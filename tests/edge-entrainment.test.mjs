// Алгебраический контроль материальных потоков у кромки, не CFD паруса.
import assert from 'node:assert/strict';
import { mergeEdgeSheets } from './lib/edge-entrainment.mjs';
import { fourierSheetWakeStep } from './lib/fourier-vortex.mjs';

const halfAngle = .2;
const c = Math.cos(halfAngle), s = Math.sin(halfAngle);
const symmetric = mergeEdgeSheets({ branches: [
  { massPerLength: .2, speed: 1, tangent: [c, -s] },
  { massPerLength: .2, speed: 1, tangent: [c, s] }] });
assert.ok(symmetric.ok && Math.abs(symmetric.tangent[1]) < 1e-14);
assert.ok(Math.abs(symmetric.massFlux - .4) < 1e-14);
assert.ok(Math.abs(symmetric.speed - c) < 1e-14);
assert.ok(Math.abs(symmetric.normalAcceleration) === 0);

const asymmetric = mergeEdgeSheets({ branches: [
  { massPerLength: .1, speed: 1, tangent: [c, -s] },
  { massPerLength: .3, speed: 1, tangent: [c, s] }],
  pressureJump: .5 });
const expectedAngle = Math.atan(.5 * Math.tan(halfAngle));
assert.ok(asymmetric.ok &&
  Math.abs(Math.atan2(asymmetric.tangent[1],
    asymmetric.tangent[0]) - expectedAngle) < 1e-14);
assert.ok(asymmetric.surfaceMass > 0 &&
  asymmetric.normalAcceleration < 0);

const birth = fourierSheetWakeStep({ flow: [1, .1], dt: .01,
  modes: 1024, points: 4096, reynolds: 1e5, releaseHeight: 0,
  advection: 'induced', advectionSubsteps: 16,
  leadingFormation: 'tangent' });
const edgeJump = birth.pressure[0] - birth.leadingGamma / .01;
const noBoundaryLayer = mergeEdgeSheets({ branches: [
  { massPerLength: 0, speed: 1, tangent: [c, -s] },
  { massPerLength: 0, speed: 1, tangent: [c, s] }],
  pressureJump: edgeJump });
assert.equal(noBoundaryLayer.reason, 'no-normal-momentum');
const noPressure = mergeEdgeSheets({ branches: [
  { massPerLength: 0, speed: 1, tangent: [c, -s] },
  { massPerLength: 0, speed: 1, tangent: [c, s] }] });
assert.ok(noPressure.ok && noPressure.tangent === null);
console.log(`слияние: симметрия ${symmetric.tangent[1].toExponential(2)}, ` +
  `асимметричный угол ${expectedAngle.toFixed(6)} рад; ` +
  `у нынешней LE-модели Δp≈${edgeJump.toFixed(6)}, ` +
  `масса слоя=0: ${noBoundaryLayer.reason}`);
