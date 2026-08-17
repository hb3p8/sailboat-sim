# Образ решателя. Собирается редко, живёт долго.
#
# Смысл этого файла не в удобстве установки, а в §3.1: в манифест результата
# записывается не тег, а DIGEST. Тег `2306` через полгода может указывать на
# другой образ, и тогда «тот же расчёт» посчитан другой версией решателя, а
# расхождение с эталоном спишут на физику.
#
#     make cfd-image
#     docker push <registry>/sv20-openfoam:2306
#     docker inspect --format='{{index .RepoDigests 0}}' <registry>/sv20-openfoam:2306
#
# Полученную строку `registry/name@sha256:...` кладут в solver.image манифеста.
# Проверка манифеста (cfd/lib/manifest.py) отвергает образ без digest.

FROM opencfd/openfoam-default:2306

# Питон нужен внутри образа только постобработке, которую удобно гонять там же,
# где лежат поля: перетаскивать десятки гигабайт ради разбора истории сил
# бессмысленно. Сама сводка после этого весит килобайты.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-numpy \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /case
