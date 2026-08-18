#!/bin/sh
# Ждать, пока обе тройки сеток соберутся целиком. Разовый помощник.
cd "$(dirname "$0")/../.."
S=out/cfd/summaries
while true; do
    n=0
    for f in "$S/keel-u200-a06-coarse.json" "$S/keel-u200-a06-medium.json" \
             "$S/keel-u200-a06-fine.json" "$S/hull-db-u250-b00-coarse.json" \
             "$S/hull-db-u250-b00-medium.json" "$S/hull-db-u250-b00-fine.json"; do
        [ -f "$f" ] && n=$((n + 1))
    done
    if [ "$n" -ge 6 ]; then
        echo "обе тройки собраны"
        exit 0
    fi
    if ! pgrep -f "queue.py" > /dev/null 2>&1; then
        echo "очередь закончилась, троек собрано $n из 6"
        exit 0
    fi
    sleep 60
done
