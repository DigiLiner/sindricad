// Horizontal and Vertical on two points (pointsHorizontal / pointsVertical)
// travel with what Copy, Paste and Mirror copy, the way every other relation
// does (id.remapConstraint, mirror.mirroredConstraints): pointed at the copies,
// and read the mirrored way. A level pair stays level across a horizontal or a
// vertical mirror line, becomes a lined-up pair across a 45 degree one, and
// stays behind across any other line, where its copy is turned off the axes.
//
// Entered through the real Copy/Paste and Mirror of a live sketch, judged on
// the stored constraints and the real solve.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch } from "./liveSketch.testkit";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;
type Pt = Extract<ResolvedEntity, { type: "point" }>;

/** two points made level with Horizontal, and a circle they are not tied to */
const ENTS = (): ResolvedEntity[] => [
  { type: "point", id: "a", x: 10, y: 10 },
  { type: "point", id: "b", x: 30, y: 10 },
  { type: "circle", id: "k", x: 20, y: 30, radius: 4 },
];
const LEVEL: SketchConstraint = { type: "pointsHorizontal", e1: "a", p1: 0, e2: "b", p2: 0 };

async function open() {
  const live = liveSketch(ENTS(), [structuredClone(LEVEL)]);
  live.s.requestSolve();
  await live.settle();
  return live;
}
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Line => ({ type: "line", id, x1, y1, x2, y2 });

async function mirrored(axis: Line) {
  const live = liveSketch([axis, ...ENTS()], [structuredClone(LEVEL)]);
  live.s.requestSolve();
  await live.settle();
  const known = new Set(live.s.entities.map((e) => e.id));
  const k = live.s.constraints.length;
  live.s.selected.add("a");
  live.s.selected.add("b");
  live.s.setTool("mirror");
  live.click((axis.x1 + axis.x2) / 2, (axis.y1 + axis.y2) / 2);
  await live.settle();
  const copies = live.s.entities.filter((e) => !known.has(e.id)) as Pt[];
  return { live, copies, added: live.s.constraints.slice(k) };
}
/** the copy lying at (x, y) */
const at = (copies: Pt[], x: number, y: number) => copies.find((p) => Math.hypot(p.x - x, p.y - y) < 1e-6);

describe("Copy and Paste carry a two-point Horizontal", () => {
  it("the pasted pair is level by its own pointsHorizontal", async () => {
    const live = await open();
    const s = live.s as unknown as { copySelection(): boolean; pasteClipboard(): boolean; conflict: boolean };
    live.s.selected.add("a");
    live.s.selected.add("b");
    expect(s.copySelection()).toBe(true);
    live.move(100, 50);
    const n = live.s.entities.length, k = live.s.constraints.length;
    expect(s.pasteClipboard()).toBe(true);
    await live.settle();
    const [a2, b2] = live.s.entities.slice(n) as Pt[];
    expect(live.s.constraints.slice(k)).toEqual([{ type: "pointsHorizontal", e1: a2!.id, p1: 0, e2: b2!.id, p2: 0 }]);
    expect(s.conflict).toBe(false);
    expect(a2!.y).toBeCloseTo(b2!.y, 9);
  });
});

describe("Mirror carries a two-point Horizontal, read the mirrored way", () => {
  it("across a vertical line it stays a Horizontal, between the mirrored points", async () => {
    const { copies, added, live } = await mirrored(line("M", 50, -10, 50, 60));
    const a2 = at(copies, 90, 10)!, b2 = at(copies, 70, 10)!;
    expect(a2 && b2).toBeTruthy();
    expect(added).toEqual([{ type: "pointsHorizontal", e1: a2.id, p1: 0, e2: b2.id, p2: 0 }]);
    expect([...live.s.overIdx]).toEqual([]);
  });

  it("across a horizontal line it stays a Horizontal", async () => {
    const { copies, added } = await mirrored(line("M", -10, 0, 60, 0));
    const a2 = at(copies, 10, -10)!, b2 = at(copies, 30, -10)!;
    expect(added).toEqual([{ type: "pointsHorizontal", e1: a2.id, p1: 0, e2: b2.id, p2: 0 }]);
  });

  it("across a 45 degree line it becomes a Vertical: the copies line up", async () => {
    const { copies, added } = await mirrored(line("M", 60, -20, 100, 20)); // y = x - 80
    // (x, y) reflects to (y + 80, x - 80)
    const a2 = at(copies, 90, -70)!, b2 = at(copies, 90, -50)!;
    expect(a2 && b2).toBeTruthy();
    expect(added).toEqual([{ type: "pointsVertical", e1: a2.id, p1: 0, e2: b2.id, p2: 0 }]);
  });

  it("across a slanted line it stays behind, and the copies sit on the mirror image", async () => {
    const { copies, added } = await mirrored(line("M", 60, 0, 90, 40));
    expect(copies).toHaveLength(2);
    expect(added).toEqual([]);
  });
});
