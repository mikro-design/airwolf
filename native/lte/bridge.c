// SPDX-License-Identifier: AGPL-3.0-or-later
#include "bridge.h"
#include <srsran/phy/ue/ue_cell_search.h>
#include <srsran/phy/ue/ue_mib.h>
#include <string.h>
#include <stdlib.h>
#include <complex.h>
#include <math.h>
struct input {void* user;airwolf_lte_read read;int eof,gap;uint64_t first,end;float mix_hz;cf_t oscillator[128];};
static int receive(void* user,cf_t* samples[SRSRAN_MAX_CHANNELS],uint32_t count,srsran_timestamp_t* ts){
  struct input* in=user;uint64_t first=0;
  if(!count)return 0;
  int got=in->read(in->user,samples[0],count,&first);
  if(got<=0){in->eof=got==0;in->gap=got<0;return SRSRAN_ERROR_RX_EOF;}
  if(in->mix_hz!=0)for(uint32_t k=0;k<count;++k)samples[0][k]*=in->oscillator[(first+k)%128];
  in->first=first;in->end=first+count;
  // Synchronization discards samples with a null timestamp destination.
  if(ts){ts->full_secs=first/1920000;ts->frac_secs=(first%1920000)/1920000.0;}
  return got;
}
void airwolf_lte_run(void* user,airwolf_lte_read read,airwolf_lte_mib emit){
  struct input in={user,read,0,0,0,0,0,{0}};
  const float hypotheses[]={0,15000,-15000,30000,-30000,45000,-45000,60000,-60000,75000,-75000};
  unsigned attempt=0;
  while(!in.eof){
    in.gap=0;in.mix_hz=hypotheses[attempt++%11];
    // Hypotheses are integer multiples of 15 kHz at 1.92 MS/s: exactly
    // periodic over 128 samples, with no accumulated NCO phase/scale error.
    for(unsigned k=0;k<128;++k){double angle=-6.2831853071795864769*in.mix_hz*k/1920000;in.oscillator[k]=(float)cos(angle)+I*(float)sin(angle);}
    srsran_ue_cellsearch_t* search=calloc(1,sizeof(*search));
    if(!search)return;
    if(srsran_ue_cellsearch_init_multi(search,10,receive,1,&in)){free(search);return;}
    srsran_ue_cellsearch_set_nof_valid_frames(search,2);
    srsran_ue_cellsearch_result_t results[3]={0};uint32_t strongest=0;
    const int found=srsran_ue_cellsearch_scan(search,results,&strongest);
    srsran_cell_t cell={0};
    if(found>0){cell.id=results[strongest].cell_id;cell.cp=results[strongest].cp;cell.frame_type=results[strongest].frame_type;cell.nof_prb=6;}
    if(found>0&&getenv("AIRWOLF_LTE_DEBUG"))fprintf(stderr,"LTE search pci=%u cfo=%f cp=%d tdd=%d\n",cell.id,results[strongest].cfo,cell.cp,cell.frame_type);
    srsran_ue_cellsearch_free(search);free(search);
    if(found<1||in.eof||in.gap)continue;
    srsran_ue_mib_sync_t* mib=calloc(1,sizeof(*mib));
    if(!mib)return;
    if(srsran_ue_mib_sync_init_multi(mib,receive,1,&in)){free(mib);return;}
    if(srsran_ue_mib_sync_set_cell(mib,cell)){srsran_ue_mib_sync_free(mib);free(mib);continue;}
    // Remove the cell-search CFO before finding/tracking the known cell. Do
    // not run integer-CFO estimation again on already corrected samples.
    srsran_ue_sync_cfo_reset(&mib->ue_sync,0);
    mib->ue_sync.cfo_current_value=results[strongest].cfo/15000.0f;
    mib->ue_sync.cfo_is_copied=true;
    mib->ue_sync.cfo_correct_enable_find=true;
    unsigned misses=0;int locked=0;
    while(!in.eof&&!in.gap&&misses<(locked?3U:1U)){
      uint8_t bits[SRSRAN_BCH_PAYLOAD_LEN]={0};uint32_t ports=0,sfn=0;int offset=0;
      const uint64_t start=in.end;
      int result=srsran_ue_mib_sync_decode(mib,10,bits,&ports,&offset);
      if(result==SRSRAN_UE_MIB_FOUND&&!in.eof&&!in.gap){
        srsran_pbch_mib_unpack(bits,&cell,&sfn);
        uint8_t bytes[3]={0};for(unsigned i=0;i<24;++i)bytes[i/8]|=bits[i]<<(7-i%8);
        emit(user,bytes,cell.id,cell.nof_prb,ports,(sfn+offset)%1024,cell.frame_type==SRSRAN_TDD,start,in.end);
        misses=0;locked=1;
      }else ++misses;
    }
    srsran_ue_mib_sync_free(mib);free(mib);
  }
}
