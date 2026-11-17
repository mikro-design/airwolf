// Test-only wall-clock diagnostics. Never compiled into shipped receivers.
#pragma once
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <algorithm>
#include <cstdint>

struct DspTiming {
  using Clock=std::chrono::steady_clock;
  struct Row {std::uint64_t first=0,dropped=0;double age=0,history=0,decode=0,spectrum=0,total=0,cpu=0;bool gap=false;};
  const bool enabled=std::getenv("AIRWOLF_NATIVE_TIMING")!=nullptr;
  std::array<Row,12> slow{};
  Row row;Clock::time_point start,last;std::clock_t cpu=0;
  std::uint64_t blocks=0,gaps=0,expected=0;
  double history=0,decode=0,spectrum=0,total=0,cpu_total=0,max_age=0;
  void begin(std::uint64_t first,std::size_t bytes,std::int64_t received_us){
    if(!enabled)return;
    start=last=Clock::now();cpu=std::clock();row={};row.first=first;
    row.age=std::max(0.,std::chrono::duration<double,std::milli>(start.time_since_epoch()).count()-received_us/1000.);
    row.gap=blocks&&first!=expected;expected=first+bytes/2;
  }
  double elapsed(){const auto now=Clock::now();const auto ms=std::chrono::duration<double,std::milli>(now-last).count();last=now;return ms;}
  void after_history(){if(enabled)row.history=elapsed();}
  void after_decode(){if(enabled)row.decode=elapsed();}
  void after_spectrum(){if(enabled)row.spectrum=elapsed();}
  void finish(std::uint64_t dropped){
    if(!enabled)return;
    row.total=std::chrono::duration<double,std::milli>(Clock::now()-start).count();
    row.cpu=1000.*double(std::clock()-cpu)/CLOCKS_PER_SEC;row.dropped=dropped;
    ++blocks;gaps+=row.gap;history+=row.history;decode+=row.decode;spectrum+=row.spectrum;total+=row.total;cpu_total+=row.cpu;max_age=std::max(max_age,row.age);
    if(row.total>slow.back().total){slow.back()=row;std::sort(slow.begin(),slow.end(),[](auto& a,auto& b){return a.total>b.total;});}
  }
  ~DspTiming(){
    if(!enabled)return;
    std::fprintf(stderr,"processing_timing={\"blocks\":%llu,\"gaps\":%llu,\"historyMs\":%.3f,\"decodeMs\":%.3f,\"spectrumMs\":%.3f,\"totalMs\":%.3f,\"cpuMs\":%.3f,\"maxQueueAgeMs\":%.3f,\"slowest\":[",(unsigned long long)blocks,(unsigned long long)gaps,history,decode,spectrum,total,cpu_total,max_age);
    for(unsigned i=0;i<slow.size();++i){const auto& r=slow[i];std::fprintf(stderr,"%s{\"first\":%llu,\"dropped\":%llu,\"gap\":%s,\"ageMs\":%.3f,\"historyMs\":%.3f,\"decodeMs\":%.3f,\"spectrumMs\":%.3f,\"totalMs\":%.3f,\"cpuMs\":%.3f}",i?",":"",(unsigned long long)r.first,(unsigned long long)r.dropped,r.gap?"true":"false",r.age,r.history,r.decode,r.spectrum,r.total,r.cpu);}
    std::fprintf(stderr,"]}\n");
  }
};
