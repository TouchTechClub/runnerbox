import type { RepoState, RunState } from "@runnerbox/shared";

/** Row shapes mirror migrations/*.sql exactly (snake_case for app tables). */

/**
 * The authenticated caller, normalized off the better-auth session `user`
 * plus their linked GitHub `account` row. `user.id` is better-auth's TEXT id;
 * `repos.user_id` / `runs.user_id` / `installations.user_id` all point at it.
 */
export interface AuthUser {
  id: string;
  githubUserId: number | null;
  login: string;
  avatarUrl: string | null;
  /** OAuth access token from account.accessToken (providerId = 'github'). */
  githubAccessToken: string | null;
  /** better-auth user.createdAt, converted to epoch milliseconds. */
  createdAtMs: number;
}

/** better-auth `account` row (camelCase columns, see 0002_better_auth.sql). */
export interface GithubAccountRow {
  accountId: string;
  accessToken: string | null;
}

export interface InstallationRow {
  installation_id: number;
  account_login: string | null;
  user_id: string | null;
  created_at: number;
}

export interface RepoRow {
  user_id: string;
  repo_id: number;
  full_name: string;
  private: number;
  default_branch: string;
  installation_id: number;
  state: RepoState;
  pr_url: string | null;
  runnerbox_token_hash: string | null;
  created_at: number;
}

export interface RunRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  gh_run_id: number | null;
  state: RunState;
  tunnel_url: string | null;
  daemon_token: string | null;
  active_devices: number;
  android_ready: number;
  created_at: number;
  dispatched_at: number | null;
  live_at: number | null;
  ended_at: number | null;
  expires_at: number | null;
  end_reason: string | null;
}

export const TERMINAL_RUN_STATES: readonly RunState[] = ["ended", "failed"];
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  "dispatching",
  "queued",
  "booting",
  "live",
];

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/**
 * The GitHub OAuth account linked to a better-auth user. `accountId` is the
 * GitHub user id (TEXT); `accessToken` is the user OAuth token needed by
 * GET /user/installations (repo picker).
 */
export async function getGithubAccount(
  db: D1Database,
  userId: string,
): Promise<GithubAccountRow | null> {
  return db
    .prepare(
      `SELECT accountId, accessToken FROM account
       WHERE userId = ? AND providerId = 'github'
       ORDER BY createdAt DESC LIMIT 1`,
    )
    .bind(userId)
    .first<GithubAccountRow>();
}

export async function getRepoForUser(
  db: D1Database,
  userId: string,
): Promise<RepoRow | null> {
  return db
    .prepare("SELECT * FROM repos WHERE user_id = ?")
    .bind(userId)
    .first<RepoRow>();
}

export async function getLatestActiveRun(
  db: D1Database,
  userId: string,
): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT * FROM runs
       WHERE user_id = ? AND state NOT IN ('ended', 'failed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId)
    .first<RunRow>();
}

export async function getRepoByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<RepoRow | null> {
  return db
    .prepare("SELECT * FROM repos WHERE runnerbox_token_hash = ?")
    .bind(tokenHash)
    .first<RepoRow>();
}
