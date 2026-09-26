// Независимый контроль нормальной скорости у разреза Жуковского.
// node tests/flat-plate-map.test.mjs
import assert from 'node:assert/strict';
import { mappedPlateVelocity, mappedVortexVelocity,
  mappedVortexInvariant } from './lib/flat-plate-map.mjs';

const vortices = [{ x: 0.2, z: 0.1, gamma: -0.02 }];
const mirrorVortices = [{ x: 0.2, z: -0.1, gamma: 0.02 }];
for (const x of [0.1, 0.2, 0.5, 0.8, 0.9]) {
  let previous = Infinity;
  for (const z of [0.01, 0.001, 0.0001]) {
    const [u, w] = mappedPlateVelocity({ flow: [1, 0.1],
      vortices, x, z });
    const [um, wm] = mappedPlateVelocity({ flow: [1, -0.1],
      vortices: mirrorVortices, x, z: -z });
    assert.ok(Number.isFinite(u) && Number.isFinite(w));
    assert.ok(Math.abs(u - um) < 1e-12);
    assert.ok(Math.abs(w + wm) < 1e-12);
    assert.ok(Math.abs(w) < previous / 5);
    previous = Math.abs(w);
    console.log(`x=${x}, z=${z}: u=${u.toFixed(6)}, w=${w.toExponential(3)}`);
  }
  assert.ok(previous < 0.0002);
}
const far = mappedPlateVelocity({ flow: [1, 0.1], x: 100, z: 50 });
assert.ok(Math.abs(far[0] - 1) < 1e-5);
assert.ok(Math.abs(far[1] - 0.1) < 1e-5);
console.log(`дальний поток: u=${far[0].toFixed(9)}, w=${far[1].toFixed(9)}`);

function oneVortex(dt) {
  let p = { x: 0.5, z: 0.1, gamma: 1 };
  const invariant = mappedVortexInvariant(p);
  let crossings = 0, aroundEdge = 0;
  const velocity = v => mappedVortexVelocity({ flow: [0, 0],
    vortices: [v], index: 0 });
  for (let i = 0; i < Math.round(2 / dt); i++) {
    const k1 = velocity(p);
    const k2 = velocity({ ...p, x: p.x + k1[0] * dt / 2,
      z: p.z + k1[1] * dt / 2 });
    const k3 = velocity({ ...p, x: p.x + k2[0] * dt / 2,
      z: p.z + k2[1] * dt / 2 });
    const k4 = velocity({ ...p, x: p.x + k3[0] * dt,
      z: p.z + k3[1] * dt });
    const next = { ...p,
      x: p.x + dt * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6,
      z: p.z + dt * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6 };
    if (p.z * next.z < 0) {
      if ((p.x > 0 && p.x < 1) ||
          (next.x > 0 && next.x < 1)) crossings++;
      else aroundEdge++;
    }
    p = next;
  }
  return { p, drift: Math.abs(mappedVortexInvariant(p) / invariant - 1),
    crossings, aroundEdge };
}

let previousDrift = Infinity, previous = null;
for (const dt of [0.004, 0.002, 0.001, 0.0005]) {
  const result = oneVortex(dt);
  assert.equal(result.crossings, 0);
  assert.equal(result.aroundEdge, 2);
  assert.ok(result.drift < previousDrift);
  if (previous)
    assert.ok(Math.hypot(result.p.x - previous.p.x,
      result.p.z - previous.p.z) < 2e-6);
  previous = result; previousDrift = result.drift;
  console.log(`траектория dt=${dt}: x=${result.p.x.toFixed(9)}, ` +
    `z=${result.p.z.toFixed(9)}, дрейф=${result.drift.toExponential(2)}, ` +
    `обходов кромки=${result.aroundEdge}`);
}
