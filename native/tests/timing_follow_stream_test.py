"""Connection interval changes through real USB/controller/DSP, with independent air timing."""
import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

binary = sys.argv[1]
env = {**os.environ, 'AIRWOLF_FAKE_CLOCK': 'controlled', 'AIRWOLF_FAKE_BLE': 'timing-update',
       'AIRWOLF_FAKE_CPU_DELAY_MS': '25', 'AIRWOLF_FAKE_START_DELAY_MS': '40'}
for rate in (8000000, 10000000, 16000000, 20000000):
    result = subprocess.run([binary, '--decoder', 'ble', '--frequency', '2402000000',
        '--sample-rate', str(rate), '--ble-follow', '--retain-iq', '--duration-ms', '5500'],
        capture_output=True, text=True, timeout=120, env=env)
    assert result.returncode == 0 and 'RETUNE_WHILE_STREAMING' not in result.stderr, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    status = [e for e in events if e['type'] == 'follow']
    packets = [e for e in events if e['type'] == 'packet' and 'connectionEvent' in e]
    diagnostic = {'rate': rate, 'status': status, 'packets': packets, 'stderr': result.stderr}
    assert status[-1]['state'] == 'stopped' and status[-1]['message'] == 'BLE following stopped', diagnostic
    assert {100000, 150000, 75000} <= {e['intervalUs'] for e in status}, diagnostic
    assert any(e['connectionEvent'] >= 40 for e in packets), diagnostic
    assert any(18 <= e['connectionEvent'] < 30 for e in packets), diagnostic
    for packet in packets:
        event = packet['connectionEvent']
        assert packet['channel'] == ((event + 1) * 5) % 37 and packet['crcInit'] == 0xc4c181, packet
        assert packet['phy'] == '1m' and packet.get('iqToken'), packet
        if packet['bytes'][4] & 3 != 3:
            assert packet['bytes'][6:-3] == [event, 0x48, 0x69], packet
    print(rate, '100ms -> 150ms -> 75ms; both offsets, event/channel/CRC and retained IQ passed', flush=True)

# Retrieve an actual post-update epoch and recover exact bytes from its IQ.
with tempfile.TemporaryDirectory(prefix='airwolf-timing-follow-') as directory:
    destination = Path(directory) / 'selected.iq'
    process = subprocess.Popen([binary, '--decoder', 'ble', '--frequency', '2402000000',
        '--sample-rate', '8000000', '--ble-follow', '--retain-iq', '--duration-ms', '6000'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    guard = threading.Timer(120, process.kill); guard.start()
    try:
        selected = None
        for line in process.stdout:
            event = json.loads(line)
            if event['type'] == 'packet' and event.get('connectionEvent', -1) >= 30:
                selected = event; break
        assert selected, 'No post-update IQ candidate'
        process.stdin.write(f"pause\niq-snapshot 1 {selected['iqToken']} {str(destination).encode().hex()}\n")
        process.stdin.flush()
        reply = None; retained = False
        for line in process.stdout:
            event = json.loads(line)
            if event['type'] == 'iq-snapshot': reply = event
            if event['type'] == 'iq-retained': retained = True
            if reply and retained: break
        assert reply and not reply['error'], reply
        process.stdin.write('stop\n'); process.stdin.flush(); process.communicate(timeout=120)
        assert process.returncode == 0
        frequency = selected['frequencyHz']
        replay = subprocess.run([sys.argv[2], 'decode', str(destination), '0',
            str(reply['endSample'] - reply['firstSample']), 'ble', '8000000', str(frequency),
            str(frequency + 2000000), '1m', str(0xaa08192b), str(0xc4c181)],
            capture_output=True, text=True, timeout=120, check=True)
        matches = [p for p in json.loads(replay.stdout)['packets'] if p['bytes'] == selected['bytes']]
        assert len(matches) == 1 and matches[0]['integrity'] == 'valid', replay.stdout
        assert abs(matches[0]['firstSample'] + reply['firstSample'] - selected['firstSample']) <= 20, (matches, selected)
    finally:
        guard.cancel()
        if process.poll() is None: process.kill(); process.wait()
print('Post-update selected IQ replays original bytes, CRC and sample bounds')
