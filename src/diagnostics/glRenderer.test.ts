// GH #17: the shell's webkit://gpu answer has to reach the fps tooltip over the
// spoofed WebGL string, and a software rasterizer has to be said once, with
// the right promise about the next launch.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyRenderer, resetGlRendererForTest } from "./glRenderer";
import { gpuLineText } from "../viewport/fpsMeter";

// node environment: the module only reads and writes two window fields
vi.stubGlobal("window", {});
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
const w = globalThis.window as { __gpu?: string };

describe("the real GL renderer", () => {
  beforeEach(() => {
    resetGlRendererForTest();
    w.__gpu = "Apple GPU (Apple Inc.) — reported by WebKitGTK, which spoofs this; not the real GPU";
  });

  it("the tooltip shows WebKit's own renderer over the spoofed WebGL string", () => {
    expect(gpuLineText()).toContain("Apple GPU");
    applyRenderer({ name: "Mesa Intel(R) UHD Graphics 630", software: false, retry: false }, vi.fn());
    expect(gpuLineText()).toContain("Mesa Intel(R) UHD Graphics 630");
    expect(gpuLineText()).not.toContain("Apple GPU");
    expect(gpuLineText()).not.toMatch(/software/i);
  });

  it("a software rasterizer is named in the tooltip and said once, promising a retry only when there is one", () => {
    const notify = vi.fn();
    const r = { name: "llvmpipe (LLVM 22.1.8, 256 bits)", software: true, retry: true };
    applyRenderer(r, notify);
    applyRenderer(r, notify); // the event and the command both answer
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(/llvmpipe.*next time you start it/s);
    expect(notify.mock.calls[0]![1]).toEqual({ kind: "warning" });
    expect(gpuLineText()).toMatch(/llvmpipe.*software rendering/);

    resetGlRendererForTest();
    const plain = vi.fn();
    applyRenderer({ ...r, retry: false }, plain);
    expect(plain.mock.calls[0]![0]).toContain("llvmpipe");
    expect(plain.mock.calls[0]![0]).not.toMatch(/next time/);
  });

  it("a GPU renderer says nothing", () => {
    const notify = vi.fn();
    applyRenderer({ name: "AMD Radeon (radeonsi)", software: false, retry: false }, notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it("remembers the renderer, and on Ivy Bridge with MSAA on says once that a restart fixes the edges", () => {
    const notify = vi.fn();
    (globalThis.window as { __msaa?: boolean }).__msaa = true;
    const ivb = { name: "Mesa Intel(R) HD Graphics 4000 (IVB GT2)", software: false, retry: false };
    applyRenderer(ivb, notify);
    applyRenderer(ivb, notify);
    expect(store.get("sindri.gpu.glRenderer")).toBe(ivb.name);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(/HD Graphics 4000.*Restart SindriCAD/s);

    // the next start already has MSAA off: nothing to say
    resetGlRendererForTest();
    const quiet = vi.fn();
    (globalThis.window as { __msaa?: boolean }).__msaa = false;
    applyRenderer(ivb, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });
});

