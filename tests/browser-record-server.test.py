"""Исходные байты, границы HTTP и сохранение прежних записей стенда."""
import hashlib
import http.client
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading

assert len(sys.argv) == 2 and sys.argv[1].startswith("--out=")
out = pathlib.Path(sys.argv[1][6:]); assert not out.exists()
source = pathlib.Path(__file__).resolve().parents[1] / "scripts/serve.py"
spec = importlib.util.spec_from_file_location("sv20_record_server", source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
accepted, rejected = [], []
with tempfile.TemporaryDirectory(prefix="sv20-record-test-") as temp:
    module.ROOT = temp
    module.BROWSER_RECORD_DIR = str(pathlib.Path(temp) / "out/acceptance")
    with module.Server(("127.0.0.1", 0), module.Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(raw, length=None):
            client = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            client.request("POST", module.BROWSER_RECORD_URL, raw,
                           {"Content-Type": "application/json", "Content-Length": str(len(raw) if length is None else length)})
            response = client.getresponse(); status = response.status; data = json.loads(response.read()); client.close()
            return status, data
        try:
            for raw in [
                '{"schema":"cloth-fluid-browser-pair-v1","input":{},"records":[{"нуль":-0,"малое":5e-324,"точное":1.0000000000000002}]}\n'.encode(),
                b'{"schema":"cloth-fluid-live-result-v1","fixture":{},"steps":[],"phase":"failed"}\n',
            ]:
                status, receipt = request(raw); assert status == 200, receipt
                path = pathlib.Path(temp) / receipt["file"]
                assert path.read_bytes() == raw
                assert receipt["bytes"] == len(raw) and receipt["sha256"] == hashlib.sha256(raw).hexdigest()
                accepted.append(receipt)
            directory = pathlib.Path(module.BROWSER_RECORD_DIR)
            old = {p.name: p.read_bytes() for p in directory.iterdir()}
            for name, raw, length, expected in [
                ("неизвестная-схема", b'{"schema":"other"}', None, 400),
                ("неполная-запись", b'{"schema":"cloth-fluid-browser-pair-v1"}', None, 400),
                ("невалидный-json", b'{', None, 400),
                ("пустое-тело", b'', None, 400),
                ("отрицательная-длина", b'', -1, 400),
                ("нечисловая-длина", b'', "bad", 400),
                ("слишком-большое-тело", b'{}', module.BROWSER_RECORD_MAX_BODY + 1, 413),
            ]:
                status, _ = request(raw, length); assert status == expected, name
                assert {p.name: p.read_bytes() for p in directory.iterdir()} == old
                rejected.append(name)
            server.read_only = True
            assert request(b'{}')[0] == 403
            assert {p.name: p.read_bytes() for p in directory.iterdir()} == old
            rejected.append("сервер-открыт-в-сеть")
            # Принудительное совпадение имён не должно заменять прежние байты.
            module.secrets.token_hex = lambda _: "a" * 12
            raw = b'{"schema":"cloth-fluid-live-result-v1","fixture":{},"steps":[]}'
            receipt = module.browser_record_save(raw)
            try:
                module.browser_record_save(raw + b'\n')
                raise AssertionError("Совпадение имени принято")
            except ValueError:
                pass
            assert (pathlib.Path(temp) / receipt["file"]).read_bytes() == raw
            rejected.append("повтор-имени")
        finally:
            server.shutdown(); thread.join()
result = {"schema": "browser-record-server-check-v1", "phase": "complete", "accepted": len(accepted), "rejected": rejected,
          "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
          "testSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          "scope": "HTTP и сохранение исходных байтов; это не физическая приёмка записи."}
with out.open("x", encoding="utf-8") as f: json.dump(result, f, ensure_ascii=False, indent=2); f.write("\n")
print("Сохранение записи: два формата сохранили байты и SHA; %d отказов, прежние файлы сохранены." % len(rejected))
