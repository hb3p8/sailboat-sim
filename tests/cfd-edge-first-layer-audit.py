#!/usr/bin/env python3
"""Read-only O-grid sweep toward a wall-resolved leading edge; no CFD."""

import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cfd.lib.ogrid import ogrid
from cfd.scripts.make_ogrid import quality, section_loop


def main():
    chord = 3.9
    contour = section_loop(.18, .5, chord, .015, nose_resolved=True)
    print("r_far_m n_theta n_radial first_layer_mm negative nonortho_deg actual_first_mm")
    for n_theta in (600,):
        for r_far in (30, 120, 1950):
            for n_radial in (100, 140):
                for first_layer in (.0002, .0005, .001):
                    grid = ogrid(contour, r_far=r_far, n_theta=n_theta,
                                 n_radial=n_radial, first_layer=first_layer)
                    q = quality(grid, chord=chord)
                    assert math.isfinite(q["nonortho_max"])
                    print(r_far, n_theta, n_radial, first_layer * 1000,
                          q["negative"], round(q["nonortho_max"], 3),
                          round(q["first_layer"] * 1000, 6))
    print("normal_passes smooth_gain negative nonortho_deg")
    for normal_passes in (120, 240, 480):
        for smooth_gain in (.2, .4, .6):
            grid = ogrid(contour, r_far=1950, n_theta=600,
                         n_radial=100, first_layer=.0002,
                         normal_passes=normal_passes,
                         smooth_gain=smooth_gain)
            q = quality(grid, chord=chord)
            assert math.isfinite(q["nonortho_max"])
            print(normal_passes, smooth_gain, q["negative"],
                  round(q["nonortho_max"], 3))
    print("n_theta negative nonortho_deg (r_far=1950m, n_radial=100, first_layer=0.2mm, gain=0.4)")
    for n_theta in (800, 1000, 1200):
        grid = ogrid(contour, r_far=1950, n_theta=n_theta,
                     n_radial=100, first_layer=.0002,
                     normal_passes=240, smooth_gain=.4)
        q = quality(grid, chord=chord)
        assert math.isfinite(q["nonortho_max"])
        print(n_theta, q["negative"], round(q["nonortho_max"], 3))


if __name__ == "__main__":
    main()
