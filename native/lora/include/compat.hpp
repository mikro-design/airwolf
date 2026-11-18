// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// Minimal local adapter for the pinned receive blocks. This is not GNU Radio:
// no runtime, scheduler, asynchronous messaging, device access or global state.
// receiver.cpp owns all bounded queues and calls each block synchronously.
#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>
// The pinned blocks use this POSIX constant, which strict UCRT C++17 omits.
#ifndef M_PI
#define M_PI 3.141592653589793238462643383279502884
#endif
// The pinned blocks call unqualified abs() on float/double LLRs and timing
// offsets (hamming_dec, frame_sync). libstdc++ and MSVC declare only
// int abs(int) globally, silently truncating soft decisions and fractional
// STO/SFO; libc++ also exposes the floating overloads. Make every platform
// resolve the same overload set.
using std::abs;
using gr_complex = std::complex<float>;
using gr_vector_int = std::vector<int>;
using gr_vector_const_void_star = std::vector<const void*>;
using gr_vector_void_star = std::vector<void*>;
namespace pmt {
struct Value {
  std::string text;
  double number = 0;
  std::map<std::string, std::shared_ptr<Value>> dict;
};
using pmt_t = std::shared_ptr<Value>;
inline pmt_t mp(const std::string& value) {
  auto result = std::make_shared<Value>(); result->text = value; return result;
}
inline pmt_t mp(const char* value) { return mp(std::string(value)); }
inline pmt_t mp(double value) {
  auto result = std::make_shared<Value>(); result->number = value; return result;
}
inline pmt_t mp(float value) { return mp(double(value)); }
inline pmt_t mp(long value) { return mp(double(value)); }
inline pmt_t mp(bool value) { return mp(double(value)); }
inline pmt_t intern(const std::string& value) { return mp(value); }
inline pmt_t string_to_symbol(const std::string& value) { return mp(value); }
inline pmt_t from_bool(bool value) { return mp(value); }
inline pmt_t from_long(long value) { return mp(value); }
inline double to_double(const pmt_t& value) {
  if (!value) throw std::logic_error("Missing LoRa metadata value");
  return value->number;
}
inline float to_float(const pmt_t& value) { return float(to_double(value)); }
inline long to_long(const pmt_t& value) { return long(to_double(value)); }
inline bool to_bool(const pmt_t& value) { return to_double(value) != 0; }
inline pmt_t make_dict() { return std::make_shared<Value>(); }
inline pmt_t dict_add(const pmt_t& source, const pmt_t& key, const pmt_t& value) {
  if (!source || !key || !value) throw std::logic_error("Invalid LoRa metadata dictionary");
  auto result = std::make_shared<Value>(*source);
  result->dict[key->text] = value;
  if (result->dict.size() > 32) throw std::logic_error("LoRa metadata dictionary limit exceeded");
  return result;
}
inline pmt_t dict_delete(const pmt_t& source, const pmt_t& key) {
  auto result = std::make_shared<Value>(*source); result->dict.erase(key->text); return result;
}
inline pmt_t dict_ref(const pmt_t& source, const pmt_t& key, const pmt_t& fallback) {
  if (!source || !key) throw std::logic_error("Invalid LoRa metadata lookup");
  const auto found = source->dict.find(key->text);
  return found == source->dict.end() ? fallback : found->second;
}
}
namespace gr {
struct tag_t { std::uint64_t offset = 0; pmt::pmt_t key, value; };
struct io_signature {
  using sptr = std::shared_ptr<io_signature>;
  static sptr make(int, int, std::size_t) { return {}; }
  static sptr make2(int, int, std::size_t, std::size_t) { return {}; }
};
class block {
public:
  static constexpr int TPP_DONT = 0, TPP_ONE_TO_ONE = 1, WORK_CALLED_PRODUCE = -2;
  std::uint64_t read = 0, written = 0;
  int consumed = 0, produced = 0, policy = TPP_DONT;
  std::vector<tag_t> input_tags, output_tags;
  std::map<std::string, std::function<void(pmt::pmt_t)>> handlers;
  std::function<void(std::string, pmt::pmt_t)> on_message;
  block() = default;
  block(const char*, io_signature::sptr, io_signature::sptr) {}
  virtual ~block() = default;
  virtual void forecast(int, gr_vector_int&) {}
  virtual int general_work(int, gr_vector_int&, gr_vector_const_void_star&, gr_vector_void_star&) { return 0; }
  void set_output_multiple(int) {}
  void set_tag_propagation_policy(int value) { policy = value; }
  std::uint64_t nitems_read(int) const { return read; }
  std::uint64_t nitems_written(int) const { return written; }
  void consume_each(int count) { consumed = count; }
  void produce(int port, int count) { if (port == 0) produced = count; }
  void get_tags_in_window(std::vector<tag_t>& output, int, std::uint64_t start,
                         std::uint64_t end, const pmt::pmt_t& key) {
    for (const auto& tag : input_tags)
      if (tag.offset >= read + start && tag.offset < read + end && tag.key->text == key->text)
        output.push_back(tag);
  }
  void add_item_tag(int, tag_t tag) {
    if (output_tags.size() >= 16) throw std::logic_error("LoRa output metadata limit exceeded");
    output_tags.push_back(std::move(tag));
  }
  void add_item_tag(int port, std::uint64_t offset, pmt::pmt_t key, pmt::pmt_t value) {
    add_item_tag(port, {offset, std::move(key), std::move(value)});
  }
  void message_port_register_in(pmt::pmt_t) {}
  void message_port_register_out(pmt::pmt_t) {}
  template<class F> void set_msg_handler(const pmt::pmt_t& port, F function) {
    handlers[port->text] = std::move(function);
  }
  void message_port_pub(const pmt::pmt_t& port, pmt::pmt_t message) {
    if (on_message) on_message(port->text, std::move(message));
  }
};
class sync_block : public block {
public:
  sync_block(const char* name, io_signature::sptr input, io_signature::sptr output) : block(name, input, output) {}
  sync_block() = default;
  virtual int work(int, gr_vector_const_void_star&, gr_vector_void_star&) = 0;
  int general_work(int maximum, gr_vector_int& available,
                   gr_vector_const_void_star& input, gr_vector_void_star& output) override {
    const auto count = work(std::min(maximum, available[0]), input, output);
    consume_each(count); return count;
  }
};
}
namespace gnuradio {
template<class T> std::shared_ptr<T> get_initial_sptr(T* value) { return std::shared_ptr<T>(value); }
}
