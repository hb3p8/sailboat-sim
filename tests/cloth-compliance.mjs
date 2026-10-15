// Исследовательские примеры используют единые ограничения и интегратор движка.
import {distance,shear,area,area3d,dihedralAngle,dihedral,bend,simulate} from '../sim/cloth/cloth-compliance.mjs';
export * from '../sim/cloth/cloth-compliance.mjs';

function scenario(kind) {
  if (kind === 'растяжение') return {
    initial: [0, 0, 0, 1, 0, 0, 2, 0, 0], inverseMass: [0, 1, 1],
    constraints: [distance(0, 1, 1, 0.02, true), distance(1, 2, 1, 0.02, true)],
    external: [0, 0, 0, 0, 0, 0, 5, 0, 0],
    read: r => r.p[6], expected: 2.2,
  };
  if (kind === 'сдвиг') return {
    initial: [0, 0, 0, 1, 0, 0, 0, 1, 0], inverseMass: [0, 0, 1],
    constraints: [shear(0, 1, 2, 0, 0.05)],
    external: [0, 0, 0, 0, 0, 0, 1, 0, 0],
    read: r => r.p[6], expected: 0.05,
  };
  if (kind === 'площадь') return {
    initial: [0, 0, 0, 1, 0, 0, 0, 1, 0], inverseMass: [0, 0, 1],
    constraints: [area(0, 1, 2, 1, 0.05)],
    external: [0, 0, 0, 0, 0, 0, 0, 1, 0],
    read: r => r.p[7], expected: 1.05,
  };
  // Равновесие среднего узла при фиксированных соседях:
  // θ=-2 atan(y), dθ/dy=-2/(1+y²), F=-θ(dθ/dy)/α.
  let lo = 0, hi = 0.1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (40 * Math.atan(mid) / (1 + mid * mid) < 1) lo = mid;
    else hi = mid;
  }
  return {
    initial: [-1, 0, 0, 0, 0, 0, 1, 0, 0], inverseMass: [0, 1, 0],
    constraints: [bend(0, 1, 2, 0, 0.1)],
    external: [0, 0, 0, 0, 1, 0, 0, 0, 0],
    read: r => r.p[4], expected: (lo + hi) / 2,
  };
}

// Командные примеры доступны в Node; сами ограничения работают и в браузере.
if (typeof process !== 'undefined' && process.argv[1] &&
    import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
for (const kind of ['растяжение', 'сдвиг', 'площадь', 'изгиб']) {
  console.log(`${kind}: модельная податливость, не ткань SV20`);
  const reactionUnit = kind === 'растяжение' ? 'Н' :
    kind === 'сдвиг' || kind === 'площадь' ? 'Н/м' : 'Н·м';
  for (const hz of [30, 120]) for (const passes of [1, 4, 16, 64]) {
    const setup = scenario(kind);
    const result = simulate({ ...setup, hz, passes });
    console.log(`  ${hz} Гц / ${passes} проходов: координата ` +
      `${setup.read(result).toFixed(8)} м, ориентир ${setup.expected.toFixed(8)} м, ` +
      `обобщённые реакции ${result.reaction.map(x => x.toFixed(5)).join('/')} ${reactionUnit}, ` +
      `невязка ${result.maxConstraint.toExponential(2)}`);
  }
}

const slack = simulate({
  initial: [0, 0, 0, 1, 0, 0], inverseMass: [0, 1],
  constraints: [distance(0, 1, 1, 0.02, true)],
  external: [0, 0, 0, -5, 0, 0], hz: 120, passes: 16, seconds: 0.1,
});
console.log(`Сжатие односторонней нити: длина ${slack.p[3].toFixed(6)} м, ` +
  `реакция ${slack.reaction[0].toFixed(6)} Н`);
if (!(slack.p[3] < 1 && slack.reaction[0] === 0))
  throw new Error('Односторонняя связь толкает при сжатии');
}
