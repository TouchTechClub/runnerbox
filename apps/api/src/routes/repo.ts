import { Hono } from "hono";
import type { RepoStatusResponse } from "@runnerbox/shared";
import type { AppContext } from "../middleware";
import { requireUser } from "../middleware";
import type { RepoRow, RunRow } from "../db";
import { getRepoForUser } from "../db";
import {
  apiError,
  nowSeconds,
  randomTokenHex,
  sha256Hex,
  toPublicRepo,
} from "../util";
import {
  cancelWorkflowRun,
  commitWorkflow,
  deleteRunnerboxTokenSecret,
  deleteWorkflowFile,
  gh,
  GithubApiError,
  installationToken,
  workflowFileExists,
  writeRunnerboxTokenSecret,
} from "../github";

export const repoRoutes = new Hono<AppContext>();
repoRoutes.use("/v1/installations", requireUser);
repoRoutes.use("/v1/repo/*", requireUser);

// ---------------------------------------------------------------------------
// GET /v1/installations — repos reachable via the user's App installations.
// Uses the user's OAuth token: GET /user/installations only works with
// user-to-server tokens, not installation tokens.
// ---------------------------------------------------------------------------

interface UserInstallationsResponse {
  installations: Array<{ id: number; account: { login: string } | null }>;
}

interface InstallationReposResponse {
  repositories: Array<{
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
  }>;
}

repoRoutes.get("/v1/installations", async (c) => {
  const user = c.get("user");
  if (!user.github_access_token) {
    return apiError(c, 400, "no_github_token", "Re-login required: missing GitHub token.");
  }
  const installations = await gh<UserInstallationsResponse>(
    user.github_access_token,
    "/user/installations?per_page=100",
  );
  const repos: Array<{
    repo_id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    installation_id: number;
    account_login: string | null;
  }> = [];
  for (const inst of installations.installations) {
    const list = await gh<InstallationReposResponse>(
      user.github_access_token,
      `/user/installations/${inst.id}/repositories?per_page=100`,
    );
    for (const r of list.repositories) {
      repos.push({
        repo_id: r.id,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        installation_id: inst.id,
        account_login: inst.account?.login ?? null,
      });
    }
  }
  return c.json({ installations: repos });
});

// ---------------------------------------------------------------------------
// POST /v1/repo/connect — write secret → commit workflow (PR fallback) → row.
// ---------------------------------------------------------------------------

interface ConnectBody {
  repo_id: number;
  full_name: string;
  private?: boolean;
  default_branch?: string;
  installation_id: number;
}

repoRoutes.post("/v1/repo/connect", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<ConnectBody>().catch(() => null);
  if (!body || typeof body.repo_id !== "number" || !body.full_name || typeof body.installation_id !== "number") {
    return apiError(c, 400, "bad_request", "Expected {repo_id, full_name, installation_id}.");
  }
  const existing = await getRepoForUser(c.env.DB, user.id);
  if (existing) {
    return apiError(c, 409, "repo_already_connected", "Disconnect the current repo before connecting another.");
  }

  const instToken = await installationToken(c.env, body.installation_id);

  // 1. Secret first — a workflow without its secret would fail on first dispatch.
  const runnerboxToken = randomTokenHex();
  try {
    await writeRunnerboxTokenSecret(instToken, body.full_name, runnerboxToken);
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 410 || e.status === 403)) {
      return apiError(c, 400, "secret_write_failed", "Could not write the repo secret — is the App installed on this repo with secrets:write?");
    }
    throw e;
  }

  // 2. Workflow file → default branch, PR fallback on protected branches.
  let state: "ok" | "pending_pr" = "ok";
  let prUrl: string | null = null;
  try {
    const result = await commitWorkflow(c.env, instToken, body.full_name, body.default_branch ?? "main");
    if (result.kind === "pending_pr") {
      state = "pending_pr";
      prUrl = result.prUrl;
    }
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 410)) {
      return apiError(c, 400, "actions_unavailable", "GitHub Actions is not available on this repo — enable Actions and retry.");
    }
    throw e;
  }

  const now = nowSeconds();
  const accountLogin = body.full_name.split("/")[0] ?? null;
  // Record the installation↔user attribution now (installation webhooks can't
  // reliably attribute which of our users installed the app).
  await c.env.DB.prepare(
    `INSERT INTO installations (installation_id, account_login, user_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET
       account_login = excluded.account_login,
       user_id = excluded.user_id`,
  )
    .bind(body.installation_id, accountLogin, user.id, now)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO repos (user_id, repo_id, full_name, private, default_branch, installation_id, state, pr_url, runnerbox_token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      user.id,
      body.repo_id,
      body.full_name,
      body.private ? 1 : 0,
      body.default_branch ?? "main",
      body.installation_id,
      state,
      prUrl,
      await sha256Hex(runnerboxToken),
      now,
    )
    .run();

  const repo = await getRepoForUser(c.env.DB, user.id);
  const resp: RepoStatusResponse = { connected: true, repo: repo ? toPublicRepo(repo) : null };
  return c.json(resp, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/repo/status — lazily promote pending_pr → ok once the workflow file
// has landed on the default branch (i.e. the setup PR was merged).
// ---------------------------------------------------------------------------

repoRoutes.get("/v1/repo/status", async (c) => {
  const user = c.get("user");
  const repo = await getRepoForUser(c.env.DB, user.id);
  if (!repo) {
    const resp: RepoStatusResponse = { connected: false, repo: null };
    return c.json(resp);
  }
  if (repo.state === "pending_pr") {
    try {
      const token = await installationToken(c.env, repo.installation_id);
      if (await workflowFileExists(token, repo.full_name, repo.default_branch)) {
        await c.env.DB.prepare(
          "UPDATE repos SET state = 'ok', pr_url = NULL WHERE user_id = ?",
        )
          .bind(user.id)
          .run();
        repo.state = "ok";
        repo.pr_url = null;
      }
    } catch (e) {
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 401)) {
        // Installation gone → surface as uninstalled rather than erroring.
        await c.env.DB.prepare("UPDATE repos SET state = 'uninstalled' WHERE user_id = ?")
          .bind(user.id)
          .run();
        repo.state = "uninstalled";
      } else {
        throw e;
      }
    }
  }
  const resp: RepoStatusResponse = { connected: true, repo: toPublicRepo(repo) };
  return c.json(resp);
});

// ---------------------------------------------------------------------------
// POST /v1/repo/repair — rotate RUNNERBOX_TOKEN + re-commit workflow.
// ---------------------------------------------------------------------------

repoRoutes.post("/v1/repo/repair", async (c) => {
  const user = c.get("user");
  const repo = await getRepoForUser(c.env.DB, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "No repo connected.");

  let instToken: string;
  try {
    instToken = await installationToken(c.env, repo.installation_id);
    // Verify the installation still exists at all.
    await gh<unknown>(instToken, `/repos/${repo.full_name}`);
  } catch (e) {
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 401 || e.status === 403)) {
      await c.env.DB.prepare("UPDATE repos SET state = 'uninstalled' WHERE user_id = ?")
        .bind(user.id)
        .run();
      return apiError(c, 409, "installation_gone", "The GitHub App installation was removed — reinstall it, then reconnect.");
    }
    throw e;
  }

  const runnerboxToken = randomTokenHex();
  await writeRunnerboxTokenSecret(instToken, repo.full_name, runnerboxToken);

  let state: "ok" | "pending_pr" = "ok";
  let prUrl: string | null = null;
  const result = await commitWorkflow(c.env, instToken, repo.full_name, repo.default_branch);
  if (result.kind === "pending_pr") {
    state = "pending_pr";
    prUrl = result.prUrl;
  }

  await c.env.DB.prepare(
    "UPDATE repos SET state = ?, pr_url = ?, runnerbox_token_hash = ? WHERE user_id = ?",
  )
    .bind(state, prUrl, await sha256Hex(runnerboxToken), user.id)
    .run();

  const updated = await getRepoForUser(c.env.DB, user.id);
  const resp: RepoStatusResponse = { connected: true, repo: updated ? toPublicRepo(updated) : null };
  return c.json(resp);
});

// ---------------------------------------------------------------------------
// POST /v1/repo/disconnect — delete workflow + secret, cancel live run, free slot.
// ---------------------------------------------------------------------------

repoRoutes.post("/v1/repo/disconnect", async (c) => {
  const user = c.get("user");
  const repo = await getRepoForUser(c.env.DB, user.id);
  if (!repo) return apiError(c, 404, "no_repo", "No repo connected.");

  // Cancel any active run before the repo row disappears.
  const activeRun = await c.env.DB.prepare(
    `SELECT * FROM runs WHERE user_id = ? AND state NOT IN ('ended','failed')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.id)
    .first<RunRow>();

  // Remote cleanup is best-effort: the installation may already be gone.
  try {
    const instToken = await installationToken(c.env, repo.installation_id);
    if (activeRun?.gh_run_id) {
      await cancelWorkflowRun(instToken, repo.full_name, activeRun.gh_run_id).catch(() => {});
    }
    await deleteWorkflowFile(instToken, repo.full_name, repo.default_branch).catch(() => {});
    await deleteRunnerboxTokenSecret(instToken, repo.full_name).catch(() => {});
  } catch {
    // Swallow — repo row is removed regardless.
  }

  const now = nowSeconds();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE runs SET state = 'ended', ended_at = ?, end_reason = 'repo_disconnected'
       WHERE user_id = ? AND state NOT IN ('ended','failed')`,
    ).bind(now, user.id),
    c.env.DB.prepare("DELETE FROM repos WHERE user_id = ?").bind(user.id),
  ]);
  return c.json({ ok: true });
});
