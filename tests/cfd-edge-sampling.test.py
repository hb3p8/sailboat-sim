#!/usr/bin/env python3
"""Geometry-only nose test; no OpenFOAM run and no grid file is written."""

import math
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cfd.lib import geometry as geo
from cfd.lib.ogrid import ogrid
from cfd.scripts.make_ogrid import quality, section_loop


def tip_geometry(loop, chord):
    i = int(np.argmin(np.linalg.norm(loop - np.array([chord, 0.0]), axis=1)))
    prev, tip, nxt = loop[(i - 1) % len(loop)], loop[i], loop[(i + 1) % len(loop)]
    u, v = tip - prev, nxt - tip
    a, b = np.linalg.norm(u), np.linalg.norm(v)
    turn = math.degrees(math.acos(np.clip(u @ v / (a * b), -1, 1)))
    ac = nxt - prev
    twice_area = abs(u[0] * ac[1] - u[1] * ac[0])
    radius = a * b * np.linalg.norm(ac) / (2 * twice_area)
    return turn, radius


def main():
    chord, thickness = 3.9, .015
    nominal = chord * thickness / 2
    # x is chordwise, not centerline arclength. The round-nose parameter r
    # therefore produces local osculating radius r*cos(entry angle).
    analytic_radius = nominal / math.sqrt(1 + (2 * .18 / .5) ** 2)
    legacy = section_loop(.18, .5, chord, thickness)
    smooth = section_loop(.18, .5, chord, thickness, nose_resolved=True)
    old_turn, old_radius = tip_geometry(legacy, chord)
    new_turn, new_radius = tip_geometry(smooth, chord)
    assert old_turn > 20
    assert new_turn < 5
    assert abs(new_radius - analytic_radius) / analytic_radius < .05
    assert new_turn < old_turn / 10
    upper, lower = geo.sail_section(.18, .5, chord, thickness,
                                    nose_resolved=True)
    solid = geo.extrude_section(upper, lower, span=.2, z0=-.1)
    assert geo.watertight(solid)["watertight"]

    # The same O-grid marshalling path, evaluated in memory. Existing grid and
    # historical CFD fields are not modified by this witness.
    coarse = ogrid(smooth, r_far=1950, n_theta=300,
                   n_radial=100, first_layer=.015)
    coarse_q = quality(coarse, chord=chord)
    assert coarse_q["negative"] > 0
    points = ogrid(smooth, r_far=1950, n_theta=600,
                   n_radial=100, first_layer=.006)
    q = quality(points, chord=chord)
    nose_turn, nose_radius = tip_geometry(points[0], chord)
    assert q["negative"] == 0
    assert nose_turn < 5
    assert abs(nose_radius - analytic_radius) / analytic_radius < .15
    print({"legacy_turn_deg": old_turn, "legacy_radius_m": old_radius,
           "resolved_turn_deg": new_turn, "resolved_radius_m": new_radius,
           "nose_parameter_m": nominal,
           "analytic_radius_m": analytic_radius,
           "coarse_ogrid_negative_cells": coarse_q["negative"],
           "ogrid_nose_turn_deg": nose_turn,
           "ogrid_nose_radius_m": nose_radius,
           "ogrid_negative_cells": q["negative"],
           "ogrid_nonortho_max_deg": q["nonortho_max"],
           "ogrid_nose_step_m": q["step_nose"],
           "ogrid_first_layer_m": q["first_layer"]})


if __name__ == "__main__":
    main()
