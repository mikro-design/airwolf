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
#include <stdlib.h>
#include <string.h>

typedef struct {
  unsigned n;
  vDSP_DFT_Setup forward, inverse;
} plan_t;

static plan_t plans[8];
static unsigned plan_count;
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

// Setups are created once per size and shared: vDSP_DFT_Execute only reads
// them, so concurrent searches may use one setup.
static const plan_t* plan_for(unsigned n) {
  pthread_mutex_lock(&plan_lock);
  const plan_t* found = NULL;
  for (unsigned i = 0; i < plan_count; ++i)
    if (plans[i].n == n) found = &plans[i];
  if (!found && plan_count < sizeof(plans) / sizeof(plans[0])) {
    plan_t* p = &plans[plan_count];
    p->n = n;
    p->forward = vDSP_DFT_zop_CreateSetup(NULL, n, vDSP_DFT_FORWARD);
    p->inverse = vDSP_DFT_zop_CreateSetup(p->forward, n, vDSP_DFT_INVERSE);
    if (p->forward && p->inverse) found = &plans[plan_count++];
  }
  pthread_mutex_unlock(&plan_lock);
  if (!found) abort();  // only a handful of sizes ever occur
  return found;
}

// Per-thread scratch: split input and output, grown on demand.
static _Thread_local float* scratch;
static _Thread_local unsigned scratch_bins;
static float* buffers(unsigned n) {
  if (scratch_bins < n) {
    free(scratch);
    scratch = malloc(sizeof(float) * 4 * n);
    if (!scratch) abort();
    scratch_bins = n;
  }
  return scratch;
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
  const plan_t* p = plan_for(airwolf_pss_bins(conv->output_len));
  float* b = buffers(p->n);
  float *re = b, *im = b + p->n, *out_re = b + 2 * p->n, *out_im = b + 3 * p->n;
  // srsRAN's filter transform reads N samples (the PSS, then zeros).
  forward(p, filter, conv->output_len, re, im, out_re, out_im);
  // Both 1/sqrt(N) factors of srsRAN's transforms; the padded inverse then
  // needs no further scaling to equal the linear convolution sum.
  const float scale = 1.0f / (float)p->n;
  for (unsigned k = 0; k < p->n; ++k) spectrum[k] = out_re[k] * scale + I * (out_im[k] * scale);
}

uint32_t airwolf_pss_correlate(const srsran_conv_fft_cc_t* conv, const cf_t* input, const cf_t* spectrum, cf_t* output) {
  const plan_t* p = plan_for(airwolf_pss_bins(conv->output_len));
  float* b = buffers(p->n);
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
