// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "srsran/phy/utils/convolution.h"
// vDSP replacement for srsRAN's PSS FFT convolution (see pss_vdsp.c).
// Spectra hold airwolf_pss_bins(conv->output_len) bins.
unsigned airwolf_pss_bins(unsigned length);
void airwolf_pss_spectrum(const srsran_conv_fft_cc_t* conv, const cf_t* filter, cf_t* spectrum);
uint32_t airwolf_pss_correlate(const srsran_conv_fft_cc_t* conv, const cf_t* input, const cf_t* spectrum, cf_t* output);
