import { useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, ApiError, GITHUB_APP_INSTALL_URL } from "../lib/api";
import type { InstallableRepo } from "../lib/api";
import { queryKeys, useInstallations, useMe, useRepoStatus } from "../lib/hooks";
import { RepoStateChip, Spinner } from "../components/ui";
import { rootRoute } from "./root";

type Step = "install" | "pick" | "progress";

const STEP_ORDER: Step[] = ["install", "pick", "progress"];
const STEP_LABELS: Record<Step, string> = {
  install: "1 · install app",
  pick: "2 · pick repo",
  progress: "3 · connect",
};

function StepBar({ step }: { step: Step }) {
  const activeIdx = STEP_ORDER.indexOf(step);
  return (
    <div className="steps">
      {STEP_ORDER.map((s, i) => (
        <div key={s} className={`step ${i === activeIdx ? "active" : i < activeIdx ? "done" : ""}`}>
          {STEP_LABELS[s]}
        </div>
      ))}
    </div>
  );
}

/** Step 1+2: poll installations; once repos are reachable, show the picker. */
function InstallAndPick({
  step,
  onPicked,
  connecting,
}: {
  step: "install" | "pick";
  onPicked: () => void;
  connecting: boolean;
}) {
  const installations = useInstallations(true); // poll every 4s
  const repos = installations.data ?? [];
  const [error, setError] = useState<string | null>(null);
  const [busyRepo, setBusyRepo] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const connect = async (repo: InstallableRepo) => {
    setBusyRepo(repo.repoId);
    setError(null);
    try {
      await api.connectRepo({
        repo_id: repo.repoId,
        full_name: repo.fullName,
        private: repo.private,
        default_branch: repo.defaultBranch,
        installation_id: repo.installationId,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.repoStatus });
      onPicked();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to connect repo");
    } finally {
      setBusyRepo(null);
    }
  };

  return (
    <>
      <StepBar step={repos.length > 0 ? "pick" : step} />
      <div className="card">
        <h2>Repositories</h2>
        <div className="card-body">
          {repos.length === 0 ? (
            <>
              <p className="muted">
                RunnerBox needs the GitHub App installed on a repo you own. Install it, grant access
                to a repo, and it will appear here automatically.
              </p>
              <a className="btn primary mt" href={GITHUB_APP_INSTALL_URL}>
                Install the RunnerBox GitHub App
              </a>
              <p className="small faint mt">
                <Spinner label="waiting for an installation…" />
              </p>
            </>
          ) : (
            <>
              <p className="muted">Pick the repo RunnerBox should run in. One repo per account.</p>
              <div className="repo-list">
                {repos.map((r) => (
                  <button
                    key={r.repoId}
                    type="button"
                    className="repo-item"
                    disabled={connecting || busyRepo !== null}
                    onClick={() => void connect(r)}
                  >
                    <span className="name">{r.fullName}</span>
                    <span className="meta">
                      {r.private ? (
                        <span className="badge warn" title="private repo">
                          private ⚠️
                        </span>
                      ) : (
                        <span className="badge">public</span>
                      )}
                      <span className="mono">{r.defaultBranch}</span>
                      {busyRepo === r.repoId ? <span className="spinner" /> : null}
                    </span>
                  </button>
                ))}
              </div>
              {repos.some((r) => r.private) ? (
                <div className="notice warn">
                  ⚠️ Private repos bill GitHub Actions minutes at a{" "}
                  <strong>10× multiplier on macOS runners</strong>. Public repos are free.
                </div>
              ) : null}
              <p className="small faint mt">
                Missing a repo? <a href={GITHUB_APP_INSTALL_URL}>Update the app installation</a> —
                it will show up here within a few seconds.
              </p>
            </>
          )}
          {error ? <div className="notice error">{error}</div> : null}
        </div>
      </div>
    </>
  );
}

/** Step 3: poll /v1/repo/status until the connection lands. */
function Progress() {
  const status = useRepoStatus(true);
  const repo = status.data?.repo ?? null;
  const me = useMe();

  if (!repo) {
    return (
      <div className="card">
        <h2>Connecting</h2>
        <div className="card-body">
          <Spinner label="committing workflow &amp; writing secret…" />
        </div>
      </div>
    );
  }

  return (
    <>
      <StepBar step="progress" />
      <div className="card">
        <h2>Repository</h2>
        <div className="card-body">
          <div className="row between">
            <span className="mono">{repo.fullName}</span>
            <RepoStateChip state={repo.state} />
          </div>

          {repo.state === "pending_pr" ? (
            <div className="notice warn mt">
              Your default branch is protected, so RunnerBox opened a pull request with the workflow
              file.{" "}
              {repo.prUrl ? (
                <a href={repo.prUrl}>Merge this PR to finish setup</a>
              ) : (
                "Merge the open PR to finish setup"
              )}{" "}
              — this page will update automatically.
              <div className="mt">
                <Spinner label="waiting for the PR to merge…" />
              </div>
            </div>
          ) : null}

          {repo.state === "ok" ? (
            <>
              <div className="notice info mt">
                ✅ Connected. The <code>runnerbox.yml</code> workflow is on your default branch and
                the <code>RUNNERBOX_TOKEN</code> secret is set.
              </div>
              <p className="mt muted">Get a simulator from your terminal:</p>
              <div className="term">
                <span className="cmd">npm i -g runnerbox</span>
                {"\n"}
                <span className="cmd">runnerbox login</span>
                {"\n"}
                <span className="cmd">runnerbox sim</span>
              </div>
              <div className="gap mt">
                <Link to="/dashboard" className="btn primary">
                  Go to dashboard
                </Link>
              </div>
              {me.data ? <p className="small faint mt">Signed in as {me.data.login}.</p> : null}
            </>
          ) : null}

          {repo.state === "needs_repair" || repo.state === "uninstalled" ? (
            <div className="notice error mt">
              Setup hit a problem (repo state: <code>{repo.state}</code>). Try again from the
              dashboard, or re-run onboarding.
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Onboarding() {
  const status = useRepoStatus();
  const [step, setStep] = useState<Step | null>(null);

  // If a repo is already connected (e.g. user re-visited /onboarding), jump
  // straight to the progress/success step.
  useEffect(() => {
    if (step === null && status.data) {
      setStep(status.data.connected && status.data.repo ? "progress" : "install");
    }
  }, [status.data, step]);

  if (step === null) {
    return <Spinner label="loading…" />;
  }

  if (step === "progress") {
    return <Progress />;
  }

  return <InstallAndPick step={step} connecting={false} onPicked={() => setStep("progress")} />;
}

export const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: Onboarding,
});
