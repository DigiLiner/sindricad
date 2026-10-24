// GH #17: what the Linux webview really draws with.
//
// WebKitGTK spoofs the WebGL renderer string (scene.ts recordGpu says "Apple
// GPU" on every Linux machine, llvmpipe included), and the acceleration policy
// the shell logs reads "always" on a software rasterizer too. So a laptop that
// drew every frame on the CPU looked healthy in every report for a month. The
// shell now reads WebKit's own webkit://gpu page (src-tauri/src/webkit.rs,
// probe_renderer) and hands the answer here: the fps tooltip shows it, and a
// software rasterizer gets said out loud once, since "slow" is all the user sees.
//
// The answer can arrive before this listens (boot.ts checks in, which starts
// the probe, before main.ts runs), so it is both listened for and asked for.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { toast } from "../ui/toast";
import { msaaBroken, rememberRenderer } from "../viewport/gpuQuirks";

export interface RendererReport {
  name: string;
  software: boolean;
  /** the next launch tries another renderer */
  retry: boolean;
}

let said = false;
let saidMsaa = false;

/** Record the report where the fps tooltip reads it, and say a software
 *  rasterizer once per launch. Safe to call twice with the same report. */
export function applyRenderer(r: RendererReport, notify: typeof toast = toast) {
  const w = window as { __glRenderer?: RendererReport; __msaa?: boolean };
  w.__glRenderer = r;
  // the next start builds its context for this GPU (viewport/gpuQuirks.ts)
  rememberRenderer(r.name);
  if (msaaBroken(r.name) && w.__msaa === true && !saidMsaa) {
    saidMsaa = true;
    notify(t("gpu.msaaNextStart", { name: r.name }), { kind: "warning" });
  }
  if (!r.software || said) return;
  said = true;
  notify(t(r.retry ? "gpu.softwareRetry" : "gpu.softwareNow", { name: r.name }), { kind: "warning" });
}

export function watchGlRenderer() {
  listen<RendererReport>("gpu:renderer", (e) => applyRenderer(e.payload)).catch(() => {});
  invoke<RendererReport | null>("gl_renderer").then((r) => { if (r) applyRenderer(r); }).catch(() => {});
}

/** test seam */
export function resetGlRendererForTest() {
  said = false;
  saidMsaa = false;
  delete (window as { __glRenderer?: RendererReport }).__glRenderer;
}
