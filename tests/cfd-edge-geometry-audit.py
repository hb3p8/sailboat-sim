#!/usr/bin/env python3
"""Read-only audit of the saved gennaker O-grid's actual leading edge.

The CFD solid's thickness is a meshing device, not a measured luff seam.
Run: .venv/bin/python tests/cfd-edge-geometry-audit.py
"""

import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
CASE = ROOT / "cfd/cases/sail-2d/gen-pol-c18-a08-extended.json"
GEOMETRY = ROOT / "out/cfd/geometry/sail/geometry.json"


def audit():
    case = json.loads(CASE.read_text())
    geometry = json.loads(GEOMETRY.read_text())
    body = geometry["bodies"][case["geometry"]["bodies"][0]]
    grid = ROOT / "cfd/grids" / case["mesh"]["grid"]
    vals = np.fromstring(grid.read_text(), sep=" ")
    assert vals[0] == 1
    ni, nj, nk = map(int, vals[1:4])
    assert ni == 2 and vals.size == 4 + 3 * ni * nj * nk
    xyz = vals[4:].reshape(3, nk, nj, ni)
    wall = xyz[:2, 0, :, 0].T
    next_ring = xyz[:2, 1, :, 0].T
    # The repeated last station closes Plot3D's periodic wall.
    wall = wall[:-1]
    next_ring = next_ring[:-1]
    nose = int(np.argmin(np.linalg.norm(
        wall - np.array([body["chord_m"], 0.0]), axis=1)))
    prev = wall[(nose - 1) % len(wall)]
    apex = wall[nose]
    following = wall[(nose + 1) % len(wall)]
    def radius_of(a, b, c):
        ab = b - a
        ac = c - a
        cross = abs(ab[0] * ac[1] - ab[1] * ac[0])
        return np.linalg.norm(ab) * np.linalg.norm(c - b) * np.linalg.norm(ac) / (2 * cross)

    radius = radius_of(prev, apex, following)
    a = np.linalg.norm(apex - prev)
    b = np.linalg.norm(following - apex)
    incoming = (apex - prev) / a
    outgoing = (following - apex) / b
    turn_deg = float(np.degrees(np.arccos(np.clip(incoming @ outgoing, -1, 1))))
    # The stored first wall ring is polygonal. If the nose is really smooth,
    # shrinking the sampling distance along its two adjacent edges should
    # approach a finite radius; a corner instead gives radius proportional h.
    probe_radii = []
    for h in (.006, .003, .0015):
        left = apex - h * incoming
        right = apex + h * outgoing
        probe_radii.append(radius_of(left, apex, right))
    first_layer = np.linalg.norm(next_ring - wall, axis=1)
    nominal_radius = body["chord_m"] * body["thickness_rel"] / 2
    assert case["solver"]["wall_treatment"] == "wall-function"
    assert abs(apex[0] - body["chord_m"]) < .01
    assert turn_deg > 20
    assert abs(probe_radii[1] / probe_radii[0] - .5) < 1e-10
    assert abs(probe_radii[2] / probe_radii[1] - .5) < 1e-10
    result = {
        "case": case["case_id"],
        "grid": grid.name,
        "wall_stations": len(wall),
        "chord_m": body["chord_m"],
        "meshing_thickness_m": body["chord_m"] * body["thickness_rel"],
        "nominal_nose_radius_m": nominal_radius,
        "measured_nose_radius_m": radius,
        "wall_corner_turn_deg": turn_deg,
        "probe_radii_m_at_6_3_1p5mm": probe_radii,
        "nose_wall_steps_m": [a, b],
        "median_first_layer_m": float(np.median(first_layer)),
        "nose_first_layer_m": float(first_layer[nose]),
        "wall_treatment": case["solver"]["wall_treatment"],
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    audit()
