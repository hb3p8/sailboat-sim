// Изолированный прототип энергии/градиентов трёх мод. Закон и порядок сумм
// совпадают с cloth-material.mjs; fast-math и слияние операций запрещены.
#include <wasm_simd128.h>
#define EXPORTED __attribute__((visibility("default")))
EXPORTED int material_abi_version(void) {return 3;}
static double dot3(const double *a,const double *b) {
  return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
}
static void cross3(const double *a,const double *b,double *out) {
  out[0]=a[1]*b[2]-a[2]*b[1];out[1]=a[2]*b[0]-a[0]*b[2];out[2]=a[0]*b[1]-a[1]*b[0];
}
// Трёхаргументный путь V8 MathHypot: масштабирование и компенсация суммы.
// Источник алгоритма: https://github.com/v8/v8/blob/main/src/builtins/math.tq
EXPORTED double material_hypot3(double a,double b,double c) {
  a=__builtin_fabs(a);b=__builtin_fabs(b);c=__builtin_fabs(c);
  if(__builtin_isinf(a)||__builtin_isinf(b)||__builtin_isinf(c))return __builtin_inf();
  if(__builtin_isnan(a)||__builtin_isnan(b)||__builtin_isnan(c))return __builtin_nan("");
  double max=a>b?a:b;max=max>c?max:c;if(max==0)return 0;
  double x=a/max,y=b/max,z=c/max,pa=x*x,pb=y*y;
  double compensation=(pa+pb)-pa-pb,pc=z*z-compensation;
  return __builtin_sqrt(pa+pb+pc)*max;
}
static void derivative(const double *p,int count,int center,const double *w,double *out) {
  v128_t sum=wasm_f64x2_splat(0),origin=wasm_v128_load(p+3*center);double z=0;
  for(int k=0;k<count;k++) {
    sum=wasm_f64x2_add(sum,wasm_f64x2_mul(wasm_f64x2_splat(w[k]),
      wasm_f64x2_sub(wasm_v128_load(p+3*k),origin)));
    z+=w[k]*(p[3*k+2]-p[3*center+2]);
  }
  wasm_v128_store(out,sum);out[2]=z;
}
EXPORTED int material_membrane(const double *p,const double *data,double *out,int requested) {
  const double *bx=data,*by=data+3;double u[3],v[3];
  for(int d=0;d<3;d++){u[d]=bx[1]*(p[3+d]-p[d]);v[d]=by[1]*(p[3+d]-p[d])+by[2]*(p[6+d]-p[d]);}
  double uu=dot3(u,u),vv=dot3(v,v);out[0]=.5*(uu+vv-2);out[1]=.5*(uu-vv);out[2]=dot3(u,v);
  for(int mode=0;mode<3;mode++) {
    if(requested>=0&&mode!=requested)continue;
    double dv[3];for(int d=0;d<3;d++)dv[d]=mode==2?u[d]:mode==1?-v[d]:v[d];
    const double *du=mode==2?v:u;double *g=out+3+mode*9;
    for(int k=0;k<3;k++) {
      wasm_v128_store(g+3*k,wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(bx[k]),wasm_v128_load(du)),
        wasm_f64x2_mul(wasm_f64x2_splat(by[k]),wasm_v128_load(dv))));
      g[3*k+2]=bx[k]*du[2]+by[k]*dv[2];
    }
  }
  return 0;
}
// data: две производные исходного окружения, по три массива весов каждой
// моды (wu/wv/wh), затем три исходные кривизны. Узлы уже в локальном порядке.
EXPORTED int material_curvature(const double *p,int count,int center,const double *data,double *out,int requested) {
  double u[3],v[3],n[3];derivative(p,count,center,data,u);derivative(p,count,center,data+count,v);cross3(u,v,n);
  double length=material_hypot3(n[0],n[1],n[2]);
  if(!(length>1e-12*material_hypot3(u[0],u[1],u[2])*material_hypot3(v[0],v[1],v[2])))return 1;
  for(int d=0;d<3;d++)n[d]/=length;
  const double *rest=data+11*count;
  for(int mode=0;mode<3;mode++) {
    if(requested>=0&&mode!=requested)continue;
    const double *wu=data+(2+3*mode)*count,*wv=wu+count,*wh=wv+count;
    double H[3],adjN[3],adjU[3],adjV[3];derivative(p,count,center,wh,H);
    double curvature=dot3(n,H);out[mode]=curvature-rest[mode];
    for(int d=0;d<3;d++)adjN[d]=(H[d]-n[d]*curvature)/length;
    cross3(v,adjN,adjU);cross3(adjN,u,adjV);double *g=out+3+mode*3*count;
    for(int k=0;k<count;k++) {
      wasm_v128_store(g+3*k,wasm_f64x2_add(wasm_f64x2_add(
        wasm_f64x2_mul(wasm_f64x2_splat(wu[k]),wasm_v128_load(adjU)),
        wasm_f64x2_mul(wasm_f64x2_splat(wv[k]),wasm_v128_load(adjV))),
        wasm_f64x2_mul(wasm_f64x2_splat(wh[k]),wasm_v128_load(n))));
      g[3*k+2]=wu[k]*adjU[2]+wv[k]*adjV[2]+wh[k]*n[2];
    }
  }
  return 0;
}
// Тот же локальный центральный разностный корректор. Позиция копируется
// один раз; порядок координат/мод и выражение каждого элемента прежние.
EXPORTED int material_hessian(double *p,int count,int center,const double *data,
    int kind,const double *weights,double *out) {
  double plus[291],minus[291];int size=3*count;
  for(int j=0;j<size;j++) {
    double original=p[j],delta=2e-6*(__builtin_fabs(original)>1?__builtin_fabs(original):1);
    p[j]=original+delta;
    int failed=kind?material_curvature(p,count,center,data,plus,-1):material_membrane(p,data,plus,-1);
    p[j]=original-delta;
    if(!failed)failed=kind?material_curvature(p,count,center,data,minus,-1):material_membrane(p,data,minus,-1);
    p[j]=original;if(failed)return failed;
    for(int mode=0;mode<3;mode++)for(int i=0;i<size;i++) {
      double gp=0.0+plus[3+mode*size+i],gm=0.0+minus[3+mode*size+i];
      out[mode*size*size+i*size+j]=weights[mode]*(plus[mode]*gp-minus[mode]*gm)/(2*delta);
    }
  }
  return 0;
}
