# Deployment

## Prerequisites

**Fridge**
- Samsung Family Hub on current firmware, on Wi-Fi and registered in SmartThings.
- View Inside cameras, with a SmartThings device that exposes `samsungce.viewInside`. Check with
  `GET /v1/devices/{id}/components/main/status`.
- The fridge screen needs only `fetch` and images. It does not need WebRTC, a camera or a
  microphone.

**Chert**
- An iMessage line with an API key and a webhook subscription for `message.received` pointing at
  `https://<bridge>/webhooks/chert/imessage`. Save the subscription secret.
- A FaceTime-enabled line, with:
  - its project id and line id;
  - a token with `facetime:read` and `facetime:write`;
  - a **published assistant** (`CHERT_ASSISTANT_ID`) that hosts the calls. Write its instructions
    for a family fridge, for example telling the caller the photos are in their Messages.
- Direct FaceTime calls to the line are not handled by the bridge. Set the line's inbound policy
  (for example `auto_reject`, or `auto_answer` with the same assistant).
- iMessage and FaceTime credentials are separate. If the two lines use different handles, family
  members text one and receive FaceTime from the other.

**Bridge host**
- Bun 1.3 or later behind public HTTPS. Chert's webhook and the fridge must both reach it.

## Configure

```sh
FRIDGE_DEVICE_TOKEN=$(openssl rand -hex 32)
FRIDGE_CONTACTS='[{"label":"Mum","handle":"+61400000001"},{"label":"Sam","handle":"sam@icloud.com"}]'
FRIDGE_LINE_LABEL='+61 400 555 010'
FRIDGE_ALLOWED_ORIGINS=null              # packaged Tizen app; hosted mode is same-origin
CHERT_API_KEY=…  CHERT_IMESSAGE_WEBHOOK_SECRET=…
CHERT_FACETIME_TOKEN=…  CHERT_PROJECT_ID=…  CHERT_LINE_ID=…  CHERT_ASSISTANT_ID=…
CHERT_CALL_VIDEO=true                    # false for audio-only FaceTime
SMARTTHINGS_DEVICE_ID=…  SMARTTHINGS_VIEWINSIDE_CID=…  # see FEASIBILITY.md §1 before enabling
SMARTTHINGS_TOKEN=…                      # 24h PAT, or the OAuth refresh variables below:
# SMARTTHINGS_CLIENT_ID=… SMARTTHINGS_CLIENT_SECRET=… SMARTTHINGS_REFRESH_TOKEN=… SMARTTHINGS_STATE_FILE=/var/lib/familyhub-call/st-refresh
```

Each feature turns on only when its variables are set. Missing pieces show on the fridge's home
screen. Then build and run:

```sh
BRIDGE_ORIGIN=https://fridge-bridge.example.com bun run build
HOST=127.0.0.1 PORT=8787 bun run bridge   # put a TLS reverse proxy in front
```

## Put the screen on the fridge

1. **Hosted page (no signing).** On the Family Hub, open the Internet browser, go to
   `https://<bridge>/`, then pair by pasting the device token.
   - Because the page is display-only, browser permission limits do not matter.
   - The page updates only while it is open.
2. **Packaged Tizen app.** This needs Samsung Family Hub partner access.
   - Sign `dist/familyhub-call.wgt` with a Samsung certificate profile in Tizen Studio:
     `tizen package -t wgt -s <profile> -- dist/familyhub-call.wgt`
   - Install with `sdb connect <fridge-ip>`, then
     `tizen install -n familyhub-call.wgt -t <device>`.
   - Developer mode and `sdb` are documented for TVs (Apps → App Settings → `12345`) but **not for
     Family Hub**. Replace `config.xml`'s package id and profile with the values the partner SDK
     assigns.

The fridge screen is optional. Texting and calls work with no app on the fridge at all.

## Removing access

- To lock the fridge screen out, rotate `FRIDGE_DEVICE_TOKEN`.
- To remove a family member, take their entry out of `FRIDGE_CONTACTS`.
- Revoke Chert and SmartThings credentials at their providers.
