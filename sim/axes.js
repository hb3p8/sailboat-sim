// Оси: единственное место, где мир и связанные с лодкой величины становятся
// координатами сцены.
//
// Мир физики (X на восток, Y на север, Z вверх) переводится в правую сцену
// three без зеркала: (x, y, z) -> (x, z, -y). Все связанные знаки живут здесь
// и проверяются вместе в tests/axes.test.mjs.

// --- мир <-> сцена -----------------------------------------------------------

export function toSceneX(x) { return x; }
export function toSceneZ(y) { return -y; }
export function toWorldX(x) { return x; }
export function toWorldY(z) { return -z; }

// Направление в горизонтальной плоскости переводится тем же отображением, что
// и точка, но без начала отсчёта.
export function dirSceneX(angle) { return Math.cos(angle); }
export function dirSceneZ(angle) { return -Math.sin(angle); }

// --- повороты вокруг осей сцены ---------------------------------------------

export function headingRotY(psi) { return psi; }
export function windRotY(dir) { return dir - Math.PI; }
export function heelRotX(phi) { return phi; }
export function rudderRotY(deflect) { return deflect; }

// --- орты лодки в сцене -----------------------------------------------------

export function bowSceneX(psi) { return Math.cos(psi); }
export function bowSceneZ(psi) { return -Math.sin(psi); }
export function stbdSceneX(psi) { return Math.sin(psi); }
export function stbdSceneZ(psi) { return Math.cos(psi); }

// Ось Y лодки смотрит влево, локальная Z модели — вправо. Поэтому и касательная
// решётки, и записываемая точка меняют знак только на выходе в геометрию.
export function bodyDirLocalX(x) { return x; }
export function bodyDirLocalY(z) { return z; }
export function bodyDirLocalZ(y) { return -y; }
export function bodyPointLocalX(x) { return x; }
export function bodyPointLocalY(z) { return z; }
export function bodyPointLocalZ(y) { return -y; }

// Бортовые величины, не являющиеся геометрическими векторами.
export function rigSideZ(side) { return -side; }
export function roseSide(awaAngle) { return awaAngle > 0 ? -1 : 1; }
