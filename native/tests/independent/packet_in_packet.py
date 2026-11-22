"""Packet-in-packet: a complete frame carried inside another frame's payload.

Every sample-phase lane searches for a preamble, so a lane not following the
real frame could acquire the frame in its payload, finish first and displace
the real one: the sniffer then showed a frame that was never sent (802.15.4:
real 0/20, injected 20/20). Also checks the other side of the fix: a real
frame right behind a frame with a corrupt LENGTH, which the enclosing lane
swallows, must still be released, and random payloads lose nothing.
"""
import os, sys, subprocess, tempfile
import numpy as np
import gen

feed = sys.argv[1]
fs = 8000000


def run(proto, channel, x, seed, phy='-', aa='0', crc='0'):
    raw = gen.to_radio(x, fs, 20000, 40, 2, 0, np.random.default_rng(seed))
    # A directory, not an open NamedTemporaryFile: Windows cannot reopen that.
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, 'capture.iq')
        raw.tofile(path)
        out = subprocess.run([feed, proto, str(channel), str(fs), phy, aa, crc, path],
                             capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr
    return [bytes.fromhex(line.split()[3]) for line in out.stdout.splitlines()]


def gap(seconds):
    return np.zeros(int(seconds * fs), complex)


rng = np.random.default_rng(1)
# 802.15.4: the inner PHY frame (preamble, SFD, length, PSDU) sits in the payload.
for t in range(20):
    inner = gen.wpan_frame(bytes([0x41, 0x88, t, 0xcd, 0xab, 0xff, 0xff, 1, 0]) + b'INJECTED')
    body = (bytes([0x41, 0x88, t, 0xcd, 0xab, 0x34, 0x12, 2, 0]) + bytes(rng.integers(0, 256, 6).tolist())
            + bytes([0, 0, 0, 0, 0xa7, len(inner)]) + inner + bytes(rng.integers(0, 256, 4).tolist()))
    outer = gen.wpan_frame(body)
    got = run('zigbee', 11, np.concatenate([gap(5e-4), gen.oqpsk(outer, fs, 0), gap(5e-4)]), t)
    assert got == [outer], (t, got)

# A real frame 20 us after a frame whose LENGTH says 127 but which stops after
# 20 bytes: the lane following the corrupt frame decodes the real one as its
# payload and fails its CRC; the real frame must still be shown.
for t in range(10):
    psdu = gen.wpan_frame(bytes(rng.integers(0, 256, 18).tolist()))
    forged = gen.oqpsk(psdu + bytes(127 - len(psdu)), fs, 0)[:len(gen.oqpsk(psdu, fs, 0))]
    real = gen.wpan_frame(bytes([0x41, 0x88, t]) + bytes(rng.integers(0, 256, 20).tolist()))
    got = run('zigbee', 11, np.concatenate([gap(5e-4), forged, gap(2e-5), gen.oqpsk(real, fs, 0), gap(5e-4)]), 100 + t)
    assert real in got, (t, got)

# Random maximum-length payloads, back to back: none lost, nothing invented.
frames = [gen.wpan_frame(bytes(rng.integers(0, 256, 125).tolist())) for _ in range(200)]
parts = []
for f in frames:
    parts += [gap(3.75e-4), gen.oqpsk(f, fs, 0)]
got = run('zigbee', 11, np.concatenate(parts + [gap(5e-4)]), 7)
assert got == frames, (sum(f in got for f in frames), len(got))

# BLE 1M: the outer payload is chosen so that, after the outer whitening, it is
# the on-air bit stream of a complete inner packet.
ch, aa, crc = 16, 0xaa08192b, 0xc4c181
for t in range(20):
    inner_air, inner = gen.ble_air_bits(bytes([0x02, 5]) + b'FAKE' + bytes([t]), ch, aa, crc, '1m')
    bits = gen.bits_lsb(bytes([0x02, 60]) + bytes(rng.integers(0, 256, 60).tolist()))
    white = gen.ble_whiten_seq(ch, len(bits))
    for j, b in enumerate(inner_air):
        bits[80 + j] = b ^ white[80 + j]
    air, outer = gen.ble_air_bits(gen.bytes_from_bits(bits), ch, aa, crc, '1m')
    got = run('ble', ch, np.concatenate([gap(2.5e-4), gen.gfsk(air, fs, 1e6, 0), gap(2.5e-4)]), t, '1m', 'aa08192b', 'c4c181')
    assert got == [outer], (t, got)
print('packet-in-packet: 802.15.4 and BLE 1M show only the real frame; '
      'a real frame behind a corrupt LENGTH and 200 random 127-byte frames are all received')
