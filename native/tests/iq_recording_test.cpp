#include "iq_recording.hpp"
#include "iq_history.hpp"
#include <iostream>
using namespace airwolf;
int main(){try{
  const std::int8_t values[]={1,-2,3,-4,5,-6,7,-8};
  IqRecording limited("unused-iq-test-path",3);
  if(!limited.append(values,sizeof(values),117)||limited.samples()!=3||limited.first()!=117||limited.end()!=120||limited.reason()!="limit")throw std::runtime_error("IQ take limit or sample bounds changed");
  if(!limited.append(values,sizeof(values),121)||limited.samples()!=3)throw std::runtime_error("Sealed take accepted additional samples");
  IqRecording gap("unused-iq-test-path",100);
  if(gap.append(values,sizeof(values),12)||!gap.append(values,sizeof(values),17)||gap.samples()!=4||gap.end()!=16||gap.reason()!="gap")throw std::runtime_error("IQ recording spliced a discontinuity");
  bool rejected=false;try{IqRecording huge("unused-iq-test-path",134217729);}catch(const std::exception&){rejected=true;}
  if(!rejected)throw std::runtime_error("Unbounded recording allocation accepted");
  IqHistory history(16,16);
  history.append(values,8,0);history.append(values,8,4);history.append(values,8,8);
  if(history.retain(0,2,0))throw std::runtime_error("Expired raw IQ was retained");
  auto token=history.retain(6,10,1);auto excerpt=history.get(token);
  const std::vector<std::int8_t> expected={3,-4,5,-6,7,-8,1,-2,3,-4,5,-6};
  if(excerpt->first!=5||excerpt->end!=11||excerpt->copy()!=expected)throw std::runtime_error("Wrapped IQ history lost exact sample order");
  history.append(values,8,20);
  if(history.retain(10,21,0))throw std::runtime_error("History bridged a sample gap");
  history.append(values,8,0,1);
  if(history.retain(0,4,0,0))throw std::runtime_error("History mixed retuning epochs");
  const auto last_token=history.retain(0,4,0,1);
  history.seal();
  if(history.get(last_token)->copy()!=std::vector<std::int8_t>(values,values+8))throw std::runtime_error("Stopping lost retained IQ");
  bool expired=false;try{history.get(token);}catch(const std::exception&){expired=true;}
  if(!expired||excerpt->copy()!=expected)throw std::runtime_error("History eviction broke a snapshot already in progress");
  {
    // The history budget bounds memory, not content: after the block size
    // shrinks, reused large blocks must not hold small blocks beyond it, and
    // the history must not stay stuck in oversized allocations.
    const std::size_t budget=4096;
    IqHistory shrinking(budget,budget);
    std::vector<std::int8_t> big(1024,1),small(32,2);
    std::uint64_t at=0;
    for(int i=0;i<8;++i){shrinking.append(big.data(),big.size(),at);at+=big.size()/2;}
    for(int i=0;i<400;++i){
      shrinking.append(small.data(),small.size(),at);at+=small.size()/2;
      if(shrinking.history_memory()>budget)throw std::runtime_error("IQ history allocations exceeded its budget");
    }
    // Steady state: the full budget holds small blocks again (all of it, less one block).
    if(!shrinking.retain(at-(budget-small.size())/2,at,0))throw std::runtime_error("IQ history stayed in oversized blocks");
  }
  std::cout<<"IQ take bounds, exact limit and gap termination passed.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
