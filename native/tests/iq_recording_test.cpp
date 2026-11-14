#include "iq_recording.hpp"
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
  std::cout<<"IQ take bounds, exact limit and gap termination passed.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
