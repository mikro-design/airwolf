// Included after the native transport types in main.cpp. USB callbacks only copy
// IQ; the worker does DSP, and this controller alone calls stop/set_freq/start.
#include "ble_follow_epoch.hpp"
#include <condition_variable>
struct FollowQueue {
  std::mutex mutex;std::deque<TimedPacket> packets;std::atomic<bool> overflow{false};
  void push(TimedPacket packet){std::lock_guard<std::mutex> lock(mutex);if(packets.size()==512){overflow=true;return;}packets.push_back(std::move(packet));}
  std::deque<TimedPacket> take(){std::lock_guard<std::mutex> lock(mutex);std::deque<TimedPacket> result;result.swap(packets);return result;}
};
int run_follow(Device& device,const Config& config){
  auto input=std::make_unique<Acquisition>();
  // Separate publisher lifetime from the reusable, per-tuning acquisition state.
  auto output_state=std::make_unique<Acquisition>();
  Mailbox mailbox;FollowQueue received;BleFollower follow;ReceiverCommands commands;
  auto history=config.retain_iq?std::make_unique<IqHistory>():nullptr;
  std::thread worker,writer;
  std::uint64_t epoch=0,total_samples=0,total_decoded=0,total_candidates=0,total_bad=0;
  std::uint64_t seen_drops=0,seen_malformed=0;
  int channel=config.channel;std::uint32_t crc_init=0x555555;
  std::string phy="1m";bool parked=false;follow.sample_rate=config.rate;
  // Re-acquisition parks run at 16 MS/s, where an eighth of the rate is one
  // 2 MHz channel step: up to six data channels per tuning instead of two.
  follow.park_rate=16000000;
  std::uint32_t epoch_rate=config.rate;
  const auto started=now_us();
  const double wall_offset=std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count()-started/1000.0;
  std::int64_t close_us=0,retune_budget=3000,last_spectrum=0,epoch_origin=0;
  const auto flush_us=static_cast<std::int64_t>(hackrf_get_transfer_buffer_size(device.value)*500000ULL/config.rate)+2000;
  std::string last_status;
  auto report=[&](bool force=false){
    std::ostringstream status;status<<"{\"version\":1,\"type\":\"follow\",\"synthetic\":false,\"state\":"<<quote(follow.state)<<",\"message\":"<<quote(follow.message)
      <<",\"channel\":"<<channel<<",\"frequencyHz\":"<<ble_frequency(channel)<<",\"accessAddress\":"<<follow.address<<",\"crcInit\":"<<follow.crc_init
      <<",\"phy\":"<<quote(phy)<<",\"intervalUs\":"<<follow.interval_us<<",\"clockUncertaintyUs\":"<<follow.uncertainty()<<",\"retunes\":"<<follow.retunes<<",\"skippedEvents\":"<<follow.skipped_events<<",\"verifiedEvents\":"<<follow.verified_events<<"}\n";
    const auto value=status.str();if(force||value!=last_status){mailbox.follow(value);last_status=value;}
  };
  auto drain=[&]{
    const auto drops=input->dropped.load(),malformed=input->malformed.load();
    const bool gap=received.overflow.exchange(false)||drops!=seen_drops||malformed!=seen_malformed;
    seen_drops=drops;seen_malformed=malformed;
    const bool discard=gap&&!follow.connected();
    if(gap&&follow.connected())follow.lose("Connection lost: native IQ or packet queue overflow / malformed USB transfer");
    auto batch=received.take();
    if(discard)batch.clear(); // Keep listening for a fresh CONNECT_IND after an advertising gap.
    for(auto& timed:batch){
      auto& packet=timed.packet;
      const auto event=follow.observe(packet,timed.first,timed.end,epoch,timed.start?std::optional<std::int64_t>(timed.start->hi):std::nullopt);
      packet.capture_epoch=epoch;packet.frequency_hz=ble_frequency(packet.channel);packet.crc_init=crc_init;
      if(epoch_rate!=config.rate)packet.sample_rate=epoch_rate;
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
  auto start_epoch=[&](int next,std::int64_t deadline,const std::string& next_phy="1m",std::vector<int> park={},std::uint64_t park_center=0,std::uint32_t park_rate=0){
    const auto retune_start=now_us();
    channel=next;phy=next_phy;crc_init=follow.connected()?follow.crc_init:0x555555;
    const auto address=follow.connected()?follow.address:0x8e89bed6;
    // A park receives every listed data channel from one tuning, each a whole
    // number of eighths of the rate away from it.
    parked=!park.empty();
    const auto rate=parked?park_rate:config.rate;
    if(rate!=epoch_rate){
      check(hackrf_set_sample_rate(device.value,rate),"hackrf_set_sample_rate");
      // +/-6 MHz channels need more than libhackrf's 0.75 x rate default.
      if(rate==16000000)check(hackrf_set_baseband_filter_bandwidth(device.value,15000000),"hackrf_set_baseband_filter_bandwidth");
      epoch_rate=rate;
    }
    follow.sample_rate=rate;
    const auto tuned=parked?park_center:receiver_center(ble_frequency(channel),rate,true);
    check(hackrf_set_freq(device.value,tuned),"hackrf_set_freq");
    input->delivered=0;input->dropped=0;input->malformed=0;input->stop=false;input->input_done=false;received.overflow=false;seen_drops=seen_malformed=0;++epoch;
    // Invocation precedes the device's first sample; callback times bound its end.
    const auto origin=now_us();epoch_origin=origin;
    check(hackrf_start_rx(device.value,receive_callback,input.get()),"hackrf_start_rx");device.receiving=true;
    close_us=deadline?deadline:origin+1000000;
    const auto eighths=[&,park_center,rate](int ch){return static_cast<int>((static_cast<std::int64_t>(park_center)-static_cast<std::int64_t>(ble_frequency(ch)))/static_cast<std::int64_t>(rate/8));};
    worker=std::thread([&,origin,address,park,rate,eighths]{
      // IQ history holds the configured rate only; park packets keep none.
      const bool retain=history&&rate==config.rate;
      FollowEpochDecoder decoder(origin,rate,channel,address,crc_init,[&](TimedPacket packet){
        if(retain)packet.packet.iq_token=history->retain(packet.packet.first_sample,packet.packet.end_sample,rate/10000,epoch);
        received.push(std::move(packet));
      },!parked,phy,false,parked?eighths(channel):0);
      // While hopping on an uncoded PHY, also decode the other one from the
      // same samples: a missed PHY update then costs nothing (BleFollower).
      // A park decodes the current PHY on each further channel: six channels
      // and both PHYs at 16 MS/s would need about 1.2 cores.
      const auto keep=[&](TimedPacket packet){
        if(retain)packet.packet.iq_token=history->retain(packet.packet.first_sample,packet.packet.end_sample,rate/10000,epoch);
        received.push(std::move(packet));
      };
      std::vector<std::unique_ptr<FollowEpochDecoder>> others;
      const bool both=follow.connected()&&channel<37&&(phy=="1m"||phy=="2m");
      if(both)others.push_back(std::make_unique<FollowEpochDecoder>(origin,rate,channel,address,crc_init,keep,!parked,phy=="1m"?"2m":"1m",false,parked?eighths(channel):0));
      for(std::size_t i=1;i<park.size();++i)
        others.push_back(std::make_unique<FollowEpochDecoder>(origin,rate,park[i],address,crc_init,keep,false,phy,false,eighths(park[i])));
      // A park's decoders are split between this thread and one helper, each
      // block handed over and waited for (2M at 16 MS/s is ~0.13 core each).
      std::vector<FollowEpochDecoder*> mine,theirs;
      for(std::size_t i=0;i<others.size();++i)(parked&&i%2?theirs:mine).push_back(others[i].get());
      std::mutex handoff;std::condition_variable turn;const Block* job=nullptr;bool quit=false;
      std::thread helper;
      if(!theirs.empty())helper=std::thread([&]{
        std::unique_lock<std::mutex> lock(handoff);
        for(;;){
          turn.wait(lock,[&]{return quit||job;});if(!job)return;
          const auto* current=job;lock.unlock();
          for(auto* o:theirs)o->consume(*current);
          lock.lock();job=nullptr;turn.notify_all();
        }
      });
      SpectrumStream spectrum;
      while(!input->input_done.load()||input->ring.front()){
        const auto* block=input->ring.front();if(!block){std::this_thread::sleep_for(std::chrono::microseconds(500));continue;}
        decoder.before_input(block->first_sample);
        if(history)history->append(block->iq.data(),block->size,block->first_sample,epoch);
        if(helper.joinable()){{std::lock_guard<std::mutex> lock(handoff);job=block;}turn.notify_all();}
        decoder.consume(*block);
        for(auto* o:mine)o->consume(*block);
        if(helper.joinable()){std::unique_lock<std::mutex> lock(handoff);turn.wait(lock,[&]{return !job;});}
        if(!parked)spectrum.consume(block->iq.data(),block->size,block->first_sample);
        // A parked tuning is not the channel's usual center; skip its spectrum.
        const auto now=now_us();if(!parked&&spectrum.windows()&&now-last_spectrum>=67000){
          Snapshot snap;snap.frequency=ble_frequency(channel);snap.ble_phy=phy;snap.end=total_samples+spectrum.end();snap.first=total_samples+spectrum.first();snap.windows=spectrum.windows();
          snap.bins=spectrum.take(&snap.mean_bins);snap.delivered=total_samples+input->delivered.load();snap.dropped=input->dropped.load();
          snap.decoded=total_decoded+decoder.decoder().frames;snap.candidates=total_candidates+decoder.decoder().candidates;snap.crc_failures=total_bad+decoder.decoder().crc_failures;
          mailbox.publish(snap);last_spectrum=now;
        }
        input->ring.pop();
      }
      if(helper.joinable()){{std::lock_guard<std::mutex> lock(handoff);quit=true;}turn.notify_all();helper.join();}
      decoder.finish();for(auto& o:others){o->finish();total_decoded+=o->decoder().frames;}
      total_samples+=input->delivered.load()*config.rate/rate;total_decoded+=decoder.decoder().frames;total_candidates+=decoder.decoder().candidates;total_bad+=decoder.decoder().crc_failures;
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
      if(interrupted||commands.poll_input(config.stop_on_stdin_eof,history.get(),mailbox)||(config.duration_ms&&now_us()-started>=config.duration_ms*1000LL)){follow.stop("BLE following stopped");break;}
      if(hackrf_is_streaming(device.value)!=HACKRF_TRUE)throw std::runtime_error("HackRF stream stopped unexpectedly during BLE following");
      drain();follow.tick(now_us());if(follow.done())break;
      // Leave advertising immediately after a valid setup. Waiting epochs are
      // restarted each second to keep host/sample clock drift bounded.
      // A hop's window closes once the delivered samples cover it on the
      // sample clock (lower bound: start_rx invocation, 1000 ppm, 40 us), not
      // at a wall-clock guess: a loaded host delivers USB transfers late, and
      // stopping on time then discards the very packet the hop was for.
      // Prompt delivery closes it sooner. Wall clock stays a capped fallback.
      const bool hop=follow.connected()&&channel<37;
      const auto covered=[&]{
        const auto at=static_cast<std::int64_t>(input->delivered.load()*1000000ULL/epoch_rate);
        return epoch_origin+at-at/1000-40>=close_us-flush_us;
      };
      // A parked epoch also closes as soon as the timing is re-acquired.
      if(hop?(covered()||now_us()>=close_us+4*flush_us||(parked&&!follow.parked())):(now_us()>=close_us||(channel>=37&&follow.connected()))){
        stop_epoch();if(follow.done())break;
        if(follow.connected()){
          const auto plan=follow.plan(now_us(),retune_budget,flush_us);if(!plan)break;
          start_epoch(plan->channel,plan->close_us,plan->phy,plan->park,plan->park_center_hz,plan->park_rate);
        }else start_epoch(config.channel,0);
      }
      controller_wait(500);
    }
    stop_epoch();report(true);cleanup();
    retain_stopped(device,commands,history.get(),mailbox);
  }catch(...){cleanup();throw;}
  return 0;
}
