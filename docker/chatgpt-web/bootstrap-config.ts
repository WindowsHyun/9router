/**
 * Write the bridge's config.json for headless operation, using the bridge's
 * own defaultConfig() and saveConfig() rather than hand-rolled JSON — so the
 * schema stays whatever upstream says it is, and their validation runs on it.
 *
 * Why not `codex-chatgpt-web setup`: prepareSetup() throws off macOS for this
 * browser host —
 *
 *   const launcherOwned = config.browserHost === "launcher";
 *   if (!launcherOwned && process.platform !== "darwin") throw new Error(
 *     "Terminal-only managed Chrome setup currently requires macOS. ...")
 *
 * — and that gate lives only in the setup path. `serve` is loadConfig() plus
 * startServer(), with no platform check, so a valid config.json is all it
 * needs. This writes one.
 *
 * Also migrates a config left behind by the previous, launcher-based image:
 * browserHost "launcher" points at an Electron descriptor that no longer
 * exists here, and would fail at the first request.
 */
import { existsSync, readFileSync } from "node:fs";

// Resolved at runtime rather than imported by a fixed absolute path, so this
// can be run against a checkout outside the image to check what it produces.
const BRIDGE_ROOT = (process.env.BRIDGE_ROOT || "/opt/codex-chatgpt-web").replace(/\\/g, "/");
const {
  defaultConfig,
  getConfigPath,
  runtimeCommandForProcess,
  saveConfig,
} = await import(`${BRIDGE_ROOT}/src/config`);

type AppConfig = Awaited<ReturnType<typeof defaultConfig>> extends infer T ? T : never;

const CLI_ENTRY = `${BRIDGE_ROOT}/src/cli.ts`;
const chromePath = (process.env.CHROME_EXECUTABLE || "/usr/bin/chromium").trim();
const port = Number(process.env.BRIDGE_PORT || 17841);

if (!existsSync(chromePath)) {
  throw new Error(`Chromium is not at ${chromePath}. Set CHROME_EXECUTABLE.`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`BRIDGE_PORT is not a valid port: ${process.env.BRIDGE_PORT}`);
}

/** The shape this image runs, applied to a fresh or an inherited config. */
function headless(config: AppConfig): AppConfig {
  return {
    ...config,
    browserHost: "managed-chrome",
    // The whole point: no display in steady state.
    headed: false,
    chromeExecutablePath: chromePath,
    port,
    // Derived through their own helper so it gets their durability checks
    // (absolute, not under a temp root, actually exists). Building it here
    // rather than letting currentRuntimeCommand() infer it, because that reads
    // Bun.main — which during this script is this script, not the CLI.
    runtimeCommand: runtimeCommandForProcess({
      executable: process.execPath,
      entry: CLI_ENTRY,
    }),
  };
}

const configPath = getConfigPath();
let next: AppConfig;
let action: string;

if (existsSync(configPath)) {
  // Read raw rather than loadConfig(): an inherited launcher config can fail
  // their validation (it requires browserHostDescriptorPath), and refusing to
  // start on a config we are about to replace would be perverse.
  const existing = JSON.parse(readFileSync(configPath, "utf8")) as AppConfig;
  const wasLauncher = existing.browserHost === "launcher";
  next = headless(existing);
  // A launcher config carries a descriptor path that means nothing here, and
  // their parser rejects the field when the host is not "launcher".
  delete (next as { browserHostDescriptorPath?: string }).browserHostDescriptorPath;
  action = wasLauncher
    ? "migrated from the launcher browser host (a new ChatGPT sign-in is required)"
    : "updated";
} else {
  next = headless(defaultConfig("browser-only"));
  action = "created";
}

saveConfig(next);
process.stdout.write(
  `[bootstrap] config ${action}: ${configPath}\n`
  + `[bootstrap]   browserHost=${next.browserHost} headed=${next.headed} port=${next.port}\n`
  + `[bootstrap]   chrome=${next.chromeExecutablePath}\n`
  + `[bootstrap]   storageState=${next.storageStatePath}\n`,
);
