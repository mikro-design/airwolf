"""Independent CEN DSRC (EN 12253 / EN 12795) generator and receiver checks.

Frames are built here from their definition: ISO/IEC 13239 FCS (derived from
binascii's MSB-first CCITT CRC by bit reflection, not a copy of the receiver),
LSB-first octets, zero-bit stuffing and 0x7E flags. The downlink is ASK with
FM0 at 500 kbit/s on the carrier; the uplink is the roadside carrier plus a
weak backscattered square-wave subcarrier (1.5 or 2.0 MHz) whose phase is
NRZI-coded at 250 kbit/s, so it has the odd harmonics a real backscatter tag
produces. Nothing is shared with the receiver.

Usage: dsrc.py airwolf-iq-feed [airwolf-follow-transport-tests airwolf-iq]
With the last two, a capture also runs through the production HackRF worker
(fake libhackrf) and IQ replay, checking event metadata and integrity.
"""
import binascii, json, os, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import gen

CHANNEL_HZ = {1: 5797500000, 2: 5802500000, 3: 5807500000, 4: 5812500000}


def reflect(value, width):
    return int(f'{value:0{width}b}'[::-1], 2)


def fcs(data):
    # X.25 = reflected CCITT: reflect each input octet and the result.
    crc = binascii.crc_hqx(bytes(reflect(b, 8) for b in data), 0xFFFF)
    return reflect(crc, 16) ^ 0xFFFF


def frame(payload, corrupt=False):
    value = fcs(payload) ^ (1 if corrupt else 0)
    return bytes(payload) + bytes([value & 0xFF, value >> 8])


def hdlc_bits(frames, flags=3):
    """Flags, then each frame stuffed, LSB first, then closing flags."""
    flag = [0, 1, 1, 1, 1, 1, 1, 0]
    bits = flag * flags
    for data in frames:
        ones = 0
        for byte in data:
            for k in range(8):
                b = (byte >> k) & 1
                bits.append(b)
                ones = ones + 1 if b else 0
                if ones == 5:
                    bits.append(0)
                    ones = 0
        bits += flag * flags
    return bits


def fm0(bits, invert=False):
    """Half-bit levels: a transition at every bit start, plus mid-bit for 0."""
    level, halves = 1, []
    for b in bits:
        level ^= 1
        first = level
        if (b == 0) != invert:
            level ^= 1
        halves += [first, level]
    return halves


def downlink(bits, fs, low=0.3, invert=False, lead_us=200, tail_us=200):
    halves = np.array(fm0(bits, invert), float)
    spb = fs // 1000000  # samples per half bit
    envelope = np.repeat(np.where(halves > 0, 1.0, low), spb)
    # Finite transmitter rise time (about 0.2 us).
    k = max(1, fs // 5000000)
    envelope = np.convolve(envelope, np.ones(k) / k, mode='same')
    pad = np.ones(int(lead_us * fs / 1e6))
    return np.concatenate((pad, envelope, np.ones(int(tail_us * fs / 1e6))))


def uplink(bits, fs, subcarrier, level=0.03, ppm=0, invert=False, lead_us=200, tail_us=200):
    """Carrier (amplitude 1) plus backscatter: level * square(subcarrier, NRZI phase)."""
    rate = 250000 * (1 + ppm * 1e-6)
    state, phases = 0, []
    for b in bits:
        if (b == 0) != invert:
            state ^= 1
        phases.append(state)
    duration = len(bits) / rate
    t = np.arange(int(duration * fs)) / fs
    index = np.minimum((t * rate).astype(int), len(bits) - 1)
    square = np.sign(np.cos(2 * np.pi * subcarrier * (1 + ppm * 1e-6) * t + np.pi * np.array(phases)[index]))
    burst = 1 + level * square
    return np.concatenate((np.ones(int(lead_us * fs / 1e6)), burst, np.ones(int(tail_us * fs / 1e6))))


def radio(wave, fs, cfo, sigma, seed, amplitude=100):
    return gen.to_radio(wave.astype(complex), fs, cfo, amplitude, sigma, 2, np.random.default_rng(seed))


def run(feed, raw, fs, channel=1):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'dsrc.iq'
        raw.tofile(path)
        out = subprocess.run([feed, 'dsrc', str(channel), str(fs), '-', '0', '0', str(path)],
                             capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr
    rows = [line.split() for line in out.stdout.splitlines()]
    return [(int(r[0]), int(r[1]), r[2], bytes.fromhex(r[3]), int(r[4])) for r in rows], out.stderr


def payloads(rng, count, low=6, high=64):
    # LID-like 4 octets (LSB extension bits), MAC and LLC octets, then data.
    out = []
    for _ in range(count):
        body = rng.integers(0, 256, int(rng.integers(low, high))).astype(np.uint8).tobytes()
        out.append(frame(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0xA0, 0x03]) + body))
    return out


def production(transport, iq_tool):
    fs, center = 20000000, CHANNEL_HZ[2]
    rng = np.random.default_rng(14906)
    down, up = payloads(rng, 2), payloads(rng, 2)
    wave = np.concatenate([downlink(hdlc_bits([down[0]]), fs), uplink(hdlc_bits([up[0]]), fs, 1500000),
                           downlink(hdlc_bits([down[1]]), fs), uplink(hdlc_bits([up[1]]), fs, 2000000)])
    raw = radio(wave, fs, 40000, 1.5, 5)
    expected = [(down[0], 'downlink', None), (up[0], 'uplink', 1500000), (down[1], 'downlink', None), (up[1], 'uplink', 2000000)]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'dsrc.iq'
        raw.tofile(path)
        env = {k: v for k, v in os.environ.items() if not k.startswith('AIRWOLF_FAKE_')}
        env['AIRWOLF_FAKE_IQ_FILE'] = str(path)
        out = subprocess.run([transport, '--decoder', 'dsrc', '--frequency', str(center), '--sample-rate', str(fs),
                              '--duration-ms', '400'], env=env, capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr
        events = [json.loads(line) for line in out.stdout.splitlines() if line.startswith('{')]
        packets = [e for e in events if e.get('type') == 'packet']
        assert [(bytes(p['bytes']), p['phy'], p.get('dsrcSubcarrierHz')) for p in packets] == expected, packets
        assert all(p['protocol'] == 'dsrc' and p['channel'] == 2 and p['integrity'] == 'valid' for p in packets)
        assert any(e.get('type') == 'spectrum' and e['decoder'] == 'dsrc' for e in events)
        replay = subprocess.run([iq_tool, 'decode', str(path), '0', str(len(raw) // 2), 'dsrc', str(fs), str(center),
                                 str(center + fs // 4), '1m', '0', '0'], capture_output=True, text=True, timeout=120)
        assert replay.returncode == 0, replay.stderr
        again = json.loads(replay.stdout)['packets']
        assert [(bytes(p['bytes']), p['phy'], p.get('dsrcSubcarrierHz')) for p in again] == expected, again
        assert all(p['integrity'] == 'valid' for p in again)
        offset = packets[0]['firstSample'] - again[0]['firstSample']
        assert all(a['firstSample'] - b['firstSample'] == offset for a, b in zip(packets, again))
        for wrong in (['--frequency', '5800000000'], ['--sample-rate', '8000000']):
            args = ['--decoder', 'dsrc', '--frequency', str(center), '--sample-rate', str(fs), '--duration-ms', '50']
            for k in range(0, len(wrong), 2):
                args[args.index(wrong[k]) + 1] = wrong[k + 1]
            refused = subprocess.run([transport, *args], env=env, capture_output=True, text=True, timeout=60)
            assert refused.returncode != 0 and 'DSRC' in refused.stderr, (wrong, refused.stderr)
    print('DSRC through the HackRF worker and IQ replay: exact frames, link, subcarrier and integrity')


def main(feed):
    rng = np.random.default_rng(12253)
    cases = 0
    # Downlink: every rate, both FM0 polarities, receiver frequency error.
    for fs in (10000000, 16000000, 20000000):
        for invert in (False, True):
            for cfo in (-110000, 0, 95000):
                frames = payloads(rng, 4)
                wave = np.concatenate([downlink(hdlc_bits([f]), fs, invert=invert) for f in frames])
                got, err = run(feed, radio(wave, fs, cfo, 3, cases), fs)
                assert [g[3] for g in got] == frames, (fs, invert, cfo, len(got), err)
                assert all(g[2] == 'downlink' and g[4] == 0 for g in got)
                cases += 1
    # Uplink: both subcarriers, both NRZI polarities, frequency error and
    # on-board-unit clock offset up to 0.1%, sideband 30 dB below the carrier.
    for fs in (10000000, 16000000, 20000000):
        for subcarrier in (1500000, 2000000):
            for invert, cfo, ppm in ((False, 100000, 1000), (True, -100000, -1000), (False, 0, 300)):
                frames = payloads(rng, 3)
                wave = np.concatenate([uplink(hdlc_bits([f]), fs, subcarrier, ppm=ppm, invert=invert) for f in frames])
                got, err = run(feed, radio(wave, fs, cfo, 1.5, cases), fs, channel=3)
                assert [g[3] for g in got] == frames, (fs, subcarrier, invert, cfo, ppm, len(got), err)
                assert all(g[2] == 'uplink' and g[4] == subcarrier for g in got), got
                cases += 1
    # Frame timing: the reported span covers the burst's frame, not the lead-in.
    fs = 10000000
    f = payloads(rng, 1)[0]
    wave = downlink(hdlc_bits([f]), fs, lead_us=1000)
    (first, end, *_), = run(feed, radio(wave, fs, 0, 3, 99), fs)[0]
    start = 1000 * 10 + 3 * 8 * 20  # lead-in plus three flags, in samples
    assert abs(first - start) <= 40 and abs(end - (start + len(hdlc_bits([f], 0)) * 20 + 8 * 20)) <= 200, (first, end, start)
    cases += 1
    # A corrupted FCS is never emitted; neither is anything from noise, plain
    # carrier, or carrier with random ASK and random subcarrier modulation.
    bad = frame(bytes(range(20)), corrupt=True)
    got, _ = run(feed, radio(downlink(hdlc_bits([bad]), fs), fs, 0, 3, 7), fs)
    assert not got, got
    for fs in (10000000, 20000000):
        seconds = 2
        noise = radio(np.zeros(seconds * fs, complex), fs, 0, 6, 11)
        carrier = radio(np.ones(seconds * fs, complex), fs, 50000, 3, 12)
        junk_bits = list(rng.integers(0, 2, seconds * 500000))
        ask = radio(downlink(junk_bits, fs), fs, 0, 3, 13)
        junk_up = list(rng.integers(0, 2, seconds * 250000))
        back = radio(uplink(junk_up, fs, 2000000), fs, 0, 1.5, 14)
        for name, raw in (('noise', noise), ('carrier', carrier), ('random ASK', ask), ('random uplink', back)):
            got, err = run(feed, raw, fs)
            assert not got, (fs, name, got)
        cases += 1
    # Sensitivity floor on the uplink: modulation 0.015 of a near-full-scale
    # carrier (each sideband about 40 dB below it), 100 kHz frequency error.
    fs, hits, total = 10000000, 0, 0
    for seed in range(10):
        frames = payloads(rng, 2, 6, 24)
        wave = np.concatenate([uplink(hdlc_bits([f]), fs, 2000000, level=0.015) for f in frames])
        got, _ = run(feed, radio(wave, fs, 100000, 1.5, 200 + seed), fs)
        hits += sum(g[3] in frames for g in got)
        assert all(g[3] in frames for g in got)
        total += len(frames)
    assert hits >= 0.9 * total, (hits, total)
    print(f'{cases} DSRC reception cases passed; weak uplink {hits}/{total}; '
          'noise, carrier and random modulation: no frames')


if __name__ == '__main__':
    main(sys.argv[1])
    if len(sys.argv) > 3:
        production(sys.argv[2], sys.argv[3])
