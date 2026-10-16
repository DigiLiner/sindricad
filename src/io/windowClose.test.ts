// The window's own close asks before unsaved work goes (GitHub #61).
//
// Only the IPC floor is fake (window.__TAURI_INTERNALS__): the REAL
// @tauri-apps/api/window registers the listener through plugin:event|listen and
// runs its own "destroy() unless preventDefault()" rule, the REAL
// confirmDiscardChanges and Save run behind it, against a REAL DocumentStore.
// The fake shell delivers the close request the way Rust does, to the callback
// registered for the event, and the effect observed is whether
// plugin:window|destroy was called. choose() is mocked: no DOM in this suite
// (the e2e unsaved_changes_guard_e2e.cjs clicks the real modal).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import capabilitiesSrc from "../../src-tauri/capabilities/default.json?raw";

const choose = vi.fn();
vi.mock("../ui/choice", () => ({ choose: (...a: unknown[]) => choose(...a), listModal: async () => {} }));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));

interface Listener { event: string; target: { kind: string; label?: string }; handler: number }
const shell = {
  log: [] as string[],
  listeners: [] as Listener[],
  callbacks: new Map<number, (e: unknown) => unknown>(),
  savePath: null as string | null,
  failSave: false,
  /** What Rust does on a close request with a listener: hand the event to it.
   *  Returns the onCloseRequested wrapper's promise, which settles after its
   *  destroy() or its decision not to. */
  requestClose(): Promise<unknown> {
    const l = shell.listeners.find((x) => x.event === "tauri://close-requested");
    if (!l) throw new Error("no close-requested listener: the shell would destroy the window at once");
    return Promise.resolve(shell.callbacks.get(l.handler)!({ event: "tauri://close-requested", id: 1, payload: null }));
  },
};

function installFloor() {
  let next = 1;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback(cb: (e: unknown) => unknown) { const id = next++; shell.callbacks.set(id, cb); return id; },
      unregisterCallback(id: number) { shell.callbacks.delete(id); },
      async invoke(cmd: string, args: Record<string, unknown>) {
        shell.log.push(cmd === "recovery_clear" ? `${cmd}:${args["slot"] as string}` : cmd);
        switch (cmd) {
          case "plugin:event|listen":
            shell.listeners.push(args as unknown as Listener);
            return next++;
          case "plugin:dialog|save": return shell.savePath;
          case "container_save":
            if (shell.failSave) throw new Error("disk full");
            return null;
          default: return null; // plugin:window|destroy, recovery_clear, plugin:dialog|message
        }
      },
    },
  };
  const ls = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v) };
}

import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {}, onStatus() { return () => {}; }, connected: true,
} as unknown as GeometryBackend;
const BOX = JSON.stringify({ parameters: {}, features: [{ id: "f1", type: "box", length: 5, width: 5, height: 5 }] });
const destroyed = () => shell.log.includes("plugin:window|destroy");

async function boot(beforeAsk?: () => void) {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  const { installWindowCloseGuard } = await import("./windowClose");
  await installWindowCloseGuard(store, () => "Save before closing?", beforeAsk);
  return store;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // the store's rebuild debounce, never run
  Object.assign(shell, { log: [], listeners: [], savePath: null, failSave: false });
  shell.callbacks.clear();
  choose.mockReset();
  installFloor();
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe("closing the window", () => {
  // Rust holds a close only for a listener on THIS window
  // (tauri-2.11.5 manager/window.rs has_js_listener: Window/WebviewWindow
  // targets). A global listen() registers {kind: "Any"}, which Rust never
  // holds: the window would die before the handler ran.
  it("registers one listener, targeted at the main window", async () => {
    await boot();
    const mine = shell.listeners.filter((l) => l.event === "tauri://close-requested");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.target).toEqual({ kind: "Window", label: "main" });
  });

  it("closes a clean document at once", async () => {
    await boot();
    await shell.requestClose();
    expect(choose).not.toHaveBeenCalled();
    expect(destroyed()).toBe(true);
  });

  it("asks about unsaved work, and Cancel or Esc keeps the window", async () => {
    const store = await boot();
    store.load(BOX); // load() marks dirty
    for (const answer of ["cancel", null]) {
      choose.mockResolvedValueOnce(answer);
      await shell.requestClose();
    }
    expect(choose).toHaveBeenCalledTimes(2);
    expect(choose.mock.calls[0]![0]).toBe("Save before closing?");
    expect(destroyed()).toBe(false);
    expect(store.dirty).toBe(true);
  });

  it("Discard clears the recovery slots, then closes", async () => {
    const store = await boot();
    store.load(BOX);
    choose.mockResolvedValueOnce("discard");
    await shell.requestClose();
    const order = ["recovery_clear:untitled", "plugin:window|destroy"].map((c) => shell.log.indexOf(c));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
  });

  it("swallows a second close request while the prompt is open", async () => {
    const store = await boot();
    store.load(BOX);
    let answer!: (v: string | null) => void;
    let entered!: () => void;
    const inChoose = new Promise<void>((r) => { entered = r; });
    choose.mockImplementationOnce(() => { entered(); return new Promise((r) => { answer = r; }); });
    const first = shell.requestClose();
    await inChoose; // the guard reaches choose() only after its dynamic import
    await shell.requestClose(); // Alt+F4 again
    expect(destroyed()).toBe(false);
    expect(choose).toHaveBeenCalledTimes(1);
    answer(null);
    await first;
    expect(destroyed()).toBe(false);
  });
});

describe("Save at the close", () => {
  it("a cancelled Save As keeps the window and the work", async () => {
    const store = await boot();
    store.load(BOX);
    choose.mockResolvedValueOnce("save");
    shell.savePath = null; // the native dialog was cancelled
    await shell.requestClose();
    expect(shell.log).toContain("plugin:dialog|save");
    expect(destroyed()).toBe(false);
    expect(store.dirty).toBe(true);
  });

  // The window goes as soon as the guard says yes, so the recovery slots must
  // already be gone, or the next launch offers to recover what was just saved.
  it("writes the file, clears recovery, THEN closes", async () => {
    const store = await boot();
    store.load(BOX);
    choose.mockResolvedValueOnce("save");
    shell.savePath = "/home/me/part.sindri";
    await shell.requestClose();
    const at = (c: string) => shell.log.indexOf(c);
    expect(at("container_save")).toBeGreaterThanOrEqual(0);
    expect(at("recovery_clear:untitled")).toBeGreaterThan(at("container_save"));
    expect(at("plugin:window|destroy")).toBeGreaterThan(at("recovery_clear:untitled"));
    expect(store.dirty).toBe(false);
  });

  it("a failed save keeps the window, and the next close asks again", async () => {
    const store = await boot();
    store.load(BOX);
    shell.failSave = true;
    shell.savePath = "/home/me/part.sindri";
    choose.mockResolvedValueOnce("save");
    await shell.requestClose();
    expect(shell.log).toContain("plugin:dialog|message"); // the error was shown
    expect(destroyed()).toBe(false);
    choose.mockResolvedValueOnce(null);
    await shell.requestClose();
    expect(choose).toHaveBeenCalledTimes(2);
    expect(destroyed()).toBe(false);
  });
});

// The shell closes the window anyway when a close request goes unacked for a
// few seconds (src-tauri/src/close_guard.rs), so the handler must ack first, on
// every request: also the second X while the prompt is up, which a
// still-asking guard otherwise swallows without a word.
describe("the ack to the shell's watchdog", () => {
  it("comes before anything else the handler does", async () => {
    const store = await boot(() => void shell.log.push("beforeAsk"));
    store.load(BOX);
    choose.mockImplementationOnce(async () => { shell.log.push("choose"); return null; });
    await shell.requestClose();
    expect(shell.log.filter((c) => ["close_guard_ack", "beforeAsk", "choose"].includes(c)))
      .toEqual(["close_guard_ack", "beforeAsk", "choose"]);
  });

  it("is sent on a clean close and on a second request during the prompt", async () => {
    const store = await boot();
    await shell.requestClose(); // clean
    expect(shell.log.indexOf("close_guard_ack")).toBeLessThan(shell.log.indexOf("plugin:window|destroy"));
    store.load(BOX);
    let entered!: () => void;
    const inChoose = new Promise<void>((r) => { entered = r; });
    let answer!: (v: null) => void;
    choose.mockImplementationOnce(() => { entered(); return new Promise((r) => { answer = r; }); });
    shell.log.length = 0;
    const first = shell.requestClose();
    await inChoose;
    await shell.requestClose(); // swallowed, but acked
    expect(shell.log.filter((c) => c === "close_guard_ack")).toHaveLength(2);
    answer(null);
    await first;
  });
});

describe("work not in the store yet", () => {
  // An open sketch is committed only by Finish. Without beforeAsk a clean
  // document with a sketch being drawn closed without asking.
  it("beforeAsk runs first, so an open sketch it commits is asked about", async () => {
    const store = await boot(() => store.load(BOX)); // stands in for sketch.finish()
    choose.mockResolvedValueOnce(null);
    await shell.requestClose();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(destroyed()).toBe(false);
  });

  it("a failing beforeAsk does not make the window unclosable", async () => {
    await boot(() => { throw new Error("boom"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await shell.requestClose();
    expect(destroyed()).toBe(true);
  });
});

// Once the listener exists the shell ALWAYS holds the close and the JS wrapper
// finishes it with destroy(), which core:window:default does not grant. Without
// this line the X does nothing, even on a clean document.
it("the capability file grants core:window:allow-destroy", () => {
  const caps = JSON.parse(capabilitiesSrc) as { permissions: unknown[] };
  expect(caps.permissions).toContain("core:window:allow-destroy");
});
