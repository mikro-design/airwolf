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

def args(rate=20000000, phy='1m', duration=450):
    return [binary, '--decoder', 'ble', '--frequency', '2402000000', '--sample-rate', str(rate),
            '--ble-phy', phy, '--ble-aux-follow', '--retain-iq', '--duration-ms', str(duration)]

def run(mode, rate=20000000, phy='1m', duration=450):
    result = subprocess.run(args(rate, phy, duration), capture_output=True, text=True, timeout=8,
                            env={**os.environ, 'AIRWOLF_FAKE_AUX': mode})
    assert result.returncode == 0 and 'RETUNE_WHILE_STREAMING' not in result.stderr, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    status = [event for event in events if event['type'] == 'aux-follow']
    packets = [event for event in events if event['type'] == 'packet']
    assert status and status[-1]['state'] == 'stopped', status
    for event in (e for e in events if e['type'] == 'spectrum'):
        assert event['centerFrequencyHz'] == event['frequencyHz'] + rate // 4, event
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
    assert [packet['bleAuxType'] for packet in followed] == ['aux-adv', 'aux-chain'], (rate, status, packets, errors)
    assert [packet['phy'] for packet in followed] == ['2m', 'coded-s8'], followed
    assert [packet['channel'] for packet in followed] == [16, 17], followed
    assert len({packet['captureEpoch'] for packet in followed}) == 2, followed
    assert status[-1]['verifiedPackets'] == 2 and status[-1]['retunes'] >= 3, status
    assert all(packet['crcInit'] == 0x555555 and packet['timeUncertaintyUs'] <= 100000 and packet.get('iqToken', 0) > 0 for packet in followed), followed
    assert any(packet['channel'] == 37 and packet['time'] > followed[-1]['time'] for packet in packets), packets
    if decoder:
        inspect([packet for packet in packets if packet['time'] <= followed[-1]['time']])
    print(rate, 'primary 1M → AUX_ADV 2M → AUX_CHAIN Coded S8; native context and primary return passed')

status, packets, errors = run('coded-primary', phy='coded')
assert status[-1]['verifiedPackets'] == 2, (status, packets, errors)
assert any(packet['channel'] == 37 and packet['phy'] == 'coded-s8' for packet in packets), packets
print('Coded primary pointer → 2M auxiliary → Coded chain passed')

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
status, packets, errors = run('clock-refresh', duration=650)
assert status[-1]['verifiedPackets'] == 2 and status[-1]['retunes'] >= 4, (status, packets, errors)
assert any('refreshing the receiver clock' in event['message'] for event in status), status
print('Verified pointer with uncertain timing requests one refresh; later pointer and chain recover')

# CLI exclusivity must fail before the device is opened.
for extra in (['--ble-follow'], ['--simulate'], ['--record-iq', 'unused.iq', '--record-samples', '10']):
    result = subprocess.run(args() + extra, capture_output=True, text=True, timeout=5)
    assert result.returncode and 'opened_serial=' not in result.stderr, result.stderr

# Per-packet samples survive retuning and USB release; this uses a generated tail.
with tempfile.TemporaryDirectory(prefix='airwolf-aux-iq-') as directory:
    destination = Path(directory) / 'aux tail.iq'
    process = subprocess.Popen(args(duration=3000), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
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
