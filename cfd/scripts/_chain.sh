#!/bin/sh
# Дождаться первой очереди и досчитать остаток полного списка.
# Разовый помощник, не часть контура.
cd "$(dirname "$0")/../.."
while kill -0 "$1" 2>/dev/null; do sleep 30; done
echo "первая очередь закончилась, досчитываю остаток"
exec .venv/bin/python cfd/scripts/queue.py
