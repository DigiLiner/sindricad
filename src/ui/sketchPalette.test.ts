// The Sketch Palette's own half of report 9b764625 (Paul, 2026-10-03): "the
// 'construction' check box does not do anything, the 'Sketch grid' tickbox
// does not appear to do anything. I don't know what a 'reference dim' or 'show
// profile' do, tooltip text may help users understand what sketch palette items
// do. I really like the 'lock to plane' and 'look at' options!"
//
// Rendered over the fakeDom stub, so these read what the user is shown: the
// tooltip on each row, and what a box draws when the sketch tells it to. The
// sketch's half (what the Construction box should show, the grid's frame) is in
// constructionToggle.test.ts and paletteToggles.test.ts; the wiring
// between the two runs in the real app in e2e/sketch_palette_e2e.cjs.
import { describe, it, expect } from "vitest";
import { FakeEl, byClass, installFakeDocument } from "./fakeDom.testkit";
import { SketchPalette, type PaletteToggle } from "./sketchPalette";
import { GLYPH_LEGEND } from "../sketch/glyphs";

installFakeDocument();

function mount() {
  const host = new FakeEl("aside");
  const palette = new SketchPalette(host as unknown as HTMLElement);
  const toggled: [PaletteToggle, boolean][] = [];
  palette.onToggle = (k, v) => toggled.push([k, v]);
  const rows = byClass(host, "palette-row");
  /** the row whose label reads `label`, and its checkbox */
  const row = (label: string) => {
    const r = rows.find((x) => x.children[0]?.textContent === label);
    expect(r, `no palette row "${label}"`).toBeTruthy();
    return { row: r!, box: r!.children[1] as FakeEl & { checked: boolean; indeterminate?: boolean } };
  };
  return { host, palette, toggled, rows, row };
}

describe("every palette item says what it does (9b764625)", () => {
  it("each switch has a tooltip of its own, which is not just its name again", () => {
    const { rows } = mount();
    expect(rows).toHaveLength(SketchPalette.toggleKeys().length);
    const titles = rows.map((r) => r.title);
    for (const [k, r] of rows.entries()) {
      const label = r.children[0]!.textContent;
      expect(r.title, `"${label}" has no tooltip`).not.toBe("");
      expect(r.title, `"${label}"`).not.toBe(label);
      expect(titles.indexOf(r.title), `"${label}" shares its tooltip`).toBe(k);
    }
  });

  it("the four the report names: Reference Dim, Show Profile, Lock to Plane and Look At", () => {
    const { host, row } = mount();
    expect(row("Reference Dim").row.title).toMatch(/never move the geometry/);
    expect(row("Show Profile").row.title).toMatch(/closed areas/);
    expect(row("Lock to Plane").row.title).toMatch(/orbiting is off/);
    const lookAt = byClass(host, "palette-btn")[0];
    expect(lookAt?.title).toBeTruthy();
  });

  it("Construction says a click with geometry selected sets what you draw next too", () => {
    // The box shows the selection while there is one, so the drawing mode the
    // same click sets (2fc27cf1) cannot be seen until it is gone: say it.
    const { row } = mount();
    expect(row("Construction").row.title).toMatch(/switches the selection and sets what you draw next/);
  });
});

describe("a box the sketch draws, without calling back", () => {
  it("show() draws the Construction box, mixed included, and toggles nothing", () => {
    const { palette, toggled, row } = mount();
    const { box } = row("Construction");
    palette.show("construction", true);
    expect([box.checked, !!box.indeterminate]).toEqual([true, false]);
    palette.show("construction", true, true);
    expect([box.checked, box.indeterminate]).toEqual([true, true]);
    palette.show("construction", false);
    expect([box.checked, box.indeterminate]).toEqual([false, false]);
    expect(toggled).toEqual([]);
  });

  it("a click on a mixed box hands the sketch the opposite of what it showed underneath", () => {
    const { palette, toggled, row } = mount();
    const { box } = row("Construction");
    palette.show("construction", true, true); // mostly construction
    // what the browser does to an indeterminate checkbox on a click
    box.checked = !box.checked;
    box.indeterminate = false;
    box.dispatch("change");
    expect(toggled).toEqual([["construction", false]]);
  });

  it("show() leaves what the switch holds alone, so the next sketch is handed the mode", () => {
    const { palette, toggled } = mount();
    palette.show("construction", true); // a selected construction line
    palette.emitAll();
    expect(toggled.find(([k]) => k === "construction")).toEqual(["construction", false]);
  });

  it("set() is remembered: the Dimension tool's menu turned Reference on, and the next sketch keeps it", () => {
    const { palette, toggled, row } = mount();
    palette.set("reference", true);
    expect(row("Reference Dim").box.checked).toBe(true);
    expect(toggled, "set() must not call back into the sketch that told it").toEqual([]);
    palette.emitAll();
    expect(toggled.find(([k]) => k === "reference")).toEqual(["reference", true]);
  });
});

// Feature request X-badge-legend: "Constraint badges do not explain
// themselves: a user read the pointOn glyph (∈) as a Euro sign and as an
// error, and never found the hover tooltip." Every badge's meaning (and its
// amber/red status colors) now lives in a legend in the palette too, not only
// in a tooltip on a badge that does not exist until the constraint is already
// applied.
describe("X-badge-legend: a legend names every constraint badge, closed by default", () => {
  it("has a legend section separate from Constraints, starting closed", () => {
    const { host } = mount();
    const sections = byClass(host, "palette-section").map((e) => e.textContent);
    expect(sections).toContain("Constraints");
    const legendHead = byClass(host, "palette-legend-head")[0];
    expect(legendHead, "no legend header").toBeTruthy();
    expect(legendHead!.getAttribute("aria-expanded")).toBe("false");
    const body = byClass(host, "palette-legend")[0];
    expect(body!.classList.contains("hidden")).toBe(true);
  });

  it("clicking the header opens it and lists every badge symbol with its name", () => {
    const { host } = mount();
    const legendHead = byClass(host, "palette-legend-head")[0]!;
    legendHead.dispatch("click");
    expect(legendHead.getAttribute("aria-expanded")).toBe("true");
    const body = byClass(host, "palette-legend")[0]!;
    expect(body.classList.contains("hidden")).toBe(false);

    const rows = byClass(body, "legend-row");
    // one row per GLYPH_LEGEND entry, plus the amber and red status rows
    expect(rows).toHaveLength(GLYPH_LEGEND.length + 2);
    for (const [i, g] of GLYPH_LEGEND.entries()) {
      const glyph = rows[i]!.children[0]!;
      const name = rows[i]!.children[1]!;
      expect(glyph.textContent, `row ${i} symbol`).toBe(g.label);
      expect(name.textContent, `row ${i} name`).not.toBe("");
    }
    const amber = rows[GLYPH_LEGEND.length]!;
    const red = rows[GLYPH_LEGEND.length + 1]!;
    expect(amber.children[0]!.classList.contains("over")).toBe(true);
    expect(amber.children[1]!.textContent).toMatch(/redundant/i);
    expect(red.children[0]!.classList.contains("conflict")).toBe(true);
    expect(red.children[1]!.textContent).toMatch(/conflict/i);
  });

  it("the ∈ (pointOn) symbol the reporter misread is in the legend, named, not left to a tooltip alone", () => {
    const { host } = mount();
    byClass(host, "palette-legend-head")[0]!.dispatch("click");
    const body = byClass(host, "palette-legend")[0]!;
    const pointOn = byClass(body, "legend-row").find((r) => r.children[0]?.textContent === "∈");
    expect(pointOn, "no legend row for ∈").toBeTruthy();
    expect(pointOn!.children[1]!.textContent).toMatch(/point on/i);
  });
});
