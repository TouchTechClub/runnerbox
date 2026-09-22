import { createMiddleware } from "hono/factory";
import { createDb } from "@runnerbox/db";
import type { Env } from "./env";
import type { AuthUser, RepoRow } from "./db";
import { getGithubAccount, getRepoByTokenHash } from "./db";
import { apiError, sha256Hex } from "./util";
import { createAuth } from "./auth";

export interface AppVariables {
  user: AuthUser;
  repo: RepoRow;
}

export type AppContext = { Bindings: Env; Variables: AppVariables };

/**
 * Authenticates the human user via better-auth: either the web session cookie
 * or `Authorization: Bearer <access_token>` issued by the device flow (the
 * bearer plugin rewrites it into the session cookie for getSession).
 *
 * Sets `user` as a normalized AuthUser — better-auth user.id plus the linked
 * GitHub account's id/token (account row, providerId = 'github').
 */
export const requireUser = createMiddleware<AppContext>(async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session) {
    return apiError(c, 401, "unauthorized", "Sign in via the web app or `runnerbox login`.");
  }

  const account = await getGithubAccount(createDb(c.env), session.user.id);
  const u = session.user as typeof session.user & { login?: string };
  const user: AuthUser = {
    id: session.user.id,
    githubUserId: account ? Number(account.accountId) : null,
    login: u.login ?? u.name,
    avatarUrl: session.user.image ?? null,
    githubAccessToken: account?.accessToken ?? null,
    createdAtMs: new Date(session.user.createdAt).getTime(),
  };
  c.set("user", user);
  await next();
});

/**
 * Authenticates the in-runner agent: Bearer RUNNERBOX_TOKEN → sha256 →
 * repos.runnerbox_token_hash. On success `repo` is set on the context.
 * (Runner tokens are not user auth — unchanged from hand-rolled auth.)
 */
export const requireRunnerToken = createMiddleware<AppContext>(async (c, next) => {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return apiError(c, 401, "unauthorized", "Missing RUNNERBOX_TOKEN bearer.");
  }
  const repo = await getRepoByTokenHash(createDb(c.env), await sha256Hex(token));
  if (!repo) {
    // Unknown token — never reveal whether a repo exists for it.
    return apiError(c, 403, "forbidden", "Invalid runner token.");
  }
  c.set("repo", repo);
  await next();
});
