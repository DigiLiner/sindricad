// GH #17: drawing a rectangle got slower with every dimensioned rectangle in
// the sketch. Each dimension label carried `backdrop-filter: blur(6px)` over
// the live canvas, so the blur was redone per label per frame. Free on a GPU;
// on software GL (llvmpipe) it was ~3 ms a label: 25 ms a frame without the
// blur, 80 ms with it, at 20 rectangles (.fable/gh17-lag/RESULT.md).
//
// The rule is for anything drawn once PER ENTITY over the canvas (dimension
// labels, constraint glyphs), because their count grows with the sketch. Fixed
// chrome (the prompt, the view controls) is one element each and is not held
// to it here.
import { describe, it, expect } from "vitest";
import css from "../styles.css?raw";

/** Every top-level `selector { body }` block of styles.css. */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out.push({ selector: m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2]! });
  }
  return out;
}

const perEntity = (selector: string) => /\.sketch-dim(?!s)|\.sketch-glyph(?!s)/.test(selector);

describe("per-entity canvas labels never blur what is behind them", () => {
  it("finds the label and glyph rules (anchors, so a rename fails loudly)", () => {
    const sel = rules().map((r) => r.selector);
    expect(sel).toContain(".sketch-dim");
    expect(sel.some((s) => /\.sketch-glyph(?!s)/.test(s))).toBe(true);
  });

  it("no per-entity rule carries a backdrop-filter", () => {
    const blurred = rules().filter((r) => perEntity(r.selector) && /backdrop-filter/.test(r.body)).map((r) => r.selector);
    expect(blurred).toEqual([]);
  });

  it("a tinted label state stacks its tint on the near-opaque base, so it does not turn see-through", () => {
    for (const sel of [".sketch-dim:hover", ".sketch-dim.sketch-dim-linked"]) {
      const r = rules().find((x) => x.selector === sel);
      expect(r?.body, sel).toMatch(/background:\s*linear-gradient\([^;]*\),\s*rgba\(18,\s*20,\s*25,\s*0\.92\)/);
    }
  });
});
