// A value the user TYPES into a draw-time dim box (a centre rectangle's width/
// height, a circle's diameter) used to size the fresh entity and then vanish:
// no constraint held it, so the very next Equal or drag-driven resize could
// carry it away, and the only way to pin it back down was a separate Lock
// click on the badge. Reports 71b9955e (rectangle) and 75d4e294 (circle).
//
// Retyping an EXISTING rectangle's width/height had the same gap the other
// way round: a circle's diameter or a line's length auto-locks the moment you
// retype it (directDims.drivingDimFor), a rectangle's did not. Report
// e9742a4f: "in other dimensions that are not locked, if I change them they
// become locked" — true for everything except a rectangle.
//
// Decided scope (Thomas): rectangle width/height and circle diameter only.
// Slot width, polygon radius and line angle stay direct writes — lockDimFor
// has no constraint form for them, so there is nothing to auto-lock to.
//
// These drive the real private methods off SketchMode.prototype — no WebGL,
// same technique as dimFieldRefusal.test.ts. The solve itself is stubbed
// everywhere except the one test that needs to observe the geometry move
// (editDimension on an existing entity), which sets solverDead so the no-solver
// fallback (applyDrivingDimsDirectly) runs synchronously instead.
import { describe, it, expect } from "vitest";
import * as THREE from "three";

const toasts: string[] = [];
import { vi } from "vitest";
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { SketchMode } from "./sketchMode";
import { governingDimAt } from "./directDims";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

type FieldState = { typed: boolean; value: number | null };
function fakeDim(fields: Record<string, FieldState>) {
  return {
    isUserDriven: (n: string) => fields[n]?.typed ?? false,
    getValue: (n: string) => fields[n]?.value ?? null,
    hide: () => {},
    show: () => {},
    updateFromCursor: () => {},
    position: () => {},
    setClickThrough: () => {},
    focus: () => {},
  };
}

interface Priv {
  commitFromCursor(cursor: THREE.Vector2): void;
  centerRectClick(p: THREE.Vector2): void;
  editDimension(index: number, field: string, mm: number): void;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  clickPts: THREE.Vector2[];
  solverDead: boolean;
}

function makeMode(tool: string, dim: ReturnType<typeof fakeDim>, base?: THREE.Vector2, over: Record<string, unknown> = {}) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    tool,
    dim,
    entities: [] as ResolvedEntity[],
    constraints: [] as SketchConstraint[],
    clickPts: [] as THREE.Vector2[],
    trial: null,
    base: base ?? null,
    baseRef: null,
    baseCurve: null,
    lastSnapRef: null,
    lastSnapCurve: null,
    rectCenterRef: null,
    rectCenterCurve: null,
    chainStart: null,
    constructionMode: false,
    solverDead: false,
    plane: { to3D: (x: number, y: number) => new THREE.Vector3(x, y, 0) },
    overlay: { setPreview: () => {} },
    refreshActive: () => {},
    requestSolve: () => {},
    onState: undefined,
    ...over,
  });
  return s as unknown as SketchMode & Priv;
}

describe("71b9955e/75d4e294: a draw-time typed value locks on commit", () => {
  it("a centre rectangle's typed width AND height both lock", () => {
    const dim = fakeDim({ width: { typed: true, value: 60 }, height: { typed: true, value: 40 } });
    const s = makeMode("centerRectangle", dim);
    s.centerRectClick(new THREE.Vector2(0, 0)); // centre
    s.centerRectClick(new THREE.Vector2(30, 20)); // corner — ignored, W/H are typed
    expect(s.entities).toHaveLength(1);
    const rect = s.entities[0];
    expect(rect).toMatchObject({ type: "rectangle", width: 60, height: 40 });
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
    expect(governingDimAt(s.constraints, rect, "height")).not.toBe("free");
  });

  it("a centre rectangle with only width typed locks width, leaves height free", () => {
    const dim = fakeDim({ width: { typed: true, value: 60 } });
    const s = makeMode("centerRectangle", dim);
    s.centerRectClick(new THREE.Vector2(0, 0));
    s.centerRectClick(new THREE.Vector2(30, 20)); // height comes from the drag
    const rect = s.entities[0]!;
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
    expect(governingDimAt(s.constraints, rect, "height")).toBe("free"); // left to the drag, as always
  });

  it("a corner-to-corner rectangle's typed width/height locks the same way", () => {
    const dim = fakeDim({ width: { typed: true, value: 60 }, height: { typed: true, value: 40 } });
    const s = makeMode("rectangle", dim, new THREE.Vector2(0, 0));
    s.commitFromCursor(new THREE.Vector2(5, 5)); // cursor ignored: both fields are typed
    const rect = s.entities[0]!;
    expect(rect).toMatchObject({ type: "rectangle", width: 60, height: 40 });
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
    expect(governingDimAt(s.constraints, rect, "height")).not.toBe("free");
  });

  it("a drawn circle's typed diameter locks on commit", () => {
    const dim = fakeDim({ diameter: { typed: true, value: 20 } });
    const s = makeMode("circle", dim, new THREE.Vector2(0, 0));
    s.commitFromCursor(new THREE.Vector2(5, 0)); // cursor distance ignored: diameter is typed
    const circle = s.entities[0]!;
    expect(circle).toMatchObject({ type: "circle", radius: 10 });
    expect(s.constraints).toMatchObject([{ type: "diameter", circle: circle.id, value: 20 }]);
  });

  it("an un-typed drawn circle (dragged size) stays free, as before", () => {
    const dim = fakeDim({});
    const s = makeMode("circle", dim, new THREE.Vector2(0, 0));
    s.commitFromCursor(new THREE.Vector2(5, 0));
    const circle = s.entities[0]!;
    expect(governingDimAt(s.constraints, circle, "diameter")).toBe("free");
  });
});

describe("e9742a4f: retyping an EXISTING rectangle's dim now auto-locks too", () => {
  it("editDimension on a circle's diameter still auto-locks (drivingDimFor, unchanged)", () => {
    const dim = fakeDim({});
    const s = makeMode("select", dim);
    s.entities = [{ type: "circle", id: "c1", x: 0, y: 0, radius: 5 }];
    s.editDimension(0, "diameter", 30);
    expect(s.constraints).toMatchObject([{ type: "diameter", circle: "c1", value: 30 }]);
  });

  it("editDimension on a rectangle's width now auto-locks instead of staying free", () => {
    const dim = fakeDim({});
    // No real solver in this stub, so force the no-solver fallback
    // (applyDrivingDimsDirectly) to observe the write synchronously — the
    // same path a machine with no solver takes in the real app.
    const s = makeMode("select", dim, undefined, { solverDead: true });
    s.entities = [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 50 }];
    s.editDimension(0, "width", 60);
    const rect = s.entities[0]!;
    expect(rect).toMatchObject({ width: 60 });
    expect(governingDimAt(s.constraints, rect, "width")).not.toBe("free");
  });
});
