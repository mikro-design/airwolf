// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared-library PDCCH/PDSCH TX integration waveform. Not independent PHY evidence.
#include <srsran/phy/enb/enb_dl.h>
#include <srsran/phy/phch/ra_dl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char**argv) {
  if(argc<3)return 2;
  srsran_cell_t cell={0};cell.nof_prb=atoi(argv[2]);cell.id=argc>3?atoi(argv[3]):42;cell.nof_ports=argc>4?atoi(argv[4]):1;cell.cp=argc>8&&atoi(argv[8])?SRSRAN_CP_EXT:SRSRAN_CP_NORM;cell.phich_resources=SRSRAN_PHICH_R_1;cell.frame_type=argc>7&&atoi(argv[7])?SRSRAN_TDD:SRSRAN_FDD;
  const unsigned length=SRSRAN_SF_LEN_PRB(cell.nof_prb);
  cf_t* samples[SRSRAN_MAX_PORTS]={0};for(unsigned i=0;i<cell.nof_ports;++i)samples[i]=srsran_vec_cf_malloc(length);
  srsran_enb_dl_t* enb=calloc(1,sizeof(*enb));srsran_softbuffer_tx_t soft={0};
  if(!enb||srsran_enb_dl_init(enb,samples,cell.nof_prb)||srsran_enb_dl_set_cell(enb,cell)||srsran_softbuffer_tx_init(&soft,cell.nof_prb))return 3;
  FILE* out=fopen(argv[1],"wb");if(!out)return 4;
  const unsigned duration=argc>5?atoi(argv[5]):160;
  const char* mode=argc>6?argv[6]:"normal";
  for(unsigned tti=0;tti<duration;++tti){
    srsran_dl_sf_cfg_t sf={0};sf.tti=tti;sf.cfi=argc>9?atoi(argv[9]):3;
    if(cell.frame_type==SRSRAN_TDD){sf.tdd_config.configured=true;sf.tdd_config.sf_config=2;sf.tdd_config.ss_config=cell.cp==SRSRAN_CP_EXT?0:7;}
    srsran_enb_dl_put_base(enb,&sf);
    // The pinned eNB helper always places FDD synchronization. Relocate only
    // those REs for TS36.211 6.11 frame structure type2: SSS in the final
    // symbol of SF0/5 and PSS in the third symbol of SF1/6.
    if(cell.frame_type==SRSRAN_TDD)for(unsigned p=0;p<cell.nof_ports;++p){
      unsigned carriers=cell.nof_prb*12,symbols=SRSRAN_CP_NSYMB(cell.cp),subframe=tti%10;
      if(subframe==0||subframe==5){
        memset(enb->sf_symbols[p]+(symbols-2)*carriers+carriers/2-36,0,72*sizeof(cf_t));
        memset(enb->sf_symbols[p]+(symbols-1)*carriers+carriers/2-36,0,72*sizeof(cf_t));
        unsigned start=(2*symbols-1)*carriers+carriers/2-31;
        const float* sss=subframe?enb->sss_signal5:enb->sss_signal0;
        for(unsigned k=0;k<62;++k)enb->sf_symbols[p][start+k]=sss[k];
      }
      if(subframe==1||subframe==6)memcpy(enb->sf_symbols[p]+2*carriers+carriers/2-31,enb->pss_signal,62*sizeof(cf_t));
    }
    if(tti%20==5){
      srsran_dci_dl_t dci={0};srsran_dci_cfg_t dcicfg={0};srsran_pdsch_cfg_t pdsch={0};
      dci.rnti=SRSRAN_SIRNTI;dci.format=SRSRAN_DCI_FORMAT1A;dci.location.L=2;dci.location.ncce=0;
      dci.alloc_type=SRSRAN_RA_ALLOC_TYPE2;dci.type2_alloc.mode=SRSRAN_RA_TYPE2_LOC;dci.type2_alloc.n_prb1a=SRSRAN_RA_TYPE2_NPRB1A_3;
      dci.type2_alloc.riv=srsran_ra_type2_to_riv(cell.nof_prb==6&&cell.cp==SRSRAN_CP_EXT?6:3,cell.nof_prb>6?cell.nof_prb-4:0,cell.nof_prb);
      dci.tb[0].mcs_idx=6;dci.tb[0].rv=(unsigned[]){0,2,3,1}[(tti/20)%4];SRSRAN_DCI_TB_DISABLE(dci.tb[1]);
      if(!strcmp(mode,"format1c")) {
        dci.format=SRSRAN_DCI_FORMAT1C;dci.type2_alloc.mode=SRSRAN_RA_TYPE2_DIST;
        unsigned step=srsran_ra_type2_n_rb_step(cell.nof_prb);
        unsigned vrb=srsran_ra_type2_n_vrb_dl(cell.nof_prb,true);
        dci.type2_alloc.riv=srsran_ra_type2_to_riv(2,0,vrb/step);
      }
      if(!strcmp(mode,"wrong-rnti"))dci.rnti=0x1234;
      pdsch.rnti=dci.rnti;pdsch.softbuffers.tx[0]=&soft;
      if(srsran_ra_dl_dci_to_grant(&cell,&sf,cell.nof_ports==1?SRSRAN_TM1:SRSRAN_TM2,false,&dci,&pdsch.grant))return 5;
      uint8_t bytes[4096]={0x60,0x40,0x04,0x03,0x00,0x01,0x1a,0x2d,0x40,0x18,0x02,0x81,0x80,0x42,0x0c,0x80,0x00};uint8_t* payload[SRSRAN_MAX_CODEWORDS]={bytes};
      if(dci.tb[0].rv==0)srsran_softbuffer_tx_reset(&soft);
      if(strcmp(mode,"no-pdcch")&&srsran_enb_dl_put_pdcch_dl(enb,&dcicfg,&dci))return 5;
      if(strcmp(mode,"no-pdsch")&&srsran_enb_dl_put_pdsch(enb,&pdsch,payload))return 5;
      if(tti==5)fprintf(stderr,"rate=%d tbs=%d bytes=%d\n",srsran_sampling_freq_hz(cell.nof_prb),pdsch.grant.tb[0].tbs,pdsch.grant.tb[0].tbs/8);
    }
    srsran_enb_dl_gen_signal(enb);
    for(unsigned p=1;p<cell.nof_ports;++p)for(unsigned k=0;k<length;++k)samples[0][k]+=samples[p][k]*(.7f+I*.25f*p);
    if(cell.frame_type==SRSRAN_TDD){
      srsran_tdd_sf_t kind=srsran_sfidx_tdd_type(sf.tdd_config,tti%10);
      if(kind==SRSRAN_TDD_SF_U)memset(samples[0],0,length*sizeof(cf_t));
      if(kind==SRSRAN_TDD_SF_S){
        unsigned fft=srsran_symbol_sz(cell.nof_prb),end=0;
        for(unsigned l=0;l<srsran_sfidx_tdd_nof_dw(sf.tdd_config);++l)end+=fft+(cell.cp==SRSRAN_CP_EXT?SRSRAN_CP_LEN_EXT(fft):SRSRAN_CP_LEN_NORM(l,fft));
        memset(samples[0]+end,0,(length-end)*sizeof(cf_t));
      }
    }
    if(fwrite(samples[0],sizeof(cf_t),length,out)!=length)return 6;
  }
  fclose(out);srsran_softbuffer_tx_free(&soft);srsran_enb_dl_free(enb);free(enb);for(unsigned p=0;p<cell.nof_ports;++p)free(samples[p]);return 0;
}
