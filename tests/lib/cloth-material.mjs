// Исследовательская энергия поверхности. Не включена в основной режим Cloth.
// Параметры в физических единицах; ни число проходов, ни шаг сюда не входят.
// Растяжение: изотропная энергия Green / Saint-Venant–Kirchhoff.
// Изгиб: изменение второй фундаментальной формы в исходном базисе.
// Старый угловой кандидат с весом 3 l² / (A1 + A2) оставлен для отрицательного контроля.
import { dihedral, dihedralAngle } from '../cloth-compliance.mjs';

// Те же назначенные K/G/B, что у прежнего контрольного участка; не обмер SV20.
export const MODEL_MATERIAL = Object.freeze({ bulkNPerM: 1000, shearNPerM: 50,
  bendingNm: 1, origin: 'назначенные параметры контрольного участка; не измерения SV20' });

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const edge = (p, a, b) => [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1],
  p[3 * b + 2] - p[3 * a + 2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function gridTriangles(rows, cols, oppositeDiagonal = false) {
  if (![rows, cols].every(n => Number.isInteger(n) && n >= 2))
    throw new Error('Сетка поверхности должна иметь не менее двух строк и столбцов');
  const triangles = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    const a = r * cols + c, b = a + 1, e = a + cols, g = e + 1;
    triangles.push(...(oppositeDiagonal ? [[a, b, g], [a, g, e]] : [[a, b, e], [g, e, b]]));
  }
  return triangles;
}

function checkPositions(p, length) {
  if (!p || p.length !== length || !Array.from(p).every(Number.isFinite))
    throw new Error('Некорректные координаты материальной поверхности');
}

function referenceTriangle(reference, indices) {
  const [a, b, c] = indices, e = edge(reference, a, b), f = edge(reference, a, c);
  const l = Math.hypot(...e), area2 = Math.hypot(...cross(e, f));
  if (!(l > 0 && area2 > 1e-12 * l * Math.hypot(...f)))
    throw new Error('Вырожденный треугольник исходной поверхности');
  // Ортонормированный базис плоскости исходного треугольника: e=(l,0), f=(x,y).
  // F = Ds Dm^-1. Смена локального базиса не меняет изотропную энергию.
  const x = dot(e, f) / l, y = area2 / l;
  const bx = [-1 / l, 1 / l, 0], by = [(x / l - 1) / y, -x / (l * y), 1 / y];
  const frame = p => {
    const u = [0, 0, 0], v = [0, 0, 0];
    // Разности уменьшают потерю точности при переносе всей поверхности.
    const eb = edge(p, a, b), ec = edge(p, a, c);
    for (let d = 0; d < 3; d++) {
      u[d] = bx[1] * eb[d]; v[d] = by[1] * eb[d] + by[2] * ec[d];
    }
    return { u, v };
  };
  return { indices: indices.slice(), areaM2: .5 * area2, bx, by, frame };
}

// Один закон энергии для обоих интерфейсов. Корректор может передать свой
// массив градиента; обычный value сохраняет прежний независимый снимок.
function bufferedModes(specs,prepare,native) {
  const valid=(gradient,j)=>gradient instanceof Float64Array&&gradient.length===3*specs[j].indices.length;
  if(native&&(typeof native.valueInto!=='function'||typeof native.singleInto!=='function'))
    throw new Error('Некорректный численный вычислитель группы материала');
  const gradientGroup={size:specs.length,valueInto(p,gradients) {
    if(!Array.isArray(gradients)||gradients.length!==specs.length||gradients.some((g,j)=>!valid(g,j)))
      throw new Error('Нужны численные массивы группы материала правильной длины');
    if(native)return native.valueInto(p,gradients);
    const context=prepare(p);return specs.map((s,j)=>s.evaluateInto(p,gradients[j],context));
  }};
  if(native?.hessianInto)gradientGroup.hessianInto=(p,weights,targets)=>native.hessianInto(p,weights,targets);
  return specs.map(({family,alpha,indices,evaluateInto},j)=>{
    const gradientNodes=Object.freeze(Array.from(indices));
    const valueInto=(p,gradient)=>{
      if(!valid(gradient,j))throw new Error('Нужен численный массив градиента материала правильной длины');
      return native?native.singleInto(p,j,gradient):evaluateInto(p,gradient,prepare(p));
    };
    return {family,alpha,lambda:0,unilateral:false,gradientNodes,valueInto,gradientGroup,gradientSlot:j,
      value(p) {
        const g=new Float64Array(3*gradientNodes.length),C=valueInto(p,g);
        return {C,grad:gradientNodes.map((node,k)=>[node,[g[3*k],g[3*k+1],g[3*k+2]]])};
      }};
  });
}

function membraneMode(triangle, mode, stiffnessNPerM) {
  const { indices, areaM2, bx, by } = triangle;
  return {family:mode===0?'bulk':'shear',alpha:1/(areaM2*stiffnessNPerM),indices,evaluateInto(p,gradient,{u,v}) {
      const uu = dot(u, u), vv = dot(v, v);
      // E = (F^T F - I)/2. Энергия A/2 · [K tr(E)^2 + G (E11-E22)^2 + G (2 E12)^2].
      const C = mode === 0 ? .5 * (uu + vv - 2) : mode === 1 ? .5 * (uu - vv) : dot(u, v);
      const du = mode === 2 ? v : u, dv = mode === 2 ? u : v.map(x => mode === 1 ? -x : x);
      for(let k=0;k<indices.length;k++) {
        const coordinate=3*k,wu=bx[k],wv=by[k];
        gradient[coordinate]=wu*du[0]+wv*dv[0];
        gradient[coordinate+1]=wu*du[1]+wv*dv[1];
        gradient[coordinate+2]=wu*du[2]+wv*dv[2];
      }
      return C;
  }};
}

// Производные на равномерной параметрической сетке. У границы — односторонние
// формулы второго порядка; смешанная производная — произведение первых.
function derivativeWeights(i, n, order) {
  const h = 1 / (n - 1), factor = h ** -order;
  let offsets, weights;
  if (order === 1) {
    offsets = i === 0 ? [0, 1, 2] : i === n - 1 ? [-2, -1, 0] : [-1, 0, 1];
    weights = i === 0 ? [-1.5, 2, -.5] : i === n - 1 ? [.5, -2, 1.5] : [-.5, 0, .5];
  } else {
    offsets = i === 0 ? [0, 1, 2, 3] : i === n - 1 ? [-3, -2, -1, 0] : [-1, 0, 1];
    weights = i === 0 ? [2, -5, 4, -1] : i === n - 1 ? [-1, 4, -5, 2] : [1, -2, 1];
  }
  return offsets.map((offset, k) => [i + offset, weights[k] * factor]);
}

function curvatureModes(reference, triangles, rows, cols, B,compiled) {
  if (![rows, cols].every(n => Number.isInteger(n) && n >= 4) || rows * cols * 3 !== reference.length)
    throw new Error('Для кривизны нужна равномерная параметрическая сетка не менее 4×4');
  const areas = new Float64Array(rows * cols), modes = [];
  for (const triangle of triangles) for (const i of triangle.indices) areas[i] += triangle.areaM2 / 3;
  if (!Array.from(areas).every(a => a > 0)) throw new Error('В сетке кривизны есть узлы без площади');
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const index = r * cols + c, coefficients = new Map();
    const add = (i, slot, value) => {
      if (!coefficients.has(i)) coefficients.set(i, new Float64Array(5));
      coefficients.get(i)[slot] += value;
    };
    for (const [x, w] of derivativeWeights(c, cols, 1)) add(r * cols + x, 0, w);
    for (const [y, w] of derivativeWeights(r, rows, 1)) add(y * cols + c, 1, w);
    for (const [x, w] of derivativeWeights(c, cols, 2)) add(r * cols + x, 2, w);
    for (const [y, w] of derivativeWeights(r, rows, 2)) add(y * cols + c, 3, w);
    for (const [x, wx] of derivativeWeights(c, cols, 1))
      for (const [y, wy] of derivativeWeights(r, rows, 1)) add(y * cols + x, 4, wx * wy);
    const stencil = Array.from(coefficients);
    const centerCoordinate=3*index;
    const derivative = (p, slot) => {
      const out = [0, 0, 0];
      // Сохраняем порядок сумм по узлам и разности с центром. Развёрнутые
      // три оси убирают внутренний цикл и повторное извлечение коэффициента.
      for(let k=0;k<stencil.length;k++) {
        const coordinate=3*stencil[k][0],weight=stencil[k][1][slot];
        out[0]+=weight*(p[coordinate]-p[centerCoordinate]);
        out[1]+=weight*(p[coordinate+1]-p[centerCoordinate+1]);
        out[2]+=weight*(p[coordinate+2]-p[centerCoordinate+2]);
      }
      return out;
    };
    const frame = p => {
      const u = derivative(p, 0), v = derivative(p, 1), n = cross(u, v), length = Math.hypot(...n);
      if (!(length > 1e-12 * Math.hypot(...u) * Math.hypot(...v)))
        throw new Error('Вырожденная нормаль участка кривизны');
      return { u, v, normal: n.map(x => x / length), length };
    };
    const rest = frame(reference), l = Math.hypot(...rest.u), x = dot(rest.u, rest.v) / l, y = rest.length / l;
    // Ковариантная кривизна n·x_ij переводится в ортонормированный ИСХОДНЫЙ
    // базис: Dm^-T b Dm^-1. Вычитаем такой же тензор исходного кроя.
    // Энергия B A / 2 · (Δb11² + Δb22² + 2 Δb12²), без зависимости от диагоналей.
    const combinations = [[1 / (l * l), 0, 0],
      [x * x / (l * l * y * y), 1 / (y * y), -2 * x / (l * y * y)],
      [-Math.SQRT2 * x / (l * l * y), 0, Math.SQRT2 / (l * y)]];
    const specs=[],nativeModes=compiled?[]:null;
    for (const combination of combinations) {
      const weights = stencil.map(([i, w]) => [i, w[0], w[1],
        combination[0] * w[2] + combination[1] * w[3] + combination[2] * w[4]]);
      // second/frame читают разности с центральной точкой. Учитываем ту же
      // операцию в градиенте, включая остаток округления суммы коэффициентов.
      const center = weights.find(([i]) => i === index);
      for (const slot of [1, 2, 3]) center[slot] -= weights.reduce((sum, w) => sum + w[slot], 0);
      const second = p => {
        const out = [0, 0, 0];
        for(let k=0;k<weights.length;k++) {
          const coordinate=3*weights[k][0],weight=weights[k][3];
          out[0]+=weight*(p[coordinate]-p[centerCoordinate]);
          out[1]+=weight*(p[coordinate+1]-p[centerCoordinate+1]);
          out[2]+=weight*(p[coordinate+2]-p[centerCoordinate+2]);
        }
        return out;
      };
      const restCurvature = dot(rest.normal, second(reference));
      if(nativeModes)nativeModes.push({restCurvature,weights:[1,2,3].map(slot=>weights.map(w=>w[slot]))});
      specs.push({family:'bending',alpha:1/(B*areas[index]),indices:weights.map(([i])=>i),evaluateInto(p,gradient,f) {
          const H = second(p), curvature = dot(f.normal, H);
          // Производная нормали: (I-n n^T) / |u×v|; затем обратный ход через u×v.
          const adjN = H.map((value, d) => (value - f.normal[d] * curvature) / f.length);
          const adjU = cross(f.v, adjN), adjV = cross(adjN, f.u);
          // Три оси независимы; порядок трёх слагаемых каждой компоненты
          // сохраняется. Внутренний цикл и извлечение через итератор не нужны.
          for(let k=0;k<weights.length;k++) {
            const coordinate=3*k,wu=weights[k][1],wv=weights[k][2],wh=weights[k][3];
            gradient[coordinate]=wu*adjU[0]+wv*adjV[0]+wh*f.normal[0];
            gradient[coordinate+1]=wu*adjU[1]+wv*adjV[1]+wh*f.normal[1];
            gradient[coordinate+2]=wu*adjU[2]+wv*adjV[2]+wh*f.normal[2];
          }
          return curvature-restCurvature;
      }});
    }
    const native=compiled?.compile({kind:'curvature',center:index,nodes:stencil.map(([node])=>node),
      derivatives:[0,1].map(slot=>stencil.map(([,w])=>w[slot])),modes:nativeModes});
    modes.push(...bufferedModes(specs,frame,native));
  }
  return modes;
}

export function materialSurface(referencePositions, triangleIndices, parameters = MODEL_MATERIAL, options = {}) {
  if (!referencePositions || referencePositions.length < 9 || referencePositions.length % 3)
    throw new Error('Некорректный размер исходной поверхности');
  checkPositions(referencePositions, referencePositions.length);
  if(options.materialKernel!=null&&typeof options.materialKernel.createSurface!=='function')
    throw new Error('Нужна фабрика отдельного вычислителя материала');
  const compiled=options.materialKernel?.createSurface();
  if(options.materialKernel&&(!compiled||typeof compiled.compile!=='function'))throw new Error('Нужна компиляция локальной группы материала');
  const { bulkNPerM: K, shearNPerM: G, bendingNm: B } = parameters;
  if (![K, G, B].every(Number.isFinite) || !(K > 0 && G > 0 && B >= 0))
    throw new Error('Нужны положительные модули Н/м и неотрицательная жёсткость изгиба Н·м');
  const bendingModel = options.bendingModel ?? (B === 0 ? 'hinge' : null);
  if (!bendingModel) throw new Error('Нужно явно выбрать curvature или отрицательный контроль hinge');
  if (!['hinge', 'curvature'].includes(bendingModel)) throw new Error('Неизвестная модель изгиба');
  if (!Array.isArray(triangleIndices) || !triangleIndices.length)
    throw new Error('Отсутствует топология материальной поверхности');
  const reference = Float64Array.from(referencePositions), n = reference.length / 3;
  const edges = new Map(), seen = new Set(), triangles = [], hinges = [], constraints = [];
  for (const indices of triangleIndices) {
    if (!Array.isArray(indices) || indices.length !== 3 || new Set(indices).size !== 3 ||
        indices.some(i => !Number.isInteger(i) || i < 0 || i >= n))
      throw new Error('Некорректные индексы треугольника');
    const key = indices.slice().sort((a, b) => a - b).join(',');
    if (seen.has(key)) throw new Error('Повторный треугольник материальной поверхности');
    seen.add(key);
    const triangle = referenceTriangle(reference, indices); triangles.push(triangle);
    constraints.push(...bufferedModes([membraneMode(triangle,0,K),membraneMode(triangle,1,G),
      membraneMode(triangle,2,G)],triangle.frame,compiled?.compile({kind:'membrane',nodes:indices,
        bx:triangle.bx,by:triangle.by})));
    for (let k = 0; k < 3; k++) {
      const from = indices[k], to = indices[(k + 1) % 3], opposite = indices[(k + 2) % 3];
      const name = `${Math.min(from, to)},${Math.max(from, to)}`, previous = edges.get(name);
      if (!previous) { edges.set(name, { from, to, opposite, areaM2: triangle.areaM2, paired: false }); continue; }
      if (previous.paired || from !== previous.to || to !== previous.from)
        throw new Error('Несогласованная ориентация или более двух граней у ребра');
      previous.paired = true;
      const vertices = [previous.opposite, previous.from, previous.to, opposite];
      const edgeM = Math.hypot(...edge(reference, from, to));
      const weight = 3 * edgeM * edgeM / (previous.areaM2 + triangle.areaM2);
      const angle = dihedralAngle(reference, ...vertices);
      const hinge = { indices: vertices, weight, restAngleRad: angle };
      hinges.push(hinge);
      if (B > 0 && bendingModel === 'hinge') constraints.push(Object.assign(dihedral(...vertices, angle, 1 / (B * weight)),
        { family: 'bending' }));
    }
  }
  const areaM2 = triangles.reduce((sum, t) => sum + t.areaM2, 0);
  if (B > 0 && bendingModel === 'curvature')
    constraints.push(...curvatureModes(reference, triangles, options.rows, options.cols, B,compiled));
  const evaluate = (p, withGradient = false) => {
    checkPositions(p, reference.length);
    let bulkJ = 0, shearJ = 0, bendingJ = 0, maxHingeChangeRad = 0;
    const gradientJPerM = withGradient ? new Float64Array(reference.length) : null;
    for (const con of constraints) {
      const { C, grad } = con.value(p), energy = .5 * C * C / con.alpha;
      if (con.family === 'bulk') bulkJ += energy;
      else if (con.family === 'shear') shearJ += energy;
      else { bendingJ += energy;
        if (bendingModel === 'hinge') maxHingeChangeRad = Math.max(maxHingeChangeRad, Math.abs(C)); }
      if (withGradient) for (const [i, g] of grad) for (let d = 0; d < 3; d++)
        gradientJPerM[3 * i + d] += C * g[d] / con.alpha;
    }
    let minPrincipalStretch = Infinity, maxPrincipalStretch = 0;
    for (const tri of triangles) {
      const { u, v } = tri.frame(p), uu = dot(u, u), vv = dot(v, v), uv = dot(u, v);
      const spread = Math.hypot(uu - vv, 2 * uv);
      minPrincipalStretch = Math.min(minPrincipalStretch, Math.sqrt(Math.max(0, .5 * (uu + vv - spread))));
      maxPrincipalStretch = Math.max(maxPrincipalStretch, Math.sqrt(.5 * (uu + vv + spread)));
    }
    const membraneJ = bulkJ + shearJ, totalJ = membraneJ + bendingJ;
    if (!Number.isFinite(totalJ) || (gradientJPerM && !Array.from(gradientJPerM).every(Number.isFinite)))
      throw new Error('Не-конечная энергия или сила материальной поверхности');
    return { bulkJ, shearJ, membraneJ, bendingJ, totalJ, minPrincipalStretch,
      maxPrincipalStretch, maxHingeChangeRad: bendingModel === 'hinge' && B > 0 ? maxHingeChangeRad : null,
      ...(withGradient ? { gradientJPerM } : {}) };
  };
  return { reference, triangles, hinges, constraints, areaM2,
    parameters: { ...parameters }, bendingModel, evaluate };
}
