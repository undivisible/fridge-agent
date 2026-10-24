/**
 * Demo without hardware or accounts: runs the real bridge against fake Chert (iMessage + FaceTime)
 * and SmartThings upstreams and serves dist/app. LiveKit is real if one is reachable at LIVEKIT_URL
 * (default `livekit-server --dev` on ws://127.0.0.1:7880); otherwise answered calls stop at
 * "Could not connect".
 *
 *   bun run demo  →  http://127.0.0.1:8787  (device token printed below)
 *   POST /demo/text   body = message text; simulates Mum texting the line ("inside", "call", …)
 *   POST /demo/ring   simulates Mum FaceTiming the line
 *   GET  /demo/replies  what the line sent back (text + attachment ids)
 *   GET  /demo/remote   the participant credential Chert's worker would receive, so a test page
 *                       can stand in for the FaceTime side
 */
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createBridge } from '../bridge/bridge';

const deviceToken = 'demo-device-token-0123456789abcdef';
const ftSecret = 'demo-facetime-secret';
const imSecret = 'demo-imessage-secret';
const mum = '+61400000001';
const photo = (hue: number, label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
<rect width="640" height="480" fill="hsl(${hue} 25% 92%)"/><rect x="40" y="150" width="560" height="8" fill="#c9c4bb"/>
<rect x="40" y="320" width="560" height="8" fill="#c9c4bb"/><rect x="80" y="70" width="90" height="80" rx="8" fill="#e8b04a"/>
<rect x="200" y="50" width="60" height="100" rx="10" fill="#f6f6f6" stroke="#bbb"/><circle cx="380" cy="270" r="45" fill="#d9472b"/>
<rect x="460" y="230" width="110" height="90" rx="6" fill="#6aa84f"/><text x="40" y="455" font-family="Arial" font-size="22" fill="#555">${label} (demo image)</text></svg>`;

let callStatus = 'dialing';
let remote: { token: string; url: string } | undefined;
const replies: unknown[] = [];
let attachments = 0;
const fake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith('facetime.trychert.com/api/v1/calls')) {
    const body = JSON.parse(String(init.body));
    remote = { token: body.participant_token, url: body.livekit_url };
    return Response.json({ data: { id: 'demo-call', status: 'queued', media_status: {}, facetime_call_events: [] } });
  }
  if (url.endsWith('/calls/demo-call')) return Response.json({ data: { id: 'demo-call', status: callStatus, media_status: {}, terminal_reason: null } });
  if (url.endsWith('/calls/demo-call/end')) return Response.json({ data: { id: 'demo-call', status: 'ended' } });
  if (url.endsWith('console.trychert.com/api/v1/attachments')) {
    const id = `att-${++attachments}`;
    return Response.json({ attachment_id: id, upload_url: `https://console.trychert.com/api/v1/attachments/${id}/upload` });
  }
  if (url.endsWith('/upload')) return new Response(null, { status: 200 });
  if (url.includes('console.trychert.com/api/v1/chats/')) {
    replies.push(JSON.parse(String(init.body)).message.parts);
    return Response.json({ success: true, message_id: `m${replies.length}`, chat_id: 'demo-chat', status: 'queued' });
  }
  if (url.includes('/components/main/status')) return Response.json({
    'samsungce.viewInside': { contents: { value: [{ fileId: 'upper' }, { fileId: 'lower' }], timestamp: new Date().toISOString() } },
    contactSensor: { contact: { value: 'closed', timestamp: new Date().toISOString() } },
  });
  if (url.includes('/udo/file_links/')) {
    const id = new URL(url).pathname.split('/').pop()!;
    // SVG keeps the demo dependency-free; the line skips non-uploadable types, so text replies carry no media here.
    return new Response(photo(id === 'upper' ? 40 : 200, id === 'upper' ? 'Upper shelf' : 'Lower shelf'), { headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (url.includes('/devices/') && url.endsWith('/commands')) return Response.json({ results: [] });
  return new Response('not faked', { status: 500 });
}) as typeof fetch;

const bridge = createBridge({
  deviceToken, allowedOrigins: [], ringTimeoutMs: 12_000, textRingTimeoutMs: 45_000, lineLabel: '+61 400 555 010',
  contacts: [{ label: 'Mum', handle: mum }, { label: 'Dad', handle: '+61400000002' }],
  imessage: { apiKey: 'demo', webhookSecret: imSecret },
  facetime: { token: 'demo', projectId: '00000000-0000-4000-8000-000000000001', lineId: 'demo-line', webhookSecret: ftSecret },
  livekit: { url: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880', apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey', apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret' },
  smartthings: { deviceId: 'demo-fridge', viewInsideCid: 'demo', token: 'demo' },
}, { fetch: fake, staticDir: resolve(import.meta.dir, '../dist/app') });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787), hostname: '127.0.0.1', idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/demo/text') {
      const raw = JSON.stringify({ event: 'message.received', event_id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        data: { chat: { id: 'demo-chat', is_group: false }, message: { id: crypto.randomUUID(), direction: 'inbound',
          sender_handle: { handle: mum, is_me: false }, parts: [{ type: 'text', value: await request.text() }] } } });
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', imSecret).update(`${ts}.${raw}`).digest('hex');
      return bridge.fetch(new Request(new URL('/webhooks/chert/imessage', url), { method: 'POST', body: raw, headers: { 'x-chert-signature': `v1,${ts},${sig}` } }));
    }
    if (request.method === 'POST' && url.pathname === '/demo/ring') {
      const raw = JSON.stringify({ event_id: crypto.randomUUID(), type: 'call.incoming', created_at: new Date().toISOString(),
        data: { call_id: `in-${Date.now()}`, line_id: 'demo-line', media: { audio: true, video: true }, from_handle_hash: null,
          occurred_at: new Date().toISOString(), from: { type: 'phone_number', value: mum } } });
      void bridge.fetch(new Request(new URL('/webhooks/chert/facetime', url), { method: 'POST', body: raw,
        headers: { 'X-Chert-Signature': `sha256=${createHmac('sha256', ftSecret).update(raw).digest('hex')}` } }))
        .then((r) => r.json())
        .then((d) => { if (d.action === 'accept') remote = { token: d.participant_token, url: d.livekit_url }; });
      return Response.json({ ringing: true });
    }
    if (url.pathname === '/demo/replies') return Response.json(replies);
    if (url.pathname === '/demo/remote') return Response.json(remote ?? null);
    if (request.method === 'POST' && url.pathname === '/demo/status') { callStatus = await request.text(); return Response.json({ callStatus }); }
    return bridge.fetch(request);
  },
});
console.log(`Demo bridge on ${server.url} — device token: ${deviceToken}`);
