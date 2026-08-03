"""Реальная акватория: рельеф из Copernicus DEM и берег из OpenStreetMap.

До этого вода в симуляторе была бесконечной плоскостью. Это удобно и честно
ровно до того момента, когда лодка начинает ходить по реке: на реке разгон
волны упирается в противоположный берег, ветер заходит под высоким берегом, а
острова делят плёс на рукава. Ни одного из этих явлений на бесконечной воде
не существует.

Здесь собирается заготовка под это — карта участка: высоты суши, урез воды и
маска акватории с островами. Никакой физики, никакой привязки к симулятору;
результат кладётся в `out/terrain.json` и смотрится отдельной страницей.

Источники и почему именно они
-----------------------------

Рельеф — **Copernicus DEM GLO-30**, 30 м, глобальный, открытая лицензия с
атрибуцией. Лежит в открытом бакете AWS плитками по одному градусу, без ключей
и регистрации. Google Elevation API, о котором думаешь первым делом, здесь не
годится дважды: его условия запрещают хранить выдачу и строить из неё
производные наборы (а карта в репозитории — ровно это), и внутри у него всё
равно SRTM, то есть данные хуже даром доступных.

Берег — **OpenStreetMap** через Overpass. Это важнее рельефа: DEM над водой
плоский и урез по нему находится скверно, а в OSM Волга размечена полигонами,
с островами и затонами. Лицензия ODbL, нужна атрибуция.

Глубин в открытых источниках нет и не предвидится: карты внутренних водных
путей издаёт бассейновое управление, и они не открытые. Дно здесь рисуется
условным откосом от берега — чтобы было чему отражать свет и обо что садиться,
а не чтобы соответствовать промеру.

Как читается DEM
----------------

Плитка GLO-30 весит тридцать мегабайт, а нужен из неё кусок в пару процентов.
Поэтому она не качается целиком: COG — это обычный TIFF с внутренними тайлами
и таблицей их смещений в заголовке, и HTTP умеет отдавать диапазон байтов.
Сначала забираются первые 64 КБ (заголовок и таблица), по ним считается, какие
тайлы накрывают нужное окно, и качаются только они. Выходит около мегабайта
вместо шестидесяти.

Распаковка своя, потому что GDAL в проект тащить незачем: тайл сжат deflate и
пропущен через предиктор с плавающей точкой (тег 317 = 3). Предиктор
раскладывает каждую строку на четыре байтовых плана — старший байт всех
отсчётов, потом следующий и так далее — и хранит их разностями. Обратное
преобразование в `_undo_float_predictor`.

Зависимости: numpy, scipy (преобразование расстояний), pillow (разбор тегов
TIFF и растеризация полигонов).
"""

import io
import json
import math
import os
import time
import urllib.parse
import urllib.request
import zlib

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

COP30_BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"

# Зеркала Overpass. Основное регулярно отвечает «сервер занят» — это его
# обычное состояние, а не поломка, поэтому список, а не один адрес.
OVERPASS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

ATTRIBUTION = (
    "Рельеф: Copernicus DEM GLO-30 © ESA / DLR, лицензия Copernicus.",
    "Берег: © OpenStreetMap contributors, ODbL.",
)

# ---------------------------------------------------------------------------
# Локальная метрическая система
# ---------------------------------------------------------------------------


class Frame:
    """Касательная плоскость с началом в центре участка.

    Для пятнадцати километров разница между честной проекцией и касательной
    плоскостью — сантиметры, а мороки с зонами UTM и границами между ними не
    возникает вовсе. Ось X на восток, Y на север, метры.
    """

    def __init__(self, lat0, lon0):
        self.lat0 = lat0
        self.lon0 = lon0
        p = math.radians(lat0)
        # Длина градуса на эллипсоиде WGS84, разложение по широте.
        self.m_lat = 111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
        self.m_lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p)

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.m_lon, (lat - self.lat0) * self.m_lat)

    def lat(self, y):
        return self.lat0 + y / self.m_lat

    def lon(self, x):
        return self.lon0 + x / self.m_lon


# ---------------------------------------------------------------------------
# Сеть
# ---------------------------------------------------------------------------


def _get(url, rng=None, tries=6, timeout=120):
    """GET с повтором. Диапазон байтов — кортежем (от, до) включительно."""
    headers = {"User-Agent": "sv20-terrain/1.0 (github project, offline sim)"}
    if rng is not None:
        headers["Range"] = "bytes=%d-%d" % rng
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — важен факт неудачи, не её вид
            last = e
            time.sleep(min(2 ** k, 20))
    raise RuntimeError("не скачалось: %s (%s)" % (url, last))


def _cached(path, produce):
    """Кэш на диске: сеть здесь медленная, а данные не меняются годами."""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, "rb").read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    blob = produce()
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(blob)
    os.replace(tmp, path)
    return blob


# ---------------------------------------------------------------------------
# Copernicus DEM: чтение окна из COG по диапазонам байтов
# ---------------------------------------------------------------------------


def _undo_float_predictor(raw, tw, th):
    """Развернуть предиктор 3 (тег 317) для float32.

    В строке лежат четыре байтовых плана подряд, каждый — разностями. Значит
    сначала накопление по всей строке в uint8 (с переполнением, оно тут
    осмысленное), потом перестановка планов обратно в отсчёты. План 0 — старший
    байт, поэтому собранное читается как big-endian независимо от порядка
    байтов самого файла.
    """
    a = np.frombuffer(raw, np.uint8).reshape(th, 4 * tw)
    a = np.cumsum(a, axis=1, dtype=np.uint8)
    a = a.reshape(th, 4, tw).transpose(0, 2, 1)
    return np.ascontiguousarray(a).view(">f4").reshape(th, tw)


class _CogTile:
    """Одна градусная плитка GLO-30, читаемая по кусочкам."""

    def __init__(self, lat, lon, cache):
        name = "Copernicus_DSM_COG_10_%s%02d_00_%s%03d_00_DEM" % (
            "N" if lat >= 0 else "S", abs(lat), "E" if lon >= 0 else "W", abs(lon))
        self.url = "%s/%s/%s.tif" % (COP30_BUCKET, name, name)
        self.cache = os.path.join(cache, name)

        head = _cached(self.cache + ".head", lambda: _get(self.url, (0, 65535)))
        t = Image.open(io.BytesIO(head)).tag_v2
        if t[259] != 8 or t.get(317) != 3 or t[258] != (32,):
            raise RuntimeError("плитка %s сжата не так, как ожидалось" % name)

        self.w, self.h = int(t[256]), int(t[257])
        self.tw, self.th = int(t[322]), int(t[323])
        self.offsets, self.counts = list(t[324]), list(t[325])
        sx, sy = t[33550][0], t[33550][1]
        tie = t[33922]
        # Пиксель (0,0) — верхний левый угол растра; координата его центра
        # сдвинута на полпикселя внутрь.
        self.lon0, self.lat0 = tie[3], tie[4]
        self.dlon, self.dlat = sx, -sy
        self.cols = (self.w + self.tw - 1) // self.tw

    def px(self, lat, lon):
        """Дробный индекс пикселя по географическим координатам."""
        return ((lon - self.lon0) / self.dlon - 0.5,
                (lat - self.lat0) / self.dlat - 0.5)

    def read(self, c0, r0, c1, r1):
        """Прочитать окно [c0,c1) × [r0,r1) в индексах пикселей растра."""
        out = np.full((r1 - r0, c1 - c0), np.nan, np.float32)
        for tr in range(r0 // self.th, (r1 - 1) // self.th + 1):
            for tc in range(c0 // self.tw, (c1 - 1) // self.tw + 1):
                idx = tr * self.cols + tc
                off, cnt = self.offsets[idx], self.counts[idx]
                raw = _cached(
                    "%s.t%03d.bin" % (self.cache, idx),
                    lambda off=off, cnt=cnt: _get(self.url, (off, off + cnt - 1)))
                v = _undo_float_predictor(zlib.decompress(raw), self.tw, self.th)
                # Пересечение тайла с запрошенным окном, в индексах растра.
                a0, b0 = tc * self.tw, tr * self.th
                ca, cb = max(c0, a0), min(c1, a0 + self.tw)
                ra, rb = max(r0, b0), min(r1, b0 + self.th)
                if ca >= cb or ra >= rb:
                    continue
                out[ra - r0:rb - r0, ca - c0:cb - c0] = \
                    v[ra - b0:rb - b0, ca - a0:cb - a0]
        return out


def dem_window(bbox, cache, pad=0.01):
    """Высоты на регулярной сетке широта/долгота, накрывающей bbox с полем.

    Возвращает (высоты, широты, долготы); широты идут с севера на юг, как в
    самом растре.
    """
    s, w, n, e = bbox["south"] - pad, bbox["west"] - pad, \
        bbox["north"] + pad, bbox["east"] + pad

    tiles = {}
    for la in range(math.floor(s), math.floor(n) + 1):
        for lo in range(math.floor(w), math.floor(e) + 1):
            tiles[(la, lo)] = _CogTile(la, lo, cache)
    ref = tiles[(math.floor(s), math.floor(w))]

    # Общая сетка строится по шагу первой плитки: у GLO-30 шаг по долготе
    # зависит от широтного пояса, но внутри одного пояса он один на все плитки.
    dlon, dlat = ref.dlon, ref.dlat
    lons = np.arange(w, e + dlon, dlon)
    lats = np.arange(n, s + dlat, dlat)
    out = np.full((lats.size, lons.size), np.nan, np.float32)

    for (la, lo), t in tiles.items():
        # Какие столбцы и строки общей сетки попадают в эту плитку.
        cs = np.nonzero((lons >= lo) & (lons < lo + 1))[0]
        rs = np.nonzero((lats > la) & (lats <= la + 1))[0]
        if cs.size == 0 or rs.size == 0:
            continue
        c0, _ = t.px(0, lons[cs[0]])
        _, r0 = t.px(lats[rs[0]], 0)
        c0, r0 = int(round(c0)), int(round(r0))
        c1, r1 = min(c0 + cs.size, t.w), min(r0 + rs.size, t.h)
        c0, r0 = max(c0, 0), max(r0, 0)
        blk = t.read(c0, r0, c1, r1)
        out[rs[0]:rs[0] + blk.shape[0], cs[0]:cs[0] + blk.shape[1]] = blk

    return out, lats, lons


# ---------------------------------------------------------------------------
# OpenStreetMap: полигоны воды, леса и застройки
# ---------------------------------------------------------------------------
#
# Слоёв три, и берутся они разными запросами, а не одним: кэш тогда бьётся по
# слоям, и добавление нового не заставляет качать заново уже имеющиеся.
#
# Отдельные здания не берутся нарочно. Их в городе десятки тысяч, силуэт с воды
# они не меняют — с километра квартал читается сплошным массивом, а не набором
# коробок, — зато утраивают выгрузку. Застройка берётся кварталами по landuse.

WATER_SEL = ('["natural"="water"]', '["waterway"="riverbank"]')

FOREST_SEL = ('["landuse"="forest"]', '["natural"="wood"]',
              '["landuse"="orchard"]', '["leisure"="park"]')

URBAN_SEL = ('["landuse"~"^(residential|industrial|commercial|retail|'
             'garages|construction|railway|port|quarry)$"]',)


def _stitch(ways):
    """Сшить отрезки в замкнутые кольца по совпадающим концам.

    Это не мелочь разбора, а условие того, чтобы река вообще появилась. Берег
    большой реки в OSM разрезан на десятки способов — по кускам, по авторам, по
    границам районов, — и роль outer несёт каждый из них. Если залить их
    поодиночке, получится не река, а кайма из тонких лоскутов вдоль берега:
    ровно так первая выгрузка и выглядела, и главное русло в маске
    отсутствовало.

    Концы сравниваются по координатам: точки приходят из одного источника и в
    стыке совпадают до последнего знака.
    """
    def key(p):
        return (round(p[0], 7), round(p[1], 7))

    left = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while left:
        cur = left.pop()
        while key(cur[0]) != key(cur[-1]):
            for i, w in enumerate(left):
                if key(w[0]) == key(cur[-1]):
                    cur += w[1:]
                elif key(w[-1]) == key(cur[-1]):
                    cur += w[-2::-1]
                elif key(w[-1]) == key(cur[0]):
                    cur = w[:-1] + cur
                elif key(w[0]) == key(cur[0]):
                    cur = w[:0:-1] + cur
                else:
                    continue
                left.pop(i)
                break
            else:
                break           # оборванная цепочка — замкнём как есть
        if len(cur) >= 3:
            rings.append(cur)
    return rings


def osm_rings(bbox, cache, name, selectors, pad=0.02):
    """Кольца одного слоя OSM: список (точки, дырка ли) в порядке отрисовки.

    Мультиполигоны OSM приходят отношениями с ролями outer/inner — острова и
    поляны это именно inner. Порядок важен: сначала внешние кольца отношения,
    потом его дырки, иначе остров зальётся обратно.
    """
    box = "(%f,%f,%f,%f)" % (bbox["south"] - pad, bbox["west"] - pad,
                             bbox["north"] + pad, bbox["east"] + pad)
    body = "".join("  %s%s%s;\n" % (kind, sel, box)
                   for sel in selectors for kind in ("way", "relation"))
    q = "[out:json][timeout:300];\n(\n%s);\nout geom;" % body
    path = os.path.join(cache, name + ".json")

    def fetch():
        last = None
        for url in OVERPASS:
            try:
                body = urllib.parse.urlencode({"data": q}).encode()
                req = urllib.request.Request(
                    url, data=body,
                    headers={"User-Agent": "sv20-terrain/1.0"})
                with urllib.request.urlopen(req, timeout=300) as r:
                    blob = r.read()
                json.loads(blob)  # обрыв на середине выглядит как успех
                return blob
            except Exception as e:  # noqa: BLE001
                last = e
        raise RuntimeError("Overpass не ответил ни на одном зеркале: %s" % last)

    data = json.loads(_cached(path, fetch))
    els = data["elements"]

    in_rel = set()
    for e in els:
        if e["type"] == "relation":
            for m in e["members"]:
                if m["type"] == "way":
                    in_rel.add(m["ref"])

    rings = []
    for e in els:
        if e["type"] != "relation":
            continue
        for role in ("outer", "inner"):
            segs = [[(g["lat"], g["lon"]) for g in m["geometry"]]
                    for m in e["members"]
                    if m.get("role") == role and m.get("geometry")]
            for r in _stitch(segs):
                rings.append((r, role == "inner"))
    for e in els:
        if e["type"] == "way" and e["id"] not in in_rel and e.get("geometry"):
            rings.append(([(g["lat"], g["lon"]) for g in e["geometry"]], False))

    return rings


# ---------------------------------------------------------------------------
# Сборка карты
# ---------------------------------------------------------------------------

SUPERSAMPLE = 3       # во столько раз мельче растрируется маска до усреднения
DEPTH_MAX = 6.0       # м, глубина, дальше которой условное дно не углубляется
DEPTH_SLOPE = 0.06    # уклон условного дна от уреза
FREEBOARD = 0.4       # м, на столько суша поднимается над урезом, если ниже

# Наименьшая высота крон и кварталов над землёй. Числа грубые и такими
# задуманы: от леса нужен силуэт, а не таксация. Восемнадцать метров — обычный
# спелый сосняк и ельник средней полосы; десять — застройка вперемешку, от
# частного сектора до пятиэтажек. Это именно минимум: где DSM видит больше,
# берётся измеренное, и городские высотки остаются высотками.
FOREST_H = 18.0
URBAN_H = 10.0

# Потолки высоты слоя, м. Общий — шестьдесят три: не круглое число, а всё, что
# влезает в шесть бит, потому что слой упакован в тот же байт, что и его класс.
#
# Лесу потолок ниже, и по делу. Измеренная часть берётся от подставленной
# земли, а на крутом склоне подставлять её приходится издалека — от подножия,
# если лес занимает весь косогор, — и разница выходит не высотой дерева, а
# высотой склона. Без потолка на бровке откоса вырастает полоса
# шестидесятиметровых сосен. Тридцать пять метров — предел для здешних пород, и
# он отрезает ровно этот случай: под него попадает две десятых процента лесных
# ячеек, все на кромках.
FOREST_MAX = 35.0
URBAN_MAX = 63.0

# Окно сглаживания подставленной земли, м. Подстановка идёт по ближайшей
# открытой ячейке и потому ступенчата; сотни метров хватает, чтобы ступеньки
# ушли, а форма склона осталась.
GROUND_WIN_M = 100.0


def build(bbox, step, cache, level=None):
    """Собрать карту участка на метрической сетке с шагом `step` метров."""
    lat0 = 0.5 * (bbox["south"] + bbox["north"])
    lon0 = 0.5 * (bbox["west"] + bbox["east"])
    fr = Frame(lat0, lon0)

    x0, y0 = fr.xy(bbox["south"], bbox["west"])
    x1, y1 = fr.xy(bbox["north"], bbox["east"])
    nx = int(round((x1 - x0) / step)) + 1
    ny = int(round((y1 - y0) / step)) + 1
    xs = x0 + step * np.arange(nx)
    ys = y0 + step * np.arange(ny)

    # --- рельеф: билинейная выборка DEM в узлы метрической сетки
    dem, dlats, dlons = dem_window(bbox, cache)
    if np.isnan(dem).any():
        dem = np.nan_to_num(dem, nan=float(np.nanmedian(dem)))

    glat = fr.lat(ys)[:, None] + 0 * xs[None, :]
    glon = fr.lon(xs)[None, :] + 0 * ys[:, None]
    fr_r = (glat - dlats[0]) / (dlats[1] - dlats[0])
    fr_c = (glon - dlons[0]) / (dlons[1] - dlons[0])
    h = ndimage.map_coordinates(dem, [fr_r, fr_c], order=1, mode="nearest")

    # --- слои OSM: полигоны растрируются мельче сетки и усредняются, чтобы у
    # границы получилось не «да/нет», а доля ячейки
    ss = SUPERSAMPLE

    def rasterize(rings):
        img = Image.new("L", (nx * ss, ny * ss), 0)
        dr = ImageDraw.Draw(img)
        for pts, hole in rings:
            if len(pts) < 3:
                continue
            px = []
            for la, lo in pts:
                x, y = fr.xy(la, lo)
                px.append(((x - x0) / step * ss, (y - y0) / step * ss))
            dr.polygon(px, fill=0 if hole else 255)
        # Строка растра растёт вместе с Y, потому что в него так и рисовали: он
        # здесь не картинка, а та же метрическая сетка, только мельче.
        # Переворота быть не должно — с ним маска садится зеркально по широте,
        # ложится на чужой рельеф, и урез уезжает на два десятка метров.
        return np.asarray(img, np.float32).reshape(
            ny, ss, nx, ss).mean((1, 3)) / 255.0

    cov = rasterize(osm_rings(bbox, cache, "water", WATER_SEL))

    wet = cov > 0.5
    if not wet.any():
        raise RuntimeError("в участке не нашлось воды — проверь bbox")

    # --- урез. Медиана DEM по воде устойчивее среднего: в маску попадают
    # мосты и суда, которые DEM видит как высокие точки над рекой.
    if level is None:
        level = float(np.median(h[wet]))

    # --- лес и застройка.
    #
    # Нужны они ради силуэта берега: с воды берег читается не рельефом, а стеной
    # леса и гребёнкой кварталов над ним, и без них высокий правый берег
    # выглядит голым косогором, каким он не бывает.
    #
    # Слой отдаётся отдельно от рельефа — классом и высотой на ячейку, — а не
    # вминается в высоты. Рельеф тогда остаётся рельефом: по нему можно считать
    # уклон, урез и ветровую тень, не гадая, где холм, а где сосняк на холме. И
    # выключить лес на просмотре можно, не пересобирая выгрузку.
    #
    # Тонкость, из-за которой это не сводится к «взять высоту по маске».
    # Copernicus DEM — это DSM, поверхность отражения: кроны и крыши в нём УЖЕ
    # есть. Если оставить рельеф как он есть и положить сверху ещё и слой, лес
    # посчитается дважды. Значит землю надо из DSM достать.
    #
    # Первым делом здесь стояло размыкание — эрозия окном в сто метров, потом
    # наращивание. Классический приём, и он не сработал: в сплошном массиве
    # окно ни в одной точке не дотягивается до открытой земли, и размыкание
    # вырождается в тождество. Замеры это показали сразу — высота слоя выходила
    # ровно паспортной, среднее 18.0 при медиане 18.0, то есть измеренная часть
    # не давала ничего, а рельеф при этом терял по семь метров на гребнях,
    # которые окно всё-таки успевало сточить.
    #
    # Работает другое: земли под массивом никто не мерил, и честно взять её
    # неоткуда, кроме как от ближайшей открытой. Подстановка по ближайшему
    # соседу, сглаживание, ограничение сверху самим DSM — земля не может быть
    # выше поверхности. Разница уходит в высоту слоя, и городские высотки
    # становятся высотками, потому что теперь есть от чего их мерить.
    urban = rasterize(osm_rings(bbox, cache, "urban", URBAN_SEL)) > 0.5
    forest = rasterize(osm_rings(bbox, cache, "forest", FOREST_SEL)) > 0.5

    # Вода главнее любого слоя суши: полигоны кварталов в OSM нередко нарезаны
    # по осям улиц и заходят на затоны и гребной канал.
    urban &= ~wet
    forest &= ~wet
    urban &= ~forest

    cls = np.zeros((ny, nx), np.uint8)
    cls[urban] = 2
    cls[forest] = 1

    covered = cls > 0
    win = max(3, int(round(GROUND_WIN_M / step)) | 1)
    src = ndimage.distance_transform_edt(
        covered, return_distances=False, return_indices=True)
    ground = ndimage.uniform_filter(h[tuple(src)], size=win, mode="nearest")
    ground = np.minimum(ground, h)

    floor = np.where(forest, FOREST_H, np.where(urban, URBAN_H, 0.0))
    ceil = np.where(forest, FOREST_MAX, np.where(urban, URBAN_MAX, 0.0))
    cover_h = np.where(covered,
                       np.minimum(np.maximum(floor, h - ground), ceil), 0.0)
    h = np.where(covered, ground, h)

    # --- условное дно: откос от берега до потолка глубины. Промера нет, и
    # выдавать это за глубины нельзя; нужно оно ровно затем, чтобы у воды был
    # низ, а у мели — положение.
    dist = ndimage.distance_transform_edt(wet) * step
    depth = np.minimum(DEPTH_MAX, dist * DEPTH_SLOPE)

    h = np.where(wet, level - depth, np.maximum(h, level + FREEBOARD))
    cover_h = np.where(wet, 0.0, cover_h)

    # Две приметные точки для просмотра. Середина самого широкого плёса — та,
    # что дальше всего от любого берега; вставать на воду надо там, иначе
    # взгляд с высоты глаза упирается в ближний куст. Высшая точка нужна,
    # чтобы сразу развернуть взгляд на высокий берег, ради которого всё и
    # затевалось.
    #
    # Расстояние здесь считается по своему, с закрытой рамкой: у преобразования
    # выше край массива берегом не считается, и река, уходящая за границу
    # квадрата, получает у самого края бесконечную ширину. Самым широким плёсом
    # тогда объявляется угол картинки. Для откоса дна такая рамка была бы
    # враньём — фальшивой отмелью поперёк русла, — поэтому счёт отдельный.
    inner = np.zeros((ny + 2, nx + 2), bool)
    inner[1:-1, 1:-1] = wet
    dist_in = ndimage.distance_transform_edt(inner)[1:-1, 1:-1] * step
    iy, ix = np.unravel_index(np.argmax(dist_in), dist_in.shape)
    open_water = [float(xs[ix]), float(ys[iy])]
    # Высшая точка — по верху слоя, а не по земле: взгляд с воды разворачивают
    # на то, что видно, а видно кроны и крыши.
    top = h + cover_h
    iy, ix = np.unravel_index(np.argmax(top), top.shape)
    high_point = [float(xs[ix]), float(ys[iy])]

    return {
        "bbox": bbox,
        "origin": {"lat": lat0, "lon": lon0},
        "meters_per_deg": {"lat": fr.m_lat, "lon": fr.m_lon},
        "step": step,
        "nx": nx, "ny": ny,
        "size": [(nx - 1) * step, (ny - 1) * step],
        "level": level,
        "hmin": float(h.min()), "hmax": float(h.max()),
        "top_max": float(top.max()),
        "water_fraction": float(wet.mean()),
        "forest_fraction": float(forest.mean()),
        "urban_fraction": float(urban.mean()),
        "cover_min_m": {"forest": FOREST_H, "urban": URBAN_H},
        "cover_max_m": float(cover_h.max()),
        "open_water": open_water,
        "widest_m": float(2 * dist_in.max()),
        "high_point": high_point,
        "attribution": list(ATTRIBUTION),
        "height": h.astype(np.float32),
        "water": cov.astype(np.float32),
        "cover_class": cls,
        "cover_height": cover_h.astype(np.float32),
    }
