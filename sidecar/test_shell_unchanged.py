"""Shell must never be a silent no-op.

With the Intersection join, OCCT's thick-solid hands the INPUT back, with no
error, when the opening face runs smoothly (tangentially) into a neighbour: a
filleted rim, a rounded sketch corner, a slot's flat side. The feature stayed
green while the body did not change. The project's rule for booleans holds here
too: a feature that changes nothing says so.

Run: uv run python test_shell_unchanged.py
"""

import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

import builder  # noqa: E402

PASS = "  ok"

BOX = {"id": "b1", "type": "box", "length": 40, "width": 40, "height": 20}  # z -10..10
TOP_RIM = [{"kind": "edge", "by": "nearest", "point": p, "body": "body1"}
           for p in ([0, 20, 10], [0, -20, 10], [20, 0, 10], [-20, 0, 10])]
TOP = {"kind": "face", "by": "normal", "dir": [0, 0, 1], "body": "body1"}


def shell(faces, thickness=1):
    return {"id": "sh1", "type": "shell", "thickness": thickness, "faces": faces}


def build(*features):
    _p, errors, bodies = builder.rebuild({"parameters": {}, "features": list(features)})
    return errors, bodies


def body1(bodies):
    return next(b["shape"] for b in bodies if b["id"] == "body1")


def assert_refused_unchanged(errors, bodies, volume, faces):
    assert len(errors) == 1 and errors[0]["feature_id"] == "sh1", errors
    assert "unchanged" in errors[0]["message"], errors[0]["message"]
    shape = body1(bodies)
    # a failed feature is a no-op: the body is what it was before the shell
    assert abs(shape.volume - volume) < 1e-3, shape.volume
    assert len(shape.faces()) == faces, len(shape.faces())


def test_a_filleted_rim_is_refused_not_ignored():
    errors, bodies = build(BOX, {"id": "fl", "type": "fillet", "radius": 2, "edges": TOP_RIM},
                           shell(TOP))
    assert_refused_unchanged(errors, bodies, 31865.7227, 10)
    print(f"{PASS} shelling through a filleted rim says it did nothing")


def test_a_slot_side_with_no_fillet_is_refused_too():
    """The trigger is tangency, not a fillet feature: a slot's flat side runs
    smoothly into its round ends."""
    errors, bodies = build(
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [
            {"id": "sl", "type": "slot", "x1": -15, "y1": 0, "x2": 15, "y2": 0, "width": 10}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
        shell({"kind": "face", "by": "normal", "dir": [0, 1, 0], "body": "body1"}))
    assert_refused_unchanged(errors, bodies, 7570.7963, 6)
    print(f"{PASS} shelling through a slot's flat side says it did nothing")


def test_the_preview_path_refuses_it_too():
    """The app builds through rebuild_cached (prefix, then full, twice)."""
    doc = {"parameters": {}, "features": [
        BOX, {"id": "fl", "type": "fillet", "radius": 2, "edges": TOP_RIM}]}
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    builder.rebuild_cached(doc)
    doc = {"parameters": {}, "features": doc["features"] + [shell(TOP)]}
    for _ in range(2):
        _p, errors, _b = builder.rebuild_cached(doc)[:3]
        assert len(errors) == 1 and "unchanged" in errors[0]["message"], errors
    print(f"{PASS} the cached rebuild refuses it on every pass")


# --- controls: shells that work today must stay green, with the same numbers

def test_a_chamfered_rim_still_shells():
    errors, bodies = build(BOX, {"id": "ch", "type": "chamfer", "distance": 2, "edges": TOP_RIM},
                           shell(TOP))
    assert errors == [], errors
    shape = body1(bodies)
    assert abs(shape.volume - 4678.8657) < 1e-3 and len(shape.faces()) == 19, (
        shape.volume, len(shape.faces()))
    assert shape.is_valid
    print(f"{PASS} a chamfered rim still shells (4678.8657 mm3, 19 faces)")


def test_a_plain_and_a_closed_shell_still_work():
    errors, bodies = build(BOX, shell(TOP))
    assert errors == [] and abs(body1(bodies).volume - 4564.0) < 1e-3, errors
    errors, bodies = build(BOX, {"id": "sh1", "type": "shell", "thickness": 2})
    assert errors == [] and abs(body1(bodies).volume - 20736.0) < 1e-3, errors
    print(f"{PASS} open and closed box shells keep their volumes")


def test_a_multi_solid_body_still_shells():
    """One body can hold several solids (a pattern); the guard must compare
    against the input's own solid count, never against 1."""
    errors, bodies = build(
        BOX, {"id": "pr", "type": "patternRect", "countX": 3, "countY": 1,
              "spacingX": 60, "spacingY": 60},
        shell({"kind": "face", "by": "nearest", "point": [0, 0, 10], "body": "body1"}))
    assert errors == [], errors
    shape = body1(bodies)
    assert len(shape.solids()) == 3 and abs(shape.volume - 56548.0) < 1e-3, (
        len(shape.solids()), shape.volume)
    print(f"{PASS} a 3-solid pattern body still shells")


def main():
    test_a_filleted_rim_is_refused_not_ignored()
    test_a_slot_side_with_no_fillet_is_refused_too()
    test_the_preview_path_refuses_it_too()
    test_a_chamfered_rim_still_shells()
    test_a_plain_and_a_closed_shell_still_work()
    test_a_multi_solid_body_still_shells()
    print("all shell tests passed")


if __name__ == "__main__":
    main()
