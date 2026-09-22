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
const agent = read("session-agent.mjs");
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

// The reason the VNC stack could go at all: the bridge is signed in over
// HTTP, not by a human sitting at a remote desktop.
check("the session agent verifies a session instead of serving a desktop",
  /detectChatGptAccountCapabilities/.test(stripJs(agent))
    && !/x11vnc|websockify|noVNC/i.test(stripJs(agent)),
  "session-agent must verify the pasted session with the bridge's own browser, and start no desktop");

// Upstream's own verifier waits for a textbox whose accessible name is the
// English "Chat with ChatGPT", which no non-English account has — a Korean one
// is labelled "ChatGPT와 채팅", so a working session was reported as rejected.
// The agent must use the locale-independent selector the bridge exports.
check("the session agent does not depend on an English UI",
  /CHATGPT_COMPOSER_SELECTOR/.test(stripJs(agent))
    && !/Chat with ChatGPT/.test(stripJs(agent)),
  "verification must locate the composer by selector, not by its English accessible name");

check("no VNC tooling is installed at all",
  !/x11vnc|novnc|websockify/i.test(stripHash(dockerfile)),
  "signing in does not happen in the container any more, so nothing should be listening for a viewer");

check("both internal ports are exposed for the router",
  /EXPOSE 17841 17842/.test(dockerfile), "");

check("tini is the entrypoint",
  /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/entrypoint\.sh"\]/.test(dockerfile), "");

check("no Electron is installed, downloaded or executed",
  !/electron/i.test(stripHash(dockerfile)) && !/electron/i.test(stripHash(entrypoint)),
  "a leftover Electron instruction would fail the build or the boot");

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
