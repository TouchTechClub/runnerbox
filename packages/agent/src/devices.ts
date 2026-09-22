/**
 * Booted-device counting for heartbeat `active_devices`:
 * iOS via `xcrun simctl list devices booted -j`, Android via `adb devices`.
 * Everything is wrapped — failures count as zero, never crash the loop.
 */
import { run } from "./proc.js";

interface SimctlList {
  devices?: Record<string, Array<{ state?: string; availabilityError?: string }>>;
}

async function countBootedSims(): Promise<number> {
  const res = await run(["xcrun", "simctl", "list", "devices", "booted", "-j"], {
    timeoutMs: 15_000,
  });
  if (res.code !== 0) return 0;
  let parsed: SimctlList;
  try {
    parsed = JSON.parse(res.stdout) as SimctlList;
  } catch {
    return 0;
  }
  let n = 0;
  for (const devices of Object.values(parsed.devices ?? {})) {
    for (const d of devices) {
      if (d.state === "Booted" && d.availabilityError === undefined) n++;
    }
  }
  return n;
}

async function countEmulators(): Promise<number> {
  const res = await run(["adb", "devices"], { timeoutMs: 10_000 });
  if (res.code !== 0) return 0;
  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // First line is "List of devices attached"; entries look like
  // "emulator-5554\tdevice". Anything not a ready "device" state is excluded.
  return lines.slice(1).filter((l) => l.endsWith("\tdevice")).length;
}

export async function countActiveDevices(): Promise<number> {
  try {
    const [sims, emus] = await Promise.all([countBootedSims(), countEmulators()]);
    return sims + emus;
  } catch {
    return 0;
  }
}
