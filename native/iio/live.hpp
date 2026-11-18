// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "source.hpp"
#include "pipeline.hpp"
namespace airwolf::iio {
struct LiveOptions {
  Config radio;
  DecodeConfig decode;
  std::string recording;
  std::uint64_t record_samples=0;
  bool retain=false,stop_on_eof=false;
};
int live(const LiveOptions& options);
}
