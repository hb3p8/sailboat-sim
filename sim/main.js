// Симулятор управления SV20: сцена, ввод, цикл.
//
// Физика идёт фиксированным шагом 1/30 с и не зависит от частоты кадров;
// отрисовка интерполирует между шагами. Так поведение лодки одинаково и на
// шестидесяти герцах, и на просевших тридцати.
//
// Мировая система здесь — трёхмерная система three (Y вверх). Физика живёт в
// судостроительной (Z вверх), перевод только на границе: three = (x, z, −y).

const D = Math.PI / 180;
const HZ = 30;
const DT = 1 / HZ;

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');

const scene = new Scene();
scene.fog = new Fog(new Color(0x9fb8cc), 60, 900);
const camera = new PerspectiveCamera(55, 1, 0.2, 3000);
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x9fb8cc);
stage.appendChild(renderer.domElement);

scene.add(new HemisphereLight(0xdff0ff, 0x2a4058, 2.2));
const sun = new DirectionalLight(0xfff4e0, 2.4);
sun.position.set(-60, 90, 40);
scene.add(sun);

// ------------------------------------------------------------------- вода

const SEA = 420, SEG = 96;
const seaGeo = new PlaneGeometry(SEA, SEA, SEG, SEG);
seaGeo.rotateX(-Math.PI / 2);
const sea = new Mesh(seaGeo, new MeshStandardMaterial({
  color: 0x2f5f80, roughness: 0.35, metalness: 0.05, flatShading: false,
}));
scene.add(sea);
const seaBase = seaGeo.attributes.position.array.slice();

// Волны нужны только глазу: на силы они не влияют, поэтому это простая сумма
// синусов, а не спектр. Их задача — дать чувство хода и направления ветра.
function waveHeight(x, z, t, dirX, dirZ) {
  const a = Math.sin((x * dirX + z * dirZ) * 0.22 + t * 1.1);
  const b = Math.sin((x * dirZ - z * dirX) * 0.13 - t * 0.7);
  const c = Math.sin((x * dirX + z * dirZ) * 0.55 + t * 2.3);
  return 0.16 * a + 0.10 * b + 0.05 * c;
}

// ------------------------------------------------------------------- лодка

const boatGroup = new Group();
scene.add(boatGroup);

function meshFrom(data, colour, rough) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(data.positions, 3));
  g.setIndex(data.indices);
  g.computeVertexNormals();
  return new Mesh(g, new MeshStandardMaterial({
    color: new Color(colour), roughness: rough == null ? 0.45 : rough,
    metalness: 0.05, side: DoubleSide,
  }));
}

const hullMesh = meshFrom(MESH.hull, 0xeef2f5, 0.35);
const finMesh = meshFrom(MESH.keel_fin, 0x6b7681);
const bulbMesh = meshFrom(MESH.bulb, 0x8d7340, 0.4);
const rudderMesh = meshFrom(MESH.rudder, 0x6b7681);
boatGroup.add(hullMesh, finMesh, bulbMesh);

// руль поворачивается вокруг снятой с чертежа оси баллера
const rudderPivot = new Group();
const stockX = PACK.foils.rudder.x_m;
rudderMesh.position.set(-stockX, 0, 0);
rudderPivot.position.set(stockX, 0, 0);
rudderPivot.add(rudderMesh);
boatGroup.add(rudderPivot);

// --- паруса: плоские, но с настоящим углом выноса ---------------------------

function sailMesh(colour) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(9 * 3), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  return new Mesh(g, new MeshStandardMaterial({
    color: new Color(colour), roughness: 0.85, side: DoubleSide,
    transparent: true, opacity: 0.95,
  }));
}
const main = sailMesh(0xf2f4f6);
const jib = sailMesh(0xe6ebef);
const mastPivot = new Group();
mastPivot.add(main, jib);
boatGroup.add(mastPivot);

const rig = PACK.rig;
const mast = new Mesh(
  new CylinderGeometry(0.045, 0.055, rig.mast_height_m, 8),
  new MeshStandardMaterial({ color: 0xb9c2ca, roughness: 0.4, metalness: 0.5 }));
mast.position.set(rig.mast_x_m, rig.mast_height_m / 2 + 0.6, 0);
boatGroup.add(mast);

function shapeSails(sheet, side) {
  // side = +1 ветер справа, парус уходит влево (в три — в +Z)
  const s = sheet * side;
  const foot = 2.9, head = rig.mast_height_m * 0.96, tack = rig.mast_x_m;
  const put = (mesh, pts) => {
    const a = mesh.geometry.attributes.position.array;
    for (let i = 0; i < pts.length; i++) {
      a[i * 3] = pts[i][0]; a[i * 3 + 1] = pts[i][1]; a[i * 3 + 2] = pts[i][2];
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  };
  const belly = 0.35;
  put(main, [
    [tack, 0.75, 0],
    [tack, head, 0],
    [tack - foot * Math.cos(s) * 0.55, head * 0.55,
      foot * Math.sin(s) * 0.55 + belly * 0.5],
    [tack - foot * Math.cos(s) * 0.85, head * 0.22,
      foot * Math.sin(s) * 0.85 + belly],
    [tack - foot * Math.cos(s), 0.95, foot * Math.sin(s)],
  ]);
  const jt = rig.mast_x_m + 2.35, jh = rig.mast_height_m * 0.78;
  const jfoot = 2.0, js = s * 0.65;
  put(jib, [
    [jt, 0.85, 0],
    [rig.mast_x_m + 0.15, jh, 0],
    [rig.mast_x_m + 0.9 - jfoot * Math.cos(js) * 0.5, jh * 0.5,
      jfoot * Math.sin(js) * 0.5 + belly * 0.4],
    [rig.mast_x_m + 0.9 - jfoot * Math.cos(js) * 0.8, jh * 0.22,
      jfoot * Math.sin(js) * 0.8 + belly * 0.6],
    [rig.mast_x_m + 0.9 - jfoot * Math.cos(js), 1.0, jfoot * Math.sin(js)],
  ]);
}

// --------------------------------------------------------------- указатель

const arrow = new Group();
const shaft = new Mesh(new CylinderGeometry(0.06, 0.06, 2.4, 8),
  new MeshBasicMaterial({ color: 0xffcf5a }));
shaft.rotation.z = Math.PI / 2;
const tip = new Mesh(new ConeGeometry(0.2, 0.6, 10),
  new MeshBasicMaterial({ color: 0xffcf5a }));
tip.rotation.z = -Math.PI / 2;
tip.position.x = 1.5;
arrow.add(shaft, tip);
scene.add(arrow);

// ---------------------------------------------------------------- ввод

const boat = new Boat(PACK);
const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code))
    e.preventDefault();
  if (e.code === 'KeyR') boat.reset();
});
addEventListener('keyup', e => { keys[e.code] = false; });

const ui = {};
for (const id of ['wind', 'winddir', 'hike', 'sailscale', 'cam']) {
  const el = document.getElementById(id);
  if (el) ui[id] = el;
}

function readControls(dt) {
  const o = boat.o;
  const rate = 45 * D;                      // скорость перекладки руля
  let target = 0;
  if (keys.ArrowLeft || keys.KeyA) target = -35 * D;
  if (keys.ArrowRight || keys.KeyD) target = 35 * D;
  o.rudder += Math.max(-rate * dt, Math.min(rate * dt, target - o.rudder));
  if (!target) o.rudder *= Math.pow(0.02, dt);   // руль сам идёт в ДП

  const sr = 30 * D;
  if (keys.ArrowUp || keys.KeyW) o.sheet -= sr * dt;
  if (keys.ArrowDown || keys.KeyS) o.sheet += sr * dt;
  o.sheet = Math.max(2 * D, Math.min(90 * D, o.sheet));

  o.windSpeed = parseFloat(ui.wind.value);
  o.windDir = parseFloat(ui.winddir.value) * D;
  o.crewHike = parseFloat(ui.hike.value);
  o.crewMass = o.crewHike > 0 ? 240 : 0;
  o.sailScale = parseFloat(ui.sailscale.value);
}

// ---------------------------------------------------------------- цикл

let acc = 0, last = performance.now() / 1000;
const camPos = new Vector3(-12, 5, 0);
const prev = { x: 0, y: 0, psi: 0, phi: 0 };

function resize() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, true);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

function frame() {
  const now = performance.now() / 1000;
  let dt = Math.min(0.25, now - last);
  last = now;
  acc += dt;

  let steps = 0;
  while (acc >= DT && steps < 8) {
    prev.x = boat.x; prev.y = boat.y; prev.psi = boat.psi; prev.phi = boat.phi;
    readControls(DT);
    boat.step(DT);
    if (![boat.x, boat.y, boat.psi, boat.phi, boat.u, boat.v].every(Number.isFinite)) {
      // Модель разошлась. Молча продолжать нельзя: дальше пойдут NaN в сцене,
      // и вместо понятной ошибки будет чёрный экран.
      boat.reset();
      const box = document.getElementById('crash');
      box.hidden = false;
      box.textContent = 'Физика разошлась, состояние сброшено. ' +
        'Проверьте sim/selftest.html.';
      acc = 0;
      break;
    }
    acc -= DT;
    steps++;
  }
  const a = Math.min(1, acc / DT);
  const ix = prev.x + (boat.x - prev.x) * a;
  const iy = prev.y + (boat.y - prev.y) * a;
  const ipsi = prev.psi + (boat.psi - prev.psi) * a;
  const iphi = prev.phi + (boat.phi - prev.phi) * a;

  // судостроительные координаты -> сцена
  boatGroup.position.set(ix, 0, -iy);
  boatGroup.rotation.order = 'YXZ';
  boatGroup.rotation.y = ipsi;
  boatGroup.rotation.x = -iphi;

  rudderPivot.rotation.y = boat.o.rudder;
  const t = boat.telemetry || {};
  const side = (t.awaDeg != null && boat.apparentWind().angle > 0) ? 1 : -1;
  shapeSails(boat.o.sheet, side);
  mastPivot.rotation.y = 0;

  // вода движется вместе с лодкой, чтобы не строить бесконечную сетку
  sea.position.set(Math.round(ix / 4) * 4, 0, Math.round(-iy / 4) * 4);
  const dirX = Math.cos(boat.o.windDir), dirZ = -Math.sin(boat.o.windDir);
  const pos = seaGeo.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    const wx = seaBase[i] + sea.position.x, wz = seaBase[i + 2] + sea.position.z;
    pos[i + 1] = waveHeight(wx, wz, now, dirX, dirZ) *
                 (0.4 + 0.09 * boat.o.windSpeed);
  }
  seaGeo.attributes.position.needsUpdate = true;
  // нормали воды пересчитываем через кадр: на глаз незаметно, а это самая
  // дорогая операция в цикле
  if ((hudTick & 1) === 0) seaGeo.computeVertexNormals();

  arrow.position.set(ix - 3 * Math.cos(boat.o.windDir), 5.5,
                     -iy + 3 * Math.sin(boat.o.windDir));
  arrow.rotation.y = boat.o.windDir + Math.PI;

  // камера: сзади и сбоку, с плавным догоном
  const mode = ui.cam ? ui.cam.value : 'chase';
  const back = mode === 'close' ? 9 : 15;
  const want = new Vector3(
    ix - back * Math.cos(ipsi) + 2 * Math.sin(ipsi),
    mode === 'close' ? 3.2 : 6.0,
    -iy + back * Math.sin(ipsi) + 2 * Math.cos(ipsi));
  camPos.lerp(want, 1 - Math.pow(0.001, dt));
  camera.position.copy(camPos);
  camera.lookAt(ix + 1.5 * Math.cos(ipsi), 1.2, -iy - 1.5 * Math.sin(ipsi));

  renderer.render(scene, camera);
  updateHud(t);
  requestAnimationFrame(frame);
}

const HUD_ROWS = [
  ['speedKn', 'Скорость', 'уз', 2],
  ['vmg', 'VMG', 'уз', 2],
  ['heelDeg', 'Крен', '°', 1],
  ['leewayDeg', 'Дрейф', '°', 1],
  ['twaAbsDeg', 'Истинный ветер', '°', 0],
  ['awaDeg', 'Кажущийся ветер', '°', 0],
  ['awsKn', 'Скорость кажущегося', 'уз', 1],
  ['alphaDeg', 'Угол атаки паруса', '°', 1],
  ['driveN', 'Тяга паруса', 'Н', 0],
  ['sideN', 'Боковая сила', 'Н', 0],
  ['resistN', 'Сопротивление', 'Н', 0],
  ['gzM', 'Плечо GZ', 'м', 3],
];

let hudTick = 0;
function updateHud(t) {
  if (!t || (hudTick++ % 4)) return;
  const rows = HUD_ROWS.map(([k, label, unit, prec]) =>
    '<tr><td>' + label + '</td><td class="v">' +
    (t[k] == null ? '—' : (+t[k]).toFixed(prec)) +
    '</td><td class="u">' + unit + '</td></tr>').join('');
  hud.innerHTML =
    '<div class="big">' + (t.speedKn || 0).toFixed(2) + ' <span>уз</span></div>' +
    '<table>' + rows + '</table>' +
    '<div class="ctl">руль ' + (boat.o.rudder / D).toFixed(0) +
    '°&nbsp;&nbsp;шкот ' + (boat.o.sheet / D).toFixed(0) + '°</div>';
}

shapeSails(boat.o.sheet, 1);
frame();
