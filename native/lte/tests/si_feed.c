// SPDX-License-Identifier: AGPL-3.0-or-later
#include "system_information.h"
#include <stdio.h>
#include <stdlib.h>
static void emit(void* user, const airwolf_lte_si_block* block) {
  (void)user;
  printf("{\"sfn\":%u,\"subframe\":%u,\"firstSample\":%llu,\"endSample\":%llu,\"mcs\":%u,\"rv\":%u,\"snrDb\":%.2f,\"data\":\"", block->sfn, block->subframe, (unsigned long long)block->first_sample, (unsigned long long)block->end_sample, block->mcs, block->rv, block->snr_db);
  for (unsigned i=0;i<block->length;++i) printf("%02x",block->bytes[i]);
  printf("\",\"rnti\":%u}\n",block->rnti);
}
int main(int argc,char**argv) {
  if (argc<3) return 2;
  airwolf_lte_si_cell cell={0}; cell.prb=atoi(argv[2]); cell.pci=argc>3?atoi(argv[3]):42; cell.ports=argc>4?atoi(argv[4]):1; cell.phich_resources=2; cell.cfo_hz=argc>5?atof(argv[5]):0;
  cell.tdd=argc>6?atoi(argv[6]):0;cell.extended_cp=argc>7?atoi(argv[7]):0;
  FILE* in=fopen(argv[1],"rb"); if(!in)return 2;
  fseek(in,0,SEEK_END); long length=ftell(in);rewind(in);
  if(length<0||length>256000000||length%8){fclose(in);return 2;}
  void* data=malloc((size_t)length);if(!data){fclose(in);return 2;}
  if(fread(data,1,length,in)!=(size_t)length){free(data);fclose(in);return 2;}fclose(in);
  airwolf_lte_si_stats stats;
  int result=airwolf_lte_decode_si(data,length/8,&cell,emit,NULL,&stats);
  fprintf(stderr,"subframes=%u mib=%u dci=%u crc_failures=%u invalid_blocks=%u blocks=%u\n",stats.synchronized_subframes,stats.mib_count,stats.dci_count,stats.crc_failures,stats.invalid_blocks,stats.blocks);
  free(data);return result>0?0:result==0?1:2;
}
