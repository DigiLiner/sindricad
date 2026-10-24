// Ivy Bridge draws MSAA wrong (Chromium bug 116370; Doug's HD 4000). The match
// runs on WebKit's GL_RENDERER string, so it has to catch Mesa's spellings and
// leave every other Intel generation alone.
import { describe, it, expect } from "vitest";
import { msaaBroken } from "./gpuQuirks";

describe("msaaBroken", () => {
  it("matches Ivy Bridge as Mesa and others name it", () => {
    for (const r of [
      "Mesa Intel(R) HD Graphics 4000 (IVB GT2)",
      "Mesa Intel(R) HD Graphics 2500 (IVB GT1)",
      "Mesa DRI Intel(R) Ivybridge Mobile",
      "Intel(R) HD Graphics 4000",
    ]) expect(msaaBroken(r), r).toBe(true);
  });

  it("leaves other GPUs, Intel included, alone", () => {
    for (const r of [
      "Mesa Intel(R) HD Graphics 4600 (HSW GT2)",
      "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
      "Mesa Intel(R) HD Graphics 3000 (SNB GT2)",
      "AMD Radeon RX 6900 XT (radeonsi, navi21, ACO)",
      "llvmpipe (LLVM 22.1.8, 256 bits)",
      "NVIDIA GeForce RTX 3060/PCIe/SSE2",
    ]) expect(msaaBroken(r), r).toBe(false);
    expect(msaaBroken(null)).toBe(false);
    expect(msaaBroken("")).toBe(false);
  });
});
