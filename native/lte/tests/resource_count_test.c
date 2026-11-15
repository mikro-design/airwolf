// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent RE-by-RE oracle; does not call the PHY's mapping/count helpers.
#include <srsran/phy/phch/ra_dl.h>
#include <stdio.h>
#include <stdlib.h>
extern uint32_t ra_re_x_prb(const srsran_cell_t*,srsran_dl_sf_cfg_t*,uint32_t,uint32_t);
static unsigned expected(const srsran_cell_t* c,unsigned sf,unsigned cfi,unsigned slot,unsigned prb){
  const unsigned ns=c->cp==SRSRAN_CP_EXT?6:7,control=cfi+(c->nof_prb<=10),carriers=c->nof_prb*12;
  unsigned re=0;
  for(unsigned l=slot?0:control;l<ns;++l)for(unsigned k=0;k<12;++k){
    unsigned frequency=prb*12+k;
    int central=frequency>=carriers/2-36&&frequency<carriers/2+36;
    if(central){
      if(slot==1&&sf==0&&l<4)continue; // PBCH, including reserved REs.
      if(c->frame_type==SRSRAN_FDD&&slot==0&&(sf==0||sf==5)&&l>=ns-2)continue;
      if(c->frame_type==SRSRAN_TDD&&slot==1&&(sf==0||sf==5)&&l==ns-1)continue;
    }
    int reference=l==0||l==(c->cp==SRSRAN_CP_EXT?3:4)||(c->nof_ports==4&&l==1);
    if(reference){
      if(c->nof_ports==1){unsigned shift=(c->id+(l==0?0:3))%6;if(k%6==shift)continue;}
      else if(k%3==c->id%3)continue;
    }
    ++re;
  }
  return re;
}
int main(void){
  unsigned checks=0;
  const unsigned bandwidths[]={6,15,25,50,75,100};
  for(unsigned b=0;b<6;++b)for(unsigned cp=0;cp<2;++cp)for(unsigned tdd=0;tdd<2;++tdd)
  for(unsigned ports=1;ports<=4;ports*=2)for(unsigned cfi=1;cfi<=3;++cfi)for(unsigned sf=0;sf<10;++sf){
    // Normal downlink subframes for TDD UL/DL configuration2. Special subframe
    // resource counts have different DwPTS rules and are not exercised here.
    if(tdd&&(sf==1||sf==2||sf==6||sf==7))continue;
    srsran_cell_t c={0};c.nof_prb=bandwidths[b];c.cp=cp?SRSRAN_CP_EXT:SRSRAN_CP_NORM;c.frame_type=tdd?SRSRAN_TDD:SRSRAN_FDD;c.nof_ports=ports;c.id=42;
    srsran_dl_sf_cfg_t config={0};config.tti=sf;config.cfi=cfi;config.tdd_config.configured=tdd;config.tdd_config.sf_config=2;config.tdd_config.ss_config=7;
    for(unsigned slot=0;slot<2;++slot)for(unsigned prb=0;prb<c.nof_prb;++prb){
      unsigned want=expected(&c,sf,cfi,slot,prb),got=ra_re_x_prb(&c,&config,slot,prb);
      if(want!=got){fprintf(stderr,"RE count: bandwidth=%u cp=%u tdd=%u ports=%u cfi=%u sf=%u slot=%u prb=%u: expected%u got%u\n",c.nof_prb,cp,tdd,ports,cfi,sf,slot,prb,want,got);return 1;}++checks;
    }
  }
  printf("%u independent PDSCH resource-count checks passed\n",checks);return 0;
}
