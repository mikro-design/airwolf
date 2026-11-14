// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
// JSON is the worker's stdout contract. Library diagnostics belong on stderr.
#define printf(...) fprintf(stderr, __VA_ARGS__)
#ifdef _WIN32
// This build uses the portable PHY kernels (no LV_HAVE_* alignment contracts).
// Standard malloc is sufficiently aligned for scalar complex floats on UCRT64.
static inline int airwolf_posix_memalign(void** p,size_t alignment,size_t size) {
  (void)alignment; *p=malloc(size); return *p ? 0 : 12;
}
#define posix_memalign airwolf_posix_memalign
#define bzero(p,n) memset((p),0,(n))
#define bcopy(s,d,n) memmove((d),(s),(n))
#endif
