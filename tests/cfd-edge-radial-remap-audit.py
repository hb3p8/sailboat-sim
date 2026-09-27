#!/usr/bin/env python3
"""In-memory geometric radial remap of a non-inverted O-grid; no CFD."""

import math
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cfd.lib.ogrid import ogrid, remap_radial
from cfd.scripts.make_ogrid import quality, section_loop


def main():
    chord = 3.9
    contour = section_loop(.18, .5, chord, .015, nose_resolved=True)
    base = ogrid(contour, r_far=1950, n_theta=600, n_radial=100, first_layer=.006)
    baseline = quality(base, chord=chord)
    assert baseline["negative"] == 0
    print("baseline", baseline["negative"], baseline["nonortho_max"], baseline["first_layer"])
    print("n_radial first_med_mm first_min_mm first_max_mm negative nonortho_deg max_step_ratio")
    for n_radial in (140, 160, 180, 200):
        grid = remap_radial(base, n_radial, .0002)
        q = quality(grid, chord=chord)
        local_steps = np.linalg.norm(np.diff(grid, axis=0), axis=2)
        first = local_steps[0]
        max_ratio = np.max(local_steps[1:] / local_steps[:-1])
        assert math.isfinite(q["nonortho_max"])
        assert q["negative"] == 0
        assert q["nonortho_max"] < 70
        assert abs(q["first_layer"] - .0002) < 1e-6
        assert np.array_equal(grid[0], base[0])
        assert np.array_equal(grid[-1], base[-1])
        print(n_radial, round(q["first_layer"] * 1000, 6),
              round(float(first.min()) * 1000, 6),
              round(float(first.max()) * 1000, 6),
              q["negative"], round(q["nonortho_max"], 3),
              round(float(max_ratio), 3))
    print("r_far_m base_negative base_nonortho_deg remap_negative remap_nonortho_deg")
    for r_far in (30, 120, 300, 600):
        candidate = ogrid(contour, r_far=r_far, n_theta=600,
                          n_radial=100, first_layer=.006)
        base_q = quality(candidate, chord=chord)
        refined = remap_radial(candidate, 180, .0002)
        refined_q = quality(refined, chord=chord)
        print(r_far, base_q["negative"], round(base_q["nonortho_max"], 3),
              refined_q["negative"], round(refined_q["nonortho_max"], 3))
    coarser = remap_radial(base, 180, .0005)
    coarser_q = quality(coarser, chord=chord)
    coarser_first = np.linalg.norm(coarser[1] - coarser[0], axis=1)
    assert coarser_q["negative"] == 0
    assert coarser_q["nonortho_max"] < 70
    assert np.array_equal(coarser[0], base[0])
    assert np.array_equal(coarser[-1], base[-1])
    print("0.5mm geometric candidate", coarser_q["negative"],
          round(coarser_q["nonortho_max"], 3),
          round(coarser_q["first_layer"] * 1000, 6),
          round(float(coarser_first.min()) * 1000, 6),
          round(float(coarser_first.max()) * 1000, 6))


if __name__ == "__main__":
    main()
