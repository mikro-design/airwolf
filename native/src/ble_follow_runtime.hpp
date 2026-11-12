// Included after the native transport types in main.cpp. USB callbacks only copy
// IQ; the worker does DSP, and this controller alone calls stop/set_freq/start.
#include "ble_follow_epoch.hpp"
struct FollowQueue {
  std::mutex mutex;std::deque<TimedPacket> packets;std::atomic<bool> overflow{false};
  void push(TimedPacket packet){std::lock_guard<std::mutex> lock(mutex);if(packets.size()==512){overflow=true;return;}packets.push_back(std::move(packet));}
  std::deque<TimedPacket> take(){std::lock_guard<std::mutex> lock(mutex);std::deque<TimedPacket> result;result.swap(packets);return result;}
};
int run_follow(Device& device,const Config& config){
  auto input=std::make_unique<Acquisition>();
  // Separate publisher lifetime from the reusable, per-tuning acquisition state.
  auto output_state=std::make_unique<Acquisition>();
  Mailbox mailbox;FollowQueue received;BleFollower follow;
  std::thread worker,writer;
  std::uint64_t epoch=0,total_samples=0,total_decoded=0,total_candidates=0,total_bad=0;
  int channel=config.channel;std::uint32_t crc_init=0x555555;
  const auto started=now_us();
  const double wall_offset=std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count()-started/1000.0;
  std::int64_t close_us=0,retune_budget=3000,last_spectrum=0;
  const auto flush_us=static_cast<std::int64_t>(hackrf_get_transfer_buffer_size(device.value)*500000ULL/config.rate)+2000;
  std::string last_status;
  auto report=[&](bool force=false){
    std::ostringstream status;status<<"{\"version\":1,\"type\":\"follow\",\"synthetic\":false,\"state\":"<<quote(follow.state)<<",\"message\":"<<quote(follow.message)
      <<",\"channel\":"<<channel<<",\"frequencyHz\":"<<ble_frequency(channel)<<",\"accessAddress\":"<<follow.address<<",\"crcInit\":"<<follow.crc_init
      <<",\"intervalUs\":"<<follow.interval_us<<",\"clockUncertaintyUs\":"<<follow.uncertainty()<<",\"retunes\":"<<follow.retunes<<",\"skippedEvents\":"<<follow.skipped_events<<",\"verifiedEvents\":"<<follow.verified_events<<"}\n";
    const auto value=status.str();if(force||value!=last_status){mailbox.follow(value);last_status=value;}
  };
  auto drain=[&]{
    if(received.overflow.load()||input->dropped.load()||input->malformed.load())follow.lose("Connection lost: native IQ or packet queue overflow / malformed USB transfer");
    for(auto& timed:received.take()){
      auto& packet=timed.packet;
      const auto event=follow.observe(packet,timed.first,timed.end,epoch);
      packet.capture_epoch=epoch;packet.frequency_hz=ble_frequency(packet.channel);packet.crc_init=crc_init;
      packet.time_ms=wall_offset+(timed.first.lo+(timed.first.hi-timed.first.lo)/2)/1000.0;
      packet.time_uncertainty_us=(timed.first.hi-timed.first.lo+1)/2;
      if(event)packet.connection_event=static_cast<std::int64_t>(*event&0xffff);
      mailbox.packet(std::move(packet));
    }
    report();
  };
  auto stop_epoch=[&]{
    if(device.receiving){input->stop.store(true);check(hackrf_stop_rx(device.value),"hackrf_stop_rx");device.receiving=false;}
    input->input_done.store(true);if(worker.joinable())worker.join();drain();
  };
  auto start_epoch=[&](int next,std::int64_t deadline){
    const auto retune_start=now_us();
    channel=next;crc_init=follow.connected()?follow.crc_init:0x555555;
    const auto address=follow.connected()?follow.address:0x8e89bed6;
    check(hackrf_set_freq(device.value,ble_frequency(channel)),"hackrf_set_freq");
    input->delivered=0;input->dropped=0;input->malformed=0;input->stop=false;input->input_done=false;received.overflow=false;++epoch;
    // Invocation precedes the device's first sample; callback times bound its end.
    const auto origin=now_us();
    check(hackrf_start_rx(device.value,receive_callback,input.get()),"hackrf_start_rx");device.receiving=true;
    close_us=deadline?deadline:origin+1000000;
    worker=std::thread([&,origin,address]{
      FollowEpochDecoder decoder(origin,config.rate,channel,address,crc_init,[&](TimedPacket packet){received.push(std::move(packet));});Spectrum spectrum;
      while(!input->input_done.load()||input->ring.front()){
        const auto* block=input->ring.front();if(!block){std::this_thread::sleep_for(std::chrono::microseconds(500));continue;}
        decoder.consume(*block);
        const auto now=now_us();if(block->size>=fft_size*2&&now-last_spectrum>=67000){
          Snapshot snap;snap.frequency=ble_frequency(channel);snap.end=total_samples+block->first_sample+block->size/2;snap.first=snap.end-fft_size;
          snap.bins=spectrum.compute(block->iq.data()+block->size-fft_size*2);snap.delivered=total_samples+input->delivered.load();snap.dropped=input->dropped.load();
          snap.decoded=total_decoded+decoder.decoder().frames;snap.candidates=total_candidates+decoder.decoder().candidates;snap.crc_failures=total_bad+decoder.decoder().crc_failures;
          mailbox.publish(snap);last_spectrum=now;
        }
        input->ring.pop();
      }
      total_samples+=input->delivered.load();total_decoded+=decoder.decoder().frames;total_candidates+=decoder.decoder().candidates;total_bad+=decoder.decoder().crc_failures;
    });
    retune_budget=std::max<std::int64_t>(retune_budget,now_us()-retune_start+2000);report(true);
  };
  auto cleanup=[&]{
    // Destruction must join even if a USB stop fails.
    input->stop=true;if(device.receiving){hackrf_stop_rx(device.value);device.receiving=false;}
    input->input_done=true;if(worker.joinable())worker.join();drain();mailbox.finish();if(writer.joinable())writer.join();
  };
  try{
    writer=std::thread(publish,std::ref(*output_state),std::ref(mailbox),std::cref(config));
    start_epoch(config.channel,0);
    while(!follow.done()&&!output_state->stop.load()){
      if(interrupted||stdin_stop()||(config.duration_ms&&now_us()-started>=config.duration_ms*1000LL)){follow.stop("BLE following stopped");break;}
      if(hackrf_is_streaming(device.value)!=HACKRF_TRUE)throw std::runtime_error("HackRF stream stopped unexpectedly during BLE following");
      drain();follow.tick(now_us());if(follow.done())break;
      // Leave advertising immediately after a valid setup. Waiting epochs are
      // restarted each second to keep host/sample clock drift bounded.
      if(now_us()>=close_us||(channel>=37&&follow.connected())){
        stop_epoch();if(follow.done())break;
        if(follow.connected()){
          const auto plan=follow.plan(now_us(),retune_budget,flush_us);if(!plan)break;
          start_epoch(plan->channel,plan->close_us);
        }else start_epoch(config.channel,0);
      }
      std::this_thread::sleep_for(std::chrono::microseconds(500));
    }
    stop_epoch();report(true);cleanup();
  }catch(...){cleanup();throw;}
  return 0;
}
