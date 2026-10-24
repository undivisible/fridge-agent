import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { createBridge } from '../bridge/bridge';
import type { BridgeConfig } from '../bridge/config';

const DEVICE = 'd'.repeat(40);
const IM_SECRET = 'im-whsec';
const CHERT = 'https://console.trychert.com/api/v1';
const base: BridgeConfig = {
  deviceToken: DEVICE,
  allowedOrigins: ['null'],
  contacts: [{ label: 'Mum', handle: '+61 400 000 001' }],
  imessage: { apiKey: 'line-api-key', webhookSecret: IM_SECRET },
  facetime: { token: 'ft-token', projectId: '00000000-0000-4000-8000-000000000001', lineId: 'line-1', assistantId: 'asst-1', video: true },
  smartthings: { deviceId: 'fridge-1', viewInsideCid: 'cid-x', token: 'st-token' },
};

interface Seen { url: string; method: string; headers: Headers; body?: any }
function fakeUpstream(opts: { uploadOrigin?: string; callStatus?: string } = {}) {
  const seen: Seen[] = [];
  let attachments = 0;
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    if (url === 'https://facetime.trychert.com/api/v1/calls') {
      return Response.json({ data: { id: 'call-1', status: 'queued', media_status: {}, facetime_call_events: [] } });
    }
    if (url === 'https://facetime.trychert.com/api/v1/calls/call-1') {
      return Response.json({ data: { id: 'call-1', status: opts.callStatus ?? 'active', media_status: {}, facetime_call_events: [] } });
    }
    if (url === 'https://facetime.trychert.com/api/v1/calls/call-1/end') {
      return Response.json({ data: { id: 'call-1', status: 'ended', media_status: {}, facetime_call_events: [] } });
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

async function settle(bridge: ReturnType<typeof createBridge>) { await Promise.all([...bridge.tasks]); }
const sends = (seen: Seen[]) => seen.filter((s) => s.url.startsWith(`${CHERT}/chats/`));

test('fridge API rejects a same-length wrong device token', async () => {
  const response = await createBridge(base).fetch(api('/api/status', {}, 'e'.repeat(40)));
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

    // A failed photo upload still lets "call" go through, with a text-only note.
    await bridge.fetch(text('e4b', '+61400000001', 'call'));
    await settle(bridge);
    expect(sends(up.seen).map((s) => s.body.message.parts)).toEqual([[{ type: 'text', value: expect.stringContaining('not available') }]]);
    expect(up.seen.some((s) => s.url === 'https://facetime.trychert.com/api/v1/calls')).toBe(true);
  });

  test('"call" puts the photos in the chat before a managed FaceTime call to the sender', async () => {
    const up = fakeUpstream();
    const bridge = createBridge(base, { fetch: up.fetch });
    await bridge.fetch(text('e5', '+61 400 000 001', 'call'));
    await settle(bridge);

    const photosAt = up.seen.findIndex((s) => s.url === `${CHERT}/chats/chat-1/messages`);
    const callAt = up.seen.findIndex((s) => s.url === 'https://facetime.trychert.com/api/v1/calls');
    expect(photosAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThan(photosAt);
    expect(up.seen[photosAt]!.body.message.parts.filter((p: any) => p.type === 'media')).toHaveLength(2);
    const call = up.seen[callAt]!;
    // No media room: Chert's assistant hosts the call and the fridge contributes no audio/video.
    expect(call.body).toEqual({ direction: 'outbound', mode: 'managed', assistant_id: 'asst-1', line_id: 'line-1',
      destination: '+61 400 000 001', media: { audio: true, video: true } });
    expect(call.headers.get('Idempotency-Key')).toBe('fridge-call-e5');

    expect(await (await bridge.fetch(api('/api/status'))).json()).toEqual({ call: { label: 'Mum', status: 'active' } });
  });

  test('a second "call" during an active call is refused; "end" hangs up', async () => {
    const up = fakeUpstream();
    const bridge = createBridge(base, { fetch: up.fetch });
    await bridge.fetch(text('e6', '+61400000001', 'call'));
    await settle(bridge);
    await bridge.fetch(text('e7', '+61400000001', 'call'));
    await settle(bridge);
    expect(up.seen.filter((s) => s.url.endsWith('/api/v1/calls'))).toHaveLength(1);
    expect(sends(up.seen).at(-1)!.body.message.parts[0].value).toBe('The fridge line is already on a call.');

    await bridge.fetch(text('e8', '+61400000001', 'end'));
    await settle(bridge);
    expect(up.seen.some((s) => s.url.endsWith('/calls/call-1/end') && s.method === 'POST')).toBe(true);
    expect(await (await bridge.fetch(api('/api/status'))).json()).toEqual({ call: null });
  });

  test('the fridge forgets a call once Chert reports it ended', async () => {
    const up = fakeUpstream({ callStatus: 'ended' });
    const bridge = createBridge(base, { fetch: up.fetch });
    await bridge.fetch(text('e9', '+61400000001', 'call'));
    await settle(bridge);
    expect(await (await bridge.fetch(api('/api/status'))).json()).toEqual({ call: null });
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
