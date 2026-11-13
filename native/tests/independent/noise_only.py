"""Quantized AWGN through the real receiver: no transmitted preamble or packet."""
import os
import subprocess
import tempfile
import numpy as np


def verify_noise_only(feed, seconds=4):
    rng = np.random.default_rng(99173)
    for rate in (8000000, 20000000):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'noise.iq')
            # Bounded generation memory; all PHYs see exactly the same noise.
            with open(path, 'wb') as output:
                remaining = 2 * rate * seconds
                while remaining:
                    count = min(remaining, 262144)
                    values = np.clip(np.rint(rng.normal(0, 30, count)), -128, 127).astype(np.int8)
                    output.write(values.tobytes())
                    remaining -= count
            for protocol, phy, channel, address, crc in (
                ('ble', '1m', 37, '8e89bed6', '555555'),
                ('ble', '2m', 16, 'aa08192b', 'c4c181'),
                ('ble', 'coded', 16, 'aa08192b', 'c4c181'),
                ('15p4', '1m', 15, '8e89bed6', '555555'),
            ):
                result = subprocess.run([feed, protocol, str(channel), str(rate), phy, address, crc, path],
                                        capture_output=True, text=True, check=True, timeout=60)
                assert not result.stdout.strip(), (rate, protocol, phy, result.stdout[:2000])
                assert result.stderr.startswith('cand=0 crcfail=0 '), (rate, protocol, phy, result.stderr)
                print(f'{rate/1e6:g} MS/s {protocol}/{phy}: {seconds}s noise, zero frames/candidates.', flush=True)
