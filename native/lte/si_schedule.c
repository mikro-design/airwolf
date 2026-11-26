// SPDX-License-Identifier: AGPL-3.0-or-later
#include "si_schedule.h"
#include <string.h>
struct bits { const uint8_t* data;size_t count,at;int ok; };
static unsigned take(struct bits* b,unsigned n){
  if(!b->ok||n>32||n>b->count-b->at){b->ok=0;return 0;}
  unsigned v=0;for(unsigned i=0;i<n;++i){v=(v<<1)|((b->data[b->at/8]>>(7-b->at%8))&1);++b->at;}return v;
}
static unsigned limited(struct bits* b,unsigned n,unsigned max){unsigned v=take(b,n);if(v>max)b->ok=0;return v;}
int airwolf_lte_parse_si_schedule(const uint8_t* bytes,size_t count,airwolf_lte_si_schedule* schedule){
  if(!schedule)return 0;memset(schedule,0,sizeof(*schedule));
  if(!bytes||count<2||count>4096)return 0;
  struct bits b={bytes,count*8,0,1};airwolf_lte_si_schedule out={0};
  if(take(&b,2)!=1)return 0; // BCCH-DL-SCH c1 / SIB1.
  unsigned pmax=take(&b,1);out.tdd=take(&b,1);const unsigned extension=take(&b,1);
  unsigned csg=take(&b,1),plmns=limited(&b,3,5)+1;
  for(unsigned p=0;p<plmns;++p){
    unsigned mcc=take(&b,1);if(p==0&&!mcc)return 0;
    if(mcc)for(unsigned d=0;d<3;++d)limited(&b,4,9);
    unsigned mnc=take(&b,1)+2;for(unsigned d=0;d<mnc;++d)limited(&b,4,9);
    take(&b,1); // cellReservedForOperatorUse.
  }
  take(&b,16);take(&b,28);take(&b,3);if(csg)take(&b,27);
  unsigned qoffset=take(&b,1);limited(&b,6,48);if(qoffset)take(&b,3);
  if(pmax)take(&b,6);take(&b,6); // p-Max / freqBandIndicator.
  out.count=take(&b,5)+1;
  for(unsigned i=0;i<out.count;++i){
    unsigned period=limited(&b,3,6);out.period_frames[i]=8U<<period;
    unsigned mappings=take(&b,5);
    for(unsigned j=0;j<mappings;++j){
      if(take(&b,1)){
        // Normally-small extended enum index. Large/fragmented future encodings
        // are unsupported and must not accidentally alter the receive schedule.
        if(take(&b,1))return 0;take(&b,6);
      }else take(&b,4);
    }
  }
  if(out.tdd){out.subframe_assignment=limited(&b,3,6);out.special_subframe_pattern=limited(&b,4,8);}
  static const unsigned windows[]={1,2,5,10,15,20,40};
  unsigned w=limited(&b,3,6);if(!b.ok)return 0;out.window_ms=windows[w];
  out.value_tag=take(&b,5);if(!b.ok)return 0;
  // TS36.331 Rel-11 tdd-Config-v1130 replaces the Release-8 special subframe
  // pattern. Reach it through the v890 and v920 extensions. A malformed or
  // fragmented extension keeps the Release-8 fields, which a UE of that
  // release would use.
  if(extension&&out.tdd){
    struct bits e=b;
    const unsigned late=take(&e,1),v920=take(&e,1);
    if(late){
      unsigned length=take(&e,8);
      if(length&0x80){if(length&0x40)e.ok=0;else length=((length&0x3f)<<8)|take(&e,8);}
      if(e.ok&&length*8U<=e.count-e.at)e.at+=length*8U;else e.ok=0;
    }
    if(e.ok&&v920){
      take(&e,1);const unsigned selection=take(&e,1),v1130=take(&e,1);
      if(selection){const unsigned offset=take(&e,1);take(&e,5);if(offset)take(&e,3);}
      if(v1130){const unsigned tdd=take(&e,1);take(&e,2);const unsigned ssp9=tdd?take(&e,1):0;if(e.ok&&tdd)out.special_subframe_pattern=ssp9?9:7;}
    }
  }
  for(unsigned i=0;i<out.count;++i)if(i*out.window_ms>=out.period_frames[i]*10)return 0;
  for(unsigned i=0;i<out.count;++i)for(unsigned j=0;j<i;++j){
    unsigned period=(out.period_frames[i]<out.period_frames[j]?out.period_frames[i]:out.period_frames[j])*10;
    unsigned distance=((i-j)*out.window_ms)%period;
    if(distance<out.window_ms||period-distance<out.window_ms)return 0;
  }
  *schedule=out;return 1;
}
int airwolf_lte_si_window(const airwolf_lte_si_schedule* schedule,unsigned sfn,unsigned subframe,unsigned* offset,unsigned* epoch){
  if(!schedule||!schedule->count||schedule->count>32||sfn>1023||subframe>9||!schedule->window_ms)return -1;
  if(subframe==5&&!(sfn%2))return -1; // SIB1 has its separate HARQ process.
  for(unsigned i=0;i<schedule->count;++i){
    unsigned period=schedule->period_frames[i]*10,start=i*schedule->window_ms;
    if(!period)continue;
    unsigned tti=sfn*10+subframe,position=tti%period;
    if(position>=start&&position-start<schedule->window_ms){
      if(offset)*offset=position-start;if(epoch)*epoch=tti-position+start;return (int)i;
    }
  }
  return -1;
}
int airwolf_lte_dwpts_config(unsigned pattern,int extended_cp){
  if(!extended_cp)return pattern<10?(int)pattern:-1;
  // Extended-CP DwPTS symbols 3,8,9,10,3,8,9,5 for patterns 0-7.
  static const int same[]={0,-1,1,2,0,-1,1,-1};
  return pattern<8?same[pattern]:-1;
}
