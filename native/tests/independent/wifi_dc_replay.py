"""Cold OFDM IQ clips retain the preamble without requiring receiver DC history."""
import pathlib
import subprocess
import sys
import tempfile
import numpy as np
from wifi import packet, waveform

with tempfile.TemporaryDirectory(prefix='airwolf-wifi-dc-') as directory:
    file = pathlib.Path(directory) / 'clip.iq'
    cases = 0
    for rate in [6, 9, 12, 18, 24, 36, 48, 54]:
        payload = packet(96)
        for dc in [0, 20-15j, 40+30j]:
            signal = waveform(payload, rate)
            signal *= 20 / max(abs(signal))
            signal = np.r_[signal, np.zeros(200)] + dc
            np.rint(np.column_stack((signal.real, signal.imag))).astype(np.int8).tofile(file)
            for chunk in [1, 63, 127, 509]:
                run = subprocess.run([sys.argv[1], str(file), str(chunk)], check=True,
                                     capture_output=True, text=True, timeout=10)
                rows = [row.split() for row in run.stdout.splitlines()]
                assert len(rows) == 1 and rows[0][2:] == [str(rate), '1', payload.hex()], (rate, dc, chunk, run.stderr)
                cases += 1
    print(f'{cases} cold OFDM clips: exact PSDU and CRC across rates, DC levels and chunk boundaries')
