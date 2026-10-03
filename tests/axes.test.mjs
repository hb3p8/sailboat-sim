// Геометрический замок осей. Здесь проверяется не правдоподобие картинки, а
// один общий контракт между миром, сценой, моделью лодки, ригом и приборами.

import assert from 'node:assert/strict';
import { Euler, Matrix4, Vector3 } from '../viewer/vendor/three.webgpu.js';
import { Buoyancy } from '../sim/buoyancy.js';
import {
  toSceneX, toSceneZ, toWorldX, toWorldY,
  dirSceneX, dirSceneZ,
  headingRotY, windRotY, heelRotX, rudderRotY,
  bowSceneX, bowSceneZ, stbdSceneX, stbdSceneZ,
  pitchRotZ, heaveY,
  bodyDirLocalX, bodyDirLocalY, bodyDirLocalZ,
  bodyPointLocalX, bodyPointLocalY, bodyPointLocalZ,
  rigSideZ, roseSide,
  BOAT_SCENE_ORDER, boatBodyRotation,
} from '../sim/axes.js';

const EPS = 1e-12;
const near = (a, b, message) =>
  assert.ok(Math.abs(a - b) < EPS, `${message}: ${a} != ${b}`);
const pair = (got, want, message) => {
  near(got[0], want[0], `${message}, X`);
  near(got[1], want[1], `${message}, Z`);
};

// В three вращение локального +X вокруг Y на угол a даёт (cos a, -sin a).
const rotatedLocalX = a => [Math.cos(a), -Math.sin(a)];
const sceneDir = a => [toSceneX(Math.cos(a)), toSceneZ(Math.sin(a))];

console.log('\nОси мира и сцены\n');

// Полный перевод (world X,Y,Z -> scene X,Y,Z) обязан сохранять ориентацию.
// E x N = Up и после перевода: (1,0,0) x (0,0,-1) = (0,1,0).
const east = [toSceneX(1), 0, toSceneZ(0)];
const north = [toSceneX(0), 0, toSceneZ(1)];
const up = [0, 1, 0];
const cross = [
  east[1] * north[2] - east[2] * north[1],
  east[2] * north[0] - east[0] * north[2],
  east[0] * north[1] - east[1] * north[0],
];
assert.deepEqual(cross, up, 'перевод мира должен иметь определитель +1');

for (const [x, y] of [[0, 0], [3, -7], [-11.5, 2.25]]) {
  near(toWorldX(toSceneX(x)), x, 'обратный перевод X');
  near(toWorldY(toSceneZ(y)), y, 'обратный перевод Y');
}

for (const psi of [0, Math.PI / 6, Math.PI / 2, -2.1, Math.PI]) {
  const bow = sceneDir(psi);
  pair([bowSceneX(psi), bowSceneZ(psi)], bow, 'нос смотрит по курсу');
  pair(rotatedLocalX(headingRotY(psi)), bow, 'поворот модели совпадает с курсом');

  const rightWorld = psi - Math.PI / 2;
  pair([stbdSceneX(psi), stbdSceneZ(psi)], sceneDir(rightWorld),
       'правый борт есть курс минус 90°');
}

for (const dir of [0, Math.PI / 3, Math.PI, -Math.PI / 2]) {
  // Стрелка сделана вдоль локального +X и показывает КУДА дует.
  pair(rotatedLocalX(windRotY(dir)), sceneDir(dir + Math.PI),
       'стрелка ветра показывает по потоку');
  pair([dirSceneX(dir), dirSceneZ(dir)], sceneDir(dir),
       'направление волны переводится как вектор мира');
}

console.log('  ok    мир переводится без зеркала');
console.log('  ok    курс, правый борт и стрелка ветра согласованы');

console.log('\nЗамок лодки\n');

// Положительная Y решётки — левый борт; локальная +Z модели — правый.
assert.equal(bodyDirLocalZ(1), -1, 'касательная решётки меняет борт');
assert.equal(bodyPointLocalZ(1), -1, 'точка решётки меняет борт');
assert.equal(bodyDirLocalX(2), 2);
assert.equal(bodyDirLocalY(3), 3);
assert.equal(bodyPointLocalX(2), 2);
assert.equal(bodyPointLocalY(3), 3);

for (const awa of [-1.2, -0.2, 0.2, 1.2]) {
  const physicsRigSide = awa > 0 ? 1 : -1;
  assert.equal(rigSideZ(physicsRigSide), roseSide(awa),
    'риг, роза и измеренный борт решётки должны показывать одну сторону');
  assert.equal(rigSideZ(physicsRigSide), bodyPointLocalZ(physicsRigSide),
    'нарисованный парус должен стоять на той же стороне, что решётка');
}

// Крен проверяется точкой, а не самим знаком. Физика вращает (Y влево, Z вверх)
// вокруг +X; модель хранит ту же точку как (Y вверх, Z вправо = -Y физики).
// После обоих преобразований координаты обязаны совпасть.
for (const phi of [-0.4, -0.1, 0.2, 0.55]) {
  const bodyY = 1.3, bodyZ = 4.7;
  const c = Math.cos(phi), s = Math.sin(phi);
  const rolledBodyY = c * bodyY - s * bodyZ;
  const rolledBodyZ = s * bodyY + c * bodyZ;

  const localY = bodyPointLocalY(bodyZ);
  const localZ = bodyPointLocalZ(bodyY);
  const a = heelRotX(phi), ca = Math.cos(a), sa = Math.sin(a);
  const rolledLocalY = ca * localY - sa * localZ;
  const rolledLocalZ = sa * localY + ca * localZ;
  near(rolledLocalY, bodyPointLocalY(rolledBodyZ), 'высота точки после крена');
  near(rolledLocalZ, bodyPointLocalZ(rolledBodyY), 'борт точки после крена');
}

// Дифферент проверяется точкой, как и крен: нос обязан подниматься, корма
// опускаться, и обе — на ту же величину, что дал бы поворот в физике.
for (const th of [-0.09, -0.02, 0.03, 0.11]) {
  const bowX = 3.2, sternX = -1.4;
  const a = pitchRotZ(th), ca = Math.cos(a), sa = Math.sin(a);
  // Поворот локального (X в нос, Y вверх) вокруг Z: x' = x c - y s, y' = x s + y c.
  near(bowX * sa, bowX * Math.sin(th), 'нос поднимается на дифференте');
  assert.ok(bowX * sa > 0 === th > 0, 'плюс дифферента поднимает нос');
  assert.ok(sternX * sa < 0 === th > 0, 'и опускает корму');
  near(ca, Math.cos(th), 'дифферент не меняет длину');
}
for (const zc of [-0.4, 0, 0.25]) near(heaveY(zc), zc, 'всплытие переводится как есть');
console.log('  ok    дифферент поднимает нос, всплытие переводится без знака');

// Независимое последовательное вращение: порядок не выводится из матрицы
// проверяемого помощника или из соглашения Euler в three.
const sequential = ([x, y, z], psi, phi, th) => {
  const yr = Math.cos(phi) * y - Math.sin(phi) * z;
  const zr = Math.sin(phi) * y + Math.cos(phi) * z;
  const xp = Math.cos(th) * x - Math.sin(th) * zr;
  return [Math.cos(psi) * xp - Math.sin(psi) * yr,
          Math.sin(psi) * xp + Math.cos(psi) * yr,
          Math.sin(th) * x + Math.cos(th) * zr];
};
let combinedCases = 0;
for (const psi of [0, 0.7, -2.2]) for (const phi of [0, -0.45, 0.6])
for (const th of [0, -0.13, 0.24]) {
  const r = boatBodyRotation(psi, phi, th);
  const scene = new Matrix4().makeRotationFromEuler(new Euler(
    heelRotX(phi), headingRotY(psi), pitchRotZ(th), BOAT_SCENE_ORDER));
  for (const p of [[0, 0, 0], [4.6, 1.3, -0.7], [1.2, -2.3, 6.1],
                   [1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const want = sequential(p, psi, phi, th);
    const mapped = [0, 1, 2].map(d => r[3*d]*p[0]+r[3*d+1]*p[1]+r[3*d+2]*p[2]);
    const drawn = new Vector3(p[0], p[2], -p[1]).applyMatrix4(scene);
    const world = [drawn.x, -drawn.z, drawn.y];
    for (let d = 0; d < 3; d++) {
      near(mapped[d], want[d], 'матрица физики совпадает с последовательным вращением');
      near(world[d], want[d], 'three совпадает с физикой при всех трёх углах');
    }
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    near([0,1,2].reduce((s,d) => s+r[3*d+i]*r[3*d+j], 0), i===j?1:0,
      'составной поворот сохраняет длины и углы');
  // Призма 2×2×4; вода пересекает обе боковые грани каждого сечения.
  // Площадь и первый момент по Y получены прямым интегрированием линии воды.
  const poly = [[-1,-2],[1,-2],[1,2],[-1,2]];
  const buoy = new Buoyancy({sections:{x_m:[-1,0,1],poly:[poly,poly,poly]}});
  const zc = 0.15, hyd = buoy.at(zc, phi, th);
  for (let i = 0; i < 3; i++) {
    const height = (-zc-r[6]*buoy.xs[i])/r[8];
    near(buoy.area[i], 2*(2+height), 'площадь погружённого сечения по мировой вертикали');
    near(buoy.area[i]*buoy.cy[i], -2*r[7]/(3*r[8]), 'первый момент сечения по Y');
  }
  near(hyd.volume, 4*(2-zc/r[8]), 'известный объём призмы при крене и дифференте');
  combinedCases++;
}
assert.throws(() => boatBodyRotation(0, NaN, 0), /конечными/);
console.log(`  ok    ${combinedCases} сочетаний курса/крена/дифферента: three, матрица и погружение`);

// Положительное отклонение пера направляет его хорду в +Y физики (влево).
// В модели это -Z; положительный поворот three вокруг Y как раз ведёт +X в -Z.
for (const deflect of [-0.45, -0.12, 0.18, 0.5]) {
  pair(rotatedLocalX(rudderRotY(deflect)),
       [bodyDirLocalX(Math.cos(deflect)), bodyDirLocalZ(Math.sin(deflect))],
       'нарисованное перо совпадает с отклонением в физике');
}

// Линия тока интегрируется в осях лодки, а преобразуется только результат.
// Поэтому расстояние до центра парусности и касательная обязаны сохраниться.
const ce = [1.4, 0.0, 4.8];
const bodyPoint = [4.1, 2.3, 5.6];
const bodyTangent = [0.8, -0.5, 0.2];
const localCe = [bodyPointLocalX(ce[0]), bodyPointLocalY(ce[2]), bodyPointLocalZ(ce[1])];
const localPoint = [
  bodyPointLocalX(bodyPoint[0]),
  bodyPointLocalY(bodyPoint[2]),
  bodyPointLocalZ(bodyPoint[1]),
];
const bodyDistance = Math.hypot(
  bodyPoint[0] - ce[0], bodyPoint[1] - ce[1], bodyPoint[2] - ce[2]);
const localDistance = Math.hypot(
  localPoint[0] - localCe[0], localPoint[1] - localCe[1], localPoint[2] - localCe[2]);
near(localDistance, bodyDistance, 'расстояние линии тока до центра парусности');

const ds = 0.17;
const nextBody = bodyPoint.map((v, i) => v + bodyTangent[i] * ds);
const nextLocal = [
  bodyPointLocalX(nextBody[0]),
  bodyPointLocalY(nextBody[2]),
  bodyPointLocalZ(nextBody[1]),
];
const localTangent = [
  bodyDirLocalX(bodyTangent[0]),
  bodyDirLocalY(bodyTangent[2]),
  bodyDirLocalZ(bodyTangent[1]),
];
for (let i = 0; i < 3; i++)
  near(nextLocal[i] - localPoint[i], localTangent[i] * ds,
       'касательная линии тока согласована с точками');

console.log('  ok    парус, крен, ветер, роза и решётка замкнуты');
console.log('  ok    линии тока сохраняют расстояние до центра парусности');
console.log('\nВсе проверки осей пройдены.\n');
