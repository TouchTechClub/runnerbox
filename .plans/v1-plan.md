# RunnerBox — v1 Build Plan

**One-liner:** Free on-demand iOS simulators & Android emulators running on the user's own GitHub Actions minutes, exposed to their local machine as an `agent-device` remote proxy.

**Product shape:** A `macos-latest` GitHub Actions job in the _user's_ repo boots `agent-device proxy` + a Cloudflare quick tunnel. The tunnel URL and daemon token are registered to our backend (secret-authenticated, never in logs) and handed to the user's CLI. The user connects with `agent-device connect proxy` and drives sims/emulators until the job times out (~6h).

```
┌──────────────┐   HTTPS    ┌───────────────────┐   REST (installation token)  ┌──────────────┐
│ CLI (npm)    │───────────▶│ API (CF Worker)   │─────────────────────────────▶│ GitHub       │
│ `runnerbox`  │            │ Hono · D1 · KV    │   commit, secrets, dispatch  │ App          │
└──────────────┘            └─────────┬─────────┘                              └──────┬───────┘
      │                               ▲                                               │ workflow_dispatch
      │                               │ register + heartbeat (Bearer RUNNERBOX_TOKEN) ▼
      │ agent-device proxy            │                                    ┌──────────────────────────┐
      │ over *.trycloudflare.com      │                                    │ GH run · macos-latest    │
      │ (Bearer daemon token)         └────────────────────────────────────│ user repo · our workflow │
      └───────────────────────────────────────────────────────────────────▶│ composite action         │
                                                                           │  └ runnerbox-agent (bun) │
                                                                           │     ├ agent-device proxy │
                                                                           │     └ cloudflared        │
                                                                           └──────────────────────────┘
```

---

## 1. Key design decisions (locked)

| #   | Decision          | Resolution                                                                                                                                |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device surface    | `agent-device proxy` over Cloudflare quick tunnel — no custom viewer, no streaming server                                                 |
| 2   | Platforms         | iOS sim + Android emulator, both on `macos-latest`. Devices multiplex into the same run; `--new` CLI flag forces a fresh run              |
| 3   | Repo access       | GitHub App (`contents:write`, `secrets:write`, `actions:write`, `metadata:read`) — no broad OAuth token                                   |
| 4   | Secrets           | One long-lived repo secret `RUNNERBOX_TOKEN`; per-run daemon token minted in-runner, sent over TLS, never logged                          |
| 5   | Repo visibility   | Public + private both allowed; dashboard warns about 10× macOS minute multiplier on private repos                                         |
| 6   | Stack             | Monorepo: API = CF Workers + D1 + KV · CLI = TS on npm · Web = TanStack · agent-runner = Bun-compiled binary                              |
| 7   | CLI auth          | Device flow against our backend → same GitHub identity as web                                                                             |
| 8   | Runner delivery   | Composite action `runnerbox/runner@v1` → downloads pinned release tarball (binary + cloudflared). Graduate to real published action later |
| 9   | Abuse             | No rate limits on our side (compute is the user's own GH quota). 1 GitHub account + 1 repo per user                                       |
| 10  | Tamper check      | Skipped. Run correlation by `GITHUB_RUN_ID` already prevents foreign runs from reaching a user                                            |
| 11  | Session model     | Run-centric. No sessions table — a "session" is just connect info to a live run. `runs` is the only state machine                         |
| 12  | Run status        | `workflow_run` webhooks primary + lazy poll fallback                                                                                      |
| 13  | Workflow delivery | Direct commit to default branch; PR fallback on protected branches                                                                        |
| 14  | Leases            | Native agent-device semantics (5-min inactivity lease expiry; re-`open` is cheap)                                                         |
| 15  | Lifecycle         | 15-min idle exit · 5h45m hard exit (clean cleanup before GH's 6h kill) · `runnerbox stop` → GH cancel API                                 |
| 16  | Repo switching    | Allowed; clean uninstall from old repo (delete file + secret, cancel runs)                                                                |
| 17  | Onboarding        | Web-first (App install requires browser anyway); `runnerbox init` deep-links to dashboard                                                 |
| 18  | Repair            | `runnerbox repair` + dashboard button: re-commit canonical workflow, rotate secret, verify installation                                   |
| 19  | Devices/run       | Soft cap 3 (advisory via heartbeat-reported count)                                                                                        |
| 20  | Correlation       | Backend dispatches → polls `listWorkflowRuns` → binds `run_id` to pending run row; agent registers with `GITHUB_RUN_ID` + token           |

---

## 2. Monorepo layout

```
runnerbox/
├── apps/
│   ├── api/          # Cloudflare Worker (Hono), wrangler.toml, D1 + KV bindings
│   ├── cli/          # `runnerbox` npm package (TS, bun build → dist)
│   └── web/          # TanStack (Start or Router+Query), deployed to CF Pages
├── packages/
│   ├── agent/        # runnerbox-agent — Bun-compiled single binary (darwin-arm64)
│   └── shared/       # API contracts, types, constants (workflow YAML template, secret name)
├── action-src/       # source of the composite action (published to runnerbox/runner repo)
└── PLAN.md
```

The composite action must live in a **dedicated repo** (`runnerbox/runner`) so `uses: runnerbox/runner@v1` works with clean tag versioning. `action-src/` is synced/published there.

---

## 3. GitHub App

One GitHub App does both identity and repo ops.

- **Permissions:** `contents:write`, `secrets:write`, `actions:write`, `metadata:read`
- **Events:** `installation`, `installation_repositories`, `workflow_run`
- **User auth:** App's OAuth flow ("identify users") for web login — no extra OAuth app needed
- **Setup URL** redirects into `/onboarding`; `installation` webhook records `installation_id` + repo list

All repo operations use short-lived **installation tokens** (minted per-request via App JWT → `POST /app/installations/{id}/access_tokens`). Cached in KV until expiry.

---

## 4. Data model (D1)

Auth tables are owned by **better-auth** (`user`, `session`, `account`, `verification`, `deviceCode` — migration `0002`). Our app tables reference `user.id` (TEXT):

```sql
installations (
  installation_id INTEGER PK, account_login TEXT, user_id TEXT FK,
  created_at INTEGER
)

repos (
  user_id TEXT PK,                    -- 1 repo per user
  repo_id INTEGER, full_name TEXT, private INTEGER,
  default_branch TEXT, installation_id INTEGER,
  state TEXT,                         -- ok | needs_repair | uninstalled | pending_pr
  pr_url TEXT,                        -- set when protected-branch PR fallback used
  created_at INTEGER
)

runs (
  id TEXT PK, user_id TEXT FK, repo_full_name TEXT,
  gh_run_id INTEGER UNIQUE,           -- NULL until listWorkflowRuns resolves it
  state TEXT,                         -- dispatching | queued | booting | live | closing | ended | failed
  tunnel_url TEXT, daemon_token TEXT, -- populated at registration
  active_devices INTEGER DEFAULT 0,
  created_at INTEGER, dispatched_at INTEGER, live_at INTEGER, ended_at INTEGER,
  end_reason TEXT
)
```

**KV** (ephemeral, TTL-native) — sessions & device codes live in better-auth's D1 tables, so KV is just:

- `gh_inst_token:{installation_id}` → cached installation token
- `ensure_lock:{user_id}` → idempotency for concurrent `runs/ensure`
- `gh_check:{run_id}` → throttle for lazy GH status polling

---

## 5. API surface (Worker, Hono)

### Auth — **better-auth** (mounted at `/api/auth/*`)

Plugins: `deviceAuthorization` (RFC 8628, client_id `runnerbox-cli`, verificationUri → `${APP_URL}/device`) + `bearer` (CLI sends session token as Bearer). GitHub social provider stores `accessToken` + `accountId` in the `account` table — used for `/v1/installations`.

| Method | Path                                      | Notes                                                                                                           |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/auth/sign-in/social`                | `{provider:"github", callbackURL}` → `{url}` (web)                                                              |
| GET    | `/api/auth/get-session`                   | cookie session check                                                                                            |
| POST   | `/api/auth/device/code`                   | CLI: `{client_id}` → `{device_code, user_code, verification_uri_complete, interval}`                            |
| POST   | `/api/auth/device/token`                  | CLI polls (JSON body) → `{access_token}` or `authorization_pending`/`slow_down`/`access_denied`/`expired_token` |
| GET    | `/api/auth/device?user_code=`             | web: claims the code for the session                                                                            |
| POST   | `/api/auth/device/approve` `/device/deny` | web: `{userCode}` (cookie session)                                                                              |
| GET    | `/v1/me`                                  | `{user: {id, githubUserId, login, avatarUrl}, repo}`                                                            |

### Webhooks

| Method | Path               | Notes                                                                                                                                                                           |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/webhooks/github` | Verify `X-Hub-Signature-256`. Handle `installation` (created/deleted/suspend), `installation_repositories`, `workflow_run` (queued/in_progress/completed → update `runs.state`) |

### Repo

| Method | Path                  | Notes                                                                            |
| ------ | --------------------- | -------------------------------------------------------------------------------- |
| GET    | `/v1/installations`   | Repos reachable via user's installations (for picker)                            |
| POST   | `/v1/repo/connect`    | `{repo_id}` → commit workflow + write secret (PR fallback → `pending_pr`)        |
| GET    | `/v1/repo/status`     | State incl. private-repo cost warning flag                                       |
| POST   | `/v1/repo/repair`     | Re-commit canonical workflow + rotate `RUNNERBOX_TOKEN` + re-verify installation |
| POST   | `/v1/repo/disconnect` | Delete workflow file + secret, cancel live run, free the slot                    |

### Runs

| Method | Path                  | Auth                     | Notes                                                                                               |
| ------ | --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| POST   | `/v1/runs/ensure`     | user                     | `{new?: bool}` → `live` connect info \| `dispatching`/`booting` state. Dedupes via `ensure_lock`    |
| GET    | `/v1/runs/current`    | user                     | Live/dispatching run + `active_devices` + `expires_at`                                              |
| POST   | `/v1/runs/:id/stop`   | user                     | `POST /repos/{}/actions/runs/{}/cancel` via installation token                                      |
| POST   | `/v1/runs/register`   | `Bearer RUNNERBOX_TOKEN` | `{gh_run_id, tunnel_url, daemon_token, versions}` — validates run_id ∈ dispatched set for this repo |
| POST   | `/v1/runs/heartbeat`  | `Bearer RUNNERBOX_TOKEN` | `{gh_run_id, active_devices, android_ready}` every 60s; missing heartbeats >3min → reap             |
| POST   | `/v1/runs/deregister` | `Bearer RUNNERBOX_TOKEN` | Clean shutdown path                                                                                 |

**`ensure` logic:**

1. Live run & `!new` → return `{state: "live", tunnel_url, daemon_token, expires_at}` (reject if `active_devices >= 3` → tell CLI to suggest `--new`)
2. Run in `dispatching|queued|booting` & `!new` → return `{state}`
3. Else → `POST .../workflows/runnerbox.yml/dispatches` (ref = default branch) → poll `listWorkflowRuns?event=workflow_dispatch&created>=t` → bind `gh_run_id` → row `dispatching`

---

## 6. The committed workflow file

`.github/workflows/runnerbox.yml` in the user's repo:

```yaml
name: runnerbox
on:
  workflow_dispatch:

jobs:
  runnerbox:
    runs-on: macos-latest
    timeout-minutes: 350
    steps:
      - name: RunnerBox agent
        uses: runnerbox/runner@v1
        with:
          token: ${{ secrets.RUNNERBOX_TOKEN }}
          # api_url defaults to production; override for staging
```

- `workflow_dispatch` only fires when the file is on the **default branch** — hence direct-commit-first onboarding.
- `timeout-minutes: 350` belt-and-braces under the 360 platform limit.
- `secrets.RUNNERBOX_TOKEN` is auto-masked in logs; the tunnel URL and daemon token never appear in the workflow at all.

### Composite action (`runnerbox/runner` repo, `action.yml`)

```yaml
name: runnerbox
inputs:
  token: { required: true }
  api_url: { default: "https://api.runnerbox.dev" }
  version: { default: "v1" }
runs:
  using: composite
  steps:
    - shell: bash
      env:
        RUNNERBOX_TOKEN: ${{ inputs.token }}
        RUNNERBOX_API_URL: ${{ inputs.api_url }}
      run: |
        curl -fsSL https://github.com/runnerbox/runnerbox/releases/download/${{ inputs.version }}/runnerbox-agent-darwin-arm64.tar.gz -o agent.tgz
        echo "<pinned-sha256>  agent.tgz" | shasum -a 256 -c -
        tar xzf agent.tgz && ./runnerbox-agent
```

Tarball is sha256-verified — supply-chain hygiene for code executing in users' repos.

---

## 7. runnerbox-agent (Bun binary)

Single `bun build --compile` binary, darwin-arm64 (`macos-latest` = Apple Silicon).

Boot sequence:

1. Read env: `RUNNERBOX_TOKEN`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `RUNNERBOX_API_URL`. Missing token → exit 1 with `::error::` annotation.
2. Provision (parallel where possible):
   - `npm i -g agent-device@<pinned>` (Node exists in toolcache)
   - Download pinned `cloudflared` darwin binary
   - **Background:** Android prep — locate SDK, accept licenses, download pinned system image, `avdmanager create avd` → report `android_ready` in heartbeats once done (~2–3 min, lazy enough to never block iOS)
3. Generate `daemon_token` (32 random bytes hex).
4. Spawn `agent-device proxy --port 4310 --host 127.0.0.1 --daemon-auth-token <daemon_token>`.
5. Spawn `cloudflared tunnel --url http://127.0.0.1:4310 --no-autoupdate`; parse `*.trycloudflare.com` URL from stderr.
6. `POST /v1/runs/register` `{gh_run_id, tunnel_url, daemon_token, versions}` with `Authorization: Bearer $RUNNERBOX_TOKEN`. Non-2xx → exit 1 (fails the job visibly).
7. Supervision loop every 60s:
   - `POST /v1/runs/heartbeat` `{gh_run_id, active_devices, android_ready}` (`active_devices` from `agent-device device status` / proxy health)
   - **Idle exit:** 15 min with `active_devices == 0` → graceful shutdown
   - **Hard exit:** at job-start +5h45m → graceful shutdown (deregister, kill children, exit 0 → green checkmark)
   - Child process died → attempt one restart; second failure → exit 1
   - Log lines prefixed `::add-mask::` for the daemon token & tunnel URL as extra insurance (they're never printed anyway)

---

## 8. CLI (`runnerbox` on npm)

```bash
runnerbox login     # POST /v1/cli/device → open verify_url → poll → save ~/.config/runnerbox/auth.json
runnerbox init      # opens dashboard onboarding (app install + repo pick); waits until repo connected
runnerbox sim       # ensure → spinner through states → connect (see below)
                    #   --new    force a fresh run even if one is live
                    #   --json   print {tunnel_url, daemon_token, run_id, expires_at} for agent/CI consumers
runnerbox ps        # current run: state, devices, time remaining
runnerbox stop      # cancel the active run
runnerbox repair    # repo repair endpoint
runnerbox logout
```

**Connect UX on `sim` (decided: auto-connect with printed fallback):**

- If `agent-device` binary found locally: run `agent-device connect proxy --daemon-base-url <tunnel>/agent-device`, then write `daemonAuthToken` into the remote config profile so every subsequent `agent-device` command is authenticated without env vars.
- Always print the manual equivalent as fallback:

```bash
export AGENT_DEVICE_DAEMON_AUTH_TOKEN=<token>
agent-device connect proxy --daemon-base-url https://xxx.trycloudflare.com/agent-device
agent-device open <app> --platform ios      # or --platform android
```

- Also print `eval "$(runnerbox sim --shell)"` style hint? — keep `--json` only for v1; `--shell` is a v1.1 nicety.

**State display during `sim`:** `dispatching → queued → booting → live` with elapsed time; typical cold start target <4 min (runner pickup ~30–60s, provision ~60–90s, tunnel ~10s). Timeout with helpful error at 8 min.

---

## 9. Web app (TanStack, CF Pages)

Dashboard only — no device viewer in v1.

| Route         | Purpose                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | Landing + "Sign in with GitHub"                                                                                                                                                     |
| `/onboarding` | Install App → pick repo → progress: `committing workflow → setting secret → done` → shows `npx runnerbox login && runnerbox sim`                                                    |
| `/device`     | Approve CLI device code (`runnerbox login` flow)                                                                                                                                    |
| `/dashboard`  | Repo card (full_name, private ⚠️ cost warning, state, repair/disconnect) · Live run card (state, uptime, devices, expires_at, copy-connect-command with token reveal) · Run history |

---

## 10. Security model

- **In-runner auth:** `RUNNERBOX_TOKEN` repo secret → masked by GH automatically. Registration payload carries it as `Authorization` header over TLS — body (tunnel URL, daemon token) is never in the workflow file or logs.
- **Run binding:** register rejected unless `gh_run_id` is a run _we dispatched_ for that repo → manual/tampered dispatches produce a run that exists but is unreachable: our API never hands out its tunnel/token.
- **Tunnel secrecy:** `*.trycloudflare.com` subdomain is unguessable; every proxied command additionally requires the per-run `daemon_token` bearer. Two independent layers.
- **Token leak scope:** if `RUNNERBOX_TOKEN` leaks (e.g., malicious collaborator), attacker can only register fake tunnels against _that repo's_ runs → `runnerbox repair` rotates it.
- **Webhook:** `X-Hub-Signature-256` verified against App webhook secret.
- **Supply chain:** agent tarball sha256-pinned in the composite action; `agent-device` + `cloudflared` versions pinned in release manifest.
- **Installation tokens** are short-lived (1h), minted per-operation, cached in KV.

---

## 11. Edge cases & failure paths

| Case                                        | Handling                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Actions disabled on repo / dispatch 404-410 | `repo.state = needs_repair`, dashboard+CLI message "enable Actions"                                    |
| Protected default branch                    | Commit → 403 → open PR (`pending_pr`), dashboard polls contents API until file lands on default branch |
| `workflow_run` webhook dropped              | `ensure`/`current` lazily polls `getWorkflowRun` when state is stale (>90s in dispatching)             |
| Run dies before registering                 | `workflow_run completed` webhook → `failed`; next `sim` re-dispatches                                  |
| Run killed hard (GH eviction)               | Heartbeat gap >3 min → reap row                                                                        |
| Registration arrives for canceled run       | Rejected (state ∉ dispatching/booting)                                                                 |
| Repo renamed/transferred                    | `installation_repositories`/`installation` webhook → `needs_repair`                                    |
| App uninstalled                             | `installation deleted` → `uninstalled`; CLI + dashboard prompt reconnect                               |
| Two CLIs race `ensure`                      | `ensure_lock` KV key + conditional dispatch                                                            |
| Android requested before image ready        | Heartbeat `android_ready=false` surfaced in `ps`; `agent-device open` just waits/retries client-side   |

---

## 12. Cost & limits (v1 posture)

- **Our infra:** Workers free tier (100k req/day ≫ need), D1 free tier, KV free tier, `trycloudflare` tunnels free. ≈ $0.
- **User's infra:** their own GH Actions minutes — free on public repos, 10×-metered on private (warned, not blocked).
- **No rate limits** on our API in v1 per decision #9. The code should keep a `LIMITS` constant block anyway so a single config flip adds caps later.

---

## 13. Milestones

| #   | Milestone           | Done means                                                                                                                            |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Scaffold            | Monorepo, wrangler/pages/npm configs, GitHub App registered (dev instance), shared types package                                      |
| M1  | Auth + repo connect | Web OAuth, CLI device flow, App install → commit workflow + secret on a test repo (incl. PR fallback path)                            |
| M2  | Runner bring-up     | Composite action repo, release pipeline for agent binary, agent does proxy+tunnel+register on a manual test dispatch                  |
| M3  | Session loop e2e    | `runs/ensure` → dispatch → run_id bind → register → CLI `sim` prints working connect line → `agent-device open` on iOS works remotely |
| M4  | Lifecycle + Android | Idle/hard exits, `stop`, heartbeats, `workflow_run` states, Android AVD background provisioning, `ps` device reporting                |
| M5  | Ship                | Repair/disconnect, dashboard polish, private-repo warning, npm publish, Pages deploy, README/docs                                     |

**Known open items (not v1 blockers):** domain name registration (`api.runnerbox.dev` placeholder), npm package name availability (`runnerbox` vs `runnerbox-cli`), Android first-boot latency UX (image download ~2–3min), `--shell` eval flag, real published Marketplace action.
