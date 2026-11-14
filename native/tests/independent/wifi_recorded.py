"""Third-party captured IQ: no production or local transmitter helpers."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zlib
import numpy as np

fixtures = Path(__file__).resolve().parents[1] / 'fixtures' / 'openofdm'
total = 0
with tempfile.TemporaryDirectory(prefix='airwolf-recorded-wifi-') as tmp:
    iq = Path(tmp) / 'capture.iq'
    for case in json.loads((fixtures / 'sources.json').read_text()):
        source = (fixtures / case['file']).read_bytes()
        assert hashlib.sha256(source).hexdigest() == case['sha256'], case['file']
        values = np.frombuffer(source, dtype='<i2').astype(np.float64)
        # Fixed per-file gain, preserving I/Q order and all sample positions.
        # The original captures are signed 16-bit; HackRF input is signed 8-bit.
        np.rint(values * (100 / np.max(np.abs(values)))).astype(np.int8).tofile(iq)
        run = subprocess.run([sys.argv[1], str(iq)], check=True,
                             capture_output=True, text=True, timeout=20)
        rows = [line.split() for line in run.stdout.splitlines()]
        assert [int(row[2]) for row in rows] == case['expected_rates'], (case['file'], run.stderr)
        payloads = []
        for first, end, rate, valid, hex_bytes in rows:
            payload = bytes.fromhex(hex_bytes)
            assert valid == '1', case['file']
            assert int.from_bytes(payload[-4:], 'little') == zlib.crc32(payload[:-4]), case['file']
            assert 0 <= int(first) < int(end) <= len(values) // 2, case['file']
            payloads.append(payload)
        assert hashlib.sha256(b''.join(payloads)).hexdigest() == case['psdu_sha256'], case['file']
        total += len(rows)
        print(f"{case['file']}: {len(rows)} CRC-valid packets")
print(f'{total} packets recovered from seven external recorded-IQ fixtures')
