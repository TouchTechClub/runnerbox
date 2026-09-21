import { Hono } from "hono";
import type {
  EnsureRunRequest,
  EnsureRunResponse,
  RunHeartbeatRequest,
  RunRegisterRequest,
  RunState,
} from "@runnerbox/shared";
import { HARD_EXIT_MINUTES, MAX_DEVICES_PER_RUN } from "@runnerbox/shared";
import type { AppContext } from "../middleware";
import { requireRunnerToken, requireUser } from "../middleware";
import type { RepoRow, RunRow } from "../db";
import { getLatestActiveRun, getRepoForUser, isTerminal } from "../db";
import {
  apiError,
  newId,
  nowSeconds,
  toPublicRun,
  toRunSummary,
} from "../util";
import {
  bindGhRunId,
  cancelWorkflowRun,
  dispatchWorkflow,
  getWorkflowRun,
  GithubApiError,
  installationToken,
} from "../github";

export const runRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// Lazy reconciliation
//
// The schema has no heartbeat timestamp column (locked in the plan), so stale
// detection is time-based: `expires_at` marks the hard-exit horizon, and runs
// that sit too long in early states get reconciled by asking GitHub for the
// real workflow_run status. The `gh_check:{run_id}` KV key throttles those
// API calls to at most once per 20s per run. The workflow_run webhook remains
// the primary update path (plan §11).
// ---------------------------------------------------------------------------

const DISPATCH_BIND_GRACE_SECONDS = 600; // unbound run older than this → failed
const GH_CHECK_THROTTLE_SECONDS = 20;

export function mapWorkflowRun(
  status: string | null,
  conclusion: string | null,
  current: RunState,
): { state: RunState; endReason: string | null } | null {
  if (status === "queued" || status === "waiting" || status === "pending") {
    return current === "dispatching" || current === "queued"
      ? { state: "queued", endReason: null }
      : null;
  }
  if (status === "in_progress" || status === "requested") {
    return current === "dispatching" || current === "queued" || current === "booting"
      ? { state: "booting", endReason: null }
      : null;
  }
  if (status === "completed") {
    if (isTerminal(current)) return null;
    if (conclusion === "success") return { state: "ended", endReason: "completed" };
    if (conclusion === "cancelled") return { state: "ended", endReason: "cancelled" };
    return { state: "failed", endReason: conclusion ?? "unknown" };
  }
  return null;
}

async function applyRunTransition(
  db: D1Database,
  run: RunRow,
  next: { state: RunState; endReason: string | null },
): Promise<RunRow> {
  const now = nowSeconds();
  const terminal = isTerminal(next.state);
  await db
    .prepare(
      `UPDATE runs SET state = ?, end_reason = ?, ended_at = ? WHERE id = ?`,
    )
    .bind(
      next.state,
      next.endReason ?? run.end_reason,
      terminal ? (run.ended_at ?? now) : run.ended_at,
      run.id,
    )
    .run();
  return {
    ...run,
    state: next.state,
    end_reason: next.endReason ?? run.end_reason,
    ended_at: terminal ? (run.ended_at ?? now) : run.ended_at,
  };
}

/**
 * Ask GitHub about a run whose local state looks stale, and fold the result
 * back into the runs row. Throttled via KV so hot endpoints don't hammer the
 * GitHub API.
 */
export async function reconcileRun(
  env: { DB: D1Database; KV: KVNamespace },
  run: RunRow,
  repo: RepoRow | null,
  instToken: string | null,
): Promise<RunRow> {
  if (isTerminal(run.state) || !repo) return run;
  const now = nowSeconds();

  // Past the hard-exit horizon → treat as ended regardless of what GH says.
  if (run.expires_at !== null && run.expires_at < now) {
    return applyRunTransition(env.DB, run, { state: "ended", endReason: "expired" });
  }

  // Dispatching with no gh_run_id: retry binding briefly, then give up.
  if (run.state === "dispatching" && run.gh_run_id === null) {
    if (run.created_at + DISPATCH_BIND_GRACE_SECONDS < now) {
      return applyRunTransition(env.DB, run, { state: "failed", endReason: "run_never_appeared" });
    }
    if (!instToken) return run;
    const throttleKey = `gh_check:${run.id}`;
    if (await env.KV.get(throttleKey)) return run;
    await env.KV.put(throttleKey, "1", { expirationTtl: GH_CHECK_THROTTLE_SECONDS });
    const bound = await bindGhRunId(instToken, repo.full_name, run.created_at, 1).catch(() => null);
    if (bound) {
      await env.DB.prepare("UPDATE runs SET gh_run_id = ?, state = 'queued' WHERE id = ? AND gh_run_id IS NULL")
        .bind(bound, run.id)
        .run();
      return { ...run, gh_run_id: bound, state: "queued" };
    }
    return run;
  }

  if (!run.gh_run_id || !instToken) return run;

  // Only poll GH for runs that look stale — a run stuck in dispatching/queued/
  // booting for >90s, or a closing run that hasn't resolved.
  const staleEarly =
    (run.state === "dispatching" || run.state === "queued" || run.state === "booting") &&
    run.created_at + 90 < now;
  const staleClosing = run.state === "closing";
  const suspiciousLive = run.state === "live" && run.live_at !== null && run.live_at + HARD_EXIT_MINUTES * 60 < now;
  if (!staleEarly && !staleClosing && !suspiciousLive) return run;

  const throttleKey = `gh_check:${run.id}`;
  if (await env.KV.get(throttleKey)) return run;
  await env.KV.put(throttleKey, "1", { expirationTtl: GH_CHECK_THROTTLE_SECONDS });

  const info = await getWorkflowRun(instToken, repo.full_name, run.gh_run_id).catch(() => null);
  if (!info) {
    // Run vanished from GitHub entirely → almost certainly dead.
    return applyRunTransition(env.DB, run, { state: "failed", endReason: "run_not_found" });
  }
  const next = mapWorkflowRun(info.status, info.conclusion, run.state);
  return next ? applyRunTransition(env.DB, run, next) : run;
}

// ---------------------------------------------------------------------------
// POST /v1/runs/ensure — the heart of the run state machine.
// ---------------------------------------------------------------------------

runRoutes.post("/v1/runs/ensure", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<EnsureRunRequest>().catch(() => ({}) as EnsureRunRequest);
  const wantNew = body.new === true;

  const repo = await getRepoForUser(c.env.DB, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "Connect a repo first (dashboard onboarding).");
  if (repo.state !== "ok") {
    return apiError(c, 409, "repo_not_ready", `Repo state is "${repo.state}" — finish setup or run repair.`);
  }

  const instToken = await installationToken(c.env, repo.installation_id);

  let active = await getLatestActiveRun(c.env.DB, user.id);
  if (active) active = await reconcileRun(c.env, active, repo, instToken);

  if (active && !isTerminal(active.state)) {
    if (!wantNew) {
      if (active.state === "live") {
        if (active.active_devices >= MAX_DEVICES_PER_RUN) {
          return c.json(
            {
              error: "at_capacity",
              message: `Run already has ${active.active_devices} devices (cap ${MAX_DEVICES_PER_RUN}).`,
              hint: "use --new",
            },
            409,
          );
        }
        const resp: EnsureRunResponse = {
          state: "live",
          runId: active.id,
          ghRunId: active.gh_run_id ?? 0,
          tunnelUrl: active.tunnel_url ?? "",
          daemonToken: active.daemon_token ?? "",
          expiresAt: (active.expires_at ?? 0) * 1000,
        };
        return c.json(resp);
      }
      if (active.state === "closing") {
        // Treat closing as occupied until the webhook/poll resolves it —
        // dispatching a second run would fight the shutdown.
        const resp: EnsureRunResponse = { state: "booting", runId: active.id };
        return c.json(resp);
      }
      const resp: EnsureRunResponse = { state: active.state as "dispatching" | "queued" | "booting", runId: active.id };
      return c.json(resp);
    }
    // wantNew → mark the old run for shutdown and dispatch fresh.
    if (active.gh_run_id) {
      c.executionCtx.waitUntil(
        cancelWorkflowRun(instToken, repo.full_name, active.gh_run_id).catch(() => {}),
      );
    }
    await c.env.DB.prepare(
      "UPDATE runs SET state = 'closing' WHERE id = ? AND state NOT IN ('ended','failed')",
    )
      .bind(active.id)
      .run();
  }

  // Idempotency: two CLIs racing `ensure` — the loser sees the lock and
  // reports "dispatching" rather than double-dispatching.
  const lockKey = `ensure_lock:${user.id}`;
  if (await c.env.KV.get(lockKey)) {
    const resp: EnsureRunResponse = { state: "dispatching", runId: active?.id ?? "" };
    return c.json(resp);
  }
  await c.env.KV.put(lockKey, "1", { expirationTtl: 60 });

  try {
    const now = nowSeconds();
    try {
      await dispatchWorkflow(instToken, repo.full_name, repo.default_branch);
    } catch (e) {
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 410)) {
        // Actions disabled or workflow file missing → needs_repair (plan §11).
        await c.env.DB.prepare("UPDATE repos SET state = 'needs_repair' WHERE user_id = ?")
          .bind(user.id)
          .run();
        return apiError(c, 409, "dispatch_failed", "Could not dispatch the workflow — run `runnerbox repair`.");
      }
      throw e;
    }

    // workflow_dispatch returns 204 — bind the real run id by polling.
    const ghRunId = await bindGhRunId(instToken, repo.full_name, now).catch(() => null);

    const runId = newId();
    await c.env.DB.prepare(
      `INSERT INTO runs (id, user_id, repo_full_name, gh_run_id, state, created_at, dispatched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        runId,
        user.id,
        repo.full_name,
        ghRunId,
        ghRunId ? "queued" : "dispatching",
        now,
        now,
        now + HARD_EXIT_MINUTES * 60,
      )
      .run();

    const resp: EnsureRunResponse = ghRunId
      ? { state: "queued", runId }
      : { state: "dispatching", runId };
    return c.json(resp);
  } finally {
    // Release via waitUntil so the response isn't held by KV latency.
    c.executionCtx.waitUntil(c.env.KV.delete(lockKey));
  }
});

// ---------------------------------------------------------------------------
// GET /v1/runs/current — latest non-terminal run (reconciled).
// ---------------------------------------------------------------------------

runRoutes.get("/v1/runs/current", requireUser, async (c) => {
  const user = c.get("user");
  const repo = await getRepoForUser(c.env.DB, user.id);
  let run = await getLatestActiveRun(c.env.DB, user.id);
  if (run && repo) {
    // Reconciliation may need an installation token; fetch lazily only when
    // the run looks stale to avoid paying the JWT+KV cost on every poll.
    const now = nowSeconds();
    const looksStale =
      (run.expires_at !== null && run.expires_at < now) ||
      (run.state === "dispatching" && run.created_at + 90 < now) ||
      ((run.state === "queued" || run.state === "booting") && run.created_at + 90 < now) ||
      run.state === "closing" ||
      (run.state === "live" && run.live_at !== null && run.live_at + HARD_EXIT_MINUTES * 60 < now);
    if (looksStale) {
      const instToken = await installationToken(c.env, repo.installation_id).catch(() => null);
      run = await reconcileRun(c.env, run, repo, instToken);
    }
  }
  if (!run || isTerminal(run.state)) return c.json({ run: null });
  return c.json({ run: toPublicRun(run) });
});

// ---------------------------------------------------------------------------
// GET /v1/runs — history (no secrets).
// ---------------------------------------------------------------------------

runRoutes.get("/v1/runs", requireUser, async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
  )
    .bind(user.id)
    .all<RunRow>();
  return c.json({ runs: (results ?? []).map(toRunSummary) });
});

// ---------------------------------------------------------------------------
// POST /v1/runs/:id/stop — cancel via GitHub, then wait for webhook to end it.
// ---------------------------------------------------------------------------

runRoutes.post("/v1/runs/:id/stop", requireUser, async (c) => {
  const user = c.get("user");
  const runId = c.req.param("id");
  let run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?")
    .bind(runId)
    .first<RunRow>();
  // Ownership check: a run id is an unguessable uuid, but still scope to user.
  if (!run || run.user_id !== user.id) {
    return apiError(c, 404, "not_found", "Run not found.");
  }
  if (isTerminal(run.state)) return c.json({ run: toPublicRun(run) });

  const repo = await getRepoForUser(c.env.DB, user.id);
  const now = nowSeconds();
  if (run.gh_run_id && repo) {
    try {
      const instToken = await installationToken(c.env, repo.installation_id);
      await cancelWorkflowRun(instToken, repo.full_name, run.gh_run_id);
      await c.env.DB.prepare("UPDATE runs SET state = 'closing' WHERE id = ?")
        .bind(run.id)
        .run();
      run = { ...run, state: "closing" };
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 404) {
        // Already gone on GitHub — close it locally.
        await c.env.DB.prepare(
          "UPDATE runs SET state = 'ended', ended_at = ?, end_reason = 'cancelled' WHERE id = ?",
        )
          .bind(now, run.id)
          .run();
        run = { ...run, state: "ended", ended_at: now, end_reason: "cancelled" };
      } else {
        throw e;
      }
    }
  } else {
    // Never bound to a GH run → nothing to cancel remotely.
    await c.env.DB.prepare(
      "UPDATE runs SET state = 'ended', ended_at = ?, end_reason = 'stopped' WHERE id = ?",
    )
      .bind(now, run.id)
      .run();
    run = { ...run, state: "ended", ended_at: now, end_reason: "stopped" };
  }
  return c.json({ run: toPublicRun(run) });
});

// ---------------------------------------------------------------------------
// Runner-authenticated endpoints (Bearer RUNNERBOX_TOKEN)
// ---------------------------------------------------------------------------

// POST /v1/runs/register — agent announces its tunnel.
// Security: the run must be one WE dispatched for THIS repo — otherwise a
// leaked token could attach foreign tunnels to arbitrary runs.
runRoutes.post("/v1/runs/register", requireRunnerToken, async (c) => {
  const repo = c.get("repo");
  const body = await c.req.json<RunRegisterRequest>().catch(() => null);
  if (!body || typeof body.ghRunId !== "number" || !body.tunnelUrl || !body.daemonToken) {
    return apiError(c, 400, "bad_request", "Expected {ghRunId, tunnelUrl, daemonToken, versions}.");
  }

  // Normal path: gh_run_id was bound at dispatch time.
  let run = await c.env.DB.prepare("SELECT * FROM runs WHERE gh_run_id = ?")
    .bind(body.ghRunId)
    .first<RunRow>();

  if (!run) {
    // Fallback: ensure's bind poll timed out and the webhook hasn't arrived —
    // adopt the run id onto the single unbound dispatching run for this repo.
    run = await c.env.DB.prepare(
      `SELECT * FROM runs WHERE repo_full_name = ? AND gh_run_id IS NULL AND state = 'dispatching'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(repo.full_name)
      .first<RunRow>();
    if (run) {
      await c.env.DB.prepare("UPDATE runs SET gh_run_id = ? WHERE id = ? AND gh_run_id IS NULL")
        .bind(body.ghRunId, run.id)
        .run();
      run = { ...run, gh_run_id: body.ghRunId };
    }
  }

  if (
    !run ||
    run.repo_full_name !== repo.full_name ||
    (run.state !== "dispatching" && run.state !== "queued" && run.state !== "booting")
  ) {
    return apiError(c, 403, "run_not_accepted", "No dispatched run matching this gh_run_id.");
  }

  const now = nowSeconds();
  await c.env.DB.prepare(
    `UPDATE runs SET state = 'live', tunnel_url = ?, daemon_token = ?, live_at = ? WHERE id = ?`,
  )
    .bind(body.tunnelUrl, body.daemonToken, now, run.id)
    .run();
  return c.json({ ok: true });
});

// POST /v1/runs/heartbeat — refresh device counts. A missing heartbeat is
// detected lazily (see reconcileRun — no heartbeat column in the locked schema).
runRoutes.post("/v1/runs/heartbeat", requireRunnerToken, async (c) => {
  const repo = c.get("repo");
  const body = await c.req.json<RunHeartbeatRequest>().catch(() => null);
  if (!body || typeof body.ghRunId !== "number") {
    return apiError(c, 400, "bad_request", "Expected {ghRunId, active_devices, android_ready}.");
  }
  const run = await c.env.DB.prepare(
    "SELECT * FROM runs WHERE gh_run_id = ? AND repo_full_name = ?",
  )
    .bind(body.ghRunId, repo.full_name)
    .first<RunRow>();
  if (!run || isTerminal(run.state)) {
    return apiError(c, 404, "run_not_found", "No active run for this gh_run_id.");
  }
  await c.env.DB.prepare(
    "UPDATE runs SET active_devices = ?, android_ready = ? WHERE id = ?",
  )
    .bind(Math.max(0, body.activeDevices | 0), body.androidReady ? 1 : 0, run.id)
    .run();
  return c.json({ ok: true });
});

// POST /v1/runs/deregister — clean shutdown path from the agent.
runRoutes.post("/v1/runs/deregister", requireRunnerToken, async (c) => {
  const repo = c.get("repo");
  const body = await c.req
    .json<{ ghRunId?: number; reason?: string }>()
    .catch(() => ({}) as { ghRunId?: number; reason?: string });
  const now = nowSeconds();
  if (typeof body.ghRunId === "number") {
    await c.env.DB.prepare(
      `UPDATE runs SET state = 'ended', ended_at = ?, end_reason = ?
       WHERE gh_run_id = ? AND repo_full_name = ? AND state NOT IN ('ended','failed')`,
    )
      .bind(now, body.reason ?? "agent_exit", body.ghRunId, repo.full_name)
      .run();
  } else {
    // No gh_run_id — end any still-active run for this repo.
    await c.env.DB.prepare(
      `UPDATE runs SET state = 'ended', ended_at = ?, end_reason = ?
       WHERE repo_full_name = ? AND state NOT IN ('ended','failed')`,
    )
      .bind(now, body.reason ?? "agent_exit", repo.full_name)
      .run();
  }
  return c.json({ ok: true });
});
