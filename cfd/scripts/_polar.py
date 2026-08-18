"""Разовый взгляд на поляру киля: CFD против модели. Не часть контура."""
import glob
import json
import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from cfd.lib import simbridge  # noqa: E402

rows = []
for p in sorted(glob.glob("out/cfd/summaries/keel-*.json")):
    s = json.load(open(p, encoding="utf-8"))
    rows.append((s["manifest"]["condition"]["leeway_deg"], s["case_id"],
                 s["derived"]["Cl"], s["derived"]["Cd"],
                 (s.get("layers") or {}).get("percent"), s["mesh"]["cells"]))
rows.sort()
ans = simbridge.query([{"fn": "foil", "alpha_deg": r[0], "foil": "keel"}
                       for r in rows])
print("  a   случай                    Cl(CFD)  Cl(мод)  отн   Cd(CFD)  слои%   ячеек")
for r, a in zip(rows, ans):
    print("%4.1f  %-25s %7.4f %8.4f %5.2f %8.4f %6.1f %8d"
          % (r[0], r[1], r[2], a["cl"], r[2] / a["cl"] if a["cl"] else 0,
             r[3], r[4] or 0, r[5]))

lin = [r for r in rows if r[0] >= 0]
if len(lin) >= 2:
    sl = (lin[-1][2] - lin[0][2]) / (lin[-1][0] - lin[0][0])
    rad = sl * 180 / math.pi
    ar = 2.0 / (2 * math.pi / rad - 1.0) if 0 < rad < 2 * math.pi else None
    print("\nнаклон %.5f 1/град = %.3f 1/рад -> удлинение %s"
          % (sl, rad, "%.2f" % ar if ar else "вне области"))
    print("геометрическое 3.75, в симуляторе 5.62, зеркальное 7.50")
