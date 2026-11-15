"""Synthetic PCCH IQ for the desktop gate; never accesses radio hardware.

PCCH/SIB1 bits are assembled independently from ASN.1. The PHY waveform uses
the pinned srsRAN TX, so this is integration coverage, not a PHY oracle.
"""
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
from scipy.signal import resample_poly

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'native/lte/tests'))
from paging_vectors import STMSI, sib1

directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
(directory / 'sib1.bin').write_bytes(sib1(False))
(directory / 'paging.bin').write_bytes(STMSI)
subprocess.run([
    sys.argv[2], str(directory / 'paging.cf32'), '25', '42', '2', '640',
    'paging', '0', '0', '3', str(directory / 'sib1.bin'), str(directory / 'paging.bin'),
], check=True, capture_output=True)
signal = resample_poly(np.fromfile(directory / 'paging.cf32', np.complex64), 25, 18)
signal *= 20 / np.sqrt(np.mean(abs(signal) ** 2))
signal *= np.exp(2j * np.pi * 18000 * np.arange(len(signal)) / 8000000)
signal += 2 - 1j
np.clip(np.rint(np.column_stack((signal.real, signal.imag))), -127, 127).astype(np.int8).tofile(directory / 'paging.iq')
print(json.dumps({'prefix': STMSI.hex(), 'sampleRate': 8000000}))
