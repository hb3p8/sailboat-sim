#!/bin/sh
# Сообщать о каждой новой сводке и о каждом упавшем случае.
# Разовый помощник, не часть контура.
cd "$(dirname "$0")/../.."
seen=""
fails=""
while true; do
    for f in out/cfd/summaries/*.json; do
        [ -f "$f" ] || continue
        n=$(basename "$f" .json)
        case " $seen " in *" $n "*) ;; *)
            seen="$seen $n"
            echo "готово: $n"
        ;; esac
    done
    bad=$(grep -c "упал" /private/tmp/claude-501/-Users-hb3p8-projects-sv20/398e1f93-61b4-505a-b729-b7d178947800/tasks/bdczza6zm.output 2>/dev/null || echo 0)
    if [ "$bad" != "$fails" ]; then
        fails="$bad"
        [ "$bad" != "0" ] && echo "УПАВШИХ СЛУЧАЕВ: $bad"
    fi
    if ! pgrep -f "queue.py" > /dev/null 2>&1; then
        echo "очередь закончилась"
        exit 0
    fi
    sleep 60
done
