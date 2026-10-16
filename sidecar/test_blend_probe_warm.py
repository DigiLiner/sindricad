"""The fillet/chamfer hang probe answers from ONE warm child, not a cold interpreter per question.

Run: uv run python test_blend_probe_warm.py   (or .venv/bin/python test_blend_probe_warm.py)

Field report 5be73f3d ("chamfer speed"): on a body with more than 60 edges every
chamfer or fillet probes for a hang in a separate process, and that process was a
fresh `python -c "import builder; ..."` per question. The kernel call takes a few
milliseconds; the import of build123d took ~1.9 s here and ~16 s on the
reporter's Windows laptop, so every preview value dragged upward and every edge
clicked in cost that much. These checks enter where the app does, through
`rebuild_cached` (what the worker runs for a live preview), and count the
interpreters actually started.

The lifecycle cases (timeout, a child that dies, chatter on its stdout, idle
expiry) swap the child for a tiny real one through `_BLEND_PROBE_CHILD_CMD`, so
the pipes, threads and deadlines under test are the real ones.
"""

import contextlib
import io
import os
import subprocess
import sys
import time

os.environ.setdefault("SINDRI_DISK_CACHE", "0")  # every case starts from a cold, RAM-only cache
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402

PASS = "  ok"
PY = sys.executable

# Fake children. Each carries the "blend_probe" marker the spawn counter looks for.
_READY = 'import sys, json, time; print(json.dumps({"ready": True}), flush=True)\n'
SLEEPER = [PY, "-c", _READY + "time.sleep(60)  # blend_probe fake: ready, then never answers"]
NEVER_READY = [PY, "-c", "import time; time.sleep(60)  # blend_probe fake: a start that never ends"]
DIES_AT_START = [PY, "-c", "pass  # blend_probe fake: exits before it is ready"]
DIES_ANSWERING = [PY, "-c", _READY + "sys.stdin.readline()  # blend_probe fake: dies on the recipe"]
CHATTY = [PY, "-c", _READY + (
    "for line in sys.stdin:  # blend_probe fake\n"
    "    rec = json.loads(line)\n"
    "    print('kernel chatter', flush=True)\n"
    "    print(json.dumps({'id': -1, 'blend': True}), flush=True)\n"
    "    sys.stdout.write('partial'); sys.stdout.flush()\n"
    "    print('\\n' + json.dumps({'id': rec['id'], 'blend': True}), flush=True)\n")]
# Answers the first recipe TWICE, then hangs on the second.
STALE = [PY, "-c", _READY + (
    "rec = json.loads(sys.stdin.readline())  # blend_probe fake\n"
    "for _ in range(2):\n"
    "    print(json.dumps({'id': rec['id'], 'blend': True}), flush=True)\n"
    "sys.stdin.readline()\n"
    "time.sleep(60)\n")]

_SAVED = {k: getattr(builder, k) for k in (
    "_BLEND_PROBE_CHILD_CMD", "_BLEND_PROBE_TIMEOUT", "_BLEND_PROBE_TICK",
    "_BLEND_PROBE_IDLE_S", "_BLEND_PROBE_RECYCLE")}


def _reset():
    """Every case starts from nothing: no cached prefix, no cached verdict, no child."""
    builder._blend_probe_discard(kill=True)
    for k, v in _SAVED.items():
        setattr(builder, k, v)
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    builder._BLEND_PROBE_CACHE.clear()


class _Spawns:
    """Count the probe interpreters started, still starting them for real. Only a
    Popen whose argv names the blend probe counts: an unrelated subprocess must
    neither satisfy nor spoil the count."""

    def __enter__(self):
        self.procs = []
        self._popen = subprocess.Popen
        outer = self

        class _Counting(self._popen):
            def __init__(self, args, *a, **k):
                super().__init__(args, *a, **k)
                if "blend_probe" in " ".join(map(str, args)):
                    outer.procs.append(self)

        subprocess.Popen = _Counting
        return self

    @property
    def n(self):
        return len(self.procs)

    def __exit__(self, *_exc):
        subprocess.Popen = self._popen
        return False


def _sel(p):
    return {"kind": "edge", "by": "nearest", "point": list(p)}


# A 40x30x20 box, every edge chamfered at 1.0 (48 edges, under the heuristic),
# then four of the new edges at 0.3: 68 edges, so the next blend is probed.
_BOX = {"id": "b1", "type": "box", "length": 40, "width": 30, "height": 20}
_BOX_EDGES = [(-20, -15, 0), (-20, 0, 10), (-20, 15, 0), (-20, 0, -10), (20, -15, 0), (20, 0, 10),
              (20, 15, 0), (20, 0, -10), (0, -15, -10), (0, -15, 10), (0, 15, -10), (0, 15, 10)]
_F2 = {"id": "f2", "type": "chamfer", "edges": [_sel(p) for p in _BOX_EDGES], "distance": 1.0}
_F3 = {"id": "f3", "type": "chamfer", "distance": 0.3, "edges": [
    _sel(p) for p in ((-20, 0, 9), (-19, 0, 10), (0, -15, 9), (20, 0, 9))]}


def _doc(f4_distance=None):
    feats = [_BOX, _F2, _F3]
    if f4_distance is not None:
        feats.append({"id": "f4", "type": "chamfer", "edges": _sel((0, 15, -9)),
                      "distance": f4_distance})
    return {"parameters": {}, "features": [dict(f) for f in feats]}


def _build(f4_distance):
    """One live-preview rebuild of the chamfer at `f4_distance`: (errors, bodies, seconds, log)."""
    out = io.StringIO()
    t = time.monotonic()
    with contextlib.redirect_stdout(out):
        _part, err, bodies = builder.rebuild_cached(_doc(f4_distance))
    return err, bodies, time.monotonic() - t, out.getvalue()


def _probe_entry():
    assert len(builder._BLEND_PROBE_CACHE) == 1, \
        f"expected one probed edge set, cache holds {len(builder._BLEND_PROBE_CACHE)}"
    return next(iter(builder._BLEND_PROBE_CACHE.values()))


def test_a_drag_on_a_many_edge_body_starts_one_interpreter():
    """The bug: five upward preview values of one chamfer on a 68-edge body."""
    _reset()
    try:
        _part, err, bodies = builder.rebuild(_doc())
        assert not err, err
        n_edges = len(bodies[0]["shape"].edges())
        assert n_edges > 60, f"fixture has {n_edges} edges, under the probe heuristic: proves nothing"

        sizes = (0.10, 0.15, 0.20, 0.25, 0.30)
        with _Spawns() as spawns:
            runs = [_build(d) for d in sizes]
        for d, (err, _b, _s, _log) in zip(sizes, runs):
            assert not err, f"f4 at {d}: {err}"
        for d, (_e, _b, _s, log) in zip(sizes[1:], runs[1:]):
            assert "features=4 resume_from=3 src=RAM" in log, \
                f"f4 at {d} did not take the live-preview path: {log.strip()!r}"
        secs = [round(s, 3) for _e, _b, s, _l in runs]
        print(f"    per-value rebuild seconds: {secs}")
        assert spawns.n == 1, (
            f"{spawns.n} probe interpreters for {len(sizes)} preview values; each one is a cold "
            "import of build123d (~2 s here, ~16 s on the reporter's machine)")
        for d, s in zip(sizes[1:], secs[1:]):
            assert s < secs[0] / 2, \
                f"f4 at {d} took {s} s against {secs[0]} s for the first value: still paying a start"
        assert _probe_entry()[0] == 0.30, "the largest size that passed was not remembered"
        assert builder._BLEND_PROBE_CHILD is not None \
            and builder._BLEND_PROBE_CHILD.proc.poll() is None, "the warm child did not stay up"

        # The probe decides only whether to build: the geometry is the unprobed build's.
        warm = runs[-1][1][0]["shape"]
        real = builder._blend_needs_probing
        builder._blend_needs_probing = lambda *_a: False
        try:
            _p, err, ref = builder.rebuild(_doc(0.30))
        finally:
            builder._blend_needs_probing = real
        assert not err, err
        assert abs(warm.volume - ref[0]["shape"].volume) < 1e-6 \
            and len(warm.faces()) == len(ref[0]["shape"].faces()), "the probed build changed the geometry"
    finally:
        _reset()
    print(f"{PASS} five preview values on a 68-edge body start one probe interpreter")


def test_a_probe_that_never_answers_still_refuses_and_is_killed():
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = SLEEPER
        builder._BLEND_PROBE_TIMEOUT, builder._BLEND_PROBE_TICK = 1.0, 0.1
        with _Spawns() as spawns:
            err, _b, _s, _l = _build(0.10)
        assert err and "did not finish" in str(err[0].get("message", "")), \
            f"a probe past its deadline did not refuse the chamfer: {err}"
        assert spawns.n == 1 and spawns.procs[0].poll() is not None, "the hung child was left running"
        assert builder._BLEND_PROBE_CHILD is None, "a killed child is still the one asked next"
        assert 0.10 in _probe_entry()[1], "the timeout was not remembered for that size"

        # A NEW size: the same document would replay the refused feature from RAM.
        builder._BLEND_PROBE_CHILD_CMD = None
        builder._BLEND_PROBE_TIMEOUT = _SAVED["_BLEND_PROBE_TIMEOUT"]
        with _Spawns() as again:
            err, _b, _s, _l = _build(0.11)
        assert not err, f"after a timeout the next size could not build: {err}"
        assert again.n == 1 and builder._BLEND_PROBE_CHILD.proc.poll() is None, \
            "no fresh child was started after the hung one was killed"
    finally:
        _reset()
    print(f"{PASS} a child past the deadline refuses, is killed, and the next size gets a fresh one")


def test_a_child_that_dies_at_start_fails_open_after_one_retry():
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = DIES_AT_START
        t = time.monotonic()
        with _Spawns() as spawns:
            err, _b, _s, _l = _build(0.10)
        assert not err, f"a broken probe blocked a valid chamfer: {err}"
        assert spawns.n == 2, f"{spawns.n} starts: expected the first plus exactly one retry"
        assert time.monotonic() - t < 5, "a child that cannot start held the rebuild"
        assert builder._BLEND_PROBE_CHILD is None
        assert not builder._BLEND_PROBE_CACHE, "a probe that never ran was cached as a pass"
    finally:
        _reset()
    print(f"{PASS} a child that cannot start fails open after one retry and caches nothing")


def test_a_child_that_dies_answering_fails_open_without_a_retry():
    """A crash on the recipe would crash again: retrying costs two more starts for nothing."""
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = DIES_ANSWERING
        with _Spawns() as spawns:
            err, _b, _s, _l = _build(0.10)
        assert not err, f"a probe that crashed blocked a valid chamfer: {err}"
        assert spawns.n == 1, f"{spawns.n} starts for a child that died on the recipe"
        assert builder._BLEND_PROBE_CHILD is None and not builder._BLEND_PROBE_CACHE
    finally:
        _reset()
    print(f"{PASS} a child that dies on the recipe fails open with no retry")


def test_a_start_that_never_finishes_fails_open():
    """A machine too slow to import inside the budget is not a hang in the blend."""
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = NEVER_READY
        builder._BLEND_PROBE_TIMEOUT, builder._BLEND_PROBE_TICK = 1.0, 0.1
        with _Spawns() as spawns:
            err, _b, _s, _l = _build(0.10)
        assert not err, f"a slow start refused a valid chamfer: {err}"
        assert spawns.n == 1 and spawns.procs[0].poll() is not None, "the stuck start was left running"
        assert builder._BLEND_PROBE_CHILD is None and not builder._BLEND_PROBE_CACHE
    finally:
        _reset()
    print(f"{PASS} a start past the deadline is killed and fails open")


def test_chatter_on_the_childs_stdout_is_not_an_answer():
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = CHATTY
        with _Spawns() as spawns:
            for d in (0.10, 0.15):
                err, _b, _s, _l = _build(d)
                assert not err, f"f4 at {d}: {err}"
        assert spawns.n == 1, f"{spawns.n} starts: chatter desynchronised the protocol"
        assert _probe_entry()[0] == 0.15
    finally:
        _reset()
    print(f"{PASS} stray lines and a stale id on the child's stdout are skipped")


def test_a_stale_reply_never_answers_a_later_recipe():
    """A leftover reply to an earlier recipe must not clear a blend that hangs."""
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = STALE
        err, _b, _s, _l = _build(0.10)
        assert not err, err
        builder._BLEND_PROBE_TIMEOUT, builder._BLEND_PROBE_TICK = 1.0, 0.1
        err, _b, _s, _l = _build(0.15)
        assert err and "did not finish" in str(err[0].get("message", "")), \
            f"a hanging blend was cleared by the previous recipe's duplicate reply: {err}"
    finally:
        _reset()
    print(f"{PASS} a duplicate reply to an earlier recipe does not clear a hang")


def test_an_idle_child_exits_and_the_next_probe_starts_another():
    _reset()
    try:
        builder._BLEND_PROBE_IDLE_S = 0.5
        with _Spawns() as spawns:
            err, _b, _s, _l = _build(0.10)
            assert not err, err
            child = builder._BLEND_PROBE_CHILD
            assert child is not None and builder._BLEND_PROBE_IDLE_TIMER.daemon, \
                "the idle timer is not a daemon: every script that probed would hang at exit"
            deadline = time.monotonic() + 5
            while child.proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert child.proc.returncode == 0, \
                f"the idle child did not exit cleanly on its own (rc {child.proc.returncode})"
            assert builder._BLEND_PROBE_CHILD is None
            err, _b, _s, _l = _build(0.15)
            assert not err, err
        assert spawns.n == 2, f"{spawns.n} starts: the probe after the idle expiry did not respawn"
    finally:
        _reset()
    print(f"{PASS} an idle child exits on its own and the next probe starts a fresh one")


def test_a_long_lived_child_is_recycled():
    _reset()
    try:
        builder._BLEND_PROBE_CHILD_CMD = CHATTY
        builder._BLEND_PROBE_RECYCLE = 2
        with _Spawns() as spawns:
            for d in (0.10, 0.15, 0.20):
                err, _b, _s, _l = _build(d)
                assert not err, f"f4 at {d}: {err}"
        assert spawns.n == 2, f"{spawns.n} starts for 3 probes with a recycle every 2"
        assert spawns.procs[0].returncode == 0, "the recycled child was not shut down cleanly"
    finally:
        _reset()
    print(f"{PASS} the child is replaced after _BLEND_PROBE_RECYCLE answers")


if __name__ == "__main__":
    print("blend probe: one warm child")
    test_a_drag_on_a_many_edge_body_starts_one_interpreter()
    test_a_probe_that_never_answers_still_refuses_and_is_killed()
    test_a_child_that_dies_at_start_fails_open_after_one_retry()
    test_a_child_that_dies_answering_fails_open_without_a_retry()
    test_a_start_that_never_finishes_fails_open()
    test_chatter_on_the_childs_stdout_is_not_an_answer()
    test_a_stale_reply_never_answers_a_later_recipe()
    test_an_idle_child_exits_and_the_next_probe_starts_another()
    test_a_long_lived_child_is_recycled()
    print("all blend probe tests passed")
