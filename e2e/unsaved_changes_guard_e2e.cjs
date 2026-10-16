// Unsaved work must not go without a question: the window's own close, and the
// welcome screen's recent-files list.
//
// GitHub #61: closing the window (the titlebar X, Alt+F4, the window manager's
// close) quit at once with unsaved changes. Nothing listened for Tauri's
// close-requested event, and Tauri holds a close ONLY when the webview has such
// a listener (tauri-2.11.5 manager/window.rs: has_js_listener, Window or
// WebviewWindow targets only), so the window was destroyed in the same turn.
// The 30 s autosave is no net: it is never flushed at close.
//
// The close cannot happen in a browser, so this boots the REAL app bundle with a
// fake Tauri IPC floor installed before any app script runs. The floor models
// the two pieces of the shell the fix depends on, read from the crate: a close
// request is held and dispatched only when a Window-targeted listener exists,
// else the window is destroyed; and plugin:window|destroy is refused unless the
// capability file grants core:window:allow-destroy (read from
// src-tauri/capabilities/default.json). The X is the real button
// (mountWindowControls only mounts it under Tauri), the prompt is the real
// choose() modal, and the engine behind it is the real sidecar.
//
// What it cannot prove: that the compiled shell's ACL matches the JSON, and
// that the native WM close reaches the same event. Those stay manual.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/unsaved_changes_guard_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));
const CAPS = JSON.parse(fs.readFileSync(path.join(__dirname, "../src-tauri/capabilities/default.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, "../locales/en.json"), "utf8"));

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

const BOX = { version: 5, units: "mm", parameters: {},
  features: [{ id: "f1", type: "box", length: 50, width: 50, height: 20 }] };

/** Runs in the page before any app script: the fake shell. */
function installFloor({ token, permissions }) {
  const allowed = new Set(permissions.filter((p) => typeof p === "string"));
  const floor = {
    log: [], // every command, in order
    listeners: new Map(), // event id -> { event, target, handler }
    callbacks: new Map(),
    destroyed: null, // null | "destroy" | "closed-without-asking"
    slots: new Map(), files: new Map(),
    savePath: null, failSave: false, nextId: 1,
  };
  /** What tauri does with a close request (manager/window.rs): hold it and
   *  tell the webview only if a listener targets THIS window; else destroy. */
  floor.requestClose = () => {
    const held = [...floor.listeners.entries()].filter(([, l]) =>
      l.event === "tauri://close-requested"
      && (l.target.kind === "Window" || l.target.kind === "WebviewWindow") && l.target.label === "main");
    if (!held.length) { floor.destroyed = "closed-without-asking"; return null; }
    return Promise.all(held.map(([id, l]) =>
      floor.callbacks.get(l.handler)({ event: "tauri://close-requested", id, payload: null })));
  };
  window.__floor = floor;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) { const id = floor.nextId++; floor.callbacks.set(id, cb); return id; },
    unregisterCallback(id) { floor.callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      floor.log.push(cmd === "recovery_clear" || cmd === "recovery_write" ? `${cmd}:${args.slot}` : cmd);
      switch (cmd) {
        case "sidecar_token": return token;
        case "plugin:event|listen": {
          const id = floor.nextId++;
          floor.listeners.set(id, { event: args.event, target: args.target, handler: args.handler });
          return id;
        }
        case "plugin:event|unlisten": floor.listeners.delete(args.eventId); return null;
        case "plugin:window|close":
          if (!allowed.has("core:window:allow-close")) throw new Error("close not allowed");
          floor.requestClose();
          return null;
        case "plugin:window|destroy":
          if (!allowed.has("core:window:allow-destroy")) throw new Error("window.destroy not allowed");
          floor.destroyed = "destroy";
          return null;
        case "plugin:window|is_maximized": return false;
        case "recovery_list": return [...floor.slots.keys()].map((s) => [s, 1]);
        case "recovery_read": return floor.slots.get(args.slot) ?? null;
        case "recovery_write": floor.slots.set(args.slot, args.json); return null;
        case "recovery_clear": floor.slots.delete(args.slot); return null;
        case "container_save":
          if (floor.failSave) throw new Error("disk full");
          floor.files.set(args.path, args.documentJson);
          return null;
        case "container_is_container": return true;
        case "container_open":
          if (!floor.files.has(args.path)) throw new Error("no such file");
          return floor.files.get(args.path);
        case "plugin:dialog|save": return floor.savePath;
        case "plugin:dialog|message": return null;
        case "ta_ping": return false; // TinkerAtlas offline; the welcome asks
        default: throw new Error(`fake shell: ${cmd} not modelled`);
      }
    },
  };
}

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(installFloor, { token: TOKEN, permissions: CAPS.permissions });
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // the startup welcome
  await page.waitForTimeout(400);
  await page.waitForFunction(
    () => document.getElementById("status")?.className.includes("connected"),
    null, { timeout: 60000 },
  ).catch(() => console.log("  (warning: the geometry engine never reported connected)"));

  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const settle = async (act) => {
    const before = await page.evaluate(() => window.__settles);
    if (act) await act();
    await page.waitForFunction(
      (b) => window.__settles > b && !window.__sindri.store.buildState.building,
      before, { timeout: 120000 },
    ).catch(() => console.log("  (warning: no rebuild settled within the timeout)"));
  };

  const state = () => page.evaluate(() => ({
    destroyed: window.__floor.destroyed,
    dirty: window.__sindri.store.dirty,
    path: window.__sindri.store.filePath,
    features: window.__sindri.store.document.features.map((f) => f.id),
    prompts: document.querySelectorAll(".choice-backdrop").length,
    title: document.querySelector(".choice-backdrop .choice-title")?.textContent ?? null,
    buttons: [...document.querySelectorAll(".choice-backdrop .choice-btn > span")].map((s) => s.textContent),
    log: window.__floor.log.slice(),
  }));
  /** A fresh dirty, untitled document, and a clean slate in the fake shell. */
  const dirtyDocument = async () => {
    await settle(() => page.evaluate((d) => {
      window.__sindri.store.loadDocument(d);
      Object.assign(window.__floor, { destroyed: null, log: [], savePath: null, failSave: false });
    }, BOX));
  };
  const clickClose = () => page.click(".win-close");
  const answer = async (label) => {
    await page.locator(".choice-backdrop .choice-btn", { hasText: label }).click({ timeout: 3000 })
      .catch(() => check(false, `there is a ${label} button to press`));
    await page.waitForTimeout(300);
  };
  const quitTitle = EN.file.close.confirmQuit;
  const L = { save: EN.file.close.save, discard: EN.common.discard, cancel: EN.common.cancel };

  console.log("\n=== a listener is registered for THIS window, so the shell holds the close ===");
  const targets = await page.evaluate(() => [...window.__floor.listeners.values()]
    .filter((l) => l.event === "tauri://close-requested").map((l) => l.target));
  check(targets.length === 1 && targets[0].kind === "Window" && targets[0].label === "main",
    "one close-requested listener, targeted at the main window", JSON.stringify(targets));

  console.log("\n=== a clean document closes at once ===");
  await settle(() => page.evaluate(() => { window.__sindri.store.newDocument(); window.__floor.destroyed = null; }));
  await clickClose();
  await page.waitForTimeout(400);
  let s = await state();
  check(s.prompts === 0, "no prompt");
  check(s.destroyed === "destroy", "the window is destroyed (and the capability allows it)", String(s.destroyed));

  console.log("\n=== dirty: the X asks, and Esc keeps the app working ===");
  await dirtyDocument();
  await clickClose();
  await page.waitForTimeout(400);
  s = await state();
  check(s.destroyed === null, "the window is still there", String(s.destroyed));
  check(s.prompts === 1 && s.title === quitTitle, "the prompt asks to save before closing", `${s.prompts} ${s.title}`);
  check(JSON.stringify(s.buttons) === JSON.stringify([L.save, L.discard, L.cancel]),
    "Save, Discard and Cancel, Save first (Enter)", JSON.stringify(s.buttons));
  // Alt+F4 / the WM close while the prompt is up: the same event again
  await page.evaluate(() => { window.__floor.requestClose(); }); // not awaited: it settles once answered
  await page.waitForTimeout(300);
  s = await state();
  check(s.prompts === 1 && s.destroyed === null, "a second close request while it asks is swallowed",
    `${s.prompts} ${s.destroyed}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  s = await state();
  check(s.prompts === 0 && s.destroyed === null && s.dirty, "Esc: prompt gone, window kept, work still unsaved",
    `${s.prompts} ${s.destroyed} ${s.dirty}`);
  await settle(() => page.evaluate(() => window.__sindri.store.addFeature(
    { id: "f2", type: "box", length: 10, width: 10, height: 60 })));
  const bodies = await page.evaluate(() => window.__sindri.store.buildState.result?.bodies?.length ?? 0);
  check(bodies >= 1, "and the geometry engine still builds", `bodies=${bodies}`);

  console.log("\n=== the window manager's close (Alt+F4) reaches the same prompt; Cancel keeps it ===");
  await dirtyDocument();
  await page.evaluate(() => { window.__floor.requestClose(); }); // not awaited: it settles once answered
  await page.waitForTimeout(400);
  s = await state();
  check(s.prompts === 1 && s.title === quitTitle, "the prompt is up", `${s.prompts} ${s.title}`);
  await answer(L.cancel);
  s = await state();
  check(s.prompts === 0 && s.destroyed === null && s.dirty, "Cancel: window kept, work still unsaved",
    `${s.prompts} ${s.destroyed} ${s.dirty}`);

  console.log("\n=== Save on an untitled document, Save As cancelled: the app stays ===");
  await dirtyDocument();
  await clickClose();
  await page.waitForTimeout(300);
  await answer(L.save);
  s = await state();
  check(s.destroyed === null && s.dirty, "window kept, work still unsaved", `${s.destroyed} ${s.dirty}`);
  check(s.log.includes("plugin:dialog|save") && !s.log.includes("container_save"),
    "the Save As dialog was shown and nothing written", JSON.stringify(s.log));

  console.log("\n=== Save fails on disk: the app stays, and the next close asks again ===");
  await dirtyDocument();
  await page.evaluate(() => Object.assign(window.__floor, { savePath: "/home/me/part.sindri", failSave: true }));
  await clickClose();
  await page.waitForTimeout(300);
  await answer(L.save);
  s = await state();
  check(s.destroyed === null && s.dirty, "window kept, work still unsaved", `${s.destroyed} ${s.dirty}`);
  check(s.log.includes("plugin:dialog|message"), "and the failure was reported");
  await page.evaluate(() => { window.__floor.failSave = false; });
  await clickClose();
  await page.waitForTimeout(300);
  s = await state();
  check(s.prompts === 1, "the next close asks again", String(s.prompts));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  console.log("\n=== Save with a path: written, recovery cleared, THEN closed ===");
  await dirtyDocument();
  await page.evaluate(() => {
    window.__floor.savePath = "/home/me/part.sindri";
    window.__floor.slots.set("untitled", "{}"); // the autosave had run
  });
  await clickClose();
  await page.waitForTimeout(300);
  await answer(L.save);
  await page.waitForTimeout(300);
  s = await state();
  const at = (c) => s.log.indexOf(c);
  const saved = await page.evaluate(() => window.__floor.files.get("/home/me/part.sindri") ?? null);
  check(!!saved && JSON.parse(saved).features.map((f) => f.id).join() === "f1", "the document was written");
  check(s.destroyed === "destroy", "the window closed", String(s.destroyed));
  // the next launch must not offer to recover a document that was just saved
  check(at("container_save") >= 0 && at("recovery_clear:untitled") > at("container_save")
    && at("plugin:window|destroy") > at("recovery_clear:untitled"),
    "the recovery slots are cleared before the window goes", JSON.stringify(s.log));
  const left = await page.evaluate(() => [...window.__floor.slots.keys()]);
  check(left.length === 0, "nothing is left to recover", JSON.stringify(left));

  console.log("\n=== Discard: recovery cleared, then closed ===");
  await dirtyDocument();
  await page.evaluate(() => window.__floor.slots.set("untitled", "{}"));
  await clickClose();
  await page.waitForTimeout(300);
  await answer(L.discard);
  s = await state();
  check(s.destroyed === "destroy", "the window closed", String(s.destroyed));
  check(s.log.indexOf("recovery_clear:untitled") >= 0
    && s.log.indexOf("plugin:window|destroy") > s.log.indexOf("recovery_clear:untitled"),
    "the slot was cleared before the window went", JSON.stringify(s.log));

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
