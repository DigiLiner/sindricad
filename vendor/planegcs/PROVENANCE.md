planegcs glue and wasm, built with -s DYNAMIC_EXECUTION=0 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=128MB
===========================================================================================================

WHY THIS IS VENDORED

The 2D constraint solver is planegcs, an emscripten/embind module. embind builds
each invoker by handing SOURCE TEXT to the Function constructor - in the shipped
1.1.7 glue, closure has specialised its `new_` helper to

    function qb(b){var a=Function; ... b=a.apply(c,b); ...}

A Content-Security-Policy of `script-src 'self' 'wasm-unsafe-eval'` permits
WebAssembly compilation and does NOT permit that, so the app needed
'unsafe-eval' purely for this one dependency. `tauri dev` serves from vite
without the CSP, which is why it never reproduced in development: three Windows
reporters and one Linux reporter were told to update a runtime that was never
the problem, and one reinstalled WebView2 for nothing.

WHY THE HEAP GROWS (added 2026-10-17)

The published build has a FIXED 16 MB heap (wasm memory min = max = 256 pages,
5 MB of it stack), and planegcs diagnoses every system it solves with dense
constraints x parameters matrices. SindriCAD solves each independent part of a
sketch as its own system (src/sketch/solver.ts, SYSTEM_BUDGET), but one connected
part of roughly 280 or more dimensioned lines still ran the heap out and aborted
with "Aborted(OOM)". With ALLOW_MEMORY_GROWTH the heap grows on demand, up to
MAXIMUM_MEMORY = 128 MB (2048 pages), so a runaway part fails at a bound instead
of taking the webview's memory with it.

Why 128 MB and not 256: the first growable build that day capped at 256 MB, and
measured on one connected staircase of dimensioned lines the extra 128 MB only
admitted parts that took 5 to 19 s to solve on the main thread (1,000 lines 5 s
in 126 MB, 1,500 lines 19 s in 256 MB). At 128 MB, 1,000 lines still solve
(5 s) and 1,050 or more are refused within 0.4 to 1.5 s.

Upstream PR Salusoft89/planegcs#12 proposes the same one-line flag. It is still
open, and its branch is based on 1.2.0 - taking it would silently upgrade the
solver alongside the CSP fix. So the flag is applied to the exact commit that
produced the 1.1.7 artifact pinned in package-lock.json.

PROVENANCE

    source:    https://github.com/Salusoft89/planegcs
    commit:    951ba1a56c7fbae17de05851a221129e185fa92c   (= tag 1.1.7; the npm
               packument records this as gitHead for 1.1.7)
    toolchain: emscripten/emsdk:3.1.45, upstream's own builder base, plus the
               eigen3/boost layer and the /inc/boost symlink from its Dockerfile
    patch:     ` -s DYNAMIC_EXECUTION=0 -s ALLOW_MEMORY_GROWTH=1
               -s MAXIMUM_MEMORY=128MB` appended to LINK_FLAGS in
               planegcs/CMakeLists.txt. Nothing else is changed.
    built by:  .github/workflows/planegcs-glue.yml (manual trigger)
    build log: https://github.com/MakerViking/sindricad/actions/runs/39057010371
               (history: the 256 MB build it replaced the same day came from
               https://github.com/MakerViking/sindricad/actions/runs/39053175504,
               lowered for the solve times above; the DYNAMIC_EXECUTION=0-only
               pair before it from
               https://github.com/MakerViking/sindricad/actions/runs/32002153102)

    Rebuild it: run that workflow. It is not a local build by design - a binary
    in a public AGPL repo needs provenance a workstation cannot give.

WHAT IS ESTABLISHED, AND WHAT IS NOT

ESTABLISHED. The same job first builds the source UNMODIFIED and requires the
result to be byte-identical to the published npm artifact. It is (in both runs
above). That is what
proves this toolchain is the maintainer's toolchain, and therefore that the flag
is the only variable between the published build and this one.

ESTABLISHED. The sink is gone. The published glue contains embind's `var
a=Function` helper and 3 bare `Function` references; this build contains neither
the helper nor 2 of the 3 references.

ESTABLISHED, in a real browser under the real policy. Served under
`script-src 'self' 'wasm-unsafe-eval'` and initialised in Chromium:

    published glue -> EvalError: Evaluating a string as JavaScript violates the
                      following Content Security Policy directive because
                      'unsafe-eval' is not an allowed source of script
    this glue      -> initialises

Re-run for each growable pair (2026-10-17: 256 MB, then 128 MB), through
scripts/check-csp-serve.py with the published 1.1.7 glue as the control, in
Chromium AND in WebKitGTK (scripts/check-csp-webkit.py): the published glue
throws EvalError in both, this glue initialises in both. In Chromium the page
then pushed 3,000,000 parameters into one GcsSystem (24 MB of doubles, past the
old 16 MB heap) and read the count back, so the heap grows under that policy too.

ESTABLISHED. The heap grows, and stops at the cap. In vitest (Node), a 500-line
connected staircase that aborted the 16 MB heap solves; with WebAssembly memory
growth refused past 300 pages, the same solve aborts with "Aborted()" (not
"Aborted(OOM)": a refused growth makes malloc fail, and the C++ allocation aborts
without emscripten's OOM label). src/sketch/solverHeap.test.ts pins both. At
the real 128 MB cap, unclamped, a 1,000-line staircase solves and a 1,050-line
one is refused the same way.

That is the field bug and its removal, reproduced directly. Note that the
frontend test suites CANNOT show this: vitest runs in Node, which has no CSP, so
those suites prove compatibility and not the fix.

NOT ESTABLISHED BY CHECKSUM, and do not let a future reader think otherwise: the
WASM does not build reproducibly in this toolchain. Three runs at this same
commit in this same container disagreed about it - once matching the published
binary, once not, once neither. The JS glue reproduced byte for byte every time.
So a byte comparison of the wasm means nothing in either direction, and the
workflow records its hashes rather than gating on them.

WHY BOTH FILES ARE VENDORED, not just the glue. Two reasons.

First, the heap's ceiling lives in the WASM, not the glue: its memory section
declares the maximum (256 pages in the published build, 2048 now; 4096 in the
256 MB build), and that is the only byte the 256 MB and 128 MB wasm differ in.
The growth code (emscripten_resize_heap) is in the glue, and carries the cap
too (134217728 against 268435456: the only change between those two glues).
Either half alone would be a different heap from the one that was tested.

Second, DYNAMIC_EXECUTION=0 also changes the wasm, by 5 bytes at one offset - a struct's field offsets shifting by 4 (0x2c->0x28,
0x24->0x20, 0x1c->0x18), i.e. something got 4 bytes smaller. Both files are the
same size and the solver's arithmetic is untouched, but glue and wasm are built
as a pair and are shipped as one. Mixing this glue with the published wasm was
measured to pass the solver suites, and is still not worth doing: pairing costs
508 KB and removes the question.

    69 solver tests passed against the first pair (sketchSolve,
    constraintSequences, solver), matching the published pair. Against the
    growable pair the same three suites, grown since, pass 92 of 92.

KEEPING IT HONEST

scripts/vendor-planegcs.mjs verifies both checksums on every install and refuses
rather than installing something unexpected. src/security/noDynamicEval.test.ts
keeps src/params/parse.ts and src/params/eval.ts hand-written, because a
`new Function` there would become reachable the moment the policy is loosened
again.
