"""Core 6.1 Figure 2.10/11 decision advertising through real native DSP.
Independent literal packet bytes/CRC/whitening/modulation; no receiver imports.
"""
import subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import gen
from coded import coded_bits

def verify(feed):
    rng = np.random.default_rng(902619); count = 0
    with tempfile.TemporaryDirectory() as temporary:
        filename = str(Path(temporary) / 'decision.iq')
        for rate in (8000000, 10000000, 16000000, 20000000):
            for channel in (37, 38, 39):
                for phy, spread in [('1m', 0), ('coded', 2), ('coded', 8)]:
                    bodies = [bytes([0, 0x10, 16, 100, 0x20]),
                        bytes([1, 0x19, 1, 2, 3, 4, 5, 6, 0x34, 0x12, 16, 100, 0x20,
                               0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x41, 0x42])]
                    expected, waves = [], []
                    for body in bodies:
                        pdu = bytes([9, len(body)]) + body
                        if spread: bits, raw = coded_bits(pdu, channel, 0x8e89bed6, 0x555555, spread)
                        else: bits, raw = gen.ble_air_bits(pdu, channel, 0x8e89bed6, 0x555555, phy)
                        waves.append(gen.gfsk(bits, rate, 1e6, 300 + rng.uniform(0, rate / 1e6)))
                        expected.append(raw.hex())
                    gen.to_radio(np.concatenate(waves), rate, 150000, 30, 1, 10, rng).tofile(filename)
                    result = subprocess.run([feed, 'ble', str(channel), str(rate), phy, '8e89bed6', '555555', filename],
                        capture_output=True, text=True, timeout=20, check=True)
                    got = [line.split()[3] for line in result.stdout.splitlines()]
                    assert got == expected, (rate, channel, phy, spread, got, result.stderr)
                    count += len(expected)
    print(f'{count} independent ADV_DECISION_IND packets, all primary channels/rates/1M/S2/S8, exactly recovered')
if __name__ == '__main__': verify(sys.argv[1])
