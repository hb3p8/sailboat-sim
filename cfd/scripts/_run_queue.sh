#!/bin/sh
# Запуск очереди в фоне. Разовый помощник, не часть контура.
cd "$(dirname "$0")/../.."
exec .venv/bin/python cfd/scripts/queue.py
