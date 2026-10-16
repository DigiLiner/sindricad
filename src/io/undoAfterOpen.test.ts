// Undo must not step back across File > Open, the recent list or Recover.
//
// load() used to push the OUTGOING document onto the undo stack. undo() swaps
// only the feature document, while the path, the suppress set, the rollback
// marker, the overlays and the palette already belong to the file just opened,
// so one Ctrl+Z too many put the previous document on screen under the new
// file's name, and the next Save wrote it over that file. On a fresh launch the
// previous document is the empty one, so the file was overwritten with nothing.
//
// Entered where the user enters: the real Open handler (openDocumentAtPath, the
// one File > Open, the palette and the welcome recent list share), the real
// Recover handler (checkRecovery) and the real Save handler, with only the
// Tauri IPC floor stood in by an in-memory disk. The effect observed is what
// Save writes, not the state of the undo stack.
import { describe, it, expect, vi, beforeEach } from "vitest";

const disk = vi.hoisted(() => {
  // isTauri() is `"__TAURI_INTERNALS__" in window`, and Open/Save note the file
  // in Recent (localStorage): stand up exactly those, nothing more
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
  return { files: new Map<string, string>(), slots: new Map<string, string>(), saves: [] as string[] };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "container_save") {
      disk.saves.push(args["path"] as string);
      return void disk.files.set(args["path"] as string, args["documentJson"] as string);
    }
    if (cmd === "container_is_container") return true;
    if (cmd === "container_open") return disk.files.get(args["path"] as string);
    if (cmd === "recovery_list") return [...disk.slots.keys()].map((s) => [s, 1]);
    if (cmd === "recovery_read") return disk.slots.get(args["slot"] as string) ?? null;
    if (cmd === "recovery_clear") return void disk.slots.delete(args["slot"] as string);
    return undefined;
  },
}));
// a dialog here would be an error report: fail loudly rather than swallow it
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: async (m: string) => { throw new Error(`unexpected dialog: ${m}`); },
}));
vi.mock("../ui/choice", () => ({ choose: async () => "recover" }));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));

import { DocumentStore } from "../document/store";
import { openDocumentAtPath, saveDocument } from "./files";
import { checkRecovery } from "./recovery";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, Feature } from "../types";

const A = "/home/me/A.sindri";
const B = "/home/me/B.sindri";
const box = (id: string): Feature => ({ id, type: "box", length: 10, width: 10, height: 10 } as unknown as Feature);
const doc = (...ids: string[]): CadDocument =>
  ({ version: 5, units: "mm", parameters: {}, features: ids.map(box) }) as unknown as CadDocument;

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {}, onStatus() { return () => {}; }, connected: true,
} as unknown as GeometryBackend;

/** main.ts starts every launch on an empty document. */
const launch = () => new DocumentStore(backend, { parameters: {}, features: [] });
const ids = (json: string) => (JSON.parse(json) as CadDocument).features.map((f) => f.id);

beforeEach(() => {
  disk.files.clear();
  disk.slots.clear();
  disk.saves.length = 0;
  disk.files.set(A, JSON.stringify(doc("a1", "a2", "a3")));
  disk.files.set(B, JSON.stringify(doc("b1")));
});

describe("undo after opening a document", () => {
  it("cannot bring the previous document back under the new file's name", async () => {
    const store = launch();
    expect(await openDocumentAtPath(store, A)).toBe("ok");
    expect(await openDocumentAtPath(store, B)).toBe("ok");
    const opened = store.toJSON();

    store.undo(); // Ctrl+Z
    expect(ids(store.toJSON())).toEqual(["b1"]);
    expect(store.toJSON()).toBe(opened);
    expect(store.filePath).toBe(B);
    expect(store.dirty).toBe(false);

    // the effect the report is about: what Ctrl+S writes, and where
    await saveDocument(store);
    expect(disk.saves).toEqual([B]);
    expect(ids(disk.files.get(B)!)).toEqual(["b1"]);
    expect(ids(disk.files.get(A)!)).toEqual(["a1", "a2", "a3"]);
    expect(store.canUndo).toBe(false); // so the undo button is off, too
  });

  it("on a fresh launch cannot empty the file just opened", async () => {
    const store = launch();
    expect(await openDocumentAtPath(store, B)).toBe("ok");
    store.undo();
    expect(ids(store.toJSON())).toEqual(["b1"]);
    expect(store.dirty).toBe(false);
  });

  // Guards against clearing too much: history made AFTER the open still works.
  it("still undoes and redoes an edit made after the open, and stops at the open", async () => {
    const store = launch();
    await openDocumentAtPath(store, A);
    await openDocumentAtPath(store, B);
    store.addFeature(box("b2"));
    expect(ids(store.toJSON())).toEqual(["b1", "b2"]);

    store.undo();
    expect(ids(store.toJSON())).toEqual(["b1"]);
    store.undo(); // one too many
    expect(ids(store.toJSON())).toEqual(["b1"]);
    expect(store.filePath).toBe(B);
    expect(store.canUndo).toBe(false);

    store.redo();
    expect(ids(store.toJSON())).toEqual(["b1", "b2"]);
  });
});

describe("undo after Recover", () => {
  it("keeps the recovered document", async () => {
    disk.slots.set("part_k9x", JSON.stringify({ source: "/home/me/part.sindri", savedAt: Date.now(), doc: doc("r1", "r2") }));
    const store = launch();
    await checkRecovery(store);
    expect(ids(store.toJSON())).toEqual(["r1", "r2"]);
    expect(store.dirty).toBe(true); // recovered work is unsaved work

    store.undo();
    expect(ids(store.toJSON())).toEqual(["r1", "r2"]);
    expect(store.canUndo).toBe(false);
  });
});
