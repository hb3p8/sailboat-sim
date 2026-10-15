"""Проверяемые входы обычной сборки; результаты out/ не выбираются неявно."""
import hashlib
import json
from pathlib import Path

SIM_MANIFEST = "data/simulator/v1/manifest.json"


def load_sim_runtime(root):
    root = Path(root).resolve()
    manifest = json.loads((root / SIM_MANIFEST).read_text())
    if manifest.get("schema") != "sv20-simulator-bundle-v1" or manifest.get("version") != 1:
        raise ValueError("Неизвестная версия входов симулятора")

    def read(entry):
        path = (root / entry["path"]).resolve()
        if not path.is_relative_to(root / "data/simulator/v1"):
            raise ValueError("Вход симулятора вышел из каталога версии")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Изменился вход симулятора: " + entry["path"])
        return data

    physics = json.loads(read(manifest["physics"]))
    mesh = json.loads(read(manifest["mesh"]))
    for key in ("wasm", "materialWasm"):
        if not read(manifest[key]).startswith(b"\0asm"):
            raise ValueError("Неверный вычислительный модуль: " + key)
    if set(manifest["inputs"]) != {"plus", "minus"}:
        raise ValueError("Нужны оба борта генакера")
    for side, entry in manifest["inputs"].items():
        source = json.loads(read(entry))
        if (source["schema"] != "cloth-fluid-live-v1" or source["dirty"] or source["side"] != side
                or source["physicsSha256"] != manifest["physics"]["sha256"]
                or source["recipe"]["rows"] != 11 or source["recipe"]["cols"] != 9
                or any(source[k]["sha256"] != manifest[k]["sha256"] for k in ("wasm", "materialWasm"))):
            raise ValueError("Несогласованные входы генакера: " + side)
    return physics, mesh, manifest
