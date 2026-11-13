import { buildPushHTTPRequest } from "@pushforge/builder";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "86400",
  "cache-control": "no-store"
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });

const fail = (message, status = 400) => json({ ok: false, error: message }, status);

function validId(value) {
  return typeof value === "string" && /^[a-z0-9_-]{6,40}$/i.test(value);
}

function validChannel(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value);
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function readJson(request, maxBytes = 12000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > maxBytes) throw new Error("Request body too large");
  return JSON.parse(raw);
}

function allowedOrigin(request, project) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return project.origins.includes(origin);
}

async function getProject(env, projectId) {
  const raw = await env.DB.get(`project:${projectId}`);
  return raw ? JSON.parse(raw) : null;
}

async function authorizeProject(request, env, projectId) {
  const project = await getProject(env, projectId);
  if (!project) return null;
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const suppliedHash = await sha256(match[1]);
  return safeEqual(suppliedHash, project.keyHash) ? project : null;
}

function validPushSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return false;
  if (typeof subscription.endpoint !== "string") return false;
  if (subscription.endpoint.length > 2048) return false;
  try {
    const url = new URL(subscription.endpoint);
    const host = url.hostname.toLowerCase();
    const permitted =
      host === "fcm.googleapis.com" ||
      host.endsWith(".push.apple.com") ||
      host === "push.apple.com" ||
      host === "updates.push.services.mozilla.com" ||
      host.endsWith(".notify.windows.com");
    return url.protocol === "https:" && permitted &&
      typeof subscription.keys?.p256dh === "string" &&
      typeof subscription.keys?.auth === "string";
  } catch {
    return false;
  }
}

async function requireAdmin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !env.ADMIN_TOKEN) return false;
  const a = await sha256(match[1]);
  const b = await sha256(env.ADMIN_TOKEN);
  return safeEqual(a, b);
}

async function listProjects(env) {
  const result = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "project:", cursor, limit: 1000 });
    for (const key of page.keys) {
      const raw = await env.DB.get(key.name);
      if (!raw) continue;
      const p = JSON.parse(raw);
      result.push({
        id: p.id,
        name: p.name,
        origins: p.origins,
        createdAt: p.createdAt
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

  if (path === "/health" && request.method === "GET") {
    return json({ ok: true, service: "ping", status: "online", version: "1.0.0" });
  }

  if (path === "/v1/public-key" && request.method === "GET") {
    if (!env.VAPID_PUBLIC_KEY) return fail("Push is not configured yet", 503);
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (path.startsWith("/v1/admin/")) {
    if (!(await requireAdmin(request, env))) return fail("Unauthorized", 401);

    if (path === "/v1/admin/projects" && request.method === "GET") {
      return json({ projects: await listProjects(env) });
    }

    if (path === "/v1/admin/projects" && request.method === "POST") {
      let data;
      try { data = await readJson(request); } catch (e) { return fail(e.message); }

      const name = typeof data.name === "string" ? data.name.trim().slice(0, 60) : "";
      const origins = Array.isArray(data.origins) ? [...new Set(data.origins)] : [];
      if (!name) return fail("Project name is required");
      if (!origins.length || origins.length > 20) return fail("Add between 1 and 20 allowed website origins");
      for (const origin of origins) {
        try {
          const parsed = new URL(origin);
          if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== origin || (parsed.protocol === "http:" && parsed.hostname !== "localhost")) {
            return fail(`Invalid origin: ${origin}`);
          }
        } catch {
          return fail(`Invalid origin: ${origin}`);
        }
      }

      const id = randomToken(9);
      const apiKey = `ping_${randomToken(32)}`;
      const project = {
        id, name, origins,
        keyHash: await sha256(apiKey),
        createdAt: new Date().toISOString()
      };
      await env.DB.put(`project:${id}`, JSON.stringify(project));
      return json({
        ok: true,
        project: { id, name, origins, createdAt: project.createdAt },
        apiKey,
        warning: "Copy this API key now. It is only shown once."
      }, 201);
    }

    return fail("Admin endpoint not found", 404);
  }

  if (path === "/v1/subscribe" && request.method === "POST") {
    let data;
    try { data = await readJson(request); } catch (e) { return fail(e.message); }

    if (!validId(data.projectId) || !validChannel(data.channel)) return fail("Invalid projectId or channel");
    const project = await getProject(env, data.projectId);
    if (!project) return fail("Unknown project", 404);
    if (!allowedOrigin(request, project)) return fail("This website origin is not allowed for this project", 403);
    if (!validPushSubscription(data.subscription)) return fail("Invalid or unsupported push subscription");

    const deviceId = randomToken(16);
    const key = `sub:${project.id}:${data.channel}:${deviceId}`;
    await env.DB.put(key, JSON.stringify({
      subscription: data.subscription,
      createdAt: new Date().toISOString()
    }));
    return json({ ok: true, deviceId, projectId: project.id, channel: data.channel }, 201);
  }

  if (path === "/v1/unsubscribe" && request.method === "POST") {
    let data;
    try { data = await readJson(request); } catch (e) { return fail(e.message); }
    if (!validId(data.projectId) || !validChannel(data.channel) || !/^[a-f0-9]{32}$/i.test(data.deviceId || "")) {
      return fail("Invalid unsubscribe details");
    }
    const project = await getProject(env, data.projectId);
    if (!project) return fail("Unknown project", 404);
    if (!allowedOrigin(request, project)) return fail("Origin not allowed", 403);
    await env.DB.delete(`sub:${project.id}:${data.channel}:${data.deviceId}`);
    return json({ ok: true });
  }

  if (path === "/v1/send" && request.method === "POST") {
    let data;
    try { data = await readJson(request, 10000); } catch (e) { return fail(e.message); }

    if (!validId(data.projectId) || !validChannel(data.channel)) return fail("Invalid projectId or channel");
    const project = await authorizeProject(request, env, data.projectId);
    if (!project) return fail("Invalid project API key", 401);

    const title = typeof data.title === "string" ? data.title.trim() : "";
    const body = typeof data.body === "string" ? data.body.trim() : "";
    if (!title || title.length > 100 || !body || body.length > 1200) {
      return fail("title (1–100 chars) and body (1–1200 chars) are required");
    }
    if (!env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return fail("Push sender is not configured", 503);

    const clickUrl = typeof data.url === "string" ? data.url : "/";
    if (!clickUrl.startsWith("/") || clickUrl.startsWith("//")) return fail("url must be a same-origin path beginning with /");

    const prefix = `sub:${project.id}:${data.channel}:`;
    const subscriptions = [];
    if (data.deviceId) {
      if (!/^[a-f0-9]{32}$/i.test(data.deviceId)) return fail("Invalid deviceId");
      const key = prefix + data.deviceId;
      const raw = await env.DB.get(key);
      if (raw) subscriptions.push({ key, ...JSON.parse(raw) });
    } else {
      let cursor;
      do {
        const page = await env.DB.list({ prefix, cursor, limit: 1000 });
        for (const item of page.keys) {
          const raw = await env.DB.get(item.name);
          if (raw) subscriptions.push({ key: item.name, ...JSON.parse(raw) });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }

    if (!subscriptions.length) return json({ ok: false, error: "No subscribed devices found", sent: 0, failed: 0 }, 404);

    let sent = 0;
    let failed = 0;
    const details = [];

    for (const item of subscriptions) {
      try {
        const built = await buildPushHTTPRequest({
          privateJWK: JSON.parse(env.VAPID_PRIVATE_KEY),
          subscription: item.subscription,
          message: {
            payload: {
              title,
              body,
              url: clickUrl,
              tag: typeof data.tag === "string" ? data.tag.slice(0, 80) : undefined
            },
            adminContact: env.VAPID_SUBJECT,
            options: { ttl: 86400, urgency: "normal" }
          }
        });
        const pushResponse = await fetch(built.endpoint, {
          method: "POST",
          headers: built.headers,
          body: built.body
        });

        if (pushResponse.ok || pushResponse.status === 201 || pushResponse.status === 202) {
          sent++;
        } else {
          failed++;
          details.push({ deviceId: item.key.split(":").at(-1), status: pushResponse.status });
          if (pushResponse.status === 404 || pushResponse.status === 410) {
            await env.DB.delete(item.key);
          }
        }
      } catch {
        failed++;
        details.push({ deviceId: item.key.split(":").at(-1), error: "delivery_error" });
      }
    }

    return json({ ok: failed === 0, sent, failed, total: subscriptions.length, details });
  }

  if (path === "/" || path === "/index.html") {
    return env.ASSETS.fetch(request);
  }

  return fail("Route not found", 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      return json({ ok: false, error: "Internal server error" }, 500);
    }
  }
};
