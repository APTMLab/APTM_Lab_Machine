// Measurement WorkFlow Remote Relay
//
// Deploy this file as a Cloudflare Worker and bind a KV namespace named MW_REMOTE_KV.
// Required environment variables:
// - REMOTE_LAB_ID: lab identifier used on the mobile site
// - REMOTE_PASSWORD_SHA256: lowercase SHA-256 hex of the mobile login password
// - DESKTOP_KEY: shared secret copied into the desktop app Cloud Relay settings
// - TOKEN_SECRET: long random string used to sign mobile login tokens

const COMMAND_TTL_SECONDS = 10 * 60;
const STATUS_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Desktop-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return json({ success: true, name: "Measurement WorkFlow Remote Relay" });
      }

      if (url.pathname === "/api/login" && request.method === "POST") {
        return login(request, env);
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        const auth = await requireMobileAuth(request, env);
        const status = await env.MW_REMOTE_KV.get(statusKey(auth.labId), "json");
        return json({ success: true, status: status ?? null });
      }

      if (url.pathname === "/api/command" && request.method === "POST") {
        const auth = await requireMobileAuth(request, env);
        const payload = await request.json();
        const type = String(payload.type ?? "").trim();
        if (!isSupportedCommand(type)) {
          return json({ success: false, message: "Unsupported command." }, 400);
        }

        const command = {
          id: crypto.randomUUID(),
          type,
          preset: payload.preset ?? null,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + COMMAND_TTL_SECONDS * 1000).toISOString()
        };

        await env.MW_REMOTE_KV.put(
          commandKey(auth.labId),
          JSON.stringify(command),
          { expirationTtl: COMMAND_TTL_SECONDS });

        return json({ success: true, commandId: command.id, message: "Command queued." });
      }

      if (url.pathname === "/api/desktop/poll" && request.method === "GET") {
        requireDesktopAuth(request, env);
        const labId = readLabId(url, env);
        const command = await env.MW_REMOTE_KV.get(commandKey(labId), "json");
        return json({ success: true, command: command ?? null });
      }

      if (url.pathname === "/api/desktop/status" && request.method === "POST") {
        requireDesktopAuth(request, env);
        const payload = await request.json();
        const labId = normalizeLabId(payload.labId, env);
        const status = {
          ...payload,
          updatedAt: new Date().toISOString()
        };
        await env.MW_REMOTE_KV.put(
          statusKey(labId),
          JSON.stringify(status),
          { expirationTtl: STATUS_TTL_SECONDS });
        return json({ success: true });
      }

      if (url.pathname === "/api/desktop/ack" && request.method === "POST") {
        requireDesktopAuth(request, env);
        const payload = await request.json();
        const labId = normalizeLabId(payload.labId, env);
        const command = await env.MW_REMOTE_KV.get(commandKey(labId), "json");
        if (command && String(command.id) === String(payload.commandId)) {
          await env.MW_REMOTE_KV.delete(commandKey(labId));
        }

        const status = {
          labId,
          appState: payload.appState ?? null,
          lastCommand: {
            id: payload.commandId ?? "",
            success: payload.success === true,
            message: payload.message ?? "",
            completedAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        };
        await env.MW_REMOTE_KV.put(
          statusKey(labId),
          JSON.stringify(status),
          { expirationTtl: STATUS_TTL_SECONDS });
        return json({ success: true });
      }

      return json({ success: false, message: "Not found." }, 404);
    } catch (error) {
      const status = error.status || 500;
      return json({ success: false, message: error.message || "Relay error." }, status);
    }
  }
};

async function login(request, env) {
  requireConfigured(env);
  const payload = await request.json();
  const labId = normalizeLabId(payload.labId, env);
  const passwordHash = await sha256Hex(String(payload.password ?? ""));
  if (passwordHash !== String(env.REMOTE_PASSWORD_SHA256 ?? "").toLowerCase()) {
    return json({ success: false, message: "Invalid login." }, 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = await signToken({ labId, exp: expiresAt }, env.TOKEN_SECRET);
  return json({
    success: true,
    token,
    labId,
    expiresAt,
    name: "Measurement WorkFlow Remote"
  });
}

function requireConfigured(env) {
  if (!env.MW_REMOTE_KV ||
      !env.REMOTE_LAB_ID ||
      !env.REMOTE_PASSWORD_SHA256 ||
      !env.DESKTOP_KEY ||
      !env.TOKEN_SECRET) {
    throw Object.assign(new Error("Relay is not fully configured."), { status: 500 });
  }
}

async function requireMobileAuth(request, env) {
  requireConfigured(env);
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = await verifyToken(token, env.TOKEN_SECRET);
  const labId = normalizeLabId(payload.labId, env);
  if (Number(payload.exp ?? 0) < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Login expired."), { status: 401 });
  }

  return { labId };
}

function requireDesktopAuth(request, env) {
  requireConfigured(env);
  if (request.headers.get("X-Desktop-Key") !== env.DESKTOP_KEY) {
    throw Object.assign(new Error("Invalid desktop key."), { status: 403 });
  }
}

function readLabId(url, env) {
  return normalizeLabId(url.searchParams.get("labId") || "", env);
}

function normalizeLabId(value, env) {
  const labId = String(value || "").trim();
  if (!labId || labId !== String(env.REMOTE_LAB_ID).trim()) {
    throw Object.assign(new Error("Invalid lab id."), { status: 403 });
  }

  return labId;
}

function isSupportedCommand(type) {
  return ["apply", "run", "stop", "pause", "reset", "outputs-off"].includes(type);
}

function commandKey(labId) {
  return `lab:${labId}:command`;
}

function statusKey(labId) {
  return `lab:${labId}:status`;
}

async function signToken(payload, secret) {
  const body = base64Url(JSON.stringify(payload));
  const signature = await hmac(body, secret);
  return `${body}.${signature}`;
}

async function verifyToken(token, secret) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) {
    throw Object.assign(new Error("Login required."), { status: 401 });
  }

  const expected = await hmac(body, secret);
  if (signature !== expected) {
    throw Object.assign(new Error("Invalid login token."), { status: 401 });
  }

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlBytes(new Uint8Array(signature));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(value) {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
