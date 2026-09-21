// Build-time proof that Electron can actually start in this image.
//
// `electron --version` only prints a string; it never touches GTK or X, so it
// would pass in an image missing half the runtime libraries. This opens a real
// (hidden) BrowserWindow, which is what forces Chromium, GTK and the X
// connection to initialise — the exact thing that fails at 3am in a container
// otherwise. Any failure exits non-zero and fails the build.
const { app, BrowserWindow } = require("electron");

const fail = (why) => {
  console.error(`[smoke] FAILED: ${why}`);
  process.exit(1);
};

// Never hang the build: if Electron cannot get to `ready`, say so and stop.
const timer = setTimeout(() => fail("Electron did not become ready within 60s"), 60_000);

app.whenReady()
  .then(() => {
    const win = new BrowserWindow({ show: false, width: 640, height: 480 });
    win.destroy();
    clearTimeout(timer);
    console.log("[smoke] Electron started and created a window");
    app.exit(0);
  })
  .catch((e) => fail(e?.message || String(e)));
