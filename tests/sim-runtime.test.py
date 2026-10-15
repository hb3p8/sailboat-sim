"""Пакет выпуска проверяется до сборки, независимо от out/ и старых входов."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from sim_runtime import load_sim_runtime, SIM_MANIFEST

physics, mesh, manifest = load_sim_runtime(ROOT)
assert physics and mesh and manifest["version"] == 1
rejected = 0
for kind in ("version", "escape", "side", "physics", "wasm", "missing"):
    with tempfile.TemporaryDirectory(prefix="sv20-runtime-") as temp:
        root = Path(temp)
        shutil.copytree(ROOT / "data/simulator/v1", root / "data/simulator/v1")
        path = root / SIM_MANIFEST
        m = json.loads(path.read_text())
        if kind == "version":
            m["version"] = 2
        elif kind == "escape":
            m["inputs"]["plus"]["path"] = "out/acceptance/unknown.json"
        elif kind == "side":
            m["inputs"]["minus"] = m["inputs"]["plus"]
        elif kind == "physics":
            (root / m["physics"]["path"]).write_bytes(b"{}")
        elif kind == "wasm":
            (root / m["wasm"]["path"]).write_bytes(b"broken")
        else:
            (root / m["mesh"]["path"]).unlink()
        path.write_text(json.dumps(m))
        try:
            load_sim_runtime(root)
        except (ValueError, FileNotFoundError):
            rejected += 1
        else:
            raise AssertionError("Принят повреждённый вход: " + kind)
        assert not (root / "out").exists()
print(f"Входы версии 1 проверены; {rejected} повреждений отклонены без out/ и без записи результатов.")
