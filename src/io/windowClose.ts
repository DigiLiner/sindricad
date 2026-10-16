// Ask before the window's own close throws unsaved work away (GitHub #61).
//
// The titlebar X, Alt+F4 and the window manager's close all arrive as Tauri's
// close-requested event. Tauri holds a close ONLY while the webview listens for
// that event on this window (tauri manager/window.rs, has_js_listener), so with
// no listener the window was destroyed in the same turn and the app quit with
// the work on screen. The 30 s autosave is no net here: it is never flushed.
//
// Once this listener exists the shell ALWAYS holds the close, and the JS side
// finishes it with destroy(). That needs `core:window:allow-destroy` in
// src-tauri/capabilities/default.json: without it no close would ever finish.
//
// A webview that cannot answer (stalled, or its web process crashed) would
// then hold the window open for good, so the shell closes it anyway when a
// request goes unacked for a few seconds (src-tauri/src/close_guard.rs). The
// handler acks FIRST, on every request, prompt or not.
//
// Not covered, because nothing reaches this event: macOS Cmd+Q (the default
// menu's Quit is a native terminate:) and a Windows session end.

import type { DocumentStore } from "../document/store";
import { confirmDiscardChanges } from "./files";

/** Install the close guard on the main window. No-op outside Tauri.
 *  `beforeAsk` runs first on every close request, so work that is not in the
 *  store yet (an open sketch) can be committed and counted as unsaved. */
export async function installWindowCloseGuard(
  store: DocumentStore,
  title: () => string,
  beforeAsk: () => void = () => {},
): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { invoke } = await import("@tauri-apps/api/core");
  let asking = false;
  // INVARIANT: returning from this handler without preventDefault() destroys
  // the window. Every path that must keep the app open calls it.
  await getCurrentWindow().onCloseRequested(async (e) => {
    // Tell the shell's watchdog this webview is alive before anything else.
    void invoke("close_guard_ack").catch((err) => console.warn("close guard ack failed:", err));
    // A second X or Alt+F4 while the prompt is up is not a second answer.
    if (asking) {
      e.preventDefault();
      return;
    }
    asking = true;
    try {
      try {
        beforeAsk();
      } catch (err) {
        console.error("close guard: preparing the document failed:", err);
      }
      // Save (Save As when untitled) or Discard closes; Cancel, Esc, a
      // cancelled Save As and a failed save keep the app running.
      if (!(await confirmDiscardChanges(store, title()))) e.preventDefault();
    } catch (err) {
      // Stay open rather than lose work. A clean document never gets here
      // (the guard returns before anything can throw), so the app can still be
      // closed after a manual save.
      console.error("close guard failed:", err);
      e.preventDefault();
    } finally {
      asking = false;
    }
  });
}
