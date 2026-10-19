// The perspective view must keep its depth precision for the model, in a real browser.
//
// Field case, 2026-10 (Doug's miter gauge STEP, Linux AppImage): "squiggles",
// stair-stepped runs along a face's back edge and hidden edges bleeding through
// a rim. The mesh was clean. The perspective camera held a FIXED near plane of
// 0.1 mm (far 10 m), and a perspective depth buffer resolves about
// d^2 / (near * 2^bits) at distance d: with the 16 bits WebGL guarantees, that
// is ~10 mm at 250 mm away, so faces and edges centimetres apart took turns in
// front. Measured on his file at his angle: 9,278 pixels changed between a
// 24-bit and a 16-bit depth buffer. With near following the model: 48.
//
// No machine in CI has a 16-bit default framebuffer, so this spec makes one: it
// draws the viewport's scene into a render target whose depth attachment is
// DEPTH_COMPONENT16 and puts the colour on the canvas. Same THREE instance,
// same scene, same camera, so the only thing that changes is the depth bits.
//
// What it checks, per view:
//   precision  16-bit vs 24-bit pixel difference stays within a few dozen.
//   control    the same with the old fixed planes forced back in is RED (hundreds
//              to thousands), or "precision" would also pass on a scene that
//              simply had nothing close together in depth.
//   no clip    at 24 bits, the fixed planes and the adaptive ones draw the SAME
//              picture, including views where the camera sits inside the box,
//              grazes the ground grid, or is right under a construction plane.
//              A near plane pulled out too far shows up here as missing pixels.
//
// Usage (from the repo root), with vite on 5173 and the sidecar on 8765:
//   SC_TOKEN=<the sidecar token> node e2e/depth_precision_e2e.cjs
// SC_CHROME overrides the browser binary (CI uses /usr/bin/google-chrome), and
// SC_URL the dev server, for running against a side-port worktree.
const { chromium } = require("playwright-core");
const { drawn } = require("./lib/frames.cjs");

const TOKEN = process.env.SC_TOKEN;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173";

const W = 1400, H = 900;
// Antialiasing jitters a handful of silhouette pixels between any two renders.
const SAME_BUDGET = 60;
// 16 bits are never quite 24: an edge line along a far silhouette still dashes
// in places, because the faces' polygonOffset is measured in depth steps and a
// 16-bit step is coarser. Measured: 0 (iso) and 128 (low, closer) with the fix,
// 5,691 and 1,872 with the fixed planes. The two bands are far apart.
const PRECISION_BUDGET = 250;
const CONTROL_FLOOR = 1000;

let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== undefined ? `  ${JSON.stringify(extra)}` : ""}`);
  if (!ok) fails++;
};

// A plate with a block resting on a second plate a hair above it, and a datum
// plane over the lot: surfaces close together in depth (the gap, every face
// meeting its neighbours at an edge) and things in front of the model (the
// plane) for the near plane to keep. The box primitive is CENTRED.
const DOC = {
  version: 5, units: "mm", parameters: {},
  features: [
    { id: "b1", type: "box", length: 160, width: 100, height: 20 },
    { id: "b2", type: "box", length: 80, width: 50, height: 10 },
    { id: "m1", type: "move", dx: 0, dy: 0, dz: 15.3, rx: 0, ry: 0, rz: 0 },
    { id: "d1", type: "datumPlane", offset: 30,
      plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] } },
  ],
};

(async () => {
  const executablePath = process.env.SC_CHROME || "/usr/bin/chromium";
  const browser = await chromium.launch({
    ...(require("fs").existsSync(executablePath) ? { executablePath } : {}),
    // WebGL2 is MANDATORY: the Viewport constructor throws without it.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(`localStorage.setItem("sindri.welcomeOnStartup", "false");`);
  await page.goto(`${URL}/?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sindri, null, { timeout: 30000 });
  await page.waitForFunction(() => !window.__sindri.store.buildState.building, null, { timeout: 60000 });
  // the fps readout changes between any two shots
  await page.addStyleTag({ content: "#fps { visibility: hidden !important; }" });

  await page.evaluate(async () => {
    // Two switches on the viewport's own draw call:
    //   __depth16  draw through a DEPTH_COMPONENT16 target (a raw blit is not
    //              allowed: the canvas itself is multisampled)
    //   __fixed    put the shipped 0.1 / 10000 planes back right before the draw
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/deps\/three\.js/.test(n));
    const THREE = await import(url);
    const vp = window.__sindri.viewport, r = vp.scene.renderer;
    const orig = r.render.bind(r);
    const quadScene = new THREE.Scene();
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false });
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    let rt = null;
    window.__depth16 = false;
    window.__fixed = false;
    r.render = (scene, cam) => {
      if (r.getRenderTarget() !== null || scene !== vp.scene.scene) return orig(scene, cam);
      if (window.__fixed && cam.isPerspectiveCamera) {
        cam.near = 0.1; cam.far = 10000; cam.updateProjectionMatrix();
      }
      window.__drawn = { type: cam.type, near: cam.near, far: cam.far };
      if (!window.__depth16) return orig(scene, cam);
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      if (!rt || rt.width !== size.x || rt.height !== size.y) {
        rt = new THREE.WebGLRenderTarget(size.x, size.y, {
          samples: 4, depthBuffer: true, colorSpace: r.outputColorSpace,
          depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedShortType),
        });
        mat.map = rt.texture; mat.needsUpdate = true;
      }
      const vpRect = r.getViewport(new THREE.Vector4());
      r.setRenderTarget(rt);
      orig(scene, cam);
      r.setRenderTarget(null);
      r.setViewport(vpRect);
      const ac = r.autoClear; r.autoClear = false;
      orig(quadScene, quadCam);
      r.autoClear = ac;
    };
    window.__settles = 0;
    window.__sindri.store.onBuild((s) => { if (!s.building) window.__settles++; });
  });

  const before = await page.evaluate(() => window.__settles);
  await page.evaluate((d) => window.__sindri.store.loadDocument(d), DOC);
  await page.waitForFunction((b) => window.__settles > b && !window.__sindri.store.buildState.building, before, { timeout: 120000 });
  const built = await page.evaluate(() => ({
    bodies: window.__sindri.viewport.model?.bodies.length ?? 0,
    quads: window.__sindri.viewport.datumQuads.length,
  }));
  check(built.bodies === 2 && built.quads === 1, "the plates and the datum plane built", built);

  const canvasRect = await page.evaluate(() => {
    const r = window.__sindri.viewport.domElement.getBoundingClientRect();
    return { x: Math.ceil(r.left), y: Math.ceil(r.top), width: Math.floor(r.width), height: Math.floor(r.height) };
  });
  const shot = async () => {
    for (let i = 0; ; i++) {
      try {
        return (await page.screenshot({ type: "png", clip: canvasRect })).toString("base64");
      } catch (e) {
        if (i >= 3) throw e;
        await page.waitForTimeout(1000);
      }
    }
  };
  const render = async (depth16, fixed) => {
    await page.evaluate(([d, f]) => { window.__depth16 = d; window.__fixed = f; }, [depth16, fixed]);
    await drawn(page, 3);
    const png = await shot();
    return { png, cam: await page.evaluate(() => window.__drawn) };
  };
  /** Pixels whose colour differs by more than 30 in any channel. */
  const differing = (a, b) => page.evaluate(async ([a, b]) => {
    const px = async (b64) => {
      const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
      const c = new OffscreenCanvas(bm.width, bm.height);
      c.getContext("2d").drawImage(bm, 0, 0);
      return c.getContext("2d").getImageData(0, 0, bm.width, bm.height).data;
    };
    const [A, B] = await Promise.all([px(a), px(b)]);
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) > 30 || Math.abs(A[i + 1] - B[i + 1]) > 30 || Math.abs(A[i + 2] - B[i + 2]) > 30) n++;
    }
    return n;
  }, [a, b]);

  const fitView = (dir, zoom) => page.evaluate(([dir, zoom]) => {
    const vp = window.__sindri.viewport;
    vp.rig.setProjectionMode("persp");
    const b = vp.modelBox(), T = b.min.constructor;
    vp.rig.setViewDir(new T(...dir).normalize(), new T(0, 0, 1));
    vp.rig.fit(b, false);
    if (zoom) vp.rig.zoomBy(zoom);
  }, [dir, zoom]);
  const lookAt = (pos, target) => page.evaluate(([p, t]) => {
    const vp = window.__sindri.viewport;
    vp.rig.setProjectionMode("persp");
    vp.rig.controls.setLookAt(...p, ...t, false);
  }, [pos, target]);

  // --- precision: a 16-bit depth buffer draws what a 24-bit one does ----------
  // The datum plane sits this part out: it is translucent, and blending into the
  // emulation's render target tints it differently from the canvas, which would
  // count as a difference that has nothing to do with depth.
  await page.evaluate(() => { window.__sindri.viewport.datumGroup.visible = false; });
  for (const [name, dir, zoom] of [["iso", [1, -1, 1.2]], ["low, closer", [1, -1, 0.5], 0.5]]) {
    await fitView(dir, zoom);
    const ref = await render(false, false);
    const now16 = await render(true, false);
    const fixed24 = await render(false, true);
    const fixed16 = await render(true, true);
    const adaptive = await differing(ref.png, now16.png);
    const control = await differing(fixed24.png, fixed16.png);
    check(ref.cam.type === "PerspectiveCamera" && ref.cam.near > 1,
      `${name}: the perspective near plane follows the model, not 0.1 mm`, ref.cam);
    check(adaptive <= PRECISION_BUDGET, `${name}: 16-bit depth draws the same picture as 24-bit`, { differing: adaptive });
    check(control >= CONTROL_FLOOR, `${name}: (control) the fixed 0.1 mm near plane does NOT at 16 bits`, { differing: control });
  }

  // --- no clip: what the fixed planes drew, the adaptive ones still draw -----
  await page.evaluate(() => { window.__sindri.viewport.datumGroup.visible = true; });
  const clipViews = [
    ["camera inside the plate's box", () => lookAt([-60, -30, 8], [60, 40, -8])],
    ["camera grazing the ground grid", () => fitView([1, -1, 0.03])],
    ["camera between the model and the datum plane", () => lookAt([70, -60, 25], [0, 0, 40])],
    ["close up on the gap between the plates", () => lookAt([48, -32, 13], [40, -25, 10.15])],
  ];
  for (const [name, set] of clipViews) {
    await set();
    const fixed = await render(false, true);
    const adaptive = await render(false, false);
    const d = await differing(fixed.png, adaptive.png);
    check(d <= SAME_BUDGET, `${name}: nothing is clipped`, { differing: d, near: adaptive.cam.near });
  }

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
