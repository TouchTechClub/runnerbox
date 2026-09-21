import type { RepoState, RunState } from "@runnerbox/shared";

/** Row shapes mirror migrations/0001_init.sql exactly (snake_case columns). */

export interface UserRow {
  id: string;
  github_user_id: number;
  login: string;
  avatar_url: string | null;
  github_access_token: string | null;
  created_at: number;
}

export interface CliTokenRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  last_used_at: number | null;
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
