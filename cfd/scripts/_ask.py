"""Разовый вопрос модели о сечении. Не часть контура."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from cfd.lib import simbridge  # noqa: E402

want = [(35, 0.0), (25, 0.185), (35, 0.185), (45, 0.185)]
ans = simbridge.query([{"fn": "polar", "alpha_deg": a, "camber": c}
                       for a, c in want])
print("угол  пузо    Cl     Cd    потолок  угол срыва")
for (a, c), r in zip(want, ans):
    print("%4d %6.3f %6.3f %6.3f %8.3f %10.1f"
          % (a, c, r["cl"], r["cd"], r["ceiling"], r["stall_deg"]))
