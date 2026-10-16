// Recover must leave exactly one snapshot behind: the recovered document's own.
//
// Recover loaded the snapshot and did nothing with its slot. The recovered
// document is untitled, so its autosave writes to "untitled" and every later
// Save or Discard clears "untitled" plus the slot of whatever path it has by
// then, never the slot it was recovered from. Save the recovered work under a
// new name, quit cleanly, and the next launch offered the same stale work again.
//
// Each "launch" here is what main.ts does at startup (a fresh store, then
// installAutosave, then checkRecovery) against an in-memory recovery directory
// that behaves like lib.rs's recovery_* commands. The effect observed is what
// the NEXT launch offers and restores, not the order of the IPC calls: a fix
// that wrote the wrong bytes to "untitled" would pass a call-order test and
// restore nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  // isTauri() is `"__TAURI_INTERNALS__" in window`. The timers delegate AT CALL
  // TIME so vi.useFakeTimers() takes them over; Save As notes the file in
  // Recent (localStorage).
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
  return {
    /** app_data_dir/recovery: slot -> [json, mtime] */
    slots: new Map<string, [string, number]>(),
    clock: 0,
    savePath: null as string | null,
    pick: null as "recover" | "discard" | null,
    prompts: 0,
    failWrite: false,
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const slot = args?.["slot"] as string;
    switch (cmd) {
      case "recovery_list": // newest first, as lib.rs sorts by mtime
        return [...h.slots].map(([s, [, m]]) => [s, m]).sort((a, b) => (b[1] as number) - (a[1] as number));
      case "recovery_read":
        return h.slots.get(slot)?.[0] ?? null;
      case "recovery_write":
        if (h.failWrite) throw new Error("disk full");
        return void h.slots.set(slot, [args["json"] as string, ++h.clock]);
      case "recovery_clear": // NotFound is fine
        return void h.slots.delete(slot);
      default:
        return undefined; // container_save
    }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: async () => h.savePath,
  message: async (m: string) => { throw new Error(`unexpected dialog: ${m}`); },
}));
vi.mock("../ui/choice", () => ({
  choose: async () => { h.prompts++; return h.pick; },
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));

import { DocumentStore } from "../document/store";
import { checkRecovery, installAutosave, slotFor } from "./recovery";
import { saveDocumentAs } from "./files";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument } from "../types";

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {}, onStatus() { return () => {}; }, connected: true,
} as unknown as GeometryBackend;

const SOURCE = "/home/me/part.sindri";
const CRASHED = slotFor(SOURCE);

/** main.ts at startup: an empty store, autosave armed, then the recovery offer. */
async function launch(pick: "recover" | "discard" | null) {
  h.pick = pick;
  h.prompts = 0;
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  installAutosave(store);
  await checkRecovery(store);
  return store;
}
const ids = (store: DocumentStore) => (JSON.parse(store.toJSON()) as CadDocument).features.map((f) => f.id);

beforeEach(() => {
  vi.useFakeTimers();
  h.slots.clear();
  h.clock = 0;
  h.savePath = null;
  h.failWrite = false;
  // the app died with unsaved work in a named file
  const doc = { parameters: {}, features: [{ id: "f1", type: "box", length: 10, width: 10, height: 10 }] };
  h.slots.set(CRASHED, [JSON.stringify({ source: SOURCE, savedAt: Date.now(), doc }), ++h.clock]);
});
afterEach(() => void vi.useRealTimers());

describe("Recover", () => {
  it("does not offer the same work again once it is saved under another name", async () => {
    const store = await launch("recover");
    expect(ids(store)).toEqual(["f1"]);
    await vi.advanceTimersByTimeAsync(31_000); // the autosave fires by itself: load() marks dirty
    expect([...h.slots.keys()]).toEqual(["untitled"]);

    h.savePath = "/home/me/elsewhere.sindri";
    await saveDocumentAs(store);
    await vi.waitFor(() => expect([...h.slots.keys()]).toEqual([]));

    const next = await launch("recover");
    expect(h.prompts).toBe(0);
    expect(ids(next)).toEqual([]);
  });

  // Guards against a fix that only clears: a second crash before the first
  // autosave must still find the work, and restore it.
  it("keeps a snapshot for a second crash right after Recover", async () => {
    await launch("recover"); // ... and the app dies again within 30 s
    expect([...h.slots.keys()]).toEqual(["untitled"]);
    const next = await launch("recover");
    expect(h.prompts).toBe(1);
    expect(ids(next)).toEqual(["f1"]);
  });

  it("still recovers, and keeps the old snapshot, when the move fails", async () => {
    h.failWrite = true;
    const store = await launch("recover");
    expect(ids(store)).toEqual(["f1"]);
    expect([...h.slots.keys()]).toEqual([CRASHED]);
  });

  it("leaves an untitled snapshot where it is", async () => {
    const [json] = h.slots.get(CRASHED)!;
    h.slots.clear();
    h.slots.set("untitled", [json, ++h.clock]);
    await launch("recover");
    expect([...h.slots.keys()]).toEqual(["untitled"]);
    expect(h.slots.get("untitled")![0]).toBe(json);
  });
});

describe("the other answers are unchanged", () => {
  it("Discard clears the snapshot and loads nothing", async () => {
    const store = await launch("discard");
    expect([...h.slots.keys()]).toEqual([]);
    expect(ids(store)).toEqual([]);
  });

  it("Esc keeps the snapshot for the next launch and loads nothing", async () => {
    const store = await launch(null);
    expect([...h.slots.keys()]).toEqual([CRASHED]);
    expect(ids(store)).toEqual([]);
    const next = await launch("recover");
    expect(ids(next)).toEqual(["f1"]);
  });
});
