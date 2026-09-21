/**
 * Static preflight on the ChatGPT Web bridge image.
 *
 *   node scripts/fork/preflight-bridge-image.mjs
 *
 * A `docker build` of this image takes minutes and needs a daemon. This takes
 * a second and needs neither, and it catches the class of mistake that
 * otherwise surfaces deep into a build or, worse, at runtime: a COPY of a file
 * that was renamed, a command nobody installed, a build check that tests a
 * configuration the runtime never uses.
 *
 * It is not a substitute for building. It is what you run before you do.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, "docker", "chatgpt-web");

const read = (p) => fs.readFileSync(path.join(DIR, p), "utf8");
const dockerfile = read("Dockerfile");
const entrypoint = read("entrypoint.sh");
const agent = read("login-agent.mjs");
const browserCheck = read("smoke/browser-check.mjs");

// Comments in these files legitimately discuss --no-sandbox and Electron, so
// the assertions below read code with comments stripped, not raw text.
const stripJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripHash = (t) => t.replace(/^\s*#.*$/gm, "");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// ── every COPY source exists ──────────────────────────────────────────────
for (const [, src] of dockerfile.matchAll(/^COPY\s+(\S+)\s+(\S+)/gm)) {
  check(`COPY ${src}`, fs.existsSync(path.join(DIR, src)), `missing ${path.join(DIR, src)}`);
}

// ── every command the runtime runs is installed ───────────────────────────
const aptBlock = dockerfile.match(/apt-get install -y --no-install-recommends([\s\S]*?)&& rm -rf/);
const packages = new Set((aptBlock?.[1] || "").replace(/\\\r?\n/g, " ").split(/\s+/).filter(Boolean));

const PROVIDED_BY = {
  Xvfb: "xvfb",
  x11vnc: "x11vnc",
  websockify: "websockify",
  xdpyinfo: "x11-utils",
  curl: "curl",
  git: "git",
  chromium: "chromium",
  tini: "tini",
};

const runtime = `${stripHash(entrypoint)}\n${stripJs(agent)}`;
for (const [cmd, pkg] of Object.entries(PROVIDED_BY)) {
  const invoked = new RegExp(`(^|[\\s"'(\`])${cmd}([\\s"'\`]|$)`, "m").test(runtime);
  if (!invoked) continue;
  check(`${cmd} is installed (${pkg})`, packages.has(pkg),
    `the runtime invokes ${cmd}, but ${pkg} is not in the apt list`);
}

// ── things that must agree across files ───────────────────────────────────
check("CHROME_EXECUTABLE points at the --no-sandbox wrapper",
  /ENV CHROME_EXECUTABLE=\/usr\/local\/bin\/chromium-container/.test(dockerfile),
  "Chromium refuses to run as root without it, and the bridge never passes it");

check("the wrapper is created before the build check runs",
  dockerfile.indexOf("chromium-container") < dockerfile.indexOf("browser-check.mjs"),
  "the check would run against a wrapper that does not exist yet");

check("the build check passes no launch arguments of its own",
  !/--no-sandbox/.test(stripJs(browserCheck)),
  "supplying the flag there makes the check pass on an image whose browser cannot start");

check("the build check exercises headful too, on a display",
  /DISPLAY=:98 bun \/opt\/smoke\/browser-check\.mjs/.test(dockerfile) && /Xvfb :98/.test(dockerfile),
  "headful is the default mode, so a headless-only check proves the wrong thing");

check("the display starts before the bridge that needs it",
  stripHash(entrypoint).indexOf("Xvfb ") < stripHash(entrypoint).indexOf("cli.ts"),
  "serve would start without a display in headed mode");

check("login-agent reuses an existing display",
  /if \(await displayReady\(\)\)/.test(agent),
  "a second X server on the same DISPLAY would fail to bind, and its teardown would kill the bridge's own browser");

check("tini is the entrypoint",
  /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/entrypoint\.sh"\]/.test(dockerfile), "");

check("no Electron is installed, downloaded or executed",
  !/electron/i.test(stripHash(dockerfile)) && !/electron/i.test(stripHash(entrypoint)),
  "a leftover Electron instruction would fail the build or the boot");

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
