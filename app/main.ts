/**
 * Family Hub screen for the fridge's iMessage line. Runs as a packaged Tizen web app or as a page
 * hosted by the bridge. It is display-only: it shows the View Inside photos and whether the line is
 * on a call. It never captures audio or video and cannot start calls; everything is driven by
 * allowlisted family members texting the line. It holds only the bridge URL and a revocable token.
 */
declare const __BRIDGE_ORIGIN__: string;
interface Config { lineLabel: string | null; features: { calls: boolean; inside: boolean; texting: boolean } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = window.localStorage;
let origin = store.getItem('bridgeOrigin') || __BRIDGE_ORIGIN__ || (location.protocol.startsWith('http') ? location.origin : '');
let token = store.getItem('deviceToken') || '';
let config: Config | undefined;
let insideImages: string[] = [];
let lastCapture: string | null = null;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(origin + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (response.status === 401) { unpair(); throw new Error('unauthorized'); }
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function imageUrl(path: string): Promise<string> {
  const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

function show(screen: 'pair' | 'home') {
  $('pair').hidden = screen !== 'pair';
  $('home').hidden = screen !== 'home';
}

function unpair() {
  store.removeItem('deviceToken');
  token = '';
  show('pair');
}

function renderHint() {
  if (config?.lineLabel) $('line-hint').textContent = `Family members text ${config.lineLabel} from iMessage.`;
  const notes = [];
  if (!config?.features.texting) notes.push('Texting is not configured on the bridge.');
  if (!config?.features.calls) notes.push('Calls are not configured on the bridge.');
  $('status-note').textContent = notes.join(' ');
}

async function loadInside(force = false) {
  if (!config?.features.inside) {
    $('inside-meta').textContent = 'View Inside is not configured on the bridge.';
    $('inside-refresh').hidden = true;
    return;
  }
  try {
    const status = await api<{ images: string[]; capturedAt: string | null; door: string | null }>('/api/inside');
    $('inside-meta').textContent = status.capturedAt
      ? `Photos taken ${new Date(status.capturedAt).toLocaleString()} · door ${status.door ?? 'unknown'}`
      : 'No photos yet. Open and close the door to capture.';
    if (!force && status.capturedAt === lastCapture && insideImages.length) return;
    lastCapture = status.capturedAt;
    const urls = await Promise.all(status.images.map(imageUrl));
    for (const url of insideImages) URL.revokeObjectURL(url);
    insideImages = urls;
    $('inside-images').replaceChildren(...urls.map((src, i) => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Fridge interior photo ${i + 1}`;
      return img;
    }));
  } catch (error) {
    $('inside-meta').textContent = `Could not load photos (${(error as Error).message}).`;
  }
}

async function refreshStatus() {
  const { call } = await api<{ call: { label: string; status: string } | null }>('/api/status').catch(() => ({ call: null }));
  $('call-banner').hidden = !call;
  if (call) $('call-banner').textContent = `FaceTime with ${call.label}: ${call.status === 'active' ? 'connected' : call.status.replaceAll('_', ' ')} · these photos were sent to their iMessage`;
}

async function start() {
  show('home');
  try {
    config = await api<Config>('/api/config');
  } catch {
    return;
  }
  renderHint();
  await loadInside(true);
  // Light polling keeps the screen in step with texts sent to the line.
  while (token) {
    await refreshStatus();
    await new Promise((r) => setTimeout(r, 5000));
    await loadInside();
  }
}

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  origin = String(data.get('origin')).replace(/\/+$/, '');
  token = String(data.get('token'));
  try {
    await api<Config>('/api/config');
    store.setItem('bridgeOrigin', origin);
    store.setItem('deviceToken', token);
    $('pair-error').textContent = '';
    void start();
  } catch (error) {
    $('pair-error').textContent = `Pairing failed (${(error as Error).message}).`;
  }
});
$('unpair').addEventListener('click', unpair);
$('inside-refresh').addEventListener('click', async () => {
  $('inside-meta').textContent = 'Asking the fridge to retake photos…';
  await api('/api/inside/refresh', { method: 'POST' }).catch(() => undefined);
  setTimeout(() => loadInside(true), 8000);
});

if (token && origin) void start(); else {
  ($('pair-form').querySelector('[name=origin]') as HTMLInputElement).value = origin;
  show('pair');
}
