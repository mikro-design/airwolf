"""Opt-in GPS sky check: is any L1 C/A satellite present at this antenna?

Independent of Airwolf's receiver (own IS-GPS-200 code generator, FFT code
search). Run it on raw int8 IQ centred on 1575.42 MHz, for example:

  hackrf_transfer -r sky.iq -f 1575420000 -s 4000000 -n 48000000 -l 40 -g 40 -a 1
  python3 native/tests/live_gps_sky.py sky.iq 4000000

hackrf_transfer -a 1 enables the RF amplifier; antenna bias (-p 1) is left to
the user because it can damage a DC-shorted antenna. Before searching, 10 us
bursts above 4x the noise are blanked and narrow lines notched: local
electronics commonly produce both near L1, and either one hides satellites from
a correlator. A synthetic satellite injected at a known C/N0 (relative to the
noise between bursts) is searched first, so "no satellites" always comes with
the sensitivity it was measured at. Receive only; reports aggregates only.
"""
import argparse
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

TAPS = [(2, 6), (3, 7), (4, 8), (5, 9), (1, 9), (2, 10), (1, 8), (2, 9), (3, 10), (2, 3), (3, 4), (5, 6), (6, 7),
        (7, 8), (8, 9), (9, 10), (1, 4), (2, 5), (3, 6), (4, 7), (5, 8), (6, 9), (1, 3), (4, 6), (5, 7), (6, 8),
        (7, 9), (8, 10), (1, 6), (2, 7), (3, 8), (4, 9)]


def ca(prn):
    g1, g2, out = [1] * 10, [1] * 10, []
    a, b = TAPS[prn - 1]
    for _ in range(1023):
        out.append(g1[9] ^ g2[a - 1] ^ g2[b - 1])
        g1 = [g1[2] ^ g1[9]] + g1[:9]
        g2 = [g2[1] ^ g2[2] ^ g2[5] ^ g2[7] ^ g2[8] ^ g2[9]] + g2[:9]
    return np.array(out)


def first_ten_octal(prn):
    return oct(int(''.join(map(str, ca(prn)[:10])), 2))[2:]


# IS-GPS-200 Table 3-Ia, first ten chips in octal.
assert [first_ten_octal(p) for p in (1, 2, 17, 32)] == ['1440', '1620', '1156', '1712']


def clean(x, rate):
    """Blank broadband bursts, then notch narrow lines and whiten the band."""
    b = rate // 100000
    m = len(x) // b * b
    pw = (np.abs(x[:m].reshape(-1, b)) ** 2).mean(1)
    hot = pw > 4 * np.median(pw) / np.log(2)
    hot = hot | np.r_[hot[1:], False] | np.r_[False, hot[:-1]]
    x[:m].reshape(-1, b)[hot] = 0
    L = 65536
    m = len(x) // L * L
    X = np.fft.fft(x[:m].reshape(-1, L), axis=1)
    psd = np.median(np.abs(X) ** 2, axis=0)
    smooth = np.median(sliding_window_view(np.pad(psd, 64, mode='wrap'), 129), axis=1)[:L]
    keep = psd < 2 * smooth
    X = X / np.sqrt(smooth) * keep
    return np.fft.ifft(X, axis=1).reshape(-1).astype(np.complex64), hot.mean(), np.count_nonzero(~keep)


def search(x, rate, code, ms, doppler):
    n = rate // 1000
    blocks = x[:n * ms].reshape(ms, n)
    t = np.arange(n) / rate
    replica = 1 - 2 * code[(np.arange(n) * 1023000 // rate) % 1023]
    C = np.conj(np.fft.fft(replica))
    best = (0.0, 0)
    for d in doppler:
        row = (np.abs(np.fft.ifft(np.fft.fft(blocks * np.exp(-2j * np.pi * d * t), axis=1) * C, axis=1)) ** 2).sum(0)
        j = row.argmax()
        mask = np.ones(n, bool)
        mask[max(0, j - rate // 500000):j + rate // 500000 + 1] = False
        metric = row[j] / row[mask].mean()
        if metric > best[0]:
            best = (metric, int(d))
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('iq', help='int8 interleaved IQ centred on 1575.42 MHz')
    parser.add_argument('rate', type=int, help='sample rate in Hz (2-8 MS/s)')
    parser.add_argument('--ms', type=int, default=200, help='non-coherent 1 ms integrations')
    parser.add_argument('--doppler-khz', type=float, default=40, help='search +/- this, covering HackRF clock error')
    parser.add_argument('--control-cn0', type=float, default=32, help='positive-control C/N0 in dB-Hz')
    args = parser.parse_args()
    rate = args.rate
    need = 2 * (rate // 1000) * args.ms + 2 * 6 * rate
    raw = np.fromfile(args.iq, np.int8, count=need + 2 * rate)[2 * rate:]  # skip 1 s of settling
    if len(raw) < need:
        raise SystemExit(f'need at least {need // (2 * rate) + 1} s of IQ')
    x = (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)
    x -= x.mean()
    clip = np.mean(np.abs(raw.astype(np.int16)) >= 127) * 100
    doppler = np.arange(-args.doppler_khz * 1000, args.doppler_khz * 1000 + 1, 500)
    rng = np.random.default_rng(0)
    # Positive control on a copy, with a fixed pseudo-random 1023-chip code:
    # same correlation statistics as a C/A code, but no satellite carries it.
    p = np.abs(x) ** 2
    floor = p[p < 4 * np.median(p)].mean() * 1.1
    t = np.arange(len(x)) / rate
    control_code = np.random.default_rng(1575).integers(0, 2, 1023)
    amp = np.sqrt(10 ** (args.control_cn0 / 10) * floor / rate)
    control = x + (amp * (1 - 2 * control_code[(t * 1023000 + 300.25).astype(int) % 1023])
                   * np.exp(2j * np.pi * (3200 * t + .3))).astype(np.complex64)
    control, _, _ = clean(control, rate)
    x, blanked, notched = clean(x, rate)
    baseline = [search(x, rate, rng.integers(0, 2, 1023), args.ms, doppler)[0] for _ in range(4)]
    threshold = max(baseline) * 1.25
    found = search(control, rate, control_code, args.ms, doppler)[0]
    print(f'clipped {clip:.2f}% of components; blanked {blanked * 100:.1f}% of time; notched {notched} lines/bins')
    print(f'random-code baseline {min(baseline):.2f}-{max(baseline):.2f}; threshold {threshold:.2f}')
    print(f'positive control {args.control_cn0:.0f} dB-Hz: {found:.2f} -> {"DETECTED" if found > threshold else "MISSED"}')
    hits = []
    for prn in range(1, 33):
        metric, d = search(x, rate, ca(prn), args.ms, doppler)
        if metric > threshold:
            hits.append(prn)
            print(f'PRN {prn:2d}: {metric:.2f} at {d:+d} Hz')
    if found <= threshold:
        print('UNVERIFIED: the positive control was missed; raise --ms or lower --control-cn0')
    elif not hits:
        print(f'No satellite above about {args.control_cn0:.0f} dB-Hz at this antenna')
    else:
        print(f'{len(hits)} satellites present')


if __name__ == '__main__':
    main()
