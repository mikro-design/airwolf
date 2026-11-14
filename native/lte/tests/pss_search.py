"""Check the independent search instrument with external recorded FDD/TDD IQ."""
import sys
from pathlib import Path
import numpy as np
from scipy.signal import resample_poly

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'tests'))
from lte_pss_search import search

rate = 8000000
for name, nid in [('fdd-1860.ci8', 2), ('tdd-2585.ci8', 0)]:
    raw = np.fromfile(root / 'tests/fixtures/lte-cell-scanner' / name, np.int8).reshape(-1, 2)
    a = raw[384000:403200].astype(float)
    x = resample_poly(a[:, 0] + 1j * a[:, 1], 25, 6)
    original = search(x, rate, range(-50000, 50001, 5000))[0]
    assert original['nid2'] == nid and original['score'] > .2, original
    for offset in (-1225000, 1225000):
        shifted = x * np.exp(2j * np.pi * offset * np.arange(len(x)) / rate)
        found = search(shifted, rate, range(offset-50000, offset+50001, 5000))[0]
        assert found['nid2'] == nid and found['offsetHz'] == original['offsetHz'] + offset, found
        assert abs(found['score'] - original['score']) < 1e-6, (found, original)
        assert found['sample1920k'] == original['sample1920k']
    print(name, 'PSS identity and positive/negative frequency translation passed')
rng = np.random.default_rng(8521)
noise = rng.normal(size=80000) + 1j * rng.normal(size=80000)
assert search(noise, rate, range(-3000000, 3000001, 5000))[0]['score'] < .12
print('Noise has no comparable repeated PSS correlation; this is not a PBCH test')
