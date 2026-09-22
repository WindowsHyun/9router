/**
 * Build-time proof that Playwright can actually drive this image's browser.
 *
 * `chromium --version` does not answer that: it never starts the browser
 * process tree, so a missing library, a blocked syscall, or a refusal to run
 * as root all still pass it. This launches the browser exactly the way
 * browser-worker.ts does — executablePath and headless, **no other arguments**
 * — opens a page, and reads something back out of it.
 *
 * The missing arguments are the point. The bridge passes no --no-sandbox
 * anywhere on the Linux path, and this image runs as root, which Chromium
 * refuses. The flag therefore lives in the chromium-container wrapper that
 * CHROME_EXECUTABLE points at, and this check only passes if that wrapper
 * works. An earlier version passed --no-sandbox itself and would have gone
 * green on an image whose browser could not start at all.
 *
 * Both modes are checked, because both ship: headful on a display is the
 * default, headless is BRIDGE_HEADLESS=1.
 */
import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_EXECUTABLE || "/usr/bin/chromium";
const display = process.env.DISPLAY;

async function drive(label, headless) {
  const browser = await chromium.launch({ executablePath, headless });
  try {
    const page = await browser.newPage();
    await page.setContent("<title>check</title><h1 id=x>ok</h1>");
    const text = await page.textContent("#x");
    if (text !== "ok") throw new Error(`page returned ${JSON.stringify(text)}`);
    console.log(`[check] ${label}: drove Chromium ${browser.version()} and read the DOM back`);
  } finally {
    await browser.close().catch(() => {});
  }
}

const timer = setTimeout(() => {
  console.error("[check] timed out");
  process.exit(1);
}, 120_000);

try {
  await drive("headless", true);
  if (display) {
    await drive(`headful on ${display}`, false);
  } else {
    // Not fatal at build time, but it means the default mode is unproven.
    console.warn("[check] no DISPLAY — headful mode, which is the default, was NOT checked");
  }
} catch (error) {
  console.error(`[check] FAILED with ${executablePath}: ${error.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
process.exit(0);
