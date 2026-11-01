# woof.fwkion.com: Ollie's QR tag page

Anyone who scans Ollie's tag lands here. Every visit is recorded and pings our
phones on Telegram, and the visitor can report that they've found him by
pointing at a map or giving a what3words address. The page never shows his
name.

```
woof/
├── web/              static site (S3). No build step, no runtime CDN.
│   ├── index.html    landing → "I've found this dog" form → thank-you
│   ├── app.js        visit recording, geolocation, maps, claim form
│   ├── fingerprint.js  device/browser/network fingerprint
│   ├── config.js     apiBase, ownerPhone, photoUrl… (overwrite at deploy)
│   └── vendor/leaflet/ Leaflet 1.9.4 (BSD-2), map library
├── api/              one Lambda function (Node.js 22, zero dependencies)
│   ├── handler.mjs   routes
│   └── lib/          store (DynamoDB / local file), notify (Telegram),
│                     context (IP, headers, geo-IP), validate, w3w
├── dev/server.mjs    local server: web/ + /api → handler
└── test/             node:test suite
```

## Run it locally

```sh
cd woof
npm test                      # API unit tests
npm run dev                   # http://localhost:8080
```

Locally, records go to `dev/data.json` and notifications print to the
terminal. To get real Telegram messages while testing:

```sh
TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_IDS=-100123 DOG_NAME=Ollie npm run dev
```

(Browsers only allow geolocation on `https://` or `localhost`. To try it
from a phone, use a tunnel such as `cloudflared tunnel --url http://localhost:8080`.)

## What gets captured

**Every visit** (`POST /api/visit`, sent automatically on page load):

| Source | Data |
|---|---|
| Server | IP address; ISP / ASN / city / approximate coordinates (CloudFront geo headers and/or an [ipwho.is](https://ipwho.is) lookup); User-Agent, Accept-Language, `Sec-CH-UA-*` client hints, referrer |
| Browser | UA + high-entropy client hints (exact Android model, OS version, browser version), languages, time zone, screen/viewport/pixel ratio, CPU cores, memory, touch points, GPU (WebGL unmasked renderer), canvas hash, battery level/charging, connection type/speed/RTT, camera/mic counts, geolocation permission state, `?query` params from the QR URL |
| WebRTC | Public IP(s) seen via STUN. These can differ from the HTTP IP (VPN, IPv6, mobile carrier NAT) |
| Correlation | Persistent visitor id + visit counter (localStorage), and a fingerprint hash that survives clearing storage |

**Precise location** (`POST /api/visit/{id}/location`): the page asks for
the browser's location as soon as it opens. If the visitor allows it, the first
GPS/Wi-Fi fix is sent, plus up to two more if accuracy improves a lot. Each
fix arrives on Telegram as a native map pin.

**Found claim** (`POST /api/found`): where they are now (GPS button,
tap-the-map, or what3words), where they found him ("same place" by default),
plus phone, name and message. You get an alert message and map pins.

### Limits worth knowing
- **Wi-Fi details (SSID, router MAC, nearby networks) can't be read from a
  web page.** No browser exposes them. The closest you'll get is the public
  IP + ISP (home broadband vs mobile network, and the area) and the connection
  type. When the visitor allows location, the browser's own location is
  already Wi-Fi-assisted, which is why indoor fixes are often ±10–30 m.
- Precise location always needs the visitor to tap "Allow". Everything else
  is captured silently.
- iOS Safari exposes much less than Android Chrome (no client hints, no
  battery or connection info, and a generic GPU name).
- what3words → coordinates conversion only happens if `W3W_API_KEY` is set.
  Without it you still get a tappable `what3words.com/…` link, which opens the
  exact square.

### Privacy
The footer tells visitors what is recorded and why. This is the honest thing
to do, and under UK/EU GDPR it is effectively required for collecting
IP/fingerprint/location data. Keep it, and consider a DynamoDB TTL (for
example 1 year) so old visits expire.

## Telegram setup (5 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → copy the token.
2. Create a group with both of you in it and add the bot.
3. Send any message in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`
   (a negative number such as `-1001234567890`).
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_IDS` on the Lambda. Several
   chat ids can be comma-separated.

Turn on notifications for that group, and maybe a custom sound, so a found
alert is hard to miss.

## Lambda configuration

| Env var | Required | Purpose |
|---|---|---|
| `TABLE_NAME` | yes | DynamoDB table, partition key `id` (String) |
| `TELEGRAM_BOT_TOKEN` | yes | bot token |
| `TELEGRAM_CHAT_IDS` | yes | comma-separated chat ids |
| `DOG_NAME` | no | used in *your* notifications only (default "the dog") |
| `DISPLAY_TZ` | no | time zone for timestamps (default `Europe/London`) |
| `W3W_API_KEY` | no | resolve what3words to coordinates |
| `IP_LOOKUP` | no | `off` disables the ipwho.is lookup |
| `ALLOWED_ORIGIN` | no | CORS origin if the API is on a different domain (default `*`) |

Runtime: `nodejs22.x`, handler `handler.handler`, zip the contents of
`api/`. The AWS SDK comes with the runtime, so there is nothing to install.
IAM: `dynamodb:PutItem` and `dynamodb:UpdateItem` on the table. Allow a
timeout of about 10 s, because the function waits for Telegram before
responding.

## Notes for the Terraform step

Recommended shape: **one CloudFront distribution for `woof.fwkion.com`**
- default behaviour → S3 bucket (private, Origin Access Control), `index.html`
  as default root object
- `/api/*` behaviour → API Gateway HTTP API (or a Lambda Function URL with
  OAC), caching disabled, all methods allowed
- origin request policy for `/api/*` must forward `User-Agent`,
  `Accept-Language`, `Sec-CH-UA*`, and **`CloudFront-Viewer-Address`** plus
  the `CloudFront-Viewer-*` geo headers (country, city, region, postal code,
  lat/long, time zone, ASN). Those give the real client IP and free geo-IP.
- ACM certificate in us-east-1, Route 53 alias record
- to get the high-entropy client hints (phone model) on the *first* request,
  add a response headers policy on the default behaviour with
  `Accept-CH: Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List`
  (the JS collects them anyway, so this is optional)

With the API on the same origin there is no CORS, and `config.js` keeps
`apiBase: '/api'`.

Abuse protection: anyone can POST to the API, so use API Gateway stage
throttling (for example 5 rps, burst 10) and/or a low reserved concurrency on
the Lambda, so a script can't flood your phones or your bill.

**QR code**: encode `https://woof.fwkion.com/?t=tag` (the `t` param shows up
in notifications, so you can tell tag scans apart from links you've shared).
Use high error correction (level H), because tags get scratched.
