// SPDX-License-Identifier: AGPL-3.0-or-later
#include "system_information.h"
#include <complex>
#include <cstdio>
#include <cstring>
#include <vector>
#include <stdexcept>
#define CHECK(x) do{if(!(x))throw std::runtime_error("Failed: " #x);}while(0)
struct Input{std::vector<std::complex<float>> iq;size_t cursor=0;unsigned calls=0;bool fail=false;};
static int read_iq(void* opaque,void* output,unsigned count){
  auto& in=*static_cast<Input*>(opaque);++in.calls;
  CHECK(count<=3*1920&&count<=in.iq.size()-in.cursor);
  if(in.fail)return count?static_cast<int>(count)-1:-1;
  std::memcpy(output,in.iq.data()+in.cursor,count*sizeof(in.iq[0]));in.cursor+=count;return count;
}
static void emit(void* opaque,const airwolf_lte_si_block*){++*static_cast<unsigned*>(opaque);}
int main(){
  airwolf_lte_si_cell cell{};cell.prb=6;cell.pci=42;cell.ports=1;cell.phich_resources=2;
  Input in;in.iq.resize(192000);unsigned frames=0;airwolf_lte_si_stats flat{},pull{};
  CHECK(airwolf_lte_decode_si(in.iq.data(),in.iq.size(),&cell,emit,&frames,&flat)==0);
  CHECK(airwolf_lte_decode_si_stream(read_iq,&in,in.iq.size(),&cell,emit,&frames,&pull)==0);
  CHECK(frames==0&&in.calls>0&&in.cursor<=in.iq.size());
  CHECK(std::memcmp(&flat,&pull,sizeof(flat))==0);
  in.cursor=in.calls=0;in.fail=true;
  CHECK(airwolf_lte_decode_si_stream(read_iq,&in,in.iq.size(),&cell,emit,&frames,&pull)==-1);
  CHECK(in.calls==1&&frames==0&&pull.blocks==0);
  CHECK(airwolf_lte_decode_si_stream(nullptr,&in,in.iq.size(),&cell,emit,&frames,&pull)==-1);
  CHECK(airwolf_lte_decode_si_stream(read_iq,&in,1920001,&cell,emit,&frames,&pull)==-1);
  CHECK(airwolf_lte_decode_si_stream(read_iq,&in,1,&cell,emit,&frames,&pull)==-1);
  CHECK(in.calls==1&&frames==0);
  std::puts("Pull SI reader matches flat-input silence; short callbacks and invalid bounds fail without frames");
}
