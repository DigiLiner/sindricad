// A dialog or the command palette blurred the whole 3D view behind it
// (`backdrop-filter: blur(2px)` on the full-window backdrop). Blurring a WebGL
// canvas makes the compositor re-filter the whole window every frame the view
// draws, and the model the dialog is about turns to mush behind it. The dim
// stays: it is what says the window behind is not live.
//
// styles.css is read as text (no jsdom, no layout engine): every rule that
// covers the whole window (`position: fixed` with `inset: 0`) is found and
// checked, so a backdrop added later is held to the same rule.
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

const fullWindow = (body: string) => /position:\s*fixed/.test(body) && /(^|[;\s])inset:\s*0\s*;/.test(body);

describe("a modal backdrop dims the view without blurring it", () => {
  it("finds the dialog and command palette backdrops (anchors, so a rename fails loudly)", () => {
    const full = rules().filter((r) => fullWindow(r.body)).map((r) => r.selector);
    expect(full).toContain(".choice-backdrop");
    expect(full).toContain(".cmdk-backdrop");
  });

  it("no full-window rule carries a backdrop-filter", () => {
    const blurred = rules().filter((r) => fullWindow(r.body) && /backdrop-filter/.test(r.body)).map((r) => r.selector);
    expect(blurred).toEqual([]);
  });

  it("the backdrops keep their dim colour", () => {
    for (const sel of [".choice-backdrop", ".cmdk-backdrop"]) {
      const r = rules().find((x) => x.selector === sel);
      expect(r?.body, sel).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.45\)/);
    }
  });
});
