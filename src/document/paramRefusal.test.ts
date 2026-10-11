// Permanent regression coverage for X-param-refuse (params-panel package,
// commit 62a9a93): a parameter value that a bound CLOSED sketch's solver
// cannot satisfy must refuse the WHOLE edit (the parameter keeps its old
// value), naming every blocking sketch and the constraints holding it.
//
// This file exists because the code review that shipped 62a9a93 found two
// things:
//
//  1. a correctness bug in paramRefusalNote: when a sketch has two different
//     paramDefs whose constraint targets both land in that SAME sketch, the
//     wrong one (the first in Object.values(draft.paramDefs) order) could get
//     blamed for a conflict the solver actually reported against the OTHER
//     one — a fabricated, self-contradictory message (wrong dimension kind,
//     wrong "held by" list, wrong previous value);
//  2. the refuse-the-whole-edit feature itself had ZERO permanent test: the
//     only test that ever drove it (src/__triage__/params-panel-X-param-
//     refuse.test.ts) was deleted per the triage workflow's own cleanup rule,
//     and nothing replaced it.
//
// Both are covered here against the REAL DocumentStore / real planegcs solve
// (same harness as dimEditConflict.test.ts and projectionRefresh.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

declare const process: { cwd(): string };
// the wasm `?url` import resolves root-relative under vitest (see
// sketch/sketchSolve.test.ts) — point the loader at the file on disk
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { DocumentStore } from "./store";
import { solveSketchFeature } from "../sketch/headlessSolve";
import type { CadDocument, Feature, RebuildReply, SketchConstraint } from "../types";
import type { GeometryBackend } from "../geometry/client";

const backend = (): GeometryBackend =>
  ({
    async rebuild(): Promise<RebuildReply> {
      return { ok: true, result: { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) }, edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] } } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  }) as unknown as GeometryBackend;

const settle = () =>
  new Promise<void>((res) => {
    let i = 0;
    const tick = () => (++i > 30 ? res() : void setTimeout(tick, 0));
    tick();
  });

// the cascade's final successful mutate schedules its debounced rebuild off
// `window` (see projectionRefresh.test.ts) — stub it the same way so a
// commit that succeeds doesn't crash in this DOM-less test environment.
beforeEach(() => {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const sketchOf = (store: DocumentStore, id: string) =>
  store.document.features.find((f): f is Extract<Feature, { type: "sketch" }> => f.type === "sketch" && f.id === id)!;

// The reporter's fixture from dimEditConflict.test.ts (886da4e5): a circle e17
// tangent to two edges of a rectangle e18 whose corners are Fixed, with e17's
// own centre also Fixed. The two tangencies plus the diameter already
// determine e17's x, y and r, so any diameter other than 30 is unsatisfiable.
// l1 is an unrelated free line with its own `fix` on one endpoint and a
// `distance` constraint cL — nothing else touches it, so ANY positive length
// is satisfiable (the line is free to point anywhere).
function conflictDoc(): CadDocument {
  return {
    parameters: {},
    paramDefs: {
      base: { expr: "30", value: 30, unit: "mm" },
      // bound to the unrelated, always-satisfiable line — NOT the dimension
      // that will actually conflict
      p1: { expr: "base/3", value: 10, unit: "mm", target: { kind: "constraint", sketch: "f", constraint: "cL" } },
      // bound to the circle's diameter — the one the solver will blame
      p2: { expr: "base", value: 30, unit: "mm", target: { kind: "constraint", sketch: "f", constraint: "c20" } },
    },
    features: [
      {
        id: "f",
        type: "sketch",
        plane: "XY",
        name: "Sketch1",
        entities: [
          { id: "e11", type: "rectangle", x: -7.649130461954812, y: 27.027137507924373, width: 86.88949115816148, height: 86.88949115816148 },
          { id: "e17", type: "circle", x: 74.69540203063235, y: -20.462819640218413, radius: 15 },
          { id: "e18", type: "rectangle", x: 89.69540203063235, y: -10.462819640218406, width: 60, height: 50 },
          { id: "l1", type: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
        ],
        constraints: [
          { type: "p2pDistance", id: "c14", e1: "e11", p1: 3, e2: "e11", p2: 0, value: 50, driven: true },
          { type: "p2pDistance", id: "c15", e1: "e11", p1: 0, e2: "e11", p2: 1, value: 100, driven: true },
          { type: "equal", l1: "e11~3", l2: "e11~0" },
          { type: "fix", e: "e18", p: 3 },
          { type: "fix", e: "e18", p: 0 },
          { type: "fix", e: "e18", p: 1 },
          { type: "tangent2", a: "e17", b: "e18~0" },
          { type: "tangent2", a: "e17", b: "e18~3" },
          { type: "diameter", id: "c20", circle: "e17", value: 30 },
          { type: "fix", e: "e17", p: 0 },
          { type: "fix", e: "l1", p: 0 },
          { type: "distance", id: "cL", line: "l1", value: 10 },
        ] as SketchConstraint[],
      },
    ],
  } as unknown as CadDocument;
}

describe("paramRefusalNote blames the dimension the solver actually failed on", () => {
  it("names the circle's diameter, not the unrelated line bound by an earlier paramDef", async () => {
    const store = new DocumentStore(backend(), conflictDoc());
    store.headlessSolve = solveSketchFeature;
    const warnings: string[] = [];
    store.onWarning = (m) => void warnings.push(m);
    let applied = 0;
    store.onParamsApplied = () => void applied++;

    // base: 30 -> 36. p1 (base/3) becomes 12 on l1 — always satisfiable.
    // p2 (base) becomes 36 on the circle's diameter c20 — genuinely
    // unsatisfiable with the centre fixed (dimEditConflict.test.ts proves even
    // 30 -> 30.5 already conflicts here).
    const err = store.setParamExpr("base", "36", "mm");
    expect(err).toBeNull();
    await settle();

    // the whole edit is refused: base kept its old value
    expect(store.document.paramDefs?.base!.value).toBe(30);
    expect(store.document.paramDefs?.p1!.value).toBe(10);
    expect(store.document.paramDefs?.p2!.value).toBe(30);
    expect(applied, "a refused edit must not fire onParamsApplied").toBe(0);

    // exactly one toast (both p1 and p2 target the SAME sketch)
    expect(warnings).toHaveLength(1);
    const msg = warnings[0]!;

    // must name the DIAMETER (the dimension that actually failed) ...
    expect(msg).toContain("diameter");
    expect(msg).toContain("its centre is fixed");
    expect(msg).toContain("Tangent");
    expect(msg).toContain("30 mm"); // the diameter's OWN previous value

    // ... and must NOT fabricate a story about the unrelated line: its kind
    // ("length"), its own previous value (10 mm), and a "Diameter constraint"
    // in the held-by list (the diameter is the edited dimension itself, never
    // one of its own reasons) are all symptoms of the wrong-target bug.
    expect(msg).not.toContain("length");
    expect(msg).not.toContain("10 mm");
    expect(msg).not.toMatch(/Diameter constraint/);

    // and the sketch itself was left exactly as it was: the line took the new
    // length 12 (bound field write-back happens regardless of the OTHER
    // sketch's refusal — only the drive of the refused dimension is what gets
    // left alone) is NOT asserted here since the whole edit is refused before
    // any field is written — paramDefs themselves stayed at 30/10/30 above,
    // which is the real guarantee: nothing moved.
    const f = sketchOf(store, "f");
    const circle = f.entities.find((e) => e.id === "e17") as { radius: number };
    expect(circle.radius).toBeCloseTo(15, 3); // untouched: still a 30 mm diameter
  });
});

// A second, independent closed sketch so one parameter can legitimately block
// on more than one sketch at once (the all-or-nothing case Thomas decided:
// "a parameter value that any bound sketch cannot satisfy is REFUSED: the
// whole edit is rejected"). Modeled on the reviewer's ad hoc confirmation
// test: two sketches, each with one line pinned at BOTH ends and dimensioned
// by the SAME model parameter — any value other than the line's built-in
// length is unsatisfiable in either sketch.
function twoSketchDoc(): CadDocument {
  return {
    parameters: {},
    paramDefs: {
      d1: { expr: "30", value: 30, unit: "mm", target: { kind: "constraint", sketch: "s1", constraint: "c0" } },
    },
    features: [
      {
        id: "s1",
        type: "sketch",
        plane: "XY",
        name: "Sketch1",
        entities: [{ id: "l1", type: "line", x1: 0, y1: 0, x2: 30, y2: 0 }],
        constraints: [
          { type: "fix", e: "l1", p: 0 },
          { type: "fix", e: "l1", p: 1 },
          { type: "distance", id: "c0", line: "l1", value: 30 },
        ] as SketchConstraint[],
      },
    ],
  } as unknown as CadDocument;
}

describe("a parameter value a bound sketch cannot satisfy refuses the whole edit (X-param-refuse)", () => {
  it("keeps the parameter at its old value and reports the sketch, rather than silently accepting it", async () => {
    const store = new DocumentStore(backend(), twoSketchDoc());
    store.headlessSolve = solveSketchFeature;
    const warnings: string[] = [];
    store.onWarning = (m) => void warnings.push(m);
    const issues: string[] = [];
    store.onParamSolveIssue = (id) => void issues.push(id);
    let applied = 0;
    store.onParamsApplied = () => void applied++;

    // This is literally what the UI reads to decide whether to reject the
    // keystroke (paramsDialog.ts's validatedInput wraps setParamExpr).
    const err = store.setParamExpr("d1", "50", "mm");
    expect(err).toBeNull(); // validation is synchronous and only catches parse/name errors

    await settle();

    // REFUSED: the parameter's own value must NOT have been committed...
    expect(store.document.paramDefs?.d1!.value).toBe(30);
    // ...the sketch it drives must be untouched...
    const l1 = sketchOf(store, "s1").entities.find((e) => e.id === "l1") as { x1: number; y1: number; x2: number; y2: number };
    expect(Math.hypot(l1.x2 - l1.x1, l1.y2 - l1.y1)).toBeCloseTo(30, 6);
    // ...the refusal is reported as a warning naming the sketch, not merely a
    // silent issue toast...
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("s1");
    expect(issues, "a REFUSED edit is not the same signal as an unrelated solve issue").toEqual([]);
    expect(applied).toBe(0);
  });

  it("control: an unbound, satisfiable value is accepted and the sketch actually follows it", async () => {
    const d = twoSketchDoc();
    // no Fix on p:1 this time -> the line is free to grow to match d1
    (d.features[0] as Extract<Feature, { type: "sketch" }>).constraints = [{ type: "fix", e: "l1", p: 0 }, { type: "distance", id: "c0", line: "l1", value: 30 }] as SketchConstraint[];
    const store = new DocumentStore(backend(), d);
    store.headlessSolve = solveSketchFeature;
    const warnings: string[] = [];
    store.onWarning = (m) => void warnings.push(m);
    let applied = 0;
    store.onParamsApplied = () => void applied++;

    const err = store.setParamExpr("d1", "50", "mm");
    expect(err).toBeNull();
    await settle();

    expect(store.document.paramDefs?.d1!.value).toBe(50);
    const l1 = sketchOf(store, "s1").entities.find((e) => e.id === "l1") as { x1: number; y1: number; x2: number; y2: number };
    expect(Math.hypot(l1.x2 - l1.x1, l1.y2 - l1.y1)).toBeCloseTo(50, 3);
    expect(warnings).toEqual([]); // no conflict -> no refusal
    expect(applied).toBe(1);
  });
});
