# Privacy and security

**Who can do what**
- Only handles in `FRIDGE_CONTACTS` can control the fridge. Commands are accepted from 1:1 chats
  only.
- Unknown senders and group chats get no reply, so the line does not reveal that it controls a
  fridge. FaceTime from unknown handles is declined.
- The fridge cannot dial anyone. A texted `call` only rings the fridge, and FaceTime is placed after
  a person at the fridge taps Answer.
- No remote request can switch on the fridge's camera or microphone. This includes the inside
  photos: they are sent only to allowlisted family members who ask.

**Camera and microphone**
- Capture starts only after a call is answered, and every track stops when the call ends.
- A label shows what is on, for example "Camera on · Microphone on · Sharing inside photos".
- **Show inside** replaces the camera feed and turns the camera off.

**Credentials**
- All secrets stay on the bridge. The fridge stores only the bridge URL and a 32+ character device
  token in `localStorage`, and the bridge compares that token in constant time.
- LiveKit tokens are minted per call, limited to one room, and expire after 15 minutes.
- Chert's worker receives its own participant token, separate from the fridge's.
- The iMessage API key is sent only to the Chert API origin. An attachment `upload_url` on any other
  origin is refused.

**Webhooks**
- iMessage webhooks are checked with the SDK's `verifyWebhook` (HMAC over `ts.body`, ±300s).
- FaceTime webhooks are checked with `sha256=` HMAC in constant time.
- The bridge fails closed when a secret is missing. Event ids are deduplicated, and reply
  idempotency keys come from the inbound event, so a redelivered webhook cannot double-send.

**Data handling**
- The bridge stores no message text, photos or call events.
- Photos are cached in memory only, limited to the file ids the fridge currently advertises, and
  served with `Cache-Control: no-store`.
- The fridge sees only call status fields, never Chert event payloads.

**Private APIs**
- View Inside depends on undocumented SmartThings endpoints and a Samsung app client id. Using them
  may break Samsung's terms or stop working without notice.
- The feature is off unless `SMARTTHINGS_VIEWINSIDE_CID` is set deliberately.

**Consent**
- Everyone on a call and everyone in the household should know the fridge can be called and can
  share interior photos. Recording is not implemented.

**Known gaps**
- There is no rate limiting.
- The ring and call state live in memory, so a bridge restart drops a ringing call.
- Hosted mode depends on the fridge browser's TLS and permission prompts.
