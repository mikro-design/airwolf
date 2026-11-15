// SPDX-License-Identifier: AGPL-3.0-or-later
#include "mib_confirmation.h"
#include <stdio.h>
#include <stdlib.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"Failed %s at%d\n",#x,__LINE__);abort();}}while(0)
static airwolf_lte_mib_observation frame(unsigned sfn,uint64_t first,uint64_t end){
  airwolf_lte_mib_observation f={0};f.bytes[0]=(uint8_t)(0xa8|(sfn>>8));f.bytes[1]=(uint8_t)(sfn&0xfc);
  f.pci=42;f.prb=100;f.ports=2;f.sfn=sfn;f.first=first;f.end=end;return f;
}
int main(void){
  airwolf_lte_mib_confirmation state={0};uint64_t first=99;
  airwolf_lte_mib_observation a=frame(1023,0,19200),b=frame(0,19200,38400),c=frame(1,38400,57600);
  CHECK(!airwolf_lte_confirm_mib(&state,&a,&first)&&first==99);
  CHECK(!airwolf_lte_confirm_mib(&state,&a,&first)); // Same physical samples never confirm twice.
  CHECK(airwolf_lte_confirm_mib(&state,&b,&first)&&first==0);
  CHECK(!airwolf_lte_confirm_mib(&state,&a,&first)); // Rewind cannot replace the latest observation.
  CHECK(airwolf_lte_confirm_mib(&state,&c,&first)&&first==19200);
  for(unsigned kind=0;kind<10;++kind){
    memset(&state,0,sizeof(state));CHECK(!airwolf_lte_confirm_mib(&state,&a,NULL));b=frame(0,19200,38400);
    switch(kind){case 0:b.pci++;break;case 1:b.prb=50;break;case 2:b.ports=4;break;case 3:b.tdd=1;break;case 4:b.extended_cp=1;break;case 5:b.bytes[0]^=4;break;case 6:b.sfn=19;break;case 7:b.end+=1000;break;case 8:b.first=100;break;case 9:b.sfn=30;b.end+=30*19200;break;}
    CHECK(!airwolf_lte_confirm_mib(&state,&b,NULL));
  }
  memset(&state,0,sizeof(state));CHECK(!airwolf_lte_confirm_mib(&state,&a,NULL));
  b=frame(2,19200,4*19200+100);CHECK(airwolf_lte_confirm_mib(&state,&b,&first)&&first==0); // Missed frame + small sample-clock drift.
  b=frame(5,4*19200+100,7*19200+200);CHECK(airwolf_lte_confirm_mib(&state,&b,NULL));
  puts("MIB confirmation: independent observations, SFN wrap/gaps, cell fields, timing and rewind rejection");return 0;
}
