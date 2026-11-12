#pragma once
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace airwolf {
constexpr std::size_t block_bytes = 262144;
struct Block {
  std::array<std::int8_t, block_bytes> iq{};
  std::size_t size = 0;
  std::uint64_t first_sample = 0;
  std::int64_t received_us = 0;
  std::uint64_t callback_end = 0;
};

// Exactly one producer (libhackrf callback), one native consumer.
// Ownership transfers via release/acquire; producer never overwrites unread data.
// One slot is reserved to distinguish full from empty. Allocate this on the heap.
template<std::size_t Slots = 33> class Ring {
  static_assert(Slots >= 2);
  std::array<Block, Slots> slots_{};
  alignas(64) std::atomic<std::size_t> write_{0};
  alignas(64) std::atomic<std::size_t> read_{0};
public:
  bool push(const std::int8_t* iq, std::size_t bytes, std::uint64_t first,std::int64_t received_us=0,std::uint64_t callback_end=0) noexcept {
    if (bytes > block_bytes || bytes % 2) return false;
    const auto w = write_.load(std::memory_order_relaxed), next = (w+1)%Slots;
    if (next == read_.load(std::memory_order_acquire)) return false;
    auto& slot = slots_[w];
    std::memcpy(slot.iq.data(), iq, bytes);
    slot.size = bytes;
    slot.first_sample = first;
    slot.received_us = received_us;slot.callback_end=callback_end;
    write_.store(next, std::memory_order_release);
    return true;
  }
  const Block* front() const noexcept {
    const auto r = read_.load(std::memory_order_relaxed);
    return r == write_.load(std::memory_order_acquire) ? nullptr : &slots_[r];
  }
  void pop() noexcept { read_.store((read_.load(std::memory_order_relaxed)+1)%Slots, std::memory_order_release); }
};
}
