"""Nordic Enhanced ShockBurst reception from independently generated GFSK IQ.

Frames are built here from the on-air format (preamble chosen by the first
address bit, MSB-first address, 9-bit PCF, payload, bit-serial CRC-16-CCITT
or CRC-8) and modulated with gen.gfsk; nothing is shared with the receiver.
Usage: esb.py airwolf-iq-feed [airwolf-follow-transport-tests airwolf-iq]
With the last two, the same capture also runs through the production HackRF
worker (fake libhackrf) and IQ replay, checking event metadata and integrity.
"""
import json, os, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import gen

PHY = {'250k': (250000, 160000), '1m': (1000000, 160000), '2m': (2000000, 320000)}


def crc(bits, size):
    if size == 2:
        r = 0xFFFF
        for b in bits:
            top = ((r >> 15) & 1) ^ b
            r = (r << 1) & 0xFFFF
            if top: r ^= 0x1021
        return r
    r = 0xFF
    for b in bits:
        top = ((r >> 7) & 1) ^ b
        r = (r << 1) & 0xFF
        if top: r ^= 0x07
    return r


def msb(data):
    return [(byte >> (7 - i)) & 1 for byte in data for i in range(8)]


def frame(address, payload, pid=1, no_ack=0, crc_size=2, corrupt=0):
    """Returns (air bits, expected receiver bytes)."""
    pcf = [(len(payload) >> (5 - i)) & 1 for i in range(6)] + [(pid >> 1) & 1, pid & 1, no_ack]
    covered = msb(address) + pcf + msb(payload)
    value = crc(covered, crc_size)
    tail = [(value >> (8 * crc_size - 1 - i)) & 1 for i in range(8 * crc_size)]
    for k in range(corrupt): covered[len(covered) - 3 - 5 * k] ^= 1
    air = covered + tail
    preamble = [1, 0] * 4 if address[0] & 0x80 else [0, 1] * 4
    control = (len(payload) << 2 | pid, no_ack << 7)
    sent = bytes(sum(b << (7 - i) for i, b in enumerate(air[8 * len(address) + 9 + 8 * k:][:8])) for k in range(len(payload)))
    expected = bytes(address) + bytes(control) + sent + value.to_bytes(crc_size, 'big')
    return preamble + air, expected


def crc_ok(data, width, crc_size):
    """Independent check of a received frame in the receiver's byte layout."""
    length = data[width] >> 2
    bits = msb(data[:width]) + msb(data[width:width + 2])[:9] + msb(data[width + 2:width + 2 + length])
    return crc(bits, crc_size) == int.from_bytes(data[width + 2 + length:], 'big')


def capture(frames, fs, phy, cfo, sigma, seed, gap_bits=600):
    rate, deviation = PHY[phy]
    sps = fs / rate
    pieces, at = [], 2000
    total = int(at + sum((len(b) + gap_bits) * sps for b, _ in frames)) + 4000
    x = np.zeros(total, complex)
    for bits, _ in frames:
        wave = gen.gfsk(bits, fs, rate, 0, h=2 * deviation / rate)
        x[at:at + len(wave)] += wave[:total - at]
        at += int((len(bits) + gap_bits) * sps)
    return gen.to_radio(x, fs, cfo, 40, sigma, 2, np.random.default_rng(seed))


def run(feed, raw, fs, phy, address='-', crc_size=2, channel=40):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'esb.iq'
        raw.tofile(path)
        out = subprocess.run([feed, 'esb', str(channel), str(fs), phy, address, str(crc_size), str(path)],
                             capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr
    rows = [line.split() for line in out.stdout.splitlines()]
    # bytes, address width, CRC bytes, first sample, corrected bits
    return [(bytes.fromhex(r[3]), int(r[4]), int(r[5]), int(r[0]), int(r[6])) for r in rows]


def production(transport, iq_tool):
    """The worker and replay report exactly the frames the receiver chain does."""
    fs, center = 8000000, 2440000000
    address = bytes([0x9D, 0x31, 0x07, 0xC2])
    frames = [frame(address, b'\x01\x02\x03'), frame(address, b''), frame(address, b'\xA5' * 32, pid=2, no_ack=1)]
    raw = capture(frames, fs, '2m', 50000, 6, 77)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'esb.iq'
        raw.tofile(path)
        env = {k: v for k, v in os.environ.items() if not k.startswith('AIRWOLF_FAKE_')}
        env['AIRWOLF_FAKE_IQ_FILE'] = str(path)
        out = subprocess.run([transport, '--decoder', 'esb', '--esb-rate', '2m', '--frequency', str(center),
                              '--sample-rate', str(fs), '--duration-ms', '600'], env=env, capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr
        events = [json.loads(line) for line in out.stdout.splitlines() if line.startswith('{')]
        packets = [e for e in events if e.get('type') == 'packet']
        assert [bytes(p['bytes']) for p in packets] == [e for _, e in frames], packets
        for p in packets:
            assert (p['protocol'], p['channel'], p['phy'], p['esbAddressWidth'], p['esbCrcBytes'], p['integrity'], p['fecErrors']) == \
                ('esb', 40, '2m', 4, 2, 'valid', 0), p
        assert any(e.get('type') == 'spectrum' and e['decoder'] == 'esb' for e in events)
        # Replay of the same samples: identical frames and boundaries.
        replay = subprocess.run([iq_tool, 'decode', str(path), '0', str(len(raw) // 2), 'esb', str(fs), str(center),
                                 str(center + fs // 4), '2m', '0', '0', '-', '2'], capture_output=True, text=True, timeout=120)
        assert replay.returncode == 0, replay.stderr
        again = json.loads(replay.stdout)['packets']
        assert [bytes(p['bytes']) for p in again] == [e for _, e in frames], again
        assert all(p['integrity'] == 'valid' and p['esbAddressWidth'] == 4 for p in again), again
        offset = packets[0]['firstSample'] - again[0]['firstSample']
        assert all(a['firstSample'] - b['firstSample'] == offset for a, b in zip(packets, again))
        # Configured address with CRC-8 is accepted; invalid settings are refused.
        bad = subprocess.run([iq_tool, 'decode', str(path), '0', '1000', 'esb', str(fs), str(center), str(center + fs // 4),
                              '2m', '0', '0', '-', '1'], capture_output=True, text=True)
        assert bad.returncode != 0 and 'CRC-16' in bad.stderr, bad.stderr
        for wrong in (['--frequency', '2440500000'], ['--esb-crc', '3'], ['--esb-address', 'abc']):
            refused = subprocess.run([transport, '--decoder', 'esb', '--frequency', str(center), '--sample-rate', str(fs),
                                      '--duration-ms', '50', *wrong], env=env, capture_output=True, text=True, timeout=60)
            assert refused.returncode != 0, wrong
    print('ESB through the HackRF worker and IQ replay: exact frames, metadata and integrity')


def main(feed):
    rng = np.random.default_rng(5)
    address5 = bytes([0xE7, 0x3A, 0x5C, 0x19, 0xB2])
    passed = 0
    for fs in (8000000, 10000000, 16000000, 20000000):
        for phy in ('250k', '1m', '2m'):
            # One link: an ACK (empty payload), a short and a maximum payload.
            frames = [frame(address5, b''), frame(address5, b'\x42', pid=2), frame(address5, bytes(rng.integers(0, 256, 32, dtype=np.uint8)), pid=3)]
            cfo = 60000 if phy != '250k' else 30000
            got = run(feed, capture(frames, fs, phy, cfo, 6, fs + len(phy)), fs, phy)
            assert [g[0] for g in got] == [e for _, e in frames], (fs, phy, got)
            assert all(g[1:3] == (5, 2) for g in got), got
            starts = [g[3] for g in got]
            assert starts == sorted(starts)
            passed += 1
    fs = 8000000
    # Every address width, promiscuous; two links interleaved; carrier offsets
    # both ways near the nRF24's +/-60 ppm crystal budget.
    for width, cfo in ((3, -110000), (4, 110000)):
        a, b = bytes(rng.integers(0, 256, width, dtype=np.uint8)), bytes(rng.integers(0, 256, width, dtype=np.uint8))
        frames = [frame(a, b'\x01\x02'), frame(b, b'\x03'), frame(a, b'\x04'), frame(b, b'')]
        got = run(feed, capture(frames, fs, '2m', cfo, 6, width), fs, '2m')
        assert sorted(g[0] for g in got) == sorted(e for _, e in frames), (width, got)
        passed += 1
    # A single frame from an address is not reported: noise passes a CRC-16
    # check a few times a second, so one hit is not evidence of a transmitter.
    got = run(feed, capture([frame(address5, b'\x55')], fs, '2m', 0, 6, 9), fs, '2m')
    assert got == [], got
    passed += 1
    # Once an address is confirmed, a damaged frame from it is kept. Two bit
    # errors are beyond CRC-16 correction (distance 4) and stay a bad CRC.
    # One may be corrected, to exactly the frame that was sent, and says so.
    good = frame(address5, b'\x10\x20')
    twice, once = frame(address5, b'\x30\x40', corrupt=2), frame(address5, b'\x50\x60', corrupt=1)
    intact = frame(address5, b'\x50\x60')[1]
    got = run(feed, capture([good, good, twice, once], fs, '1m', 20000, 6, 10), fs, '1m')
    assert [g[0] for g in got][:2] == [good[1], good[1]] and len(got) == 4, got
    assert all(crc_ok(g[0], 5, 2) and g[4] == 0 for g in got[:2])
    assert got[2][0] == twice[1] and not crc_ok(got[2][0], 5, 2) and got[2][4] == 0, got[2]
    assert (got[3][0], got[3][4]) in ((intact, 1), (once[1], 0)), got[3]
    passed += 1
    # A configured address: CRC-8, no confirmation needed, bad CRC kept;
    # another address is ignored.
    a3 = bytes([0x12, 0x34, 0x56])
    frames = [frame(a3, b'\x07', crc_size=1), frame(a3, b'\x08\x09', crc_size=1, corrupt=1), frame(bytes([0x65, 0x43, 0x21]), b'\x01', crc_size=1)]
    got = run(feed, capture(frames, fs, '1m', 0, 6, 11), fs, '1m', a3.hex(), 1)
    assert len(got) == 2 and got[0][0] == frames[0][1] and got[0][1:3] == (3, 1), got
    assert crc_ok(got[0][0], 3, 1) and got[1][0] == frames[1][1] and not crc_ok(got[1][0], 3, 1), got
    passed += 1
    # Sensitivity floor, 40 frames of 16-byte payload at 9 dB SNR over the
    # 8 MHz input (about 17/14/23 dB in the 1M/2M/250k channels). Every
    # reported frame must be one that was sent: a single-bit correction may
    # recover a frame, never invent one.
    corrections = 0
    for phy, floor in (('1m', 33), ('2m', 22), ('250k', 37)):
        frames = [frame(address5, bytes(rng.integers(0, 256, 16, dtype=np.uint8))) for _ in range(40)]
        got = run(feed, capture(frames, fs, phy, 40000, 10, 20), fs, phy)
        sent = {e for _, e in frames}
        valid = [g for g in got if crc_ok(g[0], 5, 2)]
        assert all(g[0] in sent for g in valid), phy
        assert len(valid) >= floor, (phy, len(valid))
        corrections += sum(g[4] for g in valid)
        passed += 1
    assert corrections > 0, 'single-bit correction never used at 9 dB'
    # Noise alone: nothing in promiscuous or configured mode at any rate.
    for phy in ('250k', '1m', '2m'):
        noise = np.clip(np.round(rng.normal(0, 10, 2 * 4 * fs)), -127, 127).astype(np.int8)
        assert run(feed, noise, fs, phy) == [], phy
        assert run(feed, noise, fs, phy, address5.hex(), 2) == [], phy
        passed += 1
    print(f'{passed} ESB reception cases passed (4 s of noise per rate: no frames)')


if __name__ == '__main__':
    main(sys.argv[1])
    if len(sys.argv) > 3:
        production(sys.argv[2], sys.argv[3])
