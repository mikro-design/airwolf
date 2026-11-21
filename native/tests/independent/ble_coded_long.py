"""LE Coded: long frames, clock error and carrier offset.

Each regression failed on the previous receiver:
- a match of the access-address correlator inside a long payload ended the
  frame being decoded (55/60 251-byte S=8 frames);
- symbol timing was fixed at sync, so a 251-byte S=8 frame (~17 ms) slipped a
  symbol at 150 ppm (2-4/40);
- the address prefilter decided bits against zero, so a large carrier offset
  lost S=2 frames (0.8 at 250 kHz).
"""
import os, subprocess, sys, tempfile
import numpy as np
import gen
from coded import coded_bits
import coded

feed = sys.argv[1]
coded.FEED = feed
rate = 8e6


def run(S, ppm, npk, seed, longest):
    rng = np.random.default_rng(seed)
    parts, expected = [], []
    for _ in range(npk):
        size = int(rng.integers(longest // 2, longest + 1))
        pdu = bytes([2, size]) + bytes(rng.integers(0, 256, size, dtype=np.uint8))
        bits, packet = coded_bits(pdu, 16, 0xaa08192b, 0xc4c181, S)
        parts.append(gen.gfsk(bits, rate, 1e6 * (1 + ppm * 1e-6), 300 + rng.uniform(0, rate / 1e6)))
        expected.append(packet)
    with tempfile.TemporaryDirectory() as temp:
        name = os.path.join(temp, 'input.iq')
        gen.to_radio(np.concatenate(parts), rate, 0, 30, 0, 10, rng).tofile(name)
        out = subprocess.run([feed, 'ble', '16', str(int(rate)), 'coded', 'aa08192b', 'c4c181', name],
                             capture_output=True, text=True, check=True, timeout=300)
    got = [bytes.fromhex(line.split()[3]) for line in out.stdout.splitlines()]
    return sum(packet in got for packet in expected), len(got)


found, shown = run(8, 0, 60, 11, 251)
assert found == 60 and shown == 60, ('long S=8 frames', found, shown)
for ppm in (-150, 150):
    found, shown = run(8, ppm, 40, 12, 251)
    assert found == 40, ('S=8 clock error', ppm, found, shown)
found, _ = run(2, 250, 40, 12, 251)
assert found == 40, ('S=2 clock error', found)
for cfo in (-250000, 250000):
    success = coded.run(rate, 2, None, cfo=cfo, npk=30, seed=4)
    assert success == 1, ('S=2 carrier offset', cfo, success)
print('LE Coded: 60/60 long S=8 frames, 251-byte frames at +-150 ppm (S=8) and 250 ppm (S=2), '
      'S=2 at +-250 kHz carrier offset')
