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
if protocol not in ('wifi','lte','ble','zigbee','15p4','enocean','enocean2'):
    parser.error('This take was recorded without a supported packet receiver')
if protocol == 'wifi':
    assert rate == 20000000
command = [binary('bin/airwolf-lte-radio' if protocol == 'lte' else 'bin/airwolf-iq'),
           'decode', str(file), '0', str(file.stat().st_size//2), protocol, str(rate),
           str(frequency), str(expected_lo), config.get('blePhy','1m'),
           str(config.get('bleAccessAddress',0x8e89bed6)), str(config.get('bleCrcInit',0x555555))]
context = config.get('lteContext') if protocol == 'lte' else None
if context is not None:
    # These hints carry no payload/SFN and are validated by the native CLI.
    command += [str(context['pci']), str(context['prb']), str(context['ports']),
                str(int(context['tdd'])), str(int(context['extendedCp'])),
                str(int(context['phichExtended'])), str(context['phichResources']), str(context['cfoHz'])]
run = subprocess.run(command, capture_output=True, text=True, timeout=120)
print(run.stdout, end='')
print(run.stderr, end='', file=sys.stderr)
assert run.returncode == 0, 'Native replay failed'
observed = [bytes(p['bytes']).hex() for p in json.loads(run.stdout)['packets']]
for expected in args.expect_hex:
    assert bytes.fromhex(expected).hex() in observed, 'Expected packet was not recovered from IQ'
print(f'SHA-512 verified; {len(observed)} packet(s) recovered; {len(args.expect_hex)} explicit expected-byte checks.', file=sys.stderr)
