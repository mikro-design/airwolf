// SPDX-License-Identifier: AGPL-3.0-or-later
#include "si_schedule.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <random>
#define CHECK(x) do{if(!(x)){std::fprintf(stderr,"check failed line%d: %s\n",__LINE__,#x);return 1;}}while(0)
struct Writer{std::vector<uint8_t> bytes;unsigned count=0;void put(unsigned bits,unsigned value){for(unsigned i=bits;i;--i){if(count%8==0)bytes.push_back(0);bytes.back()|=((value>>(i-1))&1)<<(7-count%8);++count;}}};
static Writer sib1(unsigned period,unsigned window,unsigned messages,bool tdd,bool optional,unsigned plmns,unsigned mappings,bool extension){
  Writer w;w.put(2,1);w.put(1,optional);w.put(1,tdd);w.put(1,0);w.put(1,optional);w.put(3,plmns-1);
  for(unsigned p=0;p<plmns;++p){w.put(1,p==0);if(p==0){w.put(4,2);w.put(4,4);w.put(4,2);}w.put(1,p%2);for(unsigned d=0;d<2+p%2;++d)w.put(4,d);w.put(1,p%2);}
  w.put(16,1);w.put(28,0x1a2d401);w.put(3,4);if(optional)w.put(27,42);
  w.put(1,optional);w.put(6,48);if(optional)w.put(3,7);if(optional)w.put(6,63);w.put(6,6);w.put(5,messages-1);
  for(unsigned i=0;i<messages;++i){w.put(3,period);w.put(5,mappings);for(unsigned j=0;j<mappings;++j){w.put(1,extension);if(extension){w.put(1,0);w.put(6,j);}else w.put(4,j%16);}}
  if(tdd){w.put(3,2);w.put(4,7);}w.put(3,window);w.put(5,31);return w;
}
int main(){
  const unsigned windows[]={1,2,5,10,15,20,40};unsigned cases=0;
  for(unsigned p=0;p<7;++p)for(unsigned window=0;window<7;++window)for(unsigned flags=0;flags<4;++flags){
    unsigned messages=std::min(32U,(8U<<p)*10/windows[window]);
    auto w=sib1(p,window,messages,flags&1,flags&2,flags+1,flags*10,flags&1);airwolf_lte_si_schedule s{};
    CHECK(airwolf_lte_parse_si_schedule(w.bytes.data(),w.bytes.size(),&s));CHECK(s.count==messages&&s.window_ms==windows[window]&&s.tdd==(flags&1)&&s.value_tag==31);
    for(unsigned i=0;i<messages;++i)CHECK(s.period_frames[i]==(8U<<p));
    for(unsigned length=0;length<(w.count+7)/8;++length)CHECK(!airwolf_lte_parse_si_schedule(w.bytes.data(),length,&s));
    CHECK(airwolf_lte_parse_si_schedule(w.bytes.data(),w.bytes.size(),&s));
    for(unsigned tti=0;tti<10240;++tti){unsigned offset=0,epoch=0;int found=airwolf_lte_si_window(&s,tti/10,tti%10,&offset,&epoch);
      unsigned position=tti%((8U<<p)*10);int want=(tti%20==5||position>=messages*windows[window])?-1:position/windows[window];
      CHECK(found==want);if(found>=0){CHECK(offset==position%windows[window]);CHECK(epoch+offset==tti);}
    }++cases;
  }
  for(unsigned invalid=0;invalid<3;++invalid){auto w=sib1(invalid==0?7:0,invalid==1?7:0,1,0,0,invalid==2?7:1,0,0);airwolf_lte_si_schedule s{};CHECK(!airwolf_lte_parse_si_schedule(w.bytes.data(),w.bytes.size(),&s));}
  // Published upstream SIB1, not made with this test's bit writer.
  const uint8_t upstream[]={0x60,0x40,0x04,0x03,0x00,0x01,0x1a,0x2d,0x40,0x18,0x02,0x81,0x80,0x42,0x0c,0x80,0x00,0x00};
  airwolf_lte_si_schedule s{};CHECK(airwolf_lte_parse_si_schedule(upstream,sizeof(upstream),&s));
  std::printf("Upstream schedule: messages=%u window=%u period=%u tag=%u\n",s.count,s.window_ms,s.period_frames[0],s.value_tag);
  std::mt19937 rng(0x51b1);for(unsigned trial=0;trial<20000;++trial){std::vector<uint8_t>b(rng()%4097);for(auto&v:b)v=rng();airwolf_lte_parse_si_schedule(b.data(),b.size(),&s);}
  std::printf("%u schedule matrices, truncations, malformed bounds and20000 random buffers passed\n",cases);return 0;
}
