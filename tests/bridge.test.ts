import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createBridge } from '../bridge/bridge';
import type { BridgeConfig } from '../bridge/config';

const DEVICE = 'd'.repeat(40);
const FT_SECRET = 'ft-whsec';
const IM_SECRET = 'im-whsec';
const CHERT = 'https://console.trychert.com/api/v1';
const base: BridgeConfig = {
  deviceToken: DEVICE,
  allowedOrigins: ['null'],
  contacts: [{ label: 'Mum', handle: '+61 400 000 001' }],
  ringTimeoutMs: 300,
  textRingTimeoutMs: 300,
  imessage: { apiKey: 'line-api-key', webhookSecret: IM_SECRET },
  facetime: { token: 'ft-token', projectId: '00000000-0000-4000-8000-000000000001', lineId: 'line-1', webhookSecret: FT_SECRET },
  livekit: { url: 'wss://lk.example.test', apiKey: 'APIkey', apiSecret: 's'.repeat(40) },
  smartthings: { deviceId: 'fridge-1', viewInsideCid: 'cid-x', token: 'st-token' },
};

interface Seen { url: string; method: string; headers: Headers; body?: any }
function fakeUpstream(opts: { uploadOrigin?: string } = {}) {
  const seen: Seen[] = [];
  let attachments = 0;
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    if (url === 'https://facetime.trychert.com/api/v1/calls') {
      return Response.json({ data: { id: 'call-1', status: 'queued', media_status: {}, facetime_call_events: [] } });
    }
    if (url === `${CHERT}/attachments`) {
      const id = `att-${++attachments}`;
      return Response.json({ attachment_id: id, upload_url: `${opts.uploadOrigin ?? 'https://console.trychert.com'}/api/v1/attachments/${id}/upload` });
    }
    if (url.includes('/attachments/') && url.endsWith('/upload')) return new Response(null, { status: 200 });
    if (url.startsWith(`${CHERT}/chats/`)) return Response.json({ success: true, message_id: 'm1', chat_id: 'chat-1', status: 'queued' });
    if (url.endsWith('/devices/fridge-1/components/main/status')) {
      return Response.json({
        'samsungce.viewInside': { contents: { value: [{ fileId: 'f1' }, { fileId: 'f2' }], timestamp: '2026-10-24T01:00:00Z' } },
        contactSensor: { contact: { value: 'closed', timestamp: '2026-10-24T00:59:00Z' } },
      });
    }
    if (url.startsWith('https://client.smartthings.com/udo/file_links/')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

const api = (path: string, init: RequestInit = {}, token = DEVICE) =>
  new Request(`http://bridge.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());

function text(eventId: string, from: string, value: string, opts: { group?: boolean; secret?: string } = {}) {
  const raw = JSON.stringify({
    event: 'message.received', event_id: eventId, timestamp: new Date().toISOString(),
    data: { chat: { id: 'chat-1', is_group: opts.group ?? false },
      message: { id: `msg-${eventId}`, direction: 'inbound', sender_handle: { handle: from, is_me: false }, parts: [{ type: 'text', value }] } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? IM_SECRET).update(`${ts}.${raw}`).digest('hex');
  return new Request('http://bridge.test/webhooks/chert/imessage', { method: 'POST', body: raw, headers: { 'x-chert-signature': `v1,${ts},${sig}` } });
}

function facetimeEvent(id: string, from: string | null, secret = FT_SECRET) {
  const raw = JSON.stringify({
    event_id: `evt-${id}`, type: 'call.incoming', created_at: 'now',
    data: { call_id: id, line_id: 'line-1', media: { audio: true, video: true }, from_handle_hash: null, occurred_at: 'now',
      from: from ? { type: 'phone_number', value: from } : null },
  });
  return new Request('http://bridge.test/webhooks/chert/facetime', {
    method: 'POST', body: raw, headers: { 'X-Chert-Signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
  });
}

async function settle(bridge: ReturnType<typeof createBridge>) { await Promise.all([...bridge.tasks]); }
const sends = (seen: Seen[]) => seen.filter((s) => s.url.startsWith(`${CHERT}/chats/`));

test('fridge API rejects a same-length wrong device token', async () => {
  const response = await createBridge(base).fetch(api('/api/ring', {}, 'e'.repeat(40)));
  expect(response.status).toBe(401);
});

describe('iMessage control', () => {
  test('rejects a webhook signed with another secret before doing anything', async () => {
    const up = fakeUpstream();
    const bridge = createBridge(base, { fetch: up.fetch });
    expect((await bridge.fetch(text('e0', '+61400000001', 'inside', { secret: 'other' }))).status).toBe(401);
    await settle(bridge);
    expect(up.seen).toHaveLength(0);
  });

  test('ignores strangers and group chats without replying', async () => {
    const up = fakeUpstream();
    const bridge = createBridge(base, { fetch: up.fetch });
    expect((await bridge.fetch(text('e1', '+61499999999', 'inside'))).status).toBe(200);
    expect((await bridge.fetch(text('e2', '+61400000001', 'inside', { group: true }))).status).toBe(200);
    await settle(bridge);
    expect(up.seen).toHaveLength(0);
  });

  test('"inside" replies in the chat with the fridge photos attached, once per event', async () => {
    const up = fakeUpstream();
    const bridge = createBridge(base, { fetch: up.fetch });
    await bridge.fetch(text('e3', '+61 400 000 001', 'Inside?'));
    await bridge.fetch(text('e3', '+61 400 000 001', 'Inside?')); // redelivery
    await settle(bridge);

    const uploads = up.seen.filter((s) => s.method === 'PUT');
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(uploads[0]!.body)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    const [message, ...rest] = sends(up.seen);
    expect(rest).toHaveLength(0);
    expect(message!.url).toBe(`${CHERT}/chats/chat-1/messages`);
    expect(message!.body.message.parts.slice(1)).toEqual([{ type: 'media', attachment_id: 'att-1' }, { type: 'media', attachment_id: 'att-2' }]);
    expect(message!.body.message.parts[0].value).toContain('Inside the fridge');
    expect(message!.body.message.idempotency_key).toBe('fridge-e3-reply');
  });

  test('never sends the line API key to an upload URL on another origin', async () => {
    const up = fakeUpstream({ uploadOrigin: 'https://attacker.example' });
    const bridge = createBridge(base, { fetch: up.fetch });
    await bridge.fetch(text('e4', '+61400000001', 'inside'));
    await settle(bridge);
    expect(up.seen.some((s) => s.url.startsWith('https://attacker.example'))).toBe(false);
    expect(sends(up.seen)).toHaveLength(0);
  });

  test('"call" rings the fridge and only FaceTimes the sender after someone answers there', async () => {
    const up = fakeUpstream();
    const bridge = createBridge({ ...base, textRingTimeoutMs: 5_000 }, { fetch: up.fetch });
    await bridge.fetch(text('e5', '+61400000001', 'call'));
    await Bun.sleep(20);
    const ringing = await (await bridge.fetch(api('/api/ring'))).json();
    expect(ringing).toMatchObject({ label: 'Mum', video: true });
    expect(up.seen.some((s) => s.url.endsWith('/calls'))).toBe(false);

    const joined = await (await bridge.fetch(api(`/api/ring/${ringing.id}/answer`, { method: 'POST' }))).json();
    await settle(bridge);
    const call = up.seen.find((s) => s.url === 'https://facetime.trychert.com/api/v1/calls')!;
    expect(call.body).toMatchObject({ mode: 'customer_managed', line_id: 'line-1', destination: '+61400000001' });
    // Chert must bridge the fridge participant, with its own credential, in the same room.
    expect(call.body.remote_participant_identity).toBe(claims(joined.token).sub);
    expect(claims(call.body.participant_token).sub).toBe(joined.remoteIdentity);
    expect(claims(call.body.participant_token).video.room).toBe(claims(joined.token).video.room);
    expect(sends(up.seen).map((s) => s.body.message.parts[0].value)).toEqual([expect.stringContaining('Ringing the fridge')]);
  });

  test('"call" tells the sender when nobody answers at the fridge', async () => {
    const up = fakeUpstream();
    const bridge = createBridge(base, { fetch: up.fetch });
    await bridge.fetch(text('e6', '+61400000001', 'call'));
    await settle(bridge);
    expect(sends(up.seen).at(-1)!.body.message.parts[0].value).toBe('Nobody answered at the fridge.');
    expect(up.seen.some((s) => s.url.endsWith('/calls'))).toBe(false);
  });
});

describe('FaceTime to the line', () => {
  test('rejects a body signed with another secret', async () => {
    expect((await createBridge(base).fetch(facetimeEvent('c1', '+61400000001', 'other'))).status).toBe(401);
  });

  test('declines callers that are not family contacts', async () => {
    expect(await (await createBridge(base).fetch(facetimeEvent('c2', '+61499999999'))).json()).toEqual({ action: 'decline' });
  });

  test('rings the fridge and accepts with a room bridging the fridge participant once answered', async () => {
    const bridge = createBridge(base);
    const decision = bridge.fetch(facetimeEvent('c3', '+61400000001'));
    await Bun.sleep(20);
    expect(await (await bridge.fetch(api('/api/ring'))).json()).toEqual({ id: 'c3', label: 'Mum', video: true });
    const joined = await (await bridge.fetch(api('/api/ring/c3/answer', { method: 'POST' }))).json();
    const accepted = await (await decision).json();
    expect(accepted.action).toBe('accept');
    expect(accepted.remote_participant_identity).toBe(claims(joined.token).sub);
    expect(claims(accepted.participant_token).sub).toBe(joined.remoteIdentity);
    // Replaying the same event cannot open a second room.
    expect(await (await bridge.fetch(facetimeEvent('c3', '+61400000001'))).json()).toEqual({ action: 'decline' });
  });

  test('declines when nobody answers before the ring timeout', async () => {
    expect(await (await createBridge(base).fetch(facetimeEvent('c4', '+61400000001'))).json()).toEqual({ action: 'decline' });
  });
});

test('fridge screen lists snapshots and fetches only advertised file ids with the configured cid', async () => {
  const up = fakeUpstream();
  const bridge = createBridge(base, { fetch: up.fetch });
  const status = await (await bridge.fetch(api('/api/inside'))).json();
  expect(status.images).toEqual(['/api/inside/images/f1', '/api/inside/images/f2']);
  const image = await bridge.fetch(api('/api/inside/images/f2'));
  expect(image.headers.get('Content-Type')).toBe('image/jpeg');
  expect(up.seen.at(-1)!.url).toBe('https://client.smartthings.com/udo/file_links/f2?cid=cid-x&di=fridge-1');
  const before = up.seen.length;
  expect((await bridge.fetch(api('/api/inside/images/not-advertised'))).status).toBe(502);
  expect(up.seen.slice(before).some((s) => s.url.includes('file_links'))).toBe(false);
});
