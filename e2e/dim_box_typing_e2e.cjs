// Typing into the draw-time W/H box replaces the live figure, in a real browser.
//
// GH #17: the box used to rewrite and re-select its text on every pointer move
// so that typing at any moment replaced the figure. That per-move selection was
// the largest app-side cost of a software-painted WebKitGTK frame, so the box
// now writes its text only when the shown figure changes (which leaves a caret
// at the end) and selects it on the next keystroke instead.
//
// What a unit test cannot show: that a real engine inserts the typed character
// over the selection made in the keydown handler, rather than at the caret the
// value write left. Real key events (CDP) after real mouse moves, Rectangle
// tool, the way the user draws: first corner, move, type 40, Tab, type 30,
// Enter. Also reads the field's selection after the moves, so the run says
// which state the box was in when the keys arrived.
//
// Usage (from the repo root), with vite on 5173 (no sidecar geometry needed):
//   SC_TOKEN=<the sidecar token> node e2e/dim_box_typing_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome);
// SC_URL overrides the dev-server origin, SC_PORT just the vite port.
const { chromium } = require("playwright-core");

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
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

  /** a fresh sketch on XY with the Rectangle tool (the default) */
  const newSketch = async () => {
    await page.evaluate(() => {
      const s = window.__sindri;
      if (s.sketch.active) s.sketch.finish(false);
      s.store.loadDocument({ version: 5, units: "mm", parameters: {}, features: [] });
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__sindri.sketch.enter("XY", window.__sindri.store));
    await page.waitForTimeout(800);
  };

  /** the W/H fields: text, selection, focus */
  const fields = () => page.evaluate(() => [...document.querySelectorAll(".dim-input input")].map((el) => ({
    value: el.value, sel: [el.selectionStart, el.selectionEnd], focused: document.activeElement === el,
  })));

  const rects = () => page.evaluate(() => window.__sindri.sketch.entities
    .filter((e) => e.type === "rectangle").map((e) => ({ w: +e.width.toFixed(6), h: +e.height.toFixed(6) })));

  const vp = await page.evaluate(() => {
    const r = document.getElementById("viewport").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const at = (fx, fy) => ({ x: Math.round(vp.x + vp.w * fx), y: Math.round(vp.y + vp.h * fy) });

  /** first corner, then a sweep of real mouse moves so the figure changes many times */
  const startRect = async () => {
    const c0 = at(0.35, 0.35);
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll(".dim-input input").length === 2, null, { timeout: 3000 });
    const c1 = at(0.55, 0.6);
    await page.mouse.move(c1.x, c1.y, { steps: 25 });
    await page.waitForTimeout(150);
  };

  console.log("\n=== typed W and H replace the live figures ===");
  await newSketch();
  await startRect();
  const before = await fields();
  console.log("after the moves:", JSON.stringify(before));
  check(before.length === 2 && before[0].focused, "the box is up with width focused");
  check(before.length === 2 && /\d/.test(before[0].value) && /\d/.test(before[1].value),
    "both fields show the cursor's figures");
  await page.keyboard.type("40");
  const typedW = await fields();
  check(typedW[0] && typedW[0].value === "40", "typing 40 replaced the width figure", JSON.stringify(typedW[0]));
  await page.keyboard.press("Tab");
  // the cursor moves on after Tab; height still tracks it, width is locked
  const c2 = at(0.6, 0.65);
  await page.mouse.move(c2.x, c2.y, { steps: 10 });
  await page.waitForTimeout(150);
  const tabbed = await fields();
  check(tabbed[1] && tabbed[1].focused, "Tab moved to height", JSON.stringify(tabbed));
  check(tabbed[0] && tabbed[0].value === "40", "width held 40 while the cursor moved on");
  await page.keyboard.type("30");
  const typedH = await fields();
  check(typedH[1] && typedH[1].value === "30", "typing 30 replaced the height figure", JSON.stringify(typedH[1]));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const made = await rects();
  check(made.length === 1 && made[0].w === 40 && made[0].h === 30, "Enter drew a 40 x 30 rectangle", JSON.stringify(made));

  console.log("\n=== a caret the user clicks into the figure is where typing goes ===");
  await newSketch();
  await startRect();
  const box = await page.evaluate(() => {
    const el = document.querySelector(".dim-input input");
    const r = el.getBoundingClientRect();
    return { x: r.left + 3, y: r.top + r.height / 2, value: el.value };
  });
  await page.mouse.click(box.x, box.y); // caret before the first digit
  await page.keyboard.type("1");
  const clicked = await fields();
  check(clicked[0] && clicked[0].value === `1${box.value}`, "the digit went in at the clicked caret",
    `${box.value} -> ${clicked[0] && clicked[0].value}`);
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
