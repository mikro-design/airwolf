// SPDX-License-Identifier: AGPL-3.0-or-later
// PSS correlation on Apple's vDSP, for the cell search's hot path.
//
// srsRAN correlates each 5 ms frame with the PSS by FFT convolution of
// N = frame + PSS length points (9728 at 1.92 MS/s, 2^9 * 19). The bundled
// FFTW has no NEON kernels and plans with FFTW_ESTIMATE; this size took 45 us
// per transform there, about 60% of an LTE worker with no cell in view.
// vDSP's DFT takes lengths f * 2^k (f = 1, 3, 5, 15): zero-padding the same
// linear convolution to the next such length (10240) takes 5 us.
//
// The result is srsRAN's: the input and PSS are both shorter than N, so its
// N-point circular convolution is the linear one, and so is the padded one;
// the first N outputs are kept, at the same scale (srsRAN normalizes both
// forward transforms by 1/sqrt(N) and not the inverse, i.e. the plain sum).
// Only float rounding differs.
#include "pss_vdsp.h"
#include <complex.h>
#include <vecLib/vDSP.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct plan {
  unsigned n;
  vDSP_DFT_Setup forward, inverse;
  struct plan* next;
} plan_t;

// One plan per transform size, kept for the process's life. Each srsRAN PSS
// object asks for its own size (cell search, MIB, verification, and two per
// cell bandwidth decoded for system information), so a process that sees
// several bandwidths needs a dozen or more: the list is unbounded.
static plan_t* plans;
static pthread_mutex_t plan_lock = PTHREAD_MUTEX_INITIALIZER;

unsigned airwolf_pss_bins(unsigned length) {
  static const unsigned factors[] = {1, 3, 5, 15};
  unsigned best = 0;
  for (unsigned f = 0; f < 4; ++f) {
    unsigned n = factors[f] * 16;  // vDSP needs at least 2^4 per factor
    while (n < length) n *= 2;
    if (!best || n < best) best = n;
  }
  return best;
}

// Out of memory (no setup or scratch): the correlation is all zeros, so the
// search finds no cell, instead of aborting the whole receiver process.
static void report_failure(unsigned n) {
  static int reported;
  if (!__atomic_exchange_n(&reported, 1, __ATOMIC_RELAXED))
    fprintf(stderr, "LTE PSS: cannot allocate a %u-point vDSP transform; cell search finds nothing\n", n);
}

// Setups are created once per size and shared: vDSP_DFT_Execute only reads
// them, so concurrent searches may use one setup. Sizes come from
// airwolf_pss_bins, which vDSP supports, so creation fails only when memory
// is exhausted.
static const plan_t* plan_for(unsigned n) {
  pthread_mutex_lock(&plan_lock);
  plan_t* found = plans;
  while (found && found->n != n) found = found->next;
  if (!found) {
    found = calloc(1, sizeof(*found));
    if (found) {
      found->n = n;
      found->forward = vDSP_DFT_zop_CreateSetup(NULL, n, vDSP_DFT_FORWARD);
      found->inverse = found->forward ? vDSP_DFT_zop_CreateSetup(found->forward, n, vDSP_DFT_INVERSE) : NULL;
      if (found->forward && found->inverse) {
        found->next = plans;
        plans = found;
      } else {
        if (found->forward) vDSP_DFT_DestroySetup(found->forward);
        free(found);
        found = NULL;
      }
    }
  }
  pthread_mutex_unlock(&plan_lock);
  if (!found) report_failure(n);
  return found;
}

// Per-thread scratch (split input and output), grown on demand and freed
// when the thread exits.
typedef struct scratch {
  float* data;
  unsigned bins;
} scratch_t;
static pthread_key_t scratch_key;
static pthread_once_t scratch_once = PTHREAD_ONCE_INIT;
static void scratch_free(void* value) {
  scratch_t* s = value;
  free(s->data);
  free(s);
}
static void scratch_init(void) { pthread_key_create(&scratch_key, scratch_free); }
static float* buffers(unsigned n) {
  pthread_once(&scratch_once, scratch_init);
  scratch_t* s = pthread_getspecific(scratch_key);
  if (!s) {
    if (!(s = calloc(1, sizeof(*s)))) return NULL;
    if (pthread_setspecific(scratch_key, s)) {
      free(s);
      return NULL;
    }
  }
  if (s->bins < n) {
    float* grown = malloc(sizeof(float) * 4 * n);
    if (!grown) return NULL;
    free(s->data);
    s->data = grown;
    s->bins = n;
  }
  return s->data;
}

static void forward(const plan_t* p, const cf_t* in, unsigned length, float* re, float* im, float* out_re, float* out_im) {
  for (unsigned i = 0; i < length; ++i) {
    re[i] = crealf(in[i]);
    im[i] = cimagf(in[i]);
  }
  memset(re + length, 0, sizeof(float) * (p->n - length));
  memset(im + length, 0, sizeof(float) * (p->n - length));
  vDSP_DFT_Execute(p->forward, re, im, out_re, out_im);
}

void airwolf_pss_spectrum(const srsran_conv_fft_cc_t* conv, const cf_t* filter, cf_t* spectrum) {
  const unsigned bins = airwolf_pss_bins(conv->output_len);
  const plan_t* p = plan_for(bins);
  float* b = p ? buffers(p->n) : NULL;
  if (!b) {
    report_failure(bins);
    memset(spectrum, 0, sizeof(cf_t) * bins);
    return;
  }
  float *re = b, *im = b + p->n, *out_re = b + 2 * p->n, *out_im = b + 3 * p->n;
  // srsRAN's filter transform reads N samples (the PSS, then zeros).
  forward(p, filter, conv->output_len, re, im, out_re, out_im);
  // Both 1/sqrt(N) factors of srsRAN's transforms; the padded inverse then
  // needs no further scaling to equal the linear convolution sum.
  const float scale = 1.0f / (float)p->n;
  for (unsigned k = 0; k < p->n; ++k) spectrum[k] = out_re[k] * scale + I * (out_im[k] * scale);
}

uint32_t airwolf_pss_correlate(const srsran_conv_fft_cc_t* conv, const cf_t* input, const cf_t* spectrum, cf_t* output) {
  const unsigned bins = airwolf_pss_bins(conv->output_len);
  const plan_t* p = plan_for(bins);
  float* b = p ? buffers(p->n) : NULL;
  if (!b) {
    report_failure(bins);
    memset(output, 0, sizeof(cf_t) * conv->output_len);
    return conv->output_len - 1;
  }
  float *re = b, *im = b + p->n, *out_re = b + 2 * p->n, *out_im = b + 3 * p->n;
  forward(p, input, conv->output_len, re, im, out_re, out_im);
  for (unsigned k = 0; k < p->n; ++k) {
    const float xr = out_re[k], xi = out_im[k], hr = crealf(spectrum[k]), hi = cimagf(spectrum[k]);
    re[k] = xr * hr - xi * hi;
    im[k] = xr * hi + xi * hr;
  }
  vDSP_DFT_Execute(p->inverse, re, im, out_re, out_im);
  for (unsigned i = 0; i < conv->output_len; ++i) output[i] = out_re[i] + I * out_im[i];
  return conv->output_len - 1;
}
