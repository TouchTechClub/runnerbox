import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";
import type { RepoRow, UserRow } from "./db";
import { getRepoByTokenHash } from "./db";
import { apiError, sha256Hex } from "./util";

export interface AppVariables {
  user: UserRow;
  repo: RepoRow;
}

export type AppContext = { Bindings: Env; Variables: AppVariables };

/**
 * Authenticates either a CLI bearer token (sha256 lookup in cli_tokens) or the
 * web `rb_session` cookie (KV web_session:{id} → user_id).
 */
export const requireUser = createMiddleware<AppContext>(async (c, next) => {
  const auth = c.req.header("Authorization");
  let userId: string | null = null;

  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) {
      const hash = await sha256Hex(token);
      const row = await c.env.DB.prepare(
        "SELECT user_id FROM cli_tokens WHERE token_hash = ?",
      )
        .bind(hash)
        .first<{ user_id: string }>();
      if (row) {
        userId = row.user_id;
        // touch last_used_at without blocking the response
        c.executionCtx.waitUntil(
          c.env.DB.prepare(
            "UPDATE cli_tokens SET last_used_at = ? WHERE token_hash = ?",
          )
            .bind(Math.floor(Date.now() / 1000), hash)
            .run(),
        );
      }
    }
  }

  if (!userId) {
    const sessionId = getCookie(c)["rb_session"];
    if (sessionId) {
      const session = await c.env.KV.get(`web_session:${sessionId}`, "json");
      if (session && typeof session === "object") {
        const s = session as { userId?: string };
        if (typeof s.userId === "string") userId = s.userId;
      }
    }
  }

  if (!userId) {
    return apiError(c, 401, "unauthorized", "Sign in via the web app or `runnerbox login`.");
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) {
    return apiError(c, 401, "unauthorized", "User no longer exists.");
  }
  c.set("user", user);
  await next();
});

/**
 * Authenticates the in-runner agent: Bearer RUNNERBOX_TOKEN → sha256 →
 * repos.runnerbox_token_hash. On success `repo` is set on the context.
 */
export const requireRunnerToken = createMiddleware<AppContext>(async (c, next) => {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return apiError(c, 401, "unauthorized", "Missing RUNNERBOX_TOKEN bearer.");
  }
  const repo = await getRepoByTokenHash(c.env.DB, await sha256Hex(token));
  if (!repo) {
    // Unknown token — never reveal whether a repo exists for it.
    return apiError(c, 403, "forbidden", "Invalid runner token.");
  }
  c.set("repo", repo);
  await next();
});
