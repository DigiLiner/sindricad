// Show/hide all sketches reuses what was drawn, in a real browser, through the
// Browser's own folder eyes (tracker 6660a646, GH #41 "the show/hide-all lag").
//
// Before: every click on the Sketches eye that SHOWED them, and every click on
// the Bodies eye while sketches were shown, threw away and rebuilt every
// sketch's curves and profile fills: 38-68 ms of blocked UI on this document
// (15 sketches x 48 entities), 111-133 ms on 20 x 96.
//
// What this checks, by identity and state only (timings are printed, never
// gated, because a loaded CI box would make them flaky):
//   - hide: nothing drawn, no geometry disposed (it is kept for the show);
//   - show: the SAME fill meshes, fill geometries, curve objects and curve
//     geometries come back, all 15 sketches drawn, the eye reads shown again;
//   - the Bodies eye twice with sketches shown: same objects, nothing disposed;
//   - an edit made through the store, then hide, then show: the edit is drawn,
//     never the cached drawing from before it.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/sketch_visibility_cache_e2e.cjs
// SC_CHROME overrides the browser binary, and SC_URL the dev server, for
// running against a side-port worktree.
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

// Rectangles, circles crossing them, a polygon, a slot, a line + arc D and a
// point: crossings make region detection do real work, and the circles draw as
// groups with a nested centre marker.
function cell(tag, ox, oy) {
  return [
    { id: `${tag}r`, type: "rectangle", x: ox, y: oy, width: 20, height: 12 },
    { id: `${tag}c1`, type: "circle", x: ox + 20, y: oy + 6, radius: 5 },
    { id: `${tag}c2`, type: "circle", x: ox + 10, y: oy + 12, radius: 4 },
    { id: `${tag}p`, type: "polygon", x: ox + 35, y: oy + 6, radius: 5, sides: 6, angle: 0 },
    { id: `${tag}s`, type: "slot", x1: ox + 48, y1: oy + 6, x2: ox + 58, y2: oy + 6, width: 4 },
    { id: `${tag}l`, type: "line", x1: ox + 66, y1: oy, x2: ox + 66, y2: oy + 12 },
    { id: `${tag}a`, type: "arc", x1: ox + 66, y1: oy, x2: ox + 66, y2: oy + 12, mx: ox + 72, my: oy + 6 },
    { id: `${tag}pt`, type: "point", x: ox + 78, y: oy },
  ];
}
const SKETCHES = 15;
const DOC = {
  version: 5, units: "mm", parameters: {},
  features: [
    { id: "b1", type: "box", length: 40, width: 40, height: 10 },
    ...Array.from({ length: SKETCHES }, (_, i) => ({
      id: `s${i}`, type: "sketch", plane: "XY",
      entities: [0, 1, 2, 3, 4, 5].flatMap((k) => cell(`s${i}k${k}`, k * 90, i * 20)),
    })),
  ],
};

(async () => {
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    // WebGL2 is MANDATORY: the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__sindri.store.buildState.building, null, { timeout: 60000 });

  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
    // time every overlay.update, so the click cost can be split
    const o = window.__sindri.overlay;
    const orig = o.update.bind(o);
    window.__upd = [];
    o.update = (...a) => { const t0 = performance.now(); orig(...a); window.__upd.push(performance.now() - t0); };
  });
  const settled = await page.evaluate(() => window.__settles);
  await page.evaluate((d) => window.__sindri.store.load(JSON.stringify(d)), DOC);
  await page.waitForFunction((b) => window.__settles > b && !window.__sindri.store.buildState.building, settled, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const ents = DOC.features[1].entities.length;
  const drawn = () => page.evaluate(() => window.__sindri.overlay.committedSketches.length);
  check(await drawn() === SKETCHES, `precondition: all ${SKETCHES} sketches (${ents} entities each) are drawn at rest`, await drawn());

  // What is on screen now, stashed by identity, with a dispose listener on
  // every geometry under it (nested ones included).
  const stash = () => page.evaluate(() => {
    const o = window.__sindri.overlay;
    const curves = [...o.committed.children];
    const fills = o.regions.map((r) => r.fill);
    const w = {
      curves, fills,
      curveGeos: curves.map((c) => c.geometry ?? null),
      fillGeos: fills.map((f) => f.geometry),
      disposed: 0, armed: 0,
    };
    for (const root of [...curves, ...fills]) {
      root.traverse((c) => {
        if (!c.geometry) return;
        w.armed++;
        c.geometry.addEventListener("dispose", () => { w.disposed++; });
      });
    }
    window.__wf = w;
    return { curves: curves.length, fills: fills.length, geometries: w.armed };
  });
  const same = () => page.evaluate(() => {
    const o = window.__sindri.overlay, w = window.__wf;
    const curves = [...o.committed.children];
    const fills = o.regions.map((r) => r.fill);
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    return {
      sameCurve: eq(curves, w.curves),
      sameCurveGeo: eq(curves.map((c) => c.geometry ?? null), w.curveGeos),
      sameFill: eq(fills, w.fills),
      sameFillGeo: eq(fills.map((f) => f.geometry), w.fillGeos),
      disposed: w.disposed,
    };
  });
  // click a folder head's eye through the DOM, timing the synchronous handler;
  // re-queried every time, because the Browser rebuilds its rows on toggle
  const clickEye = (label) => page.evaluate((want) => {
    for (const el of document.querySelectorAll("#browser .tree-folder")) {
      if (el.querySelector(".tree-label")?.textContent !== want) continue;
      const eye = el.querySelector(".tree-eye");
      if (!eye) return null;
      window.__upd.length = 0;
      const t0 = performance.now();
      eye.click();
      const ms = performance.now() - t0;
      return { ms: +ms.toFixed(1), update: +window.__upd.reduce((a, b) => a + b, 0).toFixed(1) };
    }
    return null;
  }, label);
  const pressed = (label) => page.evaluate((want) => {
    for (const el of document.querySelectorAll("#browser .tree-folder")) {
      if (el.querySelector(".tree-label")?.textContent === want) return el.querySelector(".tree-eye")?.getAttribute("aria-pressed");
    }
    return null;
  }, label);

  const at = await stash();
  console.log("drawn at rest:", JSON.stringify(at));

  for (let round = 1; round <= 3; round++) {
    const hide = await clickEye("Sketches");
    check(hide !== null, `round ${round}: the Sketches folder has an eye`);
    check(await drawn() === 0, `round ${round}: hide all draws no sketch`, await drawn());
    check(await pressed("Sketches") === "true", `round ${round}: the eye reads hidden`);
    const s1 = await same();
    check(s1.disposed === 0, `round ${round}: hiding disposes nothing`, s1.disposed);
    await page.waitForTimeout(200);

    const show = await clickEye("Sketches");
    check(await drawn() === SKETCHES, `round ${round}: show all draws all ${SKETCHES} again`, await drawn());
    check(await pressed("Sketches") === "false", `round ${round}: the eye reads shown`);
    const s2 = await same();
    check(s2.sameFill && s2.sameFillGeo && s2.sameCurve && s2.sameCurveGeo && s2.disposed === 0,
      `round ${round}: show all hands back the same fills, curves and geometries`, s2);
    console.log(`  round ${round}: hide click ${hide?.ms} ms (update ${hide?.update}), show click ${show?.ms} ms (update ${show?.update})`);
    await page.waitForTimeout(200);
  }

  // four clicks, so the body ends shown again
  for (let i = 0; i < 4; i++) {
    const b = await clickEye("Bodies");
    check(b !== null, `Bodies eye ${i + 1}: the Bodies folder has an eye`);
    const s = await same();
    check(s.sameFill && s.sameFillGeo && s.sameCurve && s.sameCurveGeo && s.disposed === 0,
      `Bodies eye ${i + 1} with sketches shown: same objects, nothing disposed`, s);
    console.log(`  Bodies eye ${i + 1}: click ${b?.ms} ms (update ${b?.update})`);
    await page.waitForTimeout(200);
  }

  // An edit, then hide, then show: the edit is what comes back.
  const lineX = () => page.evaluate(() => {
    const c = window.__sindri.overlay.committed.children.find((o) => o.userData.sketchId === "s3" && o.userData.entityId === "s3k0l");
    return c ? Math.round(c.userData.pts[0].x * 1000) / 1000 : null;
  });
  check(await lineX() === 66, "precondition: the line s3k0l is drawn at x = 66", await lineX());
  const settled2 = await page.evaluate(() => window.__settles);
  await page.evaluate(() => {
    const st = window.__sindri.store;
    const f = st.document.features.find((x) => x.id === "s3");
    st.updateFeature("s3", { entities: f.entities.map((e) => (e.id === "s3k0l" ? { ...e, x1: 64, x2: 64 } : e)) });
  });
  await page.waitForFunction((b) => window.__settles > b && !window.__sindri.store.buildState.building, settled2, { timeout: 120000 });
  check(await lineX() === 64, "the edit is drawn", await lineX());
  await clickEye("Sketches");
  await clickEye("Sketches");
  check(await drawn() === SKETCHES, "edit, hide, show: all sketches drawn", await drawn());
  check(await lineX() === 64, "edit, hide, show: the EDIT is drawn, not the drawing from before it", await lineX());

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
