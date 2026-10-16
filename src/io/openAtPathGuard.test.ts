// The welcome screen's recent-files list asks before it replaces unsaved work.
//
// File > Open, New and Close all ask "save your changes first?"; a click on a
// recent file did not: main.ts's onOpenPath went straight to
// openDocumentAtPath, which had no guard, so the document on screen was
// replaced with no prompt and its autosave slot was left to be offered again
// on the next launch.
//
// This half pins openDocumentAtPath's guard parameter through the real Open
// handler with only the Tauri IPC floor faked, plus the main.ts wiring by
// source. The click on the real row, over the real welcome, is in
// e2e/unsaved_changes_guard_e2e.cjs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mainSrc from "../main.ts?raw";

const h = vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    __TAURI_INTERNALS__: {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  const ls = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v) };
  return { invoked: [] as string[], files: new Map<string, string>(), ls };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    h.invoked.push(cmd);
    if (cmd === "container_is_container") return true;
    if (cmd === "container_open") return h.files.get(args["path"] as string);
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: async (m: string) => { throw new Error(`unexpected dialog: ${m}`); },
}));

import { DocumentStore } from "../document/store";
import { openDocumentAtPath } from "./files";
import { getRecentFiles } from "./recentFiles";
import type { GeometryBackend } from "../geometry/client";

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {}, onStatus() { return () => {}; }, connected: true,
} as unknown as GeometryBackend;
const THEIRS = "/home/me/theirs.sindri";
const box = (id: string) => ({ id, type: "box", length: 5, width: 5, height: 5 });

/** Unsaved work on screen: load() marks the store dirty. */
function myWork() {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  store.load(JSON.stringify({ parameters: {}, features: [box("mine1")] }));
  return store;
}
const ids = (s: DocumentStore) => s.document.features.map((f) => f.id);

beforeEach(() => {
  h.invoked.length = 0;
  h.ls.clear();
  h.files.set(THEIRS, JSON.stringify({ version: 5, parameters: {}, features: [box("theirs1")] }));
});

describe("openDocumentAtPath's unsaved-changes guard", () => {
  it("a refused guard keeps the work and reads nothing", async () => {
    const store = myWork();
    expect(await openDocumentAtPath(store, THEIRS, undefined, async () => false)).toBe("cancelled");
    expect(ids(store)).toEqual(["mine1"]);
    expect(store.dirty).toBe(true);
    expect(store.filePath).toBe(null);
    expect(h.invoked).toEqual([]); // so a refusal can never read as "unreadable" and drop the row
    expect(getRecentFiles()).toEqual([]);
  });

  it("an accepted guard opens the file", async () => {
    const store = myWork();
    expect(await openDocumentAtPath(store, THEIRS, undefined, async () => true)).toBe("ok");
    expect(ids(store)).toEqual(["theirs1"]);
    expect(store.dirty).toBe(false);
    expect(store.filePath).toBe(THEIRS);
    expect(getRecentFiles().map((r) => r.path)).toEqual([THEIRS]);
  });

  it("is asked before anything is read", async () => {
    let readsWhenAsked = -1;
    await openDocumentAtPath(myWork(), THEIRS, undefined, async () => { readsWhenAsked = h.invoked.length; return true; });
    expect(readsWhenAsked).toBe(0);
  });
});

describe("main.ts wires the guard into the welcome's recent list", () => {
  const at = mainSrc.indexOf("onOpenPath:");
  const body = mainSrc.slice(at, mainSrc.indexOf("onSignIn:", at));

  it("asks the same question as File > Open", () => {
    expect(at, "no onOpenPath in main.ts").toBeGreaterThan(-1);
    expect(body).toContain('confirmDiscardChanges(store, t("file.close.confirmOpen"))');
  });

  // cancel() drops an open sketch without committing it, so it may only run
  // once the user has said go, exactly as openDoc does.
  it("asks before it cancels an open sketch", () => {
    const ask = body.indexOf("confirmDiscardChanges");
    const cancel = body.indexOf("sketch.cancel()");
    expect(cancel).toBeGreaterThan(ask);
    expect(ask).toBeGreaterThan(-1);
  });
});
