// SPDX-License-Identifier: AGPL-3.0-or-later
// Integration waveform from the pinned PHY's transmitter. This deliberately
// shares the upstream codec: it is not independent PHY accuracy evidence.
#include <srsran/phy/phch/pbch.h>
#include <srsran/phy/ch_estimation/refsignal_dl.h>
#include <srsran/phy/sync/pss.h>
#include <srsran/phy/sync/sss.h>
#include <srsran/phy/dft/ofdm.h>
#include <srsran/phy/utils/vector.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char** argv){
  if(argc<2)return 2;
  srsran_cell_t cell={0};cell.id=argc>2?atoi(argv[2]):42;cell.nof_prb=6;cell.nof_ports=1;cell.cp=SRSRAN_CP_NORM;cell.frame_type=SRSRAN_FDD;cell.phich_length=SRSRAN_PHICH_NORM;cell.phich_resources=SRSRAN_PHICH_R_1;
  cf_t* symbols[SRSRAN_MAX_PORTS]={srsran_vec_cf_malloc(1008)};cf_t* samples=srsran_vec_cf_malloc(1920);
  srsran_pbch_t* pbch=calloc(1,sizeof(*pbch));srsran_refsignal_t* refs=calloc(1,sizeof(*refs));srsran_ofdm_t* ofdm=calloc(1,sizeof(*ofdm));
  if(!samples||!symbols[0]||!pbch||!refs||!ofdm)return 3;
  if(srsran_pbch_init(pbch)||srsran_pbch_set_cell(pbch,cell)||srsran_refsignal_cs_init(refs,6)||srsran_refsignal_cs_set_cell(refs,cell)||srsran_ofdm_tx_init(ofdm,cell.cp,symbols[0],samples,6))return 3;
  cf_t pss[62];float sss0[62],sss5[62];srsran_pss_generate(pss,cell.id%3);srsran_sss_generate(sss0,sss5,cell.id);
  FILE* out=fopen(argv[1],"wb");if(!out)return 4;
  for(unsigned tti=0;tti<(unsigned)(argc>4?atoi(argv[4]):800);++tti){
    memset(symbols[0],0,1008*sizeof(cf_t));srsran_dl_sf_cfg_t sf={0};sf.tti=tti;sf.cfi=3;
    if(tti%5==0){srsran_pss_put_slot(pss,symbols[0],6,cell.cp);srsran_sss_put_slot(tti%10?sss5:sss0,symbols[0],6,cell.cp);}
    srsran_refsignal_cs_put_sf(refs,&sf,0,symbols[0]);
    if(tti%10==0){uint8_t bits[24];srsran_cell_t advertised=cell;if(argc>3)advertised.nof_prb=atoi(argv[3]);srsran_pbch_mib_pack(&advertised,tti/10,bits);srsran_pbch_encode(pbch,bits,symbols,(tti/10)%4);}
    srsran_ofdm_tx_sf(ofdm);if(fwrite(samples,sizeof(cf_t),1920,out)!=1920)return 5;
  }
  fclose(out);srsran_ofdm_tx_free(ofdm);srsran_pbch_free(pbch);srsran_refsignal_free(refs);free(pbch);free(ofdm);free(refs);free(samples);free(symbols[0]);return 0;
}
