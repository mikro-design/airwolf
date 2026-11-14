# SPDX-License-Identifier: AGPL-3.0-or-later
"""Public recorded HackRF IQ, independent of the production TX/RX library."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly

fixtures = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'lte-cell-scanner'
# Decode correctness is independent of the CI runner's CPU allocation. A value
# of 1 explicitly exercises real-time throughput; default 3 gives acquisition
# headroom without changing IQ, sample indices, radio sample rate or drop checks.
wall_scale = sys.argv[2] if len(sys.argv) > 2 else '3'
with tempfile.TemporaryDirectory(prefix='airwolf-recorded-lte-') as tmp:
    output = Path(tmp) / 'capture.iq'
    for case in json.loads((fixtures / 'sources.json').read_text()):
        raw = (fixtures / case['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == case['sha256']
        v = np.frombuffer(raw, np.int8).astype(np.float32)
        x = v[::2] + 1j*v[1::2]
        for rate in (8000000, 10000000, 16000000, 20000000):
            divisor = np.gcd(rate, 1920000)
            y = resample_poly(x, rate//divisor, 1920000//divisor)
            data = np.empty(len(y)*2, np.int8)
            data[::2] = np.clip(np.rint(y.real), -127, 127)
            data[1::2] = np.clip(np.rint(y.imag), -127, 127)
            data.tofile(output)
            run = subprocess.run([sys.argv[1], str(rate), str(output), wall_scale],
                                 capture_output=True, text=True, timeout=20)
            frames = [json.loads(line) for line in run.stdout.splitlines()]
            assert run.returncode == 0 and len(frames) >= case['minimum_mibs'], (case['file'], rate, run.stderr[-1000:])
            for f in frames:
                assert f['pci'] in case['pci'] and f['prb'] == 100 and f['ports'] == 2, f
                assert f['tdd'] == case['tdd'], f
                word = int(f['mib'], 16)
                assert word >> 21 == 5 and word & 1023 == 0, f  # 100 PRB; spare bits zero
                assert 0 <= f['sfn'] < 1024, f
                assert 0 <= f['firstSample'] < f['endSample'] <= len(y), f
            print(f"{case['file']}, {rate/1e6:g} MS/s: {len(frames)} CRC-verified MIBs", flush=True)
