# familyhub-call

Proof of concept: a Samsung Family Hub fridge controlled entirely by a Chert iMessage line. Family
members text the line for interior photos or a FaceTime call. When they ask for a call, the photos
arrive in their iMessage chat first and the FaceTime call follows. The fridge plays no part in the
call's audio or video. It only shows the photos and the call status.

**Verdict:** this design is feasible with public Chert APIs.

- **The FaceTime call is Chert-managed.** Chert needs either a media room or a Chert assistant on the
  far end. With no media room, the call is hosted by a Chert assistant (`CHERT_ASSISTANT_ID`).
- **The interior image arrives as iMessage photos next to the call, not inside the FaceTime video.**
  The public SDK cannot inject an arbitrary image into the video without a media room.
- **The internal cameras are not live.** They produce stills captured after the door closes, read
  through undocumented SmartThings APIs.

Nothing has been verified on a real fridge or live Chert account. Research and sources:
[docs/FEASIBILITY.md](docs/FEASIBILITY.md).

```diagram
 family iPhone                Chert line                     bridge (this repo)              Family Hub
┌──────────────┐ iMessage ┌──────────────────┐ webhook  ┌───────────────────────┐  poll  ┌──────────────┐
│ "call"       │─────────▶│ message.received │─────────▶│ allowlist + commands  │◀───────│ display-only │
│ photos  ◀────┼──────────│ chat replies     │◀─────────│ photo attachments     │───────▶│ photos       │
│ FaceTime ◀───┼──────────│ managed FaceTime │◀─────────│ createCall (managed)  │        │ call status  │
└──────────────┘          └──────────────────┘          └───────────┬───────────┘        └──────────────┘
                                                                    │ undocumented viewInside API
                                                             SmartThings cloud
```

## What the line does

| Text from an allowlisted 1:1 chat | Result |
| --- | --- |
| `inside` (also `fridge`, `photo`, `pics`) | Replies with the latest View Inside photos as iMessage attachments |
| `retake` | Asks the fridge to recapture, waits up to 30s, then replies with the new photos. Works during a call too |
| `call` (also `facetime`, `video`) | Sends the photos into the chat, then the line places a managed FaceTime call to the sender |
| `end` | Ends the line's active call |
| anything else | Replies with the command list |

Unknown senders and group chats get no reply at all. One call runs at a time.

## Layout

- `bridge/`: Bun server.
  - `imessage.ts`: parses commands and sends replies with photo attachments.
  - `bridge.ts`: webhook, command handling, call state and the fridge API.
  - `smartthings.ts`: View Inside.
- `app/`: the display-only fridge screen. It packages as a Tizen web app (`config.xml`), or the bridge
  can host it for the Family Hub browser.
- `scripts/build.ts`: builds `dist/app` and an **unsigned** `dist/familyhub-call.wgt`.
- `scripts/demo.ts`: runs the real bridge against fake Chert and SmartThings.
- `tests/`: bridge contract tests.

## Run it

```sh
bun install
bun run typecheck && bun run test
bun run demo                                      # http://127.0.0.1:8787, token printed
curl -X POST localhost:8787/demo/text -d call     # simulate Mum texting the line
curl localhost:8787/demo/replies; curl localhost:8787/demo/calls
```

Production setup and fridge installation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Privacy and
security model: [docs/SECURITY.md](docs/SECURITY.md).

## Constraints and blockers

1. **A Chert assistant hosts the call.** A managed FaceTime call requires `assistant_id`, so the
   caller talks to a Chert assistant, not to the fridge or a person at it.
   - Without a media room, the image cannot go inside the FaceTime video. The assistant's video
     settings are `disabled`, `test_pattern` or an avatar.
   - The assistant's `background` field is undocumented and is not used here.
2. **Installing on the fridge.** Family Hub app development is a login-gated Samsung partner
   program, and sideloading is documented only for TVs. Fallback: open the bridge-hosted page in the
   Family Hub browser. The page needs only `fetch`, not WebRTC or a camera.
3. **The photos rely on private SmartThings APIs.**
   - `samsungce.viewInside` and `udo/file_links` are undocumented and need a Samsung app client id.
   - Personal access tokens expire after 24h. The bridge supports OAuth refresh, which has not been
     tested live.
4. **Chert setup is required:**
   - an iMessage line with a `message.received` webhook subscription;
   - a FaceTime-enabled line with a published assistant.
   - iMessage and FaceTime credentials are separate. If the two lines use different handles, the
     FaceTime call comes from the FaceTime line's handle.
