# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reproduce the narrowband test fixtures from pinned public HackRF recordings."""
import hashlib
import json
from pathlib import Path
import urllib.request
import numpy as np
from scipy.signal import resample_poly

root = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'lte-cell-scanner'
for case in json.loads((root / 'sources.json').read_text()):
    original = urllib.request.urlopen(case['source_url'], timeout=60).read()
    assert hashlib.sha256(original).hexdigest() == case['source_sha256']
    v = np.frombuffer(original, np.int8).astype(np.float32)
    x = resample_poly(v[::2] + 1j*v[1::2], 1, 10)
    x *= 100 / np.max(np.abs(x))
    result = np.empty(len(x)*2, np.int8)
    result[::2] = np.rint(x.real)
    result[1::2] = np.rint(x.imag)
    data = result.tobytes()
    assert hashlib.sha256(data).hexdigest() == case['sha256'], 'Use the NumPy/SciPy versions in sources.json for exact reproduction'
    (root / case['file']).write_bytes(data)
    print(case['file'])
