// Mirror a slot or a polygon. reflectEntity had a branch for every entity type
// but these two and fell through to "point": a mirrored slot became a point
// with NaN coordinates (it has no x/y, only x1..y2), a mirrored polygon a bare
// point at its centre, and neither left a region to extrude. Rotate, Scale,
// Move and Copy go through pattern.ts's rotated/scaled/translated, whose
// switches already cover every type.
//
// Everything goes in through the Mirror tool, the way the user does it: select
// the shapes, pick Mirror, click the mirror line. What comes back is read as
// the user sees it: the copy's type and size, and the region it fills.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn(() => () => {}) }));

import { liveSketch } from "./liveSketch.testkit";
import { detectRegions, polygonPoints, type Region } from "./region";
import type { ResolvedEntity } from "./snap";

type Slot = Extract<ResolvedEntity, { type: "slot" }>;
type Poly = Extract<ResolvedEntity, { type: "polygon" }>;

const shoelace = (pts: readonly THREE.Vector2[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** select `ids`, pick Mirror, click the mirror line at `at`; the new entities */
async function mirror(ents: ResolvedEntity[], ids: string[], at: [number, number]) {
  const live = liveSketch(ents);
  const before = new Set(live.s.entities.map((e) => e.id));
  for (const id of ids) live.s.selected.add(id);
  live.s.setTool("mirror");
  live.click(at[0], at[1]);
  await live.settle();
  return { live, copies: live.s.entities.filter((e) => !before.has(e.id)) };
}

/** the region bounded by entity `id` alone */
const regionOf = (ents: ResolvedEntity[], id: string): Region | undefined =>
  detectRegions("s", ents).find((r) => r.entityIds.length === 1 && r.entityIds[0] === id);

describe("Mirror a slot or a polygon", () => {
  it("a slot mirrors as a slot of the same width, its ends reflected", async () => {
    const slot: Slot = { type: "slot", id: "S", x1: 10, y1: 20, x2: 30, y2: 35, width: 8 };
    const axis: ResolvedEntity = { type: "line", id: "M", x1: 50, y1: 0, x2: 50, y2: 60 };
    const { live, copies } = await mirror([axis, slot], ["S"], [50, 30]);
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.type).toBe("slot");
    const c = copy as Slot;
    expect([c.x1, c.y1, c.x2, c.y2]).toEqual([90, 20, 70, 35]);
    expect(c.width).toBe(8);
    const src = regionOf(live.s.entities, "S"), dst = regionOf(live.s.entities, c.id);
    expect(dst, "the mirrored slot is a region of its own").toBeDefined();
    expect(shoelace(dst!.loop)).toBeCloseTo(shoelace(src!.loop), 9);
    expect(dst!.interior.x).toBeGreaterThan(50); // on the far side of the mirror line
  });

  it("a polygon mirrors as a polygon of the same size, every corner reflected", async () => {
    const hex: Poly = { type: "polygon", id: "P", x: 20, y: 10, radius: 10, sides: 6, angle: 17 };
    // a slanted mirror line, so the corners' angle has to change
    const axis: ResolvedEntity = { type: "line", id: "M", x1: 40, y1: 0, x2: 60, y2: 40 };
    const { live, copies } = await mirror([axis, hex], ["P"], [50, 20]);
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.type).toBe("polygon");
    const c = copy as Poly;
    expect(c.radius).toBe(10);
    expect(c.sides).toBe(6);
    // every reflected source corner is a corner of the copy
    const reflect = (p: THREE.Vector2) => {
      const a = new THREE.Vector2(40, 0), d = new THREE.Vector2(20, 40).normalize();
      const foot = a.clone().addScaledVector(d, p.clone().sub(a).dot(d));
      return foot.multiplyScalar(2).sub(p);
    };
    const want = polygonPoints(hex.x, hex.y, hex.radius, hex.sides, (hex.angle * Math.PI) / 180).map(reflect);
    const got = polygonPoints(c.x, c.y, c.radius, c.sides, (c.angle * Math.PI) / 180);
    for (const w of want) expect(Math.min(...got.map((g) => g.distanceTo(w))), `corner near ${w.x},${w.y}`).toBeLessThan(1e-9);
    const src = regionOf(live.s.entities, "P"), dst = regionOf(live.s.entities, c.id);
    expect(dst, "the mirrored polygon is a region of its own").toBeDefined();
    expect(shoelace(dst!.loop)).toBeCloseTo(shoelace(src!.loop), 9);
  });
});
