# Deployment

## Prerequisites

**Fridge**
- Samsung Family Hub on current firmware, connected to Wi-Fi and registered in SmartThings.
- To display interior photos: a model with View Inside cameras, and a SmartThings device that
  exposes `samsungce.viewInside`. Check with
  `GET /v1/devices/{id}/components/main/status`.
- To join calls: WebRTC in the fridge's web engine. Open the bridge page and check the capability
  chips; `WebRTC: yes` is required. A microphone or camera reachable through `getUserMedia` is
  optional.

**Chert**
- An iMessage line with an API key and a webhook subscription for `message.received` pointing at
  `https://<bridge>/webhooks/chert/imessage`. Save the subscription secret.
- A FaceTime-enabled line with project id, line id and a token with `facetime:read` and
  `facetime:write`. Set its inbound policy to `customer_decides` and add a **signed** webhook
  integration pointing at `https://<bridge>/webhooks/chert/facetime`.
  - iMessage and FaceTime credentials are separate. If the two lines use different handles, a
    family member texts one and receives FaceTime from the other. Point the fridge label at the
    texting line.

**Media**
- A LiveKit server (LiveKit Cloud or self-hosted with TURN) reachable by both the fridge and
  Chert's workers. You need its `wss://` URL, API key and secret.

**Bridge host**
- Bun 1.3 or later, behind public HTTPS. Chert webhooks and the fridge must both reach it.

## Configure

```sh
FRIDGE_DEVICE_TOKEN=$(openssl rand -hex 32)
FRIDGE_CONTACTS='[{"label":"Mum","handle":"+61400000001"},{"label":"Sam","handle":"sam@icloud.com"}]'
FRIDGE_LINE_LABEL='+61 400 555 010'
FRIDGE_ALLOWED_ORIGINS=null              # packaged Tizen app; hosted mode is same-origin
CHERT_API_KEY=…  CHERT_IMESSAGE_WEBHOOK_SECRET=…
CHERT_FACETIME_TOKEN=…  CHERT_PROJECT_ID=…  CHERT_LINE_ID=…  CHERT_FACETIME_WEBHOOK_SECRET=…
LIVEKIT_URL=wss://…  LIVEKIT_API_KEY=…  LIVEKIT_API_SECRET=…
SMARTTHINGS_DEVICE_ID=…  SMARTTHINGS_VIEWINSIDE_CID=…  # see FEASIBILITY.md §1 before enabling
SMARTTHINGS_TOKEN=…                      # 24h PAT, or the OAuth refresh variables below:
# SMARTTHINGS_CLIENT_ID=… SMARTTHINGS_CLIENT_SECRET=… SMARTTHINGS_REFRESH_TOKEN=… SMARTTHINGS_STATE_FILE=/var/lib/familyhub-call/st-refresh
```

Each feature turns on only when its variables are set. Missing pieces show on the fridge's home
screen. Then build and run:

```sh
BRIDGE_ORIGIN=https://fridge-bridge.example.com LIVEKIT_URL=wss://… bun run build
HOST=127.0.0.1 PORT=8787 bun run bridge   # put a TLS reverse proxy in front
```

## Put it on the fridge

Two routes, from most to least practical:

1. **Hosted page (no signing).** On the Family Hub, open the Internet browser, go to
   `https://<bridge>/`, then pair by pasting the device token.
   - Bookmark the page or add it to the home screen if the firmware allows.
   - Limits: the browser may block camera and microphone access or suspend background polling, so
     ringing works only while the page is open.
2. **Packaged Tizen app.** This needs Samsung Family Hub partner access.
   - Sign `dist/familyhub-call.wgt` with a Samsung certificate profile in Tizen Studio:
     `tizen package -t wgt -s <profile> -- dist/familyhub-call.wgt`
   - Install over `sdb`: `sdb connect <fridge-ip>`, then
     `tizen install -n familyhub-call.wgt -t <device>`.
   - Both steps assume the fridge exposes developer mode and `sdb`, which is **not documented for
     Family Hub**. TVs document it (Apps → App Settings → `12345`). Replace `config.xml`'s package
     id and profile with the values the partner SDK assigns.

## Removing access

- To lock the fridge out, rotate `FRIDGE_DEVICE_TOKEN`; the fridge falls back to the pairing
  screen.
- To remove a family member, take their entry out of `FRIDGE_CONTACTS`.
- Revoke the Chert, LiveKit and SmartThings credentials at their providers.
