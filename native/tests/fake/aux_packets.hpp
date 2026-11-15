// Independent synthetic transmitter schedules used by the production-controller
// test. No hardware or captured radio identifiers are used.
std::array<std::uint8_t,3> aux_test_crc(const std::vector<std::uint8_t>& pdu,std::uint32_t init=0x555555) {
  std::array<bool,24> state{};for(unsigned i=0;i<24;++i)state[i]=(init>>i)&1;
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
  const auto add=[&](std::int64_t start,int channel,std::vector<std::uint8_t> payload,const std::string& phy,bool damage=false,unsigned type=7,unsigned cte_us=0){
    std::vector<std::uint8_t> pdu{static_cast<std::uint8_t>(type),static_cast<std::uint8_t>(payload.size())};pdu.insert(pdu.end(),payload.begin(),payload.end());
    const auto check=aux_test_crc(pdu);pdu.insert(pdu.end(),check.begin(),check.end());if(damage)pdu.back()^=1;
    const auto hz=channel==37?2402000000ULL:(channel<11?2404000000ULL:2406000000ULL)+2000000ULL*channel;
    auto bits=signal_bits(pdu,channel,0x8e89bed6,phy,8);
    bits.insert(bits.end(),cte_us*(phy=="2m"?2:1),1);
    d->air.push_back({start,hz,iq(bits,d->rate,phy=="2m"?2000000:1000000)});
  };
  // Target-validation cases need to reach their target before testing its
  // contents. Give those and positive cases a legal 300 ms scheduling margin;
  // keep genuinely short-window, malformed-source and ambiguity negatives.
  const bool short_case=mode=="late"||mode=="bad-crc"||mode=="no-pointer"||mode=="ambiguous";
  const unsigned unit=short_case?30:300;
  const unsigned offset=mode=="late"?20:short_case?2000:1000;
  const unsigned unit_bit=unit==300?0x80:0;
  const std::int64_t first=short_case?40000:200000;
  const std::int64_t delay=offset*unit;
  const auto secondary_phy=mode=="coded-chain"?"coded":"2m";
  const unsigned secondary_bits=mode=="coded-chain"?0x40:0x20;
  const unsigned chain_bits=mode=="chain-phy-change"?0x40:secondary_bits;
  const auto primary_phy=(mode=="coded-primary"||mode=="coded-decision-primary")?"coded":"1m";
  const bool decision=mode=="decision-primary"||mode=="coded-decision-primary";
  const auto source=[&](std::int64_t at){
    add(at,37,{static_cast<std::uint8_t>(decision?0:12),0x19,1,2,3,4,5,6,0x34,0x12,
      static_cast<std::uint8_t>(unit_bit|0x10),static_cast<std::uint8_t>(offset),
      static_cast<std::uint8_t>(secondary_bits|(offset>>8))},primary_phy,mode=="bad-crc",decision?9:7);
  };
  if(mode!="no-pointer")source(first);
  if(mode=="ambiguous")add(45000,37,{12,0x19,9,2,3,4,5,6,0x34,0x12,0x10,0x26,0x27},"1m");
  const auto primary=mode=="clock-refresh"?first+300000:first;
  if(mode=="clock-refresh")source(primary);
  const auto start=primary+delay;
  const auto wrong=mode=="wrong-adi"?0x35:0x34;
  add(start,mode=="wrong-channel"?17:16,{12,0x19,1,2,3,4,5,6,static_cast<std::uint8_t>(wrong),0x12,
    static_cast<std::uint8_t>(unit_bit|0x11),static_cast<std::uint8_t>(offset),
    static_cast<std::uint8_t>(chain_bits|(offset>>8)),6,9,'H'},mode=="wrong-phy"?"1m":secondary_phy);
  const std::vector<std::uint8_t> tail=mode=="cte-chain"?
    std::vector<std::uint8_t>{4,12,20,0x34,0x12,'e','l','l','o'}:
    std::vector<std::uint8_t>{3,8,0x34,0x12,'e','l','l','o'};
  add(start+delay,17,tail,mode=="chain-phy-change"?"coded":secondary_phy,false,7,mode=="cte-chain"?160:0);
  if(mode!="coded-primary")add(primary+2*delay+(short_case?90000:250000),37,{1,2,3,4,5,6,5,9,'H','o','m','e'},"1m",false,2);
  if(mode=="normal"||mode=="normal-missed-first"){
    // Three independently advertised opportunities, not process retries. Each
    // has legal pointers and must pass the production clock/deadline guards.
    const auto first_event=d->air;
    for(const auto shift:{1200000,2400000})for(auto packet:first_event){packet.start+=shift;d->air.push_back(std::move(packet));}
  }
  if(mode=="normal-missed-first")
    d->air.erase(std::remove_if(d->air.begin(),d->air.end(),[](const auto& p){return p.start<1200000&&p.hz!=2402000000ULL;}),d->air.end());
  return true;
}
