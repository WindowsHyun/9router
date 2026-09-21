/**
 * Build-time proof that Playwright can drive this image's Chromium, headless.
 *
 * `chromium --version` does not answer that — it never starts the browser
 * process tree, so a missing library or a blocked syscall still passes. This
 * launches the browser the way browser-worker.ts does, opens a page and reads
 * something back from it.
 *
 * It is the headless counterpart of the Electron smoke test the launcher-based
 * image used to run, and it exists for the same reason: a broken browser should
 * fail the build with a reason, not become a CrashLoopBackOff at 3am.
 */
import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_EXECUTABLE || "/usr/bin/chromium";
const timer = setTimeout(() => {
  console.error("[smoke] timed out");
  process.exit(1);
}, 90_000);

let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    // Same reason the Electron build needed --no-sandbox: the container is
    // already an isolation boundary, and Chromium's sandbox needs privileges
    // a build layer does not have.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setContent("<title>smoke</title><h1 id=x>ok</h1>");
  const text = await page.textContent("#x");
  if (text !== "ok") throw new Error(`page returned ${JSON.stringify(text)}`);
  const version = browser.version();
  console.log(`[smoke] Playwright drove headless Chromium ${version} and read the DOM back`);
} catch (error) {
  console.error(`[smoke] FAILED with ${executablePath}: ${error.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
  await browser?.close().catch(() => {});
}
process.exit(0);
