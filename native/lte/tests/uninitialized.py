"""LTE decoding must not depend on what newly allocated memory holds.
srsRAN reads part of the MIB synchronizer's receive buffer before writing it.
With recycled heap memory (Windows) the same IQ gave 92 or 97 FDD MIBs and 30
or 7 TDD MIBs from run to run. glibc's MALLOC_PERTURB_ fills every allocation
with a fixed byte; 186 gives 0x45, which reproduced both outcomes before
bridge.c cleared that buffer. Decoding must match the unperturbed result.
"""
import json, os, pathlib, subprocess, sys, tempfile
import numpy as np
from scipy.signal import resample_poly
ROOT = pathlib.Path(__file__).resolve().parents[3]
radio = sys.argv[1]
sources = ROOT / 'native/tests/fixtures/lte-cell-scanner'
with tempfile.TemporaryDirectory(prefix='airwolf-lte-uninit-') as tmp:
    file = pathlib.Path(tmp) / 'samples.ci16'
    for case in json.loads((sources / 'sources.json').read_text()):
        raw = np.fromfile(sources / case['file'], np.int8).astype(np.float32)
        wave = resample_poly(raw[::2] + 1j * raw[1::2], 25, 6)
        codes = np.empty(len(wave) * 2, dtype='<i2')
        codes[::2] = np.clip(np.rint(wave.real * 16), -2048, 2047)
        codes[1::2] = np.clip(np.rint(wave.imag * 16), -2048, 2047)
        codes.tofile(file)
        def decode(perturb):
            env = dict(os.environ)
            env.pop('MALLOC_PERTURB_', None)
            if perturb is not None:
                env['MALLOC_PERTURB_'] = str(perturb)
            p = subprocess.run([radio, 'decode', str(file), '0', str(len(wave)), 'lte', '8000000', '1860000000',
                                '1860000000', '1m', str(0x8e89bed6), str(0x555555), '--iq-format', 'ci16_le', '12'],
                               capture_output=True, text=True, timeout=120, env=env)
            assert p.returncode == 0, p.stderr
            return [{k: v for k, v in x.items() if k != 'time'} for x in json.loads(p.stdout)['packets']]
        plain = decode(None)
        assert len(plain) >= case['minimum_mibs'], (case['file'], len(plain))
        for perturb in (186, 58):
            got = decode(perturb)
            assert got == plain, (case['file'], perturb, len(got), len(plain))
        print(case['file'], len(plain), 'packets, identical with filled allocations', flush=True)
