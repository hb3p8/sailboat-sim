// Совместимость обычного симулятора: прежний JS-закон при другом округлении.
// Исследовательские стенды по-прежнему требуют строгого совпадения WASM/JS.
import {loadMaterialKernel,MaterialEngineMismatchError} from './cloth/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from './cloth/cloth-material-engine-check.mjs';

export async function selectGennakerMaterial(bytes,recipe) {
  const start=performance.now();
  try {
    const kernel=await loadMaterialKernel(bytes),checks=verifyMaterialKernel(kernel,recipe);
    return {kernel,material:{backend:'wasm',checks,verificationMs:performance.now()-start}};
  } catch(error) {
    // Повреждённый модуль, неверный ABI и ошибки постановки остаются отказами.
    if(!(error instanceof MaterialEngineMismatchError))throw error;
    return {kernel:undefined,material:{backend:'js',reason:error.code,message:error.message,
      comparison:error.comparison,verificationMs:performance.now()-start}};
  }
}
