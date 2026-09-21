export const PROD_API_URL = "https://api.runnerbox.dev";

/** Repo secret written into the user's repository; authenticates run registration. */
export const REPO_SECRET_NAME = "RUNNERBOX_TOKEN";

/** Path of the workflow file we commit to the user's repo. */
export const WORKFLOW_PATH = ".github/workflows/runnerbox.yml";

/** Local port the agent-device proxy binds on the runner (localhost only). */
export const PROXY_PORT = 4310;

/** Agent-runner lifecycle, in minutes. */
export const IDLE_EXIT_MINUTES = 15;
export const HARD_EXIT_MINUTES = 345; // 5h45m — clean cleanup before GH's 360 kill
export const HEARTBEAT_INTERVAL_SECONDS = 60;

/** Soft advisory cap on devices per run (enforced at ensure time). */
export const MAX_DEVICES_PER_RUN = 3;

/**
 * Canonical workflow committed to the user's repo.
 * Keep minimal — api_url override lives in the composite action default,
 * not here, so the committed file stays stable across environments.
 */
export const WORKFLOW_YAML = `name: runnerbox

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
          token: \${{ secrets.RUNNERBOX_TOKEN }}
`;

/** Commit message used when installing the workflow file. */
export const WORKFLOW_COMMIT_MESSAGE = "chore: add runnerbox workflow";
