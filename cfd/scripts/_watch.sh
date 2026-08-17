#!/bin/sh
# Сообщать о каждой новой сводке и о каждом упавшем случае.
# Разовый помощник, не часть контура.
cd "$(dirname "$0")/../.."
LOG="$1"
seen=""
fails=0
while true; do
    for f in out/cfd/summaries/*.json; do
        [ -f "$f" ] || continue
        n=$(basename "$f" .json)
        case " $seen " in *" $n "*) ;; *)
            seen="$seen $n"
            echo "готово: $n"
        ;; esac
    done
    if [ -f "$LOG" ]; then
        bad=$(grep -c "упал" "$LOG" 2>/dev/null || echo 0)
        if [ "$bad" -gt "$fails" ] 2>/dev/null; then
            fails=$bad
            echo "УПАЛ случай (всего упавших: $bad)"
        fi
    fi
    if ! pgrep -f "queue.py" > /dev/null 2>&1; then
        echo "очередь закончилась"
        exit 0
    fi
    sleep 60
done
