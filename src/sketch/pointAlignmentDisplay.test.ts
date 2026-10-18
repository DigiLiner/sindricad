// Report c89a43be: Horizontal and Vertical on two POINTS show "the wrong way
// round". The geometry is right: Vertical lines the points up (same X) and is
// stored as a horizontal distance of 0, Horizontal levels them (same Y) as a
// vertical distance of 0. What was wrong is how they read back: the panel
// listed a pair made with Vertical as "Horizontal distance 0", and the canvas
// drew a "0" dimension instead of the V the user put there.
//
// Made with the real tool (the select-tool testkit's Vertical/Horizontal
// clicks), then read back through what the panel and the canvas draw from.

import { describe, it, expect } from "vitest";
import { liveSketch } from "./liveSketch.testkit";
import { sketchDimRows } from "./dimRows";
import { constraintGlyphs } from "./glyphs";
import { constraintDims } from "./entityDims";
import { dimConflictMsg } from "./dimConflict";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

/** The reporter's two points (e255 above e256), and a circle beside them. */
const ents = (): ResolvedEntity[] => [
  { type: "point", id: "e255", x: -85.27655493724903, y: -201.16708864587585 },
  { type: "point", id: "e256", x: -85.27655493724903, y: -172.0593277493453 },
  { type: "circle", id: "e251", x: -92.08822971926188, y: -172.0593277493453, radius: 2.904828224079326 },
];

function made(tool: "vertical" | "horizontal", a: [number, number], b: [number, number]) {
  const live = liveSketch(ents());
  live.s.setTool(tool);
  live.click(...a);
  live.click(...b);
  const c = live.s.constraints.at(-1)!;
  return { live, c, index: live.s.constraints.length - 1 };
}

const rowFor = (live: ReturnType<typeof liveSketch>, index: number) =>
  sketchDimRows(live.s.entities, live.s.constraints).find((r) => r.ref.kind === "constraint" && r.ref.index === index);

describe("a two-point Horizontal/Vertical reads back as the alignment the user made (c89a43be)", () => {
  it("Vertical on two points: stored as a two-point Vertical, listed as Vertical", () => {
    const { live, c, index } = made("vertical", [-85.27655493724903, -201.16708864587585], [-85.27655493724903, -172.0593277493453]);
    expect(c).toEqual({ type: "pointsVertical", e1: "e255", p1: 0, e2: "e256", p2: 0 });
    const row = rowFor(live, index);
    expect(row?.dim).toBe(t("sketch.constraint.vertical"));
    expect(row?.dim).not.toBe(t("inspector.sketchDim.kind.horizontal"));
  });

  it("Horizontal on two points: stored as a two-point Horizontal, listed as Horizontal", () => {
    const { live, c, index } = made("horizontal", [-85.27655493724903, -172.0593277493453], [-92.08822971926188, -172.0593277493453]);
    expect(c).toEqual({ type: "pointsHorizontal", e1: "e256", p1: 0, e2: "e251", p2: 0 });
    expect(rowFor(live, index)?.dim).toBe(t("sketch.constraint.horizontal"));
  });

  it("the canvas draws a V on each point, and no 0 dimension", () => {
    const { live, index } = made("vertical", [-85.27655493724903, -201.16708864587585], [-85.27655493724903, -172.0593277493453]);
    const glyphs = constraintGlyphs(live.s.entities, live.s.constraints).filter((g) => g.cIndex === index);
    expect(glyphs.map((g) => g.label)).toEqual(["V", "V"]);
    expect(glyphs.map((g) => [g.pos.x, g.pos.y])).toEqual([
      [-85.27655493724903, -201.16708864587585],
      [-85.27655493724903, -172.0593277493453],
    ]);
    expect(constraintDims(live.s.entities, live.s.constraints).filter((d) => d.cIndex === index)).toEqual([]);
  });

  it("the canvas draws an H for a Horizontal pair", () => {
    const { live, index } = made("horizontal", [-85.27655493724903, -172.0593277493453], [-92.08822971926188, -172.0593277493453]);
    const glyphs = constraintGlyphs(live.s.entities, live.s.constraints).filter((g) => g.cIndex === index);
    expect(glyphs.map((g) => g.label)).toEqual(["H", "H"]);
  });

  it("a conflict names it by the alignment too", () => {
    const { live, index } = made("vertical", [-85.27655493724903, -201.16708864587585], [-85.27655493724903, -172.0593277493453]);
    const cons = live.s.constraints;
    const edited: SketchConstraint = { type: "p2pDistance", id: "c9", e1: "e255", p1: 0, e2: "e256", p2: 0, value: 5 };
    const msg = dimConflictMsg(edited, new Set([index]), [...cons, edited]);
    expect(msg).toContain(t("sketch.constraint.vertical"));
    expect(msg).not.toContain(t("sketch.constraint.p2pDistanceX"));
  });

  it("CONTROL: a real horizontal DISTANCE is still a dimension, listed and drawn as one", () => {
    const live = liveSketch(ents(), [
      { type: "p2pDistanceX", id: "c1", e1: "e256", p1: 0, e2: "e251", p2: 0, value: -6.81167478201285 },
    ]);
    const row = sketchDimRows(live.s.entities, live.s.constraints).find((r) => r.ref.kind === "constraint");
    expect(row?.dim).toBe(t("inspector.sketchDim.kind.horizontal"));
    expect(constraintDims(live.s.entities, live.s.constraints)).toHaveLength(1);
    expect(constraintGlyphs(live.s.entities, live.s.constraints)).toEqual([]);
  });
});
