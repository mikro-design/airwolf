#pragma once
#include <cstddef>
#include <cstdint>
struct hackrf_device;
struct hackrf_transfer {hackrf_device* device;std::uint8_t* buffer;int buffer_length,valid_length;void* rx_ctx;void* tx_ctx;};
using hackrf_sample_block_cb_fn=int(*)(hackrf_transfer*);
enum hackrf_error {HACKRF_SUCCESS=0,HACKRF_TRUE=1,HACKRF_ERROR_OTHER=-1};
struct hackrf_device_list_t {int devicecount;char** serial_numbers;};
int hackrf_init();int hackrf_exit();const char* hackrf_error_name(hackrf_error);
hackrf_device_list_t* hackrf_device_list();void hackrf_device_list_free(hackrf_device_list_t*);
int hackrf_open_by_serial(const char*,hackrf_device**);int hackrf_close(hackrf_device*);
int hackrf_set_sample_rate(hackrf_device*,double);int hackrf_set_freq(hackrf_device*,std::uint64_t);
int hackrf_set_lna_gain(hackrf_device*,std::uint32_t);int hackrf_set_vga_gain(hackrf_device*,std::uint32_t);
int hackrf_set_amp_enable(hackrf_device*,std::uint8_t);int hackrf_set_antenna_enable(hackrf_device*,std::uint8_t);
int hackrf_start_rx(hackrf_device*,hackrf_sample_block_cb_fn,void*);int hackrf_stop_rx(hackrf_device*);int hackrf_is_streaming(hackrf_device*);
std::size_t hackrf_get_transfer_buffer_size(hackrf_device*);

int hackrf_set_baseband_filter_bandwidth(hackrf_device*,std::uint32_t);
