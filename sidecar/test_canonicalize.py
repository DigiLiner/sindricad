"""_canonicalize's validation gate, and the paths that could bypass it.

Run: uv run python test_canonicalize.py

_canonicalize snaps near-analytic spline faces to true planes/cylinders ONCE at
import, and the result is baked into the stored B-rep. That makes its accept/
reject decision permanent and invisible: a wrong "accept" is not a slow rebuild,
it is the user's geometry quietly replaced by something else forever.

Two ways round the gate existed. SweptToElementary's output was returned
unvalidated whenever no spline face needed converting, and the multi-root import
path handed the gate a compound of compounds, whose volume it cannot measure.
The SweptToElementary pass is gone since: it segfaulted the worker on STEP files
with swept faces (row 1bd80dc2), which the last two tests pin.
"""

import os
import sys

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402
from builder import _canonical_ok  # noqa: E402
from build123d import Box, Compound, Cylinder, Sphere  # noqa: E402

PASS = "  ok"
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def test_an_identical_shape_is_accepted():
    b = Box(10, 10, 10)
    assert _canonical_ok(b, b) is True
    print(f"{PASS} a shape is an acceptable canonicalisation of itself")


def test_a_volume_change_is_rejected():
    """The gate's whole job. 0.5% is the tolerance; 10% must not pass."""
    assert _canonical_ok(Box(10, 10, 11), Box(10, 10, 10)) is False
    # ...and a change well inside the tolerance is allowed through
    assert _canonical_ok(Box(10, 10, 10.02), Box(10, 10, 10)) is True
    print(f"{PASS} a 10% volume change is rejected, 0.2% is allowed")


def test_a_face_count_change_is_rejected():
    """Same volume, different topology: a canonicalisation that merged or split
    faces has changed what the user can select and dimension."""
    assert _canonical_ok(Cylinder(5, 10), Box(10, 10, 10)) is False
    print(f"{PASS} a face-count change is rejected even at a similar volume")


def test_a_solid_count_change_is_rejected():
    one = Box(10, 10, 10)
    two = Compound([Box(10, 10, 10), Box(10, 10, 10).moved(__import__("build123d").Location((40, 0, 0)))])
    assert _canonical_ok(two, one) is False
    print(f"{PASS} a solid-count change is rejected")


def test_an_unmeasurable_result_is_rejected():
    """Any doubt is a NO. This decides what gets baked permanently into the
    stored B-rep, so an exception anywhere in the checks must not read as pass."""
    class Broken:
        @property
        def wrapped(self):
            raise RuntimeError("no shape here")

        def solids(self):
            raise RuntimeError("no solids")

        def faces(self):
            raise RuntimeError("no faces")

    assert _canonical_ok(Broken(), Box(10, 10, 10)) is False
    assert _canonical_ok(Box(10, 10, 10), Broken()) is False
    print(f"{PASS} an unmeasurable result is rejected, not accepted by accident")


def test_the_gate_cannot_measure_a_compound_of_compounds():
    """Documents WHY the multi-root import path must canonicalise per root.

    Compound.volume does not recurse into nested compounds, so a nested shape
    reads a partial volume and compares unequal to itself. Not a bug in the gate
    — a limit of the measurement, which is exactly why callers with multi-root
    input have to work per root instead of handing the whole thing in."""
    inner = Compound([Box(10, 10, 10)])
    nested = Compound([inner])
    flat = Box(10, 10, 10)
    # A flat compound measures fine...
    assert _canonical_ok(Compound([flat]), flat) is True
    # ...a nested one does not, which would silently fail every canonicalisation.
    assert _canonical_ok(nested, flat) is False
    print(f"{PASS} the gate cannot measure nested compounds — hence per-root")


def test_multi_root_canonicalises_each_root_separately():
    """`_canonicalize_roots` must hand the gate one root at a time.

    Tested directly rather than through import_geometry, because the branch it
    serves turned out to be hard to reach on purpose: a STEP written from two
    free shapes by OCCT's own writer gains a wrapper product (2 roots arrive as
    3 nodes), so step_assembly classifies it as an assembly and it takes the
    per-leaf path instead. Driving it through an import would have measured the
    ASSEMBLY path while claiming to measure this one — which is how a test comes
    to pass for the wrong reason."""
    seen = []
    real = builder._canonicalize
    builder._canonicalize = lambda s, tol=1e-3: (seen.append(s), real(s, tol))[1]
    try:
        roots = [Box(20, 20, 4).wrapped, Box(8, 8, 8).wrapped, Cylinder(3, 9).wrapped]
        out = builder._canonicalize_roots(roots)
    finally:
        builder._canonicalize = real

    assert len(seen) == len(roots), (
        f"{len(seen)} canonicalise calls for {len(roots)} roots — the whole "
        "compound went in as one, which the gate cannot measure"
    )
    # Every root must be handed in individually, never a compound of them.
    for s in seen:
        assert len(s.solids()) == 1, f"a root arrived as {len(s.solids())} solids"
    # And nothing is lost on the way out.
    assert len(out.solids()) == len(roots), (
        f"{len(out.solids())} solids out of {len(roots)} roots"
    )
    print(f"{PASS} {len(seen)} separate canonicalise calls for {len(roots)} roots, "
          f"{len(out.solids())} solids out")


def test_multi_root_skips_unwrappable_roots_without_losing_the_rest():
    """A root that will not wrap must not take the whole import down with it."""
    out = builder._canonicalize_roots([Box(10, 10, 10).wrapped, None])
    assert len(out.solids()) == 1, len(out.solids())
    print(f"{PASS} an unwrappable root is skipped, the rest survive")


def test_import_still_produces_the_same_geometry():
    """The per-root change must not alter what any fixture imports."""
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    def faces(sh):
        e = TopExp_Explorer(sh, TopAbs_FACE)
        n = 0
        while e.More():
            n += 1
            e.Next()
        return n

    for name in ("asm_flat", "asm_multisolid", "asm_nested"):
        path = os.path.join(FIXTURES, f"{name}.step")
        pay = builder.import_geometry(path, "step")
        doc = {"parameters": {}, "features": [
            {"id": "im", "type": "import", "format": "step", "name": pay["name"],
             "geom": pay["geom"]}]}
        _p, err, bodies = builder.rebuild(doc)
        assert not err, f"{name}: {err}"
        total = sum(faces(b["shape"].wrapped) for b in bodies)
        assert total > 0, name
        print(f"{PASS} {name}: {len(bodies)} bodies, {total} faces")


def _surface_kinds(shape):
    from collections import Counter

    from OCP.BRepAdaptor import BRepAdaptor_Surface

    return Counter(
        str(BRepAdaptor_Surface(f.wrapped).GetType()).rsplit(".", 1)[-1]
        for f in shape.faces()
    )


def _import_in_child(fn, *args):
    """Run an import in a forked child so a kernel SEGFAULT fails this test with
    an exit code instead of killing the whole runner. Returns (exitcode, payload)."""
    import multiprocessing

    ctx = multiprocessing.get_context("fork")
    q = ctx.Queue()

    def run():
        res = fn(*args)
        q.put({k: res.get(k) for k in
               ("faces", "solid", "name", "geom", "nodes", "parts", "error")})

    p = ctx.Process(target=run)
    p.start()
    p.join(120)
    if p.is_alive():
        p.terminate()
        p.join()
        raise AssertionError("the import hung for 120 s")
    # the payload is a few hundred bytes (geom is a blob hash), so reading the
    # queue after join cannot deadlock on a full pipe
    return p.exitcode, (q.get(timeout=5) if p.exitcode == 0 else None)


def test_a_swept_face_next_to_ordinary_faces_imports():
    """Row 1bd80dc2: exporting a model with a revolve to STEP and importing that
    STEP back killed the geometry worker. OCCT's whole-shape SweptToElementary
    modifier dereferences a null face for every ordinary face next to a swept
    one (BRepTools_Modifier::CreateOtherVertices), so the pass segfaulted on any
    realistic solid carrying a surface of revolution. Enters where the user does:
    the server's own export job, then its import job, on the app's document. Two
    bodies make the export an assembly, which is the per-leaf branch the field
    file took."""
    import tempfile

    import server

    doc = {"version": 5, "parameters": {}, "features": [
        {"id": "rs", "type": "sketch", "plane": "XZ", "entities": [
            {"id": "l0", "type": "line", "x1": 10, "y1": -5, "x2": 16, "y2": -5},
            {"id": "l1", "type": "line", "x1": 16, "y1": -5, "x2": 16, "y2": 5},
            {"id": "l2", "type": "line", "x1": 16, "y1": 5, "x2": 13, "y2": 5},
            {"id": "sp", "type": "spline", "points": [
                {"x": 13, "y": 5}, {"x": 11, "y": 2}, {"x": 12, "y": -2},
                {"x": 10, "y": -5}]}]},
        {"id": "rv", "type": "revolve", "sketch": "rs", "axis": "Z", "angle": 120},
        {"id": "bx", "type": "box", "length": 5, "width": 5, "height": 5,
         "origin": [40, 0, 0]}]}
    _p, err, src = builder.rebuild(doc)
    assert not err, err
    src_kinds = [_surface_kinds(b["shape"]) for b in src]
    # the trigger must survive in the source, or this test proves nothing
    assert any(k["GeomAbs_SurfaceOfRevolution"] for k in src_kinds), src_kinds

    out = os.path.join(tempfile.mkdtemp(), "revolve.step")
    res = server._export_job(doc, "step", out)
    assert "error" not in res, res

    code, pay = _import_in_child(server._import_job, out, "step")
    assert code == 0, (f"the import child exited {code} "
                       "(-11 is the SweptToElementary segfault)")
    assert pay["error"] is None, pay["error"]
    assert (pay["faces"], pay["solid"]) == (12, True), (pay["faces"], pay["solid"])
    assert sorted(pt["faces"] for pt in pay["parts"]) == [6, 6], pay["parts"]

    _p, err, got = builder.rebuild({"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "step", "name": pay["name"],
         "geom": pay["geom"], "nodes": pay["nodes"], "parts": pay["parts"]}]})
    assert not err, err

    def summary(bodies):
        return sorted((round(b["shape"].volume, 6), sorted(_surface_kinds(b["shape"]).items()))
                      for b in bodies)

    assert summary(got) == summary(src), (summary(got), summary(src))
    print(f"{PASS} a revolve with a spline profile round-trips through STEP: "
          f"{len(got)} bodies, same faces and volumes")


def test_a_body_made_only_of_swept_faces_imports():
    """The same crash without any ordinary neighbour: a dome revolved from two
    splines touching the axis has two surfaces of revolution and degenerate apex
    edges, and the degenerate edges reach the same null-face probe."""
    import tempfile

    from build123d import Axis, Line, Spline, make_face, revolve

    import exporters

    dome = revolve(make_face(Spline((0, 9), (6, 8), (10, 5))
                             + Spline((10, 5), (7, 1), (0, 0))
                             + Line((0, 0), (0, 9))), Axis.Y, 360)
    assert _surface_kinds(dome)["GeomAbs_SurfaceOfRevolution"] == 2, _surface_kinds(dome)
    out = os.path.join(tempfile.mkdtemp(), "dome.step")
    exporters.export(dome, "step", out)

    code, pay = _import_in_child(builder.import_geometry, out, "step")
    assert code == 0, (f"the import child exited {code} "
                       "(-11 is the SweptToElementary segfault)")
    assert (pay["faces"], pay["solid"]) == (2, True), (pay["faces"], pay["solid"])
    print(f"{PASS} a dome of two swept faces round-trips through STEP")


if __name__ == "__main__":
    print("_canonicalize validation gate")
    test_an_identical_shape_is_accepted()
    test_a_volume_change_is_rejected()
    test_a_face_count_change_is_rejected()
    test_a_solid_count_change_is_rejected()
    test_an_unmeasurable_result_is_rejected()
    test_the_gate_cannot_measure_a_compound_of_compounds()
    test_multi_root_canonicalises_each_root_separately()
    test_multi_root_skips_unwrappable_roots_without_losing_the_rest()
    test_import_still_produces_the_same_geometry()
    test_a_swept_face_next_to_ordinary_faces_imports()
    test_a_body_made_only_of_swept_faces_imports()
    print("all canonicalize tests passed")
