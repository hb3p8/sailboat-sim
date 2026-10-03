// Известные повторные узлы, округление и отказ раскладки; без расчёта паруса.
import assert from 'node:assert/strict';
import {gradientLayout,gradientValues} from './lib/cloth-gradient-layout.mjs';
const grad=[[7,[2,-0,1]],[3,[4,5,6]],[7,[-1,2,3]]],layout=gradientLayout(grad);
assert.deepEqual(Array.from(layout.coordinates),[21,22,23,9,10,11]);
const target=new Float64Array(6);
assert.deepEqual(Array.from(gradientValues(layout,grad,target)),[1,2,4,4,5,6]);
assert.deepEqual(Array.from(gradientValues(layout,[[7,[8,9,10]],[3,[0,0,0]],[7,[-8,-9,-10]]],target)),[0,0,0,0,0,0]);
const repeated=[[1,[1e16,0,-0]],[1,[1,0,0]],[1,[-1e16,0,0]]],rounding=gradientLayout(repeated),values=new Float64Array(3);
assert.deepEqual(Array.from(gradientValues(rounding,repeated,values)),[0,0,0]);
assert.deepEqual(Array.from(gradientValues(rounding,[repeated[0],repeated[2],repeated[1]],values)),[1,0,0]);
assert.deepEqual(Array.from(gradientValues(layout,[[7,[1,2,3]],[7,[4,5,6]],[3,[7,8,9]]],target)),[5,7,9,7,8,9]);
const before=target.slice();
assert.throws(()=>gradientValues(layout,[[7,[1,2,3]],[8,[4,5,6]]],target),/набор узлов/);
assert.deepEqual(target,before);
assert.throws(()=>gradientValues(layout,[[3,[1,2,3]],[7,[4,5,6]]],target),/набор узлов/);
assert.deepEqual(target,before);
assert.throws(()=>gradientValues(layout,grad,new Float64Array(1)),/длина/);
console.log('ок: известные градиенты, повторные узлы, порядок округления, повторное использование и отказ без изменения значений');
