// Every export writes what the user SEES (finding explore-file-lifecycle-6).
//
// File > Export, Export print project (which Open in OrcaSlicer and Send to
// printer go through) and TinkerAtlas Publish sent store.document, the raw saved
// timeline: features past the rollback marker and suppressed ones were built
// into the file, and nothing told the sidecar which bodies were hidden. These go
// in through the user's own commands and read the document the backend was
// handed, the way the sidecar receives it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../types";
import type { Viewport } from "../viewport/viewport";
import { t } from "../i18n";

const FEATURES = [
  { id: "f1", type: "box", length: 10, width: 10, height: 10 },
  { id: "f2", type: "box", length: 5, width: 5, height: 5 },
  { id: "f3", type: "box", length: 4, width: 4, height: 4 },
  { id: "f4", type: "box", length: 3, width: 3, height: 3 },
] as Feature[];

function result(ids: string[]): RebuildResult {
  return {
    mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    bodies: ids.map((id, i) => ({ id, name: id, faceStart: i, faceCount: 1 })),
  };
}

let reported: string[];
let toasts: string[];
let sent: CadDocument[];

function backend(): GeometryBackend {
  return {
    // one body per feature the build was handed, ids positional like the sidecar's
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      return { ok: true, result: result(doc.features.map((_f, i) => `body${i + 1}`)) };
    },
    async init() {}, onStatus() { return () => {}; }, connected: true,
    async export(doc: CadDocument, _fmt: string, path: string) {
      sent.push(doc);
      return { ok: true, path };
    },
    async exportProject(doc: CadDocument, path: string) {
      sent.push(doc);
      return { ok: true, path };
    },
  } as unknown as GeometryBackend;
}

/** Rolled back before f4, f2 suppressed, and body1 (f1's box) hidden: the
 *  screen shows ONE body, f3's. */
async function editedStore(hide: string[] = ["body1"]) {
  vi.useFakeTimers();
  try {
    const store = new DocumentStore(backend(), { parameters: {}, features: structuredClone(FEATURES) });
    store.setRollback(3);
    store.toggleSuppress("f2");
    await vi.runAllTimersAsync();
    store.setBodiesVisibility(new Map(hide.map((id) => [id, false])));
    return store;
  } finally {
    vi.useRealTimers();
  }
}

function expectVisibleDocument(doc: CadDocument | undefined) {
  expect(doc, "nothing was exported").toBeDefined();
  expect(doc!.features.map((f) => f.id), "the export did not get the model on screen").toEqual(["f1", "f3"]);
  expect(doc!.bodyVisibility).toEqual({ body1: false });
}

/** Just enough DOM for publishForm: every element is inert, and the form's
 *  primary button is clicked as soon as the form is on screen. */
function fakeDom() {
  const el = (): Record<string, unknown> => {
    const listeners: Record<string, () => void> = {};
    const node: Record<string, unknown> = {
      value: "Bracket", checked: true, className: "", innerHTML: "",
      append() {}, appendChild() {}, focus() {}, select() {}, remove() {},
      addEventListener(type: string, fn: () => void) {
        listeners[type] = fn;
        if (type === "click" && String(node.className).includes("choice-primary")) queueMicrotask(fn);
      },
    };
    return node;
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: el, createTextNode: () => ({}), body: { appendChild() {} }, activeElement: null,
  };
}

beforeEach(() => {
  reported = [];
  toasts = [];
  sent = [];
  (globalThis as unknown as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {},
    addEventListener() {},
    removeEventListener() {},
  };
  vi.doMock("@tauri-apps/plugin-dialog", () => ({
    save: async () => "/tmp/part.step",
    open: async () => null,
    message: async (m: string) => void reported.push(m),
  }));
  vi.doMock("../ui/choice", () => ({
    choose: async () => "3mf",
    listModal: async () => {},
    pushModal() {},
    popModal() {},
  }));
  vi.doMock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
  vi.doMock("../print/printerClient", () => ({
    activePrinterId: () => null,
    printerFilaments: async () => null,
  }));
  vi.doMock("../tinkeratlas/client", () => ({
    currentAccount: () => ({ id: "u1" }),
    taStagingPath: async () => "/tmp/staged.3mf",
    taPublish: async () => ({ url: "https://example.invalid/m/1" }),
    asTaError: () => null,
  }));
});

afterEach(() => {
  for (const m of ["@tauri-apps/plugin-dialog", "../ui/choice", "../ui/toast", "../print/printerClient", "../tinkeratlas/client"]) vi.doUnmock(m);
  vi.resetModules();
  delete (globalThis as unknown as Record<string, unknown>).window;
  delete (globalThis as unknown as Record<string, unknown>).document;
});

const viewport = { screenshotPNG: () => "data:image/png;base64,AA" } as unknown as Viewport;

describe("an export writes the model on screen", () => {
  it("File > Export", async () => {
    const store = await editedStore();
    const { exportModel } = await import("./files");
    await exportModel(store, backend());
    expectVisibleDocument(sent[0]);
  });

  it("right-click a body > Export", async () => {
    const store = await editedStore();
    const { exportBody } = await import("./files");
    await exportBody(store, backend(), "body2", "stl");
    expectVisibleDocument(sent[0]);
  });

  it("Export print project, which Open in OrcaSlicer and Send to printer go through", async () => {
    const store = await editedStore();
    const { exportPrintProject } = await import("./files");
    await exportPrintProject(store, backend(), { path: "/tmp/p.3mf" });
    await new Promise((r) => setTimeout(r, 10));  // let the fire-and-forget slot warning land
    expectVisibleDocument(sent[0]);
  });

  it("TinkerAtlas > Publish", async () => {
    fakeDom();
    const store = await editedStore();
    const { publishToTinkerAtlas } = await import("../tinkeratlas/publish");
    await publishToTinkerAtlas(store, backend(), viewport);
    expectVisibleDocument(sent[0]);
  });
});

describe("with every body hidden there is nothing to export", () => {
  it("File > Export refuses instead of writing the hidden bodies", async () => {
    const store = await editedStore(["body1", "body2"]);
    const { exportModel } = await import("./files");
    await exportModel(store, backend());
    expect(sent).toEqual([]);
    expect(reported).toEqual([t("file.export.allHidden")]);
  });

  it("File > Export with the marker rolled back to the start refuses too", async () => {
    vi.useFakeTimers();
    const store = new DocumentStore(backend(), { parameters: {}, features: structuredClone(FEATURES) });
    store.setRollback(0);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const { exportModel } = await import("./files");
    await exportModel(store, backend());
    expect(sent).toEqual([]);
    expect(reported).toEqual([t("file.export.nothing")]);
  });

  it("Export print project refuses too", async () => {
    const store = await editedStore(["body1", "body2"]);
    const { exportPrintProject } = await import("./files");
    expect(await exportPrintProject(store, backend(), { path: "/tmp/p.3mf" })).toBeNull();
    expect(sent).toEqual([]);
    expect(reported).toEqual([t("file.export.allHidden")]);
  });

  it("Publish refuses before asking anything", async () => {
    const store = await editedStore(["body1", "body2"]);
    const { publishToTinkerAtlas } = await import("../tinkeratlas/publish");
    await publishToTinkerAtlas(store, backend(), viewport);
    expect(sent).toEqual([]);
    expect(toasts).toEqual([t("tinkeratlas.publish.allHidden")]);
  });
});

// A tool's live preview is on screen but not in the model: a fillet being
// dragged, or a feature re-opened for editing (which also rolls the model back
// to it). The built document carries that uncommitted state, so an export
// started then is refused, never written from the preview.
describe("an export never writes a tool's live preview", () => {
  const PREVIEW = { id: "pv", type: "box", length: 1, width: 1, height: 1 } as Feature;

  async function previewing(how: "preview" | "edit") {
    const store = await editedStore();
    vi.useFakeTimers();
    if (how === "preview") store.setPreview(PREVIEW);
    else { store.beginEditPreview("f3"); store.setEditPreview({ ...FEATURES[2]!, length: 40 } as Feature); }
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    return store;
  }

  for (const how of ["preview", "edit"] as const) {
    it(`File > Export refuses while a tool shows a ${how}`, async () => {
      const store = await previewing(how);
      const { exportModel } = await import("./files");
      await exportModel(store, backend());
      expect(sent).toEqual([]);
      expect(reported).toEqual([t("file.export.toolOpen")]);
    });
  }

  it("right-click Export, Export print project and Publish refuse too", async () => {
    const store = await previewing("preview");
    const { exportBody, exportPrintProject } = await import("./files");
    await exportBody(store, backend(), "body2", "stl");
    expect(await exportPrintProject(store, backend(), { path: "/tmp/p.3mf" })).toBeNull();
    const { publishToTinkerAtlas } = await import("../tinkeratlas/publish");
    await publishToTinkerAtlas(store, backend(), viewport);
    expect(sent).toEqual([]);
    expect(reported).toEqual([t("file.export.toolOpen"), t("file.export.toolOpen")]);
    expect(toasts).toEqual([t("tinkeratlas.publish.toolOpen")]);
  });

  it("exports the committed model again once the preview is cleared", async () => {
    const store = await previewing("preview");
    vi.useFakeTimers();
    store.setPreview(null);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const { exportModel } = await import("./files");
    await exportModel(store, backend());
    expectVisibleDocument(sent[0]);
  });
});
