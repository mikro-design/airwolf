"""Exact native IQ slicing, digest, range checks and plot-summary oracle."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np

binary = sys.argv[1]
with tempfile.TemporaryDirectory(prefix='airwolf-iq-') as directory:
    root = Path(directory)
    source = root / 'recording with spaces.iq'
    rng = np.random.default_rng(184)
    data = rng.integers(-128, 128, (20000, 2), dtype=np.int8)
    source.write_bytes(data.tobytes())
    first, count, columns = 37, 8109, 64
    run = subprocess.run([binary, 'overview', str(source), str(first), str(count), str(columns)], check=True, capture_output=True, text=True)
    view = json.loads(run.stdout)
    assert (view['firstSample'], view['sampleCount'], view['totalSamples']) == (first, count, len(data))
    selected = data[first:first+count].astype(float)/128
    indices = np.arange(count)*columns//count
    for column, values in enumerate(view['envelope']):
        x = selected[indices == column]
        power = (x*x).sum(axis=1)
        expected = [x[:, 0].min(), x[:, 0].max(), x[:, 1].min(), x[:, 1].max(), power.mean(), power.max(), len(x), np.count_nonzero(np.any((x == -1) | (x == 127/128), axis=1))]
        assert np.allclose(values, expected, rtol=1e-6, atol=1e-7), column
    assert sum(view['spectrumWindows']) == 1+(count-2048)//1024
    assert len(view['spectrum']) == view['timeColumns']*128
    for at, length in [(0, 1), (37, 8109), (19999, 1), (0, 20000)]:
        target = root / f'selected-{at}-{length}.sigmf-data'
        result = json.loads(subprocess.check_output([binary, 'slice', str(source), str(at), str(length), str(target)], text=True))
        expected = data[at:at+length].tobytes()
        assert target.read_bytes() == expected
        assert result == {'samples': length, 'byteLength': len(expected), 'sha512': hashlib.sha512(expected).hexdigest()}
        # Never overwrite an existing destination, including the input itself.
        rejected = subprocess.run([binary, 'slice', str(source), '0', '1', str(target)], capture_output=True)
        assert rejected.returncode and target.read_bytes() == expected
    original = source.read_bytes()
    assert subprocess.run([binary, 'slice', str(source), '0', '10', str(source)], capture_output=True).returncode
    assert source.read_bytes() == original
    for at, length in [('-1', '20'), ('0', '0'), ('19999', '2'), ('20000', '1'), ('18446744073709551615', '2')]:
        target = root / 'invalid.iq'
        assert subprocess.run([binary, 'slice', str(source), at, length, str(target)], capture_output=True).returncode
        assert not target.exists()
    source.write_bytes(b'odd')
    assert subprocess.run([binary, 'overview', str(source), '0', '1', '64'], capture_output=True).returncode
    n = np.arange(8192)
    tone = np.column_stack((np.round(64*np.cos(2*np.pi*256*n/2048)), np.round(64*np.sin(2*np.pi*256*n/2048)))).astype(np.int8)
    source.write_bytes(tone.tobytes())
    view = json.loads(subprocess.check_output([binary, 'overview', str(source), '0', '8192', '16'], text=True))
    for count, spectrum in zip(view['spectrumWindows'], np.array(view['spectrum']).reshape(-1, 128)):
        if count:
            assert np.argmax(spectrum) == 80
            assert abs(spectrum[80]+6.0206) < .1
print('Native IQ exact slices, SHA-512, safe bounds/overwrite handling, envelopes and spectrum passed.')
