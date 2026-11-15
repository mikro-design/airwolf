// Independent synthetic transmitter schedules used by the production-controller
// test. No hardware or captured radio identifiers are used.
std::array<std::uint8_t,3> aux_test_crc(const std::vector<std::uint8_t>& pdu) {
  std::array<bool,24> state{};for(unsigned i=0;i<24;++i)state[i]=(0x555555>>i)&1;
  for(auto octet:pdu)for(unsigned bit=0;bit<8;++bit){
    const bool feedback=state[23]^((octet>>bit)&1);
    for(unsigned i=23;i>0;--i)state[i]=state[i-1];state[0]=false;
    if(feedback)for(unsigned tap:{0,1,3,4,6,9,10})state[tap]=!state[tap];
  }
  std::array<std::uint8_t,3> output{};for(unsigned i=0;i<24;++i)output[i/8]|=std::uint8_t(state[23-i])<<(i%8);return output;
}
bool prepare_aux_packets(hackrf_device* d) {
  const auto* setting=std::getenv("AIRWOLF_FAKE_AUX");if(!setting)return false;
  const std::string mode=setting;
  const auto add=[&](std::int64_t start,int channel,std::vector<std::uint8_t> payload,const std::string& phy,bool damage=false,unsigned type=7){
    std::vector<std::uint8_t> pdu{static_cast<std::uint8_t>(type),static_cast<std::uint8_t>(payload.size())};pdu.insert(pdu.end(),payload.begin(),payload.end());
    const auto check=aux_test_crc(pdu);pdu.insert(pdu.end(),check.begin(),check.end());if(damage)pdu.back()^=1;
    const auto hz=channel==37?2402000000ULL:(channel<11?2404000000ULL:2406000000ULL)+2000000ULL*channel;
    d->air.push_back({start,hz,iq(signal_bits(pdu,channel,0x8e89bed6,phy,8),d->rate,phy=="2m"?2000000:1000000)});
  };
  const unsigned offset=mode=="late"?2:mode=="clock-refresh"?400:200;
  const auto primary_phy=mode=="coded-primary"?"coded":"1m";
  // 300us units, 60ms delay (or a valid but software-unreachable600us delay).
  if(mode!="no-pointer")add(40000,37,{12,0x19,1,2,3,4,5,6,0x34,0x12,0x90,static_cast<std::uint8_t>(offset),static_cast<std::uint8_t>(0x20|(offset>>8))},primary_phy,mode=="bad-crc");
  if(mode=="ambiguous")add(45000,37,{12,0x19,9,2,3,4,5,6,0x34,0x12,0x90,183,0x20},"1m");
  const auto primary=mode=="clock-refresh"?160000:40000;
  if(mode=="clock-refresh")add(primary,37,{12,0x19,1,2,3,4,5,6,0x34,0x12,0x90,static_cast<std::uint8_t>(offset),static_cast<std::uint8_t>(0x20|(offset>>8))},"1m");
  const auto start=primary+offset*300;
  const auto wrong=mode=="wrong-adi"?0x35:0x34;
  add(start,mode=="wrong-channel"?17:16,{12,0x19,1,2,3,4,5,6,static_cast<std::uint8_t>(wrong),0x12,0x91,static_cast<std::uint8_t>(offset),static_cast<std::uint8_t>(0x40|(offset>>8)),6,9,'H'},mode=="wrong-phy"?"1m":"2m");
  add(start+offset*300,17,{3,8,0x34,0x12,'e','l','l','o'},"coded");
  if(mode!="coded-primary")add(mode=="clock-refresh"?500000:250000,37,{1,2,3,4,5,6,5,9,'H','o','m','e'},"1m",false,2);
  return true;
}
