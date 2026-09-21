-- 0001_init.sql — initial RunnerBox schema (D1 / SQLite).
-- Timestamps are unix seconds. `runs` is the only state machine (plan §4).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT,
  github_access_token TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cli_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS installations (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT,
  user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  repo_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL DEFAULT 'main',
  installation_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'ok',
  pr_url TEXT,
  runnerbox_token_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_full_name TEXT NOT NULL,
  gh_run_id INTEGER UNIQUE,
  state TEXT NOT NULL DEFAULT 'dispatching',
  tunnel_url TEXT,
  daemon_token TEXT,
  active_devices INTEGER NOT NULL DEFAULT 0,
  android_ready INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  live_at INTEGER,
  ended_at INTEGER,
  expires_at INTEGER,
  end_reason TEXT
);

-- Hot paths: runner-token auth lookup, per-user run listing, CLI token lookup.
CREATE INDEX IF NOT EXISTS idx_repos_token_hash ON repos(runnerbox_token_hash);
CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_user ON cli_tokens(user_id);
