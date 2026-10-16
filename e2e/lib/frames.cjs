// Wait for the viewport to DRAW, not for a stopwatch.
//
// three's Raycaster hit-tests against each object's stored matrixWorld, and the
// render-on-demand loop refreshes that only inside renderer.render(). So an
// object added or moved since the last draw sits at its old transform (often
// the identity) for picking: a press on the Section arrow, or a pick on a datum
// quad the build just re-created, misses until a frame has been drawn. A fixed
// sleep holds the spec up only while frames happen to arrive in time, which on
// a loaded CI runner they do not.
//
// This counts frames that actually drew: renderer.info.render.frame moves on
// every render() call, and the poll looks once per animation frame. The poll's
// rAF is registered after the loop's, so it runs after that frame's draw.
// requestRender is re-armed on every poll because the loop draws only on
// demand. Counting changes per poll, not render() calls, keeps this right if a
// frame ever gains another render pass (today it has two: scene + ViewCube).
//
//   await drawn(page, 2); // two frames drawn since this call
module.exports.drawn = (page, draws = 2) => page.evaluate((n) => new Promise((resolve, reject) => {
  const v = window.__sindri.viewport;
  const info = v.scene.renderer.info.render;
  let last = info.frame;
  let seen = 0;
  const timer = setTimeout(() => reject(new Error(`drawn(${n}): only ${seen} frame(s) drawn in 30 s`)), 30000);
  const poll = () => {
    if (info.frame !== last) { seen++; last = info.frame; }
    if (seen >= n) { clearTimeout(timer); resolve(seen); return; }
    v.requestRender();
    requestAnimationFrame(poll);
  };
  v.requestRender();
  requestAnimationFrame(poll);
}), draws);
