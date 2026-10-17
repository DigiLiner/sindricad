// The funding pill, its panel and the welcome card, in a real browser.
//
// Unit tests (src/ui/funding.test.ts) cover the content, the warning window and
// every bad payload against a fake DOM; what only a real engine can show is the
// layout: that the pill appearing moves nothing else in the title bar, that the
// panel lands under it (or in the corner when it is hidden), that the buttons
// reach the opener, and that keyboard focus goes where it should.
//
// The feature only exists under Tauri (Rust fetches the goal), so this boots the
// real app bundle with a fake IPC floor that answers `ta_funding_goal` and
// records `plugin:opener|open_url`; every other command answers null. The
// sidecar is optional: without it the status pill just says "connecting".
//
// Usage (from the repo root), with vite on 5173:
//   SC_TOKEN=<sidecar token> node e2e/funding_pill_e2e.cjs
// SC_URL / SC_CHROME as in the other specs. SC_SHOTS=<dir> also saves
// screenshots of the welcome card, the pill and the panel at 1400x900.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "e2etok";
const URL = process.env.SC_URL || "http://localhost:5173";
const SHOTS = process.env.SC_SHOTS || "";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

const LIVE = { goal: 335, current: 147, percentage: 44, reset_day: 20 };
const FUNDED = { goal: 335, current: 401, percentage: 100, reset_day: 20 };

/** Runs in the page before any app script. */
function installFloor({ token, answer, hold }) {
  const floor = { log: [], opened: [], nextId: 1, callbacks: new Map() };
  // `hold`: the goal is not answered until the test calls __floor.release(), so
  // the title bar can be measured once the engine status has settled (its text
  // changes width as it connects) and THEN with the pill.
  floor.gate = hold ? new Promise((r) => { floor.release = r; }) : Promise.resolve();
  window.__floor = floor;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) { const id = floor.nextId++; floor.callbacks.set(id, cb); return id; },
    unregisterCallback(id) { floor.callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      floor.log.push(cmd);
      switch (cmd) {
        case "sidecar_token": return token;
        case "ta_funding_goal": await floor.gate; return answer;
        case "plugin:opener|open_url": floor.opened.push(args.url); return null;
        case "plugin:event|listen": return floor.nextId++;
        case "plugin:window|is_maximized": return false;
        case "recovery_list": return [];
        case "ta_ping": return false; // the welcome's remote pane shows its offline box
        default: return null;
      }
    },
  };
}

async function boot(browser, answer, { welcome = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(installFloor, { token: TOKEN, answer, hold: true });
  await page.addInitScript((w) => {
    localStorage.setItem("sindri.welcomeOnStartup", w ? "true" : "false");
  }, welcome);
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  return page;
}

const shot = async (page, name, clip) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), ...(clip ? { clip } : {}) });
  console.log(`  shot ${path.join(SHOTS, name)}`);
};

/** Left edges of everything right of the spacer that was there before the pill. */
const titlebarLayout = (page) => page.evaluate(() => {
  const x = (sel) => document.querySelector(sel)?.getBoundingClientRect().left ?? null;
  return { units: x("#titlebar .units"), status: x("#status"), docname: x("#docname") };
});

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });

  // --- 1. startup: the welcome card fills in, the title bar does not move ------
  const page = await boot(browser, LIVE);
  await page.waitForFunction(
    () => document.getElementById("status")?.className.includes("connected"),
    null, { timeout: 60000 },
  ).catch(() => console.log("  (warning: the geometry engine never reported connected)"));
  await page.waitForFunction(() => window.__floor.log.includes("ta_funding_goal"), null, { timeout: 15000 });
  const before = await titlebarLayout(page);
  const pillShownEarly = await page.evaluate(() => {
    const p = document.querySelector(".funding-pill");
    return !!p && !p.hidden;
  });
  check(!pillShownEarly, "no pill before the first fetch (no cache yet)");
  await page.evaluate(() => window.__floor.release());
  await page.waitForFunction(() => {
    const p = document.querySelector(".funding-pill");
    return p && !p.hidden;
  }, null, { timeout: 15000 });
  const after = await titlebarLayout(page);
  check(JSON.stringify(before) === JSON.stringify(after), "the pill appearing moves nothing else in the title bar",
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const fetches = await page.evaluate(() => window.__floor.log.filter((c) => c === "ta_funding_goal").length);
  check(fetches === 1, "exactly one fetch at startup", `${fetches}`);

  const card = await page.evaluate(() => {
    const c = document.querySelector(".welcome-funding");
    return c && { hidden: c.hidden, text: c.innerText, h: c.getBoundingClientRect().height };
  });
  check(card && !card.hidden && card.text.includes("$147 of $335 this month"), "the welcome card shows the amounts",
    card && JSON.stringify(card.text));
  const welcomeLeft = await page.evaluate(() => {
    const l = document.querySelector(".welcome-left");
    return l && { overflow: l.scrollHeight - l.clientHeight };
  });
  check(welcomeLeft && welcomeLeft.overflow <= 1, "the welcome column still fits", JSON.stringify(welcomeLeft));
  // ta_ping answers false, so the remote pane is the offline box. Its Retry used
  // to grow to the pane's full height (.choice-btn is flex:1 for button rows).
  await page.waitForSelector(".welcome-offline .choice-btn");
  const retry = await page.evaluate(() => {
    const b = document.querySelector(".welcome-offline .choice-btn").getBoundingClientRect();
    const box = document.querySelector(".welcome-offline").getBoundingClientRect();
    const msg = document.querySelector(".welcome-offline p");
    return { h: b.height, w: b.width, offCentre: Math.abs((b.left + b.right) / 2 - (box.left + box.right) / 2),
      below: b.top > msg.getBoundingClientRect().bottom, text: msg.innerText };
  });
  check(retry.h < 48 && retry.w < 200 && retry.offCentre < 1.5 && retry.below,
    "the offline box's Retry sizes to its label, centred under the message", JSON.stringify(retry));
  check(!/[—–]/.test(retry.text), "the offline message has no dash", JSON.stringify(retry.text));
  await shot(page, "welcome-card.png");

  await page.keyboard.press("Escape"); // close the welcome
  await page.waitForFunction(() => !document.querySelector(".welcome-panel"));

  // --- 2. the pill and its panel ----------------------------------------------
  const pillText = await page.evaluate(() => document.querySelector(".funding-pill").innerText.trim());
  check(pillText === "Funding 44%", "pill text", JSON.stringify(pillText));
  await shot(page, "pill.png", { x: 700, y: 0, width: 700, height: 60 });

  await page.click(".funding-pill");
  const panel = await page.evaluate(() => {
    const p = document.querySelector(".funding-panel");
    if (!p) return null;
    const bar = p.querySelector("[role=progressbar]");
    const pill = document.querySelector(".funding-pill").getBoundingClientRect();
    const r = p.getBoundingClientRect();
    return {
      role: p.getAttribute("role"),
      focused: document.activeElement === p,
      expanded: document.querySelector(".funding-pill").getAttribute("aria-expanded"),
      bar: bar && ["aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-label"].map((a) => bar.getAttribute(a)),
      buttons: [...p.querySelectorAll(".funding-links button")].map((b) => b.innerText.trim()),
      under: r.top >= pill.bottom && r.top - pill.bottom < 12,
      rightAligned: Math.abs(r.right - pill.right) < 1.5,
      inView: r.left >= 0 && r.bottom <= innerHeight,
      wraps: [...p.querySelectorAll(".funding-links button")].some((b) => b.scrollWidth > b.clientWidth + 1),
    };
  });
  check(panel && panel.role === "dialog" && panel.focused && panel.expanded === "true", "the pill opens the panel and focus moves into it", JSON.stringify(panel));
  check(panel && JSON.stringify(panel.bar) === JSON.stringify(["44", "0", "100", "Funding this month"]), "a real progressbar", JSON.stringify(panel && panel.bar));
  check(panel && JSON.stringify(panel.buttons) === JSON.stringify(["PayPal", "Ko-fi", "TinkerAtlas"]), "buttons in Thomas's order", JSON.stringify(panel && panel.buttons));
  check(panel && panel.under && panel.rightAligned && panel.inView, "the panel hangs under the pill, right edges aligned");
  check(panel && !panel.wraps, "no button label is clipped");
  await shot(page, "panel.png");

  await page.click(".funding-links button >> nth=0");
  await page.click(".funding-links button >> nth=1");
  await page.click(".funding-links button >> nth=2");
  // each click goes through two lazy imports (help -> welcome -> plugin-opener)
  await page.waitForFunction(() => window.__floor.opened.length >= 3, null, { timeout: 5000 }).catch(() => {});
  const opened = await page.evaluate(() => window.__floor.opened);
  check(JSON.stringify(opened) === JSON.stringify(["https://paypal.me/makerviking", "https://ko-fi.com/tinkeratlas", "https://tinkeratlas.com/pricing"]),
    "each button reaches the opener with its URL", JSON.stringify(opened));

  await page.keyboard.press("Escape");
  const afterEsc = await page.evaluate(() => ({
    open: !!document.querySelector(".funding-panel"),
    focusOnPill: document.activeElement === document.querySelector(".funding-pill"),
  }));
  check(!afterEsc.open && afterEsc.focusOnPill, "Escape closes it and focus returns to the pill", JSON.stringify(afterEsc));
  await page.keyboard.press("Enter");
  check(await page.evaluate(() => !!document.querySelector(".funding-panel")), "Enter on the focused pill opens it");
  await page.mouse.click(700, 500); // the viewport
  check(await page.evaluate(() => !document.querySelector(".funding-panel")), "a click outside closes it");

  // --- 3. hide it, then Help > Support SindriCAD ---------------------------------
  await page.click(".funding-pill");
  await page.click(".funding-hide");
  const hidden = await page.evaluate(() => ({
    pillHidden: document.querySelector(".funding-pill").hidden,
    stored: localStorage.getItem("sindri.funding.pillHidden"),
    label: document.querySelector(".funding-hide")?.innerText.trim(),
  }));
  check(hidden.pillHidden && hidden.stored === "true" && hidden.label === "Show in the status bar", "Hide from the status bar", JSON.stringify(hidden));
  check(JSON.stringify(await titlebarLayout(page)) === JSON.stringify(before), "hiding it moves nothing else either");
  await page.keyboard.press("Escape");
  await page.click(".menu-btn >> text=Help");
  await page.click(".menu-item >> text=Support SindriCAD");
  const fromHelp = await page.evaluate(() => {
    const p = document.querySelector(".funding-panel");
    const r = p && p.getBoundingClientRect();
    return p && { right: innerWidth - r.right, top: r.top, bar: !!p.querySelector("[role=progressbar]") };
  });
  check(fromHelp && fromHelp.bar && fromHelp.right > 0 && fromHelp.top > 30, "Help > Support SindriCAD opens the panel with the pill hidden", JSON.stringify(fromHelp));
  await shot(page, "panel-from-help.png");
  await page.click(".funding-hide"); // show it again
  check(await page.evaluate(() => !document.querySelector(".funding-pill").hidden), "Show in the status bar brings it back");
  await page.keyboard.press("Escape");
  await page.close();

  // --- 4. next launch: the cache shows at once; then a funded month --------------
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p2 = await ctx.newPage();
  await p2.addInitScript(installFloor, { token: TOKEN, answer: FUNDED });
  await p2.addInitScript(() => {
    localStorage.setItem("sindri.welcomeOnStartup", "false");
    localStorage.setItem("sindri.funding.cache", JSON.stringify({ at: Date.now() - 3600_000,
      goal: { goal: 335, current: 147, percentage: 44, reset_day: 20 } }));
  });
  await p2.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await p2.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  const instant = await p2.evaluate(() => ({
    text: document.querySelector(".funding-pill")?.innerText.trim(),
    fetched: window.__floor.log.includes("ta_funding_goal"),
  }));
  check(instant.text === "Funding 44%" && !instant.fetched, "next launch: the cached value shows before any fetch", JSON.stringify(instant));
  await p2.waitForFunction(() => document.querySelector(".funding-pill")?.innerText.trim() === "Funded", null, { timeout: 15000 })
    .then(() => check(true, "the fetched funded month replaces it: \"Funded\""))
    .catch(() => check(false, "the fetched funded month replaces it"));
  await p2.click(".funding-pill");
  const funded = await p2.evaluate(() => document.querySelector(".funding-panel")?.innerText);
  check(funded && funded.includes("This month is covered. Thank you!") && !funded.includes("pauses"), "funded panel thanks, no warning", JSON.stringify(funded));
  await shot(p2, "panel-funded.png");
  await p2.emulateMedia({ colorScheme: "light" });
  await shot(p2, "panel-funded-prefers-light.png");
  await ctx.close();

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
