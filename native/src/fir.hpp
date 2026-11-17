#pragma once
#include <complex>
#include <cstddef>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <immintrin.h>
#endif

namespace airwolf {
#if (defined(__x86_64__) || defined(_M_X64)) && (defined(__GNUC__) || defined(__clang__))
// Optional x86 acceleration, selected once. The binary still runs on SSE2 CPUs.
__attribute__((target("avx2"))) inline std::complex<float> fir_dot_avx2(const float* real,const float* imag,const float* taps,std::size_t size){
  std::size_t k=0;
  auto r0=_mm256_setzero_ps(),r1=r0,r2=r0,r3=r0,q0=r0,q1=r0,q2=r0,q3=r0;
  for(;k+31<size;k+=32){
    const auto t0=_mm256_loadu_ps(taps+k),t1=_mm256_loadu_ps(taps+k+8),t2=_mm256_loadu_ps(taps+k+16),t3=_mm256_loadu_ps(taps+k+24);
    r0=_mm256_add_ps(r0,_mm256_mul_ps(_mm256_loadu_ps(real+k),t0));q0=_mm256_add_ps(q0,_mm256_mul_ps(_mm256_loadu_ps(imag+k),t0));
    r1=_mm256_add_ps(r1,_mm256_mul_ps(_mm256_loadu_ps(real+k+8),t1));q1=_mm256_add_ps(q1,_mm256_mul_ps(_mm256_loadu_ps(imag+k+8),t1));
    r2=_mm256_add_ps(r2,_mm256_mul_ps(_mm256_loadu_ps(real+k+16),t2));q2=_mm256_add_ps(q2,_mm256_mul_ps(_mm256_loadu_ps(imag+k+16),t2));
    r3=_mm256_add_ps(r3,_mm256_mul_ps(_mm256_loadu_ps(real+k+24),t3));q3=_mm256_add_ps(q3,_mm256_mul_ps(_mm256_loadu_ps(imag+k+24),t3));
  }
  r0=_mm256_add_ps(_mm256_add_ps(r0,r1),_mm256_add_ps(r2,r3));q0=_mm256_add_ps(_mm256_add_ps(q0,q1),_mm256_add_ps(q2,q3));
  for(;k+7<size;k+=8){const auto t=_mm256_loadu_ps(taps+k);r0=_mm256_add_ps(r0,_mm256_mul_ps(_mm256_loadu_ps(real+k),t));q0=_mm256_add_ps(q0,_mm256_mul_ps(_mm256_loadu_ps(imag+k),t));}
  const auto r=_mm_add_ps(_mm256_castps256_ps128(r0),_mm256_extractf128_ps(r0,1));
  const auto q=_mm_add_ps(_mm256_castps256_ps128(q0),_mm256_extractf128_ps(q0,1));
  float rr[4],qq[4];_mm_storeu_ps(rr,r);_mm_storeu_ps(qq,q);
  float re=(rr[0]+rr[1])+(rr[2]+rr[3]),im=(qq[0]+qq[1])+(qq[2]+qq[3]);
  for(;k<size;++k){re+=real[k]*taps[k];im+=imag[k]*taps[k];}
  return {re,im};
}
#endif
// Real coefficients, complex samples in contiguous split storage. Independent
// accumulators avoid a dependency chain through every tap. No fast-math, CPU
// feature probing, alignment assumption or allocation in the sample path.
inline std::complex<float> fir_dot(const float* real,const float* imag,const float* taps,std::size_t size){
#if (defined(__x86_64__) || defined(_M_X64)) && (defined(__GNUC__) || defined(__clang__))
  static const bool avx2=__builtin_cpu_supports("avx2");
  if(avx2)return fir_dot_avx2(real,imag,taps,size);
#endif
  std::size_t k=0;float re=0,im=0;
#if defined(__ARM_NEON)
  auto r0=vdupq_n_f32(0),r1=r0,r2=r0,r3=r0,q0=r0,q1=r0,q2=r0,q3=r0;
  for(;k+15<size;k+=16){
    const auto t0=vld1q_f32(taps+k),t1=vld1q_f32(taps+k+4),t2=vld1q_f32(taps+k+8),t3=vld1q_f32(taps+k+12);
    r0=vmlaq_f32(r0,vld1q_f32(real+k),t0);q0=vmlaq_f32(q0,vld1q_f32(imag+k),t0);
    r1=vmlaq_f32(r1,vld1q_f32(real+k+4),t1);q1=vmlaq_f32(q1,vld1q_f32(imag+k+4),t1);
    r2=vmlaq_f32(r2,vld1q_f32(real+k+8),t2);q2=vmlaq_f32(q2,vld1q_f32(imag+k+8),t2);
    r3=vmlaq_f32(r3,vld1q_f32(real+k+12),t3);q3=vmlaq_f32(q3,vld1q_f32(imag+k+12),t3);
  }
  r0=vaddq_f32(vaddq_f32(r0,r1),vaddq_f32(r2,r3));q0=vaddq_f32(vaddq_f32(q0,q1),vaddq_f32(q2,q3));
  for(;k+3<size;k+=4){const auto t=vld1q_f32(taps+k);r0=vmlaq_f32(r0,vld1q_f32(real+k),t);q0=vmlaq_f32(q0,vld1q_f32(imag+k),t);}
  float r[4],q[4];vst1q_f32(r,r0);vst1q_f32(q,q0);re=(r[0]+r[1])+(r[2]+r[3]);im=(q[0]+q[1])+(q[2]+q[3]);
#elif defined(__SSE2__) || defined(_M_X64)
  auto r0=_mm_setzero_ps(),r1=r0,r2=r0,r3=r0,q0=r0,q1=r0,q2=r0,q3=r0;
  for(;k+15<size;k+=16){
    const auto t0=_mm_loadu_ps(taps+k),t1=_mm_loadu_ps(taps+k+4),t2=_mm_loadu_ps(taps+k+8),t3=_mm_loadu_ps(taps+k+12);
    r0=_mm_add_ps(r0,_mm_mul_ps(_mm_loadu_ps(real+k),t0));q0=_mm_add_ps(q0,_mm_mul_ps(_mm_loadu_ps(imag+k),t0));
    r1=_mm_add_ps(r1,_mm_mul_ps(_mm_loadu_ps(real+k+4),t1));q1=_mm_add_ps(q1,_mm_mul_ps(_mm_loadu_ps(imag+k+4),t1));
    r2=_mm_add_ps(r2,_mm_mul_ps(_mm_loadu_ps(real+k+8),t2));q2=_mm_add_ps(q2,_mm_mul_ps(_mm_loadu_ps(imag+k+8),t2));
    r3=_mm_add_ps(r3,_mm_mul_ps(_mm_loadu_ps(real+k+12),t3));q3=_mm_add_ps(q3,_mm_mul_ps(_mm_loadu_ps(imag+k+12),t3));
  }
  r0=_mm_add_ps(_mm_add_ps(r0,r1),_mm_add_ps(r2,r3));q0=_mm_add_ps(_mm_add_ps(q0,q1),_mm_add_ps(q2,q3));
  for(;k+3<size;k+=4){const auto t=_mm_loadu_ps(taps+k);r0=_mm_add_ps(r0,_mm_mul_ps(_mm_loadu_ps(real+k),t));q0=_mm_add_ps(q0,_mm_mul_ps(_mm_loadu_ps(imag+k),t));}
  float r[4],q[4];_mm_storeu_ps(r,r0);_mm_storeu_ps(q,q0);re=(r[0]+r[1])+(r[2]+r[3]);im=(q[0]+q[1])+(q[2]+q[3]);
#endif
  for(;k<size;++k){re+=real[k]*taps[k];im+=imag[k]*taps[k];}
  return {re,im};
}
}
