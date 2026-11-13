# ping

**Web push notifications without building your own notification backend.**

ping is a small, serverless Web Push relay that runs on Cloudflare Workers. Developers add a service worker to their site, let visitors opt in, and send notifications through a project-scoped endpoint.

> **What “API-less” means here:** developers do not need to operate their own notification server or integrate a push vendor SDK. ping itself exposes a small HTTP API and uses the browser's standard Web Push service. It is not literally API-free.

## Features

- Cloudflare Worker — no VPS or always-on server
- Browser-native Web Push using VAPID
- Project-scoped API keys
- Exact allowed-origin checks when subscribing
- Channels for grouping subscribers
- Broadcast to a channel or target one device
- Expired subscription cleanup on HTTP 404/410
- Small owner dashboard for creating projects and sending tests
- Cloudflare KV storage
- No Firebase project or third-party notification vendor account required

## Architecture

1. A site registers its own `/sw.js` service worker.
2. A visitor explicitly opts in to notifications.
3. The browser creates a PushSubscription and sends it to `POST /v1/subscribe`.
4. ping stores the subscription in Cloudflare KV.
5. The developer's trusted backend calls `POST /v1/send` with its project API key.
6. ping encrypts the payload and forwards it to the browser's push service.
7. The browser wakes the service worker and displays the notification.

The recipient's browser chooses its push service. The website must use HTTPS (localhost is allowed for development). On iOS/iPadOS, web push is available for web apps added to the Home Screen.

## Deploy to Cloudflare

### Requirements

- A Cloudflare account with Workers enabled
- A GitHub account if you want automatic deploys from GitHub
- Node.js 20+ and npm for local deployment
- A Cloudflare KV namespace

### 1. Create the KV namespace

```bash
npx wrangler kv namespace create DB
```

Copy the returned namespace ID into `wrangler.jsonc`, replacing:

```json
"id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

### 2. Install dependencies

```bash
npm install
```

### 3. Generate VAPID keys

Generate one VAPID key pair for this deployment. Do not regenerate it after users have subscribed unless you are deliberately rotating keys and re-subscribing users.

```bash
npx @pushforge/builder vapid
```

Keep the private JWK secret. The public key is safe to expose.

### 4. Set Worker secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_SUBJECT
```

Values:

- `ADMIN_TOKEN`: a long, random secret used only by you to unlock the dashboard.
- `VAPID_PRIVATE_KEY`: the private JWK generated in step 3, as JSON.
- `VAPID_PUBLIC_KEY`: the matching public VAPID key in base64url format.
- `VAPID_SUBJECT`: a contact URI such as `mailto:you@example.com`.

Never commit secrets or put the admin token / project API keys in public browser JavaScript.

### 5. Deploy

```bash
npx wrangler deploy
```

Wrangler will publish the Worker to its `workers.dev` address. Open that address to use the owner dashboard.

### 6. Connect GitHub for deploy-on-push

In Cloudflare:

1. Open **Workers & Pages**.
2. Select **Create application → Connect to Git** (or choose GitHub from the creation options).
3. Authorize Cloudflare's GitHub app and select this repository.
4. Select the `main` branch and the repository root.
5. Confirm the Worker name is `ping-push-api`, then select **Save and Deploy**.

The KV binding and Worker secrets still need to be configured in Cloudflare. Once connected, pushes to the production branch trigger deployments automatically. Use either Cloudflare Workers Builds or a separate GitHub Actions deployment workflow, not both.

## Dashboard

Open your Worker URL. Enter `ADMIN_TOKEN` to unlock the dashboard.

You can:
- Create a project with a name and one or more exact website origins.
- Copy the generated project ID and API key.
- Send a test notification to a channel.
- View existing project IDs and allowed origins.

The API key is shown once at creation. Save it securely. If lost, create a replacement project or add key rotation before using this for production.

## Integrate a website

Copy `examples/sw.js` to the root of the developer's website as `/sw.js`. A service worker must be served from the site's own origin.

Copy `examples/subscribe.js` into the site and replace:

```js
const PING_API = "https://YOUR-WORKER.workers.dev";
const PING_PROJECT_ID = "YOUR_PROJECT_ID";
const PING_CHANNEL = "general";
```

Call `enablePingNotifications()` from a user click:

```html
<button id="enable-push">Enable notifications</button>
<script type="module">
  import { enablePingNotifications } from "/subscribe.js";

  document.querySelector("#enable-push").addEventListener("click", async () => {
    try {
      const result = await enablePingNotifications();
      console.log("Notifications enabled", result.deviceId);
    } catch (error) {
      console.error(error);
    }
  });
</script>
```

The visitor must explicitly grant permission. Do not trigger the permission prompt automatically on page load.

## Send a notification

Send from a trusted backend, serverless function, or other environment where the project key can remain secret:

```js
const response = await fetch("https://YOUR-WORKER.workers.dev/v1/send", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer YOUR_PROJECT_API_KEY"
  },
  body: JSON.stringify({
    projectId: "YOUR_PROJECT_ID",
    channel: "general",
    title: "New message",
    body: "You have a new message.",
    url: "/inbox"
  })
});

console.log(await response.json());
```

To target one device, add the `deviceId` returned by `/v1/subscribe`:

```json
{
  "projectId": "YOUR_PROJECT_ID",
  "channel": "general",
  "deviceId": "DEVICE_ID",
  "title": "A private update",
  "body": "This is for one subscribed device.",
  "url": "/inbox"
}
```

**Do not call `/v1/send` with a private API key from public frontend JavaScript.** Anyone can inspect browser code and steal it. If your site has no backend at all, use a trusted serverless function or an authenticated platform function as the sender. The subscriber code can run entirely in the browser.

## API reference

All request and response bodies are JSON.

### `GET /health`

Public health check.

### `GET /v1/public-key`

Returns the public VAPID key:

```json
{ "publicKey": "..." }
```

### `POST /v1/admin/projects`

Admin-only. Header: `Authorization: Bearer ADMIN_TOKEN`.

```json
{
  "name": "My website",
  "origins": ["https://example.com", "https://www.example.com"]
}
```

Returns a project ID and a one-time project API key.

### `GET /v1/admin/projects`

Admin-only. Lists project names, IDs, allowed origins, and creation dates. Does not return project API keys.

### `POST /v1/subscribe`

Public, but requires an `Origin` header matching one of the project's allowed origins.

```json
{
  "projectId": "PROJECT_ID",
  "channel": "general",
  "subscription": {
    "endpoint": "https://push-service.example/...",
    "keys": { "p256dh": "...", "auth": "..." }
  }
}
```

Returns `deviceId`.

### `POST /v1/unsubscribe`

Public, with the same allowed-origin check.

```json
{
  "projectId": "PROJECT_ID",
  "channel": "general",
  "deviceId": "DEVICE_ID"
}
```

### `POST /v1/send`

Project API key required:

`Authorization: Bearer PROJECT_API_KEY`

```json
{
  "projectId": "PROJECT_ID",
  "channel": "general",
  "title": "Hello",
  "body": "Your notification message",
  "url": "/"
}
```

Optional `deviceId` sends to one device. Otherwise, sends to every subscription in that project's channel.

### `GET /health`

Returns service status and version.

## Important limits and production notes

- **Not a way around browser permission.** Each visitor has to opt in.
- **Not literally API-less.** ping is the hosted API; the developer avoids hosting a notification backend.
- **Keep send keys private.** A browser-side key is public, regardless of obfuscation.
- **Origin checks are not user authentication.** They reduce cross-site subscription abuse but do not prove a visitor's identity.
- **Add account-level rate limits and billing controls before opening project creation to the public.** This repository is a self-hosted starter, not a multi-tenant commercial SaaS with abuse operations.
- KV is eventually consistent and has request/list limits. For high-volume workloads, use a database/queue architecture and batch delivery.
- Delivery is best-effort. A successful push-service response means accepted by the push service, not guaranteed displayed to the user.
- The dashboard is intended for the owner, not public customer self-service.
- The browser vendor's push service may have its own availability and policies.

## Local development

```bash
npm install
npx wrangler dev
```

Set local secrets in `.dev.vars` (do not commit it):

```dotenv
ADMIN_TOKEN=replace-me
VAPID_PRIVATE_KEY={"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}
VAPID_PUBLIC_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

## License

MIT. See [LICENSE](LICENSE).
