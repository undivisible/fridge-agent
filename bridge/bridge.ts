/**
 * iMessage line ⇄ bridge ⇄ fridge, with FaceTime media via Chert ⇄ LiveKit.
 *
 * The Chert line is the control surface: family members text it ("inside", "retake", "call", "end")
 * or FaceTime it. The fridge app is a passive endpoint that shows View Inside photos and rings;
 * nothing on the fridge can dial out. Chert's Mac workers own the FaceTime leg and join a LiveKit
 * room with a separate call-scoped token, bridging the fridge participant. This server holds every
 * credential and enforces the family allowlist.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join, normalize } from 'node:path';
import { ChertControlPlane } from '@trychert/sdk/facetime';
import type { IncomingCallDecision, IncomingCallWebhook } from '@trychert/sdk/facetime';
import { verifyWebhook } from '@trychert/sdk/imessage';
import { AccessToken } from 'livekit-server-sdk';
import type { BridgeConfig, Contact } from './config';
import { HELP, LineMessenger, parseCommand, parseInbound, type InboundText, type Photo } from './imessage';
import { SmartThingsFridge } from './smartthings';

type Fetch = typeof globalThis.fetch;
interface Room { livekitUrl: string; room: string; fridgeIdentity: string; fridgeToken: string; chertIdentity: string; chertToken: string }
interface Joined { callId: string; livekitUrl: string; token: string; remoteIdentity: string }
/** A ring on the fridge screen; `answer` returns what the fridge needs to join. */
interface Ring { id: string; label: string; video: boolean; createdAt: number; timeoutMs: number; answer: () => Promise<Joined>; decline: () => void }

export interface BridgeDeps { fetch?: Fetch; staticDir?: string; now?: () => number }

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, code: string) => json({ error: code }, status);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Chert signs FaceTime incoming-call webhooks as `X-Chert-Signature: sha256=<hex HMAC-SHA256(raw body)>`. */
export function verifyFaceTimeSignature(secret: string, rawBody: Uint8Array, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header, `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
}

/** Phone numbers compare digit-for-digit with a leading +; emails/Apple IDs compare case-insensitively. */
function sameHandle(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes('@') ? s.trim().toLowerCase() : s.replace(/[^\d+]/g, ''));
  return norm(a) === norm(b);
}

export function createBridge(config: BridgeConfig, deps: BridgeDeps = {}) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const facetime = config.facetime
    ? new ChertControlPlane({ token: config.facetime.token, projectId: config.facetime.projectId, baseUrl: config.facetime.baseUrl, fetch: fetcher })
    : undefined;
  const line = config.imessage ? new LineMessenger(config.imessage, fetcher) : undefined;
  const fridge = config.smartthings ? new SmartThingsFridge(config.smartthings, fetcher) : undefined;
  const calls = new Map<string, Room>();
  const seenEvents = new Set<string>();
  let ring: Ring | undefined;
  /** Background work started by iMessage commands; tests and shutdown can await it. */
  const tasks = new Set<Promise<unknown>>();
  const canCall = () => Boolean(facetime && config.livekit);
  const contactFor = (handle: string | undefined): Contact | undefined =>
    handle ? config.contacts.find((c) => sameHandle(c.handle, handle)) : undefined;

  function firstSeen(id: string): boolean {
    if (seenEvents.has(id)) return false;
    seenEvents.add(id);
    if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value!);
    return true;
  }

  async function mint(identity: string, room: string, name: string): Promise<string> {
    const lk = config.livekit!;
    const token = new AccessToken(lk.apiKey, lk.apiSecret, { identity, name, ttl: '15m' });
    token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
    return token.toJwt();
  }

  async function createRoom(): Promise<Room> {
    const suffix = crypto.randomUUID();
    const room = `fridge-${suffix}`;
    const fridgeIdentity = `fridge-${suffix.slice(0, 8)}`;
    const chertIdentity = `facetime-${suffix.slice(0, 8)}`;
    return {
      livekitUrl: config.livekit!.url, room, fridgeIdentity, chertIdentity,
      fridgeToken: await mint(fridgeIdentity, room, 'Family Hub'),
      chertToken: await mint(chertIdentity, room, 'FaceTime'),
    };
  }

  const joinInfo = (callId: string, room: Room): Joined =>
    ({ callId, livekitUrl: room.livekitUrl, token: room.fridgeToken, remoteIdentity: room.chertIdentity });

  async function insidePhotos(): Promise<{ photos: Photo[]; capturedAt: string | null }> {
    const status = await fridge!.status();
    return { photos: await Promise.all(status.fileIds.map((id) => fridge!.image(id))), capturedAt: status.capturedAt };
  }

  const when = (iso: string | null) => (iso ? ` (taken ${new Date(iso).toUTCString().replace(' GMT', ' UTC')})` : '');

  /** One iMessage command from an allowlisted family member. */
  async function runCommand(msg: InboundText, contact: Contact): Promise<void> {
    const command = parseCommand(msg.text);
    if (command === 'help') return line!.reply(msg, HELP);

    if (command === 'inside' || command === 'retake') {
      if (!fridge) return line!.reply(msg, 'Fridge photos are not set up on this line.');
      let before: string | null = null;
      if (command === 'retake') {
        before = (await fridge.status()).capturedAt;
        await fridge.refresh();
        await line!.reply(msg, 'Asking the fridge to retake its photos…', [], 'ack');
        for (let i = 0; i < 10 && (await fridge.status()).capturedAt === before; i++) await Bun.sleep(3000);
      }
      const { photos, capturedAt } = await insidePhotos();
      if (!photos.length) return line!.reply(msg, 'The fridge has no photos yet. Open and close the door to capture some.');
      const stale = command === 'retake' && capturedAt === before ? ' The fridge did not retake them; these are the previous photos.' : '';
      return line!.reply(msg, `Inside the fridge${when(capturedAt)}.${stale}`, photos);
    }

    if (command === 'end') {
      const ids = [...calls.keys()];
      if (!ids.length) return line!.reply(msg, 'There is no fridge call to end.');
      for (const id of ids) { await facetime!.endCall(id, `fridge-end-${id}`, { reason: 'ended_by_text' }).catch(() => undefined); calls.delete(id); }
      return line!.reply(msg, 'Fridge call ended.');
    }

    // call
    if (!canCall()) return line!.reply(msg, 'Fridge calls are not set up on this line.');
    if (ring || calls.size) return line!.reply(msg, 'The fridge is busy with another call.');
    const id = `text-${msg.eventId}`.replace(/[^\w-]/g, '').slice(0, 80);
    const outcome = new Promise<'answered' | 'declined' | 'missed' | 'failed'>((resolve) => {
      ring = {
        id, label: contact.label, video: true, createdAt: now(), timeoutMs: config.textRingTimeoutMs,
        // FaceTime is only placed once someone at the fridge accepts: no remote-triggered camera.
        answer: async () => {
          try {
            const room = await createRoom();
            const call = await facetime!.createCall({
              direction: 'outbound', mode: 'customer_managed', line_id: config.facetime!.lineId,
              destination: msg.sender, media: { audio: true, video: true },
              livekit_url: room.livekitUrl, participant_token: room.chertToken, remote_participant_identity: room.fridgeIdentity,
            }, `fridge-${id}`);
            calls.set(call.id, room);
            resolve('answered');
            return joinInfo(call.id, room);
          } catch (error) {
            resolve('failed');
            throw error;
          }
        },
        decline: () => resolve('declined'),
      };
      setTimeout(() => resolve('missed'), config.textRingTimeoutMs);
    });
    await line!.reply(msg, 'Ringing the fridge. You will get a FaceTime call if someone answers.', [], 'ack');
    const result = await outcome;
    if ((ring as Ring | undefined)?.id === id) ring = undefined;
    if (result === 'declined') await line!.reply(msg, 'Someone at the fridge declined the call.');
    if (result === 'missed') await line!.reply(msg, 'Nobody answered at the fridge.');
    if (result === 'failed') await line!.reply(msg, 'The fridge answered but the FaceTime call could not be started.');
  }

  async function imessageWebhook(request: Request): Promise<Response> {
    const raw = await request.text();
    // Fail closed: verify the subscription signature (v1,<ts>,<hmac>) with a 5-minute replay window.
    if (!config.imessage || !(await verifyWebhook(raw, request.headers.get('x-chert-signature') ?? '', config.imessage.webhookSecret))) {
      return fail(401, 'invalid_signature');
    }
    const msg = parseInbound(JSON.parse(raw));
    // Strangers and group chats get no reply at all, so the line does not confirm it controls a fridge.
    const contact = msg && !msg.isGroup ? contactFor(msg.sender) : undefined;
    if (msg && contact && firstSeen(`imessage:${msg.eventId}`)) {
      const task = runCommand(msg, contact).catch((error) => console.error(`fridge command failed: ${(error as Error).message}`));
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
    return json({ ok: true });
  }

  async function facetimeWebhook(request: Request): Promise<Response> {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!config.facetime?.webhookSecret || !verifyFaceTimeSignature(config.facetime.webhookSecret, raw, request.headers.get('X-Chert-Signature'))) {
      return fail(401, 'invalid_signature');
    }
    const event = JSON.parse(new TextDecoder().decode(raw)) as IncomingCallWebhook;
    const decline = (): Response => json({ action: 'decline' } satisfies IncomingCallDecision);
    if (event.type !== 'call.incoming' || !firstSeen(`facetime:${event.event_id}`)) return decline();
    if (event.data.line_id !== config.facetime.lineId || !config.livekit) return decline();
    const contact = contactFor(event.data.from?.value);
    if (!contact || ring || calls.size) return decline(); // Unknown callers and call-waiting are declined.

    const room = await createRoom();
    const callId = event.data.call_id;
    // Hold the webhook open while the fridge rings.
    const answered = await new Promise<boolean>((resolve) => {
      ring = {
        id: callId, label: contact.label, video: event.data.media.video, createdAt: now(), timeoutMs: config.ringTimeoutMs,
        answer: async () => { calls.set(callId, room); resolve(true); return joinInfo(callId, room); },
        decline: () => resolve(false),
      };
      setTimeout(() => resolve(false), config.ringTimeoutMs);
    });
    if ((ring as Ring | undefined)?.id === callId) ring = undefined;
    if (!answered) return decline();
    return json({ action: 'accept', livekit_url: room.livekitUrl, participant_token: room.chertToken,
      remote_participant_identity: room.fridgeIdentity } satisfies IncomingCallDecision);
  }

  async function api(request: Request, url: URL): Promise<Response> {
    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), config.deviceToken)) return fail(401, 'unauthorized');
    const { pathname: path } = url;
    const method = request.method;

    if (method === 'GET' && path === '/api/config') {
      return json({ lineLabel: config.lineLabel ?? null, features: { calls: canCall(), inside: Boolean(fridge), texting: Boolean(line) } });
    }

    if (method === 'GET' && path === '/api/ring') {
      if (ring && now() - ring.createdAt > ring.timeoutMs) ring = undefined;
      return json(ring ? { id: ring.id, label: ring.label, video: ring.video } : null);
    }
    const ringMatch = path.match(/^\/api\/ring\/([\w-]{1,80})\/(answer|decline)$/);
    if (method === 'POST' && ringMatch) {
      const current = ring;
      if (!current || current.id !== ringMatch[1]) return fail(404, 'no_ring');
      ring = undefined;
      if (ringMatch[2] === 'decline') { current.decline(); return json({ declined: true }); }
      try {
        return json(await current.answer());
      } catch (error) {
        current.decline();
        return fail(502, (error as { code?: string }).code ?? 'chert_error');
      }
    }

    const callMatch = path.match(/^\/api\/calls\/([\w-]{1,80})(\/end)?$/);
    if (callMatch) {
      const [, id, end] = callMatch;
      if (!facetime || !calls.has(id!)) return fail(404, 'unknown_call');
      try {
        if (method === 'POST' && end) {
          const call = await facetime.endCall(id!, `fridge-end-${id}`, { reason: 'ended_on_fridge' });
          calls.delete(id!);
          return json({ status: call.status });
        }
        if (method === 'GET' && !end) {
          // Only status fields leave the bridge; event payloads may contain sensitive call data.
          const call = await facetime.getCall(id!);
          if (['ended', 'failed', 'rejected'].includes(call.status)) calls.delete(id!);
          return json({ status: call.status, mediaStatus: call.media_status, terminalReason: call.terminal_reason });
        }
      } catch (error) {
        return fail(502, (error as { code?: string }).code ?? 'chert_error');
      }
    }

    if (path.startsWith('/api/inside')) {
      if (!fridge) return fail(503, 'inside_not_configured');
      try {
        if (method === 'GET' && path === '/api/inside') {
          const status = await fridge.status();
          return json({ ...status, images: status.fileIds.map((id) => `/api/inside/images/${encodeURIComponent(id)}`) });
        }
        if (method === 'POST' && path === '/api/inside/refresh') {
          await fridge.refresh();
          return json({ requested: true });
        }
        const image = path.match(/^\/api\/inside\/images\/([\w.-]{1,200})$/);
        if (method === 'GET' && image) {
          const { bytes, type } = await fridge.image(decodeURIComponent(image[1]!));
          return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
        }
      } catch {
        return fail(502, 'smartthings_error');
      }
    }
    return fail(404, 'not_found');
  }

  function cors(request: Request, response: Response): Response {
    const origin = request.headers.get('Origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST');
      response.headers.set('Vary', 'Origin');
    }
    return response;
  }

  async function staticFile(url: URL): Promise<Response> {
    if (!deps.staticDir) return fail(404, 'not_found');
    const relative = normalize(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname));
    const file = Bun.file(join(deps.staticDir, relative));
    if (!relative.startsWith('/') || !(await file.exists())) return fail(404, 'not_found');
    return new Response(file, { headers: { 'Cache-Control': 'no-cache' } });
  }

  return {
    tasks,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return cors(request, new Response(null, { status: 204 }));
      if (request.method === 'POST' && url.pathname === '/webhooks/chert/imessage') return imessageWebhook(request);
      if (request.method === 'POST' && url.pathname === '/webhooks/chert/facetime') return facetimeWebhook(request);
      if (url.pathname.startsWith('/api/')) return cors(request, await api(request, url));
      if (request.method === 'GET') return staticFile(url);
      return fail(405, 'method_not_allowed');
    },
  };
}
