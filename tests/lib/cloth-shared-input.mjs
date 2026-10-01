// Один заданный вход для уточнения сетки. Только исследовательский стенд.
// Это билинейное поле в долях высоты/ширины, восстановленное из опорных
// узловых интегралов; не новый закон воздуха и не точное исходное давление.

const validGrid = (rows, cols) => [rows, cols].every(n => Number.isInteger(n) && n >= 2);
const weights = (u, v) => [(1-u)*(1-v), u*(1-v), (1-u)*v, u*v];
const gauss = [.5 - .5 / Math.sqrt(3), .5 + .5 / Math.sqrt(3)];

export function densityFromNodalIntegrals(rows, cols, components, integrals) {
  if (!validGrid(rows, cols) || !Number.isInteger(components) || components < 1 ||
      integrals.length !== rows * cols * components || !Array.from(integrals).every(Number.isFinite))
    throw new Error('Некорректные узловые интегралы');
  const values = new Float64Array(integrals.length), cellArea = 1 / ((rows-1)*(cols-1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const area = cellArea * (r===0 || r===rows-1 ? .5 : 1) * (c===0 || c===cols-1 ? .5 : 1);
    for (let k = 0; k < components; k++) {
      const i = (r*cols+c)*components+k; values[i] = integrals[i] / area;
    }
  }
  return { rows, cols, components, values };
}

export function integrateDensity(field, rows, cols) {
  const { rows: sr, cols: sc, components, values } = field;
  if (!validGrid(sr, sc) || !validGrid(rows, cols) ||
      !Number.isInteger(components) || components < 1 ||
      values.length !== sr*sc*components || !Array.from(values).every(Number.isFinite) ||
      (rows-1) % (sr-1) || (cols-1) % (sc-1))
    throw new Error('Нужна вложенная сетка того же поля с целым уточнением по каждой оси');
  const result = new Float64Array(rows*cols*components), cellArea = 1 / ((rows-1)*(cols-1));
  for (let r = 0; r < rows-1; r++) for (let c = 0; c < cols-1; c++) {
    const r0 = Math.floor((r+.5)*(sr-1)/(rows-1)), c0 = Math.floor((c+.5)*(sc-1)/(cols-1));
    const a = r0*sc+c0, source = [a,a+1,a+sc,a+sc+1];
    const b = r*cols+c, target = [b,b+1,b+cols,b+cols+1];
    // Поле и функции распределения билинейны: 2×2 точки интегрируют их
    // произведение точно на каждой ячейке; границы исходных ячеек сохранены.
    for (const v of gauss) for (const u of gauss) {
      const sw = weights((c+u)*(sc-1)/(cols-1)-c0, (r+v)*(sr-1)/(rows-1)-r0);
      const tw = weights(u,v);
      for (let k = 0; k < components; k++) {
        let value = 0;
        for (let j = 0; j < 4; j++) value += sw[j]*values[source[j]*components+k];
        for (let j = 0; j < 4; j++) result[target[j]*components+k] += .25*cellArea*tw[j]*value;
      }
    }
  }
  return result;
}

// pressure[3], gravity[3], mass[1], normal drag[3×3]. Плотности включают
// исходный вес площади: геометрический множитель второй раз не применяется.
export function sharedInputFromCloth(cloth, boat) {
  if (!cloth.pressureForce || cloth.pos.some((x,k) => x !== cloth.prev[k]))
    throw new Error('Опорный вход снимается на неподвижном крое до первого движения');
  const integrals = new Float64Array(cloth.n*16);
  const area = cloth.flyingAreas();
  for (let i = 0; i < cloth.n; i++) {
    const n = Array.from(cloth.nrm.slice(3*i,3*i+3)), pr = cloth.pressureForce[i];
    const g = boat.rig.stripCalc[12+cloth.stripOf(Math.floor(i/cloth.cols))] || {};
    const drag = g.live ? cloth.rhoAir*g.ve*area[i] : 0;
    for (let d = 0; d < 3; d++) {
      integrals[16*i+d] = pr*n[d];
      integrals[16*i+3+d] = cloth.frc[3*i+d]-pr*n[d];
      for (let e = 0; e < 3; e++) integrals[16*i+7+3*d+e] = drag*n[d]*n[e];
    }
    integrals[16*i+6] = cloth.mass[i];
  }
  return densityFromNodalIntegrals(cloth.rows,cloth.cols,16,integrals);
}

export function installSharedInput(cloth, field) {
  if (!cloth.rigidBoard || cloth.freeClew || field.components !== 16)
    throw new Error('Общий вход требует неподвижных углов, жёсткой планки и 16 компонент поля');
  const integrated = integrateDensity(field,cloth.rows,cloth.cols), pattern = cloth.pattern;
  cloth.pattern = function (...args) {
    pattern.apply(this,args);
    for (let i = 0; i < this.n; i++) {
      const mass = integrated[16*i+6];
      if (!(mass > 0)) throw new Error('Общий вход дал неположительную массу');
      this.mass[i] = mass; this.w[i] = 1 / mass;
    }
    this.w[this.tack] = this.w[this.head] = this.w[this.clew] = 0;
    this.prepareBoard();
  };
  cloth.forcesAt = function (boat,h) {
    const velocityDt = this.velocityDt(h), cp = Math.cos(boat.phi), sp = Math.sin(boat.phi);
    this.pressureForce ||= new Float64Array(this.n);
    const load = this.load ||= {};
    load.fx = load.fy = load.fz = load.mx = 0;
    for (let i = 0; i < this.n; i++) {
      const k = 3*i, j = 16*i;
      const pr = Math.hypot(integrated[j],integrated[j+1],integrated[j+2]);
      this.pressureForce[i] = pr;
      for (let d = 0; d < 3; d++) {
        this.nrm[k+d] = pr > 0 ? integrated[j+d]/pr : 0;
        let drag = 0;
        for (let e = 0; e < 3; e++)
          drag += integrated[j+7+3*d+e]*(this.pos[k+e]-this.prev[k+e])/velocityDt;
        this.frc[k+d] = integrated[j+d]+integrated[j+3+d]-drag;
      }
      const [fx,fy,fz] = [integrated[j],integrated[j+1],integrated[j+2]];
      load.fx += fx; load.fy += fy; load.fz += fz;
      const Y = this.pos[k+1]*cp-this.pos[k+2]*sp;
      const Z = this.pos[k+2]*cp+this.pos[k+1]*sp;
      load.mx += Y*(fz*cp+fy*sp)-(Z-boat.p.mass.cg_m[2])*(fy*cp-fz*sp);
    }
  };
  return { integrated };
}
