"""Every export writes what the user SEES: a hidden body stays out of the file.

The app sends the document as it BUILT it (rollback and suppression already
applied by the frontend) with its `bodyVisibility` map. The exporters used to
ignore that map, so File > Export, the print project, Open in OrcaSlicer and
TinkerAtlas Publish all wrote bodies the user had hidden. With every body hidden
there is nothing on screen, and an export refuses instead of writing it all.

Run: uv run python test_export_visible.py
"""

import json
import os
import shutil
import struct
import sys
import tempfile
import zipfile

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402

PASS = "  ok"

# three 20 mm cubes along X at 0, 40 and 80 (body1..body3), body2 hidden
FEATURES = []
for i in range(3):
    FEATURES.append({"id": f"b{i}", "type": "box", "length": 20, "width": 20, "height": 20})
    if i:
        FEATURES.append({"id": f"m{i}", "type": "move", "dx": i * 40})


def doc(visibility):
    return {"parameters": {}, "features": list(FEATURES), "bodyVisibility": visibility}


HIDE_MIDDLE = doc({"body2": False})


def stl_xs(path):
    """Distinct cube centres (rounded X) present in a binary STL."""
    with open(path, "rb") as fh:
        data = fh.read()
    (n,) = struct.unpack_from("<I", data, 80)
    xs = set()
    for i in range(n):
        v = struct.unpack_from("<12f", data, 84 + 50 * i)
        xs.add(round(sum(v[3::3][:3]) / 3 / 40) * 40)  # snap to a cube's slot
    return xs


def model_xml(path):
    with zipfile.ZipFile(path) as z:
        return z.read("3D/3dmodel.model").decode()


def test_mesh_formats_leave_the_hidden_body_out(tmp):
    res = server._export_job(HIDE_MIDDLE, "stl", os.path.join(tmp, "a.stl"))
    assert "error" not in res, res
    xs = stl_xs(res["path"])
    assert xs == {0, 80}, f"STL holds cubes at {sorted(xs)}, expected 0 and 80 only"

    res = server._export_job(HIDE_MIDDLE, "3mf", os.path.join(tmp, "a.3mf"))
    assert "error" not in res, res
    verts = model_xml(res["path"]).count("<vertex ")
    res_all = server._export_job(doc({}), "3mf", os.path.join(tmp, "all.3mf"))
    all_verts = model_xml(res_all["path"]).count("<vertex ")
    assert verts * 3 == all_verts * 2, (verts, all_verts)

    res = server._export_job(HIDE_MIDDLE, "glb", os.path.join(tmp, "a.glb"))
    assert "error" not in res, res
    with open(res["path"], "rb") as fh:
        blob = fh.read()
    (jlen,) = struct.unpack_from("<I", blob, 12)
    gltf = json.loads(blob[20:20 + jlen])
    assert len(gltf["meshes"]) == 2, len(gltf["meshes"])
    print(f"{PASS} STL, 3MF and GLB leave the hidden body out")


def test_step_leaves_the_hidden_body_out(tmp):
    from build123d import import_step

    res = server._export_job(HIDE_MIDDLE, "step", os.path.join(tmp, "a.step"))
    assert "error" not in res, res
    shape = import_step(res["path"])
    assert len(shape.solids()) == 2, len(shape.solids())
    assert abs(shape.volume - 2 * 8000) < 1e-3, shape.volume
    print(f"{PASS} STEP leaves the hidden body out")


def test_separate_files_skip_the_hidden_body(tmp):
    res = server._export_job(HIDE_MIDDLE, "stl", os.path.join(tmp, "parts.stl"), separate=True)
    assert "error" not in res, res
    assert len(res["paths"]) == 2, res["paths"]
    print(f"{PASS} each-body-separately writes only the visible bodies")


def test_an_explicit_body_export_still_writes_that_body(tmp):
    """Right-click a hidden body's Browser row > Export names the body outright;
    that is what the user asked for, so it is not filtered."""
    res = server._export_job(HIDE_MIDDLE, "stl", os.path.join(tmp, "one.stl"), body="body2")
    assert "error" not in res, res
    assert stl_xs(res["path"]) == {40}
    print(f"{PASS} an explicit export of a hidden body still writes it")


def test_the_print_project_leaves_the_hidden_body_out(tmp):
    res = server._export_project_job(HIDE_MIDDLE, os.path.join(tmp, "p.3mf"), [], {}, {}, {})
    assert "error" not in res, res
    xml = model_xml(res["path"])
    assert xml.count('type="model"') == 2, xml.count('type="model"')
    print(f"{PASS} the print project (Orca, Send to printer) leaves the hidden body out")


def test_everything_hidden_is_refused_not_written(tmp):
    hidden = doc({"body1": False, "body2": False, "body3": False})
    for fmt in ("stl", "3mf", "glb", "step"):
        p = os.path.join(tmp, f"none.{fmt}")
        res = server._export_job(hidden, fmt, p)
        assert "error" in res and "hidden" in res["error"]["message"], (fmt, res)
        assert not os.path.exists(p), fmt
    res = server._export_job(hidden, "stl", os.path.join(tmp, "none-parts.stl"), separate=True)
    assert "error" in res and "hidden" in res["error"]["message"], res
    res = server._export_project_job(hidden, os.path.join(tmp, "none.3mf"), [], {}, {}, {})
    assert "error" in res and "hidden" in res["error"]["message"], res
    print(f"{PASS} with every body hidden each export refuses instead of writing them")


def main():
    tmp = tempfile.mkdtemp()
    try:
        test_mesh_formats_leave_the_hidden_body_out(tmp)
        test_step_leaves_the_hidden_body_out(tmp)
        test_separate_files_skip_the_hidden_body(tmp)
        test_an_explicit_body_export_still_writes_that_body(tmp)
        test_the_print_project_leaves_the_hidden_body_out(tmp)
        test_everything_hidden_is_refused_not_written(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("all visible-export tests passed")


if __name__ == "__main__":
    main()
