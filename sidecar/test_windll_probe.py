"""The Windows DLL probe that runs when the engine's `import numpy` fails.

Run: uv run python test_windll_probe.py   (or .venv/bin/python test_windll_probe.py)

Field report 14928c4f: numpy's `_multiarray_umath` failed to initialise on one
Windows machine (error 1114) and the log could not say which DLL refused. The
probe names it. These tests run anywhere: the Windows branch is driven with an
injected loader, and the end-to-end test runs the REAL server.py in a
subprocess with a stand-in numpy that fails the way the field log did.

What has to hold, in order of how much it matters:
  * numpy's own ImportError still ends stderr, unchanged. The Rust shell takes
    the last stderr line as the cause and matches "DLL load failed" on it to
    show the antivirus/damaged-install hint (sidecar.rs classify_exit).
  * the probe never raises, and never runs off Windows.
  * the line for the failing DLL names it, with the Windows error.
"""

import io
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import windll_probe  # noqa: E402

PASS = "  ok"
WINERR = "[WinError 1114] A dynamic link library (DLL) initialization routine failed"
NUMPY_TAIL = (
    "Original error was: DLL load failed while importing _multiarray_umath: "
    "A dynamic link library (DLL) initialization routine failed."
)


def _fake_site(tmp):
    """A site-packages with numpy laid out as the win_amd64 wheel ships it.
    Its __init__ fails exactly as numpy 2.x does when the extension's DLL init
    fails: the loader's error, re-raised inside numpy's long advice message."""
    site = os.path.join(tmp, "site")
    core = os.path.join(site, "numpy", "_core")
    libs = os.path.join(site, "numpy.libs")
    os.makedirs(core)
    os.makedirs(libs)
    for p in (
        os.path.join(libs, "libscipy_openblas64_-b788.dll"),
        os.path.join(libs, "msvcp140-a4c2.dll"),
        os.path.join(core, "_multiarray_umath.cp312-win_amd64.pyd"),
        os.path.join(core, "_umath_linalg.cp312-win_amd64.pyd"),  # not in the chain probed
    ):
        open(p, "wb").close()
    with open(os.path.join(site, "numpy", "__init__.py"), "w") as f:
        f.write(
            "try:\n"
            "    raise ImportError('DLL load failed while importing _multiarray_umath: "
            "A dynamic link library (DLL) initialization routine failed.')\n"
            "except ImportError as exc:\n"
            "    msg = '\\n\\nIMPORTANT: PLEASE READ THIS FOR ADVICE ON HOW TO SOLVE THIS ISSUE!\\n\\n'"
            " + f'Original error was: {exc}\\n'\n"
            "    raise ImportError(msg) from exc\n"
        )
    return site


def _loader_failing_on(fragment):
    loaded = []

    def load(path):
        loaded.append(os.path.basename(path))
        if fragment in os.path.basename(path):
            raise OSError(WINERR)

    return load, loaded


def test_names_the_dll_that_fails_with_its_windows_error():
    tmp = tempfile.mkdtemp()
    try:
        site = _fake_site(tmp)
        load, loaded = _loader_failing_on("msvcp140")
        out = io.StringIO()
        got = windll_probe.main(platform="win32", loader=load, numpy_dir=os.path.join(site, "numpy"), out=out)
        lines = out.getvalue().splitlines()
        assert lines[0].startswith("[windll_probe] windows "), lines
        # numpy.libs first (what the extension links against), then the extension
        assert loaded == [
            "libscipy_openblas64_-b788.dll",
            "msvcp140-a4c2.dll",
            "_multiarray_umath.cp312-win_amd64.pyd",
        ], loaded
        fails = [ln for ln in lines if " FAIL " in ln]
        assert len(fails) == 1, lines
        assert "msvcp140-a4c2.dll" in fails[0] and "WinError 1114" in fails[0], fails
        assert sum(" ok " in ln for ln in lines) == 2, lines
        assert [os.path.basename(p) for p, err in got if err] == ["msvcp140-a4c2.dll"], got
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} names the failing DLL and its Windows error, the others ok")


def test_is_a_no_op_off_windows():
    out = io.StringIO()
    calls = []
    got = windll_probe.main(platform="linux", loader=calls.append, numpy_dir="/nowhere", out=out)
    assert got == [] and calls == [] and out.getvalue() == "", (got, calls, out.getvalue())
    print(f"{PASS} prints and loads nothing off Windows")


def test_never_raises():
    def explode(path):
        raise RuntimeError("a loader that does not even raise OSError")

    tmp = tempfile.mkdtemp()
    try:
        site = _fake_site(tmp)
        out = io.StringIO()
        windll_probe.main(platform="win32", loader=explode, numpy_dir=os.path.join(site, "numpy"), out=out)
        assert "probe failed: RuntimeError" in out.getvalue(), out.getvalue()
        # a numpy dir that is not there is said, not raised
        out = io.StringIO()
        windll_probe.main(platform="win32", loader=lambda p: None, numpy_dir=os.path.join(tmp, "gone"), out=out)
        # and with no WinDLL at all (what ctypes has off Windows)
        out = io.StringIO()
        windll_probe.main(platform="win32", out=out)
        assert "[windll_probe]" in out.getvalue(), out.getvalue()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} never raises: a bad loader, a missing numpy dir, no WinDLL")


def test_server_startup_prints_the_probe_and_keeps_numpys_error_last():
    """The real server.py, started the way the shell starts it, with a numpy
    whose import fails as in 14928c4f. The probe is pointed at Windows and an
    injected loader (this test runs on any OS); everything else is real."""
    tmp = tempfile.mkdtemp()
    try:
        site = _fake_site(tmp)
        driver = (
            "import functools, os, runpy, sys\n"
            f"sys.path.insert(0, {site!r})\n"
            f"sys.path.insert(1, {HERE!r})\n"
            "import windll_probe\n"
            "def load(path):\n"
            "    if 'msvcp140' in os.path.basename(path):\n"
            f"        raise OSError({WINERR!r})\n"
            "windll_probe.main = functools.partial(windll_probe.main, platform='win32', loader=load)\n"
            f"runpy.run_path({os.path.join(HERE, 'server.py')!r}, run_name='__main__')\n"
        )
        env = dict(os.environ, SINDRI_SIDECAR_PORT="1", SINDRI_DISK_CACHE="0")
        p = subprocess.run(
            [sys.executable, "-c", driver], cwd=HERE, env=env, capture_output=True, text=True, timeout=120
        )
        err = p.stderr
        assert p.returncode != 0, f"server.py started with a numpy that cannot import: {err}"
        assert "[windll_probe] FAIL numpy.libs" in err and "msvcp140-a4c2.dll" in err, err
        # the probe comes BEFORE the traceback, and numpy's line ends it
        assert err.index("[windll_probe]") < err.index("Traceback"), err
        last = [ln.strip() for ln in err.splitlines() if ln.strip()][-1]
        assert last == NUMPY_TAIL, f"the last stderr line changed: {last!r}"
        assert "DLL load failed" in last  # what is_dll_init_failure matches on
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} server startup: probe first, numpy's own error still the last line")


def test_a_probe_that_cannot_import_still_leaves_numpys_error_last():
    tmp = tempfile.mkdtemp()
    try:
        site = _fake_site(tmp)
        driver = (
            "import runpy, sys\n"
            f"sys.path.insert(0, {site!r})\n"
            "sys.modules['windll_probe'] = None  # import windll_probe now raises ImportError\n"
            f"runpy.run_path({os.path.join(HERE, 'server.py')!r}, run_name='__main__')\n"
        )
        p = subprocess.run(
            [sys.executable, "-c", driver], cwd=HERE, capture_output=True, text=True, timeout=120
        )
        assert p.returncode != 0
        assert "During handling" not in p.stderr, p.stderr
        last = [ln.strip() for ln in p.stderr.splitlines() if ln.strip()][-1]
        assert last == NUMPY_TAIL, f"the last stderr line changed: {last!r}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} a probe that cannot even import leaves numpy's error last")


def test_an_import_failure_that_is_not_a_dll_load_runs_no_probe():
    tmp = tempfile.mkdtemp()
    try:
        site = os.path.join(tmp, "site")
        os.makedirs(os.path.join(site, "numpy"))
        with open(os.path.join(site, "numpy", "__init__.py"), "w") as f:
            f.write("raise ImportError('No module named numpy._core._multiarray_umath')\n")
        driver = (
            "import functools, runpy, sys\n"
            f"sys.path.insert(0, {site!r})\n"
            f"sys.path.insert(1, {HERE!r})\n"
            "import windll_probe\n"
            "windll_probe.main = functools.partial(windll_probe.main, platform='win32', loader=lambda p: None)\n"
            f"runpy.run_path({os.path.join(HERE, 'server.py')!r}, run_name='__main__')\n"
        )
        p = subprocess.run(
            [sys.executable, "-c", driver], cwd=HERE, capture_output=True, text=True, timeout=120
        )
        assert p.returncode != 0
        assert "[windll_probe]" not in p.stderr, p.stderr
        assert p.stderr.strip().splitlines()[-1].endswith("No module named numpy._core._multiarray_umath"), p.stderr
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} any other import failure is left alone")


if __name__ == "__main__":
    print("windll_probe: the Windows numpy DLL diagnostic")
    test_names_the_dll_that_fails_with_its_windows_error()
    test_is_a_no_op_off_windows()
    test_never_raises()
    test_server_startup_prints_the_probe_and_keeps_numpys_error_last()
    test_a_probe_that_cannot_import_still_leaves_numpys_error_last()
    test_an_import_failure_that_is_not_a_dll_load_runs_no_probe()
    print("all windll_probe tests passed")
