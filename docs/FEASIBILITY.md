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

  Family Hub is not in this table, and its engine version is not published publicly. The current
  design does not depend on this table: the fridge screen needs only `fetch` and `<img>`, with no
  WebRTC or `getUserMedia`.
- **Cameras.** The View Inside cameras sit inside the fridge, and no public Tizen API exposes them
  to third-party apps. The fridge's own microphone and any user-facing camera are deliberately
  unused.
- **Privileges.** The app needs only `http://tizen.org/privilege/internet`. Partner-level privileges
  and the Family Hub profile id come from the partner SDK and are not reproduced here.

## 3. Chert SDK (`trychert/sdk`)

`github.com/trychert/sdk` returns 404. The SDK is the npm package `@trychert/sdk` (MIT), with source
at <https://github.com/cherthq/sdk>. This project pins `@trychert/sdk@0.2.0`.

- **FaceTime control plane** (`@trychert/sdk/facetime`): `createCall`, `getCall` and `endCall`.
  The SDK **is not a media runtime**. `CreateCall` has exactly two modes:
  - `managed` requires `assistant_id` and requested media. A Chert assistant is the far end, and its
    video is `disabled`, `test_pattern` or an `anam` avatar. The assistant's `background` field is
    an undocumented string of up to 300 characters.
  - `customer_managed` requires a LiveKit room (`livekit_url`, `participant_token`,
    `remote_participant_identity`).

  With LiveKit removed, this project uses `managed` calls. Accepting an inbound FaceTime through the
  customer webhook also requires a LiveKit room. Direct FaceTime calls to the line therefore follow
  the line's own Chert inbound policy and are not handled by the bridge.
- **iMessage** (`@trychert/sdk/imessage`):
  - `verifyWebhook` checks `x-chert-signature: v1,<ts>,<HMAC(ts.body)>` with a 300s window.
  - `message.received` events carry `data.chat.id` and `data.message.sender_handle` plus text
    `parts`.
  - Replies go to `POST /chats/{id}/messages`. Photos go through `POST /attachments`, then a `PUT`
    of the bytes to `upload_url`, then a `media` part.
- **Not provided:**
  - a FaceTime endpoint that runs on non-Apple hardware;
  - a way to put an arbitrary image into a FaceTime video without a media room.

## Answers

| Question | Answer |
| --- | --- |
| A FaceTime call from the fridge line? | **Yes, Chert-managed.** The line FaceTimes the family member and a Chert assistant hosts the call. The fridge contributes no audio or video. |
| Show the internal camera view alongside it? | **Yes, as stills in the same iMessage chat.** The photos arrive just before the call and again on `retake` during it. They do not appear inside the FaceTime video, and no live interior video exists. |
| Control from iMessage? | **Yes.** Every action starts from a text to the line. The fridge only displays. |

## What was verified (no real device, no live accounts)

- **Bridge contract tests (`bun run test`, 9 pass):**
  - The webhook signature is checked, and strangers and group chats are silently ignored.
  - Photos are uploaded and attached once per event, and the API key never goes to a foreign
    upload origin.
  - `call` sends the photos before a `managed` `createCall` to the sender. A failed photo upload
    still lets the call go ahead.
  - A second `call` is refused while one is active, `end` hangs up, and calls that Chert reports as
    ended are cleared.
  - View Inside fetches only file ids the device advertises.
- **Browser run of the fridge page against the demo bridge:**
  - A texted `call` produced one chat reply, then one managed FaceTime request.
  - The fridge showed "FaceTime with Mum: connected · these photos were sent to their iMessage",
    and cleared it after `end`.
  - The page never called `getUserMedia`.
