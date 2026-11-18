// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
namespace airwolf::iio {
// A stopped reader can block this writer, never acquisition or DSP. Keep the
// latest spectrum and bounded packet/reply queues; the host owns shutdown timeout.
class Events {
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::string> packets_,replies_;
  std::string spectrum_;
  std::size_t bytes_=0;
  bool done_=false;
  std::thread writer_;
  void write(){
    for(;;){
      std::string event;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock,[&]{return done_||!spectrum_.empty()||!packets_.empty()||!replies_.empty();});
        if(!replies_.empty()){event=std::move(replies_.front());replies_.pop_front();}
        else if(!spectrum_.empty())event.swap(spectrum_);
        else if(!packets_.empty()){event=std::move(packets_.front());bytes_-=event.size();packets_.pop_front();}
        else return;
      }
      std::cout<<event<<std::flush;
      if(!std::cout){failed.store(true);return;}
    }
  }
public:
  std::atomic<bool> failed{false};
  std::atomic<std::uint64_t> skipped{0},packet_drops{0};
  Events(){writer_=std::thread([this]{try{write();}catch(...){failed.store(true);}});}
  ~Events(){finish();}
  void finish(){
    {std::lock_guard<std::mutex> lock(mutex_);done_=true;}ready_.notify_one();
    if(writer_.joinable())writer_.join();
  }
  void spectrum(std::string event){
    {std::lock_guard<std::mutex> lock(mutex_);if(!spectrum_.empty())++skipped;spectrum_=std::move(event);}ready_.notify_one();
  }
  void packet(std::string event){
    {std::lock_guard<std::mutex> lock(mutex_);
      if(event.size()>8*1024*1024){++packet_drops;return;}
      while(!packets_.empty()&&(packets_.size()>=2000||bytes_+event.size()>8*1024*1024)){bytes_-=packets_.front().size();packets_.pop_front();++packet_drops;}
      bytes_+=event.size();packets_.push_back(std::move(event));
    }ready_.notify_one();
  }
  bool replies_full(){std::lock_guard<std::mutex> lock(mutex_);return replies_.size()>=8;}
  void reply(std::string event){
    {std::lock_guard<std::mutex> lock(mutex_);replies_.push_back(std::move(event));}ready_.notify_one();
  }
};
}
