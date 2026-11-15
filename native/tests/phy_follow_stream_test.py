"""Real controller, fake USB and independently CRC-built generated air."""
import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

# The fake USB clock advances only after the real DSP consumed each due block.
# OS scheduling and waveform-generation CPU cannot masquerade as USB latency.
os.environ['AIRWOLF_FAKE_CLOCK'] = 'controlled'
os.environ['AIRWOLF_FAKE_CPU_DELAY_MS'] = '25'
binary = sys.argv[1]
# Wall-clock watchdogs bound CPU/test hangs, not virtual radio deadlines.
# Shared Intel runners take longer to generate and decode the full fixture.
PROCESS_TIMEOUT = 30
# The positive fixture uses a legal 100 ms interval; an explicit 40 ms first
# start delay reproduces the CI uncertainty that invalidated the old 30 ms
# interval. Instants and per-packet expectations stay at events 18/30/42.
for rate in (8000000, 10000000, 16000000, 20000000):
    result = subprocess.run([binary, '--decoder', 'ble', '--frequency', '2402000000',
        '--sample-rate', str(rate), '--ble-follow', '--retain-iq', '--duration-ms', '5200'],
        capture_output=True, text=True, timeout=PROCESS_TIMEOUT, env={**os.environ, 'AIRWOLF_FAKE_BLE': 'phy-update', 'AIRWOLF_FAKE_START_DELAY_MS': '40'})
    assert result.returncode == 0 and 'RETUNE_WHILE_STREAMING' not in result.stderr, result.stderr
    assert 'fake_clock=controlled' in result.stderr, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    status = [e for e in events if e['type'] == 'follow']
    packets = [e for e in events if e['type'] == 'packet' and 'connectionEvent' in e]
    diagnostic = {'rate': rate, 'status': status, 'packets': packets, 'stderr': result.stderr}
    assert status[-1]['state'] == 'stopped' and status[-1]['message'] == 'BLE following stopped', diagnostic
    assert any(e['state'] == 'acquiring' and 40000 <= e['clockUncertaintyUs'] < 45000 and e['intervalUs'] == 100000 for e in status), diagnostic
    assert {'1m', '2m', 'coded'} <= {e['phy'] for e in status}, diagnostic
    assert {'1m', '2m', 'coded-s2', 'coded-s8'} <= {e['phy'] for e in packets}, diagnostic
    assert any(e['connectionEvent'] >= 42 and e['phy'] == '1m' for e in packets), diagnostic
    for packet in packets:
        event = packet['connectionEvent']
        expected = '2m' if 18 <= event < 30 else ('coded-s2' if event % 4 < 2 else 'coded-s8') if 30 <= event < 42 else '1m'
        assert packet['phy'] == expected and packet['channel'] == ((event + 1) * 5) % 37, packet
        assert packet.get('iqToken') and packet['crcInit'] == 0xc4c181, packet
        if packet['bytes'][4] & 3 != 3:
            assert packet['bytes'][6:-3] == [event, 0x48, 0x69], packet
    for event in events:
        if event['type'] == 'spectrum':
            assert event['blePhy'] in ('1m', '2m', 'coded'), event
            assert event['centerFrequencyHz'] == event['frequencyHz'] + rate // 4, event
    print(rate, '1M -> 2M -> Coded S2/S8 -> 1M, verified event/PHY and retained IQ passed')

for mode, reason in [('phy-asymmetric', 'asymmetric'), ('phy-reserved', 'reserved'), ('phy-past', 'instant')]:
    result = subprocess.run([binary, '--decoder', 'ble', '--frequency', '2402000000',
        '--sample-rate', '20000000', '--ble-follow', '--duration-ms', '900'],
        capture_output=True, text=True, timeout=PROCESS_TIMEOUT, env={**os.environ, 'AIRWOLF_FAKE_BLE': mode})
    assert result.returncode == 0, result.stderr
    status = [e for line in result.stdout.splitlines() if (e := json.loads(line))['type'] == 'follow']
    assert status[-1]['state'] == 'stopped' and reason in status[-1]['message'], status
    assert all(e['phy'] == '1m' for e in status), status
    print(mode, 'stops without guessing a new PHY')

# A frame decoded after the PHY switch must retain samples from that actual
# epoch. Replay the saved interval through the real native IQ worker.
if len(sys.argv) > 2:
    for desired in ('2m', 'coded-s8'):
        with tempfile.TemporaryDirectory(prefix='airwolf-phy-follow-') as directory:
            destination = Path(directory) / 'selected.iq'
            process = subprocess.Popen([binary, '--decoder', 'ble', '--frequency', '2402000000',
                '--sample-rate', '20000000', '--ble-follow', '--retain-iq', '--duration-ms', '6000'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                env={**os.environ, 'AIRWOLF_FAKE_BLE': 'phy-update', 'AIRWOLF_FAKE_START_DELAY_MS': '40'})
            guard = threading.Timer(PROCESS_TIMEOUT, process.kill); guard.start()
            try:
                selected = None
                for line in process.stdout:
                    event = json.loads(line)
                    if event['type'] == 'packet' and event.get('phy') == desired and 'connectionEvent' in event:
                        selected = event; break
                assert selected, desired
                process.stdin.write(f"pause\niq-snapshot 1 {selected['iqToken']} {str(destination).encode().hex()}\n")
                process.stdin.flush()
                reply = None; retained = False
                for line in process.stdout:
                    event = json.loads(line)
                    if event['type'] == 'iq-snapshot': reply = event
                    if event['type'] == 'iq-retained': retained = True
                    if reply and retained: break
                assert reply and not reply['error'], reply
                process.stdin.write('stop\n'); process.stdin.flush(); process.communicate(timeout=PROCESS_TIMEOUT)
                assert process.returncode == 0
                phy = 'coded' if desired.startswith('coded') else desired
                frequency = selected['frequencyHz']
                replay = subprocess.run([sys.argv[2], 'decode', str(destination), '0',
                    str(reply['endSample'] - reply['firstSample']), 'ble', '20000000', str(frequency),
                    str(frequency + 5000000), phy, str(0xaa08192b), str(0xc4c181)],
                    capture_output=True, text=True, timeout=PROCESS_TIMEOUT, check=True)
                matches = [p for p in json.loads(replay.stdout)['packets'] if p['bytes'] == selected['bytes']]
                assert len(matches) == 1 and matches[0]['phy'] == desired and matches[0]['integrity'] == 'valid', replay.stdout
                assert abs(matches[0]['firstSample'] + reply['firstSample'] - selected['firstSample']) <= 20, (matches, selected)
            finally:
                guard.cancel()
                if process.poll() is None: process.kill(); process.wait()
        print(desired, 'post-switch retained IQ replays exact bytes with verified CRC and PHY')
