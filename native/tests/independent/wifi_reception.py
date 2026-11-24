"""Wi-Fi OFDM reception under realistic conditions, with independent waveforms.

Guards five behaviours that clean-channel tests cannot see:
- dense weak traffic: every frame needs soft Viterbi; none may be starved;
- VHT, HE and HT40/multi-stream headers: counted as unsupported, never
  soft-decoded as legacy data (which wasted the FEC budget and showed nothing);
- clock drift on maximum-length 54 Mb/s frames: the FFT window must follow;
- Rayleigh multipath with 200 ns rms delay spread: acquisition must hold;
- 6 Mb/s sensitivity: beacons near 5 dB SNR must decode.
"""
import inspect, os, pathlib, subprocess, sys, tempfile, zlib
import numpy as np
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(__file__))
import wifi as W
import wifi_ht as H


def psdu(rng, length):
    body = bytes([0x08, 0x02, 0, 0]) + bytes(rng.integers(0, 256, length - 8, dtype=np.uint8))
    return body + zlib.crc32(body).to_bytes(4, 'little')


def rayleigh(rng, rms_ns):
    taps = int(np.ceil(rms_ns * 6 / 50)) + 1
    power = np.exp(-np.arange(taps) * 50 / rms_ns)
    power /= power.sum()
    h = np.sqrt(power / 2) * (rng.standard_normal(taps) + 1j * rng.standard_normal(taps))
    return h / np.sqrt(np.sum(np.abs(h) ** 2))


def impair(x, rng, ppm=0.0, rms_ns=0, gap=600):
    if rms_ns:
        x = np.convolve(x, rayleigh(rng, rms_ns))
    x = np.r_[np.zeros(gap), x, np.zeros(gap)]
    # Random fractional start and sampling-clock offset, as every capture has.
    positions = np.arange(int(len(x) / (1 + ppm * 1e-6)) - 2) * (1 + ppm * 1e-6) + rng.uniform(0, 1)
    up = resample_poly(x, 8, 1)
    grid = np.arange(len(up)) / 8
    x = np.interp(positions, grid, up.real) + 1j * np.interp(positions, grid, up.imag)
    return x * np.exp(1j * rng.uniform(-np.pi, np.pi))


def decode(binary, directory, waves, rng, snr_db, rms=18.0):
    active = np.concatenate([w for w in waves])
    power = np.mean(np.abs(active[np.abs(active) > 1e-9]) ** 2)
    x = np.concatenate(waves) * (rms / np.sqrt(power))
    sigma = rms / np.sqrt(10 ** (snr_db / 10))
    x = x + sigma / np.sqrt(2) * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x)))
    raw = np.empty(2 * len(x), np.int8)
    raw[0::2] = np.clip(np.round(x.real), -127, 127)
    raw[1::2] = np.clip(np.round(x.imag), -127, 127)
    path = pathlib.Path(directory) / 'reception.iq'
    raw.tofile(path)
    result = subprocess.run([binary, str(path), '4096'], capture_output=True, text=True, check=True, timeout=100)
    rows = [line.split() for line in result.stdout.splitlines()]
    stats = dict(item.split('=') for item in result.stderr.split())
    return rows, {key: int(value) for key, value in stats.items()}


def valid(rows, payloads):
    wanted = {p.hex() for p in payloads}
    assert not any(r[3] == '1' and r[4] not in wanted for r in rows), 'invented a valid frame'
    return sum(r[3] == '1' and r[4] in wanted for r in rows)


def very_high_throughput(rng, kind):
    """L-STF/LTF/L-SIG at 6 Mb/s, then VHT-SIG-A (BPSK, QBPSK) or HE RL-SIG
    plus two BPSK HE-SIG-A symbols, then 16-QAM data."""
    polarity = [1 - 2 * b for b in W.scramble([0] * 127, 127)]

    def symbol(points, index, qbpsk=False):
        bins = np.zeros(64, complex)
        bins[np.array(W.DATA) % 64] = points * (1j if qbpsk else 1)
        bins[np.array([-21, -7, 7, 21]) % 64] = np.array([1, 1, 1, -1]) * polarity[index % 127]
        x = np.fft.ifft(bins)
        return np.r_[x[-16:], x]

    count = int(rng.integers(10, 120))
    # 802.11-2020 21.3.8.2.4 (VHT: multiple of three) and 27.3.11.5 (HE: m = 2).
    length = 3 * (count + 2) - 3 if kind == 'vht' else 3 * (count + 3) - 3 - 2
    lsig = [1, 1, 0, 1, 0] + W.lsb(length, 12)
    lsig += [sum(lsig) % 2] + [0] * 6
    lsig_points = W.symbols(W.interleave(W.encode(lsig), 1), 1)
    parts = [W.waveform(bytes(20), 6)[:320], symbol(lsig_points, 0)]
    bpsk = lambda: 2 * rng.integers(0, 2, 48) - 1.0
    if kind == 'vht':
        parts += [symbol(bpsk(), 1), symbol(bpsk(), 2, qbpsk=True)]
    else:
        parts += [symbol(lsig_points, 1), symbol(bpsk(), 2), symbol(bpsk(), 3)]
    for n in range(count):
        points = ((2 * rng.integers(0, 4, 48) - 3) + 1j * (2 * rng.integers(0, 4, 48) - 3)) / np.sqrt(10)
        parts.append(symbol(points, n + 4))
    return np.concatenate(parts)


def unsupported_ht(rng, mcs, forty):
    """CRC-valid HT-SIG for a mode this receiver cannot demodulate."""
    source = inspect.getsource(H.waveform).replace('ht_sig=lsb(mcs,7)+[0]+', 'ht_sig=lsb(SIGNAL_MCS,7)+[FORTY]+')
    assert 'SIGNAL_MCS' in source
    namespace = dict(vars(H))
    namespace.update(SIGNAL_MCS=mcs, FORTY=int(forty))
    exec(source, namespace)
    return namespace['waveform'](psdu(rng, 200), 0)


def run(binary):
    results = {}
    with tempfile.TemporaryDirectory(prefix='airwolf-wifi-reception-') as directory:
        # Dense 24 Mb/s traffic at 12 dB, 20 us apart: soft decoding every frame.
        rng = np.random.default_rng(77)
        payloads = [psdu(rng, 1000) for _ in range(60)]
        waves = [impair(W.waveform(p, 24), rng, gap=200) for p in payloads]
        rows, stats = decode(binary, directory, waves, rng, 12)
        results['dense_24mbps_12db'] = valid(rows, payloads)
        assert results['dense_24mbps_12db'] >= 55, (results, stats)
        assert stats['recovery_budget_skips'] == 0, stats

        # Unsupported PPDUs between the same kind of legacy traffic.
        rng = np.random.default_rng(5)
        payloads = [psdu(rng, 1000) for _ in range(20)]
        waves = []
        for p in payloads:
            waves.append(impair(W.waveform(p, 24), rng, gap=200))
            waves.append(impair(very_high_throughput(rng, 'vht'), rng, gap=200))
            waves.append(impair(very_high_throughput(rng, 'he'), rng, gap=200))
        for mcs, forty in ((0, True), (8, False), (15, False), (32, True)):
            waves.append(impair(unsupported_ht(rng, mcs, forty), rng, gap=200))
        rows, stats = decode(binary, directory, waves, rng, 25)
        results['legacy_between_vht_he'] = valid(rows, payloads)
        assert results['legacy_between_vht_he'] == 20, (results, stats)
        assert len(rows) == 20, ('unsupported PPDU shown as a frame', stats)
        assert stats['unsupported'] == 44, stats

        # Maximum-length 54 Mb/s frames with +-50 ppm clock error at 30 dB.
        rng = np.random.default_rng(11)
        payloads = [psdu(rng, 4095) for _ in range(16)]
        waves = [impair(W.waveform(p, 54), rng, ppm=50 if n % 2 else -50) for n, p in enumerate(payloads)]
        rows, stats = decode(binary, directory, waves, rng, 30)
        results['54mbps_4095_50ppm'] = valid(rows, payloads)
        assert results['54mbps_4095_50ppm'] >= 15, (results, stats)

        # Rayleigh multipath, 200 ns rms delay spread, 6 and 24 Mb/s at 30 dB.
        for rate in (6, 24):
            rng = np.random.default_rng(rate)
            payloads = [psdu(rng, 500) for _ in range(30)]
            waves = [impair(W.waveform(p, rate), rng, rms_ns=200) for p in payloads]
            rows, stats = decode(binary, directory, waves, rng, 30)
            results[f'multipath_{rate}mbps'] = valid(rows, payloads)
            assert results[f'multipath_{rate}mbps'] >= 28, (results, stats)

        # 6 Mb/s sensitivity at 5 dB.
        rng = np.random.default_rng(6)
        payloads = [psdu(rng, 200) for _ in range(40)]
        waves = [impair(W.waveform(p, 6), rng) for p in payloads]
        rows, stats = decode(binary, directory, waves, rng, 5)
        results['6mbps_5db'] = valid(rows, payloads)
        assert results['6mbps_5db'] >= 36, (results, stats)
    print(results)


if __name__ == '__main__':
    run(sys.argv[1])
