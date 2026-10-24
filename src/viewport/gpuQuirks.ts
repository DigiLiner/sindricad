// Per-GPU rendering workarounds, decided from the GL renderer WebKit really
// uses (webkit://gpu, read by the shell: src-tauri/src/webkit.rs).
//
// That name arrives after the WebGL context exists, and context attributes
// (antialias) are fixed at creation. So the name is remembered, and a quirk
// takes effect from the next start (diagnostics/glRenderer.ts says so once).

const KEY = "sindri.gpu.glRenderer";

/** Intel Ivy Bridge (HD Graphics 2500/4000, Mesa's "IVB"). Chromium has turned
 *  framebuffer multisampling off on it for years ("Multisampling is buggy in
 *  Intel IvyBridge", Chromium bug 116370); WebKitGTK has no such list. Doug's
 *  HD 4000 kept stair-steps and ghost edges through two depth fixes
 *  (.fable/doug-squiggles3/RESULT.md). */
export function msaaBroken(glRenderer: string | null | undefined): boolean {
  return !!glRenderer && /\bIVB\b|ivy ?bridge|\bHD Graphics (2500|4000)\b/i.test(glRenderer);
}

export function rememberedRenderer(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberRenderer(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* private mode or a full store: the quirk just waits for a later start */
  }
}
