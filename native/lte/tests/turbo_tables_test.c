// SPDX-License-Identifier: AGPL-3.0-or-later
/* Compare the table path with the upstream scalar algorithm, across every
 * code-block size and redundancy version while other clients initialize and
 * release their instances. This is a lifetime/concurrency regression, not an
 * independent standards-conformance vector. */
#include "srsran/phy/fec/turbo/rm_turbo.h"
#include "srsran/phy/fec/cbsegm.h"
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr,"Failed: %s at %d\n",#x,__LINE__); abort(); } } while(0)
enum { CLIENTS=6, MAX_INPUT=37000, MAX_OUTPUT=18528 };
static void* client(void* opaque)
{
  unsigned id=(unsigned)(uintptr_t)opaque;
  int16_t* input=malloc(MAX_INPUT*sizeof(*input));
  int16_t* fast=malloc(MAX_OUTPUT*sizeof(*fast));
  float* floats=malloc(MAX_INPUT*sizeof(*floats));
  float* scalar=malloc(MAX_OUTPUT*sizeof(*scalar));
  float* work=malloc(MAX_OUTPUT*sizeof(*work));
  CHECK(input&&fast&&floats&&scalar&&work);
  for(unsigned k=0;k<MAX_INPUT;++k)input[k]=(int16_t)((int)((k*17+id*11)%101)-50),floats[k]=input[k];
  for(unsigned cb=id;cb<SRSRAN_NOF_TC_CB_SIZES;cb+=CLIENTS){
    unsigned length=3*srsran_cbsegm_cbsize(cb)+12;
    for(unsigned rv=0;rv<4;++rv)for(unsigned repeat=0;repeat<2;++repeat){
      unsigned count=repeat?length*2+17:length/2+3;
      CHECK(count<=MAX_INPUT&&length<=MAX_OUTPUT);
      srsran_rm_turbo_gentables();
      memset(fast,0,MAX_OUTPUT*sizeof(*fast));
      for(unsigned k=0;k<MAX_OUTPUT;++k)work[k]=SRSRAN_RX_NULL;
      CHECK(srsran_rm_turbo_rx(work,MAX_OUTPUT,floats,count,scalar,length,rv,0)==0);
      CHECK(srsran_rm_turbo_rx_lut_(input,fast,count,cb,rv,false)==0);
      for(unsigned k=0;k<length;++k)CHECK(fast[k]==scalar[k]);
      srsran_rm_turbo_free_tables();
    }
  }
  free(input);free(fast);free(floats);free(scalar);free(work);return NULL;
}
int main(void)
{
  pthread_t threads[CLIENTS];
  for(unsigned round=0;round<3;++round){
    for(unsigned i=0;i<CLIENTS;++i)CHECK(pthread_create(&threads[i],NULL,client,(void*)(uintptr_t)i)==0);
    for(unsigned i=0;i<CLIENTS;++i)CHECK(pthread_join(threads[i],NULL)==0);
  }
  puts("Six concurrent clients: all 188 LTE block sizes and four RVs match scalar rate matching through repeated lifetimes");
  return 0;
}
