"""Native simulated-load acceptance check; requires no radio and is not a USB benchmark."""
import json
import subprocess
import sys
import tempfile
import time

binary = sys.argv[1]
args = [binary, '--simulate', '--sample-rate', '20000000', '--duration-ms', '2000']
with tempfile.TemporaryFile(mode='w+b') as output:
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.PIPE)
    process.wait(timeout=10)
    errors = process.stderr.read().decode()
    process.stdin.close()
    assert process.returncode == 0, errors
    output.seek(0)
    events = [json.loads(line) for line in output]
    assert 20 <= len(events) <= 32, len(events)
    assert all(e['synthetic'] and len(e['bins']) == 2048 for e in events)
    assert all(e['queueDroppedSamples'] == 0 for e in events), errors
    assert events[-1]['samples'] > 35_000_000, events[-1]['samples']
    assert all(e['bins'].index(max(e['bins'])) == 1152 for e in events)
    assert all(e['endSample'] - e['firstSample'] == 2048 for e in events)
    print(f"20 MS/s simulated input: {len(events)} spectrum events; {errors.strip()}")

# Withhold stdout reads until it fills. Acquisition should continue independently.
process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(2.3)
output, errors = process.communicate(timeout=10)
assert process.returncode == 0, errors
assert b'queue_dropped_samples=0' in errors, errors
assert int(errors.split(b'delivered_samples=')[1].split()[0]) > 35_000_000, errors
print('Stalled IPC reader: native acquisition continued, then drained and stopped.')
# EOF is the portable stop command (no shell and no OS-specific signal required).
process = subprocess.Popen([binary, '--simulate'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
_, errors = process.communicate(timeout=5)
assert process.returncode == 0, errors
print('Control pipe EOF: receiver stopped.')
invalid = subprocess.run([binary, '--frequency', '-1'], capture_output=True, timeout=5)
assert invalid.returncode != 0 and b'unsigned' in invalid.stderr
print('Invalid native arguments rejected before device access.')

# Connection configuration must never silently fall back to advertising CRCs.
for options in [
    ['--frequency', '2404000000'],
    ['--frequency', '2404000000', '--ble-access-address', '2852657451'],
    ['--frequency', '2404000000', '--ble-access-address', '2391391958', '--ble-crc-init', '0'],
    ['--frequency', '2402000000', '--ble-access-address', '2852657451', '--ble-crc-init', '12894593'],
    ['--frequency', '2404000000', '--ble-access-address', '2852657451', '--ble-crc-init', '16777216'],
]:
    result = subprocess.run([binary, '--simulate', '--decoder', 'ble', *options], capture_output=True, timeout=5)
    assert result.returncode != 0, options
for frequency in [2404000000, 2424000000, 2428000000, 2478000000]:
    result = subprocess.run([binary, '--simulate', '--decoder', 'ble', '--frequency', str(frequency), '--ble-access-address', str(0xaa08192b), '--ble-crc-init', str(0xc4c181)], capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
print('BLE data-channel CLI configuration and missing/invalid connection context checked.')
for phy in ['2m', 'coded']:
    options = [binary, '--simulate', '--decoder', 'ble', '--frequency', '2438000000', '--ble-access-address', str(0xaa08192b), '--ble-crc-init', str(0xc4c181), '--ble-phy', phy, '--sample-rate', '20000000', '--duration-ms', '1000']
    process = subprocess.Popen(options, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    process.wait(timeout=5)
    errors = process.stderr.read()
    process.stdin.close()
    assert process.returncode == 0 and b'queue_dropped_samples=0' in errors, errors
    assert int(errors.split(b'delivered_samples=')[1].split()[0]) > 18_000_000, errors
    print(f'BLE {phy} decoder enabled: 20 MS/s simulated throughput without host queue drops.')
