// The chrome index.html ships as static markup (the SOLID tab, the view
// buttons, Fit, the Units label, the undo/redo tooltips) speaks the user's
// language after a restart. Measured in a real browser booting the real app.
//
// From the review of the first community translation (PR #59, zh-CN): with the
// whole menubar, ribbon and browser in Chinese, SOLID, ISO/Top/Front/Right, Fit
// and Units stayed English. src/i18n/index.ts had a localizeStaticChrome() for
// exactly these labels since it was written, and nothing called it. A unit test
// of that function alone stays green while it is dead, which is why this enters
// where the user does: Edit > Settings… > Language, then Restart now.
//
// Legs, each in a fresh browser context:
//   - English (control): every label reads exactly what it always read.
//   - Pseudo-locale, picked in Settings and restarted: every label is bracketed,
//     the test instrument locales/README.md tells translators to use ("text
//     WITHOUT brackets is hardcoded and should be reported").
// Both legs also wait for the status pill to read the locale's "ready": the
// boot pass writes "connecting…" into it, so a pass made after the sidecar
// connects would overwrite "ready" and leave it there. Assert the TEXT; the
// class says "connected" either way.
//
// Usage (from the repo root), with vite and the sidecar running:
//   SC_TOKEN=<the sidecar token> SC_URL=http://localhost:5173 node e2e/locale_boot_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome).
const fs = require("fs");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";
const CHROME = process.env.SC_CHROME
  || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p));

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== undefined ? `  ${JSON.stringify(extra)}` : ""}`);
  if (!ok) fails++;
};

// What index.html ships, which English must keep reading.
const ENGLISH = {
  context: "SOLID", iso: "ISO", top: "Top", front: "Front", right: "Right", fit: "Fit",
  proj: "Auto", selmode: "Faces", units: "Units", unitsTitle: "Display units (geometry is stored in mm)",
  undoTitle: "Undo (Ctrl+Z)", undoAria: "Undo", redoTitle: "Redo (Ctrl+Y)",
};

/** Runs in the page: the static chrome as the user sees it. */
function readChrome() {
  const q = (s) => document.querySelector(s);
  const units = q("label.units");
  const unitsText = units && [...units.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  return {
    context: q("#context-tab")?.textContent,
    iso: q('#viewcontrols [data-view="iso"]')?.textContent,
    top: q('#viewcontrols [data-view="top"]')?.textContent,
    front: q('#viewcontrols [data-view="front"]')?.textContent,
    right: q('#viewcontrols [data-view="right"]')?.textContent,
    fit: q("#fit")?.textContent,
    proj: q("#proj")?.textContent,
    selmode: q("#selmode")?.textContent,
    units: unitsText?.textContent.trim(),
    unitsTitle: units?.title,
    undoTitle: q("#undo-btn")?.title,
    undoAria: q("#undo-btn")?.getAttribute("aria-label"),
    redoTitle: q("#redo-btn")?.title,
    unitOptions: q("#unit")?.options.length,
    status: q("#status")?.textContent,
  };
}

/** Runs in the page: what the active locale says for each label, read from the
 *  app's own i18n module (vite serves it once, so this IS the app's instance). */
async function expectedChrome() {
  const { t } = await import("/src/i18n/index.ts");
  return {
    context: t("chrome.context.solid"), iso: t("chrome.view.iso"), top: t("chrome.view.top"),
    front: t("chrome.view.front"), right: t("chrome.view.right"), fit: t("chrome.fit"),
    proj: t("chrome.proj.auto"), selmode: t("chrome.selmode.faces"), units: t("chrome.units.label"),
    unitsTitle: t("chrome.units.title"), undoTitle: t("chrome.undoTitle"), undoAria: t("chrome.undo"),
    redoTitle: t("chrome.redoTitle"),
    ready: t("status.ready"), connecting: t("chrome.status.connecting"), settings: t("settings.menuItem"),
  };
}

async function booted(page) {
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 60000 });
  await page.waitForFunction(() => !window.__sindri.store.buildState.building, null, { timeout: 120000 });
}

async function waitForReady(page, ready) {
  try {
    await page.waitForFunction((r) => document.getElementById("status")?.textContent === r, ready, { timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is MANDATORY: the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });

  // --- English: the control. Nothing a user reads may change. ---
  {
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
    await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await booted(page);
    check(await page.evaluate(() => document.documentElement.lang) === "en", "en: precondition: <html lang> is en");
    check(await waitForReady(page, "ready"), "en: the status pill settles on \"ready\"",
      await page.evaluate(() => document.getElementById("status")?.textContent));
    const seen = await page.evaluate(readChrome);
    for (const [k, want] of Object.entries(ENGLISH)) check(seen[k] === want, `en: ${k} reads "${want}"`, seen[k]);
    check(seen.unitOptions === 3, "en: the units dropdown kept its three options", seen.unitOptions);
    await ctx.close();
  }

  // --- Pseudo-locale, the way a tester gets it: Settings, then Restart now. ---
  {
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
    await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await booted(page);

    const en = await page.evaluate(expectedChrome);
    await page.click("#menubar .menu-btn >> text=Edit");
    await page.locator(".menu-popup:not(.hidden) .menu-item", { hasText: en.settings }).click();
    await page.selectOption(".settings-lang", "qps-ploc");
    check(await page.isVisible(".settings-restart"), "pseudo: precondition: Settings offers Restart now");
    await page.evaluate(() => { window.__oldDoc = true; });
    await page.click(".settings-restart");
    await page.waitForFunction(() => !window.__oldDoc && !!window.__sindri, null, { timeout: 60000 });
    await booted(page);

    const menu = await page.evaluate(() => document.querySelector("#menubar .menu-btn")?.textContent);
    check(/^\[.*\]$/.test(menu ?? ""), "pseudo: precondition: the menubar came back bracketed", menu);
    const want = await page.evaluate(expectedChrome);
    check(want.context !== "SOLID" && /^\[.*\]$/.test(want.context), "pseudo: precondition: the catalogue is pseudo-localised", want.context);
    check(await waitForReady(page, want.ready), `pseudo: the status pill settles on "${want.ready}", not "${want.connecting}"`,
      await page.evaluate(() => document.getElementById("status")?.textContent));
    const seen = await page.evaluate(readChrome);
    for (const k of Object.keys(ENGLISH)) {
      check(seen[k] === want[k] && seen[k] !== ENGLISH[k], `pseudo: ${k} reads "${want[k]}"`, seen[k]);
    }
    check(seen.unitOptions === 3, "pseudo: the units dropdown kept its three options", seen.unitOptions);
    await ctx.close();
  }

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
