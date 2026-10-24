/**
 * iMessage line ⇄ bridge ⇄ fridge.
 *
 * The Chert line is the whole control surface: family members text it ("inside", "retake", "call",
 * "end"). Photos of the fridge interior go back as iMessage attachments. "call" sends the current
 * photos into the chat and then has the line place a Chert-managed FaceTime call to the sender, so
 * the photos sit alongside the call. The fridge is never a media participant: it only displays the
 * photos and the call status. This server holds every credential and enforces the family allowlist.
 */
import { timingSafeEqual } from 'node:crypto';
import { join, normalize } from 'node:path';
import { ChertControlPlane } from '@trychert/sdk/facetime';
import { verifyWebhook } from '@trychert/sdk/imessage';
import type { BridgeConfig, Contact } from './config';
import { HELP, LineMessenger, parseCommand, parseInbound, type InboundText, type Photo } from './imessage';
import { SmartThingsFridge } from './smartthings';

type Fetch = typeof globalThis.fetch;
interface ActiveCall { id: string; label: string; status: string }

export interface BridgeDeps { fetch?: Fetch; staticDir?: string }

const TERMINAL = new Set(['ended', 'failed', 'rejected']);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, code: string) => json({ error: code }, status);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Phone numbers compare digit-for-digit with a leading +; emails/Apple IDs compare case-insensitively. */
function sameHandle(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes('@') ? s.trim().toLowerCase() : s.replace(/[^\d+]/g, ''));
  return norm(a) === norm(b);
}

export function createBridge(config: BridgeConfig, deps: BridgeDeps = {}) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const facetime = config.facetime
    ? new ChertControlPlane({ token: config.facetime.token, projectId: config.facetime.projectId, baseUrl: config.facetime.baseUrl, fetch: fetcher })
    : undefined;
  const line = config.imessage ? new LineMessenger(config.imessage, fetcher) : undefined;
  const fridge = config.smartthings ? new SmartThingsFridge(config.smartthings, fetcher) : undefined;
  const seenEvents = new Set<string>();
  let active: ActiveCall | undefined;
  /** Background work started by iMessage commands; tests and shutdown can await it. */
  const tasks = new Set<Promise<unknown>>();

  function firstSeen(id: string): boolean {
    if (seenEvents.has(id)) return false;
    seenEvents.add(id);
    if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value!);
    return true;
  }

  async function insidePhotos(): Promise<{ photos: Photo[]; capturedAt: string | null }> {
    const status = await fridge!.status();
    return { photos: await Promise.all(status.fileIds.map((id) => fridge!.image(id))), capturedAt: status.capturedAt };
  }

  const when = (iso: string | null) => (iso ? ` (taken ${new Date(iso).toUTCString().replace(' GMT', ' UTC')})` : '');

  /** Refreshes the tracked call from Chert and forgets it once it is over. */
  async function currentCall(): Promise<ActiveCall | undefined> {
    if (!active || !facetime) return undefined;
    const call = await facetime.getCall(active.id);
    active.status = call.status;
    if (TERMINAL.has(call.status)) active = undefined;
    return active;
  }

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
      const call = await currentCall().catch(() => active);
      if (!call) return line!.reply(msg, 'There is no fridge call to end.');
      await facetime!.endCall(call.id, `fridge-end-${call.id}`, { reason: 'ended_by_text' });
      active = undefined;
      return line!.reply(msg, 'Fridge call ended.');
    }

    // call
    if (!facetime) return line!.reply(msg, 'Fridge calls are not set up on this line.');
    if (await currentCall().catch(() => active)) return line!.reply(msg, 'The fridge line is already on a call.');
    // The photos go into the chat first, so they are on screen alongside the FaceTime call.
    let photos: Photo[] = [], capturedAt: string | null = null;
    if (fridge) ({ photos, capturedAt } = await insidePhotos().catch(() => ({ photos: [], capturedAt: null })));
    const noPhotos = 'Calling you on FaceTime now. Fridge photos are not available right now.';
    await line!.reply(msg, photos.length
      ? `Inside the fridge${when(capturedAt)}. Calling you on FaceTime now; text "retake" for fresh photos during the call.`
      : noPhotos, photos, 'call-photos')
      .catch(() => line!.reply(msg, noPhotos, [], 'call-text')); // a failed upload must not block the call
    try {
      const call = await facetime.createCall({
        direction: 'outbound', mode: 'managed', assistant_id: config.facetime!.assistantId, line_id: config.facetime!.lineId,
        destination: msg.sender, media: { audio: true, video: config.facetime!.video },
      }, `fridge-call-${msg.eventId}`.slice(0, 200));
      active = { id: call.id, label: contact.label, status: call.status };
    } catch {
      await line!.reply(msg, 'The FaceTime call could not be started.', [], 'call-failed');
    }
  }

  async function imessageWebhook(request: Request): Promise<Response> {
    const raw = await request.text();
    // Fail closed: verify the subscription signature (v1,<ts>,<hmac>) with a 5-minute replay window.
    if (!config.imessage || !(await verifyWebhook(raw, request.headers.get('x-chert-signature') ?? '', config.imessage.webhookSecret))) {
      return fail(401, 'invalid_signature');
    }
    const msg = parseInbound(JSON.parse(raw));
    // Strangers and group chats get no reply at all, so the line does not confirm it controls a fridge.
    const contact = msg && !msg.isGroup ? config.contacts.find((c) => sameHandle(c.handle, msg.sender)) : undefined;
    if (msg && contact && firstSeen(msg.eventId)) {
      const task = runCommand(msg, contact).catch((error) => console.error(`fridge command failed: ${(error as Error).message}`));
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
    return json({ ok: true });
  }

  async function api(request: Request, url: URL): Promise<Response> {
    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), config.deviceToken)) return fail(401, 'unauthorized');
    const { pathname: path } = url;
    const method = request.method;

    if (method === 'GET' && path === '/api/config') {
      return json({ lineLabel: config.lineLabel ?? null, features: { calls: Boolean(facetime), inside: Boolean(fridge), texting: Boolean(line) } });
    }
    if (method === 'GET' && path === '/api/status') {
      // Only the family label and status reach the fridge; Chert event payloads stay on the bridge.
      const call = await currentCall().catch(() => active);
      return json({ call: call ? { label: call.label, status: call.status } : null });
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
      if (url.pathname.startsWith('/api/')) return cors(request, await api(request, url));
      if (request.method === 'GET') return staticFile(url);
      return fail(405, 'method_not_allowed');
    },
  };
}
