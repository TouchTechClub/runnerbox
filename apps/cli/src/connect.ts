import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pc from "picocolors";

export interface ConnectInfo {
  runId: string;
  tunnelUrl: string;
  daemonToken: string;
  expiresAt: number | null;
}

export function daemonBaseUrl(tunnelUrl: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/agent-device`;
}

/** Locate the agent-device binary on PATH. */
export function findAgentDevice(): string | null {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, ["agent-device"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = (res.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return first?.trim() ?? null;
}

/**
 * Persist the daemon token into agent-device's config so subsequent
 * `agent-device` commands authenticate without env vars.
 *
 * agent-device's remote-config file format isn't part of our contract, so this
 * is deliberately defensive: we only touch files that already parse as JSON
 * objects, we merge under a `runnerbox` key plus common token field names, and
 * any failure is swallowed — the printed export line is the guaranteed fallback.
 */
function persistDaemonToken(info: ConnectInfo): string | null {
  const candidates: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) candidates.push(join(xdg, "agent-device", "config.json"));
  candidates.push(join(homedir(), ".config", "agent-device", "config.json"));
  candidates.push(join(homedir(), ".agent-device", "config.json"));

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      const json = JSON.parse(raw) as Record<string, unknown>;
      if (json === null || typeof json !== "object" || Array.isArray(json)) continue;

      // Merge under a namespaced key and also set conventional top-level
      // fields if the file already uses them.
      const prev = json.runnerbox;
      json.runnerbox = {
        ...(prev && typeof prev === "object" ? (prev as object) : {}),
        daemonAuthToken: info.daemonToken,
        daemonBaseUrl: daemonBaseUrl(info.tunnelUrl),
      };
      if ("daemonAuthToken" in json) json.daemonAuthToken = info.daemonToken;
      if ("daemonBaseUrl" in json) json.daemonBaseUrl = daemonBaseUrl(info.tunnelUrl);

      writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf8");
      return path;
    } catch {
      // try next candidate
    }
  }

  // Nothing existed yet — create the XDG/default profile with just our key.
  try {
    const path =
      xdg && existsSync(xdg)
        ? join(xdg, "agent-device", "config.json")
        : join(homedir(), ".agent-device", "config.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          runnerbox: {
            daemonAuthToken: info.daemonToken,
            daemonBaseUrl: daemonBaseUrl(info.tunnelUrl),
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return path;
  } catch {
    return null;
  }
}

/**
 * Auto-connect if agent-device is installed; always print the manual fallback.
 * Output goes to stderr when `quiet` (JSON mode keeps stdout clean).
 */
export function connectFlow(info: ConnectInfo, quiet = false): void {
  const out = quiet ? process.stderr : process.stdout;
  const base = daemonBaseUrl(info.tunnelUrl);
  const bin = findAgentDevice();

  if (bin) {
    out.write(`${pc.green("▶")} Connecting via ${pc.bold("agent-device")}…\n`);
    const res = spawnSync(bin, ["connect", "proxy", "--daemon-base-url", base], {
      stdio: quiet ? ["inherit", "ignore", "inherit"] : "inherit",
      env: { ...process.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: info.daemonToken },
    });
    if (res.error || res.status !== 0) {
      out.write(
        pc.yellow("  agent-device connect failed — use the manual commands below.\n"),
      );
    } else {
      const saved = persistDaemonToken(info);
      out.write(
        saved
          ? pc.dim(`  saved daemon token to ${saved}\n`)
          : pc.dim("  could not persist token to agent-device config (see fallback below)\n"),
      );
      out.write(
        `\nNext: ${pc.cyan("agent-device open <app> --platform ios")} ${pc.dim("(or --platform android)")}\n\n`,
      );
    }
  } else {
    out.write(
      `${pc.yellow("!")} ${pc.bold("agent-device")} not found on PATH — install it, then:\n`,
    );
  }

  out.write(pc.dim("  manual connect:\n"));
  out.write(`  ${pc.cyan(`export AGENT_DEVICE_DAEMON_AUTH_TOKEN=${info.daemonToken}`)}\n`);
  out.write(`  ${pc.cyan(`agent-device connect proxy --daemon-base-url ${base}`)}\n`);
  out.write(`  ${pc.cyan("agent-device open <app> --platform ios")}\n`);
}
