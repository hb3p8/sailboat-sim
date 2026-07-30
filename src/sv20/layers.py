"""Ф0, шаг 3: раскладка полилиний по видам чертежа.

Лист содержит три наложенных друг на друга изображения — вид сверху, вид сбоку
и план парусности, — поэтому разложить их одной горизонтальной нарезкой нельзя:
линии такелажа проходят сквозь вид сверху. Критерий здесь другой: путь
относится к виду, если он целиком помещается в габарит этого вида. Всё, что
пересекает границу, — это заведомо рангоут или выноска, и оно уходит в
отдельные группы.

Раскладка сознательно грубая. Её задача — не разметить каждую линию, а
отделить корпус от всего остального и честно показать, сколько путей осталось
неразобранными.
"""

MARGIN = 0.5  # пункты


class Views(object):
    def __init__(self, plan_box, profile_box, title_box):
        self.plan_box = plan_box
        self.profile_box = profile_box
        self.title_box = title_box

    def to_dict(self):
        return {"plan_box_pt": self.plan_box,
                "profile_box_pt": self.profile_box,
                "title_box_pt": self.title_box}


def _inside(sp, box, margin=MARGIN):
    x0, y0, x1, y1 = box
    return all(x0 - margin <= p[0] <= x1 + margin and y0 - margin <= p[1] <= y1 + margin
               for p in sp.points)


def _overlaps(sp, box):
    x0, y0, x1, y1 = box
    bx0, by0, bx1, by1 = sp.bbox
    return not (bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1)


def make_views(datum, key, media_box):
    """Габариты видов, выведенные из уже найденных опорных элементов."""
    deck = key["deck_starboard"]
    port = key["deck_port"]
    sheer = key["sheer_profile"]

    plan_box = (deck.bbox[0], port.bbox[1], deck.bbox[2], deck.bbox[3])
    profile_box = (datum.x_ap, datum.y_dwl,
                   datum.x_fp, max(p[1] for p in sheer.points))

    # штамп — правый нижний угол листа
    mx0, my0, mx1, my1 = media_box
    title_box = (mx0 + 0.68 * (mx1 - mx0), my0, mx1, my0 + 0.08 * (my1 - my0))

    return Views(plan_box, profile_box, title_box)


def classify(subpaths, views, key, deck_headroom=25.0):
    """Разложить пути по группам. Возвращает dict имя -> список Subpath.

    `deck_headroom` — запас над линией борта (в пунктах), в котором ещё живут
    палубные детали вида сбоку: комингсы, крыша рубки, погоны. Выше начинается
    рангоут.
    """
    px0, py0, px1, py1 = views.profile_box
    profile_ext = (px0, py0, px1, py1 + deck_headroom)

    outline_pts = key["profile_outline"]

    groups = {
        "hull_outline": [],   # прослеженный контур корпуса на виде сбоку
        "deck_line": [],      # линия борта на виде сверху, обе половины
        "plan": [],           # прочее на виде сверху
        "profile": [],        # прочее на виде сбоку, включая палубные детали
        "sailplan": [],       # паруса и рангоут — та же ДП, просто выше по листу
        "rig": [],            # такелаж и выноски, пересекающие границы видов
        "title": [],          # штамп и рамка листа
        "other": [],
    }

    named = {id(key["deck_starboard"]), id(key["deck_port"]), id(key["sheer_profile"])}

    for sp in subpaths:
        if id(sp) in named:
            groups["deck_line" if sp is not key["sheer_profile"] else "hull_outline"].append(sp)
            continue
        if _inside(sp, views.title_box):
            groups["title"].append(sp)
        elif _inside(sp, views.plan_box):
            groups["plan"].append(sp)
        elif _inside(sp, profile_ext):
            groups["profile"].append(sp)
        elif _overlaps(sp, views.plan_box) or _overlaps(sp, profile_ext):
            groups["rig"].append(sp)
        elif px0 - MARGIN <= sp.bbox[0] and sp.bbox[2] <= px1 + MARGIN and sp.bbox[1] >= py0:
            # мачта высотой девять метров не помещается в габарит вида сбоку и
            # уходит вверх по листу — но лежит в той же ДП и в тех же абсциссах
            groups["sailplan"].append(sp)
        else:
            groups["other"].append(sp)

    # контур корпуса вынимаем из «прочего на виде сбоку»: он уже прослежен
    traced = set()
    for chain in outline_pts.values():
        traced.update((round(p[0], 4), round(p[1], 4)) for p in chain)
    keep = []
    for sp in groups["profile"]:
        pts = set((round(p[0], 4), round(p[1], 4)) for p in sp.points)
        if pts and pts <= traced:
            groups["hull_outline"].append(sp)
        else:
            keep.append(sp)
    groups["profile"] = keep

    return groups


def summary(groups):
    return dict((name, {"paths": len(items),
                        "points": sum(len(s.points) for s in items)})
                for name, items in groups.items())
