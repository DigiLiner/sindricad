// Regression guard for the ambient-selection lifecycle of the Texture tool.
//
// The bug this locks: the progressive renderer installs a FRESH Highlighter per
// installment (viewport.adoptProgressiveView, once at stream begin and again for
// every appended chunk), and a new Highlighter starts with an empty
// selectedFaces. So a chunked rebuild drops the ambient selection several times
// BEFORE store.onBuild fires. The tool's rAF tick, landing in that window with
// `rebuildLanded` still false, read the empty selection as a user deselect and
// discarded the faces the user had picked — "click a face, it highlights for a
// frame, then clears itself". Shipped in ee204bc; unrelated to any one feature,
// but only visible on documents big enough to stream.

import { describe, expect, it } from "vitest";
import { TextureTool } from "./textureTool";

// The panel's constructor is the only DOM this test touches: one createElement,
// a style assign, and a body.appendChild. Stubbed rather than pulling in jsdom
// for four assertions.
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {} }),
  // commit()'s success path calls cleanup(), which calls setPrompt() (reads
  // getElementById, src/ui/prompt.ts) and unregisters the Esc handler.
  getElementById: () => null,
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};
// tick() re-arms itself; the harness drives it by hand instead.
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame ??= () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame ??= () => {};

/** The two collaborators tick() actually reads, and nothing else. */
function harness(opts: { building: boolean }) {
  let selected: number[] = [];
  const viewport = {
    getSelectedFaceIds: () => selected,
    selectFaces: (ids: number[]) => { selected = [...ids]; },
    getSelectedBodies: () => [] as string[],
    setSelectedBodies: () => {},
  };
  const store = { buildState: { building: opts.building, result: {} } };
  const tool = new TextureTool(viewport as never, store as never);
  const t = tool as unknown as {
    active: boolean;
    lastFaceIds: number[];
    rebuildLanded: boolean;
    raf: number;
    tick: () => void;
    refreshSummary: () => void;
    pushPreview: () => void;
  };
  t.active = true;
  // stub the two side effects a tick can trigger, so the test observes state only
  t.refreshSummary = () => {};
  t.pushPreview = () => {};
  return {
    t,
    setSelection: (ids: number[]) => { selected = ids; },
    currentSelection: () => selected,
    tick: () => { t.tick(); cancelAnimationFrame(t.raf); },
  };
}

describe("TextureTool ambient selection", () => {
  it("keeps the user's faces when a rebuild wipes the selection mid-stream", () => {
    const h = harness({ building: true });
    h.t.lastFaceIds = [7, 9];
    h.setSelection([]); // the progressive renderer just installed a fresh Highlighter
    h.tick();
    expect(h.t.lastFaceIds).toEqual([7, 9]);
  });

  it("still treats an empty selection as a deselect once the build has landed", () => {
    const h = harness({ building: false });
    h.t.lastFaceIds = [7, 9];
    h.setSelection([]);
    h.tick();
    expect(h.t.lastFaceIds).toEqual([]);
  });

  it("restores the members when a completed rebuild wiped them", () => {
    const h = harness({ building: false });
    h.t.lastFaceIds = [7, 9];
    h.t.rebuildLanded = true;
    h.setSelection([]);
    h.tick();
    expect(h.currentSelection()).toEqual([7, 9]);
    expect(h.t.lastFaceIds).toEqual([7, 9]);
  });

  it("picks up a genuine user selection made while idle", () => {
    const h = harness({ building: false });
    h.t.lastFaceIds = [];
    h.setSelection([3]);
    h.tick();
    expect(h.t.lastFaceIds).toEqual([3]);
  });
});

// The saved face point used to be re-minted at commit from the mesh on screen,
// which by then is the DISPLACED preview: the point sat on a texture crest off
// the B-rep face, by:"nearest" tied with a 1 mm2 neighbour, and the texture the
// user had just saved failed as "ambiguous face reference". The fake viewport
// below mints from whatever it is "showing", and the preview moves the point.
describe("TextureTool saved face point", () => {
  function commitHarness() {
    let z = 25; // the plain top face
    const viewport = {
      selecting: "faces",
      setSelectionMode: () => {},
      getSelectedFaceIds: () => [4],
      selectedFacesForPressPull: () => ({
        selectors: [{ kind: "face", by: "nearest", point: [-30.57, 22.39, z] }],
        faceIds: [4],
        bodyId: "b1",
      }),
      faceIdToBodyId: () => "b1",
    };
    let n = 0;
    const store = { buildState: { building: false, result: {} }, nextId: () => `f${++n}`, onBuild: () => () => {} };
    const tool = new TextureTool(viewport as never, store as never);
    const t = tool as unknown as { mode: string; buildFeature: () => { faces: { point: number[] } } };
    t.mode = "faces";
    return { t, showPreview: () => { z = 25.08; } };
  }

  it("keeps the point minted before the preview displaced the face", () => {
    const h = commitHarness();
    expect(h.t.buildFeature().faces.point[2]).toBe(25); // the first preview's build
    h.showPreview(); // the displaced preview is on screen now
    expect(h.t.buildFeature().faces.point[2]).toBe(25); // the commit's build
  });
});

// commit() is the Apply button, and unlike tick() it had no building gate at
// all: a fast click+Apply during ANY rebuild (a mode switch's clearing
// rebuild, or any other) could mint a face's selector off the stale displaced
// mesh still on screen, in the very call that also saves it — and
// faceSelectors only mints a fid once, so there is no later call that heals
// it. commit() now defers behind the same store.buildState.building gate
// tick() already uses, and tick() retries it once building clears.
describe("TextureTool commit(): deferred while a rebuild is in flight", () => {
  function applyHarness() {
    // z is whatever the viewport is CURRENTLY SHOWING for the one face in
    // play: 25 is the real (undisplaced) B-rep face, 25.4 is a stale displaced
    // crest still on screen while a rebuild is in flight.
    let z = 25.4;
    const faceIds = [4];
    const viewport = {
      selecting: "faces",
      setSelectionMode: () => {},
      getSelectedBodies: () => ["b1"],
      getSelectedFaceIds: () => faceIds,
      selectedFacesForPressPull: () => ({
        selectors: faceIds.map(() => ({ kind: "face", by: "nearest", point: [-30.57, 22.39, z] })),
        faceIds,
        bodyId: "b1",
      }),
      faceIdToBodyId: () => "b1",
      clearSelection: () => {},
      setSelectedBodies: () => {},
    };
    const saved: { faces: { point: number[] } }[] = [];
    const store = {
      buildState: { building: true, result: {} },
      nextId: () => "f1",
      onBuild: () => () => {},
      setPreview: () => {},
      addFeature: (f: unknown) => saved.push(f as { faces: { point: number[] } }),
    };
    const tool = new TextureTool(viewport as never, store as never);
    const t = tool as unknown as { mode: string; active: boolean; raf: number; commit: () => void; tick: () => void };
    t.mode = "faces";
    t.active = true;
    return {
      t,
      saved,
      landBuild: () => { store.buildState.building = false; z = 25; },
      tick: () => { t.tick(); cancelAnimationFrame(t.raf); },
    };
  }

  it("Apply during a stale displaced preview waits, then saves the real face point", () => {
    const h = applyHarness();
    h.t.commit();
    expect(h.saved.length, "commit() must not mint off the stale mesh").toBe(0);
    h.landBuild(); // the rebuild lands; the real, undisplaced face is on screen
    h.tick(); // the tool's own rAF loop notices building cleared and retries
    expect(h.saved.length).toBe(1);
    expect(h.saved[0]!.faces.point[2]).toBeCloseTo(25, 5); // the real face, not the 25.4 crest
  });

  it("commits immediately when no rebuild is in flight", () => {
    const h = applyHarness();
    h.landBuild();
    h.t.commit();
    expect(h.saved.length).toBe(1);
    expect(h.saved[0]!.faces.point[2]).toBeCloseTo(25, 5);
  });
});
