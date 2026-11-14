"""Replay an Airwolf SigMF selection through the production native PHY, without RF.

Observed annotations are not an independent oracle. Pass --expect-hex explicitly
only after reviewing the expected bytes with an independent source/decoder.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('metadata', type=Path)
parser.add_argument('--build', type=Path, default=Path(__file__).resolve().parents[1]/'build')
parser.add_argument('--expect-hex', action='append', default=[])
args = parser.parse_args()
meta = json.loads(args.metadata.read_text())
global_ = meta['global']
assert global_['core:datatype'] == 'ci8' and global_.get('core:num_channels', 1) == 1
assert len(meta['captures']) == 1 and meta['captures'][0]['core:sample_start'] == 0
assert not global_.get('core:offset', 0) and not global_.get('core:trailing_bytes', 0)
assert not meta['captures'][0].get('core:header_bytes', 0)
name = global_.get('core:dataset', args.metadata.name.removesuffix('.sigmf-meta')+'.sigmf-data')
assert '/' not in name and '\\' not in name and '..' not in name
file = args.metadata.parent/name
with file.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha512').hexdigest()
assert digest == global_['core:sha512'], 'IQ digest mismatch'
assert file.stat().st_size % 2 == 0 and file.stat().st_size <= 268435456, 'Replay a selected take of at most 256 MiB'
config = global_.get('airwolf:source', {}).get('config')
if not config:
    parser.error('This file has no Airwolf receiver context; use the native feed tool with explicit settings')
rate = int(global_['core:sample_rate'])
assert rate in (8000000, 10000000, 16000000, 20000000)
protocol = config.get('decoder', 'none')
frequency = round(config['frequency']*1e6)
expected_lo = frequency + (0 if protocol in ('none','wifi','lte') else rate//4)
assert meta['captures'][0]['core:frequency'] == expected_lo, 'Capture LO does not match native channelizer settings'
def binary(name):
    return str(args.build/(name+('.exe' if sys.platform == 'win32' else '')))
if protocol == 'wifi':
    assert rate == 20000000
    command = [binary('airwolf-wifi-feed'), str(file)]
elif protocol == 'lte':
    command = [binary('lte/airwolf-lte-feed'), str(rate), str(file)]
elif protocol in ('ble','zigbee','15p4','enocean','enocean2'):
    if protocol == 'ble':
        channel = {2402000000:37, 2426000000:38, 2480000000:39}.get(frequency)
        if channel is None:
            channel = (frequency-(2404000000 if frequency<2426000000 else 2406000000))//2000000
    elif protocol in ('zigbee','15p4'):
        channel = 11+(frequency-2405000000)//5000000
    else:
        channel = 0
    command = [binary('airwolf-iq-feed'),protocol,str(channel),str(rate),config.get('blePhy','1m'),
               f"{config.get('bleAccessAddress',0x8e89bed6):x}",f"{config.get('bleCrcInit',0x555555):x}",str(file)]
else:
    parser.error('This take was recorded without a supported packet receiver')
run = subprocess.run(command, capture_output=True, text=True, timeout=120)
print(run.stdout, end='')
print(run.stderr, end='', file=sys.stderr)
assert run.returncode == 0, 'Native replay failed or LTE found no MIB'
observed = [json.loads(line)['mib'] if protocol == 'lte' else line.split()[-1]
            for line in run.stdout.splitlines() if line.strip()]
for expected in args.expect_hex:
    assert bytes.fromhex(expected).hex() in observed, 'Expected packet was not recovered from IQ'
print(f'SHA-512 verified; {len(observed)} packet(s) recovered; {len(args.expect_hex)} explicit expected-byte checks.', file=sys.stderr)
