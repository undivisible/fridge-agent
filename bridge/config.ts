/** Bridge configuration. Every secret stays on the bridge host; none is shipped to the fridge. */
export interface Contact { label: string; handle: string }

export interface BridgeConfig {
  /** Shared secret the fridge app sends as `Authorization: Bearer …`. */
  deviceToken: string;
  /** Origins allowed to call the API from a browser context (packaged Tizen apps use `file://` → `null`). */
  allowedOrigins: string[];
  /** Family allowlist: the only handles that may text commands to the fridge line. */
  contacts: Contact[];
  /** How the fridge screen names the line people text, e.g. "+61 400 000 000". */
  lineLabel?: string;
  /** Chert iMessage line that receives commands and replies (with photos). */
  imessage?: { apiKey: string; webhookSecret: string; baseURL?: string };
  /**
   * Chert FaceTime control plane. Calls are Chert-managed: `assistantId` is the Chert assistant that
   * hosts the call, because Chert needs either an assistant or a LiveKit room on the far end and the
   * fridge contributes no audio/video.
   */
  facetime?: { token: string; projectId: string; lineId: string; assistantId: string; video: boolean; baseUrl?: string };
  smartthings?: {
    deviceId: string;
    /** Client id the undocumented `udo/file_links` endpoint expects; must be set explicitly (see docs/FEASIBILITY.md). */
    viewInsideCid: string;
    token?: string;
    oauth?: { clientId: string; clientSecret: string; refreshToken: string; stateFile?: string };
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function parseContacts(raw: string | undefined): Contact[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('FRIDGE_CONTACTS must be a JSON array.');
  return parsed.map((c, i) => {
    if (!c || typeof c.label !== 'string' || typeof c.handle !== 'string') throw new Error(`FRIDGE_CONTACTS[${i}] needs label and handle.`);
    return { label: c.label, handle: c.handle };
  });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const deviceToken = required(env, 'FRIDGE_DEVICE_TOKEN');
  if (deviceToken.length < 32) throw new Error('FRIDGE_DEVICE_TOKEN must be at least 32 characters.');
  const config: BridgeConfig = {
    deviceToken,
    allowedOrigins: (env.FRIDGE_ALLOWED_ORIGINS ?? 'null').split(',').map((s) => s.trim()).filter(Boolean),
    contacts: parseContacts(env.FRIDGE_CONTACTS),
    lineLabel: env.FRIDGE_LINE_LABEL || undefined,
  };
  if (env.CHERT_API_KEY) {
    config.imessage = { apiKey: env.CHERT_API_KEY, webhookSecret: required(env, 'CHERT_IMESSAGE_WEBHOOK_SECRET'), baseURL: env.CHERT_IMESSAGE_BASE_URL || undefined };
  }
  if (env.CHERT_FACETIME_TOKEN) {
    config.facetime = {
      token: env.CHERT_FACETIME_TOKEN,
      projectId: required(env, 'CHERT_PROJECT_ID'),
      lineId: required(env, 'CHERT_LINE_ID'),
      assistantId: required(env, 'CHERT_ASSISTANT_ID'),
      video: env.CHERT_CALL_VIDEO !== 'false',
      baseUrl: env.CHERT_FACETIME_BASE_URL || undefined,
    };
  }
  if (env.SMARTTHINGS_DEVICE_ID) {
    const oauth = env.SMARTTHINGS_REFRESH_TOKEN
      ? { clientId: required(env, 'SMARTTHINGS_CLIENT_ID'), clientSecret: required(env, 'SMARTTHINGS_CLIENT_SECRET'),
          refreshToken: env.SMARTTHINGS_REFRESH_TOKEN, stateFile: env.SMARTTHINGS_STATE_FILE || undefined }
      : undefined;
    if (!oauth && !env.SMARTTHINGS_TOKEN) throw new Error('Set SMARTTHINGS_TOKEN or the SMARTTHINGS OAuth refresh variables.');
    config.smartthings = { deviceId: env.SMARTTHINGS_DEVICE_ID, viewInsideCid: required(env, 'SMARTTHINGS_VIEWINSIDE_CID'), token: env.SMARTTHINGS_TOKEN, oauth };
  }
  return config;
}
