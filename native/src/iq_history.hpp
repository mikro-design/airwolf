#pragma once
#include "iq_recording.hpp"
#include <deque>
#include <memory>
#include <mutex>
#include <unordered_map>
namespace airwolf {
// Original USB blocks are shared by history and packet excerpts. Overlapping
// LTE acquisition windows therefore do not duplicate hundreds of milliseconds
// of IQ for every MIB. Separate raw/cache budgets bound total retained storage.
template<class Sample> class BasicIqHistory {
  struct Block {std::uint64_t first;std::vector<Sample> bytes;};
public:
  struct Excerpt {
    std::uint64_t token,first,end;
    std::vector<std::shared_ptr<const Block>> blocks;
    template<class F> void each(F emit)const{
      for(const auto& block:blocks){
        const auto a=std::max(first,block->first),b=std::min(end,block->first+block->bytes.size()/2);
        if(b>a)emit(block->bytes.data()+(a-block->first)*2,static_cast<std::size_t>((b-a)*2),a);
      }
    }
    void save(const std::string& path)const{
      BasicIqRecording<Sample> recording(path,end-first);
      each([&](const Sample* data,std::size_t bytes,std::uint64_t at){recording.append(data,bytes,at);});
      recording.save();
    }
    std::vector<Sample> copy()const{
      std::vector<Sample> result;result.reserve((end-first)*2);
      each([&](const Sample* data,std::size_t bytes,std::uint64_t){result.insert(result.end(),data,data+bytes);});return result;
    }
  };
private:
  std::mutex mutex_;
  std::deque<std::shared_ptr<const Block>> history_;
  // A block evicted while no excerpt shares it is reused for the next append.
  // Allocating each multi-MB block anew maps fresh pages; faulting and zeroing
  // them took up to 130 ms per 1M-sample block on a loaded CI VM, on the DSP
  // thread, and dropped real-time GPS samples.
  std::shared_ptr<Block> spare_;
  void release(std::shared_ptr<const Block>&& block){
    if(block.use_count()==1&&(!spare_||block->bytes.capacity()>spare_->bytes.capacity()))
      spare_=std::const_pointer_cast<Block>(std::move(block));
    block.reset();
  }
  std::deque<std::shared_ptr<const Excerpt>> excerpts_;
  std::unordered_map<const Block*,std::size_t> references_;
  std::uint64_t end_=0,epoch_=0,next_=0;
  std::size_t history_budget_,budget_,history_bytes_=0,bytes_=0;
  void evict(){
    for(const auto& block:excerpts_.front()->blocks){
      auto found=references_.find(block.get());
      if(!--found->second){bytes_-=block->bytes.capacity();references_.erase(found);}
    }
    excerpts_.pop_front();
  }
public:
  explicit BasicIqHistory(std::size_t history_bytes=64*1024*1024,std::size_t excerpt_bytes=64*1024*1024)
    :history_budget_(history_bytes/sizeof(Sample)),budget_(excerpt_bytes/sizeof(Sample)){
    if(history_bytes<2*sizeof(Sample)||history_bytes%(2*sizeof(Sample)))throw std::runtime_error("Invalid IQ history size");
  }
  void append(const Sample* data,std::size_t bytes,std::uint64_t first,std::uint64_t epoch=0){
    if(bytes%2)throw std::runtime_error("Incomplete history IQ sample");
    if(!bytes)return;
    std::lock_guard<std::mutex> lock(mutex_);
    if(first!=end_||epoch!=epoch_){while(!history_.empty()){release(std::move(history_.front()));history_.pop_front();}history_bytes_=0;epoch_=epoch;}
    end_=first+bytes/2;
    if(bytes>history_budget_){data+=bytes-history_budget_;bytes=history_budget_;first=end_-bytes/2;}
    // The budget bounds memory: blocks count by allocation (capacity), not by
    // content. A reused block keeps its capacity, so after the USB block size
    // shrank, small blocks in big allocations held up to twice the budget. A
    // spare more than twice the size needed (or over budget) is freed instead.
    if(spare_&&(spare_->bytes.capacity()>2*bytes||spare_->bytes.capacity()>history_budget_))spare_.reset();
    auto block=spare_?std::move(spare_):std::make_shared<Block>();
    block->first=first;block->bytes.assign(data,data+bytes);
    const auto size=block->bytes.capacity();
    while(!history_.empty()&&history_bytes_+size>history_budget_){
      history_bytes_-=history_.front()->bytes.capacity();release(std::move(history_.front()));history_.pop_front();
    }
    history_bytes_+=size;history_.push_back(std::move(block));
  }
  // Bytes allocated for raw history (test and diagnostics).
  std::size_t history_memory(){
    std::lock_guard<std::mutex> lock(mutex_);
    std::size_t n=0;for(const auto& block:history_)n+=block->bytes.capacity();return n;
  }
  std::uint64_t retain(std::uint64_t first,std::uint64_t end,std::uint64_t padding,std::uint64_t epoch=0){
    std::lock_guard<std::mutex> lock(mutex_);
    if(history_.empty()||epoch!=epoch_||first<history_.front()->first||end>end_||end<=first)return 0;
    auto item=std::make_shared<Excerpt>();
    item->first=std::max(history_.front()->first,first-std::min(first,padding));
    item->end=end+std::min(end_-end,padding);
    std::size_t total=0;
    for(const auto& block:history_)if(block->first<item->end&&block->first+block->bytes.size()/2>item->first){
      item->blocks.push_back(block);total+=block->bytes.capacity();
    }
    if(total>budget_)return 0;
    auto additional=[&]{std::size_t n=0;for(const auto& block:item->blocks)if(!references_.count(block.get()))n+=block->bytes.capacity();return n;};
    while(!excerpts_.empty()&&(bytes_+additional()>budget_||excerpts_.size()>=2000))evict();
    for(const auto& block:item->blocks)if(references_[block.get()]++==0)bytes_+=block->bytes.capacity();
    item->token=++next_;excerpts_.push_back(item);return item->token;
  }
  void seal(){
    std::lock_guard<std::mutex> lock(mutex_);history_.clear();history_bytes_=0;
  }
  std::shared_ptr<const Excerpt> get(std::uint64_t token){
    std::lock_guard<std::mutex> lock(mutex_);
    for(const auto& item:excerpts_)if(item->token==token)return item;
    throw std::runtime_error("This frame's IQ has expired from the native cache");
  }
};
using IqHistory=BasicIqHistory<std::int8_t>;
}
