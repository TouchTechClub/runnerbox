/**
 * runnerbox-agent — boots agent-device proxy + cloudflared quick tunnel on a
 * GitHub Actions macOS runner, registers with the runnerbox API, then
 * supervises until idle/hard-exit/token-revocation.
 *
 * Exit codes: 0 = clean shutdown (green check), 1 = failure (red X).
 */
import { randomBytes } from "node:crypto";
import {
  HARD_EXIT_MINUTES,
  HEARTBEAT_INTERVAL_SECONDS,
  IDLE_EXIT_MINUTES,
  PROD_API_URL,
  PROXY_PORT,
} from "@runnerbox/shared";
import type { RunRegisterRequest } from "@runnerbox/shared";
import { PINS } from "./pins.js";
import pkg from "../package.json" with { type: "json" };
import { addMask, error, info, warn } from "./log.js";
import { pumpLines, run, setSecretFilter } from "./proc.js";
import type { ChildProc } from "./proc.js";
import { installAgentDevice, installCloudflared, prepareAndroid } from "./provision.js";
import { ApiClient, HttpError } from "./api.js";
import { countActiveDevices } from "./devices.js";

const TUNNEL_URL_TIMEOUT_MS = 60_000;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTER_ATTEMPTS = 3;
const HEARTBEAT_FAILURE_LIMIT = 3;

// ---------------------------------------------------------------------------
// Shared run state (module-level so provision/supervise/shutdown all see it)
// ---------------------------------------------------------------------------

interface ManagedChild {
  name: string;
  proc: ChildProc;
  restarts: number;
  dead: boolean;
}

const state = {
  apiUrl: Bun.env.RUNNERBOX_API_URL ?? PROD_API_URL,
  token: Bun.env.RUNNERBOX_TOKEN ?? "",
  ghRunId: 0,
  ghRunAttempt: Bun.env.GITHUB_RUN_ATTEMPT ?? "?",
  daemonToken: "",
  tunnelUrl: "",
  agentDeviceBin: "",
  cloudflaredBin: "",
  androidReady: false,
  registered: false,
  shuttingDown: false,
  bootedAt: Date.now(),
  children: {} as { proxy?: ManagedChild; tunnel?: ManagedChild },
  wake: null as (() => void) | null,
};

function notifyWake(): void {
  const w = state.wake;
  state.wake = null;
  w?.();
}

/** Sleep `ms`, waking early if a supervised child exits. */
async function interruptibleSleep(ms: number): Promise<void> {
  let woke = false;
  const wokeP = new Promise<void>((resolve) => {
    state.wake = () => {
      woke = true;
      resolve();
    };
  });
  await Promise.race([Bun.sleep(ms), wokeP]);
  if (!woke) state.wake = null;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

function track(name: string, proc: ChildProc): ManagedChild {
  const child: ManagedChild = { name, proc, restarts: 0, dead: false };
  proc.exited
    .then((code) => {
      child.dead = true;
      if (!state.shuttingDown) {
        warn(`${name} exited unexpectedly (code ${code})`);
        notifyWake();
      }
    })
    .catch(() => {
      child.dead = true;
    });
  return child;
}

function spawnProxy(): ManagedChild {
  const proc = Bun.spawn(
    [
      state.agentDeviceBin,
      "proxy",
      "--port",
      String(PROXY_PORT),
      "--host",
      "127.0.0.1",
      "--daemon-auth-token",
      state.daemonToken,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const child = track("agent-device proxy", proc);
  pumpLines(proc.stdout, "agent-device");
  pumpLines(proc.stderr, "agent-device");
  return child;
}

interface TunnelSpawn {
  child: ManagedChild;
  url: Promise<string>;
}

function spawnTunnel(): TunnelSpawn {
  const proc = Bun.spawn(
    [state.cloudflaredBin, "tunnel", "--url", `http://127.0.0.1:${PROXY_PORT}`, "--no-autoupdate"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const child = track("cloudflared", proc);

  // The trycloudflare URL is printed on stderr once the tunnel is up.
  let settled = false;
  const url = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`no trycloudflare URL within ${TUNNEL_URL_TIMEOUT_MS / 1000}s`));
      }
    }, TUNNEL_URL_TIMEOUT_MS);
    pumpLines(proc.stderr, "cloudflared", (line) => {
      const m = TUNNEL_URL_RE.exec(line);
      if (m && !settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(m[0]);
      }
    });
    proc.exited.then((code) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`cloudflared exited (code ${code}) before tunnel URL`));
      }
    });
  });
  pumpLines(proc.stdout, "cloudflared");
  return { child, url };
}

// ---------------------------------------------------------------------------
// API calls with their retry/fatal policies
// ---------------------------------------------------------------------------

const api = () => new ApiClient(state.apiUrl, state.token);

function isRetriable(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.status >= 400 && err.status < 500) return false; // 4xx = fatal
    return true; // 5xx retriable
  }
  return true; // network errors retriable
}

async function register(): Promise<void> {
  const body: RunRegisterRequest = {
    ghRunId: state.ghRunId,
    tunnelUrl: state.tunnelUrl,
    daemonToken: state.daemonToken,
    versions: {
      agent: pkg.version,
      agentDevice: PINS.agentDevice,
      cloudflared: PINS.cloudflared,
    },
  };
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    try {
      await api().register(body);
      state.registered = true;
      info(`registered run ${state.ghRunId} (attempt ${attempt})`);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetriable(err)) {
        error(`registration rejected (${String(err)}) — exiting`);
        throw err;
      }
      warn(`register attempt ${attempt}/${REGISTER_ATTEMPTS} failed: ${String(err).slice(0, 200)}`);
      if (attempt < REGISTER_ATTEMPTS) await Bun.sleep(1000 * attempt);
    }
  }
  error(`registration failed after ${REGISTER_ATTEMPTS} attempts: ${String(lastErr)}`);
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

async function killChildren(): Promise<void> {
  const kids = [state.children.proxy, state.children.tunnel].filter(
    (c): c is ManagedChild => !!c,
  );
  for (const c of kids) {
    if (c.dead) continue;
    try {
      c.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Give them a moment, then SIGKILL stragglers.
  await Promise.race([
    Promise.allSettled(kids.filter((c) => !c.dead).map((c) => c.proc.exited)),
    Bun.sleep(3000),
  ]);
  for (const c of kids) {
    if (c.dead) continue;
    try {
      c.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function shutdown(reason: string, code: number): Promise<never> {
  if (state.shuttingDown) process.exit(code);
  state.shuttingDown = true;
  info(`shutting down: ${reason}`);
  if (state.registered) {
    try {
      await api().deregister({ ghRunId: state.ghRunId, reason });
    } catch (err) {
      warn(`deregister failed (continuing shutdown): ${String(err).slice(0, 200)}`);
    }
  }
  await killChildren();
  info(`goodbye (exit ${code})`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Supervision loop
// ---------------------------------------------------------------------------

/** Restart a dead child once; second death is fatal. Returns false if fatal. */
async function handleDeadChildren(): Promise<boolean> {
  if (state.children.proxy?.dead) {
    const c = state.children.proxy;
    if (c.restarts >= 1) {
      error("agent-device proxy died twice — exiting");
      return false;
    }
    warn("restarting agent-device proxy");
    state.children.proxy = spawnProxy();
    state.children.proxy.restarts = c.restarts + 1;
  }
  if (state.children.tunnel?.dead) {
    const c = state.children.tunnel;
    if (c.restarts >= 1) {
      error("cloudflared died twice — exiting");
      return false;
    }
    warn("restarting cloudflared (new tunnel URL)");
    const t = spawnTunnel();
    state.children.tunnel = t.child;
    t.child.restarts = c.restarts + 1;
    try {
      const newUrl = await t.url;
      addMask(newUrl);
      state.tunnelUrl = newUrl;
      // URL changed → re-register so the API hands out the fresh tunnel.
      await register();
      info("tunnel re-registered with new URL");
    } catch (err) {
      error(`tunnel restart failed: ${String(err).slice(0, 300)}`);
      return false;
    }
  }
  return true;
}

async function supervise(): Promise<never> {
  let heartbeatFailures = 0;
  let lastDeviceSeenAt = Date.now(); // idle clock starts at boot
  for (;;) {
    await interruptibleSleep(HEARTBEAT_INTERVAL_SECONDS * 1000);

    // --- children ---
    const childrenOk = await handleDeadChildren();
    if (!childrenOk) await shutdown("child process died twice", 1);

    // --- device count ---
    const activeDevices = await countActiveDevices();
    if (activeDevices > 0) lastDeviceSeenAt = Date.now();

    // --- exits (checked before heartbeat so a dead run doesn't beat one more time) ---
    const uptimeMin = (Date.now() - state.bootedAt) / 60_000;
    if (uptimeMin >= HARD_EXIT_MINUTES) {
      await shutdown(`hard exit after ${HARD_EXIT_MINUTES} minutes`, 0);
    }
    const idleMin = (Date.now() - lastDeviceSeenAt) / 60_000;
    if (idleMin >= IDLE_EXIT_MINUTES) {
      await shutdown(`idle exit — no active devices for ${IDLE_EXIT_MINUTES} minutes`, 0);
    }

    // --- heartbeat ---
    try {
      await api().heartbeat({
        ghRunId: state.ghRunId,
        activeDevices,
        androidReady: state.androidReady,
      });
      heartbeatFailures = 0;
      info(
        `heartbeat ok — devices=${activeDevices} android=${state.androidReady} ` +
          `idle=${idleMin.toFixed(1)}m up=${uptimeMin.toFixed(1)}m`,
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        error("heartbeat unauthorized — RUNNERBOX_TOKEN revoked, exiting");
        await shutdown("token revoked", 1);
      }
      heartbeatFailures++;
      warn(`heartbeat failed (${heartbeatFailures}/${HEARTBEAT_FAILURE_LIMIT}): ${String(err).slice(0, 200)}`);
      if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) {
        error("too many consecutive heartbeat failures — exiting");
        await shutdown("heartbeat failures", 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Env
  if (!state.token) {
    error("RUNNERBOX_TOKEN is required (repo secret). Set it in the workflow's `with: token:`.");
    process.exit(1);
  }
  if (!Bun.env.GITHUB_RUN_ID || Number.isNaN(Number(Bun.env.GITHUB_RUN_ID))) {
    error("GITHUB_RUN_ID missing or invalid — this agent must run inside GitHub Actions.");
    process.exit(1);
  }
  state.ghRunId = Number(Bun.env.GITHUB_RUN_ID);
  addMask(state.token); // belt-and-braces; GH already masks repo secrets

  // Register signal handlers early so a SIGTERM during provisioning still
  // cleans up children instead of orphaning them.
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));

  info(
    `runnerbox-agent v${pkg.version} — run ${state.ghRunId} (attempt ${state.ghRunAttempt}), api ${state.apiUrl}`,
  );

  // 2. Provision: agent-device + cloudflared in parallel; Android prep runs
  // fully in the background and must never block iOS bring-up (it handles all
  // its own errors internally).
  void prepareAndroid(() => {
    state.androidReady = true;
  });
  const [agentDeviceBin, cloudflaredBin] = await Promise.all([
    installAgentDevice(),
    installCloudflared(),
  ]);
  state.agentDeviceBin = agentDeviceBin;
  state.cloudflaredBin = cloudflaredBin;

  // 3. daemon token — mask before any use.
  state.daemonToken = randomBytes(32).toString("hex");
  addMask(state.daemonToken);
  // Filter by URL *pattern* (not just the known value) so the very stderr line
  // the URL is parsed from is never relayed to the log.
  setSecretFilter(
    (line) => line.includes(state.daemonToken) || TUNNEL_URL_RE.test(line),
  );

  // 4. agent-device proxy
  state.children.proxy = spawnProxy();
  info(`agent-device proxy on 127.0.0.1:${PROXY_PORT} (pid ${state.children.proxy.proc.pid})`);

  // 5. cloudflared quick tunnel — wait for the URL.
  const tunnel = spawnTunnel();
  state.children.tunnel = tunnel.child;
  try {
    state.tunnelUrl = await tunnel.url;
  } catch (err) {
    error(`tunnel never came up: ${String(err).slice(0, 300)}`);
    await shutdown("no tunnel URL", 1);
  }
  addMask(state.tunnelUrl);
  info("tunnel up (url registered + masked)");

  // 6. Register
  await register().catch(async (err) => {
    await shutdown(`registration failed: ${String(err).slice(0, 200)}`, 1);
    throw err; // unreachable, keeps types happy
  });

  // 7. Supervision
  await supervise();
}

main().catch(async (err) => {
  error(`fatal: ${String(err).slice(0, 500)}`);
  await shutdown("fatal boot error", 1);
});
