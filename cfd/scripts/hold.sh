#!/bin/sh
# Пауза и возобновление расчётов OpenFOAM: cfd/scripts/hold.sh {pause|resume|status}
#
# Работает сигналами SIGSTOP/SIGCONT по ГРУППАМ процессов: очередь, mpirun и
# решатели замирают все разом и продолжают с того же места — состояние счёта
# не теряется, файлы не портятся. Единственный побочный эффект — время стены
# в логах включает простой; на физический ответ оно не влияет.
#
# Ловятся: сама очередь (queue.py), одиночные запуски (cfd.py run/case/collect),
# mpirun и решатели/сеточники OpenFOAM по именам.

PATTERNS='cfd/scripts/queue.py|cfd\.py (run|case|collect)|mpirun|prterun|simpleFoam|interFoam|potentialFoam|snappyHexMesh|blockMesh|decomposePar|reconstructPar|checkMesh|surfaceFeatureExtract|renumberMesh'

pgids() {
    pgrep -f "$PATTERNS" 2>/dev/null |
        xargs -r ps -o pgid= -p 2>/dev/null | sort -u | tr -d ' '
}

case "$1" in
pause)
    G=$(pgids)
    [ -z "$G" ] && { echo "расчётов не найдено"; exit 0; }
    for g in $G; do kill -STOP -- -"$g" 2>/dev/null; done
    echo "на паузе: группы $(echo $G | tr '\n' ' ')"
    ;;
resume)
    G=$(pgids)
    [ -z "$G" ] && { echo "расчётов не найдено"; exit 0; }
    for g in $G; do kill -CONT -- -"$g" 2>/dev/null; done
    echo "продолжены: группы $(echo $G | tr '\n' ' ')"
    ;;
status|*)
    P=$(pgrep -f "$PATTERNS" 2>/dev/null)
    [ -z "$P" ] && { echo "расчётов нет"; exit 0; }
    echo "$P" | xargs ps -o pid=,stat=,pcpu=,etime=,comm= -p 2>/dev/null |
        awk '{s=($2 ~ /^T/) ? "ПАУЗА " : "идёт  "; printf "  %s %6s  cpu %5s%%  %8s  %s\n", s, $1, $3, $4, $5}'
    ;;
esac
