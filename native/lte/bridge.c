// SPDX-License-Identifier: AGPL-3.0-or-later
#include "bridge.h"
#include "mib_confirmation.h"
#include <srsran/phy/ue/ue_cell_search.h>
#include <srsran/phy/ue/ue_mib.h>
#include <string.h>
#include <stdlib.h>
#include <complex.h>
#include <math.h>
#define HISTORY_SAMPLES 576000U /* 300 ms at 1.92 MS/s, bounded native IQ only */
struct input {void* user;airwolf_lte_read read;int eof,gap,has_history;uint64_t first,end,next,history_first,history_end;float mix_hz;cf_t oscillator[128];cf_t* history;};
// Residual CFO from antenna port 0 CRS in the MIB's subframe 0, in units of
// the 15 kHz subcarrier spacing. Symbol 0 and symbol 4 of slot 0 are compared
// with the same symbols of slot 1, exactly 0.5 ms later (unambiguous +/-1 kHz).
// Every cell transmits port 0; the phase ratio cancels the static channel.
static float mib_crs_cfo(srsran_ue_mib_t* m){
  srsran_chest_dl_t* chest=&m->chest;srsran_dl_sf_cfg_t sf;memset(&sf,0,sizeof(sf));
  const uint32_t count=srsran_refsignal_cs_nof_re(&chest->csr_refs,&sf,0),quarter=count/4;
  if(!quarter||count%4)return NAN;
  srsran_refsignal_cs_get_sf(&chest->csr_refs,&sf,0,m->sf_symbols,chest->pilot_recv_signal);
  srsran_vec_prod_conj_ccc(chest->pilot_recv_signal,chest->csr_refs.pilots[0][0],chest->pilot_estimates,count);
  const cf_t* h=chest->pilot_estimates;cf_t sum=0;
  for(uint32_t k=0;k<quarter;++k)sum+=h[k]*conjf(h[2*quarter+k])+h[quarter+k]*conjf(h[3*quarter+k]);
  if(!(cabsf(sum)>0))return NAN;
  return -cargf(sum)/(2*(float)M_PI*0.0005f*15000);
}
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
static void correct_context_cfo(cf_t* samples,unsigned count,float cfo_hz){
  for(unsigned k=0;k<count;++k){
    double phase=-6.2831853071795864769*cfo_hz*k/1920000;
    samples[k]*=(float)cos(phase)+I*(float)sin(phase);
  }
}
static int validate_tail_sync(struct input* in,const airwolf_lte_search_context* context,
                             uint64_t end,cf_t* samples){
  // PBCH alone cannot establish FDD versus TDD. Corroborate the alignment and
  // supplied cell with an independently decoded SSS identity and PSS position.
  // Do not use the known-identity SSS ratio shortcut for this check.
  srsran_sync_t* sync=calloc(1,sizeof(*sync));int ready=0,valid=0;
  if(!sync)goto done;
  if(srsran_sync_init(sync,1920,1920,128))goto done;ready=1;
  srsran_sync_set_N_id_2(sync,context->pci%3);
  srsran_sync_set_cp(sync,context->extended_cp?SRSRAN_CP_EXT:SRSRAN_CP_NORM);
  srsran_sync_cp_en(sync,false);
  srsran_sync_set_frame_type(sync,context->tdd?SRSRAN_TDD:SRSRAN_FDD);
  srsran_sync_set_threshold(sync,2.0f);
  const unsigned prefix=context->tdd?960:1920;
  for(unsigned half_frame=0;half_frame<60;++half_frame){
    const uint64_t back=prefix+(uint64_t)half_frame*9600;
    if(end<back||end-back<in->history_first)break;
    const uint64_t start=end-back;
    if(start+1920>in->history_end)continue;
    history_copy(in,samples,start,1920,0);correct_context_cfo(samples,1920,context->cfo_hz);
    srsran_sync_reset(sync);unsigned peak=0;
    int found=srsran_sync_find(sync,samples,0,&peak);
    const unsigned expected_sf=(half_frame%2?5:0)+(context->tdd?1:0);
    const unsigned expected_peak=context->tdd?(context->extended_cp?1440:1372):960;
    if(found==SRSRAN_SYNC_FOUND&&srsran_sync_sss_detected(sync)&&
       srsran_sync_get_cell_id(sync)==(int)context->pci&&srsran_sync_get_sf_idx(sync)==expected_sf&&
       abs((int)peak-(int)expected_peak)<=16){valid=1;break;}
  }
done:
  if(ready)srsran_sync_free(sync);free(sync);return valid;
}
static void decode_selected_tail(struct input* in,const airwolf_lte_search_context* context,
                                airwolf_lte_mib emit,airwolf_lte_candidate candidate,uint64_t last_published){
  // A retained MIB interval ends at its last decoded SF0. Try that bounded
  // alignment hypothesis directly when cold PSS acquisition cannot reach both
  // observations in a short selection. Every hypothesis must independently
  // pass physical synchronization and PBCH integrity/progression checks.
  // SFN, MIB bytes and integrity are never supplied by the recorded annotation.
  const unsigned sf_len=1920;
  if(!in->has_history||in->history_end-in->history_first<11*sf_len)return;
  cf_t* sf=srsran_vec_cf_malloc(sf_len);
  srsran_ue_mib_t* mib=calloc(1,sizeof(*mib));int ready=0;
  if(!sf||!mib)goto done;
  if(srsran_ue_mib_init(mib,sf,6))goto done;ready=1;
  srsran_cell_t cell={0};cell.id=context->pci;cell.nof_prb=6;cell.nof_ports=context->ports;
  cell.cp=context->extended_cp?SRSRAN_CP_EXT:SRSRAN_CP_NORM;cell.frame_type=context->tdd?SRSRAN_TDD:SRSRAN_FDD;
  if(srsran_ue_mib_set_cell(mib,cell))goto done;
  for(unsigned shift=0;shift<3;++shift){
    uint64_t end=in->history_end-shift;
    if(end<=last_published+192||end-in->history_first<11*sf_len)continue;
    if(!validate_tail_sync(in,context,end,sf))continue;
    airwolf_lte_mib_confirmation confirmation={0};
    const uint64_t first_stop=end-(end-in->history_first-sf_len)/(10*sf_len)*(10*sf_len);
    uint64_t observation_first=first_stop-sf_len;
    srsran_ue_mib_reset(mib);
    for(uint64_t stop=first_stop;stop<=end;stop+=10*sf_len){
      const uint64_t start=stop-sf_len;
      history_copy(in,sf,start,sf_len,0);
      correct_context_cfo(sf,sf_len,context->cfo_hz);
      // PBCH may need several radio frames. ue_mib resets its combining state
      // after each CRC success, so confirmed observations never share samples.
      // No combining state is inherited from another alignment hypothesis.
      uint8_t bits[24]={0};unsigned ports=0,sfn=0;int offset=0;
      if(srsran_ue_mib_decode(mib,bits,&ports,&offset)!=SRSRAN_UE_MIB_FOUND)continue;
      if(candidate)candidate(in->user);
      srsran_cell_t decoded=cell;srsran_pbch_mib_unpack(bits,&decoded,&sfn);
      if(decoded.nof_prb!=context->prb||ports!=context->ports||
         (unsigned)decoded.phich_length!=context->phich_extended||
         (unsigned)decoded.phich_resources!=context->phich_resources){confirmation.have=0;observation_first=stop;continue;}
      airwolf_lte_mib_observation value={0};
      for(unsigned k=0;k<24;++k)value.bytes[k/8]|=bits[k]<<(7-k%8);
      value.pci=context->pci;value.prb=decoded.nof_prb;value.ports=ports;value.sfn=(sfn+offset)%1024;
      value.tdd=context->tdd;value.extended_cp=context->extended_cp;value.cfo_hz=context->cfo_hz;
      value.first=airwolf_lte_pbch_support_first(observation_first,stop);value.end=stop;observation_first=stop;
      const uint64_t anchor=confirmation.previous.end;uint64_t first=0;
      if(airwolf_lte_confirm_mib(&confirmation,&value,&first)&&stop==end){
        emit(in->user,value.bytes,value.pci,value.prb,value.ports,value.sfn,value.tdd,value.extended_cp,value.cfo_hz,first,stop,anchor,value.cfo_hz);
        goto done;
      }
    }
  }
done:
  if(ready)srsran_ue_mib_free(mib);free(mib);free(sf);
}
// Reads and keeps (in history) the next `samples` of input without searching.
static void idle(struct input* in,uint64_t samples){
  cf_t buffer[1920];cf_t* channels[SRSRAN_MAX_CHANNELS]={buffer};
  const uint64_t until=in->end+samples;in->mix_hz=0;
  while(!in->eof&&!in->gap&&in->end<until){
    if(in->has_history)in->next=in->history_end;
    if(receive(in,channels,1920,NULL)<0)break;
  }
}
void airwolf_lte_run(void* user,airwolf_lte_read read,airwolf_lte_mib emit,airwolf_lte_search searched,airwolf_lte_candidate candidate,const airwolf_lte_search_context* context,int live){
  if(context&&(context->pci>503||context->tdd>1||context->extended_cp>1||
      (context->prb!=6&&context->prb!=15&&context->prb!=25&&context->prb!=50&&context->prb!=75&&context->prb!=100)||
      (context->ports!=1&&context->ports!=2&&context->ports!=4)||context->phich_extended>1||context->phich_resources>3||
      !isfinite(context->cfo_hz)||fabsf(context->cfo_hz)>250000))return;
  const int debug_context=context&&getenv("AIRWOLF_LTE_DEBUG");
  struct input in={0};in.user=user;in.read=read;in.history=calloc(HISTORY_SAMPLES,sizeof(cf_t));if(!in.history)return;
  const float hypotheses[]={0,15000,-15000,30000,-30000,45000,-45000,60000,-60000,75000,-75000};
  unsigned attempt=0;uint64_t cycle_start=0,last_published=0;
  // FFT plans and cell-search storage are independent of each frequency/CP
  // hypothesis. Retain them across failed searches instead of rebuilding them.
  srsran_ue_cellsearch_t* search=calloc(1,sizeof(*search));
  srsran_ue_mib_sync_t* mib=calloc(1,sizeof(*mib));
  int search_ready=0,mib_ready=0,mib_used=0;
  if(!search||!mib)goto done;
  if(srsran_ue_cellsearch_init_multi(search,10,receive,1,&in))goto done;
  search_ready=1;
  if(srsran_ue_mib_sync_init_multi(mib,receive,1,&in))goto done;
  mib_ready=1;
  // A live search with no cell in view: one cycle is all 22 CFO/CP
  // hypotheses over the same 300 ms of history, about a fifth of a core on
  // its own. After two cycles without a single PSS candidate, pause 0.25 s
  // between cycles, doubling to 1 s; any candidate, gap or retune resumes
  // full speed. A cell that appears is found within the pause plus one
  // cycle: 0.1-1.3 s on the recorded FDD and TDD cells.
  unsigned empty_cycles=0;int cycle_found=0;
  while(!in.eof){
    if(!context&&attempt%22==0){
      if(attempt&&live&&!cycle_found)++empty_cycles;else empty_cycles=0;
      cycle_found=0;
      if(empty_cycles>=2){
        const unsigned shift=empty_cycles-2<2?empty_cycles-2:2;
        idle(&in,(480000ULL<<shift));
        if(in.gap)empty_cycles=0;
      }
    }
    if(context||attempt%22==0)cycle_start=in.has_history?in.history_end:0;
    const srsran_cp_t cp=(attempt%2)?SRSRAN_CP_EXT:SRSRAN_CP_NORM;
    in.gap=0;rewind_search(&in,cycle_start);in.mix_hz=context?0:hypotheses[(attempt/2)%11];++attempt;
    // Hypotheses are integer multiples of 15 kHz at 1.92 MS/s: exactly
    // periodic over 128 samples, with no accumulated NCO phase/scale error.
    for(unsigned k=0;k<128;++k){double angle=-6.2831853071795864769*in.mix_hz*k/1920000;in.oscillator[k]=(float)cos(angle)+I*(float)sin(angle);}
    srsran_cell_t cell={0};srsran_ue_cellsearch_result_t results[3]={0};uint32_t strongest=0;int found=0;
    if(context){
      // Physical receive hints avoid an all-cell scan exhausting a short IQ
      // selection. They supply neither MIB bytes nor SFN: independent PBCH
      // observations below must still pass CRC and progression confirmation.
      cell.id=context->pci;cell.nof_prb=6;cell.cp=context->extended_cp?SRSRAN_CP_EXT:SRSRAN_CP_NORM;
      cell.frame_type=context->tdd?SRSRAN_TDD:SRSRAN_FDD;results[0].cfo=context->cfo_hz;found=1;
    }else{
    // SSS location depends on CP before the upstream CP detector runs. Search
    // both explicit layouts rather than accepting a wrong identity first.
    srsran_sync_set_cp(&search->ue_sync.sfind,cp);
    srsran_sync_set_cp(&search->ue_sync.strack,cp);
    search->ue_sync.cell.cp=cp;
    srsran_ue_cellsearch_set_nof_valid_frames(search,2);
    found=srsran_ue_cellsearch_scan(search,results,&strongest);
    if(found>=0&&searched)searched(user,(unsigned)found);
    if(found>0)cycle_found=1;
    if(in.gap)empty_cycles=0;
    // Prefer a consistent identity and a distinct correlation peak. Absolute
    // peak power alone can select an interferer over a decodable nearby cell.
    for(unsigned i=0;i<3;++i)if(results[i].psr*results[i].mode>results[strongest].psr*results[strongest].mode)strongest=i;
    if(getenv("AIRWOLF_LTE_DEBUG"))for(unsigned i=0;i<3;++i)fprintf(stderr,"LTE candidate mix=%.0f pci=%u mode=%.2f psr=%.2f peak=%.2f cfo=%.0f\n",in.mix_hz,results[i].cell_id,results[i].mode,results[i].psr,results[i].peak,results[i].cfo);
    if(found>0){cell.id=results[strongest].cell_id;cell.cp=results[strongest].cp;cell.frame_type=results[strongest].frame_type;cell.nof_prb=6;}
    if(found>0&&getenv("AIRWOLF_LTE_DEBUG"))fprintf(stderr,"LTE search pci=%u cfo=%f cp=%d tdd=%d\n",cell.id,results[strongest].cfo,cell.cp,cell.frame_type);
    }
    if(found<1||in.eof||in.gap)continue;
    rewind_search(&in,cycle_start);
    // A failed attempt leaves synchronizer, CFO and PBCH state behind that
    // srsRAN's set_cell/reset do not clear. Reusing it made every later,
    // correct cell hypothesis fail PBCH (0 of 118 MIBs at some start
    // offsets). Start each used attempt from a freshly initialized object.
    if(mib_used){
      srsran_ue_mib_sync_free(mib);memset(mib,0,sizeof(*mib));mib_ready=0;
      if(srsran_ue_mib_sync_init_multi(mib,receive,1,&in))goto done;
      mib_ready=1;
    }
    mib_used=1;
    srsran_ue_mib_reset(&mib->ue_mib);
    if(srsran_ue_mib_sync_set_cell(mib,cell))continue;
    // Seed the known-cell synchronizer with the residual search estimate. Its
    // tracking loop keeps refining it after acquisition.
    srsran_ue_sync_cfo_reset(&mib->ue_sync,0);
    mib->ue_sync.cfo_current_value=results[strongest].cfo/15000.0f;
    mib->ue_sync.cfo_is_copied=true;
    mib->ue_sync.cfo_correct_enable_find=true;
    if(context)srsran_sync_set_cfo_cp_enable(&mib->ue_sync.sfind,false,0);
    int locked=0;uint64_t observation_start=in.end,last_mib=in.end;
    airwolf_lte_mib_confirmation confirmation={0};
    // Keep the synchronizer running between PBCH observations. The upstream
    // one-shot mib_sync_decode helper resets timing/CFO tracking on every call.
    while(!in.eof&&!in.gap&&in.end-last_mib<(locked?576000U:confirmation.have?384000U:192000U)){
      uint8_t bits[SRSRAN_BCH_PAYLOAD_LEN]={0};uint32_t ports=0,sfn=0;int offset=0;
      const float applied_cfo=in.mix_hz+srsran_ue_sync_get_cfo(&mib->ue_sync);
      int synchronized=srsran_ue_sync_zerocopy(&mib->ue_sync,mib->sf_buffer,3*SRSRAN_SF_LEN_PRB(SRSRAN_UE_MIB_NOF_PRB));
      if(debug_context)fprintf(stderr,"LTE context sync=%d sf=%u input=%llu cfo=%.1f pss=%.2f sss=%d cp-cfo=%.2f\n",synchronized,srsran_ue_sync_get_sfidx(&mib->ue_sync),(unsigned long long)in.end,srsran_ue_sync_get_cfo(&mib->ue_sync),mib->ue_sync.sfind.peak_value,mib->ue_sync.sfind.sss_detected,mib->ue_sync.sfind.cfo_cp_mean);
      if(synchronized<0||in.eof||in.gap)break;
      if(synchronized!=1){srsran_ue_mib_reset(&mib->ue_mib);confirmation.have=0;continue;}
      if(srsran_ue_sync_get_sfidx(&mib->ue_sync)!=0)continue;
      int result=srsran_ue_mib_decode(&mib->ue_mib,bits,&ports,&offset);
      // srsRAN's tracking loop ignores PSS CFO below 400 Hz (typical PSS
      // bias); a full UE closes that gap with CRS from ue_dl, which the MIB
      // path never runs. The cell search's estimate is typically 250-300 Hz
      // off, so every track kept that error and PBCH failed on weak real
      // captures. Close the loop on port 0 CRS while PSS sees no larger
      // error (so the true residual is inside the +/-1 kHz CRS range).
      // Gain 0.3 per frame settles within about 0.5 s.
      if(result>=0){
        const float fine=mib_crs_cfo(&mib->ue_mib),limit=400.f/15000;
        if(isfinite(fine)&&fabsf(srsran_sync_get_cfo(&mib->ue_sync.strack))<limit)
          mib->ue_sync.cfo_current_value+=0.3f*fminf(fmaxf(fine,-limit),limit);
      }
      if(debug_context)fprintf(stderr,"LTE context PBCH result=%d input=%llu\n",result,(unsigned long long)in.end);
      if(result==SRSRAN_UE_MIB_FOUND&&!in.eof&&!in.gap){
        if(candidate)candidate(user);
        // TS 36.331 MIB dl-Bandwidth has six values. The upstream unpacker
        // maps reserved encodings 6/7 to 125/150 PRB. A CRC coincidence in
        // weak live IQ must not publish an impossible cell configuration.
        // Later releases use former spare bits; do not require those zero.
        const unsigned bandwidth=(bits[0]<<2)|(bits[1]<<1)|bits[2];
        if(bandwidth>5||(ports!=1&&ports!=2&&ports!=4))continue;
        srsran_pbch_mib_unpack(bits,&cell,&sfn);
        uint8_t bytes[3]={0};for(unsigned i=0;i<24;++i)bytes[i/8]|=bits[i]<<(7-i%8);
        airwolf_lte_mib_observation observation={0};memcpy(observation.bytes,bytes,3);
        observation.pci=cell.id;observation.prb=cell.nof_prb;observation.ports=ports;observation.sfn=(sfn+offset)%1024;
        observation.tdd=cell.frame_type==SRSRAN_TDD;observation.extended_cp=cell.cp==SRSRAN_CP_EXT;
        observation.cfo_hz=in.mix_hz+srsran_ue_sync_get_cfo(&mib->ue_sync);
        observation.first=airwolf_lte_pbch_support_first(observation_start,in.end);observation.end=in.end;
        uint64_t context_first=observation.first;
        const uint64_t anchor_end=confirmation.previous.end;
        const float anchor_cfo=confirmation.previous.cfo_hz;
        if(airwolf_lte_confirm_mib(&confirmation,&observation,&context_first)){
          // Replay must use the correction actually applied to this subframe,
          // before PSS tracking updates the estimate for the following one.
          emit(user,bytes,observation.pci,observation.prb,observation.ports,observation.sfn,observation.tdd,observation.extended_cp,applied_cfo,context_first,in.end,anchor_end,anchor_cfo);
          last_published=in.end;
          last_mib=in.end;locked=1;
        }
        // ue_mib resets its combining buffer after each raw CRC success. The
        // next candidate therefore must use newly consumed PBCH samples.
        observation_start=in.end;
      }
    }
    if(locked)attempt=0; // Never replay already published observation intervals.
  }
done:
  if(search_ready)srsran_ue_cellsearch_free(search);free(search);
  if(mib_ready)srsran_ue_mib_sync_free(mib);free(mib);
  if(context&&in.eof&&!in.gap)decode_selected_tail(&in,context,emit,candidate,last_published);
  free(in.history);
}
