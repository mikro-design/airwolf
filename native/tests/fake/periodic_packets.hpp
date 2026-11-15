// Synthetic transmitter with independently expressed CRC and CSA #2. This is
// received by the actual USB controller and DSP, never by a decoder stub.
bool prepare_periodic_packets(hackrf_device* d) {
  const auto* setting=std::getenv("AIRWOLF_FAKE_PERIODIC");if(!setting)return false;
  const std::string mode=setting;
  const std::string phy=mode.find("coded")!=std::string::npos?"coded":mode.find("1m")!=std::string::npos?"1m":"2m";
  const unsigned phy_bits=phy=="coded"?0x40:phy=="2m"?0x20:0;
  const auto add=[&](std::int64_t time,int channel,std::uint32_t aa,std::uint32_t init,std::vector<std::uint8_t> payload,const std::string& radio_phy,bool bad=false,unsigned cte=0,int scheme=8){
    std::vector<std::uint8_t> pdu={7,static_cast<std::uint8_t>(payload.size())};pdu.insert(pdu.end(),payload.begin(),payload.end());
    const auto crc=aux_test_crc(pdu,init);pdu.insert(pdu.end(),crc.begin(),crc.end());if(bad)pdu.back()^=1;
    auto bits=signal_bits(pdu,channel,aa,radio_phy,scheme);bits.insert(bits.end(),cte*(radio_phy=="2m"?2:1),1);
    const auto frequency=channel==37?2402000000ULL:(channel<11?2404000000ULL:2406000000ULL)+2000000ULL*channel;
    d->air.push_back({time,frequency,iq(bits,d->rate,radio_phy=="2m"?2000000:1000000)});
  };
  // Primary AuxOffset60ms; SyncInfo39.99ms; periodic interval80ms.
  // All sub245.7ms offsets use required30us units.
  add(200000,37,0x8e89bed6,0x555555,{12,0x19,1,2,3,4,5,6,0x34,0x12,16,0xd0,static_cast<std::uint8_t>(phy_bits|7)},"1m");
  std::vector<std::uint8_t> source={21,0x28,0x34,0x12,0x35,5,64,0,255,255,255,255,31,0x2b,0x19,8,0xaa,0x81,0xc1,0xc4,0xfd,0xff};
  if(mode=="invalid-map")source[8]=source[9]=source[10]=source[11]=source[12]=0;
  add(260000,16,0x8e89bed6,0x555555,source,phy,mode=="bad-source-crc");
  for(unsigned n=0;n<80;++n){
    const unsigned event=(65533+n)&65535;
    unsigned random=(0xaa08^0x192b)^event;
    for(int round=0;round<3;++round){unsigned p=0;for(int bit=0;bit<16;++bit)p|=((random>>bit)&1)<<((bit&8)+7-(bit&7));random=(17*p+(0xaa08^0x192b))&65535;}
    int channel=(random^(0xaa08^0x192b))%37;
    if(mode=="wrong-channel")channel=(channel+1)%37;
    std::vector<std::uint8_t> payload={1,0,4,9,'L','a','b'};
    if(mode.find("chain")!=std::string::npos)payload={6,0x18,0x34,0x12,17,0x35,static_cast<std::uint8_t>(phy_bits|5),6,9,'H'};
    if(mode=="cte"||mode=="cte-coded")payload={2,4,20,4,9,'L','a','b'};
    if(mode=="chain-cte")payload={7,0x1c,20,0x34,0x12,17,0x35,static_cast<std::uint8_t>(phy_bits|5),6,9,'H'};
    if(mode=="acad"&&n>=8)payload={4,0,2,0xfe,0,4,9,'L','a','b'};
    if((mode=="missing"&&n<6)||(mode=="reacquire"&&n>=3))continue;
    add(299990+n*80000,channel,mode=="wrong-aa"?0xaa08192d:0xaa08192b,0xc4c181,payload,phy,mode=="bad-crc",(mode=="cte"||mode=="chain-cte")?160:0,n%4<2?2:8);
    if(mode.find("chain")!=std::string::npos){
      auto tail=std::vector<std::uint8_t>{3,8,0x34,0x12,'e','l','l','o'};
      if(mode=="wrong-chain-adi")tail[2]=0x35;
      if(mode=="chain-cte")tail={4,12,20,0x34,0x12,'e','l','l','o'};
      add(339980+n*80000,17,0xaa08192b,0xc4c181,tail,phy,false,mode=="chain-cte"?160:0,n%4<2?2:8);
    }
  }
  if(mode=="reacquire"){
    add(1400000,37,0x8e89bed6,0x555555,{12,0x19,1,2,3,4,5,6,0x34,0x12,16,0xd0,0x27},"1m");
    auto fresh=source;fresh[8]=3;fresh[9]=fresh[10]=fresh[11]=fresh[12]=0;
    fresh[17]=0x56;fresh[18]=0x34;fresh[19]=0x12;fresh[20]=0x90;fresh[21]=1;
    add(1460000,16,0x8e89bed6,0x555555,fresh,"2m");
    for(unsigned n=0;n<20;++n){
      unsigned random=(0xaa08^0x192b)^(400+n);
      for(int r=0;r<3;++r){unsigned q=0;for(int b=0;b<16;++b)q|=((random>>b)&1)<<((b&8)+7-(b&7));random=(17*q+(0xaa08^0x192b))&65535;}
      random^=0xaa08^0x192b;const auto unmapped=random%37;const auto ch=unmapped<2?unmapped:(2*random)>>16;
      add(1499990+n*80000,ch,0xaa08192b,0x123456,{1,0,4,9,'N','e','w'},"2m");
    }
  }
  return true;
}
