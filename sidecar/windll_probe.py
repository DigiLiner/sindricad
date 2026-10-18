"""Which DLL in numpy's load chain refuses to load, for a Windows startup failure.

Field report 14928c4f (0.1.232, Windows): the engine never started because
`import numpy` died with "DLL load failed while importing _multiarray_umath",
Windows error 1114: a DLL was found and mapped, and then its init routine
returned FALSE. Every DLL in that chain ships with the runtime (numpy vendors
OpenBLAS and msvcp140 in numpy.libs, python-build-standalone puts vcruntime140
next to python.exe), so the log could not say which one failed or why, and the
user's machine is the only place that can answer it. Security software hooking
or blocking a DLL at load is the likeliest cause.

server.py calls main() only when its `import numpy` fails that way, and then
re-raises numpy's own ImportError unchanged. That order is load-bearing: the
Rust shell reads the LAST stderr line as the cause (sidecar.rs classify_exit),
and is_dll_init_failure needs it to stay numpy's "Original error was: DLL load
failed ...". So everything here goes to stderr BEFORE the traceback, and nothing
here may raise: a diagnostic that breaks the error it is diagnosing is worse
than none.

No numpy import (it is the thing that just failed): numpy is located with
importlib.util.find_spec, which finds the package without running it.
"""

import ctypes
import importlib.util
import os
import platform as _platform
import sys

TAG = "[windll_probe]"


def _numpy_dir():
    spec = importlib.util.find_spec("numpy")
    if spec is None or not spec.submodule_search_locations:
        return None
    return list(spec.submodule_search_locations)[0]


def _chain(numpy_dir):
    """The files to load, in load order: numpy.libs (the vendored DLLs the
    extension links against) first, then the extension itself."""
    libs = os.path.join(os.path.dirname(numpy_dir), "numpy.libs")
    files = []
    if os.path.isdir(libs):
        files += [os.path.join(libs, n) for n in sorted(os.listdir(libs)) if n.lower().endswith(".dll")]
    core = os.path.join(numpy_dir, "_core")
    if os.path.isdir(core):
        files += [
            os.path.join(core, n)
            for n in sorted(os.listdir(core))
            if n.startswith("_multiarray_umath") and n.lower().endswith(".pyd")
        ]
    return files


def main(platform=None, loader=None, numpy_dir=None, out=None):
    """Print the Windows version and one line per DLL in the chain to stderr.

    Returns [(path, error text or None)], empty when nothing was probed (not
    Windows, numpy not found, or the probe itself failed). The arguments exist
    so a test can drive the Windows branch anywhere; the app passes none."""
    platform = sys.platform if platform is None else platform
    out = sys.stderr if out is None else out
    if platform != "win32":
        return []
    results = []
    try:
        loader = ctypes.WinDLL if loader is None else loader
        winver = getattr(sys, "getwindowsversion", None)
        print(f"{TAG} windows {tuple(winver()) if winver else 'unknown'} on {_platform.machine()}", file=out)
        numpy_dir = _numpy_dir() if numpy_dir is None else numpy_dir
        if numpy_dir is None:
            print(f"{TAG} numpy not found on sys.path", file=out)
            return results
        site = os.path.dirname(numpy_dir)
        for path in _chain(numpy_dir):
            name = os.path.relpath(path, site)
            try:
                loader(path)
            except OSError as e:
                results.append((path, str(e)))
                print(f"{TAG} FAIL {name}: {e}", file=out)
            else:
                results.append((path, None))
                print(f"{TAG} ok   {name}", file=out)
    except Exception as e:  # noqa: BLE001 -- see the module docstring
        print(f"{TAG} probe failed: {type(e).__name__}: {e}", file=out)
    try:
        out.flush()
    except Exception:  # noqa: BLE001
        pass
    return results
