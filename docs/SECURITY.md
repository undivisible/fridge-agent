# Privacy and security

**Who can do what**
- Only handles in `FRIDGE_CONTACTS` can control the line. Commands are accepted from 1:1 chats only.
- Unknown senders and group chats get no reply, so the line does not reveal that it controls a
  fridge.
- A FaceTime call goes only to the person who texted `call`. One call runs at a time.

**No capture at home**
- The fridge never captures audio or video. The app has no `mediacapture` privilege and never calls
  `getUserMedia`.
- The only household data leaving the home is the View Inside photos, sent only to allowlisted family
  members who ask for them.

**What the caller is talking to**
- A Chert-managed call is hosted by a Chert assistant (an AI voice, and optionally an avatar).
  Callers should know they are not talking to a person at the fridge.
- The assistant's speech and any transcript are processed by Chert and its model provider under the
  assistant's configuration.

**Credentials**
- All secrets stay on the bridge. The fridge stores only the bridge URL and a 32+ character device
  token in `localStorage`, and the bridge compares that token in constant time.
- The iMessage API key is sent only to the Chert API origin. An attachment `upload_url` on any other
  origin is refused, and the call still goes ahead without photos.

**Webhooks**
- iMessage webhooks are checked with the SDK's `verifyWebhook` (HMAC over `ts.body`, ±300s).
- The bridge fails closed without a secret.
- Event ids are deduplicated. Reply and call idempotency keys come from the inbound event, so a
  redelivered webhook cannot double-send or double-dial.

**Data handling**
- The bridge stores no message text, photos or call events.
- Photos are cached in memory only, limited to file ids the fridge currently advertises, and served
  with `Cache-Control: no-store`.
- The fridge sees only the caller's label and the call status.

**Private APIs**
- View Inside depends on undocumented SmartThings endpoints and a Samsung app client id. Using them
  may break Samsung's terms or stop working without notice.
- The feature is off unless `SMARTTHINGS_VIEWINSIDE_CID` is set deliberately.

**Known gaps**
- There is no rate limiting.
- Call state is held in memory. After a bridge restart, `end` cannot find a call placed earlier;
  end it from Chert instead.
