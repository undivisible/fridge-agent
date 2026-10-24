/**
 * Family Hub "View Inside" snapshots via SmartThings cloud.
 *
 * The internal cameras are not a live stream: the fridge captures stills after the door
 * closes and publishes file ids on the undocumented `samsungce.viewInside` capability.
 * Image bytes come from the undocumented `client.smartthings.com/udo/file_links` endpoint.
 * Both can change or disappear without notice.
 */
import type { BridgeConfig } from './config';

type SmartThingsConfig = NonNullable<BridgeConfig['smartthings']>;
type Fetch = typeof globalThis.fetch;

export interface InsideStatus { fileIds: string[]; door: string | null; doorChangedAt: string | null; capturedAt: string | null }

const API = 'https://api.smartthings.com/v1';
const CLIENT_API = 'https://client.smartthings.com';
const TOKEN_URL = 'https://auth-global.api.smartthings.com/oauth/token';
const TIMEOUT_MS = 10_000;

export class SmartThingsFridge {
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private refreshToken?: string;
  private readonly images = new Map<string, { bytes: ArrayBuffer; type: string }>();

  constructor(private readonly config: SmartThingsConfig, private readonly fetcher: Fetch = globalThis.fetch) {
    this.refreshToken = config.oauth?.refreshToken;
  }

  /** Personal access tokens issued after 2024-12-30 expire after 24h; OAuth refresh keeps the bridge working. */
  private async token(): Promise<string> {
    const oauth = this.config.oauth;
    if (!oauth) return this.config.token!;
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    if (oauth.stateFile && (await Bun.file(oauth.stateFile).exists())) {
      this.refreshToken = (await Bun.file(oauth.stateFile).text()).trim() || this.refreshToken;
    }
    const response = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${oauth.clientId}:${oauth.clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: oauth.clientId, refresh_token: this.refreshToken! }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`SmartThings token refresh failed (${response.status}).`);
    const body = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    if (body.refresh_token && body.refresh_token !== this.refreshToken) {
      this.refreshToken = body.refresh_token;
      // Refresh tokens rotate; persist the new one so a restart does not strand the bridge.
      if (oauth.stateFile) await Bun.write(oauth.stateFile, body.refresh_token, { mode: 0o600 });
    }
    return this.accessToken;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`SmartThings request failed (${response.status}).`);
    return response;
  }

  async status(): Promise<InsideStatus> {
    const response = await this.request(`${API}/devices/${encodeURIComponent(this.config.deviceId)}/components/main/status`);
    const status = (await response.json()) as Record<string, any>;
    const contents = status['samsungce.viewInside']?.contents;
    if (!contents) throw new Error('This device does not expose samsungce.viewInside.');
    const contact = status.contactSensor?.contact;
    const fileIds = (Array.isArray(contents.value) ? contents.value : [])
      .map((item: { fileId?: unknown }) => item?.fileId)
      .filter((id: unknown): id is string => typeof id === 'string' && /^[\w.-]{1,200}$/.test(id));
    return { fileIds, door: contact?.value ?? null, doorChangedAt: contact?.timestamp ?? null, capturedAt: contents.timestamp ?? null };
  }

  /** Bytes for one snapshot. Only ids currently advertised by the device are fetched. */
  async image(fileId: string): Promise<{ bytes: ArrayBuffer; type: string }> {
    const cached = this.images.get(fileId);
    if (cached) return cached;
    const { fileIds } = await this.status();
    if (!fileIds.includes(fileId)) throw new Error('Unknown snapshot.');
    const url = `${CLIENT_API}/udo/file_links/${encodeURIComponent(fileId)}?cid=${encodeURIComponent(this.config.viewInsideCid)}&di=${encodeURIComponent(this.config.deviceId)}`;
    const response = await this.request(url);
    const image = { bytes: await response.arrayBuffer(), type: response.headers.get('content-type') ?? 'image/jpeg' };
    for (const id of this.images.keys()) if (!fileIds.includes(id)) this.images.delete(id);
    this.images.set(fileId, image);
    return image;
  }

  /** Ask the fridge to recapture. Mirrors the command the Samsung app sends through the OCF `execute` capability. */
  async refresh(): Promise<void> {
    await this.request(`${API}/devices/${encodeURIComponent(this.config.deviceId)}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [{
          component: 'main', capability: 'execute', command: 'execute',
          arguments: ['/udo/contents/provider/vs/0', { 'x.com.samsung.da.control': { 'x.com.samsung.da.command': 'refresh' } }],
        }],
      }),
    });
  }
}
