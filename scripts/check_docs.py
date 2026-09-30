#!/usr/bin/env python3
"""Проверить локальные ссылки и доступность проектной документации без сети.

Проверяются Markdown-файлы под контролем Git и новые неигнорируемые файлы.
Внешние адреса, команды и исторические цитаты внутри манифестов не исполняются.
"""

from collections import Counter
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"\[[^\]\n]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)")
REFERENCE = re.compile(r"^\s*\[[^\]]+\]:\s*(\S+)", re.MULTILINE)
DOC_PATH = re.compile(r"\bdocs/[\w/-]+\.md")


def tracked_and_new():
    raw = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
    )
    return sorted({ROOT / p.decode() for p in raw.split(b"\0") if p})


def prose(text):
    """Убрать ограждённые блоки примеров, сохранив номера строк."""
    fence = None
    lines = []
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            lines.append("")
        else:
            lines.append(line if fence is None else "")
    return "\n".join(lines)


def anchors(text):
    found = set()
    counts = Counter()
    for heading in re.findall(r"^#{1,6}\s+(.+?)\s*#*\s*$", prose(text), re.MULTILINE):
        slug = re.sub(r"[^\w\s-]", "", heading.lower()).replace(" ", "-")
        suffix = f"-{counts[slug]}" if counts[slug] else ""
        counts[slug] += 1
        found.add(slug + suffix)
    return found


def main():
    files = [p for p in tracked_and_new() if p.is_file()]
    documents = {p: p.read_text() for p in files if p.suffix == ".md"}
    edges = {p: set() for p in documents}
    errors = []
    links = 0
    for path, text in documents.items():
        body = prose(text)
        targets = [m.group(1) for m in LINK.finditer(body)]
        targets.extend(m.group(1) for m in REFERENCE.finditer(body))
        for target in targets:
            url = urlsplit(target.strip("<>"))
            if url.scheme or url.netloc:
                continue
            links += 1
            local = (path.parent / unquote(url.path)).resolve() if url.path else path
            if not local.exists():
                errors.append(f"{path.relative_to(ROOT)}: нет {target}")
                continue
            if local in edges:
                edges[path].add(local)
            if url.fragment and local in documents:
                if unquote(url.fragment) not in anchors(documents[local]):
                    errors.append(f"{path.relative_to(ROOT)}: нет раздела {target}")

    reachable = set()
    pending = [ROOT / "README.md"]
    while pending:
        path = pending.pop()
        if path in reachable:
            continue
        reachable.add(path)
        pending.extend(edges.get(path, ()))
    for path in documents.keys() - reachable:
        errors.append(f"{path.relative_to(ROOT)}: нет пути от README.md")

    # Ссылки в комментариях и выводе своих инструментов должны вести к файлам.
    # JSON-манифесты расчётов остаются неизменной записью исходной постановки.
    for path in files:
        if path.suffix not in (".js", ".mjs", ".py", ".c", ".h") and path.name != "Makefile":
            continue
        if "vendor" in path.parts:
            continue
        for target in set(DOC_PATH.findall(path.read_text())):
            if not (ROOT / target).is_file():
                errors.append(f"{path.relative_to(ROOT)}: нет {target}")
    if errors:
        print("Ошибки документации:\n" + "\n".join(sorted(errors)), file=sys.stderr)
        return 1
    print(f"Документация: {len(documents)} файлов, {links} локальных ссылок; "
          "ссылки и навигация исправны.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
