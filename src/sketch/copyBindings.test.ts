// Copy and Mirror keep the parameter bindings of the dimensions they carry
// (decided 2026-10-18; 0.1.254 copied them as plain numbers). Change the
// parameter, and the original and the copy both follow. The rule is Copy
// sketch to plane's (decision B4, sketchPlaneEdits.copySketch):
//
//   - a dimension bound under a name the user gave (`width`) has its copy
//     follow that name;
//   - one bound under an auto name (d1) holds the source's expression, and a
//     reference in it to the auto name of another copied dimension is pointed
//     at that dimension's copy at Finish (the copy has no dN of its own
//     before), so a relation inside what was copied holds inside the copy;
//   - a copied shape's own numbers (a polygon's radius) are carried the same
//     way, but not its position, which would pull the copy back onto the
//     source.
//
// A mirror reads some values the other way round (mirror.ts), and the
// binding with them: an X distance that negates is bound to minus the
// expression. Undo and Redo of the copy take its bindings away and bring them
// back with the geometry.
//
// Driven through the tools' own clicks on a SketchMode editing a sketch of a
// REAL document store, committed the way Finish commits it, and judged on
// the numbers the parameters engine and the solver write back.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
// the store's debounced rebuild timer
(globalThis as unknown as { window: unknown }).window ??= { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };

import { liveSketch } from "./liveSketch.testkit";
import { noteConstraintId, noteEntityId } from "./id";
import { signedAngleDeg } from "./geom2d";
import { lineOperand } from "./entityDims";
import { polygonPoints } from "./region";
import { DocumentStore } from "../document/store";
import type { CadDocument, Feature, ParamDef, ParamTarget, RebuildReply, SketchConstraint } from "../types";
import type { GeometryBackend } from "../geometry/client";
import type { ResolvedEntity } from "./snap";

function stubBackend(): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}

type SketchFeature = Extract<Feature, { type: "sketch" }>;
const C = (constraint: string): ParamTarget => ({ kind: "constraint", sketch: "s1", constraint });
const E = (entity: string, field: string): ParamTarget => ({ kind: "entity", sketch: "s1", entity, field });
const def = (expr: string, value: number, target: ParamTarget, unit: ParamDef["unit"] = "mm"): ParamDef => ({ expr, value, unit, target });

interface Mode {
  pendingBindings: Map<string, { expr: string; name?: string; refs?: Record<string, string> }>;
  syncParamValues(): void;
  drainBindings(id: string): never;
  snapshotFeature(): Feature;
  redoEdit(): boolean;
  conflict: boolean;
}

/** a store holding sketch s1 with `ents` and `cons` and the parameter table
 *  `defs`, and a SketchMode editing it */
function editing(ents: ResolvedEntity[], cons: SketchConstraint[], defs: Record<string, ParamDef>) {
  for (const c of cons) if ("id" in c && c.id) noteConstraintId(c.id);
  for (const e of ents) noteEntityId(e.id);
  const sketch = { id: "s1", type: "sketch", plane: "XY", entities: structuredClone(ents), constraints: structuredClone(cons) } as SketchFeature;
  const parameters = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value]));
  const store = new DocumentStore(stubBackend(), { parameters, paramDefs: structuredClone(defs), features: [sketch] } as unknown as CadDocument);
  const live = liveSketch(structuredClone(ents), structuredClone(cons));
  Object.assign(live.s, { store, editingId: "s1", planeId: null, faceAnchor: null });
  return { live, store, mode: live.s as unknown as Mode };
}

/** wait for the store's queued parameter commit to land */
async function paramsLanded(store: DocumentStore, name: string, value: number) {
  for (let i = 0; i < 200; i++) {
    if (store.document.parameters[name] === value) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`parameter ${name} never became ${value}`);
}

const dimById = (cons: readonly SketchConstraint[], id: string) =>
  cons.find((c) => "id" in c && c.id === id) as (SketchConstraint & { value: number }) | undefined;

/** Finish, as SketchMode.finish commits an edited sketch */
function commit(store: DocumentStore, mode: Mode) {
  store.replaceFeature("s1", mode.snapshotFeature(), mode.drainBindings("s1"));
}
const saved = (store: DocumentStore) => store.document.features.find((f) => f.id === "s1") as SketchFeature;
const boundTo = (store: DocumentStore, target: ParamTarget) =>
  Object.entries(store.document.paramDefs ?? {}).find(([, d]) => JSON.stringify(d.target) === JSON.stringify(target));

describe("Copy keeps the parameter bindings of what it copies", () => {
  // two lines and a circle, a relation between them through auto names
  // (circle = width / 2, short line = circle / 2), and a hexagon whose radius
  // and position are parameters
  const ENTS = (): ResolvedEntity[] => [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 20, y2: 0 },
    { type: "line", id: "b", x1: 0, y1: 10, x2: 5, y2: 10 },
    { type: "circle", id: "k", x: 40, y: 0, radius: 5 },
    { type: "polygon", id: "P", x: 60, y: 0, radius: 4, sides: 6, angle: 0 },
  ];
  const CONS = (): SketchConstraint[] => [
    { type: "horizontal", line: "a" },
    { type: "horizontal", line: "b" },
    { type: "distance", id: "c1", line: "a", value: 20 },
    { type: "diameter", id: "c3", circle: "k", value: 10 },
    { type: "distance", id: "c5", line: "b", value: 5 },
  ];
  const DEFS = (): Record<string, ParamDef> => ({
    width: def("20", 20, C("c1")),
    d1: def("width / 2", 10, C("c3")),
    d2: def("d1 / 2", 5, C("c5")),
    r0: def("4", 4, E("P", "radius")),
    px: def("60", 60, E("P", "x")),
  });

  /** select everything, Copy it 100 mm along X */
  async function copied() {
    const ctx = editing(ENTS(), CONS(), DEFS());
    const { live } = ctx;
    live.s.requestSolve();
    await live.settle();
    const known = new Set(live.s.entities.map((e) => e.id));
    const consBefore = live.s.constraints.length;
    for (const e of ENTS()) live.s.selected.add(e.id);
    live.s.setTool("copy");
    live.click(200, 200);
    live.click(300, 200);
    await live.settle();
    const copies = live.s.entities.filter((e) => !known.has(e.id));
    const at = (x: number, y: number) => copies.find((e) => "x1" in e ? e.x1 === x && e.y1 === y : "x" in e && e.x === x && e.y === y)!.id;
    const of = { a: at(100, 0), b: at(100, 10), k: at(140, 0), P: at(160, 0) };
    const added = live.s.constraints.slice(consBefore);
    const dimOf = (type: string, operand: string) => added.find((c) => c.type === type && JSON.stringify(c).includes(`"${operand}"`)) as SketchConstraint & { id: string; value: number };
    const ids = { c1: dimOf("distance", of.a).id, c3: dimOf("diameter", of.k).id, c5: dimOf("distance", of.b).id };
    return { ...ctx, of, ids };
  }

  it("the copy's dimensions are bound as the source's are", async () => {
    const { mode, of, ids } = await copied();
    const pend = Object.fromEntries(mode.pendingBindings);
    expect(pend[`c:${ids.c1}`]?.expr, "a named parameter: the copy follows the name").toBe("width");
    expect(pend[`c:${ids.c3}`]?.expr, "an auto one: the copy holds its expression").toBe("width / 2");
    expect(pend[`c:${ids.c5}`]).toMatchObject({ expr: "d1 / 2", refs: { d1: `c:${ids.c3}` } });
    expect(pend[`e:${of.P}:radius`]?.expr, "a shape's own size").toBe("r0");
    expect(pend[`e:${of.P}:x`], "but not its position").toBeUndefined();
  });

  it("change the parameter, and the original and the copy both follow, open and after Finish", async () => {
    const { live, store, mode, ids } = await copied();
    // while the sketch is open
    expect(store.setParamExpr("width", "30")).toBeNull();
    await paramsLanded(store, "width", 30);
    mode.syncParamValues();
    await live.settle();
    const v = (id: string) => dimById(live.s.constraints, id)?.value;
    expect([v("c1"), v(ids.c1)]).toEqual([30, 30]);
    expect([v("c3"), v(ids.c3)]).toEqual([15, 15]);
    expect([v("c5"), v(ids.c5)]).toEqual([7.5, 7.5]);
    expect(mode.conflict).toBe(false);

    // Finish: every copy has a parameter of its own, and the copy of the
    // short line is a quarter of the copy of the circle, not of the source's
    commit(store, mode);
    const [circle2] = boundTo(store, C(ids.c3))!;
    expect(boundTo(store, C(ids.c1))![1].expr).toBe("width");
    expect(boundTo(store, C(ids.c5))![1].expr).toBe(`${circle2} / 2`);
    expect(store.setParamExpr(circle2, "8")).toBeNull();
    await paramsLanded(store, circle2, 8);
    const w = (id: string) => dimById(saved(store).constraints ?? [], id)?.value;
    expect([w(ids.c3), w(ids.c5)], "the copy's relation holds inside the copy").toEqual([8, 4]);
    expect([w("c3"), w("c5")], "and the source keeps its own").toEqual([15, 7.5]);
    expect(store.setParamExpr("width", "40")).toBeNull();
    await paramsLanded(store, "width", 40);
    expect([w("c1"), w(ids.c1)]).toEqual([40, 40]);
  });

  it("one Undo takes the copy's bindings away with it, and Redo brings them back", async () => {
    const { live, mode } = await copied();
    const after = new Map(mode.pendingBindings);
    expect(after.size).toBeGreaterThan(0);
    live.s.undoEdit();
    await live.settle();
    expect([...mode.pendingBindings]).toEqual([]);
    mode.redoEdit();
    await live.settle();
    expect([...mode.pendingBindings]).toEqual([...after]);
  });
});

describe("bindings in the undo history", () => {
  it("a name given in the parameters panel is its own undo step, and survives undoing a later edit", async () => {
    const line = { type: "line", id: "a", x1: 0, y1: 0, x2: 20, y2: 0 } as ResolvedEntity;
    const { live, mode } = editing([line, { type: "line", id: "b", x1: 0, y1: 10, x2: 5, y2: 10 }], [{ type: "distance", id: "c1", line: "a", value: 20 }], {});
    const m = live.s as unknown as { panelDims(): { rows: { entities: string[] }[] }; namePanelDim(row: unknown, name: string): string | null };
    const row = m.panelDims().rows.find((r) => r.entities.join() === "a")!; // the line's length
    expect(m.namePanelDim(row, "width")).toBeNull();
    // a later edit: delete the other line
    live.s.selected.add("b");
    (live.s as unknown as { deleteSelected(): void }).deleteSelected();
    await live.settle();
    live.s.undoEdit();
    await live.settle();
    expect(live.ent("b"), "the delete is undone").toBeDefined();
    expect(mode.pendingBindings.get("c:c1")?.name, "and the name is still there").toBe("width");
    live.s.undoEdit();
    await live.settle();
    expect(mode.pendingBindings.has("c:c1"), "the next Undo takes the name back").toBe(false);
  });
});

describe("Mirror keeps the parameter bindings, read the mirrored way", () => {
  const ENTS = (): ResolvedEntity[] => [
    { type: "line", id: "M", x1: 50, y1: -20, x2: 50, y2: 60 },
    { type: "line", id: "a", x1: 0, y1: 0, x2: 20, y2: 0 },
    { type: "line", id: "s", x1: 20, y1: 0, x2: 30, y2: 10 },
    { type: "point", id: "q", x: 25, y: 30 },
  ];
  const CONS = (): SketchConstraint[] => [
    { type: "horizontal", line: "a" },
    { type: "coincident", e1: "a", p1: 1, e2: "s", p2: 0 },
    { type: "distance", id: "c1", line: "a", value: 20 },
    { type: "angle", id: "c2", l1: "a", l2: "s", value: 45, place: { ox: 3, oy: 1 } },
    { type: "p2pDistanceX", id: "c3", e1: "a", p1: 1, e2: "q", p2: 0, value: 5 },
    { type: "p2pDistanceY", id: "c4", e1: "a", p1: 1, e2: "q", p2: 0, value: 30 },
  ];
  const DEFS = (): Record<string, ParamDef> => ({
    tilt: def("45", 45, C("c2"), "deg"),
    gap: def("5", 5, C("c3")),
  });

  it("an X distance that turns round is bound to minus its parameter; the angle follows its own", async () => {
    const { live, store, mode } = editing(ENTS(), CONS(), DEFS());
    live.s.requestSolve();
    await live.settle();
    const consBefore = live.s.constraints.length;
    for (const id of ["a", "s", "q"]) live.s.selected.add(id);
    live.s.setTool("mirror");
    live.click(50, 30);
    await live.settle();
    const added = live.s.constraints.slice(consBefore);
    const x = added.find((c) => c.type === "p2pDistanceX") as SketchConstraint & { id: string; value: number };
    const ang = added.find((c) => c.type === "angle") as SketchConstraint & { id: string; value: number };
    expect([x.value, ang.value]).toEqual([-5, -45]);
    expect(mode.pendingBindings.get(`c:${x.id}`)?.expr).toBe("-(gap)");
    expect(mode.pendingBindings.get(`c:${ang.id}`)?.expr).toBe("tilt");

    expect(store.setParamExpr("gap", "8")).toBeNull();
    expect(store.setParamExpr("tilt", "60")).toBeNull();
    await paramsLanded(store, "tilt", 60);
    await paramsLanded(store, "gap", 8);
    mode.syncParamValues();
    await live.settle();
    expect(mode.conflict).toBe(false);
    const v = (id: string) => dimById(live.s.constraints, id)?.value;
    expect([v("c3"), v(x.id)], "the X distance and its mirror image").toEqual([8, -8]);
    expect([v("c2"), v(ang.id)], "the angle and its mirror image").toEqual([60, -60]);
  });

  it("an angle on a side the mirror reads backwards is bound to the supplement, and still holds what the copy shows", async () => {
    const P = { type: "polygon", id: "P", x: 20, y: 20, radius: 10, sides: 6, angle: 10 } as ResolvedEntity;
    const v = polygonPoints(20, 20, 10, 6, (10 * Math.PI) / 180);
    const ln = { type: "line", id: "ln", x1: v[1]!.x, y1: v[1]!.y, x2: v[1]!.x - 5, y2: v[1]!.y + 12 } as Extract<ResolvedEntity, { type: "line" }>;
    const by = new Map<string, ResolvedEntity>([["P", P], ["ln", ln]]);
    const was = signedAngleDeg(lineOperand(by, "P~0")!, ln);
    const { live, store, mode } = editing(
      [{ type: "line", id: "M", x1: -20, y1: -5, x2: 100, y2: -5 } as ResolvedEntity, P, ln],
      [
        { type: "coincident", e1: "ln", p1: 0, e2: "P", p2: 1 },
        { type: "angle", id: "c1", l1: "P~0", l2: "ln", value: was, place: { ox: 1, oy: 1 } },
      ],
      { tilt: def(String(Math.abs(was)), Math.abs(was), C("c1"), "deg") },
    );
    live.s.requestSolve();
    await live.settle();
    const consBefore = live.s.constraints.length;
    for (const id of ["P", "ln"]) live.s.selected.add(id);
    live.s.setTool("mirror");
    live.click(40, -5);
    await live.settle();
    const ang = live.s.constraints.slice(consBefore).find((c) => c.type === "angle") as Extract<SketchConstraint, { type: "angle" }> & { id: string };
    expect(mode.pendingBindings.get(`c:${ang.id}`)?.expr).toBe("180 - (tilt)");
    const tilt = Math.abs(was) + 5;
    expect(store.setParamExpr("tilt", String(tilt))).toBeNull();
    await paramsLanded(store, "tilt", tilt);
    mode.syncParamValues();
    await live.settle();
    expect(mode.conflict).toBe(false);
    const now = new Map(live.s.entities.map((e) => [e.id, e]));
    const copyAngle = dimById(live.s.constraints, ang.id)!.value;
    expect(Math.abs(copyAngle)).toBeCloseTo(180 - tilt, 9);
    expect(signedAngleDeg(lineOperand(now, ang.l1)!, lineOperand(now, ang.l2)!), "the copy solved to what it says").toBeCloseTo(copyAngle, 6);
    expect(Math.abs(signedAngleDeg(lineOperand(now, "P~0")!, lineOperand(now, "ln")!)), "and the source to the parameter").toBeCloseTo(tilt, 6);
  });
});
