"""A textured export imports back as the bodies it was: valid solids, no slivers.

Field finding (explore-file-lifecycle-8): a four-body model with a hex texture,
exported as STL and imported again, listed TEN bodies, six of them one face of
no area, and two of the four real ones were invalid OPEN shells. The texture
makes the mesh detailed enough (over MAX_IMPORT_FACET_DIRECTIONS) to take
`_replane_mesh_file`, which sews its planar regions at 0.18 mm; a texture region
narrower than that collapses, the sew opens the surface, and the debris came
back as loose shells. The plain import gives four valid solids, so a closed mesh
that replane would open now takes the plain path (correct over fast).

The field mesh is 123,510 triangles; the same thing happens on this 19,210
triangle one once the facet-direction gate is lowered to send it down the same
path, which keeps the test to seconds. The field document itself is user data
and is not in the repo: set SINDRI_TEXTURED_FIELD_DOC to its JSON to run
test_the_field_document (minutes).

Run: uv run python test_reimport_textured.py
"""

import json
import os
import shutil
import sys
import tempfile
import time

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402
import server  # noqa: E402

PASS = "  ok"


def box(i, x):
    return [
        {"id": f"s{i}", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": x, "y": 0}]},
        {"id": f"e{i}", "type": "extrude", "sketch": f"s{i}", "distance": 10, "operation": "new"},
    ]


FEATURES = box(1, 0) + box(2, 40) + box(3, 80) + box(4, 120) + [
    {"id": "tex", "type": "texture", "kind": "hex", "faces": {"by": "all", "body": "body4"},
     "depth": 0.4, "scale": 2.0}]


def round_trip(doc, tmp):
    """Export `doc` as STL, import it, rebuild the import: (payload, bodies)."""
    stl = os.path.join(tmp, "textured.stl")
    res = server._export_job(doc, "stl", stl)
    assert "error" not in res, res
    payload = builder.import_geometry(stl, "stl")
    feature = {"id": "im", "type": "import", "name": "Textured"}
    feature.update({k: v for k, v in payload.items() if k != "name"})
    _p, errors, bodies = builder.rebuild({"parameters": {}, "features": [feature]})
    assert errors == [], errors
    return payload, bodies


def assert_valid_solids(bodies, count):
    faces = [len(b["shape"].faces()) for b in bodies]
    assert len(bodies) == count, f"{len(bodies)} bodies with {faces} faces"
    for b in bodies:
        s = b["shape"]
        assert s.solids() and s.is_valid, (b["id"], type(s.wrapped).__name__, len(s.faces()))
        assert s.volume > 1, (b["id"], s.volume)


class gate:
    """Temporarily set builder constants (the facet-direction gate, the cap)."""

    def __init__(self, **values):
        self.values, self.saved = values, {}

    def __enter__(self):
        for k, v in self.values.items():
            self.saved[k] = getattr(builder, k)
            setattr(builder, k, v)

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            setattr(builder, k, v)


def test_a_textured_stl_comes_back_as_four_valid_solids():
    tmp = tempfile.mkdtemp()
    try:
        # the replane path, as the 25,490-direction field file takes it
        with gate(MAX_IMPORT_FACET_DIRECTIONS=10):  # this mesh has 60
            _payload, bodies = round_trip({"parameters": {}, "features": FEATURES}, tmp)
        assert_valid_solids(bodies, 4)
        assert sorted(len(b["shape"].faces()) for b in bodies)[:3] == [6, 6, 6]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} a textured four-body STL imports back as four valid solids, no slivers")


def test_a_slow_replane_is_cut_off_and_the_import_still_lands():
    """Replane past REPLANE_TIME_CAP declines and the plain path imports the
    file. The slowness is injected: every region rebuild takes 50 ms, about
    3 minutes for this mesh's 3,778 regions, against a 1 s cap."""
    real = builder._planar_face_from_region

    def slow(*a, **k):
        time.sleep(0.05)
        return real(*a, **k)

    tmp = tempfile.mkdtemp()
    builder._planar_face_from_region = slow
    try:
        t0 = time.monotonic()
        with gate(MAX_IMPORT_FACET_DIRECTIONS=10, REPLANE_TIME_CAP=1.0):
            _payload, bodies = round_trip({"parameters": {}, "features": FEATURES}, tmp)
        took = time.monotonic() - t0
        assert took < 60, f"the cap did not cut replane off: {took:.0f} s"
        assert_valid_solids(bodies, 4)
    finally:
        builder._planar_face_from_region = real
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} a replane past its time cap falls back, the import lands in {took:.0f} s")


def test_the_field_document():
    """The finding's own four-body textured document, end to end."""
    path = os.environ.get("SINDRI_TEXTURED_FIELD_DOC")
    if not path:
        print("  SKIP: SINDRI_TEXTURED_FIELD_DOC is not set")
        return
    with open(path) as fh:
        d = json.load(fh)
    doc = {"parameters": d.get("parameters", {}), "features": d["features"]}
    tmp = tempfile.mkdtemp()
    try:
        t0 = time.monotonic()
        _payload, bodies = round_trip(doc, tmp)
        assert_valid_solids(bodies, 4)
        # the three plain bodies are still fitted (26, 15 and 3 faces in the
        # original), not left as the plain path's 230, 1,495 and 52 facets
        small = sorted(len(b["shape"].faces()) for b in bodies)[:3]
        assert small[0] < 10 and small[1] < 50 and small[2] < 600, small
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} the field document comes back as four valid solids ({time.monotonic() - t0:.0f} s)")


def main():
    test_a_textured_stl_comes_back_as_four_valid_solids()
    test_a_slow_replane_is_cut_off_and_the_import_still_lands()
    test_the_field_document()
    print("all textured re-import tests passed")


if __name__ == "__main__":
    main()
