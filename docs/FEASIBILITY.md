# Feasibility research (2026-10-25)

Sources were read on 2026-10-25. Statements about devices are marked **unverified** unless a real
device was tested; no real device was available.

## 1. Home Assistant discussion #2226: Family Hub camera

Source: <https://github.com/orgs/home-assistant/discussions/2226> (repository `home-assistant/feature-requests`).

- Opened 2025-12-29. It asks for SmartThings support of the Family Hub internal cameras.
- A maintainer (joostlek, 2026-01-01) replied that the integration uses only the SmartThings API, so
  unsupported data cannot be added.
- Replies point to [ibielopolskyi/smartthings_fridge_camera](https://github.com/ibielopolskyi/smartthings_fridge_camera/blob/86f07fdea22dd29e915fed5f606c2dc21ddc9854/custom_components/samsung_familyhub_fridge/api.py),
  which works through **undocumented** endpoints:
  - `GET https://api.smartthings.com/v1/devices/{id}/components/main/status` returns
    `samsungce.viewInside.contents.value[].fileId`.
  - `GET https://client.smartthings.com/udo/file_links/{fileId}?cid=<Samsung app client id>&di={id}`
    returns the JPEG.
  - `POST /v1/devices/{id}/commands` with an OCF `execute` on `/udo/contents/provider/vs/0` and
    `x.com.samsung.da.command: refresh` asks the fridge to recapture.
  - The repository hard-codes the client id. Its README says it is a proof of concept.
- The original poster notes that token logins expire after 24h, which matches SmartThings personal
  access tokens.
- 2026-08-06: a reply links to the SmartThings developer-fee discussion. As of this date, the
  official integration still has no fridge camera support.

**Conclusion:** the internal cameras produce **stills captured when the door closes**, with no live
stream. The only off-device access is the undocumented API above. This project uses it behind an
explicit opt-in (`SMARTTHINGS_VIEWINSIDE_CID` must be set, and there is no default) and fetches only
file ids the device currently advertises.

## 2. Family Hub and Tizen platform

- **Developer access.** Samsung lists a "Family Hub SDK", but
  <https://developer.samsung.com/family-hub/develop/partner/getting-started.html> redirects to a
  Samsung Account sign-in. The SDK is a partner program, and there is no public store submission
  path for Family Hub. Developer mode (Apps → App Settings → `12345` → host IP) is documented
  **for TVs**
  (<https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html>).
  No equivalent is documented for Family Hub (**unverified** on device).
- **Web engine.** Samsung's TV web engine table
  (<https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html>):

  | Platform | Engine | WebRTC | `getUserMedia` |
  | --- | --- | --- | --- |
  | Tizen 10.0 (2026) | Chromium M130 | Yes | Yes (basic) |
  | Tizen 9.0 (2025) | Chromium M120 | Partial | No |
  | Tizen 8.0 (2024) and older | ≤ M108 | No | No |

  Family Hub is not in this table, and its engine version is not published publicly. The app reports
  what is available at runtime (capability chips on the home screen) instead of assuming.
- **Cameras.** The View Inside cameras sit inside the fridge, and no public Tizen API exposes them
  to third-party apps. Whether a given Family Hub has a **user-facing** camera that web apps can
  reach through `getUserMedia` is **unverified**. Without one, the fridge receives video but sends
  only audio (if a microphone is reachable) and the inside-photo still.
- **Privileges.** A Tizen web app needs `http://tizen.org/privilege/internet` and, for capture,
  `http://tizen.org/privilege/mediacapture`. Partner-level privileges and the Family Hub profile id
  come from the partner SDK and are not reproduced here.

## 3. Chert SDK (`trychert/sdk`)

`github.com/trychert/sdk` returns 404. The SDK is the npm package `@trychert/sdk` (MIT), with source
at <https://github.com/cherthq/sdk>. This project pins `@trychert/sdk@0.2.0`.

- **FaceTime control plane** (`@trychert/sdk/facetime`): `createCall`, `getCall`, `endCall` and the
  incoming-call webhook types. The SDK **is not a media runtime**.
  - `customer_managed` calls take a LiveKit URL, a call-scoped `participant_token` for Chert's
    worker, and `remote_participant_identity`, which is the participant Chert bridges to FaceTime.
  - Incoming calls are decided by returning `{action:'accept', …room}` or `{action:'decline'}` from
    the webhook. The webhook is signed `X-Chert-Signature: sha256=<HMAC(raw body)>`, as in
    `chert-facetime` `webhook-core.ts`.
- **iMessage** (`@trychert/sdk/imessage`):
  - `verifyWebhook` checks `x-chert-signature: v1,<ts>,<HMAC(ts.body)>` with a 300s window.
  - `message.received` events carry `data.chat.id` and `data.message.sender_handle` plus text
    `parts`.
  - Replies go to `POST /chats/{id}/messages`. Photos go through `POST /attachments`, then a `PUT`
    of the bytes to `upload_url`, then a `media` part.
- **Not provided:** a FaceTime endpoint that runs on non-Apple hardware. FaceTime is proprietary,
  so the fridge can only be a LiveKit participant bridged by Chert's Mac worker.

## Answers

| Question | Answer |
| --- | --- |
| Video calls that feel like FaceTime from the fridge? | **Yes, bridged.** iPhone users get a real FaceTime call from the Chert line. The fridge is a WebRTC participant. This needs WebRTC in the fridge's engine (likely Tizen 9 or later, unverified). |
| Show the internal camera view? | **Stills only.** View Inside photos on the fridge screen, as iMessage attachments, and as a still in the call. No live interior video exists. |
| Control from iMessage? | **Yes.** All actions start from the Chert line, and the fridge cannot dial. |

## What was verified (no real device)

- **Bridge contract tests (`bun run test`):**
  - Signatures for both webhooks.
  - Strangers and group chats are silently ignored.
  - Photos upload and attach, and a redelivered event does not send a second reply.
  - The API key is never sent to a foreign upload origin.
  - `call` places FaceTime only after the fridge answers, with the fridge identity as
    `remote_participant_identity`.
  - The FaceTime accept, decline and timeout paths.
  - View Inside fetches only file ids the device advertises.
- **Browser run against `livekit-server --dev`, with a page standing in for Chert's worker:**
  - The fridge page answered a texted `call`.
  - The stand-in received the fridge's audio and video.
  - **Show inside** replaced the outgoing video with the interior still (sampled pixel 238,235,227,
    matching the demo photo) and then restored the camera (sampled pixel 51,255,0, the fake camera).
  - Hang-up released the local tracks.
