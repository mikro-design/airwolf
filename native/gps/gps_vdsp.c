// SPDX-License-Identifier: BSD-2-Clause
// PocketSDR's FFTs on Apple's vDSP. On Apple Silicon the bundled FFTW has no
// NEON kernels: its transforms were about three quarters of the GPS
// receiver's time, and the 4096-point acquisition FFT took 9.2 us there
// against 1.6 us in vDSP. CMake renames PocketSDR's sdr_cpx_fft to
// airwolf_fftw_cpx_fft (APPLE only); this one takes its place, uses vDSP for
// the lengths it implements and FFTW for the rest (e.g. 2000).
//
// Same transform: unnormalized in both directions, e^-i forward and e^+i
// backward, interleaved float pairs, input and output distinct or equal (the
// FFTW fallback's plans are out-of-place, so an in-place call copies first).
#include "pocket_sdr.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vecLib/vDSP.h>

int airwolf_fftw_cpx_fft(sdr_cpx_t* cpx1, int N, int dir, sdr_cpx_t* cpx2);

typedef struct plan {
  int n;
  // Interleaved setups for f * 2^k, f = 2, 3, 5, 9, 15, 25 (k >= 2), else
  // split-complex setups for f = 1, 3, 5, 15 (k >= 4), else neither: FFTW.
  vDSP_DFT_Interleaved_Setup interleaved[2];
  vDSP_DFT_Setup split[2];
  struct plan* next;
} plan_t;

static plan_t* plans;
static pthread_mutex_t plan_lock = PTHREAD_MUTEX_INITIALIZER;

// Setups are created once per length and kept; executing only reads them,
// so channels on several threads may share one.
static const plan_t* plan_for(int n) {
  pthread_mutex_lock(&plan_lock);
  plan_t* p = plans;
  while (p && p->n != n) p = p->next;
  if (!p && (p = calloc(1, sizeof(*p)))) {
    p->n = n;
    p->interleaved[0] = vDSP_DFT_Interleaved_CreateSetup(NULL, (vDSP_Length)n, vDSP_DFT_FORWARD, vDSP_DFT_Interleaved_ComplextoComplex);
    p->interleaved[1] = p->interleaved[0] ? vDSP_DFT_Interleaved_CreateSetup(p->interleaved[0], (vDSP_Length)n, vDSP_DFT_INVERSE, vDSP_DFT_Interleaved_ComplextoComplex) : NULL;
    if (!p->interleaved[1]) {
      if (p->interleaved[0]) vDSP_DFT_Interleaved_DestroySetup(p->interleaved[0]);
      p->interleaved[0] = NULL;
      p->split[0] = vDSP_DFT_zop_CreateSetup(NULL, (vDSP_Length)n, vDSP_DFT_FORWARD);
      p->split[1] = p->split[0] ? vDSP_DFT_zop_CreateSetup(p->split[0], (vDSP_Length)n, vDSP_DFT_INVERSE) : NULL;
      if (!p->split[1]) {
        if (p->split[0]) vDSP_DFT_DestroySetup(p->split[0]);
        p->split[0] = NULL;
      }
    }
    p->next = plans;
    plans = p;
  }
  pthread_mutex_unlock(&plan_lock);
  return p;  // NULL only when out of memory: FFTW then
}

// Per-thread scratch, grown on demand and freed when the thread exits.
typedef struct scratch {
  float* data;
  size_t floats;
} scratch_t;
static pthread_key_t scratch_key;
static pthread_once_t scratch_once = PTHREAD_ONCE_INIT;
static void scratch_free(void* value) {
  scratch_t* s = value;
  free(s->data);
  free(s);
}
static void scratch_init(void) { pthread_key_create(&scratch_key, scratch_free); }
static float* scratch_for(size_t floats) {
  pthread_once(&scratch_once, scratch_init);
  scratch_t* s = pthread_getspecific(scratch_key);
  if (!s) {
    if (!(s = calloc(1, sizeof(*s)))) return NULL;
    if (pthread_setspecific(scratch_key, s)) {
      free(s);
      return NULL;
    }
  }
  if (s->floats < floats) {
    float* grown = malloc(sizeof(float) * floats);
    if (!grown) return NULL;
    free(s->data);
    s->data = grown;
    s->floats = floats;
  }
  return s->data;
}

int sdr_cpx_fft(sdr_cpx_t* cpx1, int N, int dir, sdr_cpx_t* cpx2) {
  if (dir != SDR_FFT_FORWARD && dir != SDR_FFT_BACKWARD) return 0;
  const plan_t* p = N > 0 ? plan_for(N) : NULL;
  if (p && p->interleaved[dir]) {
    vDSP_DFT_Interleaved_Execute(p->interleaved[dir], (const DSPComplex*)cpx1, (DSPComplex*)cpx2);
    return 1;
  }
  float* scratch = p && p->split[dir] ? scratch_for(4 * (size_t)N) : NULL;
  if (scratch) {
    DSPSplitComplex in = {scratch, scratch + N}, out = {scratch + 2 * N, scratch + 3 * N};
    vDSP_ctoz((const DSPComplex*)cpx1, 2, &in, 1, (vDSP_Length)N);
    vDSP_DFT_Execute(p->split[dir], in.realp, in.imagp, out.realp, out.imagp);
    vDSP_ztoc(&out, 1, (DSPComplex*)cpx2, 2, (vDSP_Length)N);
    return 1;
  }
  if (cpx1 == cpx2 && N > 0) {
    float* copy = scratch_for(2 * (size_t)N);
    if (!copy) return 0;
    memcpy(copy, cpx1, sizeof(float) * 2 * (size_t)N);
    return airwolf_fftw_cpx_fft((sdr_cpx_t*)copy, N, dir, cpx2);
  }
  return airwolf_fftw_cpx_fft(cpx1, N, dir, cpx2);
}
