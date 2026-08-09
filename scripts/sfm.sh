#!/bin/bash
# Позы камер по кадрам одного плана: COLMAP, последовательное сопоставление.
#
#   scripts/sfm.sh data/video/shot01 [фокусное_в_пикселях]
#
# ГЛАВНОЕ, из-за чего первый заход провалился, потратив восемнадцать минут на
# сообщение «No good initial image pair found»: штатный порог угла триангуляции
# при инициализации у COLMAP — 16°, а во всём плане такого угла нет.
#
# Считается это на пальцах и до запуска. Дрон идёт по прямой, за 7.6 с проходит
# около семидесяти метров, снимает с трёхсот пятидесяти. Угол триангуляции по
# ВСЕЙ базе выходит 11°, между соседними кадрами — треть градуса. Порог в 16°
# не может пройти ни одна пара, и перебор их всех — это те самые восемнадцать
# минут. Отсюда init_min_tri_angle 4 ниже: не «подкрутить, чтобы заработало», а
# привести порог в соответствие с геометрией съёмки. У всякого монтажного плана
# по 7-8 секунд будет ровно то же.
#
# Второе, помельче: модель камеры. OPENCV с четырьмя коэффициентами дисторсии
# подбирать не на чем — при малом параллаксе они уходят в компенсацию ошибки
# фокусного. SIMPLE_RADIAL обусловлен лучше, а видео с дрона и так отдаётся
# почти прямолинейным. Фокусное COLMAP уточняет сам: приор ниже задан грубо,
# на съёмке 1600 px он сходится к 1632 px, то есть к 52° по горизонтали.
#
# Третье, не ошибка, но дорого: 17 тысяч особых точек на кадр в первом заходе.
# Для инициализации сплатов хватает четырёх — плотность даёт не точность, а
# время.
set -e

DIR="${1:?укажи каталог плана}"
FOCAL="${2:-}"
cd "$DIR"

W=$(python3 -c "
from PIL import Image; import os,glob
print(Image.open(sorted(glob.glob('images/*.jpg'))[0]).size[0])")
[ -z "$FOCAL" ] && FOCAL=$(python3 -c "print(round($W*0.72))")   # ≈ 70° по горизонтали

echo "кадров: $(ls images | wc -l), ширина ${W}px, фокусное ${FOCAL}px"
rm -rf db.db sparse && mkdir -p sparse

colmap feature_extractor --database_path db.db --image_path images \
  --ImageReader.single_camera 1 \
  --ImageReader.camera_model SIMPLE_RADIAL \
  --ImageReader.camera_params "$FOCAL,$((W/2)),0,0" \
  --FeatureExtraction.max_image_size "$W" \
  --SiftExtraction.max_num_features 4096

colmap sequential_matcher --database_path db.db \
  --SequentialMatching.overlap 15 --SequentialMatching.quadratic_overlap 1

# Пороги угла триангуляции опущены нарочно: при полёте вперёд эпиполь внутри
# кадра, и у точек около центра параллакса почти нет. Штатные 16° такую съёмку
# отвергают целиком.
colmap mapper --database_path db.db --image_path images --output_path sparse \
  --Mapper.init_min_tri_angle 4 \
  --Mapper.filter_min_tri_angle 1.5 \
  --Mapper.ba_global_frames_ratio 1.4

for m in sparse/*/; do
  echo "--- $m"
  colmap model_analyzer --path "$m" 2>&1 |
    grep -oE "(Cameras|Images|Points|Mean track length|Mean reprojection error): .*"
done
