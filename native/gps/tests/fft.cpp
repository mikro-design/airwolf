// SPDX-License-Identifier: BSD-2-Clause
// sdr_cpx_fft against a direct DFT, both directions, at lengths taking each
// path on Apple (vDSP interleaved 4096, vDSP split 8192, FFTW 2000) and
// FFTW elsewhere: unnormalized, e^-i forward and e^+i backward. Every
// PocketSDR call passes distinct input and output; on Apple an in-place call
// must give the same result on every path (PocketSDR's FFTW plans are
// out-of-place, so the replacement copies first).
#include <cmath>
#include <complex>
#include <cstdio>
#include <random>
// pocket_sdr.h's macros clash with C++ headers; its FFT API, declared here.
typedef float sdr_cpx_t[2];
extern "C" {
sdr_cpx_t* sdr_cpx_malloc(int N);
void sdr_cpx_free(sdr_cpx_t* cpx);
int sdr_cpx_fft(sdr_cpx_t* cpx1, int N, int dir, sdr_cpx_t* cpx2);
}
constexpr int SDR_FFT_FORWARD = 0, SDR_FFT_BACKWARD = 1;  // as in pocket_sdr.h
constexpr double pi = 3.14159265358979323846;  // M_PI is not standard C++
int main() {
  std::mt19937 rng(5);
  std::uniform_real_distribution<float> value(-1, 1);
  for (int n : {4096, 8192, 2000, 2048}) {
    sdr_cpx_t* in = sdr_cpx_malloc(n);
    sdr_cpx_t* out = sdr_cpx_malloc(n);
    for (int i = 0; i < n; ++i) { in[i][0] = value(rng); in[i][1] = value(rng); }
    for (int dir : {SDR_FFT_FORWARD, SDR_FFT_BACKWARD}) {
      if (!sdr_cpx_fft(in, n, dir, out)) { std::fprintf(stderr, "N=%d: FFT failed\n", n); return 1; }
      const double sign = dir == SDR_FFT_FORWARD ? -1 : 1;
      double error = 0, peak = 0;
      for (int k = 0; k < n; k += 97) {  // a spread of bins, each exact in double
        std::complex<double> sum = 0;
        for (int i = 0; i < n; ++i)
          sum += std::complex<double>(in[i][0], in[i][1]) * std::polar(1.0, sign * 2 * pi * double((long long)i * k % n) / n);
        error = std::fmax(error, std::abs(sum - std::complex<double>(out[k][0], out[k][1])));
        peak = std::fmax(peak, std::abs(sum));
      }
      if (!(error < 1e-5 * peak)) { std::fprintf(stderr, "N=%d dir=%d: error %.3g of %.3g\n", n, dir, error, peak); return 1; }
#ifdef __APPLE__
      sdr_cpx_t* same = sdr_cpx_malloc(n);
      for (int i = 0; i < n; ++i) { same[i][0] = in[i][0]; same[i][1] = in[i][1]; }
      if (!sdr_cpx_fft(same, n, dir, same)) { std::fprintf(stderr, "N=%d: in-place FFT failed\n", n); return 1; }
      for (int i = 0; i < n; ++i)
        if (std::fabs(same[i][0] - out[i][0]) > 1e-6f * float(peak) || std::fabs(same[i][1] - out[i][1]) > 1e-6f * float(peak)) {
          std::fprintf(stderr, "N=%d dir=%d: in-place result differs at %d\n", n, dir, i);
          return 1;
        }
      sdr_cpx_free(same);
#endif
    }
    sdr_cpx_free(in);
    sdr_cpx_free(out);
  }
  std::printf("sdr_cpx_fft matches a direct DFT at 4096, 8192, 2000 and 2048 points; in place on Apple too\n");
  return 0;
}
