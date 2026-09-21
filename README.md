# RunnerBox

Free on-demand iOS simulators & Android emulators running on your own GitHub Actions minutes, exposed to your local machine as an `agent-device` remote proxy.

**Plan:** [.plans/v1-plan.md](.plans/v1-plan.md)

## How it works

1. Sign in with GitHub on the dashboard, install the GitHub App, pick a repo.
2. We commit `.github/workflows/runnerbox.yml` to the repo and write a `RUNNERBOX_TOKEN` secret.
3. `runnerbox sim` asks our API for a run → we `workflow_dispatch` into your repo → a `macos-latest` runner boots `agent-device proxy` + a Cloudflare tunnel → the tunnel URL + daemon token come back to your CLI.
4. Drive sims/emulators with `agent-device` until the run ends (idle timeout, `runnerbox stop`, or ~6h).

## Monorepo

| Path | What |
|---|---|
| `apps/api` | Cloudflare Worker (Hono + D1 + KV) — auth, repo connect, run registry |
| `apps/cli` | `runnerbox` npm package — login/sim/ps/stop/repair |
| `apps/web` | TanStack dashboard (Vite + Router + Query) — CF Pages |
| `packages/agent` | `runnerbox-agent` Bun-compiled binary that runs inside the GH job |
| `packages/shared` | API contracts, constants, canonical workflow YAML |
| `action-src` | Source of the composite action published to `runnerbox/runner` |

## Develop

```bash
bun install
bun run typecheck        # all packages
bun run dev:api          # wrangler dev (needs .dev.vars, see apps/api/.dev.vars.example)
bun run dev:web          # vite dev on :5173, proxies /v1 → :8787
bun run --cwd apps/cli dev -- <command>   # run CLI from source
```

## Deploy checklist (first time)

- [ ] Register the GitHub App (contents/secrets/actions write; webhook → `POST /webhooks/github`; user OAuth)
- [ ] `wrangler d1 create` + `wrangler kv create`, fill IDs in `apps/api/wrangler.toml`, `bun run --cwd apps/api db:migrate`
- [ ] `wrangler secret put` GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET / GITHUB_OAUTH_CLIENT_SECRET
- [ ] Create `runnerbox/runner` repo, publish `action-src/` there, tag `v1`
- [ ] `action-src/release.sh <version>` → build agent, publish release tarball on `runnerbox/runnerbox`
- [ ] `npm publish` in `apps/cli`, deploy `apps/web` to Pages
