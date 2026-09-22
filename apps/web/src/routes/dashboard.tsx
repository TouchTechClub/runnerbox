import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  formatDuration,
  formatTimestamp,
  queryKeys,
  useCurrentRun,
  useNow,
  useRepoStatus,
  useRuns,
} from "../lib/hooks";
import { ConfirmDialog, RepoStateChip, RunStateChip, Spinner } from "../components/ui";
import { rootRoute } from "./root";
import type { PublicRun } from "@runnerbox/shared/types";

// ---- Repo card ----

function RepoCard() {
  const status = useRepoStatus();
  const queryClient = useQueryClient();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.repoStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.runs }),
      queryClient.invalidateQueries({ queryKey: queryKeys.currentRun }),
    ]);

  const repair = useMutation({
    mutationFn: api.repairRepo,
    onSettled: invalidate,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectRepo,
    onSettled: invalidate,
  });

  const repo = status.data?.repo ?? null;

  if (status.isLoading) {
    return (
      <div className="card">
        <h2>Repository</h2>
        <div className="card-body">
          <Spinner label="loading…" />
        </div>
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="card">
        <h2>Repository</h2>
        <div className="card-body">
          <p className="muted">No repo connected yet.</p>
          <Link to="/onboarding" className="btn primary mt">
            Connect a repo
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Repository</h2>
      <div className="card-body">
        <div className="row between">
          <div className="row">
            <span className="mono" style={{ fontSize: 16 }}>
              {repo.fullName}
            </span>
            {repo.private ? <span className="badge warn">private ⚠️</span> : null}
            <RepoStateChip state={repo.state} />
          </div>
          <div className="gap">
            <button
              type="button"
              className="btn sm"
              disabled={repair.isPending}
              onClick={() => repair.mutate()}
            >
              {repair.isPending ? <span className="spinner" /> : null} Repair
            </button>
            <button
              type="button"
              className="btn sm danger"
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </button>
          </div>
        </div>

        {repo.private ? (
          <div className="notice warn">
            ⚠️ Private repo: GitHub bills macOS Actions minutes at a <strong>10× multiplier</strong>
            . Each RunnerBox run can burn ~10 hours of metered minutes. Consider using a public repo
            instead.
          </div>
        ) : null}

        {repo.state === "pending_pr" ? (
          <div className="notice warn">
            Setup is waiting on a pull request.{" "}
            {repo.prUrl ? <a href={repo.prUrl}>Merge this PR to finish</a> : null}
          </div>
        ) : null}

        {repo.state === "needs_repair" ? (
          <div className="notice error">
            The repo setup is broken (workflow file or secret missing, or Actions disabled). Hit{" "}
            <strong>Repair</strong> to re-install.
          </div>
        ) : null}

        {repo.state === "uninstalled" ? (
          <div className="notice error">
            The GitHub App was uninstalled from this repo.{" "}
            <Link to="/onboarding">Re-run onboarding</Link> to reconnect.
          </div>
        ) : null}

        {repair.isError ? (
          <div className="notice error">
            Repair failed:{" "}
            {repair.error instanceof ApiError ? repair.error.message : "unknown error"}
          </div>
        ) : null}
        {disconnect.isError ? (
          <div className="notice error">
            Disconnect failed:{" "}
            {disconnect.error instanceof ApiError ? disconnect.error.message : "unknown error"}
          </div>
        ) : null}
      </div>

      {confirmDisconnect ? (
        <ConfirmDialog
          title={`Disconnect ${repo.fullName}?`}
          body="This removes the runnerbox workflow and RUNNERBOX_TOKEN secret, cancels any live run, and frees your repo slot. You can reconnect later."
          confirmLabel="Disconnect"
          busy={disconnect.isPending}
          onConfirm={() =>
            disconnect.mutate(undefined, { onSettled: () => setConfirmDisconnect(false) })
          }
          onCancel={() => setConfirmDisconnect(false)}
        />
      ) : null}
    </div>
  );
}

// ---- Live run card ----

const STARTING_STATES = new Set(["dispatching", "queued", "booting", "closing"]);

function LiveRunCard() {
  const current = useCurrentRun();
  const queryClient = useQueryClient();
  const now = useNow();
  const [revealToken, setRevealToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const stop = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.currentRun });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });

  const run: PublicRun | null = current.data?.run ?? null;

  if (current.isLoading) {
    return (
      <div className="card">
        <h2>Live run</h2>
        <div className="card-body">
          <Spinner label="checking…" />
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="card">
        <h2>Live run</h2>
        <div className="card-body">
          <p className="muted">No active run. Start one from your terminal:</p>
          <div className="term">
            <span className="cmd">runnerbox sim</span>
          </div>
        </div>
      </div>
    );
  }

  const isLive = run.state === "live";

  const copyConnect = async () => {
    const cmd = `export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${run.daemonToken ?? ""}\nagent-device connect proxy --daemon-base-url ${run.tunnelUrl ?? ""}/agent-device`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="card">
      <h2>Live run</h2>
      <div className="card-body">
        <div className="row between">
          <div className="row">
            <RunStateChip state={run.state} />
            {run.ghRunId ? <span className="small faint mono">gh run #{run.ghRunId}</span> : null}
          </div>
          <button type="button" className="btn sm danger" onClick={() => setConfirmStop(true)}>
            Stop
          </button>
        </div>

        <div className="row mt small muted" style={{ gap: 20 }}>
          <span>
            uptime <span className="mono">{formatDuration(now - run.createdAt)}</span>
          </span>
          <span>
            devices <span className="mono">{run.activeDevices}</span>
          </span>
          <span>
            android{" "}
            {run.androidReady ? (
              <span className="mono" style={{ color: "var(--green)" }}>
                ready
              </span>
            ) : (
              <span className="mono" style={{ color: "var(--yellow)" }}>
                preparing…
              </span>
            )}
          </span>
          {run.expiresAt ? (
            <span>
              expires in <span className="mono">{formatDuration(run.expiresAt - now)}</span>
            </span>
          ) : null}
        </div>

        {isLive && run.tunnelUrl ? (
          <>
            <div className="term mt">
              <span className="comment"># connect from your machine</span>
              {"\n"}
              <span className="cmd">export</span> AGENT_DEVICE_DAEMON_AUTH_TOKEN=
              <span className="token-mask">
                {revealToken ? (run.daemonToken ?? "") : "••••••••••••••••"}
              </span>
              {"\n"}
              <span className="cmd">agent-device</span> connect proxy --daemon-base-url{" "}
              {run.tunnelUrl}/agent-device
            </div>
            <div className="gap mt">
              <button type="button" className="btn sm primary" onClick={() => void copyConnect()}>
                {copied ? "Copied ✓" : "Copy connect command"}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setRevealToken((v) => !v)}
              >
                {revealToken ? "Hide token" : "Reveal token"}
              </button>
            </div>
          </>
        ) : null}

        {STARTING_STATES.has(run.state) && run.state !== "closing" ? (
          <p className="small muted mt">
            <Spinner label="runner is coming up — connect command appears when it's live" />
          </p>
        ) : null}

        {stop.isError ? (
          <div className="notice error">
            Stop failed: {stop.error instanceof ApiError ? stop.error.message : "unknown error"}
          </div>
        ) : null}
      </div>

      {confirmStop ? (
        <ConfirmDialog
          title="Stop this run?"
          body="The GitHub Actions job will be cancelled and all connected devices will drop."
          confirmLabel="Stop run"
          busy={stop.isPending}
          onConfirm={() => stop.mutate(run.id, { onSettled: () => setConfirmStop(false) })}
          onCancel={() => setConfirmStop(false)}
        />
      ) : null}
    </div>
  );
}

// ---- History ----

function HistoryCard() {
  const runs = useRuns();
  const list = runs.data?.runs ?? [];

  return (
    <div className="card">
      <h2>Run history</h2>
      <div className="card-body">
        {runs.isLoading ? <Spinner label="loading…" /> : null}
        {runs.isError ? <div className="notice error">Failed to load run history.</div> : null}
        {!runs.isLoading && list.length === 0 ? <p className="muted small">No runs yet.</p> : null}
        {list.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>run</th>
                <th>state</th>
                <th>created</th>
                <th>ended</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="mono">
                    {r.id.slice(0, 8)}
                    {r.ghRunId ? ` · #${r.ghRunId}` : ""}
                  </td>
                  <td>
                    <RunStateChip state={r.state} />
                  </td>
                  <td>{formatTimestamp(r.createdAt)}</td>
                  <td>{formatTimestamp(r.endedAt)}</td>
                  <td className="mono">{r.endReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}

function Dashboard() {
  return (
    <>
      <RepoCard />
      <LiveRunCard />
      <HistoryCard />
    </>
  );
}

export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: Dashboard,
});
