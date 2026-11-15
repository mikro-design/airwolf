// Included after the transport types and FollowQueue in main.cpp. Only this
// controller calls stop/set_freq/start; the USB callback only copies samples.
#include "ble_aux_follow.hpp"
int run_aux_follow(Device& device, const Config& config) {
  auto input = std::make_unique<Acquisition>();
  auto output_state = std::make_unique<Acquisition>();
  auto history = config.retain_iq ? std::make_unique<IqHistory>() : nullptr;
  Mailbox mailbox;
  FollowQueue received;
  ReceiverCommands commands;
  BleAuxFollower follow(config.channel, config.ble_phy);
  std::thread worker, writer;
  std::uint64_t epoch = 0, total_samples = 0, total_decoded = 0, total_candidates = 0, total_bad = 0;
  std::uint64_t seen_drops = 0, seen_malformed = 0;
  int channel = config.channel;
  std::string phy = config.ble_phy;
  const auto started = now_us();
  const double wall_offset = std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count() - started / 1000.0;
  const auto delivery_us = static_cast<std::int64_t>(hackrf_get_transfer_buffer_size(device.value) * 500000ULL / config.rate) + 2000;
  std::int64_t stop_budget = delivery_us, start_budget = 3000, close_us = 0, last_spectrum = 0;
  std::string last_status;
  auto report = [&](bool force = false) {
    std::ostringstream status;
    status << "{\"version\":1,\"type\":\"aux-follow\",\"synthetic\":false,\"state\":" << quote(follow.state)
      << ",\"message\":" << quote(follow.message) << ",\"channel\":" << channel << ",\"frequencyHz\":" << ble_frequency(channel)
      << ",\"phy\":" << quote(phy) << ",\"observedPointers\":" << follow.observed_pointers
      << ",\"verifiedPackets\":" << follow.verified_packets << ",\"skippedLate\":" << follow.skipped_late
      << ",\"missedWindows\":" << follow.missed_windows << ",\"rejectedPointers\":" << follow.rejected_pointers
      << ",\"retunes\":" << follow.retunes << "}\n";
    const auto value = status.str();
    if (force || value != last_status) { mailbox.follow(value); last_status = value; }
  };
  auto drain = [&] {
    const auto drops = input->dropped.load(), malformed = input->malformed.load();
    const bool gap = received.overflow.exchange(false) || drops != seen_drops || malformed != seen_malformed;
    seen_drops = drops; seen_malformed = malformed;
    if (gap) follow.gap();
    for (auto& timed : received.take()) {
      auto& packet = timed.packet;
      if (!gap) {
        const auto type = follow.observe(packet, timed.first, timed.end);
        if (type) packet.ble_aux_type = *type == 0 ? "aux-adv" : "aux-chain";
      }
      packet.capture_epoch = epoch;
      packet.frequency_hz = ble_frequency(packet.channel);
      packet.crc_init = 0x555555;
      packet.time_ms = wall_offset + (timed.first.lo + (timed.first.hi - timed.first.lo) / 2) / 1000.0;
      packet.time_uncertainty_us = (timed.first.hi - timed.first.lo + 1) / 2;
      mailbox.packet(std::move(packet));
    }
    report();
  };
  auto stop_epoch = [&] {
    const auto beginning = now_us();
    if (device.receiving) {
      input->stop = true;
      check(hackrf_stop_rx(device.value), "hackrf_stop_rx");
      device.receiving = false;
    }
    input->input_done = true;
    if (worker.joinable()) worker.join();
    drain();
    stop_budget = std::max(stop_budget, now_us() - beginning + 1000);
  };
  auto start_epoch = [&](int next_channel, const std::string& next_phy, std::int64_t deadline) {
    const auto beginning = now_us();
    channel = next_channel; phy = next_phy;
    check(hackrf_set_freq(device.value, receiver_center(ble_frequency(channel), config.rate, true)), "hackrf_set_freq");
    input->delivered = 0; input->dropped = 0; input->malformed = 0;
    input->stop = false; input->input_done = false;
    received.overflow = false; seen_drops = seen_malformed = 0;
    if (epoch) ++follow.retunes;
    ++epoch;
    const auto origin = now_us();
    check(hackrf_start_rx(device.value, receive_callback, input.get()), "hackrf_start_rx");
    device.receiving = true;
    close_us = deadline;
    if (channel == config.channel && phy == config.ble_phy) follow.clock_refreshed();
    worker = std::thread([&, origin] {
      FollowEpochDecoder decoder(origin, config.rate, channel, 0x8e89bed6, 0x555555, [&](TimedPacket packet) {
        if (history) packet.packet.iq_token = history->retain(packet.packet.first_sample, packet.packet.end_sample, config.rate / 10000, epoch);
        received.push(std::move(packet));
      }, true, phy);
      SpectrumStream spectrum;
      while (!input->input_done.load() || input->ring.front()) {
        const auto* block = input->ring.front();
        if (!block) { std::this_thread::sleep_for(std::chrono::microseconds(500)); continue; }
        decoder.before_input(block->first_sample);
        if (history) history->append(block->iq.data(), block->size, block->first_sample, epoch);
        decoder.consume(*block);
        spectrum.consume(block->iq.data(), block->size, block->first_sample);
        const auto now = now_us();
        if (spectrum.windows() && now - last_spectrum >= 67000) {
          Snapshot snap;
          snap.frequency = ble_frequency(channel);
          snap.ble_phy = phy;
          snap.end = total_samples + spectrum.end(); snap.first = total_samples + spectrum.first(); snap.windows = spectrum.windows();
          snap.bins = spectrum.take(&snap.mean_bins); snap.delivered = total_samples + input->delivered.load(); snap.dropped = input->dropped.load();
          snap.decoded = total_decoded + decoder.decoder().frames;
          snap.candidates = total_candidates + decoder.decoder().candidates; snap.crc_failures = total_bad + decoder.decoder().crc_failures;
          mailbox.publish(snap); last_spectrum = now;
        }
        input->ring.pop();
      }
      decoder.finish();
      total_samples += input->delivered.load(); total_decoded += decoder.decoder().frames;
      total_candidates += decoder.decoder().candidates; total_bad += decoder.decoder().crc_failures;
    });
    start_budget = std::max(start_budget, now_us() - beginning + 2000);
    report(true);
  };
  auto cleanup = [&] {
    input->stop = true;
    if (device.receiving) { hackrf_stop_rx(device.value); device.receiving = false; }
    input->input_done = true;
    if (worker.joinable()) worker.join();
    drain(); mailbox.finish();
    if (writer.joinable()) writer.join();
  };
  try {
    writer = std::thread(publish, std::ref(*output_state), std::ref(mailbox), std::cref(config));
    start_epoch(config.channel, config.ble_phy, 0);
    while (!follow.done() && !output_state->stop.load()) {
      if (interrupted || commands.poll_input(config.stop_on_stdin_eof, history.get(), mailbox) ||
          (config.duration_ms && now_us() - started >= config.duration_ms * 1000LL)) {
        follow.stop("Auxiliary advertising following stopped"); break;
      }
      if (hackrf_is_streaming(device.value) != HACKRF_TRUE) throw std::runtime_error("HackRF stream stopped unexpectedly during auxiliary following");
      drain();
      const auto plan = follow.plan(now_us(), stop_budget + start_budget, delivery_us);
      const bool return_home = follow.clock_refresh_requested() || (follow.waiting() && (channel != config.channel || phy != config.ble_phy));
      if (plan || return_home || (close_us && now_us() >= close_us)) {
        stop_epoch();
        follow.tick(now_us());
        const auto target = follow.plan(now_us(), start_budget, delivery_us, true);
        if (target) {
          follow.started(*target);
          start_epoch(target->channel, target->phy, target->close_us);
        } else start_epoch(config.channel, config.ble_phy, 0);
      }
      std::this_thread::sleep_for(std::chrono::microseconds(500));
    }
    stop_epoch(); report(true); cleanup();
    retain_stopped(device, commands, history.get(), mailbox);
  } catch (...) { cleanup(); throw; }
  return 0;
}
