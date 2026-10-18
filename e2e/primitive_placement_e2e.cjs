// A new primitive rests on the grid, and its centre is typed in the panel, in a real app.
//
// Field report 3ff3dc1b (0.1.244): "I placed a primitive and could only resize
// it", and "the plane moved to the bottom, leaving the origin in mid-air". A box
// built centred on the origin spans z -10..10, the ground grid drops to its
// lowest point (scene.ts groundGridZ) while the origin marker stays at (0,0,0).
// A new primitive is now written centred half its height up, so it sits on
// z=0, and Box/Cylinder/Sphere show Centre X/Y/Z in the inspector.
//
// A new one keeps its base on the grid as it is resized, until Centre Z is
// typed. Every step goes in where the user does: the ribbon's Primitive
// button, the Box choice, the timeline chip, the inspector's rows, Ctrl+Z /
// Ctrl+Y, the M key and the Move panel. What is read back is the rebuilt model's box and the grid's
// rendered height, never a call.
//
// Controls, so a pass cannot be vacuous:
//   - a document saved before the fields (a box with no x/y/z) must still build
//     centred and still pull the grid down with it: saved primitives stay put;
//   - Move on top of a typed centre must add to it, not replace it.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/primitive_placement_e2e.cjs
// SC_CHROME overrides the browser binary, SC_URL the dev server, and SC_SHOT a
// path to save a front-view screenshot of the new box on the grid.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails++;
};
const near = (a, b, tol = 1e-3) => typeof a === "number" && Math.abs(a - b) < tol;

// A box saved by 0.1.259: no x/y/z, so it is centred on the origin.
const OLD_DOC = {
  version: 5, paramDefs: {}, parameters: {},
  features: [{ id: "f1", type: "box", length: 20, width: 20, height: 20 }],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY — the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.keyboard.press("Escape"); // dismiss the welcome modal
  await page.waitForTimeout(400);

  // Wait for a build to ADVANCE, never a stopwatch: right after a mutation the
  // store still holds the previous, settled build.
  await page.evaluate(() => {
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });
  const settles = () => page.evaluate(() => window.__settles);
  const settled = async (before) => {
    await page.waitForFunction(
      (b) => window.__settles > b && !window.__sindri.store.buildState.building,
      before, { timeout: 120000 },
    ).catch(() => console.log("  (warning: no rebuild settled within the timeout)"));
    await page.evaluate(() => window.__sindri.viewport.requestRender());
    await page.waitForTimeout(400); // one painted frame, so the grid has moved
  };

  const read = () => page.evaluate(() => {
    const { viewport: vp, store } = window.__sindri;
    const r = (n) => (typeof n === "number" ? +n.toFixed(4) : n);
    const box = vp.modelBox();
    return {
      bodies: vp.model?.bodies.length ?? 0,
      z: box ? [r(box.min.z), r(box.max.z)] : null,
      x: box ? [r(box.min.x), r(box.max.x)] : null,
      gridZ: r(vp.scene.grid.group.position.z),
      features: store.document.features.map((f) => ({ ...f })),
    };
  });

  /** The inspector's rows: label -> input value. */
  const inspectorRows = () => page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll("#inspector .param-row")) {
      const label = row.querySelector("label")?.textContent;
      const input = row.querySelector("input");
      if (label && input) out[label] = input.value;
    }
    return out;
  });

  // --- 1. Create > Primitive > Box, from the ribbon --------------------------
  let before = await settles();
  await page.click('[data-action="primitive"]');
  await page.locator(".choice-btn", { hasText: "Box" }).first().click();
  await settled(before);
  const placed = await read();
  console.log("  new box:", JSON.stringify({ ...placed, features: undefined }));
  const box = placed.features.find((f) => f.type === "box");
  check(placed.bodies === 1 && !!box, "the ribbon placed one box");
  check(box && box.x === 0 && box.y === 0 && box.z === 10 && box.onGrid === true,
    "its centre is written into the feature, half its height up, following its size", JSON.stringify(box));
  check(near(placed.z?.[0], 0) && near(placed.z?.[1], 20), "the box rests on the grid: z 0..20", `z=${JSON.stringify(placed.z)}`);
  check(near(placed.gridZ, 0), "the grid stays on the XY plane, at the origin marker", `grid z=${placed.gridZ}`);
  const hint = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));
  check(/Centre X, Y or Z/.test(hint), "the hint names the new Centre fields", hint);

  if (process.env.SC_SHOT) {
    await page.evaluate(() => { window.__sindri.handleAction("front"); window.__sindri.viewport.requestRender(); });
    await page.waitForTimeout(800);
    await page.screenshot({ path: process.env.SC_SHOT });
    await page.evaluate(() => window.__sindri.handleAction("iso"));
    console.log(`  screenshot: ${process.env.SC_SHOT}`);
  }

  // --- 2. The inspector offers Centre X/Y/Z, and typing Centre Z moves it ----
  await page.click(`.timeline-node[data-id="${box.id}"]`);
  await page.waitForTimeout(300);
  const rows = await inspectorRows();
  console.log("  inspector:", JSON.stringify(rows));
  check(["Centre X mm", "Centre Y mm", "Centre Z mm"].every((l) => l in rows), "the panel lists Centre X, Y and Z");
  check(rows["Centre Z mm"] === "10", "Centre Z reads the box's centre", `"${rows["Centre Z mm"]}"`);

  /** Type into an inspector row and press Enter, as the user commits it. */
  const typeRow = async (label, text) => {
    const before = await settles();
    const input = page.locator("#inspector .param-row", { hasText: label }).locator("input");
    await input.fill(text);
    await input.press("Enter");
    await settled(before);
    return read();
  };
  const span = (r) => JSON.stringify(r.z);

  // A new box's base stays on the grid as it is resized...
  let r = await typeRow("Height", "40");
  check(near(r.z?.[0], 0) && near(r.z?.[1], 40), "Height 40 keeps the base on the grid: z 0..40", `z=${span(r)}`);
  check((await inspectorRows())["Centre Z mm"] === "20", "and the panel shows the centre it moved to", `"${(await inspectorRows())["Centre Z mm"]}"`);
  // ...until Centre Z is typed: from then on the centre stays put.
  r = await typeRow("Centre Z", "50");
  check(near(r.z?.[0], 30) && near(r.z?.[1], 70), "Centre Z 50 puts the box at z 30..70", `z=${span(r)}`);
  r = await typeRow("Height", "60");
  check(near(r.z?.[0], 20) && near(r.z?.[1], 80), "Height 60 after a typed centre keeps it at 50: z 20..80", `z=${span(r)}`);

  // Undo and redo walk back through those, the base-following included.
  const key = async (combo) => {
    const before = await settles();
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press(combo);
    await settled(before);
    return read();
  };
  r = await key("Control+z");
  check(near(r.z?.[0], 30) && near(r.z?.[1], 70), "Ctrl+Z undoes the height: z 30..70", `z=${span(r)}`);
  r = await key("Control+z");
  check(near(r.z?.[0], 0) && near(r.z?.[1], 40) && r.features[0]?.onGrid === true,
    "Ctrl+Z again undoes the typed centre, base back on the grid: z 0..40", `z=${span(r)}`);
  r = await key("Control+y");
  r = await key("Control+y");
  check(near(r.z?.[0], 20) && near(r.z?.[1], 80), "Ctrl+Y twice redoes both: z 20..80", `z=${span(r)}`);

  // --- 3. Move (M) still works on top of the typed centre --------------------
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.mouse.click(900, 650); // on the canvas, off the box: nothing selected
  await page.keyboard.press("m");
  const panel = page.locator(".move-panel");
  await panel.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  check(await panel.isVisible(), "M opens the Move panel on the box");
  before = await settles();
  const moveZ = panel.locator(".tool-panel-row", { hasText: "Move Z" }).locator("input");
  await moveZ.fill("5");
  await moveZ.press("Enter"); // Enter in a row commits the move
  await settled(before);
  const moved = await read();
  console.log("  after Move Z 5:", JSON.stringify({ ...moved, features: moved.features.map((f) => f.type) }));
  check(moved.features.some((f) => f.type === "move"), "the move was committed as a feature");
  check(near(moved.z?.[0], 25) && near(moved.z?.[1], 85), "Move Z 5 adds to the centre: z 25..85", `z=${JSON.stringify(moved.z)}`);

  // --- 4. Control: a box saved before the fields stays where it was ----------
  before = await settles();
  await page.evaluate((d) => window.__sindri.store.loadDocument(d), OLD_DOC);
  await settled(before);
  const old = await read();
  console.log("  saved box:", JSON.stringify({ ...old, features: undefined }));
  check(near(old.z?.[0], -10) && near(old.z?.[1], 10), "a saved box without x/y/z still straddles the origin", `z=${JSON.stringify(old.z)}`);
  check(near(old.gridZ, -10, 1e-3), "and the grid still drops to its bottom, as before", `grid z=${old.gridZ}`);
  await page.click('.timeline-node[data-id="f1"]');
  await page.waitForTimeout(300);
  const oldRows = await inspectorRows();
  check("Centre Z mm" in oldRows, "its panel offers Centre Z too", JSON.stringify(oldRows));

  await browser.close();
  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
