// SPDX-License-Identifier: AGPL-3.0-or-later
#include "bridge.h"
#include <srsran/phy/ue/ue_cell_search.h>
#include <srsran/phy/ue/ue_mib.h>
#include <string.h>
#include <stdlib.h>
#include <complex.h>
#include <math.h>
#define HISTORY_SAMPLES 576000U /* 300 ms at 1.92 MS/s, bounded native IQ only */
struct input {void* user;airwolf_lte_read read;int eof,gap,has_history;uint64_t first,end,next,history_first,history_end;float mix_hz;cf_t oscillator[128];cf_t* history;};
static void history_copy(struct input* in,cf_t* samples,uint64_t first,unsigned count,int save){
  unsigned at=first%HISTORY_SAMPLES,n=count;
  if(n>HISTORY_SAMPLES-at)n=HISTORY_SAMPLES-at;
  if(save){memcpy(in->history+at,samples,n*sizeof(cf_t));memcpy(in->history,samples+n,(count-n)*sizeof(cf_t));}
  else {memcpy(samples,in->history+at,n*sizeof(cf_t));memcpy(samples+n,in->history,(count-n)*sizeof(cf_t));}
}
static void rewind_search(struct input* in,uint64_t first){
  if(in->has_history){in->next=first<in->history_first?in->history_first:first;in->end=in->next;}
}
static int receive(void* user,cf_t* samples[SRSRAN_MAX_CHANNELS],uint32_t count,srsran_timestamp_t* ts){
  struct input* in=user;uint64_t first=in->next;
  if(!count)return 0;
  unsigned done=0;
  while(done<count){
    if(in->has_history&&in->next<in->history_end){
      unsigned n=count-done;if(n>in->history_end-in->next)n=in->history_end-in->next;
      history_copy(in,samples[0]+done,in->next,n,0);in->next+=n;done+=n;
    }else{
      uint64_t at=0;int got=in->read(in->user,samples[0]+done,count-done,&at);
      if(got<=0){in->eof=got==0;in->gap=got<0;if(in->gap)in->has_history=0;return SRSRAN_ERROR_RX_EOF;}
      if(!in->has_history){in->history_first=in->history_end=in->next=at;first=at;in->has_history=1;}
      if(at!=in->history_end){in->gap=1;in->has_history=0;return SRSRAN_ERROR_RX_EOF;}
      history_copy(in,samples[0]+done,at,got,1);in->history_end=in->next=at+got;done+=got;
      if(in->history_end-in->history_first>HISTORY_SAMPLES)in->history_first=in->history_end-HISTORY_SAMPLES;
    }
  }
  if(in->mix_hz!=0)for(uint32_t k=0;k<count;++k)samples[0][k]*=in->oscillator[(first+k)%128];
  in->first=first;in->end=first+count;
  // Synchronization discards samples with a null timestamp destination.
  if(ts){ts->full_secs=first/1920000;ts->frac_secs=(first%1920000)/1920000.0;}
  return count;
}
void airwolf_lte_run(void* user,airwolf_lte_read read,airwolf_lte_mib emit,airwolf_lte_search searched){
  struct input in={0};in.user=user;in.read=read;in.history=calloc(HISTORY_SAMPLES,sizeof(cf_t));if(!in.history)return;
  const float hypotheses[]={0,15000,-15000,30000,-30000,45000,-45000,60000,-60000,75000,-75000};
  unsigned attempt=0;uint64_t cycle_start=0;
  while(!in.eof){
    if(attempt%11==0)cycle_start=in.has_history?in.history_end:0;
    in.gap=0;rewind_search(&in,cycle_start);in.mix_hz=hypotheses[attempt++%11];
    // Hypotheses are integer multiples of 15 kHz at 1.92 MS/s: exactly
    // periodic over 128 samples, with no accumulated NCO phase/scale error.
    for(unsigned k=0;k<128;++k){double angle=-6.2831853071795864769*in.mix_hz*k/1920000;in.oscillator[k]=(float)cos(angle)+I*(float)sin(angle);}
    srsran_ue_cellsearch_t* search=calloc(1,sizeof(*search));
    if(!search)goto done;
    if(srsran_ue_cellsearch_init_multi(search,10,receive,1,&in)){free(search);goto done;}
    srsran_ue_cellsearch_set_nof_valid_frames(search,2);
    srsran_ue_cellsearch_result_t results[3]={0};uint32_t strongest=0;
    const int found=srsran_ue_cellsearch_scan(search,results,&strongest);
    if(found>=0&&searched)searched(user,(unsigned)found);
    // Prefer a consistent identity and a distinct correlation peak. Absolute
    // peak power alone can select an interferer over a decodable nearby cell.
    for(unsigned i=0;i<3;++i)if(results[i].psr*results[i].mode>results[strongest].psr*results[strongest].mode)strongest=i;
    if(getenv("AIRWOLF_LTE_DEBUG"))for(unsigned i=0;i<3;++i)fprintf(stderr,"LTE candidate mix=%.0f pci=%u mode=%.2f psr=%.2f peak=%.2f cfo=%.0f\n",in.mix_hz,results[i].cell_id,results[i].mode,results[i].psr,results[i].peak,results[i].cfo);
    srsran_cell_t cell={0};
    if(found>0){cell.id=results[strongest].cell_id;cell.cp=results[strongest].cp;cell.frame_type=results[strongest].frame_type;cell.nof_prb=6;}
    if(found>0&&getenv("AIRWOLF_LTE_DEBUG"))fprintf(stderr,"LTE search pci=%u cfo=%f cp=%d tdd=%d\n",cell.id,results[strongest].cfo,cell.cp,cell.frame_type);
    srsran_ue_cellsearch_free(search);free(search);
    if(found<1||in.eof||in.gap)continue;
    rewind_search(&in,cycle_start);
    srsran_ue_mib_sync_t* mib=calloc(1,sizeof(*mib));
    if(!mib)goto done;
    if(srsran_ue_mib_sync_init_multi(mib,receive,1,&in)){free(mib);goto done;}
    if(srsran_ue_mib_sync_set_cell(mib,cell)){srsran_ue_mib_sync_free(mib);free(mib);continue;}
    // Seed the known-cell synchronizer with the residual search estimate. Its
    // tracking loop keeps refining it after acquisition.
    srsran_ue_sync_cfo_reset(&mib->ue_sync,0);
    mib->ue_sync.cfo_current_value=results[strongest].cfo/15000.0f;
    mib->ue_sync.cfo_is_copied=true;
    mib->ue_sync.cfo_correct_enable_find=true;
    int locked=0;uint64_t observation_start=in.end,last_mib=in.end;
    // Keep the synchronizer running between PBCH observations. The upstream
    // one-shot mib_sync_decode helper resets timing/CFO tracking on every call.
    while(!in.eof&&!in.gap&&in.end-last_mib<(locked?576000U:192000U)){
      uint8_t bits[SRSRAN_BCH_PAYLOAD_LEN]={0};uint32_t ports=0,sfn=0;int offset=0;
      int synchronized=srsran_ue_sync_zerocopy(&mib->ue_sync,mib->sf_buffer,3*SRSRAN_SF_LEN_PRB(SRSRAN_UE_MIB_NOF_PRB));
      if(synchronized<0||in.eof||in.gap)break;
      if(synchronized!=1){srsran_ue_mib_reset(&mib->ue_mib);continue;}
      if(srsran_ue_sync_get_sfidx(&mib->ue_sync)!=0)continue;
      int result=srsran_ue_mib_decode(&mib->ue_mib,bits,&ports,&offset);
      if(result==SRSRAN_UE_MIB_FOUND&&!in.eof&&!in.gap){
        // TS 36.331 MIB dl-Bandwidth has six values. The upstream unpacker
        // maps reserved encodings 6/7 to 125/150 PRB. A CRC coincidence in
        // weak live IQ must not publish an impossible cell configuration.
        // Later releases use former spare bits; do not require those zero.
        const unsigned bandwidth=(bits[0]<<2)|(bits[1]<<1)|bits[2];
        if(bandwidth>5||(ports!=1&&ports!=2&&ports!=4))continue;
        srsran_pbch_mib_unpack(bits,&cell,&sfn);
        uint8_t bytes[3]={0};for(unsigned i=0;i<24;++i)bytes[i/8]|=bits[i]<<(7-i%8);
        emit(user,bytes,cell.id,cell.nof_prb,ports,(sfn+offset)%1024,cell.frame_type==SRSRAN_TDD,observation_start,in.end);
        observation_start=last_mib=in.end;locked=1;
      }
    }
    srsran_ue_mib_sync_free(mib);free(mib);
    if(locked)attempt=0; // Never replay already published observation intervals.
  }
done:
  free(in.history);
}
