"""A textured export imports back as the bodies it was, with no phantom slivers.

Field finding (explore-file-lifecycle-8): a four-body model with a hex texture,
exported as STL and imported again, listed TEN bodies, six of them one face of
no area. The texture makes the mesh detailed enough (over
MAX_IMPORT_FACET_DIRECTIONS) to take `_replane_mesh_file`, which sews its
planar regions at 0.18 mm; a texture region narrower than that collapses onto a
line, and the sew handed each one back as a loose shell, a body of its own.

The field mesh is 123,510 triangles; the same thing happens on this 19,210
triangle one once the facet-direction gate is lowered to send it down the same
path, which keeps the test to seconds.

Run: uv run python test_reimport_textured.py
"""

import os
import shutil
import sys
import tempfile

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


def test_a_textured_stl_comes_back_as_four_bodies():
    tmp = tempfile.mkdtemp()
    saved = builder.MAX_IMPORT_FACET_DIRECTIONS
    try:
        doc = {"parameters": {}, "features": FEATURES}
        _p, errors, bodies = builder.rebuild(doc)
        assert errors == [] and len(bodies) == 4, errors
        stl = os.path.join(tmp, "textured.stl")
        res = server._export_job(doc, "stl", stl)
        assert "error" not in res, res

        # the replane path, as the 25,490-direction field file takes it
        builder.MAX_IMPORT_FACET_DIRECTIONS = 10  # this mesh has 60
        payload = builder.import_geometry(stl, "stl")
        assert payload.get("reference", {}).get("bodyCount") == 4, payload.get("reference")

        feature = {"id": "im", "type": "import", "name": "Textured"}
        feature.update({k: v for k, v in payload.items() if k != "name"})
        _p, errors, bodies = builder.rebuild({"parameters": {}, "features": [feature]})
        assert errors == [], errors
        faces = [len(b["shape"].faces()) for b in bodies]
        assert len(bodies) == 4, f"{len(bodies)} bodies with {faces} faces"
        assert sorted(faces)[:3] == [6, 6, 6], faces
        assert all(b["shape"].area > 1 for b in bodies), [b["shape"].area for b in bodies]
    finally:
        builder.MAX_IMPORT_FACET_DIRECTIONS = saved
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} a textured four-body STL imports back as four bodies, no slivers")


def main():
    test_a_textured_stl_comes_back_as_four_bodies()
    print("all textured re-import tests passed")


if __name__ == "__main__":
    main()
