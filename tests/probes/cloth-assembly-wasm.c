// Пакет обычных вкладов g[a]*g[b]/alpha. Два независимых места матрицы
// обрабатываются SIMD; порядок прибавлений каждой ячейки остаётся прежним.
#include <wasm_simd128.h>
#define EXPORTED __attribute__((visibility("default")))
EXPORTED int assembly_abi_version(void) {return 1;}
EXPORTED void assemble_soft(int groups,const int *sizes,const int *entries,
    const double *values,const double *alphas,double *matrix) {
  int entry=0,start=0;
  for(int k=0;k<groups;k++) {
    int size=sizes[k];double alpha=alphas[k];
    for(int a=0;a<size;a++) {
      double ga=values[start+a];int b=0;
      for(;b+1<=a;b+=2) {
        int i=entries[entry++],j=entries[entry++];
        v128_t product=wasm_f64x2_div(wasm_f64x2_mul(wasm_f64x2_splat(ga),
          wasm_v128_load(values+start+b)),wasm_f64x2_splat(alpha));
        v128_t result=wasm_f64x2_add(wasm_f64x2_make(matrix[i],matrix[j]),product);
        matrix[i]=wasm_f64x2_extract_lane(result,0);matrix[j]=wasm_f64x2_extract_lane(result,1);
      }
      if(b<=a)matrix[entries[entry++]]+=ga*values[start+b]/alpha;
    }
    start+=size;
  }
}
