// Симулятор управления SV20: сцена, ввод, цикл.
//
// Физика идёт фиксированным шагом 1/30 с и не зависит от частоты кадров;
// отрисовка интерполирует между шагами. Так поведение лодки одинаково и на
// шестидесяти герцах, и на просевших тридцати.
//
// Мировая система здесь — трёхмерная система three (Y вверх). Физика живёт в
// судостроительной: X в нос, Y на правый борт, Z вверх. Перевод только на
// границе, и он такой: three = (x, z, y).
//
// Тройка (нос, правый борт, вверх) левая, а у three правая, поэтому перевод
// обязан менять ориентацию — отсюда Z берётся с плюсом, а все углы поворота
// с минусом. Прежний перевод (x, z, −y) ориентацию сохранял, и вся сцена
// выходила зеркальной: правый борт рисовался слева. Само по себе это
// незаметно, зеркальная яхта ходит точно так же, и крен с парусом были
// зеркальны согласованно. Но роза ветров рисуется в обычной условности и
// потому спорила с трёхмерной картинкой, а порывы на воде спорили бы с обеими.
//
// Проверяется это за минуту: поставить в boatGroup столбик на (0, 3, +6) —
// это правый борт — и посмотреть, с какой стороны экрана он окажется в
// камере погони. Должен быть справа.
//
// Отдельная забота сцены — сделать поведение читаемым. По голым числам крен,
// дрейф и потерю хода на повороте не оценить, поэтому здесь есть бурун за
// кормой, дорожка пройденного пути, знаки на воде для привязки взгляда и
// роза ветров с положением паруса.

const D = Math.PI / 180;
const HZ = 30;
const DT = 1 / HZ;

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const rose = document.getElementById('rose');

const scene = new Scene();
const SKY = new Color(0xa8c4d8);
// Туман отодвинут: порывы на воде — языки по сотне метров, и в прежние
// сорок пять метров чистой воды не помещалось даже одного.
// Туман и дальняя плоскость камеры зависят от того, есть ли на что смотреть.
//
// На бесконечной воде туман отодвинут нарочно: языки порывов на воде длиной под
// сотню метров, и в прежние сорок пять метров не помещалось ни одного. Но
// дальше двухсот метров там всё равно ничего нет.
//
// С акваторией берег стоит в километре, плато в пяти, и с прежним туманом их не
// видно вовсе. Ближняя плоскость поднята с 0.15 до 0.5 м: разрешение буфера
// глубины падает как квадрат отношения дальней к ближней, и при far = 20 км на
// трёх километрах 0.15 даёт три метра ряби по рельефу, а 0.5 — метр. Полметра
// такелаж не режет: ближе к камере в свободном виде ничего не подпускается.
// Акватория необязательна: без пакета `Terrain` отвечает «не знаю» на всё, и
// лодка ходит по бесконечной воде ровно как раньше. Объявляется здесь, а не
// рядом с лодкой, потому что от неё зависит и сцена: туман, дальняя плоскость
// камеры и сам рельеф.
const terrain = new Terrain(TERRAIN_PACK);
const FAR_WATER = terrain.ready;
scene.fog = new Fog(SKY, FAR_WATER ? 900 : 110, FAR_WATER ? 14000 : 420);
const camera = new PerspectiveCamera(52, 1, FAR_WATER ? 0.5 : 0.15,
                                     FAR_WATER ? 20000 : 2000);
// WebGPU. Если его нет, рендерер сам откатывается на WebGL2 — код при этом
// один и тот же, TSL компилируется и туда и туда.
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
// Фон задаётся сценой, а не setClearColor: у WebGPU-рендерера очистка цветом
// до неба не доходит, и небо остаётся чёрным.
scene.background = SKY;
stage.appendChild(renderer.domElement);

scene.add(new HemisphereLight(0xe8f4ff, 0x2b4a63, 2.4));
const sun = new DirectionalLight(0xfff2dc, 2.6);
sun.position.set(-70, 80, 50);
scene.add(sun);

// ------------------------------------------------------------------- вода
//
// Вода одна на всё: и та, что под лодкой, и та, что до самого тумана. Второй,
// плоской, для дали нет и не будет — а значит нет и шва между ними, и нет
// второй реализации цвета. Это то же правило, что уже записано ниже про поле
// порывов: одно поле — одна реализация. Стоило нарушить его один раз, и вода
// пошла полосами, а физика при этом была права.
//
// Сетка при этом РАВНОМЕРНОЙ быть не может. Волны должны читаться в метре от
// борта, а вода — доставать до берега в километре; равномерная сетка на такой
// размах это девять тысяч ячеек в ряду. Поэтому она сгущается к лодке:
//
//     x = A·u + B·u³,   u ∈ [−1, 1]
//
// Кубическая часть растягивает край, линейная держит середину. A подобрано так,
// чтобы у лодки ячейка была полтора метра, A + B даёт нужный радиус. У SV20 с
// акваторией это полтора метра под бортом и двести семьдесят на семи
// километрах — при тех же ста пятидесяти делениях, что и раньше.
//
// Сетка ездит за лодкой шагами по ЦЕНТРАЛЬНОЙ ячейке, чтобы сгущение всегда
// приходилось на лодку, а рябь и цвет считались по мировым координатам и
// оттого не ползли.

const SEG = 150;
const SEA_COLOUR = 0x2c5c7d;
// Докуда стелется вода. С акваторией — до тумана, чтобы река доходила до
// берега; без неё дальше двухсот метров всё равно ничего нет.
const SEA_FAR = FAR_WATER ? 7000 : 260;
const CELL = 1.5;                       // ячейка под лодкой, м
const SEA_A = CELL * (SEG / 2);
const SEA_B = SEA_FAR - SEA_A;
const seaGeo = new PlaneGeometry(2, 2, SEG, SEG);
seaGeo.rotateX(-Math.PI / 2);
{
  const p = seaGeo.attributes.position.array;
  const warp = u => SEA_A * u + SEA_B * u * u * u;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = warp(p[i]);
    p[i + 2] = warp(p[i + 2]);
  }
}
const seaMat = new MeshStandardNodeMaterial({ roughness: 0.28, metalness: 0.12 });
const sea = new Mesh(seaGeo, seaMat);
sea.frustumCulled = false;
scene.add(sea);
const seaBase = seaGeo.attributes.position.array.slice();

// Вес волны по вершине. Далёкие ячейки в сотни метров волну не разрешают, и
// считать её там значит не рисовать волну, а разводить рябь из ошибок
// дискретизации. Гасится она по размеру ячейки, а не по расстоянию: размер и
// есть то, из-за чего гасить.
const seaAmp = new Float32Array(seaBase.length / 3);
{
  const du = 2 / SEG;
  for (let i = 0, v = 0; i < seaBase.length; i += 3, v++) {
    const r = Math.hypot(seaBase[i], seaBase[i + 2]);
    const u = Math.min(1, r / SEA_FAR);
    const cell = (SEA_A + 3 * SEA_B * u * u) * du;
    seaAmp[v] = Math.max(0, Math.min(1, (8 - cell) / 6));
  }
}

// Рябь от порывов. На воде усиление ветра видно раньше, чем оно доходит до
// парусов, — тёмными языками, ползущими по ветру. Это не украшение: без них
// порыв приходит из ниоткуда, и понять, что произошло, невозможно.
//
// Красится это в шейдере, по мировым координатам фрагмента. Раньше цвет
// раскладывался по вершинам на процессоре: сетка воды переставляется вслед за
// лодкой шагами по ячейке каждый кадр, а цвета пересчитывались через кадр, и
// картинка отставала от геометрии — языки мельтешили. В шейдере отставать
// нечему, заодно исчезла и зернистость от полутораметровой сетки вершин.
//
// Само поле здесь НЕ считается. Оно посчитано один раз в sim/wind.js — тем же
// кодом, по которому идут силы, — и лежит в текстуре размером в один период.
// Шейдеру остаётся перевести мировые координаты в систему, связанную с ветром,
// и взять выборку.
//
// Так сделано после того, как две реализации одного поля разошлись: множитель
// сглаживания в шейдерном шуме оказался переписан с ошибкой, поле рвалось на
// границах ячеек решётки, вода шла полосами — а физика при этом считала
// правильное поле. Ни тестом, ни консолью такое не ловится, потому что тесты
// до шейдера не достают. Теперь реализация одна, и расходиться нечему.
//
// Период поля — тысяча метров вдоль ветра и триста поперёк; текстура кроется
// с повторением, поэтому вода бесконечная. Байта на тексел хватает: на яркость
// приходится меньше процента на шаг, а вывод и так восьмибитный.
const GUST_TEX = { w: 512, h: 256 };
const seaGustMap = new DataTexture(
  gustTexture(GUST_TEX.w, GUST_TEX.h), GUST_TEX.w, GUST_TEX.h, RedFormat);
seaGustMap.wrapS = RepeatWrapping;
seaGustMap.wrapT = RepeatWrapping;
seaGustMap.minFilter = LinearFilter;
seaGustMap.magFilter = LinearFilter;
seaGustMap.needsUpdate = true;

const seaGust = uniform(0);
const seaWindDir = uniform(0);
const seaWindSpeed = uniform(6);
const seaTime = uniform(0);

// Те же две строки, что и в WindField.frame: вдоль потока и поперёк, поле едет
// по ветру со скоростью потока.
const svGust = Fn(([p]) => {
  const c = seaWindDir.cos(), s = seaWindDir.sin();
  const along = p.x.mul(c).add(p.y.mul(s)).negate().sub(seaWindSpeed.mul(seaTime));
  const across = p.x.mul(s).negate().add(p.y.mul(c));
  const uv = vec2(along.div(GUST_PERIOD.along), across.div(GUST_PERIOD.across));
  return texture(seaGustMap, uv).r.mul(2.0).sub(1.0);
});

seaMat.colorNode = color(SEA_COLOUR).mul(
  svGust(positionWorld.xz).mul(seaGust).mul(3.0).oneMinus().clamp(0.25, 1.8));

// Имена TSL живут в одной области видимости с вклеенным three, и какое-нибудь
// из них может оказаться перекрыто одноимённой обычной функцией — так уже
// вышло с clamp: в ядре есть числовой clamp, он молча вернул число вместо
// узла, и вода стала чёрной без единой ошибки в консоли. Проверять по списку
// имён незачем: достаточно убедиться, что собранное выражение — узел.
if (!seaMat.colorNode || typeof seaMat.colorNode.mul !== 'function') {
  throw new Error('TSL: выражение цвета воды собралось не в узел — ' +
                  'какое-то имя перекрыто вклеенной сборкой three');
}

function waveHeight(x, z, t, dx, dz, amp) {
  const a = Math.sin((x * dx + z * dz) * 0.28 + t * 1.35);
  const b = Math.sin((x * dz - z * dx) * 0.17 - t * 0.85);
  const c = Math.sin((x * dx + z * dz) * 0.72 + t * 2.6);
  const d = Math.sin((x * 0.9 - z * 0.4) * 1.35 - t * 3.4);
  return amp * (0.5 * a + 0.28 * b + 0.14 * c + 0.08 * d);
}

// ------------------------------------------------------------------- лодка

const boatGroup = new Group();
scene.add(boatGroup);

function meshFrom(data, colour, rough, metal) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(data.positions, 3));
  g.setIndex(data.indices);
  g.computeVertexNormals();
  return new Mesh(g, new MeshStandardMaterial({
    color: new Color(colour), roughness: rough == null ? 0.45 : rough,
    metalness: metal == null ? 0.05 : metal, side: DoubleSide,
  }));
}

boatGroup.add(meshFrom(MESH.hull, 0xf4f7fa, 0.32));
boatGroup.add(meshFrom(MESH.keel_fin, 0x5d6873, 0.4));
boatGroup.add(meshFrom(MESH.bulb, 0x8d7340, 0.35, 0.3));
if (MESH.keel_case) boatGroup.add(meshFrom(MESH.keel_case, 0xe4eaee, 0.4));

const rudderMesh = meshFrom(MESH.rudder, 0x5d6873, 0.4);
const rudderPivot = new Group();
const stockX = PACK.foils.rudder.x_m;
rudderMesh.position.set(-stockX, 0, 0);
rudderPivot.position.set(stockX, 0, 0);
rudderPivot.add(rudderMesh);
boatGroup.add(rudderPivot);

const rig = PACK.rig;
const spar = new MeshStandardMaterial({
  color: 0xc3ccd4, roughness: 0.35, metalness: 0.6 });
const wireMat = new MeshStandardMaterial({
  color: 0x7d8894, roughness: 0.4, metalness: 0.8 });

// Трос или трубка между двумя точками. Всё стоячее такелажное хозяйство
// вычерчено на плане парусности, и здесь оно ставится по снятым точкам, а не
// на глаз: штаг от форштевня к узлу на мачте, ванты от путенсов туда же.
function strut(a, b, radius, mat) {
  const dir = new Vector3().subVectors(b, a);
  const m = new Mesh(new CylinderGeometry(radius, radius, dir.length(), 6), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
  return m;
}

// Мачта с наклоном: на чертеже она завалена в корму на три с половиной
// градуса, и это видно — топ уходит на полметра назад от пятки.
const mastFoot = new Vector3(rig.mast_x_m, rig.mast_deck_z_m, 0);
const mastTop = new Vector3(rig.mast_top_x_m, rig.mast_height_m, 0);
const mast = strut(mastFoot, mastTop, 0.055, spar);
boatGroup.add(mast);

const boom = new Mesh(new CylinderGeometry(0.045, 0.045, rig.boom_m, 8), spar);
boom.rotation.z = Math.PI / 2;
boom.position.set(-rig.boom_m / 2, 0, 0);
const boomPivot = new Group();
boomPivot.position.set(rig.sails.main.tack[0], rig.boom_z_m, 0);
boomPivot.add(boom);
boatGroup.add(boomPivot);

// Штаг и ванты. Спредеры на чертеже не показаны — их закрывает наложенный
// сверху вид сверху, — но без них вантина с таким выносом не держалась бы,
// поэтому они ставятся упором в саму вантину на половине высоты узла.
// Проекция вантины на чертеже прямая, изломов у неё нет, так что и здесь она
// рисуется прямой, а спредер её только подпирает.
{
  const fs = rig.forestay;
  boatGroup.add(strut(new Vector3(fs.stem[0], fs.stem[1], 0),
                      new Vector3(fs.hounds[0], fs.hounds[1], 0), 0.012, wireMat));
  const sh = rig.shroud;
  if (sh) {
    const tang = new Vector3(sh.tang[0], sh.tang[1], 0);
    const SPREADER_F = 0.48;    // доля высоты узла, где стоит спредер
    for (const board of [1, -1]) {
      const foot = new Vector3(sh.chainplate[0], sh.chainplate[1],
                               sh.chainplate_y_m * board);
      boatGroup.add(strut(foot, tang, 0.010, wireMat));
      const tip = new Vector3().lerpVectors(foot, tang, SPREADER_F);
      const onMast = new Vector3().lerpVectors(mastFoot, mastTop,
        (tip.y - mastFoot.y) / (mastTop.y - mastFoot.y));
      boatGroup.add(strut(onMast, tip, 0.018, spar));
    }
  }
}

// --- паруса -----------------------------------------------------------------

// Паруса строятся по тем же треугольникам и тому же закону твиста, что и
// полоски в физике: сетка станций по высоте, на каждой хорда повёрнута на свой
// угол и выгнута пузом под ветер. Раньше здесь была отдельная приблизительная
// заглушка из пяти точек, и нарисованный парус жил своей жизнью — с твистом
// это стало видно сразу: латы торчали за шкаторину.
// Строк по высоте стало больше: у грота серп ломаной в пять звеньев, и на
// семи станциях он срезался.
// Строк по высоте — по числу полосок с запасом; столбцов по хорде много и они
// сгущены к передней шкаторине. Пузырь заполаскивания живёт в передней пятой
// части хорды, и на прежних пяти столбцах он целиком помещался в одну ячейку:
// нарисовать в ней бегущую волну нечем.
const SAIL_ROWS = 11, SAIL_COLS = 18;

// Доля хорды для столбца c. Показатель больше единицы сгущает точки к нулю,
// то есть к мачте и штагу.
const chordAt = c => Math.pow(c / (SAIL_COLS - 1), 1.6);

// Число Струхаля для бьющего полотна. У флага частота колебаний примерно
// равна 0.3·V/L, где L — длина свободной части; у смятой передней шкаторины
// механизм тот же. В двенадцать узлов ветра на метровом пузыре выходит около
// двух герц — столько парус и бьёт.
const FLAP_ST = 0.3;

// Длина волны тряски по высоте, м: заполаскивание бежит по шкаторине вверх,
// а не хлопает всем полотном сразу.
const FLAP_SPAN = 1.6;

// Потолок частоты. У короткого пузыря по формуле выходит за десять герц, а
// картинка идёт тридцать кадров в секунду: показать такое нечем, и вместо
// тряски получается дрожь от недосэмплирования. Пять герц глаз читает как
// «бьёт», и на тридцати кадрах они ещё различимы.
const FLAP_MAX_HZ = 5;

function sailMesh(colour) {
  const g = new BufferGeometry();
  const n = SAIL_ROWS * SAIL_COLS;
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3));
  // Цвет по вершинам — им затемняется смятая ткань: она ловит свет иначе, и
  // без этого бьющий парус на картинке отличается от стоящего только формой.
  const col = new Float32Array(n * 3).fill(1);
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  const idx = [];
  for (let r = 0; r < SAIL_ROWS - 1; r++) {
    for (let c = 0; c < SAIL_COLS - 1; c++) {
      const a = r * SAIL_COLS + c;
      idx.push(a, a + 1, a + SAIL_COLS, a + 1, a + SAIL_COLS + 1, a + SAIL_COLS);
    }
  }
  g.setIndex(idx);
  const m = new Mesh(g, new MeshStandardMaterial({
    color: new Color(colour), roughness: 0.9, side: DoubleSide,
    vertexColors: true,
  }));
  m.frustumCulled = false;
  return m;
}
const mainSail = sailMesh(0xf7f9fb);
const jibSail = sailMesh(0xeef2f6);
boatGroup.add(mainSail, jibSail);

// Колдунчики.
//
// Тряска показывает, что парус УЖЕ полощет; колдунчик — что вот-вот начнёт, и
// в какую сторону править. Это то, по чему на воде и держат настройку, и стоит
// он дешевле всего: всё нужное уже посчитано.
//
// Наветренный поднимается, когда угол атаки падает ниже идеального, то есть
// когда лодка приведена или шкот перетравлен. Подветренный виснет и мечется,
// когда угол атаки подходит к срыву — перебран шкот или лодка увалена. Оба
// стелются по потоку, когда парус настроен.
const TELL_ROWS = [2, 5, 8];      // строки сетки паруса, где висят ленточки
const TELL_COL = 5;               // столбец: примерно 15% хорды от шкаторины
const TELL_SEG = 4;               // звеньев в ленточке
const TELL_LEN = 0.34;            // длина, м
const TELL_OFF = 0.03;            // отступ от полотна, м
const TELL_W = 0.018;             // полуширина ленты, м
const SAIL_STALL = 13;            // градусов, как в physics.sailCoeffs

// Ленточка — не линия, а узкая полоса: линия толщиной в пиксель на воде не
// читается, а тут ещё и не утолщается (WebGL везде рисует её в один пиксель).
// Полосу разворачиваем в плоскости паруса — тогда с наветра, откуда на них и
// смотрят, она видна плашмя.
//
// Рисуем поверх всего (`depthTest: false`), как и латы: подветренный колдунчик
// смотрят сквозь полотно, ради того его и вешают против наветренного.
const TELL_VERT = TELL_SEG * 6;   // два треугольника на звено

function telltaleMesh() {
  const n = TELL_ROWS.length * 2 * TELL_VERT;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3));
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // первая половина вершин — наветренные, вторая — подветренные
    const lee = i >= n / 2;
    col[i * 3] = lee ? 0.35 : 0.98;
    col[i * 3 + 1] = lee ? 0.88 : 0.36;
    col[i * 3 + 2] = lee ? 0.58 : 0.30;
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  const m = new Mesh(g, new MeshBasicMaterial({
    vertexColors: true, depthTest: false, side: DoubleSide }));
  m.renderOrder = 3;
  m.frustumCulled = false;
  return m;
}
const telltales = [telltaleMesh(), telltaleMesh()];
boatGroup.add(telltales[0], telltales[1]);

// Одна ленточка: от точки на полотне по потоку, с изломом и трепетом.
// `bend` — насколько её задирает или роняет, `wob` — насколько мечется.
function drawTelltale(arr, at, px, py, pz, ux, uz, bend, wob, phase) {
  let x = px, y = py, z = pz, i = at;
  const step = TELL_LEN / TELL_SEG;
  for (let s = 0; s < TELL_SEG; s++) {
    const f = (s + 1) / TELL_SEG;
    const a = bend * f + wob * Math.sin(phase + 3 * f);
    const c = Math.cos(a), sn = Math.sin(a);
    const nx = x + ux * c * step, ny = y + sn * step, nz = z + uz * c * step;
    // поперёк ленты, в плоскости паруса: единичное, потому что c² + sin² = 1
    const wx = sn * ux * TELL_W, wy = -c * TELL_W, wz = sn * uz * TELL_W;
    const v = [x - wx, y - wy, z - wz,  x + wx, y + wy, z + wz,
               nx + wx, ny + wy, nz + wz,
               x - wx, y - wy, z - wz,  nx + wx, ny + wy, nz + wz,
               nx - wx, ny - wy, nz - wz];
    for (let j = 0; j < 18; j++) arr[i + j] = v[j];
    x = nx; y = ny; z = nz; i += 18;
  }
  return i;
}

// Стаксель-шкот и погон под ним. Нарисованы затем, что именно они и объясняют,
// почему добранный стаксель стоит не в ДП: шкотовый угол тянут к каретке на
// погоне, к точке у борта.
const jibSheetGeo = new BufferGeometry();
jibSheetGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(6), 3));
const jibSheet = new Line(jibSheetGeo,
  new LineBasicMaterial({ color: 0x3d4650 }));
jibSheet.frustumCulled = false;
boatGroup.add(jibSheet);
{
  const sh = rig.sails.jib.sheeting;
  if (sh) {
    for (const board of [1, -1]) {
      const g = new BufferGeometry().setFromPoints([
        new Vector3(sh.track_m[0][0], sh.lead_m[2], sh.track_m[0][1] * board),
        new Vector3(sh.track_m[1][0], sh.lead_m[2], sh.track_m[1][1] * board)]);
      boatGroup.add(new Line(g, new LineBasicMaterial({ color: 0x8d98a4 })));
    }
  }
}

// Парус рисуется ровно там, где стоит в расчёте: шкот его только ограничивает,
// а твист берётся действующий, вместе с той добавкой, которую даёт провисший
// шкот. Иначе на потравленных шкотах нарисованный парус стоит колом, а
// посчитанный полощет.
function shapeSails(side) {
  const awa = boat.telemetry ? boat.telemetry.awaDeg * D : Math.PI;
  // Та же формула, что в physics.sailForces: парус держится шкотом до своего
  // предела, дальше сваливается по потоку.
  const setOf = sail => {
    const own = boat.o.sheet + (sail.mast ? 0 : boat.o.jibTrim);
    const trim = Math.max(sail.minSet || 0, own);
    const held = Math.min(trim, awa);
    const over = Math.min(1, Math.max(0, (own - sail.maxSheet) / (25 * D)));
    return held + (awa - held) * over;
  };
  boomPivot.rotation.y = setOf(boat.sails[0]) * side;
  const twist = boat.twistEff || boat.o.twist;
  // Пузо и положение горба больше не назначаются: их посчитала мембрана, по
  // полоске на каждую. Раньше здесь стояло 0.10 хорды по синусу — то есть
  // картинка жила отдельно от расчёта и врала вдвойне: и глубиной (в физике
  // было 0.026), и тем, что горб всегда стоял на середине. Теперь у смятого
  // спереди паруса горб уезжает назад ровно так, как получилось в расчёте.
  const strips = boat.stripCalc;
  const tele = boat.telemetry && boat.telemetry.strips;
  boat.sails.forEach((sail, k) => {
    const mesh = k === 0 ? mainSail : jibSail;
    const a = mesh.geometry.attributes.position.array;
    const col = mesh.geometry.attributes.color.array;
    const base = k * 6;
    // Обводы — снятые с чертежа ломаные, те же самые, по которым физика режет
    // парус на полоски. У грота отсюда берётся серп: задняя шкаторина выгнута
    // в корму почти на две трети метра, и на картинке это сразу узнаётся.
    const zLo = Math.max(sail.tack[1], sail.clew[1]);
    const zHi = Math.min(sail.head[1], sail.head_aft[1]);
    const luffAt = edgeFn(sail.luff), leechAt = edgeFn(sail.leech);
    let i = 0;
    for (let r = 0; r < SAIL_ROWS; r++) {
      const f = r / (SAIL_ROWS - 1);
      const h = zLo + f * (zHi - zLo);
      const xLuff = luffAt(h), chord = Math.max(0, xLuff - leechAt(h));
      const sh = setOf(sail) + twist * Math.pow(f, 1.3);
      // Пузо берётся у ближайшей по высоте полоски: их шесть на парус, строк
      // сетки одиннадцать.
      const g = strips[base + Math.min(5, Math.round(f * 5))] || {};
      // Знак пуза берётся из расчёта: он говорит, на какую сторону выгнут
      // парус. Нормаль ниже — та же самая, что в physics.sailForces, поэтому
      // нарисованное и посчитанное полотно совпадают.
      const camber = (g.camber || 0) * (g.fill == null ? 1 : g.fill);
      const draft = Math.min(0.85, Math.max(0.15, g.draft == null ? 0.5 : g.draft));

      // Заполаскивание. Физика говорит, какая доля хорды от передней шкаторины
      // потеряла нагрузку; здесь эта доля начинает биться.
      //
      // Всё, чем задаётся тряска, посчитано, а не назначено. Размах — из
      // запаса ткани: лишняя длина укладывается полуволной, и из равенства
      // длин выходит A = (2/π)·L·√σ. Частота — по Струхалю от местного потока
      // и длины смятого участка, как у флага. Волна бежит по хорде назад и по
      // шкаторине вверх.
      //
      // В силы это не входит: потери уже сидят в наполнении, а здесь только
      // картинка. Время берётся физическое, поэтому записанный прогон
      // выглядит при воспроизведении так же.
      const lf = Math.min(1, g.luffFrac || 0);
      const flap = lf > 0.02 && chord > 0.05;
      let amp = 0, om = 0;
      if (flap) {
        const L = lf * chord;
        amp = (2 / Math.PI) * L * Math.sqrt(Math.max(0, g.slack || 0));
        const hz = Math.min(FLAP_MAX_HZ, FLAP_ST * Math.max(1, g.ve || 1) / L);
        om = 2 * Math.PI * hz;
      }
      const phase = om * boat.t - h / FLAP_SPAN;

      // хорда идёт в корму и под ветер, нормаль к ней смотрит туда же
      const ux = -Math.cos(sh), uy = Math.sin(sh) * side;
      const nx = -uy, ny = ux;
      for (let c = 0; c < SAIL_COLS; c++) {
        const t = chordAt(c);
        // Горб на своей доле хорды: две сопряжённые полуволны синуса, слева от
        // горба и справа. Глубина — посчитанное пузо.
        const u = t < draft ? 0.5 * t / draft : 0.5 + 0.5 * (t - draft) / (1 - draft);
        let bow = camber * chord * Math.sin(Math.PI * u);
        let shade = 1;
        if (flap && t < lf) {
          // Полотно закреплено на шкаторине и держится там, где нагрузка
          // ещё есть, — значит размах нулевой на обоих концах пузыря.
          const v = t / lf;
          bow += amp * Math.sin(Math.PI * v) * Math.sin(phase - Math.PI * v);
          shade = 1 - 0.3 * Math.sin(Math.PI * v);
        }
        a[i] = xLuff + chord * t * ux + bow * nx;
        a[i + 1] = h;
        a[i + 2] = chord * t * uy + bow * ny;
        col[i] = shade; col[i + 1] = shade; col[i + 2] = shade;
        i += 3;
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.geometry.computeVertexNormals();

    // Колдунчики: по три пары на парус, на тех же строках сетки.
    //
    // Пороги здесь — не подгонка, а перевод посчитанного в видимое. Запас угла
    // над идеальным меньше трёх градусов — наветренный начинает подниматься;
    // угол атаки подошёл к срыву ближе трёх градусов — подветренный виснет.
    // Между этими двумя состояниями и лежит правильная настройка.
    const tt = telltales[k].geometry.attributes.position.array;
    const half = tt.length / 2;
    let iw = 0, il = half;
    for (const r of TELL_ROWS) {
      const si = base + Math.min(5, Math.round((r / (SAIL_ROWS - 1)) * 5));
      const g = strips[si] || {};
      const d = (tele && tele[si]) || {};
      const at = (r * SAIL_COLS + TELL_COL) * 3;
      const ax = a[at], ay = a[at + 1], az = a[at + 2];
      // направление хорды на этой строке — из соседнего по хорде узла
      const nx2 = a[at + 3] - ax, nz2 = a[at + 5] - az;
      const len = Math.hypot(nx2, nz2) || 1;
      const ux = nx2 / len, uz = nz2 / len;
      // подветренная сторона — та, куда выгнут парус
      const lee = Math.sign(g.camber || 1);
      const offX = -uz * TELL_OFF * lee, offZ = ux * TELL_OFF * lee;

      const margin = (g.margin || 0) / D;
      // Срыв меряется углом атаки ПОСЛЕ скоса — тем, под которым сечение
      // стоит в потоке. По углу к хорде подветренный колдунчик дёргался почти
      // на любой настройке: у грота за стакселем и у стакселя за штагом угол к
      // хорде порядка пятнадцати градусов даже тогда, когда поток на них
      // приходит почти по касательной. 13° — тот же угол срыва, по которому
      // считаются коэффициенты паруса.
      const stall = SAIL_STALL - Math.abs(d.alphaDeg || 0);
      const lift = Math.min(1, Math.max(0, (3 - margin) / 4));
      const droop = Math.min(1, Math.max(0, (3 - stall) / 4));
      // Мечется по тому же закону Струхаля, что и заполоскавшее полотно, только
      // длина здесь своя — самой ленточки.
      const hz = Math.min(FLAP_MAX_HZ, FLAP_ST * Math.max(1, g.ve || 1) / TELL_LEN);
      const ph = 2 * Math.PI * hz * boat.t - r;

      iw = drawTelltale(tt, iw, ax - offX, ay, az - offZ, ux, uz,
                        lift * 1.1, lift * 0.5, ph);
      il = drawTelltale(tt, il, ax + offX, ay, az + offZ, ux, uz,
                        -droop * 0.9, droop * 0.6, ph + 2);
    }
    telltales[k].geometry.attributes.position.needsUpdate = true;
    telltales[k].geometry.computeBoundingSphere();
  });

  // Шкот от шкотового угла стакселя к каретке. Шкотовый угол здесь — нижняя
  // точка задней шкаторины нарисованного паруса, то есть ровно та, что
  // получилась из расчёта.
  const sh = rig.sails.jib.sheeting;
  if (sh) {
    const a = jibSail.geometry.attributes.position.array;
    const k = (SAIL_COLS - 1) * 3;
    const p = jibSheetGeo.attributes.position.array;
    p[0] = a[k]; p[1] = a[k + 1]; p[2] = a[k + 2];
    p[3] = sh.lead_m[0]; p[4] = sh.lead_m[2]; p[5] = sh.lead_m[1] * side;
    jibSheetGeo.attributes.position.needsUpdate = true;
    jibSheetGeo.computeBoundingSphere();
  }
}

// --- бурун и дорожка пути -----------------------------------------------------
//
// Без них ход и снос не читаются: вода однородная, глазу не за что зацепиться.
// Бурун показывает скорость, дорожка — куда лодку на самом деле несёт.

const WAKE = 150;
const wakeGeo = new BufferGeometry();
wakeGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(WAKE * 2 * 3), 3));
wakeGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(WAKE * 2 * 3), 3));
const wakeIdx = [];
for (let i = 0; i < WAKE - 1; i++) {
  const a = i * 2;
  wakeIdx.push(a, a + 1, a + 3, a, a + 3, a + 2);
}
wakeGeo.setIndex(wakeIdx);
const wake = new Mesh(wakeGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false,
}));
wake.frustumCulled = false;
scene.add(wake);
const wakePts = [];

const TRACK = 1200;
const trackGeo = new BufferGeometry();
trackGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(TRACK * 3), 3));
trackGeo.setDrawRange(0, 0);
const track = new Line(trackGeo, new LineBasicMaterial({
  color: 0xffd97a, transparent: true, opacity: 0.8 }));
track.frustumCulled = false;
scene.add(track);
let trackN = 0;

// --- сетка на воде ------------------------------------------------------------
//
// Однородная вода не даёт ощущения хода: лодка будто висит. Сетка привязана к
// миру, а не к лодке, и переставляется шагами по ячейке — получается
// бесконечное поле, по которому видно и скорость, и снос, и поворот.

const GRID_STEP = 5, GRID_HALF = 11, GRID_SUB = 2;
const gridLines = [];
{
  const n = GRID_HALF * 2, m = n * GRID_SUB;
  for (let i = 0; i <= n; i++) {
    const a = (i - GRID_HALF) * GRID_STEP;
    for (let j = 0; j < m; j++) {
      const b0 = (j / GRID_SUB - GRID_HALF) * GRID_STEP;
      const b1 = ((j + 1) / GRID_SUB - GRID_HALF) * GRID_STEP;
      gridLines.push([a, b0], [a, b1]);          // вдоль Z
      gridLines.push([b0, a], [b1, a]);          // вдоль X
    }
  }
}
const gridGeo = new BufferGeometry();
gridGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(gridLines.length * 3), 3));
gridGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(gridLines.length * 3), 3));
const grid = new LineSegments(gridGeo, new LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false }));
grid.frustumCulled = false;
scene.add(grid);
const GRID_FADE = GRID_HALF * GRID_STEP;

function updateGrid(cx, cz, t, dx, dz, amp) {
  const ox = Math.round(cx / GRID_STEP) * GRID_STEP;
  const oz = Math.round(cz / GRID_STEP) * GRID_STEP;
  const p = gridGeo.attributes.position.array;
  const c = gridGeo.attributes.color.array;
  for (let i = 0; i < gridLines.length; i++) {
    const x = ox + gridLines[i][0], z = oz + gridLines[i][1];
    p[i * 3] = x;
    p[i * 3 + 1] = waveHeight(x, z, t, dx, dz, amp) + 0.03;
    p[i * 3 + 2] = z;
    const d = Math.max(Math.abs(gridLines[i][0]), Math.abs(gridLines[i][1]));
    const f = Math.max(0, 1 - d / GRID_FADE);
    const v = 0.35 + 0.45 * f * f;
    c[i * 3] = v; c[i * 3 + 1] = v * 1.05; c[i * 3 + 2] = v * 1.1;
  }
  gridGeo.attributes.position.needsUpdate = true;
  gridGeo.attributes.color.needsUpdate = true;
}

// --- знаки на воде ------------------------------------------------------------

function buoy(x, z, colour) {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: colour, roughness: 0.6 });
  const body = new Mesh(new CylinderGeometry(0.34, 0.42, 1.5, 12), mat);
  body.position.y = 0.55;
  const top = new Mesh(new ConeGeometry(0.34, 0.7, 12), mat);
  top.position.y = 1.6;
  g.add(body, top);
  g.position.set(x, 0, z);
  scene.add(g);
  return g;
}
[[0, -90, 0xe8683c], [0, 90, 0xe8b83c], [70, 0, 0x4a9ad4], [-70, 0, 0x4a9ad4]]
  .forEach(m => buoy(m[0], m[1], m[2]));

// --- указатель ветра над лодкой ----------------------------------------------

const arrow = new Group();
const amat = new MeshBasicMaterial({ color: 0xffcf5a });
const shaft = new Mesh(new CylinderGeometry(0.05, 0.05, 2.2, 8), amat);
shaft.rotation.z = Math.PI / 2;
const tip = new Mesh(new ConeGeometry(0.18, 0.55, 10), amat);
tip.rotation.z = -Math.PI / 2;
tip.position.x = 1.35;
arrow.add(shaft, tip);
scene.add(arrow);

// --- отладочный слой: поле ветра и полоски рига -------------------------------
//
// Обе новые вещи — профиль ветра по высоте и разбивка парусов на полоски —
// невидимы в числах. Поэтому у каждой есть свой вид.
//
// Стрелки на воде показывают поле ветра там, где оно есть: свою длину и своё
// направление в каждой точке. По ним видно и заход, и то, что порыв приходит
// не сразу на всю акваторию.
//
// Латы на парусе — это хорды полосок, нарисованные каждая под своим углом.
// Твист по ним читается сразу: латы разворачиваются веером. Цвет — угол атаки:
// синий заполаскивает, зелёный работает, красный сорван.

const DBG_STEP = 12, DBG_HALF = 3;             // сетка стрелок ветра, м
const arrowPts = [];
for (let i = -DBG_HALF; i <= DBG_HALF; i++)
  for (let j = -DBG_HALF; j <= DBG_HALF; j++) arrowPts.push([i * DBG_STEP, j * DBG_STEP]);
// Стрелки — плоские фигурки, а не линии: линия в WebGL всегда толщиной в один
// пиксель, и в камере погони, где на воду смотришь под острым углом, она
// пропадает совсем. Три треугольника на стрелку.
const ARR_V = 9;
const fieldGeo = new BufferGeometry();
fieldGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(arrowPts.length * ARR_V * 3), 3));
fieldGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(arrowPts.length * ARR_V * 3), 3));
const field = new Mesh(fieldGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.8,
  depthTest: false, side: DoubleSide }));
field.frustumCulled = false;
field.renderOrder = 3;
scene.add(field);

function updateField(cx, cz, t) {
  const p = fieldGeo.attributes.position.array;
  const c = fieldGeo.attributes.color.array;
  const ox = Math.round(cx / DBG_STEP) * DBG_STEP;
  const oz = Math.round(cz / DBG_STEP) * DBG_STEP;
  const ref = boat.o.windSpeed || 1;
  for (let i = 0; i < arrowPts.length; i++) {
    const x = ox + arrowPts[i][0], z = oz + arrowPts[i][1];
    const w = boat.wind.sample(x, z, 3.0, t);
    // рисуем туда, КУДА дует: так видно, куда поедет порыв
    const dx = w.x / (w.speed || 1), dz = w.y / (w.speed || 1);
    const px = -dz, pz = dx;                       // поперёк стрелки
    const len = 2.2 + 3.4 * (w.speed / ref);
    const hw = 0.22, head = 1.3, hh = 0.62;        // полширины древка и головки
    const bx = x + dx * (len - head), bz2 = z + dz * (len - head);
    const tx = x + dx * len, tz = z + dz * len;
    let k = i * ARR_V * 3;
    const put = (ax, az) => {
      p[k] = ax; p[k + 1] = 0.36; p[k + 2] = az; k += 3;
    };
    put(x + px * hw, z + pz * hw); put(x - px * hw, z - pz * hw);
    put(bx + px * hw, bz2 + pz * hw);
    put(x - px * hw, z - pz * hw); put(bx - px * hw, bz2 - pz * hw);
    put(bx + px * hw, bz2 + pz * hw);
    put(bx + px * hh, bz2 + pz * hh); put(bx - px * hh, bz2 - pz * hh);
    put(tx, tz);
    // цвет по силе: слабее среднего синеет, сильнее — желтеет
    const s = Math.max(0, Math.min(1, (w.speed / ref - 0.7) / 0.7));
    for (let v = 0; v < ARR_V; v++) {
      const b = (i * ARR_V + v) * 3;
      c[b] = 0.35 + 0.65 * s;
      c[b + 1] = 0.65 + 0.25 * s;
      c[b + 2] = 1.0 - 0.45 * s;
    }
  }
  fieldGeo.attributes.position.needsUpdate = true;
  fieldGeo.attributes.color.needsUpdate = true;
}

const NSTRIP = 12, BAT_V = 6, BAT_HALF = 0.055;
const battenGeo = new BufferGeometry();
battenGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(NSTRIP * BAT_V * 3), 3));
battenGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(NSTRIP * BAT_V * 3), 3));
const battens = new Mesh(battenGeo, new MeshBasicMaterial({
  vertexColors: true, depthTest: false, side: DoubleSide }));
battens.frustumCulled = false;
battens.renderOrder = 4;
boatGroup.add(battens);

// Цвет по ТЯГЕ полоски, а не по углу атаки.
//
// По углу атаки было честно, но обманчиво: на полных курсах парус работает
// сорванным, потому что там нужна не подъёмная сила, а лобовое сопротивление
// вдоль движения. Шкала «зелёный — поток прилип, красный — сорван» показывала
// в фордевинд сплошной красный ровно там, где лодка едет быстрее всего.
// Тяга отвечает на вопрос прямо и одинаково на всех курсах.
//
// Состояние потока никуда не делось: угол атаки со срывной чертой остался
// вторым столбцом панели рига.
function driveColour(f) {
  if (f < 0) {                       // тормозит: от серого к красному
    const k = Math.min(1, -f);
    return [0.55 + 0.45 * k, 0.55 - 0.25 * k, 0.6 - 0.3 * k];
  }
  const k = Math.min(1, f);          // тянет: от серого к зелёному
  return [0.55 - 0.25 * k, 0.55 + 0.4 * k, 0.6 - 0.25 * k];
}

function updateBattens(side) {
  const p = battenGeo.attributes.position.array;
  const c = battenGeo.attributes.color.array;
  const st = boat.telemetry && boat.telemetry.strips;
  // Нормируем по самой тянущей полоске: важно, кто здесь и сейчас работает,
  // а не абсолютные ньютоны, которые меняются на порядок с силой ветра.
  let peak = 1e-6;
  if (st) for (const d of st) peak = Math.max(peak, Math.abs(d.drive));
  for (let i = 0; i < NSTRIP; i++) {
    const s = boat.strips[i], d = st ? st[i] : null;
    const aw = d ? d.awaDeg * D : Math.PI;
    const held = Math.min(boat.o.sheet, aw);
    const over = Math.min(1, Math.max(0, (boat.o.sheet - s.maxSheet) / (25 * D)));
    const sheet = held + (aw - held) * over +
                  (boat.twistEff || boat.o.twist) * s.twistF;
    const ax = s.xLuff, az = 0;
    const bx = s.xLuff - s.chord * Math.cos(sheet);
    const bz = s.chord * Math.sin(sheet) * side;
    let k = i * BAT_V * 3;
    const put = (x, y, z) => { p[k] = x; p[k + 1] = y; p[k + 2] = z; k += 3; };
    put(ax, s.h - BAT_HALF, az); put(ax, s.h + BAT_HALF, az);
    put(bx, s.h - BAT_HALF, bz);
    put(ax, s.h + BAT_HALF, az); put(bx, s.h + BAT_HALF, bz);
    put(bx, s.h - BAT_HALF, bz);
    const col = driveColour(d ? d.drive / peak : 0);
    for (let v = 0; v < BAT_V; v++) {
      const b = (i * BAT_V + v) * 3;
      c[b] = col[0]; c[b + 1] = col[1]; c[b + 2] = col[2];
    }
  }
  battenGeo.attributes.position.needsUpdate = true;
  battenGeo.attributes.color.needsUpdate = true;
}

// --- запись состояния ---------------------------------------------------------
//
// Кнопка «сдампать» пишет в файл всё, что нужно, чтобы воспроизвести момент:
// состояние лодки, настройки, поле ветра — и запись последних двадцати секунд
// по шагам физики. Запись важнее снимка: жалобы на воде звучат как «дрожит»
// или «понемногу разгоняется», а это про поведение во времени, а не про одно
// мгновение.
//
// Поле ветра собственного состояния не имеет: оно однозначно задаётся
// скоростью, направлением, порывистостью и парой (положение, время). Значит
// восстановления лодки достаточно, чтобы получить тот же самый ветер.
//
// Проигрывается дамп без браузера: scripts/replay.mjs.
const TRACE_SECONDS = 20;
const recorder = new Recorder(TRACE_SECONDS, HZ);

function dumpState() {
  const t = boat.telemetry || {};
  return {
    build: typeof BUILD !== 'undefined' ? BUILD : null,
    // Отпечаток полей акватории. Запись, сделанная на ней, без неё не
    // воспроизводится — и об этом надо сказать вслух, а не разойтись молча.
    terrain: terrain.ready ? { hash: TERRAIN_PACK.hash } : null,
    saved: new Date().toISOString(),
    boat: {
      x: boat.x, y: boat.y, psi: boat.psi, u: boat.u, v: boat.v, r: boat.r,
      phi: boat.phi, p_: boat.p_, t: boat.t, rigSide: boat.rigSide,
    },
    controls: Object.assign({}, boat.o),
    wind: Object.assign({}, boat.wind.o),
    scene: {
      camera: CAMS[camMode], autopilot: autopilot, apHeading: apHeading,
      debug: debugOn,
    },
    telemetry: Object.assign({}, t, { strips: undefined }),
    strips: (t.strips || []).map(s => Object.assign({}, s)),
    rig: boat.strips.map(s => ({
      h: s.h, area: s.area, chord: s.chord, xLuff: s.xLuff,
      ar: s.ar, twistF: s.twistF,
    })),
    trace: recorder.dump(),
  };
}

function saveDump() {
  const name = 'sv20-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(dumpState(), null, 1)],
                        { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  const btn = document.getElementById('dump');
  if (btn) {
    btn.textContent = 'записано: ' + recorder.frames.length + ' кадров';
    setTimeout(() => { btn.textContent = 'Сдампать состояние'; }, 2200);
  }
}

// --- акватория: рельеф, покров, дальняя вода ----------------------------------
//
// Всё, что ниже, включается только когда есть пакет акватории. Без него ничего
// не создаётся вовсе, и сцена остаётся прежней — бесконечная вода со знаками.
//
// Оси: земля кладётся в те же, в которых ездит лодка, — three = (x, высота, y),
// X на восток, Y на север. Ошибка знака по Y отражает участок зеркально, и
// глазом это не ловится совершенно: река на месте, берега на месте. Ловится
// оно проверкой в tests/terrain.test.mjs и одним взглядом на то, какой берег
// высокий, — правый, южный.

// Гипсометрическая шкала земли: от поймы к плато, отсчёт от УРЕЗА, а не от
// нуля высот. На реке значение имеет высота над водой, а не над Балтикой.
// Та же, что в просмотрщике акватории, — одна картина местности на оба.
const LAND_RAMP = [
  [0.0, 0x4d6b4a], [6.0, 0x6f8352], [18.0, 0x8b9159],
  [40.0, 0xa89a6c], [80.0, 0xc0b189], [140.0, 0xdcd5c0],
];

// Ячеек в куске сетки. Двести с лишним кусков со своими габаритами: камера
// стоит в полутора метрах над водой, и половина участка либо за горизонтом,
// либо за ближним берегом. Отбраковку по пирамиде видимости делает сам three,
// от нас требуется только не отдавать ему всё одним объектом.
const CHUNK = 48;

function buildTerrainScene() {
  const P = TERRAIN_PACK;
  const NX = P.nx, NY = P.ny, STEP = P.step, LEVEL = P.level;
  const H = terrain.height, COVER = terrain.cover, SDF = terrain.sdf;
  const group = new Group();
  const ca = new Color(), cb = new Color(), cc = new Color();

  const tint = dh => {
    let i = 0;
    while (i < LAND_RAMP.length - 2 && dh > LAND_RAMP[i + 1][0]) i++;
    const [a, hexA] = LAND_RAMP[i], [b, hexB] = LAND_RAMP[i + 1];
    const t = Math.max(0, Math.min(1, (dh - a) / (b - a)));
    return ca.setHex(hexA).lerp(cb.setHex(hexB), t);
  };

  const gx = k => P.x0 + (k % NX) * STEP;
  const gy = k => P.y0 + ((k / NX) | 0) * STEP;

  // Земля куском. Дно под водой красится своим цветом: иначе мель читается как
  // суша, и вся береговая черта теряет смысл.
  const landChunk = (ix0, iy0, nx, ny) => {
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    for (let j = 0, v = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, v++) {
        const k = (iy0 + j) * NX + ix0 + i;
        pos[v * 3] = gx(k); pos[v * 3 + 1] = H[k] / 10; pos[v * 3 + 2] = gy(k);
        const t = SDF[k] > 128 ? cc.setHex(0x2f4a52) : tint(H[k] / 10 - LEVEL);
        col[v * 3] = t.r; col[v * 3 + 1] = t.g; col[v * 3 + 2] = t.b;
      }
    const idx = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
        // Намотка против часовой при взгляде сверху. Проверять это надо на
        // бумаге, а не на глаз: «очевидный» порядок обхода даёт нормали вниз,
        // вся суша уходит в отбраковку задних граней, и экран показывает
        // пустую воду, а не вывернутый рельеф.
        idx.push(a, d, b, b, d, e);
      }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new Mesh(g, new MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.0 }));
  };

  // Лес и застройка — отдельной геометрией, а не вмятые в рельеф высотами.
  // Крышка по верху слоя и вертикальные стенки там, где массив кончается: с
  // воды квартал и опушка читаются сплошной стеной, а не набором коробок.
  const coverChunk = (ix0, iy0, nx, ny, cls, colour) => {
    const vp = [], vi = [], node = new Map();
    const capped = (i, j) => {
      if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return false;
      const k = (iy0 + j) * NX + ix0 + i;
      return (COVER[k] >> 6) === cls && (COVER[k + 1] >> 6) === cls &&
             (COVER[k + NX] >> 6) === cls && (COVER[k + NX + 1] >> 6) === cls;
    };
    const ytop = k => H[k] / 10 + (COVER[k] & 0x3F);
    const put = k => {
      let n = node.get(k);
      if (n === undefined) { n = vp.length / 3; node.set(k, n); vp.push(gx(k), ytop(k), gy(k)); }
      return n;
    };
    const wall = (k1, k2) => {
      const n = vp.length / 3;
      vp.push(gx(k1), H[k1] / 10, gy(k1), gx(k2), H[k2] / 10, gy(k2),
              gx(k2), ytop(k2), gy(k2), gx(k1), ytop(k1), gy(k1));
      vi.push(n, n + 1, n + 2, n, n + 2, n + 3);
    };
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        if (!capped(i, j)) continue;
        const k = (iy0 + j) * NX + ix0 + i;
        const p0 = put(k), p1 = put(k + 1), p2 = put(k + NX + 1), p3 = put(k + NX);
        vi.push(p0, p3, p1, p1, p3, p2);
        if (!capped(i, j - 1)) wall(k, k + 1);
        if (!capped(i, j + 1)) wall(k + NX, k + NX + 1);
        if (!capped(i - 1, j)) wall(k, k + NX);
        if (!capped(i + 1, j)) wall(k + 1, k + NX + 1);
      }
    if (!vi.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(vp), 3));
    g.setIndex(vi);
    g.computeVertexNormals();
    // DoubleSide намеренно: намотка стенок зависит от того, с какой стороны
    // ячейки они выросли, и разбираться с восемью случаями ради отбраковки,
    // которая тут ничего не экономит, — не та цена.
    return new Mesh(g, new MeshStandardMaterial({
      color: colour, roughness: 0.92, metalness: 0.0, side: DoubleSide }));
  };

  let tris = 0;
  for (let iy0 = 0; iy0 < NY - 1; iy0 += CHUNK)
    for (let ix0 = 0; ix0 < NX - 1; ix0 += CHUNK) {
      const nx = Math.min(CHUNK + 1, NX - ix0), ny = Math.min(CHUNK + 1, NY - iy0);
      if (nx < 2 || ny < 2) continue;
      for (const m of [landChunk(ix0, iy0, nx, ny),
                       coverChunk(ix0, iy0, nx, ny, 1, 0x2f4a26),
                       coverChunk(ix0, iy0, nx, ny, 2, 0x8c8377)]) {
        if (!m) continue;
        tris += m.geometry.index.count / 3;
        group.add(m);
      }
    }

  scene.add(group);
  return { group: group, triangles: tris };
}

const terrainScene = terrain.ready ? buildTerrainScene() : null;
if (terrainScene) {
  console.log('акватория: %d кусков, %s тыс. треугольников',
              terrainScene.group.children.length,
              (terrainScene.triangles / 1000).toFixed(0));
}

// Акватория стоит на настоящих высотах над эллипсоидом, а лодка — на нуле.
// Проще опустить участок к нулю, чем поднимать лодку: у лодки в нуле сидят и
// волны, и след, и знаки.
if (terrainScene) terrainScene.group.position.y = -TERRAIN_PACK.level;

// --- линии тока вокруг парусов ------------------------------------------------
//
// То, что в трубе показывают дымом. Вихревая решётка умеет считать наведённую
// скорость в любой точке, а не только на самих панелях, — значит можно взять
// сетку точек с наветра и повести их по потоку. Видно сразу и подпор перед
// парусами, и разгон в щели между гротом и стакселем, и скос за задней
// шкаториной: то есть именно то, ради чего решётка и заводилась и чего по
// числам не понять.
//
// Линии живут в горизонтной системе лодки — той же, в которой считает риг:
// курс есть, крена нет. Поэтому у них своя группа.
// Линия — не отрезок, а трубка.
//
// Отрезок WebGL везде рисует в один пиксель, толщина не задаётся, и на воде
// такие линии не читаются вовсе. Готовые «толстые линии» для three.js
// (Line2/LineMaterial) раздувают отрезок в экранных координатах вершинным
// шейдером; здесь рендерер узловой, и городить свой шейдер ради этого незачем —
// пятигранная трубка даёт то же самое и обходится геометрией.
//
// У трубки есть и второе достоинство, ради которого она и выбрана. Грани
// закрашиваются по своему наклону к условному свету, и у линии сам собой
// появляется тёмный кант. Без него никакая палитра не читается сразу и на
// тёмной воде, и на белом парусе — светлое пропадает на парусе, тёмное на воде.
// Шаг вдвое мельче полного: длина линии та же, звеньев вдвое больше. Дело не
// только в гладкости трубки — этим же шагом линия и интегрируется, и на
// тугих завитках сходящей пелены крупный шаг срезал углы.
const FLOW_LINES = 26, FLOW_STEPS = 48, FLOW_DS = 0.275;
const FLOW_SEED = 4.5;        // насколько выше по потоку начинать, м
const FLOW_SIDES = 5;
const FLOW_R = 0.032;         // радиус трубки, м
const FLOW_PTS = FLOW_STEPS + 1;
const FLOW_LIGHT = [0.35, 0.86, 0.37];   // куда смотрит условный свет

// Палитра расходящаяся, и это не украшение, а то же самое решение, что и у
// трубки: показывать надо ОТКЛОНЕНИЕ от набегающего потока, а не саму скорость.
// Поэтому середина шкалы — набегающий поток, и она нейтральная; холодный полюс
// — подпор перед парусом, тёплый — разгон в щели.
//
// Числа не подобраны на глаз. Полюса взяты голубой и янтарный: они
// противоположны по теплу, различимы при любом виде дальтонизма (ΔE 19 при
// нормальном зрении, 8 при дейтеранопии) и оба выше 3:1 на воде. Середина —
// чистый серый и заметно ТЕМНЕЕ полюсов: во-первых, у расходящейся шкалы
// светлота обязана расти к обоим краям, чтобы величина отклонения читалась и
// без цвета; во-вторых, светлая середина сливалась с белым парусом — на
// картинке нельзя было отличить поток от полотна.
const FLOW_SLOW = [0.247, 0.816, 0.910];   // #3fd0e8
const FLOW_MID = [0.561, 0.561, 0.561];    // #8f8f8f
const FLOW_FAST = [0.961, 0.647, 0.141];   // #f5a524
// Размах шкалы: на сколько долей набегающей растянуты полюса. Взят по самому
// полю, а не на глаз. Между пятью и девяноста пятью процентами точек скорость
// лежит в пределах 0.90…1.15 набегающей; при размахе 0.45 в эту вилку попадала
// только середина шкалы, и картинка выходила сплошь серой. При 0.25 обычное
// отклонение красится вполсилы, а полностью — только там, где поток и правда
// стоит или разгоняется вдвое: перед шкаториной и в щели.
const FLOW_SPAN = 0.25;

const flowGroup = new Group();
scene.add(flowGroup);

function flowGeometry() {
  const nv = FLOW_LINES * FLOW_PTS * FLOW_SIDES;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(nv * 3), 3));
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(nv * 3), 3));
  const idx = [];
  for (let l = 0; l < FLOW_LINES; l++) {
    for (let k = 0; k < FLOW_STEPS; k++) {
      const a = (l * FLOW_PTS + k) * FLOW_SIDES, b = a + FLOW_SIDES;
      for (let s = 0; s < FLOW_SIDES; s++) {
        const s2 = (s + 1) % FLOW_SIDES;
        idx.push(a + s, b + s, b + s2, a + s, b + s2, a + s2);
      }
    }
  }
  g.setIndex(idx);
  return g;
}
const flowGeo = flowGeometry();
// Две прорисовки одной геометрии. Первая — как есть, с тестом глубины: линии
// прячутся за парусами и корпусом, как всякое тело. Вторая — поверх всего и
// еле видная: она и даёт увидеть поток за парусом, не ломая при этом ощущение
// объёма. Приём известный, и он надёжнее полупрозрачных линий, у которых
// порядок отрисовки всё время не тот.
const flow = new Mesh(flowGeo, new MeshBasicMaterial({ vertexColors: true }));
flow.frustumCulled = false;
flowGroup.add(flow);
const flowGhost = new Mesh(flowGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.16,
  depthTest: false, depthWrite: false }));
flowGhost.frustumCulled = false;
flowGhost.renderOrder = 6;
flowGroup.add(flowGhost);
const flowV = [0, 0, 0];

function updateFlow() {
  const lat = boat.lattice;
  const aw = boat.apparentWind();
  const V = Math.hypot(aw.x, aw.y);
  const p = flowGeo.attributes.position.array;
  const c = flowGeo.attributes.color.array;
  if (V < 0.3) { flowGeo.setDrawRange(0, 0); return; }
  const ux = aw.x / V, uy = aw.y / V;          // куда дует
  const px = -uy, py = ux;                     // поперёк потока
  const rigX = rig.ce_x_m, rigZ = rig.ce_height_m;
  let at = 0;
  for (let i = 0; i < FLOW_LINES; i++) {
    // Засев: сетка поперёк потока, с наветра от рига. Начинать дальше незачем —
    // до паруса поток идёт прямо, и длинные прямые хвосты только загораживают
    // лодку.
    const row = i % 2, col = (i - row) / 2;
    const lat0 = (col / (FLOW_LINES / 2 - 1) - 0.5) * 6.0;
    const h = row ? rigZ * 0.45 : rigZ * 1.05;
    let x = rigX - ux * FLOW_SEED + px * lat0;
    let y = -uy * FLOW_SEED + py * lat0;
    let z = h;
    for (let k = 0; k <= FLOW_STEPS; k++) {
      lat.induced(x, y, z, ux, uy, 0, true, flowV);
      const vx = aw.x + flowV[0], vy = aw.y + flowV[1], vz = flowV[2];
      const sp = Math.hypot(vx, vy, vz) || 1;
      // Касательная в осях отрисовки: X в нос, Y вверх, Z вправо.
      const tx = vx / sp, ty = vz / sp, tz = vy / sp;
      // Поперечный репер. Линии тока почти горизонтальны, так что мировая
      // вертикаль годится за опорную и вырождения не даёт.
      let ax = -tz, ay = 0, az = tx;
      const al = Math.hypot(ax, az) || 1;
      ax /= al; az /= al;
      const bx = ty * az - ay, by = tz * ax - tx * az, bz = -ty * ax;

      const t = Math.max(-1, Math.min(1, (sp / V - 1) / FLOW_SPAN));
      const lo = t < 0 ? FLOW_SLOW : FLOW_FAST;
      const w = Math.abs(t);
      const cr = FLOW_MID[0] + (lo[0] - FLOW_MID[0]) * w;
      const cg = FLOW_MID[1] + (lo[1] - FLOW_MID[1]) * w;
      const cb = FLOW_MID[2] + (lo[2] - FLOW_MID[2]) * w;

      for (let s = 0; s < FLOW_SIDES; s++) {
        const a = 2 * Math.PI * s / FLOW_SIDES;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = ax * ca + bx * sa, ny = ay * ca + by * sa, nz = az * ca + bz * sa;
        const o = at * 3;
        p[o] = x + nx * FLOW_R;
        p[o + 1] = z + ny * FLOW_R;
        p[o + 2] = y + nz * FLOW_R;
        // Затенение по нормали грани: сверху светлее, снизу темнее. Отсюда и
        // кант, который держит линию читаемой на любом фоне.
        const d = nx * FLOW_LIGHT[0] + ny * FLOW_LIGHT[1] + nz * FLOW_LIGHT[2];
        const sh = 0.52 + 0.48 * (0.5 + 0.5 * d);
        c[o] = cr * sh; c[o + 1] = cg * sh; c[o + 2] = cb * sh;
        at++;
      }
      if (k === FLOW_STEPS) break;
      x += tx * FLOW_DS;
      z = Math.max(0.15, z + ty * FLOW_DS);
      y += tz * FLOW_DS;
    }
  }
  flowGeo.attributes.position.needsUpdate = true;
  flowGeo.attributes.color.needsUpdate = true;
}

let debugOn = false;
function setDebug(on) {
  debugOn = on;
  // Паруса приспускаются в прозрачность только в отладочном виде: там сквозь
  // них угадывается и поток, и колдунчик с подветренной стороны. В обычном
  // полотно должно быть полотном.
  //
  // `transparent` переключается вместе с прозрачностью, а не остаётся всегда
  // включённым: у прозрачного материала своя очередь отрисовки, с сортировкой
  // по дальности, и держать в ней непрозрачный парус незачем. Смена флага
  // требует пересборки программы — отсюда needsUpdate.
  for (const m of [mainSail.material, jibSail.material]) {
    m.transparent = on;
    m.opacity = on ? 0.9 : 1;
    m.needsUpdate = true;
  }
  field.visible = on;
  battens.visible = on;
  flow.visible = on;
  flowGhost.visible = on;
  document.getElementById('rigcard').hidden = !on;
}

// ---------------------------------------------------------------- ввод

// Старт: галфвинд, шкот под него, ход близкий к установившемуся и включённый
// авторулевой. Без этого лодка первым делом уваливается в фордевинд, где
// парус работает одним сопротивлением, — и посмотреть на её поведение
// не получается, пока не возьмёшь руль.
const boat = new Boat(PACK, terrain);
const START_TWA = 90 * D;
boat.o.sheet = 24 * D;

// Где лодка стоит в начале и куда возвращается по сбросу.
//
// На бесконечной воде это начало координат — там всё равно, где стоять. На
// акватории начало координат — центр квадрата, а он с равным успехом может
// оказаться сушей, и у SV20 на этом участке так и есть. Вставать надо на
// середину самого широкого плёса: она посчитана выгрузкой и лежит в пакете.
function startAt() {
  boat.reset();
  if (terrain.ready) {
    boat.x = TERRAIN_PACK.open_water[0];
    boat.y = TERRAIN_PACK.open_water[1];
  }
  boat.psi = boat.o.windDir - START_TWA;
  boat.u = 4.0;
}
startAt();
let autopilot = true;
let apHeading = boat.psi;

const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code))
    e.preventDefault();
  // Сброс переехал на X: R с F теперь стаксель-шкот.
  if (e.code === 'KeyX') {
    startAt();
    apHeading = boat.psi;
    wakePts.length = 0;
    trackN = 0;
  }
  if (e.code === 'KeyH') { autopilot = !autopilot; apHeading = boat.psi; }
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyG') setDebug(!debugOn);
  // Подсказки прячутся по умолчанию: карточка длинная и закрывала собой
  // ползунки условий, а нужна она один раз — прочитать и убрать.
  if (e.key === '?' || e.key === '/') {
    const n = document.getElementById('note');
    n.hidden = !n.hidden;
    document.body.classList.toggle('hints', !n.hidden);
  }
  // Не D: она занята рулём вместе со стрелкой вправо (WASD), и дамп
  // сохранялся на каждое нажатие при повороте. P далеко от обеих рук.
  if (e.code === 'KeyP') saveDump();
});
addEventListener('keyup', e => { keys[e.code] = false; });

const ui = {};
for (const id of ['wind', 'winddir', 'hike', 'sailscale', 'gust', 'twist', 'draft',
                  'fetch', 'fetchover'])
  ui[id] = document.getElementById(id);

const capFetch = document.getElementById('v-fetch');
// Галочка есть только когда есть акватория: без неё переопределять нечего.
if (!terrain.ready && ui.fetchover) ui.fetchover.closest('label').querySelector('input[type=checkbox]').hidden = true;

// «Сверху» и «с высоты» — не одно и то же, и обе нужны. Первая с двадцати
// восьми метров: видно лодку, её след и ближайшую сотню метров воды, то есть
// как она идёт. Вторая с полукилометра: видно, где ты на реке — какой берег
// ближе, куда уходит плёс, докуда достаёт следующий галс. На бесконечной воде
// второй смысла не было вовсе, с акваторией она главная.
const CAMS = ['погоня', 'сбоку', 'с борта', 'сверху', 'с высоты', 'свободная'];
// Километр с лишним: в кадр входит около двух километров реки, то есть плёс
// целиком с обоими берегами. Туман на такой высоте приходится отодвигать —
// он настроен на взгляд с воды, где всё интересное в километре, а отсюда в
// километре начинается сама картинка.
const HIGH_CAM_UP = 1200;
const HIGH_FOG = [4000, 40000];
const HIGH_CAM = 4;
const FREE_CAM = 5;

// Свободная камера: облёт вокруг лодки мышью. Нужна, чтобы разглядывать
// паруса — из готовых точек их толком не видно, а именно там сейчас вся работа.
//
// Камера следует за лодкой, но не за её курсом: иначе при рыскании картинка
// ездит под руками. Целится в середину рига, а не в корпус.
const freeCam = { az: 2.2, el: 0.22, dist: 16, drag: null };

stage.addEventListener('pointerdown', e => {
  if (camMode !== FREE_CAM) return;
  freeCam.drag = { x: e.clientX, y: e.clientY };
  // Захват указателя не обязателен и на некоторых событиях недоступен —
  // например у синтетических. Без него вращение всё равно работает.
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* не беда */ }
});
stage.addEventListener('pointermove', e => {
  if (!freeCam.drag) return;
  freeCam.az += (e.clientX - freeCam.drag.x) * 0.008;
  freeCam.el += (e.clientY - freeCam.drag.y) * 0.006;
  freeCam.el = Math.max(-0.5, Math.min(1.4, freeCam.el));
  freeCam.drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { freeCam.drag = null; });
stage.addEventListener('wheel', e => {
  if (camMode !== FREE_CAM) return;
  e.preventDefault();
  freeCam.dist = Math.max(3, Math.min(90, freeCam.dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });
let camMode = FREE_CAM;
function cycleCam() {
  camMode = (camMode + 1) % CAMS.length;
  document.getElementById('cammode').textContent = CAMS[camMode];
}

// wrapPi берём из physics.js: оба файла вклеиваются в один блок, и второе
// объявление того же имени — синтаксическая ошибка на весь модуль.

function readControls(dt) {
  const o = boat.o;
  let target = 0;
  // Положительный угол пера уводит корму вправо и, значит, нос влево.
  const left = keys.ArrowLeft || keys.KeyA;
  const right = keys.ArrowRight || keys.KeyD;
  // Взялся за руль — авторулевой отключается сам. Иначе он молча перебивает
  // стрелки, и создаётся полное впечатление, что управление не работает.
  if (left || right) autopilot = false;
  if (left) target = 35 * D;
  if (right) target = -35 * D;
  if (autopilot) {
    const err = wrapPi(apHeading - boat.psi);
    target = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * boat.r)));
  }
  // Скорость перекладки ограничивает сама лодка (physics.js): это её
  // свойство, а не интерфейса.
  o.rudderTarget = (!target && !autopilot) ? 0 : target;

  const sr = 32 * D;
  if (keys.ArrowUp || keys.KeyW) o.sheet -= sr * dt;
  if (keys.ArrowDown || keys.KeyS) o.sheet += sr * dt;
  // Ближе семи градусов шкот не выбирается: мешают ванты и погон.
  o.sheet = Math.max(7 * D, Math.min(90 * D, o.sheet));
  // Стаксель-шкот отдельно, поправкой к общему: R добрать, F потравить. Свой
  // упор острее диаметральной у стакселя всё равно остаётся — его ставит
  // каретка на погоне (physics.js), — так что дальше него не добрать.
  if (keys.KeyR) o.jibTrim -= sr * dt;
  if (keys.KeyF) o.jibTrim += sr * dt;
  o.jibTrim = Math.max(-30 * D, Math.min(55 * D, o.jibTrim));

  o.windSpeed = parseFloat(ui.wind.value);
  const wd = parseFloat(ui.winddir.value) * D;
  if (autopilot) apHeading += wd - o.windDir;   // ветер повернули — держим TWA
  o.windDir = wd;
  o.crewHike = parseFloat(ui.hike.value);
  o.crewMass = o.crewHike > 0 ? 240 : 0;
  o.sailScale = parseFloat(ui.sailscale.value);
  o.twist = parseFloat(ui.twist.value) * D;
  o.draft = parseFloat(ui.draft.value) / 100;
  // Разгон: с акваторией его задаёт место, а ползунок становится
  // переопределением. Без акватории галочка не нужна и не показывается — там
  // ползунок и есть единственный источник.
  o.fetch = parseFloat(ui.fetch.value) * 1000;
  o.fetchOverride = !terrain.ready || ui.fetchover.checked;
  ui.fetch.disabled = terrain.ready && !ui.fetchover.checked;
  // Когда разгон задаёт место, подпись показывает его настоящую величину, а не
  // положение отключённого ползунка. Это и есть смысл акватории на панели: на
  // одном галсе полкилометра, на другом три с половиной.
  if (terrain.ready && !ui.fetchover.checked && capFetch) {
    const t = boat.telemetry;
    capFetch.textContent = t && t.fetchField
      ? (t.fetchM / 1000).toFixed(1) + ' км по месту'
      : 'вне участка';
  }
  // Порывистость одним ползунком: сильнее дует — сильнее и заходит. Порознь
  // эти две вещи на воде не встречаются, а два ползунка вместо одного только
  // мешают понять, что происходит.
  const gust = parseFloat(ui.gust.value);
  boat.wind.o.gust = gust;
  boat.wind.o.shift = gust * 45 * D;
}

// ---------------------------------------------------------------- цикл

let acc = 0, last = performance.now() / 1000, tick = 0;
const camPos = new Vector3(-14, 5, 0);
const camAim = new Vector3();
const prev = { x: 0, y: 0, psi: 0, phi: 0 };

function resize() {
  const r = stage.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  renderer.setSize(r.width, r.height, true);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
// Одного вызова мало: на момент запуска модуля раскладка ещё может не
// устояться, и холст остаётся размером в угол экрана. ResizeObserver ловит
// это надёжнее, чем окно.
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(stage);
resize();

function frame() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.25, now - last);
  last = now;
  acc += dt;

  let steps = 0;
  while (acc >= DT && steps < 8) {
    prev.x = boat.x; prev.y = boat.y; prev.psi = boat.psi; prev.phi = boat.phi;
    readControls(DT);
    boat.step(DT);
    if (![boat.x, boat.y, boat.psi, boat.phi, boat.u, boat.v].every(Number.isFinite)) {
      boat.reset(); boat.u = 1;
      const box = document.getElementById('crash');
      box.hidden = false;
      box.textContent = 'Физика разошлась, состояние сброшено. Проверьте make test.';
      acc = 0;
      break;
    }
    recorder.push(boat);
    acc -= DT;
    steps++;
  }
  const a = Math.min(1, acc / DT);
  const ix = prev.x + (boat.x - prev.x) * a;
  const iy = prev.y + (boat.y - prev.y) * a;
  const ipsi = prev.psi + wrapPi(boat.psi - prev.psi) * a;
  const iphi = prev.phi + (boat.phi - prev.phi) * a;
  const t = boat.telemetry || {};

  boatGroup.position.set(ix, 0, iy);
  boatGroup.rotation.order = 'YXZ';
  boatGroup.rotation.y = -ipsi;
  boatGroup.rotation.x = -iphi;
  rudderPivot.rotation.y = -boat.o.rudder;

  // Борт паруса берём у физики: там он с запасом на перекидывание и меняется
  // за конечное время, так что гик переходит плавно, а не телепортируется.
  // До первого шага физики он ещё не поставлен.
  const side = boat.rigSide != null ? boat.rigSide : 1;
  shapeSails(side);

  const amp = 0.10 + 0.035 * boat.o.windSpeed;
  sea.position.set(Math.round(ix / CELL) * CELL, 0, Math.round(iy / CELL) * CELL);
  const dirX = Math.cos(boat.o.windDir), dirZ = Math.sin(boat.o.windDir);
  const pos = seaGeo.attributes.position.array;
  for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
    pos[i + 1] = seaAmp[v] === 0 ? 0
      : waveHeight(seaBase[i] + sea.position.x, seaBase[i + 2] + sea.position.z,
                   now, dirX, dirZ, amp * seaAmp[v]);
  }
  seaGeo.attributes.position.needsUpdate = true;
  if ((tick & 1) === 0) seaGeo.computeVertexNormals();
  seaGust.value = boat.wind.o.gust;
  seaWindDir.value = boat.wind.o.dir;
  seaWindSpeed.value = boat.wind.o.speed;
  seaTime.value = boat.t;
  updateGrid(ix, iy, now, dirX, dirZ, amp);
  if (debugOn) {
    updateField(ix, iy, now);
    updateBattens(side);
    // Линии тока считаются по всей решётке в каждой точке — это дорого, и
    // каждый кадр не нужно: поток меняется не быстрее самой лодки.
    flowGroup.position.set(ix, 0, iy);
    flowGroup.rotation.y = -ipsi;
    if ((tick % 12) === 0) updateFlow();
  }

  const spd = t.speed || 0;
  if ((tick % 2) === 0) {
    wakePts.unshift({
      x: ix - 2.9 * Math.cos(ipsi), z: iy - 2.9 * Math.sin(ipsi),
      psi: ipsi, w: 0.30 + 0.07 * spd });
    if (wakePts.length > WAKE) wakePts.length = WAKE;
  }
  const wp = wakeGeo.attributes.position.array;
  const wc = wakeGeo.attributes.color.array;
  for (let i = 0; i < wakePts.length; i++) {
    const p = wakePts[i];
    const f = 1 - i / WAKE;
    const w = p.w * (0.8 + 0.9 * (1 - f));
    const nx = -Math.sin(p.psi), nz = Math.cos(p.psi);
    wp[i * 6] = p.x + nx * w; wp[i * 6 + 1] = 0.05; wp[i * 6 + 2] = p.z + nz * w;
    wp[i * 6 + 3] = p.x - nx * w; wp[i * 6 + 4] = 0.05; wp[i * 6 + 5] = p.z - nz * w;
    const b = f * f * Math.min(1, spd / 3);
    for (let k = 0; k < 6; k++) wc[i * 6 + k] = 0.75 + 0.25 * b;
  }
  // Рисуем только накопленные звенья: иначе хвост схлопывается в одну точку
  // и получается веер поперёк всей акватории.
  wakeGeo.setDrawRange(0, Math.max(0, (wakePts.length - 1) * 6));
  wakeGeo.attributes.position.needsUpdate = true;
  wakeGeo.attributes.color.needsUpdate = true;
  wake.material.opacity = 0.12 + 0.45 * Math.min(1, spd / 4);

  if ((tick % 6) === 0 && trackN < TRACK) {
    const tp = trackGeo.attributes.position.array;
    tp[trackN * 3] = ix; tp[trackN * 3 + 1] = 0.06; tp[trackN * 3 + 2] = iy;
    trackN++;
    trackGeo.setDrawRange(0, trackN);
    trackGeo.attributes.position.needsUpdate = true;
  }

  arrow.position.set(ix + 4 * Math.cos(boat.o.windDir), 6.2,
                     iy + 4 * Math.sin(boat.o.windDir));
  arrow.rotation.y = Math.PI - boat.o.windDir;

  // Орты лодки в сцене: куда смотрит нос и где правый борт. Через них
  // камеры пишутся без тригонометрии в каждой строке и, главное, без шанса
  // случайно поставить камеру не с того борта.
  const bx = ix, bz = iy;
  const fx = Math.cos(ipsi), fz = Math.sin(ipsi);      // в нос
  const sx = -Math.sin(ipsi), sz = Math.cos(ipsi);     // на правый борт
  const at = (fwd, stb, h) =>
    new Vector3(bx + fwd * fx + stb * sx, h, bz + fwd * fz + stb * sz);
  let want;
  if (camMode === 0) want = at(-13, 2.5, 4.6);
  else if (camMode === 1) want = at(-2, 5, 3.0);
  else if (camMode === 2) want = at(-1.2, 1.0, 1.9);
  else if (camMode === 3) want = at(-2, 0, 28);
  else if (camMode === HIGH_CAM) want = at(-60, 0, HIGH_CAM_UP);
  else {
    // Свободная: сферические координаты вокруг лодки, в мировых осях.
    const c = Math.cos(freeCam.el), d = freeCam.dist;
    want = new Vector3(bx + d * c * Math.cos(freeCam.az),
                       rig.mast_height_m * 0.35 + d * Math.sin(freeCam.el),
                       bz + d * c * Math.sin(freeCam.az));
  }
  // Туман зависит от вида: с воды он в километре, с высоты в четырёх.
  if (scene.fog) {
    const hi = camMode === HIGH_CAM;
    scene.fog.near = hi ? HIGH_FOG[0] : (FAR_WATER ? 900 : 110);
    scene.fog.far = hi ? HIGH_FOG[1] : (FAR_WATER ? 14000 : 420);
  }
  const aim = camMode === FREE_CAM
    ? new Vector3(bx + 1.5 * fx, rig.mast_height_m * 0.35, bz + 1.5 * fz)
    : at(2, 0, camMode === 3 || camMode === HIGH_CAM ? 0 : 1.4);
  // Свободную камеру не сглаживаем: под рукой она должна ходить сразу.
  if (camMode === FREE_CAM) { camPos.copy(want); camAim.copy(aim); }
  else {
    camPos.lerp(want, 1 - Math.pow(camMode === 2 ? 1e-7 : 0.004, dt));
    camAim.lerp(aim, 1 - Math.pow(0.004, dt));
  }
  camera.position.copy(camPos);
  camera.lookAt(camAim);

  renderer.render(scene, camera);
  if ((tick % 3) === 0) { updateHud(t); updateRose(t); if (debugOn) updateRig(t); }
  tick++;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- приборы

const HUD_ROWS = [
  ['vmg', 'VMG', 'уз', 2],
  ['heelDeg', 'Крен', '°', 1],
  ['leewayDeg', 'Дрейф', '°', 1],
  ['twaAbsDeg', 'Истинный ветер', '°', 0],
  ['awaDeg', 'Кажущийся', '°', 0],
  ['awsKn', 'Скорость кажущегося', 'уз', 1],
  ['alphaDeg', 'Угол атаки паруса', '°', 1],
  ['driveN', 'Тяга', 'Н', 0],
  ['resistN', 'Сопротивление', 'Н', 0],
];

function updateHud(t) {
  if (!t) return;
  const rows = HUD_ROWS.map(([k, label, unit, prec]) =>
    '<tr><td>' + label + '</td><td class="v">' +
    (t[k] == null ? '—' : (+t[k]).toFixed(prec)) +
    '</td><td class="u">' + unit + '</td></tr>').join('');
  // «Перебрано» имеет смысл только на острых курсах: на полных парус работает
  // сорванным, и это норма, а не ошибка настройки.
  const al = t.alphaDeg || 0;
  const luff = al < 3 ? ' <em>полощет</em>'
             : ((t.awaDeg || 0) < 80 && al > 24 ? ' <em>перебрано</em>' : '');
  hud.innerHTML =
    '<div class="big">' + (t.speedKn || 0).toFixed(2) + ' <span>уз</span></div>' +
    '<table>' + rows + '</table>' +
    '<div class="ctl">руль ' + (boat.o.rudder / D).toFixed(0) +
    '°&nbsp;&nbsp;шкот ' + (boat.o.sheet / D).toFixed(0) + '°' +
    (Math.abs(boat.o.jibTrim) > 0.5 * D
      ? '&nbsp;&nbsp;стаксель ' + (boat.o.jibTrim > 0 ? '+' : '') +
        (boat.o.jibTrim / D).toFixed(0) + '°' : '') + luff +
    (autopilot ? '&nbsp;&nbsp;<b>авторулевой</b>' : '') + '</div>';
}

// Роза: лодка всегда носом вверх, стрелки показывают, откуда дует истинный и
// кажущийся ветер, серая линия — положение паруса. По ней видно, добран шкот
// или вынесен, не заглядывая в цифры.
function updateRose(t) {
  if (!t) return;
  const R = 46;
  // Ноль наверху — нос, положительный угол вправо, то есть на правый борт.
  const pt = (ang, r) => [56 + r * Math.sin(ang), 56 - r * Math.cos(ang)];
  // Ветер справа — вектор кажущегося дует на левый борт, то есть ay < 0.
  const stbd = boat.apparentWind().angle > 0 ? -1 : 1;
  const tw = (t.twaAbsDeg || 0) * D * stbd;
  const aw = (t.awaDeg || 0) * D * stbd;
  const [tx, ty] = pt(tw, R - 3);
  const [ax, ay] = pt(aw, R - 3);
  // Парус вынесен под ветер, то есть на борт, противоположный ветру.
  const [sx, sy] = pt(Math.PI + boat.o.sheet * stbd, R - 16);
  rose.innerHTML =
    '<circle cx="56" cy="56" r="46" class="ring"/>' +
    '<circle cx="56" cy="56" r="30" class="ring2"/>' +
    '<path d="M56 20 L67 76 L56 68 L45 76 Z" class="boat"/>' +
    '<line x1="56" y1="56" x2="' + sx.toFixed(1) + '" y2="' + sy.toFixed(1) +
      '" class="sail"/>' +
    '<line x1="' + tx.toFixed(1) + '" y1="' + ty.toFixed(1) +
      '" x2="56" y2="56" class="tw"/>' +
    '<line x1="' + ax.toFixed(1) + '" y1="' + ay.toFixed(1) +
      '" x2="56" y2="56" class="aw"/>';
}

// Панель рига: что происходит по высоте паруса.
//
// Четыре столбца с общей вертикальной осью — высотой над водой. Первый
// показывает профиль ветра, второй угол атаки каждой полоски, третий её вклад
// в боковую силу. Вместе они отвечают на вопрос, ради которого всё это и
// делалось: почему верх паруса работает не так, как низ, и что с этим делает
// твист.
//
// Четвёртый — посчитанное мембраной пузо. Оно тут не для красоты: пузо
// показывает, где парус ещё держит форму, а где ткань смялась и он превратился
// в плоскую тряпку. Ноль в этом столбце и есть заполаскивание.
const rigSvg = document.getElementById('rig');
const RIG_W = 96, RIG_H = 132, RIG_PAD = 16;

function updateRig(t) {
  const st = t && t.strips;
  if (!st) return;
  const H = rig.mast_height_m;
  const y = h => RIG_H - RIG_PAD - (h / H) * (RIG_H - 2 * RIG_PAD);
  const main = st.slice(0, 6), jib = st.slice(6);
  let peakDrive = 1e-6;
  for (const s of st) peakDrive = Math.max(peakDrive, Math.abs(s.drive));

  const axis = (col, label, ticks) => {
    let g = '<g transform="translate(' + col * RIG_W + ',0)">' +
      '<text class="cap" x="' + (RIG_W / 2) + '" y="10">' + label + '</text>' +
      '<line class="ax" x1="6" y1="' + y(0) + '" x2="' + (RIG_W - 6) +
      '" y2="' + y(0) + '"/>';
    for (const [tx, tl] of ticks)
      g += '<text class="tick" x="' + tx + '" y="' + (RIG_H - 3) + '">' + tl + '</text>';
    return g;
  };
  const poly = (pts, cls) => '<polyline class="' + cls + '" points="' +
    pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';

  // --- ветер по высоте
  const wMax = Math.max(1, ...st.map(s => s.ws)) * 1.15;
  const xw = v => 8 + (v / wMax) * (RIG_W - 20);
  let svg = axis(0, 'ветер, м/с', [[8, '0'], [RIG_W - 26, wMax.toFixed(0)]]);
  svg += poly(main.map(s => [xw(s.ws), y(s.z)]), 'w') + '</g>';

  // --- угол атаки: ноль и срыв отмечены, между ними парус работает
  const aLo = -20, aHi = 34;
  const xa = v => 8 + ((Math.max(aLo, Math.min(aHi, v)) - aLo) / (aHi - aLo)) *
                      (RIG_W - 20);
  svg += axis(1, 'угол атаки', [[xa(0) - 4, '0'], [xa(18) - 8, '18°']]);
  svg += '<line class="zero" x1="' + xa(0) + '" y1="' + y(H) + '" x2="' +
    xa(0) + '" y2="' + y(0) + '"/>';
  svg += '<line class="stall" x1="' + xa(18) + '" y1="' + y(H) + '" x2="' +
    xa(18) + '" y2="' + y(0) + '"/>';
  svg += poly(main.map(s => [xa(s.alphaDeg), y(s.z)]), 'a') +
         poly(jib.map(s => [xa(s.alphaDeg), y(s.z)]), 'aj');
  for (const s of st)
    svg += '<circle cx="' + xa(s.alphaDeg).toFixed(1) + '" cy="' +
      y(s.z).toFixed(1) + '" r="1.8" fill="rgb(' +
      driveColour(s.drive / peakDrive).map(v => Math.round(v * 255)).join(',') +
      ')"/>';
  svg += '</g>';

  // --- тяга и боковая: расходящиеся столбики от общей середины. Сразу видно,
  // где парус везёт, а где только кренит, — и что на полных курсах это одни и
  // те же полоски, а в лавировку разные.
  const fMax = Math.max(1, ...st.map(s => Math.max(Math.abs(s.side), Math.abs(s.drive))));
  const mid = RIG_W / 2, half = RIG_W / 2 - 8;
  svg += axis(2, 'тяга / боковая', [[10, 'бок'], [RIG_W - 26, 'тяга']]);
  svg += '<line class="ax" x1="' + mid + '" y1="' + y(rig.mast_height_m) +
    '" x2="' + mid + '" y2="' + y(0) + '"/>';
  for (const [arr, dim] of [[main, false], [jib, true]]) {
    for (const s of arr) {
      const yy = (y(s.z) - 2.6).toFixed(1);
      const wd = (Math.abs(s.drive) / fMax) * half;
      const ws = (Math.abs(s.side) / fMax) * half;
      svg += '<rect class="' + (dim ? 'bdj' : 'bd') + '" x="' + mid +
        '" y="' + yy + '" width="' + Math.max(0.4, wd).toFixed(1) + '" height="5.2"/>';
      svg += '<rect class="' + (dim ? 'bj' : 'bm') + '" x="' +
        (mid - Math.max(0.4, ws)).toFixed(1) + '" y="' + yy +
        '" width="' + Math.max(0.4, ws).toFixed(1) + '" height="5.2"/>';
    }
  }
  svg += '</g>';

  // --- пузо: сколько его осталось после того, как посчиталась форма
  const cMax = 0.16;
  const xc = v => 8 + (Math.min(cMax, Math.max(0, v)) / cMax) * (RIG_W - 20);
  svg += axis(3, 'пузо, % хорды', [[8, '0'], [RIG_W - 30, (100 * cMax).toFixed(0)]]);
  svg += poly(main.map(s => [xc(Math.abs(s.camber)), y(s.z)]), 'cam') +
         poly(jib.map(s => [xc(Math.abs(s.camber)), y(s.z)]), 'camj') + '</g>';

  rigSvg.innerHTML = svg;
  document.getElementById('rignote').innerHTML =
    'ЦП по нагрузке <b>' + (t.ceHeightM || 0).toFixed(2) + ' м</b>' +
    ' &nbsp;·&nbsp; твист <b>' + ((boat.twistEff || 0) / D).toFixed(0) + '°</b>' +
    (boat.twistEff > boat.o.twist + 1 * D ? ' <span class="slack">шкот провис</span>' : '') +
    ' &nbsp;·&nbsp; ветер у рига <b>' + (t.twsKn || 0).toFixed(1) + '</b> уз';
}

document.getElementById('cammode').textContent = CAMS[camMode];
document.getElementById('dump').addEventListener('click', saveDump);
// Тот же дамп доступен из консоли — удобно, когда файл забирать некуда:
// copy(JSON.stringify(sv20dump()))
window.sv20dump = dumpState;
shapeSails(1);
setDebug(false);
// WebGPU поднимается асинхронно: устройство запрашивается у системы. До этого
// рисовать нечем, поэтому цикл запускается после init.
renderer.init().then(() => { resize(); frame(); }).catch(err => {
  const box = document.getElementById('crash');
  box.hidden = false;
  box.textContent = 'Не удалось поднять рендерер: ' + (err && err.message || err);
});
