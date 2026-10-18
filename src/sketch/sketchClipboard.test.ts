// Copy, Cut and Paste inside a sketch (Ctrl+C, Ctrl+X, Ctrl+V; keymap.ts
// turns the keys into the calls main.ts makes here). A paste is a Copy taken
// apart in time: the constraints and dimensions among what was copied come
// along by Copy's rule, with the parameters that drive them, and the copy
// lands with its middle under the pointer. The clipboard is the app's own
// and outlives the sketch, so what is copied in one sketch pastes into the
// next, on another plane too (the 2D coordinates are kept, as Copy sketch to
// plane keeps them). Every paste and every cut is one undo step.
//
// Driven through the real handlers: the key event reaches SketchMode's own
// listener, the pointer moves over the canvas, and the solve and the undo
// history are the real ones.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
// SketchMode's key handler narrows its target with instanceof
const g = globalThis as unknown as Record<string, unknown>;
for (const k of ["HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLElement"]) g[k] ??= class {};

import { liveSketch } from "./liveSketch.testkit";
import { SketchPlane } from "./plane";
import { noteConstraintId } from "./id";
import { t } from "../i18n";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type Line = Extract<ResolvedEntity, { type: "line" }>;

interface Clip {
  copySelection(): boolean;
  cutSelection(): boolean;
  pasteClipboard(): boolean;
  onKey(e: unknown): void;
  redoEdit(): boolean;
  conflict: boolean;
  pendingBindings: Map<string, { expr: string; kind: string; name?: string }>;
}

// an L of two lines with their lengths and a right angle, and a line nobody copies
const ENTS = (): ResolvedEntity[] => [
  { type: "line", id: "a", x1: 0, y1: 0, x2: 20, y2: 0 },
  { type: "line", id: "b", x1: 20, y1: 0, x2: 20, y2: 10 },
  { type: "line", id: "far", x1: 0, y1: 50, x2: 10, y2: 50 },
];
const CONS = (): SketchConstraint[] => [
  { type: "horizontal", line: "a" },
  { type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 },
  { type: "perpendicular", l1: "a", l2: "b" },
  { type: "distance", id: "c1", line: "a", value: 20 },
  { type: "distance", id: "c2", line: "b", value: 10 },
  { type: "parallel", l1: "a", l2: "far" }, // to something not copied: stays behind
];

async function open(ents = ENTS(), cons = CONS(), plane?: SketchPlane) {
  for (const c of cons) if ("id" in c && c.id) noteConstraintId(c.id);
  const live = liveSketch(ents, cons);
  if (plane) Object.assign(live.s, { plane });
  live.s.requestSolve();
  await live.settle();
  return { live, s: live.s as unknown as Clip & typeof live.s };
}
/** the pointer over the canvas at sketch point (x, y) */
const hover = (live: Awaited<ReturnType<typeof open>>["live"], x: number, y: number) => live.move(x, y);
const added = (live: Awaited<ReturnType<typeof open>>["live"], before: number) => live.s.entities.slice(before);

beforeEach(() => {
  toasts.length = 0;
});

describe("Copy and Paste inside a sketch", () => {
  it("Ctrl+C in a sketch no longer arms the Circle tool", async () => {
    const { live, s } = await open();
    s.onKey({ key: "c", ctrlKey: true, metaKey: false, shiftKey: false, target: null, preventDefault() {} });
    expect(live.s.tool).toBe("select");
  });

  it("a paste lands under the pointer with the constraints and dimensions among what was copied", async () => {
    const { live, s } = await open();
    live.s.selected.add("a");
    live.s.selected.add("b");
    expect(s.copySelection()).toBe(true);
    expect(toasts).toEqual([t("sketch.clipboard.copied", { count: 2 })]);
    hover(live, 100, 40);
    const n = live.s.entities.length, k = live.s.constraints.length;
    expect(s.pasteClipboard()).toBe(true);
    await live.settle();
    const [a2, b2] = added(live, n) as [Line, Line];
    // the middle of what was copied (10, 5) is under the pointer
    expect([a2.x1, a2.y1, a2.x2, a2.y2]).toEqual([90, 35, 110, 35]);
    expect([b2.x1, b2.y1, b2.x2, b2.y2]).toEqual([110, 35, 110, 45]);
    const dims = live.s.constraints.slice(k).flatMap((c) => ("id" in c && c.id ? [c.id] : []));
    expect(live.s.constraints.slice(k)).toEqual([
      { type: "horizontal", line: a2.id },
      { type: "coincident", e1: a2.id, p1: 1, e2: b2.id, p2: 0 },
      { type: "perpendicular", l1: a2.id, l2: b2.id },
      { type: "distance", id: dims[0], line: a2.id, value: 20 },
      { type: "distance", id: dims[1], line: b2.id, value: 10 },
    ]);
    expect(dims.some((id) => id === "c1" || id === "c2")).toBe(false);
    expect([...live.s.selected].sort(), "the paste is selected").toEqual([a2.id, b2.id].sort());
    expect(s.conflict).toBe(false);
    expect([...live.s.overIdx]).toEqual([]);
    // a second paste is a second copy, under the pointer where it is now
    hover(live, -50, -50);
    s.pasteClipboard();
    await live.settle();
    const [a3] = added(live, n + 2) as [Line];
    expect([a3.x1, a3.y1]).toEqual([-60, -55]);
  });

  it("each paste is one undo step, and Redo brings it back", async () => {
    const { live, s } = await open();
    live.s.selected.add("a");
    live.s.selected.add("b");
    s.copySelection();
    hover(live, 100, 40);
    const before = { entities: structuredClone(live.s.entities), constraints: structuredClone(live.s.constraints) };
    s.pasteClipboard();
    await live.settle();
    const after = { entities: structuredClone(live.s.entities), constraints: structuredClone(live.s.constraints) };
    live.s.undoEdit();
    await live.settle();
    expect(live.s.entities).toEqual(before.entities);
    expect(live.s.constraints).toEqual(before.constraints);
    s.redoEdit();
    await live.settle();
    expect(live.s.entities).toEqual(after.entities);
    expect(live.s.constraints).toEqual(after.constraints);
  });

  it("Ctrl+X copies and deletes in one undo step; the clipboard keeps what was cut", async () => {
    const { live, s } = await open();
    live.s.selected.add("a");
    live.s.selected.add("b");
    expect(s.cutSelection()).toBe(true);
    await live.settle();
    expect(live.s.entities.some((e) => e.id === "a" || e.id === "b")).toBe(false);
    expect(live.s.constraints.some((c) => JSON.stringify(c).includes('"a"'))).toBe(false);
    hover(live, 10, 5);
    const n = live.s.entities.length;
    s.pasteClipboard();
    await live.settle();
    const [a2] = added(live, n) as [Line];
    expect([a2.x1, a2.y1, a2.x2, a2.y2], "pasted back where it was").toEqual([0, 0, 20, 0]);
    // undo the paste, then the cut: the original is back
    live.s.undoEdit();
    await live.settle();
    live.s.undoEdit();
    await live.settle();
    expect(live.s.entities.filter((e) => e.id === "a" || e.id === "b").map((e) => e.id)).toEqual(["a", "b"]);
    expect(live.s.constraints).toEqual(CONS());
  });

  it("what is copied in one sketch pastes into the next, on another plane, constraints and parameters with it", async () => {
    const first = await open();
    first.live.s.selected.add("a");
    first.live.s.selected.add("b");
    // and a text that runs along the line nobody copies
    first.live.s.entities.push({ type: "text", id: "tx", text: "hi", x: 0, y: 50, height: 3, pathRef: "far" } as ResolvedEntity);
    first.live.s.selected.add("tx");
    first.s.pendingBindings.set("c:c1", { expr: "40", kind: "length", name: "width" });
    first.s.copySelection();
    // Finish that one; open another, on the XZ plane, with nothing in it
    const second = await open([], [], new SketchPlane("XZ"));
    second.s.pendingBindings.set("c:c99", { expr: "40", kind: "length", name: "width" }); // the name is known here
    hover(second.live, 30, 30);
    expect(second.s.pasteClipboard()).toBe(true);
    await second.live.settle();
    const lines = second.live.s.entities.filter((e) => e.type === "line" && !e.id.startsWith("__")) as Line[];
    const text = second.live.s.entities.find((e) => e.type === "text");
    expect(text && "pathRef" in text, "the text is straight here: its path is in the other sketch").toBe(false);
    // the middle of what was copied, (10, 25) with the text, under the pointer
    expect(lines.map((l) => [l.x1, l.y1, l.x2, l.y2])).toEqual([[20, 5, 40, 5], [40, 5, 40, 15]]);
    const dist = second.live.s.constraints.find((c) => c.type === "distance" && c.line === lines[0]!.id) as { id: string };
    expect(second.s.pendingBindings.get(`c:${dist.id}`)?.expr, "the pasted length follows `width`").toBe("width");
    expect(second.live.s.constraints).toHaveLength(5);
  });

  it("with nothing selected, Copy says what to do and leaves the clipboard alone", async () => {
    const { live, s } = await open();
    live.s.selected.add("a");
    s.copySelection();
    live.s.selected.clear();
    toasts.length = 0;
    expect(s.copySelection()).toBe(false);
    expect(toasts).toEqual([t("sketch.clipboard.nothingSelected")]);
    hover(live, 10, -20);
    const n = live.s.entities.length;
    s.pasteClipboard();
    expect(added(live, n)).toHaveLength(1);
  });
});

