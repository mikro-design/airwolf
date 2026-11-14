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
  std::cout<<"IQ take bounds, exact limit and gap termination passed.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
