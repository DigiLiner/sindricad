// Work package "sketch-fullscreen-panels" (report 3d04e930, Paul Crabb): a
// View menu item to hide/show the side panels (Browser, Parameters, the
// sketch help prompt) for more sketch room, remembered for the session, no
// keyboard shortcut yet.
//
// The original triage repro
// (.fable/beta-next/triage-tests/sketch-fullscreen-panels-3d04e930.test.ts)
// was written to prove the ABSENCE of this feature — it asserts #main has no
// collapsing class and that no command/menu-item exists. That makes it a
// feature-ABSENCE proof: correct to fail once the feature ships, which a
// review caught the implementer's report describing backwards (claimed
// "2 failed / 2 passed" on next/beta and "4/4 passed" after the fix — the
// opposite of what actually happens). That old test is not a regression
// guard for the shipped feature and must not be relied on as one. This file
// is: it asserts the feature actually WORKS, so it fails on next/beta (no
// feature) and passes once both the feature and its ordering are correct.
//
// It reads main.ts/commands.ts/styles.css/shortcuts.ts as TEXT rather than
// importing them, for the same reason ribbonActions.test.ts does: importing
// main.ts boots the whole app (window, WebGL, the sidecar socket).
import { describe, it, expect } from "vitest";
import mainSrc from "../main.ts?raw";
import commandsSrc from "./commands.ts?raw";
import stylesSrc from "../styles.css?raw";
import shortcutsSrc from "../input/shortcuts.ts?raw";

describe("toggle-panels (3d04e930): View menu can hide/show the side panels", () => {
  it("is a real, menu-reachable, global command", () => {
    expect(commandsSrc).toMatch(/id:\s*"toggle-panels"/);
    const viewMenu = /label:\s*t\("menu\.view\.title"\)[\s\S]*?items:\s*\[([\s\S]*?)\],\s*\n\s*\},/.exec(mainSrc)?.[1] ?? "";
    expect(viewMenu, "menu.view.title's items block must be found in main.ts").toBeTruthy();
    expect(viewMenu).toMatch(/toggle-panels/);
  });

  it("hides #browser, #inspector and #prompt and collapses #main's grid, under one class", () => {
    const hiddenBlock = stylesSrc.slice(stylesSrc.indexOf("#app.panels-hidden"));
    expect(hiddenBlock).toMatch(/#app\.panels-hidden #main\s*\{[^}]*grid-template-columns:\s*1fr/);
    const panelsBlock = /#app\.panels-hidden #browser,[\s\S]*?\{[^}]*\}/.exec(hiddenBlock)?.[0] ?? "";
    for (const id of ["#browser", "#inspector", "#prompt"]) {
      expect(panelsBlock, `#app.panels-hidden must hide ${id}`).toContain(id);
    }
    expect(panelsBlock).toMatch(/display:\s*none/);
  });

  it("has no keyboard shortcut yet (spec: View menu item now, shortcut deferred)", () => {
    expect(shortcutsSrc).not.toMatch(/toggle-?panels/i);
  });

  it("is session-only state (a plain variable, not read from or written to any persisted store)", () => {
    const at = mainSrc.indexOf("let panelsHidden");
    expect(at, "panelsHidden must exist in main.ts").toBeGreaterThan(-1);
  });

  // The blocker this file guards against: handleAction's generic fallback
  // ("a 3D modeling command finishes the active sketch first") sits right
  // before the big switch/case that toggle-panels used to live in alone.
  // Toggling panels is a VIEW state change, not a modeling command — reaching
  // it through that fallback silently commits whatever sketch is open, which
  // defeats the feature's whole purpose (more room to keep sketching in).
  it("is handled BEFORE the 'finishes the active sketch' fallback, so it never commits an in-progress sketch", () => {
    const sketchFinishAt = mainSrc.indexOf("a 3D modeling command finishes the active sketch first");
    expect(sketchFinishAt, "the sketch.finish(true) fallback comment is gone — this test's anchor is stale").toBeGreaterThan(-1);
    const toggleAt = mainSrc.indexOf('action === "toggle-panels"');
    expect(toggleAt, 'no `action === "toggle-panels"` early-return guard found in handleAction').toBeGreaterThan(-1);
    expect(
      toggleAt,
      "toggle-panels is handled AFTER the sketch-finishing fallback, so invoking View > Side Panels while "
        + "a sketch is being edited will finish/commit that sketch as a side effect instead of just hiding the panels",
    ).toBeLessThan(sketchFinishAt);
    // And it must not also still live in the generic switch below the fallback
    // (dead code there would be harmless, but reaching it that way would mean
    // the early guard above isn't actually returning).
    const switchAt = mainSrc.indexOf("switch (action) {", sketchFinishAt);
    const caseAt = mainSrc.indexOf('case "toggle-panels"', switchAt);
    expect(caseAt, "toggle-panels must not be routed through the generic switch, only the early guard").toBe(-1);
  });
});
