// SPDX-License-Identifier: AGPL-3.0-or-later
#include <pthread.h>

/* The pinned PHY initializes these global, cell-independent tables in each
 * SCH constructor, then frees them in each destructor. Snapshot reception
 * would rebuild them repeatedly, and overlapping constructors/destructors
 * would race. The generated arrays are read-only during TX/RX rate matching.
 * A bounded process-lifetime cache avoids both problems; the OS reclaims it
 * when the separate native receiver worker exits. */
extern void airwolf_lte_rm_turbo_initialize(void);
static pthread_once_t tables_once = PTHREAD_ONCE_INIT;
void srsran_rm_turbo_gentables(void)
{
  pthread_once(&tables_once, airwolf_lte_rm_turbo_initialize);
}
void srsran_rm_turbo_free_tables(void)
{
  /* Shared immutable tables outlive individual SCH instances. */
}
