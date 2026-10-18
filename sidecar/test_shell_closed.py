"""Shell with no opening face makes a CLOSED HOLLOW part.

The document format and the shell handler both promise that a faceless shell is
"a fully closed hollow", but the kernel's offset with no opening returns the
inward-offset CORE: a smaller copy of the body (a 40x40x20 box came back as a
38x38x18 box). The hollow is the body minus that core: the outer skin kept, one
solid holding TWO shells, the inner one bounding a sealed cavity.

Volume alone is a false oracle here (a shrunken solid also "loses volume"), so
each case checks the shells, the solids, the faces and the outer extent too, and
the export checks that the cavity reaches a slicer as an inward-facing shell.

Run: uv run python test_shell_closed.py
"""

import os
import shutil
import struct
import sys
import tempfile
from collections import defaultdict

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402
import server  # noqa: E402

PASS = "  ok"

BOX = {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 20}  # +-20, +-20, +-10


def closed_shell(thickness):
    return {"id": "sh1", "type": "shell", "thickness": thickness}


def build(*features, parameters=None):
    _p, errors, bodies = builder.rebuild({"parameters": parameters or {}, "features": list(features)})
    return errors, bodies


def assert_hollow(shape, volume, faces, solids=1, extent=(20, 20, 10)):
    assert shape.is_valid
    assert abs(shape.volume - volume) < 1e-2, (shape.volume, volume)
    assert len(shape.solids()) == solids, len(shape.solids())
    # count shells MINUS solids: one inner shell (one cavity) per solid
    assert len(shape.shells()) - len(shape.solids()) == solids, (
        len(shape.shells()), len(shape.solids()))
    assert all(len(s.shells()) == 2 for s in shape.solids()), [len(s.shells()) for s in shape.solids()]
    assert len(shape.faces()) == faces, len(shape.faces())
    bb = shape.bounding_box()
    got = (bb.max.X, bb.max.Y, bb.max.Z)
    assert all(abs(g - e) < 1e-3 for g, e in zip(got, extent)), f"outer skin moved: {got}"


def test_a_closed_box_shell_is_a_hollow():
    errors, bodies = build(BOX, closed_shell(1))
    assert errors == [], errors
    # 40*40*20 - 38*38*18
    assert_hollow(bodies[0]["shape"], 32000 - 25992, faces=12)
    print(f"{PASS} a closed shell of a box is a hollow: 6008 mm3, 2 shells in 1 solid, 12 faces")


def test_a_curved_body_shells_closed_too():
    errors, bodies = build({"id": "s", "type": "sphere", "radius": 10}, closed_shell(1))
    assert errors == [], errors
    import math

    want = 4 / 3 * math.pi * (10 ** 3 - 9 ** 3)
    assert_hollow(bodies[0]["shape"], want, faces=2, extent=(10, 10, 10))
    print(f"{PASS} a sphere shells into a hollow ball ({want:.2f} mm3)")


def test_each_solid_of_a_pattern_gets_its_own_cavity():
    errors, bodies = build(
        BOX, {"id": "pr", "type": "patternRect", "countX": 3, "countY": 1,
              "spacingX": 60, "spacingY": 60},
        closed_shell(1))
    assert errors == [], errors
    assert_hollow(bodies[0]["shape"], 3 * 6008, faces=36, solids=3, extent=(140, 20, 10))
    print(f"{PASS} a 3-solid pattern body gets one cavity per solid")


def test_a_parameter_bound_wall():
    errors, bodies = build(BOX, closed_shell("wall"), parameters={"wall": 2})
    assert errors == [], errors
    assert_hollow(bodies[0]["shape"], 32000 - 36 * 36 * 16, faces=12)
    print(f"{PASS} a wall bound to a parameter shells closed at that thickness")


def test_walls_that_meet_are_refused():
    """A 20 mm tall box with 10 mm walls has no cavity left: refuse and say so,
    never hand back the body as if it were shelled."""
    errors, bodies = build(BOX, closed_shell(10))
    assert len(errors) == 1 and "thicker than the body's narrowest span" in errors[0]["message"], errors
    assert abs(bodies[0]["shape"].volume - 32000) < 1e-6
    print(f"{PASS} walls that meet in the middle are refused, the body left as it was")


def stl_components(path):
    """Connected components of a binary STL's triangles (by shared vertex), each
    with its signed volume, plus the number of edges NOT shared by exactly two
    triangles (0 = watertight)."""
    with open(path, "rb") as fh:
        data = fh.read()
    (n,) = struct.unpack_from("<I", data, 80)
    tris = []
    for i in range(n):
        v = struct.unpack_from("<12f", data, 84 + 50 * i)
        tris.append(tuple(tuple(round(c, 4) for c in v[3 + 3 * k:6 + 3 * k]) for k in range(3)))
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    edges = defaultdict(int)
    for a, b, c in tris:
        parent[find(a)] = find(b)
        parent[find(b)] = find(c)
        for p, q in ((a, b), (b, c), (c, a)):
            edges[frozenset((p, q))] += 1
    vols = defaultdict(float)
    for a, b, c in tris:
        vols[find(a)] += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                          + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    return sorted(vols.values()), sum(1 for k in edges.values() if k != 2)


def test_a_mesh_export_carries_the_cavity():
    """A slicer reads an inward-facing inner shell as a void: the STL must be
    watertight, with the outer skin positive and the cavity negative."""
    doc = {"parameters": {}, "features": [BOX, closed_shell(1)]}
    tmp = tempfile.mkdtemp()
    try:
        for fmt in ("stl", "3mf"):
            res = server._export_job(doc, fmt, os.path.join(tmp, f"hollow.{fmt}"))
            assert "error" not in res and not res.get("warnings"), res
        vols, open_edges = stl_components(os.path.join(tmp, "hollow.stl"))
        assert open_edges == 0, f"{open_edges} edges not shared by exactly two triangles"
        assert len(vols) == 2, vols
        assert abs(vols[0] + 25992) < 1e-2 and abs(vols[1] - 32000) < 1e-2, vols
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} STL/3MF export is watertight; the cavity is an inward shell of -25992 mm3")


def main():
    test_a_closed_box_shell_is_a_hollow()
    test_a_curved_body_shells_closed_too()
    test_each_solid_of_a_pattern_gets_its_own_cavity()
    test_a_parameter_bound_wall()
    test_walls_that_meet_are_refused()
    test_a_mesh_export_carries_the_cavity()
    print("all closed-shell tests passed")


if __name__ == "__main__":
    main()
