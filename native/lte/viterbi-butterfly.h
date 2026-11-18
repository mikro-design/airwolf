// SPDX-License-Identifier: LGPL-2.1-or-later
// Preserve the portable decoder's 32-bit metrics, tie breaks and decisions.
// Separate independent butterflies from bit packing so SIMD can process them
// without the original loop's repeated read/modify/write dependency on d->w.
#if defined(__aarch64__) || defined(_M_ARM64)
#include <arm_neon.h>
#endif
static inline void airwolf_viterbi_butterflies(struct v37* vp, decision_t* d,
    unsigned sym0, unsigned sym1, unsigned sym2)
{
  uint32_t low = 0, high = 0;
#if defined(__aarch64__) || defined(_M_ARM64)
  const uint32x4_t even_weights = {1, 4, 16, 64}, odd_weights = {2, 8, 32, 128};
  for (unsigned i = 0; i < 32; i += 8) {
    const uint16x8_t metrics = vaddw_u8(vaddl_u8(
        veor_u8(vld1_u8(vp->Branchtab37[0].c + i), vdup_n_u8(sym0)),
        veor_u8(vld1_u8(vp->Branchtab37[1].c + i), vdup_n_u8(sym1))),
        veor_u8(vld1_u8(vp->Branchtab37[2].c + i), vdup_n_u8(sym2)));
    for (unsigned half = 0; half < 2; ++half) {
      const unsigned at = i + half * 4;
      const uint32x4_t metric = vmovl_u16(half ? vget_high_u16(metrics) : vget_low_u16(metrics));
      const uint32x4_t inverse = vsubq_u32(vdupq_n_u32(765), metric);
      const uint32x4_t a = vld1q_u32(vp->old_metrics->w + at);
      const uint32x4_t b = vld1q_u32(vp->old_metrics->w + at + 32);
      const uint32x4_t ea = vaddq_u32(a, metric), eb = vaddq_u32(b, inverse);
      const uint32x4_t oa = vaddq_u32(a, inverse), ob = vaddq_u32(b, metric);
      const uint32x4_t even = vcgtq_s32(vreinterpretq_s32_u32(vsubq_u32(ea, eb)), vdupq_n_s32(0));
      const uint32x4_t odd = vcgtq_s32(vreinterpretq_s32_u32(vsubq_u32(oa, ob)), vdupq_n_s32(0));
      const uint32x4x2_t values = {{vbslq_u32(even, eb, ea), vbslq_u32(odd, ob, oa)}};
      vst2q_u32(vp->new_metrics->w + 2 * at, values);
      // Four butterflies produce eight adjacent decision bits. Pack directly
      // in registers instead of storing/reloading 64 scalar decision words.
      const uint32_t packed = vaddvq_u32(vorrq_u32(vandq_u32(even, even_weights), vandq_u32(odd, odd_weights)));
      if (at < 16) low |= packed << (2 * at);
      else high |= packed << (2 * (at - 16));
    }
  }
#else
  uint32_t decisions[64];
  const uint32_t* restrict old_metrics = vp->old_metrics->w;
  uint32_t* restrict new_metrics = vp->new_metrics->w;
  for (unsigned i = 0; i < 32; ++i) {
    const uint32_t metric = (vp->Branchtab37[0].c[i] ^ sym0) +
        (vp->Branchtab37[1].c[i] ^ sym1) + (vp->Branchtab37[2].c[i] ^ sym2);
    const uint32_t a = old_metrics[i], b = old_metrics[i + 32];
    const uint32_t even_a = a + metric, even_b = b + 765 - metric;
    const uint32_t odd_a = a + 765 - metric, odd_b = b + metric;
    const uint32_t even = (int32_t)(even_a - even_b) > 0;
    const uint32_t odd = (int32_t)(odd_a - odd_b) > 0;
    new_metrics[2 * i] = even ? even_b : even_a;
    new_metrics[2 * i + 1] = odd ? odd_b : odd_a;
    decisions[2 * i] = even;
    decisions[2 * i + 1] = odd;
  }
  for (unsigned i = 0; i < 32; ++i) {
    low |= decisions[i] << i;
    high |= decisions[i + 32] << i;
  }
#endif
  d->w[0] = low;
  d->w[1] = high;
}
