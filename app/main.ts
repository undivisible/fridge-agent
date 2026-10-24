/**
 * Family Hub screen for the fridge's iMessage line. Runs as a packaged Tizen web app or as a page
 * hosted by the bridge. It cannot dial: calls start from an allowlisted family member texting or
 * FaceTiming the line, and only ring here until someone answers. The fridge never holds Chert,
 * LiveKit or SmartThings credentials, only the bridge URL and a revocable device token.
 * Camera/microphone are opened only during an answered call and released after.
 */
import { Room, RoomEvent, Track, createLocalTracks, type LocalTrack, type LocalVideoTrack, type RemoteTrack } from 'livekit-client';

declare const __BRIDGE_ORIGIN__: string;
interface Joined { callId: string; livekitUrl: string; token: string; remoteIdentity: string }
interface Config { lineLabel: string | null; features: { calls: boolean; inside: boolean; texting: boolean } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = window.localStorage;
let origin = store.getItem('bridgeOrigin') || __BRIDGE_ORIGIN__ || (location.protocol.startsWith('http') ? location.origin : '');
let token = store.getItem('deviceToken') || '';
let config: Config | undefined;
let room: Room | undefined;
let activeCall: string | undefined;
let localTracks: LocalTrack[] = [];
let insideTrack: MediaStreamTrack | undefined;
let insidePaint = 0;
let insideImages: string[] = [];

const caps = {
  WebRTC: typeof RTCPeerConnection !== 'undefined',
  getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
  'canvas.captureStream': typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype,
  'Tizen runtime': typeof (window as unknown as { tizen?: unknown }).tizen !== 'undefined',
};

function show(screen: 'pair' | 'home' | 'incoming' | 'call') {
  for (const id of ['pair', 'home', 'incoming', 'call']) $(id).hidden = id !== screen;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(origin + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (response.status === 401) { unpair(); throw new Error('unauthorized'); }
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function imageUrl(path: string): Promise<string> {
  const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

function unpair() {
  store.removeItem('deviceToken');
  token = '';
  show('pair');
}

function renderCaps() {
  $('caps').replaceChildren(...Object.entries(caps).map(([name, ok]) => {
    const li = document.createElement('li');
    li.textContent = `${name}: ${ok ? 'yes' : 'no'}`;
    li.className = ok ? 'yes' : '';
    return li;
  }));
}

function renderHint() {
  if (config?.lineLabel) $('line-hint').textContent = `Family members text ${config.lineLabel} from iMessage.`;
  const notes = [];
  if (!config?.features.texting) notes.push('Texting is not configured on the bridge.');
  if (!config?.features.calls) notes.push('Calls are not configured on the bridge.');
  else if (!caps.WebRTC) notes.push('This fridge browser has no WebRTC, so calls cannot connect here.');
  $('status-note').textContent = notes.join(' ');
}

async function loadInside() {
  if (!config?.features.inside) {
    $('inside-meta').textContent = 'View Inside is not configured on the bridge.';
    $('inside-refresh').hidden = true;
    return;
  }
  try {
    const status = await api<{ images: string[]; capturedAt: string | null; door: string | null }>('/api/inside');
    for (const url of insideImages) URL.revokeObjectURL(url);
    insideImages = await Promise.all(status.images.map(imageUrl));
    $('inside-meta').textContent = status.capturedAt
      ? `Photos taken ${new Date(status.capturedAt).toLocaleString()} · door ${status.door ?? 'unknown'}`
      : 'No photos yet. Open and close the door to capture.';
    $('inside-images').replaceChildren(...insideImages.map((src, i) => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Fridge interior photo ${i + 1}`;
      return img;
    }));
  } catch (error) {
    $('inside-meta').textContent = `Could not load photos (${(error as Error).message}).`;
  }
}

async function goHome() {
  show('home');
  try {
    config = await api<Config>('/api/config');
  } catch {
    return;
  }
  renderHint();
  renderCaps();
  await loadInside();
}

function setPrivacy() {
  const kinds = localTracks.map((t) => t.kind);
  const parts = [kinds.includes(Track.Kind.Video) && !insideTrack && 'Camera on', kinds.includes(Track.Kind.Audio) && 'Microphone on', insideTrack && 'Sharing inside photos'];
  $('privacy').textContent = parts.filter(Boolean).join(' · ') || 'Camera and microphone off';
}

async function publishLocal(video: boolean) {
  const attempts: { audio: boolean; video: boolean }[] = video ? [{ audio: true, video: true }, { audio: true, video: false }] : [{ audio: true, video: false }];
  for (const attempt of attempts) {
    try {
      localTracks = await createLocalTracks({ audio: attempt.audio, video: attempt.video && { resolution: { width: 640, height: 480 } } });
      break;
    } catch { /* fall through to the next, smaller request */ }
  }
  for (const track of localTracks) {
    await room!.localParticipant.publishTrack(track);
    if (track.kind === Track.Kind.Video) {
      track.attach($<HTMLVideoElement>('local-video'));
      $('local-video').hidden = false;
    }
  }
  $('self-note').textContent = localTracks.length
    ? ''
    : 'No camera or microphone available here; the other person can still be seen and heard.';
  setPrivacy();
}

/** Swaps the outgoing camera for a still of the inside photo (FaceTime shows one camera feed), and back. */
async function toggleInside() {
  if (!room) return;
  const camera = localTracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
  if (insideTrack) {
    if (camera) await camera.restartTrack(); else await room.localParticipant.unpublishTrack(insideTrack);
    window.clearInterval(insidePaint);
    insideTrack.stop();
    insideTrack = undefined;
    $('inside-canvas').hidden = true;
    $('local-video').hidden = !camera;
    $('share-inside').textContent = 'Show inside';
  } else {
    const src = insideImages[0];
    if (!src || !caps['canvas.captureStream']) {
      $('self-note').textContent = 'Inside photos cannot be shared on this device.';
      return;
    }
    const canvas = $<HTMLCanvasElement>('inside-canvas');
    const img = new Image();
    img.src = src;
    await img.decode();
    // Chromium only emits frames for repainted canvases, so keep redrawing the still.
    const paint = () => canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    paint();
    insidePaint = window.setInterval(paint, 200);
    const track = canvas.captureStream(5).getVideoTracks()[0];
    if (!track) return;
    insideTrack = track;
    if (camera) {
      const cameraSource = camera.mediaStreamTrack;
      await camera.replaceTrack(track, true);
      cameraSource.stop(); // user-provided replacement leaves the old track running; turn the camera off
    } else {
      await room.localParticipant.publishTrack(track, { source: Track.Source.Camera, name: 'fridge-inside' });
    }
    canvas.hidden = false;
    $('local-video').hidden = true;
    $('share-inside').textContent = 'Show camera';
  }
  setPrivacy();
}

async function join(joined: Joined, label: string, video: boolean) {
  activeCall = joined.callId;
  $('call-name').textContent = label;
  $('call-status').textContent = 'Connecting…';
  show('call');
  room = new Room({ adaptiveStream: true, dynacast: true });
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    track.attach(track.kind === Track.Kind.Video ? $<HTMLVideoElement>('remote-video') : $<HTMLAudioElement>('remote-audio'));
  });
  room.on(RoomEvent.ParticipantConnected, (p) => { if (p.identity === joined.remoteIdentity) $('call-status').textContent = 'Ringing on FaceTime…'; });
  room.on(RoomEvent.Disconnected, () => { if (activeCall === joined.callId) void endCall(false); });
  try {
    await room.connect(joined.livekitUrl, joined.token);
    await publishLocal(video);
    void pollCall(joined.callId);
  } catch (error) {
    $('call-status').textContent = `Could not connect (${(error as Error).message}).`;
  }
}

async function pollCall(callId: string) {
  while (activeCall === callId) {
    try {
      const { status } = await api<{ status: string }>(`/api/calls/${callId}`);
      $('call-status').textContent = status === 'active' ? 'Connected' : status.replaceAll('_', ' ');
      if (['ended', 'failed', 'rejected'].includes(status)) return endCall(false);
    } catch { /* transient; keep polling */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function endCall(notifyBridge = true) {
  const callId = activeCall;
  activeCall = undefined;
  if (notifyBridge && callId) await api(`/api/calls/${callId}/end`, { method: 'POST' }).catch(() => undefined);
  for (const track of localTracks) track.stop();
  localTracks = [];
  window.clearInterval(insidePaint);
  insideTrack?.stop();
  insideTrack = undefined;
  await room?.disconnect();
  room = undefined;
  $('local-video').hidden = true;
  $('inside-canvas').hidden = true;
  $('share-inside').textContent = 'Show inside';
  await goHome();
  void pollIncoming();
}

let polling = false;
async function pollIncoming() {
  if (polling) return;
  polling = true;
  while (token && !activeCall) {
    if (config?.features.calls && caps.WebRTC) {
      const incoming = await api<{ id: string; label: string; video: boolean } | null>('/api/ring').catch(() => null);
      if (incoming && $('incoming').hidden) {
        $('incoming-name').textContent = `${incoming.label} wants to FaceTime`;
        $('answer').onclick = async () => {
          const joined = await api<Joined>(`/api/ring/${incoming.id}/answer`, { method: 'POST' }).catch(() => undefined);
          if (joined) await join(joined, incoming.label, incoming.video);
          else { await goHome(); $('status-note').textContent = 'The call could not be started.'; }
        };
        $('decline').onclick = async () => {
          await api(`/api/ring/${incoming.id}/decline`, { method: 'POST' }).catch(() => undefined);
          void goHome();
        };
        show('incoming');
      } else if (!incoming && !$('incoming').hidden) {
        void goHome();
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  polling = false;
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
    await goHome();
    void pollIncoming();
  } catch (error) {
    $('pair-error').textContent = `Pairing failed (${(error as Error).message}).`;
  }
});
$('unpair').addEventListener('click', unpair);
$('inside-refresh').addEventListener('click', async () => {
  $('inside-meta').textContent = 'Asking the fridge to retake photos…';
  await api('/api/inside/refresh', { method: 'POST' }).catch(() => undefined);
  setTimeout(loadInside, 8000);
});
$('hangup').addEventListener('click', () => endCall(true));
$('share-inside').addEventListener('click', () => void toggleInside());
$('mute').addEventListener('click', async () => {
  const mic = room?.localParticipant.isMicrophoneEnabled;
  await room?.localParticipant.setMicrophoneEnabled(!mic);
  $('mute').textContent = mic ? 'Unmute' : 'Mute';
});
// Tizen back key leaves a call rather than the app.
document.addEventListener('tizenhwkey', (event) => {
  if ((event as unknown as { keyName: string }).keyName === 'back' && activeCall) void endCall(true);
});

if (token && origin) { void goHome(); void pollIncoming(); } else {
  ($('pair-form').querySelector('[name=origin]') as HTMLInputElement).value = origin;
  show('pair');
}
