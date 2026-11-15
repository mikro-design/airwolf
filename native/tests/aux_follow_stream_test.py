"""Production USB controller + independent generated BLE air; no hardware claim."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading

binary = sys.argv[1]
decoder = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('AIRWOLF_DECODER_PATH')

def args(rate=20000000, phy='1m', duration=1250):
    return [binary, '--decoder', 'ble', '--frequency', '2402000000', '--sample-rate', str(rate),
            '--ble-phy', phy, '--ble-aux-follow', '--retain-iq', '--duration-ms', str(duration)]

def run(mode, rate=20000000, phy='1m', duration=None):
    if duration is None:
        if mode in ('normal', 'normal-missed-first'):
            duration = 3650  # Three explicit advertising events, 1.2 s apart.
        elif mode in ('late', 'bad-crc', 'no-pointer', 'ambiguous'):
            duration = 450
        else:
            duration = 1250  # 200 ms warm-up + two legal 300 ms pointers + return.
    result = subprocess.run(args(rate, phy, duration), capture_output=True, text=True, timeout=8,
                            env={**os.environ, 'AIRWOLF_FAKE_AUX': mode})
    assert result.returncode == 0 and 'RETUNE_WHILE_STREAMING' not in result.stderr, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    status = [event for event in events if event['type'] == 'aux-follow']
    packets = [event for event in events if event['type'] == 'packet']
    assert status and status[-1]['state'] == 'stopped', status
    for event in events:
        if event['type'] == 'spectrum':
            assert event['centerFrequencyHz'] == event['frequencyHz'] + rate // 4, event
            secondary_phy = 'coded' if mode == 'coded-chain' else '2m'
            expected_phy = {2402000000: phy, 2438000000: secondary_phy, 2440000000: secondary_phy}[event['frequencyHz']]
            assert event.get('blePhy') == expected_phy, event
    return status, packets, result.stderr

def inspect(packets):
    """Feed actual receiver metadata directly through the bundled native worker."""
    capture = bytearray(struct.pack('<IHHIIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 147))
    for packet in packets:
        header = bytearray(b'AWBL' + bytes(16))
        header[4:8] = bytes((1, packet['channel'], {'1m': 1, '2m': 2, 'coded-s2': 3, 'coded-s8': 4}[packet['phy']], 5))
        struct.pack_into('<I', header, 8, packet['crcInit'])
        header[15] = {'aux-adv': 1, 'aux-chain': 2}.get(packet.get('bleAuxType'), 0)
        struct.pack_into('<I', header, 16, packet['timeUncertaintyUs'])
        data = header + bytes(packet['bytes'])
        usec = round(packet['time'] * 1000)
        capture += struct.pack('<IIII', usec // 1000000, usec % 1000000, len(data), len(data)) + data
    request = struct.pack('<II', len(capture), len(packets) - 1) + capture
    result = subprocess.run([decoder], input=request, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    decoded = json.loads(result.stdout)['result']
    def walk(fields):
        for field in fields:
            yield field
            yield from walk(field.get('children', []))
    assert decoded['integrity'] == 'valid', decoded
    names = [field for field in walk(decoded['fields']) if field.get('filter') == 'btcommon.eir_ad.entry.device_name']
    assert any(field['value'] == 'Hello' and field.get('mapped') is False for field in names), decoded
    assert not any('ambiguous' in note or 'no matching' in note for note in decoded['warnings']), decoded['warnings']

for rate in (8000000, 10000000, 16000000, 20000000):
    status, packets, errors = run('normal', rate)
    followed = [packet for packet in packets if packet.get('bleAuxType')]
    completed = [packet for packet in followed if packet['bleAuxType'] == 'aux-chain']
    assert completed, (rate, status, packets, errors)
    for index, packet in enumerate(followed):
        assert packet['phy'] == '2m', packet
        assert packet['channel'] == (16 if packet['bleAuxType'] == 'aux-adv' else 17), packet
        if packet['bleAuxType'] == 'aux-chain':
            assert index > 0 and followed[index - 1]['bleAuxType'] == 'aux-adv', followed
    assert len({packet['captureEpoch'] for packet in followed}) == len(followed), followed
    assert status[-1]['verifiedPackets'] == len(followed) and status[-1]['retunes'] >= 3, status
    assert all(packet['crcInit'] == 0x555555 and packet['timeUncertaintyUs'] <= 100000 and packet.get('iqToken', 0) > 0 for packet in followed), followed
    assert any(packet['channel'] == 37 and packet['time'] > followed[-1]['time'] for packet in packets), packets
    if decoder:
        inspect([packet for packet in packets if packet['time'] <= followed[-1]['time']])
    print(rate, 'primary 1M -> AUX_ADV 2M -> AUX_CHAIN 2M; native context and primary return passed')

status, packets, errors = run('normal-missed-first')
assert status[-1]['missedWindows'] >= 1 and status[-1]['verifiedPackets'] >= 2, (status, packets, errors)
assert any(packet.get('bleAuxType') == 'aux-chain' for packet in packets), packets
print('A missed first auxiliary window recovers on a later independent advertisement')

status, packets, errors = run('coded-primary', phy='coded')
assert status[-1]['verifiedPackets'] == 2, (status, packets, errors)
assert any(packet['channel'] == 37 and packet['phy'] == 'coded-s8' for packet in packets), packets
print('Coded primary pointer -> 2M auxiliary -> 2M chain passed')

status, packets, errors = run('coded-chain')
followed = [packet for packet in packets if packet.get('bleAuxType')]
assert [packet['phy'] for packet in followed] == ['coded-s8', 'coded-s8'], (status, packets, errors)
if decoder: inspect([packet for packet in packets if packet['time'] <= followed[-1]['time']])
print('1M primary pointer -> Coded auxiliary -> Coded chain passed')
status, packets, errors = run('chain-phy-change')
assert status[-1]['verifiedPackets'] == 1 and status[-1]['rejectedPointers'] >= 1, (status, packets, errors)
assert not any(packet.get('bleAuxType') == 'aux-chain' for packet in packets), packets
assert any('changes PHY within' in event['message'] for event in status), status
print('Invalid 2M auxiliary -> Coded chain pointer rejected; valid source retained')

for mode, phy in [('decision-primary', '1m'), ('coded-decision-primary', 'coded')]:
    status, packets, errors = run(mode, phy=phy)
    assert status[-1]['verifiedPackets'] == 2, (status, packets, errors)
    assert any(packet['channel'] == 37 and packet['bytes'][4] & 15 == 9 for packet in packets), packets
    print(mode, 'verified decision pointer -> legal auxiliary chain passed')

status, packets, errors = run('cte-chain')
cte = [packet for packet in packets if packet.get('bleAuxType') == 'aux-chain']
assert len(cte) == 1 and 'bleCteUs' not in cte[0] and 'bleCteComplete' not in cte[0], (status, packets, errors)
assert cte[0].get('iqToken') and status[-1]['verifiedPackets'] == 2 and status[-1]['rejectedPointers'] >= 1, (status, packets, errors)
assert any(packet['channel'] == 37 and packet['time'] > cte[0]['time'] for packet in packets), packets
print('Fixed-AA advertising CTE lookalike does not invent periodic IQ coverage')

for mode in ('late', 'bad-crc', 'wrong-channel', 'wrong-phy', 'wrong-adi', 'no-pointer', 'ambiguous'):
    status, packets, errors = run(mode)
    assert status[-1]['verifiedPackets'] == 0 and not any(packet.get('bleAuxType') for packet in packets), (mode, status, packets, errors)
    if mode == 'late':
        assert status[-1]['skippedLate'] >= 1 and status[-1]['retunes'] == 0, status
    elif mode in ('bad-crc', 'no-pointer', 'ambiguous'):
        assert status[-1]['retunes'] == 0, status
    else:
        assert status[-1]['missedWindows'] >= 1, status
    if mode == 'ambiguous':
        assert any('ambiguous' in event['message'] for event in status), status
    print(mode, 'did not invent an auxiliary capture')

# Idle listening must not introduce periodic stop/set/start gaps.
status, packets, errors = run('no-pointer', duration=1250)
assert status[-1]['retunes'] == 0 and errors.count('start=') == 1, (status, errors)
print('Idle primary listening has no recurrent receive gaps')
status, packets, errors = run('clock-refresh', duration=1550)
assert status[-1]['verifiedPackets'] == 2 and status[-1]['retunes'] >= 4, (status, packets, errors)
assert any('refreshing the receiver clock' in event['message'] for event in status), status
print('Verified pointer with uncertain timing requests one refresh; later pointer and chain recover')

# Fixed-tuning spectrum also carries its own configured BLE PHY.
for phy, frequency in [('1m', '2402000000'), ('2m', '2438000000'), ('coded', '2402000000')]:
    result = subprocess.run([binary, '--decoder', 'ble', '--frequency', frequency,
        '--sample-rate', '20000000', '--ble-phy', phy, '--ble-advertising', '--duration-ms', '45'],
        capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
    spectra = [event for line in result.stdout.splitlines() if (event := json.loads(line))['type'] == 'spectrum']
    assert spectra and all(event.get('blePhy') == phy for event in spectra), spectra
print('Fixed and hopping spectra retain their own frequency/PHY when status advances independently')

# CLI exclusivity must fail before the device is opened.
for extra in (['--ble-follow'], ['--simulate'], ['--record-iq', 'unused.iq', '--record-samples', '10']):
    result = subprocess.run(args() + extra, capture_output=True, text=True, timeout=5)
    assert result.returncode and 'opened_serial=' not in result.stderr, result.stderr

# Per-packet samples survive retuning and USB release; this uses a generated tail.
with tempfile.TemporaryDirectory(prefix='airwolf-aux-iq-') as directory:
    destination = Path(directory) / 'aux tail.iq'
    process = subprocess.Popen(args(duration=5000), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, env={**os.environ, 'AIRWOLF_FAKE_AUX': 'normal'})
    guard = threading.Timer(10, process.kill)
    guard.start()
    try:
        selected = None
        for line in process.stdout:
            event = json.loads(line)
            if event['type'] == 'packet' and event.get('bleAuxType') == 'aux-chain':
                selected = event
                break
        assert selected and selected.get('iqToken'), 'No retained auxiliary tail'
        process.stdin.write(f"pause\niq-snapshot 1 {selected['iqToken']} {str(destination).encode().hex()}\n")
        process.stdin.flush()
        reply = None
        retained = False
        for line in process.stdout:
            event = json.loads(line)
            if event['type'] == 'iq-retained': retained = True
            if event['type'] == 'iq-snapshot': reply = event
            if retained and reply: break
        assert reply and not reply['error'], reply
        assert reply['firstSample'] <= selected['firstSample'] < selected['endSample'] <= reply['endSample'], (reply, selected)
        assert destination.stat().st_size == 2 * (reply['endSample'] - reply['firstSample'])
        process.stdin.write('stop\n')
        process.stdin.flush()
        process.communicate(timeout=5)
        assert process.returncode == 0
    finally:
        guard.cancel()
        if process.poll() is None:
            process.kill()
            process.wait()
print('Auxiliary epoch IQ retention, pause, snapshot and shutdown passed')
