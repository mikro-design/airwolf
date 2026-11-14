"""Offline LTE PSS frequency search for diagnosing real ci8 captures.

This is an independent test instrument, not a packet decoder. A repeated PSS
candidate is not proof of a cell or a decoded MIB. Feed the resulting carrier
center into the native receiver and require PBCH CRC before claiming reception.
Sequence: 3GPP TS 36.211 section 6.11.1.1. No upstream receiver code is used.
"""
import argparse
import json
import numpy as np


def templates():
    n = np.arange(62)
    phase = np.where(n < 31, n * (n + 1), (n + 1) * (n + 2))
    bins = np.zeros((3, 128), dtype=complex)
    bins[:, np.r_[np.arange(97, 128), np.arange(1, 32)]] = np.exp(
        -1j * np.pi * np.array([25, 29, 34])[:, None] * phase / 63)
    return np.fft.ifft(bins, axis=1)


def search(iq, rate, offsets):
    # Exactly 10 ms, two PSS occasions 5 ms apart. Crop in the frequency
    # domain; this is an offline diagnostic, not the production channel filter.
    count = round(rate / 100)
    if len(iq) != count:
        raise ValueError('Search requires exactly 10 ms of IQ')
    spectrum = np.fft.fft(iq)
    output_count = 19200
    indices = np.fft.fftfreq(output_count, 1 / output_count).astype(int)
    ref = templates()
    matched = np.conj(np.fft.fft(ref, output_count, axis=1))
    ref_power = np.sum(abs(ref) ** 2, axis=1)
    results = []
    for offset in offsets:
        if abs(offset) + 960000 > rate / 2:
            continue
        cropped = spectrum[(indices + round(offset / 100)) % count]
        signal = np.fft.ifft(cropped)
        integral = np.r_[0, np.cumsum(abs(signal) ** 2)]
        energy = integral[128:] - integral[:-128]
        correlation = abs(np.fft.ifft(matched * cropped, axis=1)[:, :len(energy)]) ** 2
        scores = correlation / np.maximum(energy[None, :] * ref_power[:, None], 1e-20)
        # Both occasions must correlate; max(min) avoids accepting one impulse.
        pairs = np.minimum(scores[:, :len(energy)-9600], scores[:, 9600:])
        nid, sample = np.unravel_index(np.argmax(pairs), pairs.shape)
        results.append({'offsetHz': int(offset), 'nid2': int(nid),
                        'score': float(pairs[nid, sample]), 'sample1920k': int(sample)})
    results.sort(key=lambda r: r['score'], reverse=True)
    # One result per local frequency peak, including distinct same-frequency PSS
    # only when their strongest ID differs across separate search windows.
    picked = []
    for result in results:
        if all(abs(result['offsetHz'] - other['offsetHz']) >= 100000 for other in picked):
            picked.append(result)
        if len(picked) == 8:
            break
    return picked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file')
    parser.add_argument('--rate', type=int, required=True)
    parser.add_argument('--center', type=float, default=0, help='Actual LO, Hz')
    parser.add_argument('--start-ms', type=float, default=200)
    parser.add_argument('--step', type=int, default=5000)
    parser.add_argument('--span', type=int, help='Search width, Hz')
    args = parser.parse_args()
    raw = np.memmap(args.file, mode='r', dtype='i1').reshape(-1, 2)
    first = round(args.start_ms * args.rate / 1000)
    values = raw[first:first + round(args.rate / 100)].astype(float)
    iq = values[:, 0] + 1j * values[:, 1]
    span = args.span or args.rate - 2000000
    for result in search(iq, args.rate, range(-span//2, span//2+1, args.step)):
        result['frequencyHz'] = args.center + result['offsetHz']
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
