"""A missed connection update through real USB/controller/DSP: the update
(100 ms -> 75 ms) is on air with a corrupted CRC, so the follower never hears
it and must re-acquire the new timing from the packets' own timing. The
park runs at 16 MS/s on up to six channels; following returns to 20 MS/s.
The second run adds a USB stall in the park: dropped IQ blocks cost packets,
not the connection."""
import json
import os
import subprocess
import sys

binary = sys.argv[1]
base = {**os.environ, 'AIRWOLF_FAKE_CLOCK': 'controlled', 'AIRWOLF_FAKE_BLE': 'timing-hidden',
       'AIRWOLF_FAKE_CPU_DELAY_MS': '25', 'AIRWOLF_FAKE_START_DELAY_MS': '40'}
def run(burst):
    env = {**base, 'AIRWOLF_FAKE_USB_BURST': str(burst)} if burst else base
    result = subprocess.run([binary, '--decoder', 'ble', '--frequency', '2402000000',
        '--sample-rate', '20000000', '--ble-follow', '--duration-ms', '26000'],
        capture_output=True, text=True, timeout=180, env=env)
    assert result.returncode == 0, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    status = [e for e in events if e['type'] == 'follow']
    packets = [e for e in events if e['type'] == 'packet' and 'connectionEvent' in e]
    diagnostic = {'status': [(s['state'], s['message'], s['intervalUs'], s['verifiedEvents']) for s in status],
                  'events': sorted({p['connectionEvent'] for p in packets}), 'stderr': result.stderr[-2000:]}
    assert status[-1]['state'] == 'stopped' and status[-1]['message'] == 'BLE following stopped', diagnostic
    assert any('Re-acquiring' in s['message'] for s in status), diagnostic
    # The update itself never verifies; the new interval comes from re-acquisition.
    assert 75000 in {s['intervalUs'] for s in status}, diagnostic
    # Park packets carry the park's own sample rate and come from several channels.
    parked = [e for e in events if e['type'] == 'packet' and e['sampleRateHz'] == 16000000]
    assert len({p['channel'] for p in parked}) >= 3, diagnostic
    assert {e['sampleRateHz'] for e in events if e['type'] == 'packet'} == {16000000, 20000000}, diagnostic
    after = [p for p in packets if p['connectionEvent'] >= 18]
    assert len({p['connectionEvent'] for p in after}) >= 10, diagnostic
    for packet in packets:
        event = packet['connectionEvent']
        assert packet['channel'] == ((event + 1) * 5) % 37 and packet['crcInit'] == 0xc4c181, packet
        # The payload carries the transmitter's own event counter: re-acquired
        # counters must be exact, not just right modulo 37.
        if packet['bytes'][4] & 3 != 3:
            assert packet['bytes'][6:-3] == [event & 255, 0x48, 0x69], packet
    dropped = max(s.get('queueDroppedSamples', 0) for s in status)
    if burst:
        assert f'usb_burst={burst}' in result.stderr and dropped > 0, diagnostic
        assert not any('malformed' in s['message'] or 'lost' == s['state'] for s in status), diagnostic
    else:
        assert dropped == 0, diagnostic
    print(f"Hidden 100ms -> 75ms update re-acquired{' through a USB stall (%d samples dropped)' % dropped if burst else ''}; "
          f"{len({p['connectionEvent'] for p in after})} later events with exact counters")

run(0)
run(80)
