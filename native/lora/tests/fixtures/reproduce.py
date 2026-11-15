# SPDX-License-Identifier: GPL-3.0-or-later
"""Reproduce the public HackRF crop; supply the original .cfile as argv[1]."""
import hashlib
import pathlib
import sys
import numpy as np
original = pathlib.Path(sys.argv[1])
expected = '020958423471a9bc680d6a8fdf4d470fe6b09b0071faa84abb66aacedd5e21c0'
assert hashlib.sha256(original.read_bytes()).hexdigest() == expected
first, end = 9444700, 9856140
with original.open('rb') as source:
    source.seek(first * 8)
    samples = np.frombuffer(source.read((end-first)*8), dtype='<c8')
# Original RF +2.1 MHz -> wanted -2.5 MHz at 10 MS/s. No demodulation,
# packet replacement, denoising, amplitude normalization or channel filtering.
phase = np.exp(-2j*np.pi*23*np.arange(50)/50).astype(np.complex64)
samples = samples * phase[(first + np.arange(len(samples))) % 50]
raw = np.clip(np.round(samples.view(np.float32)*127), -128, 127).astype(np.int8)
output = pathlib.Path(__file__).with_name('hackrf-zero4.ci8')
output.write_bytes(raw.tobytes())
print(hashlib.sha256(output.read_bytes()).hexdigest())
