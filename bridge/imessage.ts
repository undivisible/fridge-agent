/**
 * The Chert iMessage line is the fridge's control surface: family members text commands to it and
 * it replies, with View Inside photos attached as real iMessage media.
 */
import { ChertClient, DEFAULT_IMESSAGE_BASE_URL } from '@trychert/sdk/imessage';
import type { BridgeConfig } from './config';

export type Command = 'call' | 'inside' | 'retake' | 'end' | 'help';
export interface InboundText { eventId: string; chatId: string | null; sender: string; text: string; isGroup: boolean }
export interface Photo { bytes: ArrayBuffer; type: string }

const UPLOADABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/heic', 'image/heif', 'image/webp']);
const WORDS: Record<string, Command> = {
  call: 'call', facetime: 'call', video: 'call', ring: 'call',
  inside: 'inside', fridge: 'inside', photo: 'inside', photos: 'inside', pic: 'inside', pics: 'inside', look: 'inside',
  retake: 'retake', refresh: 'retake', new: 'retake',
  end: 'end', hangup: 'end', stop: 'end',
};

export const HELP = 'Fridge commands: "inside" for the latest photos, "retake" for fresh photos, "call" for a FaceTime call with the photos in this chat, "end" to hang up.';

export function parseCommand(text: string): Command {
  const first = text.trim().toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)[0] ?? '';
  return WORDS[first] ?? 'help';
}

/** Accepts the current `data.message` envelope and the legacy flat `from`/`text` fields. */
export function parseInbound(body: Record<string, any>): InboundText | null {
  if ((body.event ?? body.event_type ?? body.type) !== 'message.received') return null;
  const message = body.data?.message ?? {};
  if (message.sender_handle?.is_me === true || message.direction === 'outbound') return null;
  const sender = message.sender_handle?.handle ?? body.from;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => String(p.value ?? '')).join(' ') || String(body.text ?? '');
  const eventId = body.event_id ?? body.id ?? message.id;
  if (typeof sender !== 'string' || typeof eventId !== 'string') return null;
  return { eventId, sender, text, chatId: body.data?.chat?.id ?? body.chat_id ?? null, isGroup: body.data?.chat?.is_group === true };
}

export class LineMessenger {
  private readonly client: ChertClient;
  private readonly origin: string;

  constructor(private readonly config: NonNullable<BridgeConfig['imessage']>, private readonly fetcher: typeof fetch = globalThis.fetch) {
    this.client = new ChertClient({ apiKey: config.apiKey, baseURL: config.baseURL, fetch: fetcher });
    this.origin = new URL(config.baseURL ?? DEFAULT_IMESSAGE_BASE_URL).origin;
  }

  private async upload(photo: Photo, name: string): Promise<string> {
    const created = await this.client.request<Record<string, any>>('/attachments', {
      method: 'POST', body: { filename: name, content_type: photo.type, size_bytes: photo.bytes.byteLength },
    });
    const record = created.attachment ?? created;
    const id = record.attachment_id ?? record.id;
    const uploadUrl = record.upload_url;
    if (typeof id !== 'string' || typeof uploadUrl !== 'string') throw new Error('Unexpected attachment response.');
    // The upload is authorized with the line's API key; never send it to another origin.
    if (new URL(uploadUrl).origin !== this.origin) throw new Error('Refusing attachment upload to a foreign origin.');
    const put = await this.fetcher(uploadUrl, {
      method: 'PUT', body: photo.bytes, redirect: 'error',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': photo.type },
    });
    if (!put.ok) throw new Error(`Attachment upload failed (${put.status}).`);
    return id;
  }

  /** Replies in the sender's chat. Keys derive from the inbound event so a redelivered webhook cannot double-send. */
  async reply(to: InboundText, text: string, photos: Photo[] = [], step = 'reply'): Promise<void> {
    const key = `fridge-${to.eventId}-${step}`.slice(0, 200);
    if (!to.chatId) {
      await this.client.sendText({ phone: to.sender, body: text, idempotency_key: key });
      return;
    }
    const media = [];
    for (const [i, photo] of photos.entries()) {
      if (!UPLOADABLE.has(photo.type)) continue;
      media.push({ type: 'media', attachment_id: await this.upload(photo, `fridge-${i + 1}.${photo.type.split('/')[1]}`) });
    }
    await this.client.request(`/chats/${encodeURIComponent(to.chatId)}/messages`, {
      method: 'POST',
      body: { message: { parts: [{ type: 'text', value: text }, ...media], idempotency_key: key }, ...(media.length > 1 ? { parallel_attachments: true } : {}) },
    });
  }
}
