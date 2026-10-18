// Two-point Horizontal/Vertical got their own constraint types in format v8
// (explore-sketcher-1016-4). What that has to keep true across files:
//  - a sketch holding one is saved as v8, and the build before this one (it
//    reads up to v7) says on open that the file is from a newer version;
//  - an older file opens showing what it showed before: its zero X/Y
//    distances are alignments, converted where the file proves the
//    Horizontal/Vertical tool made one (no dimension id, no label placement)
//    and otherwise kept as the distance, marked to be shown as an alignment;
//  - a 0 mm distance made with the Dimension tool in this build stays a
//    distance through a save and an open.
//
// Entered where the user enters: the real Vertical tool's clicks, the sketch's
// own commit (snapshotFeature), the real Save and Open handlers. The older
// build is stood in for by its loader gate (migrateDocument reading up to v7),
// as in olderBuildFormat.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const disk = vi.hoisted(() => {
  // isTauri() is `"__TAURI_INTERNALS__" in window`, and Save notes the file in
  // Recent (localStorage): stand up exactly those, nothing more
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    __TAURI_INTERNALS__: {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
  const ls = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v) };
  return { files: new Map<string, string>() };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "container_save") return void disk.files.set(args["path"] as string, args["documentJson"] as string);
    if (cmd === "container_is_container") return true;
    if (cmd === "container_open") return disk.files.get(args["path"] as string);
    return undefined; // recovery_clear
  },
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { DocumentStore } from "../document/store";
import { sketchDimRows } from "../sketch/dimRows";
import { constraintGlyphs } from "../sketch/glyphs";
import { migrateDocument } from "../document/migrate";
import { liveSketch } from "../sketch/liveSketch.testkit";
import { resolveRealEntities } from "../sketch/resolve";
import { openDocumentAtPath, saveDocument } from "./files";
import { t } from "../i18n";
import type { GeometryBackend } from "../geometry/client";
import type { ResolvedEntity } from "../sketch/snap";
import type { CadDocument, Feature, SketchConstraint } from "../types";

/** The newest version the build before this one reads. */
const OLDER_BUILD_READS = 7;
const PATH = "/home/me/part.sindri";

const PA: ResolvedEntity = { type: "point", id: "a", x: 10, y: 0 };
const PB: ResolvedEntity = { type: "point", id: "b", x: 10, y: 20 };

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {}, onStatus() { return () => {}; }, connected: true,
} as unknown as GeometryBackend;

let warnings: string[];
beforeEach(() => { warnings = []; disk.files.clear(); });

function openStore(): DocumentStore {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  store.onWarning = (m) => void warnings.push(m); // main.ts: a toast
  return store;
}

/** Draw `ents` in a new sketch, click `tool` at each point in turn, and press
 *  Finish: the sketch's own snapshot, added the way finish() adds it. */
async function finishSketch(store: DocumentStore, ents: ResolvedEntity[], tool: string, ...at: { x: number; y: number }[]) {
  const live = liveSketch(ents);
  live.s.tool = tool as typeof live.s.tool;
  for (const q of at) live.click(q.x, q.y);
  await live.settle();
  Object.assign(live.s, { store, editingId: null });
  const sketch = (live.s as unknown as { snapshotFeature(): Feature | null }).snapshotFeature()!;
  store.addFeature(sketch);
  return sketch.type === "sketch" ? sketch.constraints ?? [] : [];
}

/** Save through the real handler and read back the document it wrote. */
async function save(store: DocumentStore): Promise<CadDocument> {
  store.markSaved(PATH);
  await saveDocument(store);
  return JSON.parse(disk.files.get(PATH)!) as CadDocument;
}

/** The one sketch's constraints, and what the panel and the canvas show for them. */
function shown(store: DocumentStore) {
  const sk = store.document.features.find((f) => f.type === "sketch");
  if (sk?.type !== "sketch") throw new Error("no sketch");
  const ents = resolveRealEntities(sk, {});
  const cons = sk.constraints ?? [];
  return {
    cons,
    rows: sketchDimRows(ents, cons).filter((r) => r.ref.kind === "constraint").map((r) => r.dim),
    glyphs: constraintGlyphs(ents, cons).map((g) => g.label),
  };
}

const file = (version: number, constraints: SketchConstraint[]) =>
  JSON.stringify({ version, parameters: {}, features: [{ id: "f1", type: "sketch", plane: "XY", entities: [PA, PB], constraints }] });

describe("a two-point Vertical is saved as v8", () => {
  it("made with the tool, saved, warned about in the older build, and opened here intact", async () => {
    const store = openStore();
    const made = await finishSketch(store, [PA, PB], "vertical", { x: 10, y: 0 }, { x: 10, y: 20 });
    expect(made).toEqual([{ type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 }]);
    const saved = await save(store);
    expect(saved.version).toBe(8);
    expect(migrateDocument(structuredClone(saved), OLDER_BUILD_READS)).toEqual([t("file.warning.newerVersion")]);

    const again = openStore();
    expect(await openDocumentAtPath(again, PATH)).toBe("ok");
    expect(warnings).toEqual([]);
    expect(shown(again)).toEqual({ cons: made, rows: [t("sketch.constraint.vertical")], glyphs: ["V", "V"] });
    expect((await save(again)).version).toBe(8);
  });
});

describe("an older file shows its zero distances as it did", () => {
  it("one the Vertical tool made and nothing reopened since (no id, no placement) becomes a two-point Vertical", async () => {
    // v7: a file the primitives build (placement, v7) wrote is older than v8 too
    disk.files.set(PATH, file(7, [{ type: "p2pDistanceX", e1: "a", p1: 0, e2: "b", p2: 0, value: 0 }]));
    const store = openStore();
    expect(await openDocumentAtPath(store, PATH)).toBe("ok");
    expect(warnings).toEqual([]);
    expect(shown(store)).toEqual({
      cons: [{ type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 }],
      rows: [t("sketch.constraint.vertical")],
      glyphs: ["V", "V"],
    });
  });

  it("one that may be either (it has an id) stays a distance, shown as the Vertical it was shown as", async () => {
    disk.files.set(PATH, file(6, [{ type: "p2pDistanceX", id: "c4", e1: "a", p1: 0, e2: "b", p2: 0, value: 0 }]));
    const store = openStore();
    expect(await openDocumentAtPath(store, PATH)).toBe("ok");
    const s = shown(store);
    expect(s.cons).toEqual([{ type: "p2pDistanceX", id: "c4", e1: "a", p1: 0, e2: "b", p2: 0, value: 0, alignment: true }]);
    expect(s.rows).toEqual([t("sketch.constraint.vertical")]);
    expect(s.glyphs).toEqual(["V", "V"]);
    // nothing in it an older build cannot read: not v8, and the same again on the next open
    const saved = await save(store);
    expect(saved.version).toBe(5);
    const again = openStore();
    expect(await openDocumentAtPath(again, PATH)).toBe("ok");
    expect(shown(again)).toEqual(s);
  });

  it("a REFERENCE zero distance was never an alignment, and is left alone", async () => {
    const ref: SketchConstraint = { type: "p2pDistanceX", id: "c4", e1: "a", p1: 0, e2: "b", p2: 0, value: 0, driven: true };
    disk.files.set(PATH, file(6, [ref]));
    const store = openStore();
    expect(await openDocumentAtPath(store, PATH)).toBe("ok");
    expect(shown(store).cons).toEqual([ref]);
  });
});

describe("a 0 mm distance the Dimension tool made in this build stays a distance", () => {
  it("through a save and an open", async () => {
    const zero: SketchConstraint = { type: "p2pDistanceX", id: "c5", e1: "a", p1: 0, e2: "b", p2: 0, value: 0, place: { ox: 0, oy: 30 } };
    const store = openStore();
    store.addFeature({ id: "f1", type: "sketch", plane: "XY", entities: [PA, PB], constraints: [zero] } as Feature);
    expect(shown(store).rows).toEqual([t("inspector.sketchDim.kind.horizontal")]);
    const saved = await save(store);
    // saved below v8 the next open would take it for an older file's, and mark it
    expect(saved.version).toBe(8);
    const again = openStore();
    expect(await openDocumentAtPath(again, PATH)).toBe("ok");
    expect(shown(again)).toEqual({ cons: [zero], rows: [t("inspector.sketchDim.kind.horizontal")], glyphs: [] });
  });
});

describe("a number typed into a closed sketch's alignment row", () => {
  it("makes it the X/Y distance it held at 0, as an open sketch's row does", async () => {
    const store = openStore();
    store.addFeature({ id: "f1", type: "sketch", plane: "XY", entities: [PA, PB], constraints: [
      { type: "pointsVertical", e1: "a", p1: 0, e2: "b", p2: 0 },
    ] } as Feature);
    const sk = store.document.features[0]!;
    if (sk.type !== "sketch") throw new Error("no sketch");
    const row = sketchDimRows(resolveRealEntities(sk, {}), sk.constraints ?? []).find((r) => r.ref.kind === "constraint")!;
    store.setSketchDimValue("f1", row, 7);
    await (store as unknown as { paramChain: Promise<void> }).paramChain;
    expect(shown(store).cons).toEqual([{ type: "p2pDistanceX", e1: "a", p1: 0, e2: "b", p2: 0, value: 7 }]);
    expect(shown(store).rows).toEqual([t("inspector.sketchDim.kind.horizontal")]);
  });
});
