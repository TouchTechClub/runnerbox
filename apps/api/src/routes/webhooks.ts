import { Hono } from "hono";
import type { Env } from "../env";
import type { RepoRow, RunRow } from "../db";
import { nowSeconds } from "../util";
import { verifyWebhookSignature } from "../github";
import { mapWorkflowRun } from "./runs";

export const webhookRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /webhooks/github — X-Hub-Signature-256 verified against the raw body.
// ---------------------------------------------------------------------------

interface InstallationPayload {
  action: string;
  installation: {
    id: number;
    account?: { login?: string } | null;
    suspended_at?: string | null;
  };
}

interface InstallationReposPayload {
  action: string;
  installation: { id: number };
  repositories_removed?: Array<{ full_name?: string }>;
}

interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    status: string | null;
    conclusion: string | null;
    path?: string;
    repository?: { full_name?: string };
  };
}

webhookRoutes.post("/webhooks/github", async (c) => {
  const raw = await c.req.arrayBuffer();
  const ok = await verifyWebhookSignature(
    c.env.GITHUB_WEBHOOK_SECRET,
    raw,
    c.req.header("X-Hub-Signature-256") ?? null,
  );
  if (!ok) {
    return c.json({ error: "bad_signature" }, 401);
  }

  const event = c.req.header("X-GitHub-Event") ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }

  const now = nowSeconds();

  if (event === "installation") {
    const p = payload as InstallationPayload;
    const installationId = p.installation?.id;
    if (!installationId) return c.json({ ok: true });

    if (p.action === "created") {
      // Record the installation; user attribution happens at repo/connect
      // (the webhook can't know which of our users clicked install).
      await c.env.DB.prepare(
        `INSERT INTO installations (installation_id, account_login, user_id, created_at)
         VALUES (?, ?, NULL, ?)
         ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login`,
      )
        .bind(installationId, p.installation.account?.login ?? null, now)
        .run();
    } else if (p.action === "deleted" || p.action === "suspend") {
      await c.env.DB.prepare(
        "UPDATE repos SET state = 'uninstalled' WHERE installation_id = ?",
      )
        .bind(installationId)
        .run();
    } else if (p.action === "unsuspend") {
      await c.env.DB.prepare(
        "UPDATE repos SET state = 'needs_repair' WHERE installation_id = ? AND state = 'uninstalled'",
      )
        .bind(installationId)
        .run();
    }
    return c.json({ ok: true });
  }

  if (event === "installation_repositories") {
    const p = payload as InstallationReposPayload;
    if (p.action === "removed" && p.repositories_removed?.length) {
      // If the connected repo was removed from the installation, the repo
      // needs repair (plan §11 — covers renames/transfers too).
      const removed = p.repositories_removed
        .map((r) => r.full_name)
        .filter((n): n is string => typeof n === "string");
      for (const fullName of removed) {
        await c.env.DB.prepare(
          "UPDATE repos SET state = 'needs_repair' WHERE full_name = ? AND installation_id = ?",
        )
          .bind(fullName, p.installation.id)
          .run();
      }
    }
    return c.json({ ok: true });
  }

  if (event === "workflow_run") {
    const p = payload as WorkflowRunPayload;
    const wr = p.workflow_run;
    if (!wr?.id) return c.json({ ok: true });

    let run = await c.env.DB.prepare("SELECT * FROM runs WHERE gh_run_id = ?")
      .bind(wr.id)
      .first<RunRow>();

    if (!run && wr.repository?.full_name) {
      // Bind a dispatching run whose gh_run_id was never resolved by the
      // ensure-time poll (see bindGhRunId).
      const repo = await c.env.DB.prepare(
        "SELECT * FROM repos WHERE full_name = ?",
      )
        .bind(wr.repository.full_name)
        .first<RepoRow>();
      if (repo) {
        const unbound = await c.env.DB.prepare(
          `SELECT * FROM runs WHERE user_id = ? AND gh_run_id IS NULL AND state = 'dispatching'
           ORDER BY created_at DESC LIMIT 1`,
        )
          .bind(repo.user_id)
          .first<RunRow>();
        if (unbound) {
          await c.env.DB.prepare(
            "UPDATE runs SET gh_run_id = ? WHERE id = ? AND gh_run_id IS NULL",
          )
            .bind(wr.id, unbound.id)
            .run();
          run = { ...unbound, gh_run_id: wr.id };
        }
      }
    }

    if (!run) return c.json({ ok: true });

    const next = mapWorkflowRun(wr.status, wr.conclusion, run.state);
    if (next) {
      const terminal = next.state === "ended" || next.state === "failed";
      await c.env.DB.prepare(
        `UPDATE runs SET state = ?, end_reason = ?, ended_at = ? WHERE id = ?`,
      )
        .bind(
          next.state,
          next.endReason ?? run.end_reason,
          terminal ? (run.ended_at ?? now) : run.ended_at,
          run.id,
        )
        .run();
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
