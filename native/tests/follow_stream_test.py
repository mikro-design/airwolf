import json, os, subprocess, sys, time
binary = sys.argv[1]
for mode in ('normal', 'csa2', 'short-interval', 'bad-crc', 'phy-update', 'waiting-gap'):
    process = subprocess.Popen([binary, '--decoder', 'ble', '--frequency', '2402000000', '--sample-rate', '20000000', '--ble-follow', '--duration-ms', '650'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, 'AIRWOLF_FAKE_BLE': mode})
    # Keep stdin open: EOF is the production receiver's graceful-stop request.
    events = [json.loads(line) for line in process.stdout]
    errors = process.stderr.read()
    assert process.wait(timeout=5) == 0, errors
    assert 'RETUNE_WHILE_STREAMING' not in errors, errors
    follow = [e for e in events if e['type'] == 'follow']
    packets = [e for e in events if e['type'] == 'packet']
    spectra = [e for e in events if e['type'] == 'spectrum']
    # Preserve evidence when a shared runner misses the one-shot setup packet.
    # Follow state alone cannot distinguish decoding, USB gaps and scheduling.
    diagnostic = {'mode': mode, 'follow': follow, 'packets': packets,
                  'spectra': [{k: v for k, v in e.items() if k != 'bins'} for e in spectra],
                  'stderr': errors}
    assert spectra and all(e['centerFrequencyHz'] == e['frequencyHz'] + 5000000 for e in spectra), spectra
    if mode == 'bad-crc':
        assert not any(e['state'] in ('acquiring','tracking') for e in follow), follow
        assert not any(e['channel'] < 37 for e in packets), packets
        continue
    assert any(e['state'] == 'tracking' and e['verifiedEvents'] >= 2 for e in follow), diagnostic
    data = [e for e in packets if e['channel'] < 37]
    assert len({e['captureEpoch'] for e in data}) >= 2, data
    assert len({e['frequencyHz'] for e in data}) >= 2, data
    for packet in data:
        assert packet['deviceSerial'] == '00000000000000000000000000000001', packet
        assert packet['crcInit'] == 0xc4c181 and packet['phy'] == '1m', packet
        assert packet['timeUncertaintyUs'] >= 0, packet
        if 'connectionEvent' in packet:
            event = packet['connectionEvent']
            if mode != 'csa2':
                assert packet['channel'] == ((event + 1) * 5) % 37, packet
            if packet['bytes'][4] & 3 != 3:
                assert packet['bytes'][6] == event % 256, packet
    assert follow[-1]['skippedEvents'] > 0, follow[-1]
    if mode == 'phy-update':
        assert follow[-1]['state'] == 'stopped' and 'PHY' in follow[-1]['message'], follow[-1]
    print(mode, 'native RX epochs:', len({e['captureEpoch'] for e in data}), 'packets:',len(data), 'retunes:',follow[-1]['retunes'])
print('Production controller + fake libhackrf + generated IQ passed (no hardware claim).')

# Exercise the production serial resolver through the actual CLI/open call.
for mode, serial, success in [('two', None, False), ('one', '00000000000000000000000000000002', False), ('two', '00000000000000000000000000000002', True), ('two', '00000000000000000000000000000003', False), ('duplicate', '00000000000000000000000000000001', False)]:
    args = [binary, '--frequency', '2402000000', '--sample-rate', '20000000', '--duration-ms', '100']
    if serial: args += ['--serial', serial]
    result = subprocess.run(args, input='', capture_output=True, text=True, timeout=5, env={**os.environ, 'AIRWOLF_FAKE_DEVICES': mode})
    assert (result.returncode == 0) == success, result.stderr
    if success: assert 'opened_serial=' + serial in result.stderr, result.stderr
    else: assert 'opened_serial=' not in result.stderr, result.stderr
print('Two-device selection: explicit serial opens only the chosen board; ambiguous/missing/duplicate selection fails without opening a board.')

for mode, usable in [('unreadable', 0), ('mixed', 1)]:
    env = {**os.environ, 'AIRWOLF_FAKE_DEVICES': mode}
    result = subprocess.run([binary, '--list'], capture_output=True, text=True, timeout=5, env=env)
    listing = json.loads(result.stdout)
    assert listing['available'] == bool(usable) and len(listing['serials']) == usable, listing
    assert 'permissions/drivers' in listing['details'], listing
    result = subprocess.run([binary, '--duration-ms', '50'], capture_output=True, text=True, timeout=5, env=env)
    assert result.returncode != 0 and 'No HackRF boards found' not in result.stderr, result.stderr
print('Unreadable USB identities retain actionable diagnostics and do not silently select a board.')

started = time.time() * 1000
result = subprocess.run([binary, '--decoder', 'ble', '--frequency', '2402000000', '--duration-ms', '800'], capture_output=True, text=True, timeout=5, env={**os.environ, 'AIRWOLF_FAKE_SETUP_DELAY_MS': '200'})
assert result.returncode == 0, result.stderr
packets = [event for line in result.stdout.splitlines() if (event := json.loads(line))['type'] == 'packet']
assert packets and all(started + 200 <= p['time'] <= time.time() * 1000 for p in packets), packets
print('Packet clock starts after USB configuration, not before device setup delay.')

# The fake transport records the real configuration call, without claiming an
# analog response measurement. Wider profiles must set this after sample rate.
for rate in (8000000,10000000,16000000,20000000):
    for decoder in ('zigbee','ble'):
        args = [binary,'--decoder',decoder,'--frequency', '2425000000' if decoder == 'zigbee' else '2438000000','--sample-rate',str(rate),'--duration-ms','30']
        if decoder == 'ble': args += ['--ble-phy','2m','--ble-access-address',str(0xaa08192b),'--ble-crc-init',str(0xc4c181)]
        result = subprocess.run(args,capture_output=True,text=True,timeout=5)
        assert result.returncode == 0, result.stderr
        if rate in (8000000,10000000):
            assert 'baseband_bandwidth=' + str(8000000 if rate == 8000000 else 9000000) in result.stderr, result.stderr
        else: assert 'baseband_bandwidth=' not in result.stderr, result.stderr
print('Wide PHYs configure an 8/9 MHz analog filter at 8/10 MS/s after setting sample rate.')
