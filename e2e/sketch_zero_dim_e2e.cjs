// A 0 mm distance made with the Dimension tool shows a "0" label on the canvas.
//
// Two points at the same X dimensioned with the Dimension tool's horizontal
// distance make a distance of 0. Since two-point Horizontal/Vertical got their
// own constraint (2173f0c) that zero reads as the distance it is, but the canvas
// drew nothing for it: a dimension with no length has no direction, and
// constraintDims skipped it. Thomas (2026-10-19): it shows a small "0" label
// beside the coincident points, clickable and editable like any other.
//
// Only a real browser can say it is on screen, beside the points rather than on
// them, and that a double-click on it opens the editor.
//
// Usage (from the repo root), with vite on 5173 (no sidecar geometry needed):
//   SC_TOKEN=<the sidecar token> node e2e/sketch_zero_dim_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome);
// SC_URL overrides the dev-server origin, SC_PORT just the vite port.
const { chromium } = require("playwright-core");

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};

// a above b at the same X, and the Dimension tool's horizontal distance between
// them: 0. Saved as v8, the version this build writes a zero distance at: an
// older file's zero may have been a Vertical and is shown as one (migrate.ts)
const DOC = {
  version: 8,
  parameters: {},
  features: [{
    id: "f1", type: "sketch", plane: "XY",
    entities: [
      { id: "a", type: "point", x: 10, y: 0 },
      { id: "b", type: "point", x: 10, y: 20 },
      { id: "c", type: "circle", x: 40, y: 10, radius: 8 }, // something else to frame
    ],
    constraints: [
      { id: "c5", type: "p2pDistanceX", e1: "a", p1: 0, e2: "b", p2: 0, value: 0 },
    ],
  }],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const origin = process.env.SC_URL || `http://localhost:${process.env.SC_PORT || "5173"}`;
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  const token = process.env.SC_TOKEN ? `?token=${process.env.SC_TOKEN}` : "";
  await page.goto(`${origin}/${token}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  await page.evaluate((d) => {
    const s = window.__sindri;
    if (s.sketch.active) s.sketch.finish(false);
    s.store.loadDocument(d);
  }, DOC);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store, "f1"));
  await page.waitForFunction(() => window.__sindri.sketch.dof >= 0, null, { timeout: 20000 });
  await page.waitForTimeout(500);

  const scr = (x, y) => page.evaluate(([x, y]) => {
    const s = window.__sindri;
    return s.viewport.projectToScreen(s.sketch.plane.to3D(x, y));
  }, [x, y]);
  const labels = () => page.evaluate(() => {
    const vp = document.getElementById("viewport").getBoundingClientRect();
    return [...document.querySelectorAll(".sketch-dim")]
      .filter((el) => getComputedStyle(el).visibility !== "hidden" && el.offsetWidth > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: (el.textContent || "").trim(), x: r.x + r.width / 2, y: r.y + r.height / 2,
          inside: r.left >= vp.left && r.right <= vp.right && r.top >= vp.top && r.bottom <= vp.bottom,
          l: r.left, r: r.right, t: r.top, b: r.bottom,
        };
      });
  });

  console.log("\n=== the 0 mm distance has a label ===");
  const all = await labels();
  const zero = all.find((l) => /^0(\s|$)/.test(l.text) || l.text === "0 mm");
  check(!!zero, "a \"0\" dimension label is drawn", JSON.stringify(all.map((l) => l.text)));
  if (zero) {
    check(zero.inside, "it is inside the view", JSON.stringify(zero));
    const pa = await scr(10, 0), pb = await scr(10, 20);
    const covers = (p) => p.x >= zero.l && p.x <= zero.r && p.y >= zero.t && p.y <= zero.b;
    check(!covers(pa) && !covers(pb), "it sits beside the points, not on them", JSON.stringify({ zero, pa, pb }));
    const near = Math.min(Math.hypot(zero.x - pa.x, zero.y - pa.y), Math.hypot(zero.x - pb.x, zero.y - pb.y));
    const span = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    check(near < span, "and near them: closer to a point than the points are to each other", `${near.toFixed(0)} px vs ${span.toFixed(0)} px`);

    console.log("\n=== it edits like any other dimension label ===");
    await page.mouse.dblclick(zero.x, zero.y);
    await page.waitForTimeout(300);
    const editing = await page.evaluate(() => {
      const input = document.querySelector(".sketch-dim input");
      return !!input && document.activeElement === input;
    });
    check(editing, "a double-click opens its value editor");
    if (editing) {
      await page.keyboard.press("Control+A");
      await page.keyboard.type("5");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => {
        const s = window.__sindri.sketch;
        const c = s.constraints.find((k) => k.id === "c5");
        const a = s.entities.find((e) => e.id === "a"), b = s.entities.find((e) => e.id === "b");
        return { c, dx: b.x - a.x };
      });
      check(after.c && after.c.type === "p2pDistanceX" && after.c.value === 5, "the typed 5 is the distance now", JSON.stringify(after.c));
      check(Math.abs(after.dx - 5) < 1e-6, "and the points are 5 apart in X", String(after.dx));
    }
  }

  await browser.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
