"""Real channel-chain regression for short enhanced MAC PSDUs, without hardware.

The O-QPSK generator constructs the IEEE chip code independently of the C++
decoder's lookup table. Byte equality, including a deliberately bad FCS, must
survive the native filter, acquisition and packet emitter at all offered rates.
"""
import pathlib
import json
import subprocess
import sys
import tempfile

import numpy as np
import gen


def verify(feed, replay):
    rng = np.random.default_rng(731)
    ack = gen.wpan_frame(bytes.fromhex('0221'))  # Enhanced ACK, sequence suppressed.
    assert len(ack) == 4
    bad = ack[:-1] + bytes([ack[-1] ^ 1])
    frames = [ack, bad,
              gen.wpan_frame(bytes.fromhex('02210100')),  # Same ACK + payload bytes.
              gen.wpan_frame(bytes.fromhex('01233412003f00f8'))]
    for rate in (8000000, 10000000, 16000000, 20000000):
        for cfo in (-200000, 0, 200000):
            expected = frames * 3
            parts = [gen.oqpsk(frame, rate, 300 + rng.uniform(0, rate / 2e6))
                     for frame in expected]
            iq = gen.to_radio(np.concatenate(parts), rate, cfo, 30, 0, 15, rng)
            with tempfile.TemporaryDirectory() as tmp:
                path = pathlib.Path(tmp) / 'wpan.iq'
                iq.tofile(path)
                result = subprocess.run([feed, '15p4', '15', str(rate), '1m',
                                         '8e89bed6', '555555', str(path)],
                                        check=True, capture_output=True, text=True, timeout=20)
                for protocol in ('15p4', 'zigbee'):
                    decoded = json.loads(subprocess.check_output([
                        replay, 'decode', str(path), '0', str(len(iq) // 2), protocol,
                        str(rate), '2425000000', str(2425000000 + rate // 4),
                        '1m', str(0x8e89bed6), str(0x555555)], text=True, timeout=20))
                    assert [bytes(p['bytes']) for p in decoded['packets']] == expected
                    assert [p['integrity'] for p in decoded['packets']] == ['valid', 'invalid', 'valid', 'valid'] * 3
            actual = [bytes.fromhex(line.split()[3]) for line in result.stdout.splitlines()]
            assert actual == expected, (rate, cfo, [f.hex() for f in actual])
    print('144 WPAN short/enhanced/corrupt PSDUs recovered exactly; 288 production IQ replays preserve bytes and CRC at four rates and ±200 kHz')


if __name__ == '__main__':
    verify(sys.argv[1], sys.argv[2])
