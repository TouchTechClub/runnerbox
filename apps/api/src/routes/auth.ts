import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type {
  DeviceFlowPollResponse,
  DeviceFlowStartResponse,
} from "@runnerbox/shared";
import type { AppContext } from "../middleware";
import type { RepoRow } from "../db";
import { getRepoForUser } from "../db";
import {
  apiError,
  newId,
  nowSeconds,
  randomTokenHex,
  sha256Hex,
  toPublicRepo,
  toPublicUser,
} from "../util";
import { gh } from "../github";
import { requireUser } from "../middleware";

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const DEVICE_CODE_TTL_SECONDS = 600;
const DEVICE_POLL_INTERVAL = 3;

export const authRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// Web OAuth (GitHub App "identify users" flow)
// ---------------------------------------------------------------------------

authRoutes.get("/auth/github", (c) => {
  const state = crypto.randomUUID();
  // Short-lived CSRF cookie; SameSite=Lax so it survives the GitHub redirect back.
  setCookie(c, "rb_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 600,
    path: "/",
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_OAUTH_CLIENT_ID);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

interface GithubUserResponse {
  id: number;
  login: string;
  avatar_url: string | null;
}

authRoutes.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieHeader = c.req.header("Cookie") ?? "";
  const stateCookie = /(?:^|;\s*)rb_oauth_state=([^;]+)/.exec(cookieHeader)?.[1];
  // CSRF: the state must match the cookie we set when starting the flow.
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return apiError(c, 400, "bad_oauth_state", "OAuth state mismatch — restart sign-in.");
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenBody.access_token) {
    return apiError(c, 400, "oauth_exchange_failed", `GitHub token exchange failed: ${tokenBody.error ?? "unknown"}`);
  }
  const accessToken = tokenBody.access_token;

  const ghUser = await gh<GithubUserResponse>(accessToken, "/user");

  const now = nowSeconds();
  const existing = await c.env.DB.prepare(
    "SELECT id FROM users WHERE github_user_id = ?",
  )
    .bind(ghUser.id)
    .first<{ id: string }>();
  const userId = existing?.id ?? newId();
  // github_access_token is stored because GET /user/installations (repo picker)
  // requires a user token, not an installation token.
  await c.env.DB.prepare(
    `INSERT INTO users (id, github_user_id, login, avatar_url, github_access_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_user_id) DO UPDATE SET
       login = excluded.login,
       avatar_url = excluded.avatar_url,
       github_access_token = excluded.github_access_token`,
  )
    .bind(userId, ghUser.id, ghUser.login, ghUser.avatar_url, accessToken, now)
    .run();

  const sessionId = crypto.randomUUID();
  await c.env.KV.put(`web_session:${sessionId}`, JSON.stringify({ userId }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  setCookie(c, "rb_session", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  deleteCookie(c, "rb_oauth_state", { path: "/" });
  return c.redirect(`${c.env.APP_URL}/onboarding`);
});

authRoutes.post("/auth/logout", async (c) => {
  const cookieHeader = c.req.header("Cookie") ?? "";
  const sessionId = /(?:^|;\s*)rb_session=([^;]+)/.exec(cookieHeader)?.[1];
  if (sessionId) await c.env.KV.delete(`web_session:${sessionId}`);
  deleteCookie(c, "rb_session", { path: "/" });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CLI device flow
// ---------------------------------------------------------------------------

interface DeviceCodeState {
  userCode: string;
  status: "pending" | "approved";
  userId?: string;
}

function humanCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

authRoutes.post("/v1/cli/device", async (c) => {
  const code = crypto.randomUUID(); // secret, URL-safe
  const userCode = humanCode();
  const state: DeviceCodeState = { userCode, status: "pending" };
  await c.env.KV.put(`device_code:${code}`, JSON.stringify(state), {
    expirationTtl: DEVICE_CODE_TTL_SECONDS,
  });
  await c.env.KV.put(`device_uc:${userCode}`, code, {
    expirationTtl: DEVICE_CODE_TTL_SECONDS,
  });
  const body: DeviceFlowStartResponse = {
    code,
    userCode,
    verifyUrl: `${c.env.APP_URL}/device?code=${encodeURIComponent(userCode)}`,
    expiresIn: DEVICE_CODE_TTL_SECONDS,
    pollInterval: DEVICE_POLL_INTERVAL,
  };
  return c.json(body);
});

authRoutes.get("/v1/cli/device/:code", async (c) => {
  const code = c.req.param("code");
  const key = `device_code:${code}`;
  const raw = await c.env.KV.get(key, "json");
  if (!raw || typeof raw !== "object") {
    const body: DeviceFlowPollResponse = { status: "expired" };
    return c.json(body);
  }
  const state = raw as DeviceCodeState;
  if (state.status !== "approved" || !state.userId) {
    const body: DeviceFlowPollResponse = { status: "pending" };
    return c.json(body);
  }

  // Approved — mint a CLI token, store only its hash, consume the code.
  const token = randomTokenHex();
  await c.env.DB.prepare(
    "INSERT INTO cli_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)",
  )
    .bind(await sha256Hex(token), state.userId, nowSeconds())
    .run();
  await c.env.KV.delete(key);
  if (state.userCode) await c.env.KV.delete(`device_uc:${state.userCode}`);
  const body: DeviceFlowPollResponse = { status: "approved", token };
  return c.json(body);
});

// Approves a pending device code (dashboard /device page). requireUser accepts
// either the rb_session cookie or a CLI bearer token.
authRoutes.post("/v1/cli/approve", requireUser, async (c) => {
  const body = await c.req.json<{ userCode?: string }>().catch(() => ({}) as { userCode?: string });
  const userCode = body.userCode?.trim().toUpperCase();
  if (!userCode) {
    return apiError(c, 400, "missing_user_code", "userCode is required.");
  }
  const code = await c.env.KV.get(`device_uc:${userCode}`);
  if (!code) {
    return apiError(c, 404, "unknown_code", "Device code not found or expired.");
  }
  const key = `device_code:${code}`;
  const raw = await c.env.KV.get(key, "json");
  if (!raw || typeof raw !== "object") {
    return apiError(c, 404, "unknown_code", "Device code not found or expired.");
  }
  const state = raw as DeviceCodeState;
  if (state.status !== "pending") {
    return apiError(c, 409, "already_approved", "This code was already approved.");
  }
  const updated: DeviceCodeState = {
    userCode,
    status: "approved",
    userId: c.get("user").id,
  };
  await c.env.KV.put(key, JSON.stringify(updated), {
    expirationTtl: DEVICE_CODE_TTL_SECONDS,
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

authRoutes.get("/v1/me", requireUser, async (c: Context<AppContext>) => {
  const user = c.get("user");
  const repo: RepoRow | null = await getRepoForUser(c.env.DB, user.id);
  return c.json({ user: toPublicUser(user), repo: repo ? toPublicRepo(repo) : null });
});
