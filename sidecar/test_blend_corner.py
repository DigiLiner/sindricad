"""A fillet that runs into a corner an EARLIER fillet already rounded says so.

Run: uv run python test_blend_corner.py

Field lead 55a4cca2: on a pointed prism, filleting the top loop (two lines and
the arc between them) and THEN, as a second feature, the vertical edge at the
tip fails in OCCT, and the app used to forward the kernel's "try a smaller
value or use max_fillet()". Measured on that body: the tip edge only builds
below about a tenth of the loop's radius (2 -> 0.2 builds, 0.4 does not), and
max_fillet() is not something a user can call. The useful answer is which
fillet is in the way and the two orders that DO build at the same size: both
edges in one fillet, or the tip edge first.

Everything enters through `rebuild`, the server's entry point, on a synthetic
teardrop prism (no reporter data). The guards at the bottom pin that nothing
which builds today changes, and that a failure with no earlier blend in its
corner keeps the kernel's own message.
"""

import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

import errors  # noqa: E402
from builder import rebuild  # noqa: E402

PASS = "  ok"

# A teardrop: an R15 arc closed by two tangent lines meeting at a 41 degree tip
# at the origin, extruded 60 up. The tip's vertical edge lies on x = 0.
R, HALF, H = 15.0, math.radians(20.5), 60.0
D = R / math.sin(HALF)  # tip -> arc centre (0, -D)
L = math.sqrt(D * D - R * R)  # tip -> tangent point
TA = (-L * math.sin(HALF), -L * math.cos(HALF))
TB = (L * math.sin(HALF), -L * math.cos(HALF))

TEARDROP = [
    {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"type": "line", "id": "la", "x1": 0, "y1": 0, "x2": TA[0], "y2": TA[1]},
        {"type": "line", "id": "lb", "x1": 0, "y1": 0, "x2": TB[0], "y2": TB[1]},
        {"type": "arc", "id": "ar", "x1": TA[0], "y1": TA[1], "mx": 0, "my": -D - R,
         "x2": TB[0], "y2": TB[1]},
    ]},
    {"id": "e", "type": "extrude", "sketch": "s", "regions": [[0, -D, 0]],
     "distance": H, "operation": "new"},
]


def _edge(p):
    return {"kind": "edge", "by": "nearest", "point": list(p)}


TOP_LOOP = [_edge((0, -D - R, H)), _edge((TA[0] / 2, TA[1] / 2, H)), _edge((TB[0] / 2, TB[1] / 2, H))]
TIP = _edge((0, 0, H / 2))
# The edge where the loop's two line fillets meet over the tip (an ellipse),
# measured on the r=2 loop; the tool used to chain it in with the tip.
MITRE = _edge((0, -2.5296564856322217, 59.66096084680251))


def _fillet(fid, r, edges):
    return {"id": fid, "type": "fillet", "radius": r, "edges": edges}


def _build(*features, base=TEARDROP):
    diags = []
    _part, errs, bodies = rebuild({"parameters": {}, "features": [*base, *features]}, diagnostics=diags)
    return errs, bodies, diags


def _assert_names_the_earlier_fillet(errs, diags, failing="f5", earlier="f4"):
    assert len(errs) == 1, errs
    e = errs[0]
    assert e["feature_id"] == failing, e
    assert e.get("code") == errors.BLEND_CORNER_TAKEN, e
    assert e.get("feature_ref") == earlier, e
    msg = e["message"]
    assert "try a smaller" not in msg and "max_fillet" not in msg, msg
    assert "add this edge to it" in msg and "before it in the timeline" in msg, msg
    # The edges still paint red in the viewport.
    assert any(d.get("kind") == "edgeOpFailed" and d.get("feature_id") == failing for d in diags), diags


def test_tip_after_the_loop_names_the_loop_fillet():
    for r in (2, 0.5):
        errs, _b, diags = _build(_fillet("f4", r, TOP_LOOP), _fillet("f5", r, [TIP]))
        _assert_names_the_earlier_fillet(errs, diags)
    print(PASS, "the tip edge after the top loop names the loop's fillet, not 'try a smaller value'")


def test_tip_with_the_mitre_names_the_loop_fillet():
    errs, _b, diags = _build(_fillet("f4", 2, TOP_LOOP), _fillet("f5", 2, [TIP, MITRE]))
    _assert_names_the_earlier_fillet(errs, diags)
    print(PASS, "the tip edge plus the mitre edge names the loop's fillet too")


def test_a_chamfer_on_the_tip_names_the_loop_fillet():
    errs, _b, diags = _build(_fillet("f4", 2, TOP_LOOP),
                             {"id": "f5", "type": "chamfer", "distance": 2, "edges": [TIP]})
    _assert_names_the_earlier_fillet(errs, diags)
    assert errs[0]["message"].startswith("Chamfer failed"), errs[0]
    print(PASS, "a chamfer on the tip after the loop fillet names it the same way")


def test_the_wire_reply_carries_it_when_the_loop_was_built_before():
    """The way the user actually gets here: the loop fillet is already built
    and cached, and the tip fillet is a NEW feature (its preview, then its
    commit), so the build resumes after the loop from the worker's snapshot.
    The code and the reference must survive that resume and the reply."""
    import server

    loop_doc = {"parameters": {}, "features": [*TEARDROP, _fillet("f4", 2, TOP_LOOP)]}
    assert "featureErrors" not in server._rebuild_job(loop_doc, 0.1)
    res = server._rebuild_job({**loop_doc, "features": [*loop_doc["features"], _fillet("f5", 2, [TIP])]}, 0.1)
    errs = res.get("featureErrors") or []
    assert len(errs) == 1 and errs[0].get("code") == errors.BLEND_CORNER_TAKEN, errs
    assert errs[0].get("feature_ref") == "f4" and errs[0].get("feature_id") == "f5", errs
    assert res["featureError"] == errs[0], res["featureError"]
    print(PASS, "the reply names the loop fillet when the build resumes after it")


def test_the_two_orders_it_suggests_both_build():
    # The advice in the message, taken literally, at the size that failed.
    for feats in ([_fillet("f4", 2, [*TOP_LOOP, TIP])],
                  [_fillet("f4", 2, [TIP]), _fillet("f5", 2, TOP_LOOP)]):
        errs, bodies, _d = _build(*feats)
        assert errs == [], errs
        sh = bodies[0]["shape"]
        assert sh.is_valid and len(sh.faces()) == 10, (sh.is_valid, len(sh.faces()))
    print(PASS, "both suggested orders build at the same size (10 faces, valid)")


def test_a_failure_with_no_earlier_blend_in_its_corner_keeps_the_kernel_message():
    # 40 x 30 x 20 box, centred. A fillet wider than a face beside its edge is too
    # big, and "try a smaller value" is the truth: 5 mm builds.
    box = [{"id": "b", "type": "box", "length": 40, "width": 30, "height": 20}]
    near = _edge((0, -15, -10))  # bottom front edge
    far = _edge((0, 15, 10))  # top back edge, no shared corner with `near`
    vert = _edge((20, -15, 0))  # vertical edge at the front right corner
    cases = [
        [_fillet("f5", 35, [vert])],
        # an earlier fillet elsewhere on the body is not in this edge's corner
        [_fillet("f4", 1, [far]), _fillet("f5", 25, [near])],
        # one that ends at this edge's corner with ONE face has not closed it
        [_fillet("f4", 1, [_edge((0, -15, 10))]), _fillet("f5", 35, [vert])],
    ]
    for feats in cases:
        errs, _b, _d = _build(*feats, base=box)
        assert len(errs) == 1 and errs[0]["feature_id"] == "f5", errs
        assert "code" not in errs[0] and "feature_ref" not in errs[0], errs[0]
        assert "try a smaller value" in errs[0]["message"], errs[0]
        smaller = [*feats[:-1], _fillet("f5", 5, feats[-1]["edges"])]
        assert _build(*smaller, base=box)[0] == [], "the smaller size the message promises must build"
    print(PASS, "a fillet that is simply too big still says 'try a smaller value', and a smaller one builds")


def main():
    print("Blend into an earlier blend's corner")
    test_tip_after_the_loop_names_the_loop_fillet()
    test_tip_with_the_mitre_names_the_loop_fillet()
    test_a_chamfer_on_the_tip_names_the_loop_fillet()
    test_the_wire_reply_carries_it_when_the_loop_was_built_before()
    test_the_two_orders_it_suggests_both_build()
    test_a_failure_with_no_earlier_blend_in_its_corner_keeps_the_kernel_message()
    print("ALL PASS")


if __name__ == "__main__":
    main()
