# familyhub-call

A proof of concept for a Samsung Family Hub fridge that a Chert iMessage line controls. Family members
text the line to get photos of the fridge's interior, or to start a FaceTime video call that rings
the fridge screen. The fridge cannot dial out. It shows the interior photos and answers or declines
calls.

**Verdict.** A call that feels like FaceTime is feasible only as a bridged call. Chert's Mac worker
handles the real FaceTime leg, and the fridge joins as a WebRTC (LiveKit) participant. The fridge's
internal cameras are **not a live video feed**. They are stills taken after the door closes, read
through undocumented SmartThings APIs. Both features have been verified against fakes and a local
LiveKit server. Nothing has been verified on a real fridge, and three blockers remain (see below).
Details and sources: [docs/FEASIBILITY.md](docs/FEASIBILITY.md).

```diagram
 family iPhone                    Chert line (Mac worker)            bridge (this repo)           Family Hub
┌──────────────┐  iMessage   ┌────────────────────────┐ webhook ┌──────────────────────┐ poll ┌─────────────┐
│ "inside"     │────────────▶│ message.received        │────────▶│ allowlist + commands │◀─────│ fridge app  │
│ "call"       │◀────────────│ replies + photo media   │◀────────│ Chert SDK            │─────▶│ ring/answer │
│              │  FaceTime   │ FaceTime leg            │         │ LiveKit token mint   │      │ photos      │
│              │◀───────────▶│ joins LiveKit room ◀────┼── WebRTC (LiveKit) ────────────┼─────▶│ WebRTC      │
└──────────────┘             └────────────────────────┘         │ SmartThings proxy    │      └─────────────┘
                                                                 └──────────┬───────────┘
                                                                            │ undocumented viewInside API
                                                                     SmartThings cloud
```

## What the line does

| Text from an allowlisted 1:1 chat | Result |
| --- | --- |
| `inside` (also `fridge`, `photo`, `pics`) | Replies with the latest View Inside photos attached as iMessage media |
| `retake` | Asks the fridge to recapture, waits up to 30s for new photos, then replies with them |
| `call` (also `facetime`, `video`) | Rings the fridge for 45s. The line FaceTimes the sender **only after someone at the fridge answers** |
| `end` | Ends the active fridge call |
| anything else | Replies with the command list |

FaceTiming the line directly from an allowlisted handle also rings the fridge. While it rings, the
Chert incoming-call webhook is held open for about 10s. Unknown senders and group chats get **no
reply at all**. During a call, **Show inside** swaps the fridge's outgoing camera for a still of the
interior, so the caller sees inside the fridge.

## Layout

- `bridge/`: Bun server. `imessage.ts` parses commands and sends replies with photo attachments.
  `bridge.ts` handles webhooks, rings, LiveKit tokens and the fridge API. `smartthings.ts` handles
  View Inside.
- `app/`: the fridge UI, as a Tizen web app (`config.xml`) that the bridge can also host for the
  Family Hub browser.
- `scripts/build.ts`: builds `dist/app` and an **unsigned** `dist/familyhub-call.wgt`.
  `scripts/demo.ts`: runs the real bridge against fake Chert and SmartThings services.
- `tests/`: bridge contract tests.

## Run it

```sh
bun install
bun run typecheck && bun run test
livekit-server --dev --bind 127.0.0.1 &   # optional: real media locally
bun run demo                              # http://127.0.0.1:8787, token printed
curl -X POST localhost:8787/demo/text -d inside   # simulate Mum texting the line
curl -X POST localhost:8787/demo/text -d call     # fridge rings; answer on screen
```

Production setup, device prerequisites and installation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
Privacy and security model: [docs/SECURITY.md](docs/SECURITY.md).

## Blockers

1. **Installing on the fridge.** Family Hub app development is a login-gated Samsung partner
   program. No public developer mode or sideloading process is documented for Family Hub, only for
   TVs. Fallback: open the bridge-hosted page in the Family Hub web browser.
2. **WebRTC and camera access on the fridge are unconfirmed.** In Samsung's published TV engines,
   WebRTC is only partial on Tizen 9 and full on Tizen 10, and `getUserMedia` exists only on Tizen 10.
   Samsung does not publish the Family Hub engine version or say whether it has a user-facing camera.
   The app detects what is available and falls back to receive-only.
3. **The interior photos rely on private SmartThings APIs.** `samsungce.viewInside` and
   `client.smartthings.com/udo/file_links` are undocumented, need a Samsung app client id, and can
   change at any time. SmartThings personal access tokens expire after 24h, so the bridge supports
   OAuth refresh. That refresh flow has not been verified live.

Chert setup still needed: an iMessage line with a `message.received` webhook subscription, and a
FaceTime-enabled line with `customer_decides` inbound policy plus a signed incoming-call webhook.
No live Chert, SmartThings or fridge request has been made from this repository.
