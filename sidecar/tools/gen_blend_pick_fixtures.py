"""Generate src/features/blendPickFixtures.json: real display edges for the
fillet/chamfer pick tests (src/features/edgeFeatureInputEdges.test.ts).

Each case is a body, the edges a first click picks, and the LIVE PREVIEW that
click produces (the blend applied), all as the viewport receives them: the
sidecar's own edge_polylines_by_body, rounded to float32 like the wire. The
second click then lands on the preview, which is where field reports e470c0e2,
6c2fc3ba, 55a4cca2 and 77f004a6 went wrong: picks and the tangent chain read
edges the blend itself had generated.

The expected member sets are decided here from geometry, never by the code
under test.

    cd sidecar && .venv/bin/python tools/gen_blend_pick_fixtures.py
"""

import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from build123d import (  # noqa: E402
    Align, Box, RegularPolygon, chamfer, extrude, fillet, make_face,
    Line, RadiusArc,
)
from tessellate import edge_polylines_by_body  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "src", "features", "blendPickFixtures.json")


def f32(x):
    return float(np.float32(x))


def polys(shape):
    out = edge_polylines_by_body([{"id": "b1", "shape": shape}])
    return [{"id": e["id"], "body": "b1", "points": [[f32(c) for c in p] for p in e["points"]]} for e in out]


def mid(points):
    """Arc-length midpoint of a polyline (edgeMatch.polylineMid)."""
    segs = [math.dist(points[i], points[i + 1]) for i in range(len(points) - 1)]
    half = sum(segs) / 2
    acc = 0.0
    for i, s in enumerate(segs):
        if acc + s >= half:
            t = (half - acc) / s if s else 0
            return [points[i][k] + t * (points[i + 1][k] - points[i][k]) for k in range(3)]
        acc += s
    return list(points[-1])


def index_of(edges, pred):
    hits = [i for i, e in enumerate(edges) if pred(e["points"])]
    assert len(hits) == 1, hits
    return hits[0]


def nearest_edge(shape, p):
    return min(shape.edges(), key=lambda e: (e.center() - tuple(p)).length)


def on_top(z):
    return lambda pts: all(abs(p[2] - z) < 1e-3 for p in pts)


def case(name, body, first, preview, second_point, expected_first, expected_second, note, close_up=False):
    inp = polys(body)
    return {
        "closeUp": close_up,
        "name": name,
        "note": note,
        "input": inp,
        "preview": polys(preview),
        "first": mid(inp[first]["points"]),
        "second": second_point,
        "expectedFirst": sorted(expected_first),
        "expectedSecond": sorted(expected_second),
    }


cases = []

# --- a rectangular frame: e470c0e2 / 6c2fc3ba (the reporter's body is this
# frame, 96 x 68 with 4 mm walls, plus a corner insert that is not needed) ---
H = 27.2
frame = Box(96, 68, H, align=(Align.CENTER, Align.CENTER, Align.MIN)) - Box(
    88, 60, 2 * H, align=(Align.CENTER, Align.CENTER, Align.MIN))
fe = polys(frame)
inner_front = index_of(fe, lambda p: on_top(H)(p) and all(abs(q[1] + 30) < 1e-3 for q in p))
inner_left = index_of(fe, lambda p: on_top(H)(p) and all(abs(q[0] + 44) < 1e-3 for q in p))
chamfered = chamfer(nearest_edge(frame, mid(fe[inner_front]["points"])), length=1)
cases.append(case(
    "frame: chamfer an inside edge, then click its neighbour (e470c0e2)",
    frame, inner_front, chamfered, mid(fe[inner_left]["points"]),
    [inner_front], [inner_front, inner_left],
    "The chamfer's 1 mm end edge lies on the neighbour's line and shares its "
    "end, so a chain walked on the preview pulls it in; its midpoint binds the "
    "concave vertical corner edge below it.",
))

# 6c2fc3ba: click a SHORT edge the chamfer generated. Whatever that click
# lands on must be an input edge; the generated one does not exist there.
pv = polys(chamfered)
inputs = {tuple(map(tuple, e["points"])) for e in fe}
generated = [e for e in pv if tuple(map(tuple, e["points"])) not in inputs]
short = min(generated, key=lambda e: sum(math.dist(e["points"][i], e["points"][i + 1])
                                       for i in range(len(e["points"]) - 1)))
cases.append(case(
    "frame: click an edge the chamfer generated (6c2fc3ba)",
    frame, inner_front, chamfered, mid(short["points"]),
    [inner_front], [],
    "expectedSecond is empty: the test asserts only that every member is an "
    "input edge, since which input edge is nearest that pixel is the picker's call. "
    "Viewed close up, so the click is clear of the chamfered edge's own ghost line.",
    close_up=True,
))

# --- a hexagonal prism: 77f004a6 ---
HH = 30
hexa = extrude(RegularPolygon(20, 6), HH)
he = polys(hexa)
top = [i for i, e in enumerate(he) if on_top(HH)(e["points"])]
assert len(top) == 6, top
rim_a = top[0]
a0, a1 = he[rim_a]["points"][0], he[rim_a]["points"][-1]
rim_b = next(i for i in top if i != rim_a and any(
    math.dist(p, q) < 1e-3 for p in (he[i]["points"][0], he[i]["points"][-1]) for q in (a0, a1)))
filleted = fillet(nearest_edge(hexa, mid(he[rim_a]["points"])), radius=2)
cases.append(case(
    "hexagon: fillet one rim edge, then click the next (77f004a6)",
    hexa, rim_a, filleted, mid(he[rim_b]["points"]),
    [rim_a], [rim_a, rim_b],
    "A bare hexagon has no tangent neighbours, so each click is exactly one edge.",
))

# the same prism with its vertical edges already rounded (a committed blend):
# the top and bottom loops are now G1 loops of 12 edges each
rounded = fillet(hexa.edges().filter_by(lambda e: abs(e.tangent_at(0.5).Z) > 0.99), radius=4)
re_ = polys(rounded)
rtop = [i for i, e in enumerate(re_) if on_top(HH)(e["points"])]
rbot = [i for i, e in enumerate(re_) if on_top(0)(e["points"])]
assert len(rtop) == 12 and len(rbot) == 12, (len(rtop), len(rbot))
rtop_line = next(i for i in rtop if len(re_[i]["points"]) == 2)
rbot_line = next(i for i in rbot if len(re_[i]["points"]) == 2)
top_filleted = fillet([nearest_edge(rounded, mid(re_[i]["points"])) for i in rtop], radius=1.5)
cases.append(case(
    "rounded hexagon: fillet the top loop, then click the bottom loop (77f004a6)",
    rounded, rtop_line, top_filleted, mid(re_[rbot_line]["points"]),
    rtop, rtop + rbot,
    "Each click chains its whole G1 loop and nothing else.",
))

# --- a teardrop: two lines tangent to an R15 arc meeting at a 41 degree tip,
# extruded 66.81 (55a4cca2's body) ---
R, TIP, TH = 15.0, math.radians(41), 66.81
d = R / math.sin(TIP / 2)  # tip distance from the arc centre
tip = (-d, 0)
tx = R * math.sin(TIP / 2)  # tangent points
ty = R * math.cos(TIP / 2)
t1, t2 = (-tx, ty), (-tx, -ty)
outline = Line(tip, t1) + RadiusArc(t1, t2, -R) + Line(t2, tip)
tear = extrude(make_face(outline), TH)
te = polys(tear)
ttop = [i for i, e in enumerate(te) if on_top(TH)(e["points"])]
assert len(ttop) == 3, ttop
tip_edge = index_of(te, lambda p: all(abs(q[0] + d) < 1e-3 and abs(q[1]) < 1e-3 for q in p))
tarc = next(i for i in ttop if len(te[i]["points"]) > 2)
loop_filleted = fillet([nearest_edge(tear, mid(te[i]["points"])) for i in ttop], radius=2)
cases.append(case(
    "teardrop: fillet the top loop, then add the tip edge (55a4cca2)",
    tear, tarc, loop_filleted, mid(te[tip_edge]["points"]),
    ttop, ttop + [tip_edge],
    "The preview's mitre edge sits on the mirror plane, exactly between two "
    "loop edges: walked into, it fails the build as an ambiguous reference.",
))

with open(OUT, "w") as fh:
    json.dump({"generatedBy": "sidecar/tools/gen_blend_pick_fixtures.py", "cases": cases}, fh,
              separators=(",", ":"))
    fh.write("\n")
for c in cases:
    print(c["name"], len(c["input"]), "->", len(c["preview"]))
