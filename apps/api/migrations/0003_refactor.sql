-- 0003_refactor.sql — retire hand-rolled auth tables and repoint app tables at
-- better-auth's "user" table.
--
--   users      → dropped; better-auth "user" (TEXT id) is the identity table.
--                GitHub-specific data (github user id, login, OAuth token)
--                lives on "user"."login" + "account" (providerId='github'),
--                so no user_profiles table is needed.
--   cli_tokens → dropped; CLI auth is a better-auth session token issued by
--                /api/auth/device/token and consumed via the bearer plugin.
--   installations / repos / runs — rebuilt because SQLite can't ALTER a
--                foreign key; user_id now references "user"(id).
--
-- Old user ids never match better-auth ids, so the INSERT…SELECTs only carry
-- over rows whose user_id exists in "user" (normally zero rows — this lands
-- with the auth cutover). D1 enforces foreign keys, so children are rebuilt
-- BEFORE "users" is dropped.

CREATE TABLE installations_new (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT,
  user_id TEXT REFERENCES "user"(id),
  created_at INTEGER NOT NULL
);
INSERT INTO installations_new (installation_id, account_login, user_id, created_at)
  SELECT installation_id, account_login, user_id, created_at
  FROM installations
  WHERE user_id IS NULL OR user_id IN (SELECT id FROM "user");
DROP TABLE installations;
ALTER TABLE installations_new RENAME TO installations;

CREATE TABLE repos_new (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id),
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
INSERT INTO repos_new
  SELECT r.user_id, r.repo_id, r.full_name, r.private, r.default_branch,
         r.installation_id, r.state, r.pr_url, r.runnerbox_token_hash, r.created_at
  FROM repos r
  WHERE r.user_id IN (SELECT id FROM "user");
DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;
CREATE INDEX IF NOT EXISTS idx_repos_token_hash ON repos(runnerbox_token_hash);

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id),
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
INSERT INTO runs_new
  SELECT r.id, r.user_id, r.repo_full_name, r.gh_run_id, r.state, r.tunnel_url,
         r.daemon_token, r.active_devices, r.android_ready, r.created_at,
         r.dispatched_at, r.live_at, r.ended_at, r.expires_at, r.end_reason
  FROM runs r
  WHERE r.user_id IN (SELECT id FROM "user");
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs(user_id, created_at DESC);

DROP TABLE cli_tokens;
DROP TABLE users;
