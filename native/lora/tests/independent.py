# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent transmit fixtures through the real native LoRa receive chain.

The MIT reference.py transmitter is translated from LoRaPHY, independently of
our gr-lora_sdr receiver. No receiver encoder, lookup table or CRC helper is used.
This verifies deterministic vectors, not measured hardware sensitivity.
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time

import numpy as np
from scipy.signal import resample_poly, resample
import reference


def verify(binary):
    published = [2541, 1153, 673, 2397, 1189, 3509, 41, 3089,
                 3237, 3917, 2729, 2765, 1417, 2833, 1389, 801,
                 3197, 345, 961, 745, 3101, 297, 1893, 469]
    # Published fixture's ignored padding nibbles, after payload and CRC.
    assert reference.symbols(list(range(1, 10)), 12, 4, padding=[3, 8, 13]) == published
    assert reference.checksum(list(range(1, 10))) == [0xba, 0x2e]
    rng = np.random.default_rng(0x90713)
    cases = 0
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='airwolf-lora-') as directory:
        path = pathlib.Path(directory) / 'samples.bin'

        def receive(signal, sf=7, bw=125000, rate=8000000, raw=False,
                    sync=0x34, offset=True, chunk=32768, allow_resets=False, inverted=False):
            nonlocal cases
            signal.tofile(path)
            result = subprocess.run([binary, str(path), 'ci8' if raw else 'cf32',
                str(sf), str(bw), str(rate), format(sync, 'x'), str(int(offset)), str(chunk), str(int(inverted))],
                check=False, text=True, capture_output=True, timeout=45)
            assert result.returncode == 0, (result.args, result.stdout, result.stderr)
            frames = [json.loads(line) for line in result.stdout.splitlines()]
            stats = {key: int(value) for key, value in re.findall(r'(\w+)=(\d+)', result.stderr)}
            assert stats['frames'] == len(frames), result.stderr
            assert stats['peak_buffered_bytes'] < 2 * 1024 * 1024, stats
            if not allow_resets:
                assert stats['pipeline_resets'] == 0, stats
            for frame in frames:
                assert frame['firstSample'] < frame['endSample'], frame
                if frame['crcPresent']:
                    calculated = reference.checksum(bytes.fromhex(frame['bytes']))
                    assert frame['crcCalculated'] == calculated[0] + 256*calculated[1]
                    assert frame['crcValid'] == (frame['crcReceived'] == frame['crcCalculated'])
                maximum = len(signal) // 2 if raw else len(signal) * rate // (4 * bw)
                assert frame['endSample'] <= maximum, (frame, maximum)
            cases += 1
            return frames, stats

        # PHY rate/BW/SF choices, random content and fractional symbol placement.
        for bw in (125000, 250000, 500000):
            for sf in range(7, 13):
                for cr in range(1, 5):
                    payload = rng.integers(0, 256, 23).tolist()
                    signal = reference.iq(payload, sf=sf, cr=cr, bw=bw, fs=4*bw,
                        pad=int(rng.integers(1, 4*(1 << sf))))
                    frames, _ = receive(signal, sf, bw)
                    assert len(frames) == 1, (sf, bw, cr, frames)
                    frame = frames[0]
                    assert frame['bytes'] == bytes(payload).hex(), (sf, bw, cr, frame)
                    assert frame['sf'] == sf and frame['cr'] == cr
                    assert frame['crcPresent'] and frame['crcValid']
                    assert frame['crcReceived'] == frame['crcCalculated']

        # Full signed-byte USB/channelizer path, all offered input sample rates,
        # narrow/wide CSS and fast/slow chirps. Fractional source timing changes.
        for rate in (8000000, 10000000, 16000000, 20000000):
            for sf, bw in ((7, 125000), (9, 250000), (12, 500000)):
                payload = [1, 2, 3, 4, 5, 6, 7, 8, 9]
                pad = 1709
                base = reference.iq(payload, sf=sf, bw=bw, fs=4*bw, pad=pad)
                signal = resample_poly(base, rate // (4*bw), 1).astype(np.complex64)
                # Wanted channel is -fs/4 relative to the receiver LO.
                signal[1::4] *= -1j
                signal[2::4] *= -1
                signal[3::4] *= 1j
                raw = np.clip(np.round(signal.view(np.float32)*70), -127, 127).astype(np.int8)
                frames, _ = receive(raw, sf, bw, rate, raw=True, chunk=4093)
                assert len(frames) == 1 and frames[0]['bytes'] == bytes(payload).hex()
                assert frames[0]['crcValid'], (rate, sf, bw, frames)
                nominal_start = pad * rate // (4*bw)
                assert frames[0]['firstSample'] <= nominal_start
                assert nominal_start - frames[0]['firstSample'] <= 1.1*(1 << sf)*rate/bw

        # Byte-length extremes, CRC absence and bad CRC are separate outcomes.
        for length in (1, 2, 127, 254, 255):
            payload = rng.integers(0, 256, length).tolist()
            for crc in (False, True):
                frames, _ = receive(reference.iq(payload, crc=crc))
                assert len(frames) == 1 and frames[0]['bytes'] == bytes(payload).hex()
                assert frames[0]['crcPresent'] == crc and frames[0]['crcValid'] == crc
            correct = reference.checksum(payload)
            frames, _ = receive(reference.iq(payload, crc_bytes=[correct[0] ^ 1, correct[1]]))
            assert len(frames) == 1 and frames[0]['bytes'] == bytes(payload).hex()
            assert frames[0]['crcPresent'] and not frames[0]['crcValid']
            assert frames[0]['crcReceived'] != frames[0]['crcCalculated']

        # Checksummed but reserved coding rates must be rejected before reaching
        # block-size-dependent demodulator/FEC arrays.
        for invalid_rate in (0, 5, 6, 7):
            frames, stats = receive(reference.iq([1, 2, 3], header_rate=invalid_rate))
            assert not frames and stats['rejected_headers'] >= 1, (invalid_rate, frames, stats)
        frames, stats = receive(reference.iq([1, 2, 3], header_checksum_error=True))
        assert not frames and stats['rejected_headers'] >= 1
        frames, _ = receive(reference.iq([]))
        assert not frames
        good = reference.iq([1, 2, 3, 4, 5])
        for cut in (0, 1, 7*512, 15*512, len(good)//2):
            frames, _ = receive(good[:cut])
            assert not frames, (cut, frames)

        # Public, private and Meshtastic (0x2B) sync words; a receiver set to
        # any other supported word yields no payload.
        for word, other in ((0x12, 0x34), (0x34, 0x2b), (0x2b, 0x12), (0x2b, 0x34)):
            frames, _ = receive(reference.iq([1, 2, 3], sync=word), sync=word)
            assert len(frames) == 1 and frames[0]['crcValid'], (hex(word), frames)
            frames, _ = receive(reference.iq([1, 2, 3], sync=word), sync=other)
            assert not frames, (hex(word), hex(other), frames)

        # Inverted downlink chirps must be an explicit physical choice.
        inverted = reference.iq([1, 2, 3]).conjugate()
        frames, _ = receive(inverted, inverted=True)
        assert len(frames) == 1 and frames[0]['bytes'] == '010203' and frames[0]['crcValid']
        frames, _ = receive(inverted)
        assert not frames
        # Independent CFO and below-noise-floor cases exercise synchronization,
        # including phase offsets that require look-behind across input chunks.
        for sf in (7, 9, 12):
            for cfo in (-20000, -5000, 0, 5000, 20000):
                payload = [sf, 7, 2, 91, 24, 62, 15]
                signal = reference.iq(payload, sf=sf, cfo=cfo, pad=777)
                frames, _ = receive(signal, sf=sf, chunk=4093)
                assert len(frames) == 1 and frames[0]['bytes'] == bytes(payload).hex() and frames[0]['crcValid'], (sf, cfo, frames)
        # The original shared-crystal model remains useful when RF and sample
        # clock errors are correlated; the alternate hypothesis must not regress it.
        for cfo in (-20000, -5000, 5000, 20000):
            payload = list(range(29))
            signal = reference.iq(payload, sf=12, cfo=cfo, pad=1709)
            signal = resample(signal, round(len(signal)*(1-cfo/868100000))).astype('<c8')
            frames, _ = receive(signal, sf=12)
            assert len(frames) == 1 and frames[0]['bytes'] == bytes(payload).hex() and frames[0]['crcValid'], (cfo, frames)
        # Deterministic malformed/noisy chirps exercise bounded acquisition and
        # explicit-header/FEC transitions under the sanitizer build too.
        for number in range(96):
            sf = int(rng.integers(7, 13))
            payload = rng.integers(0, 256, int(rng.integers(1, 90))).tolist()
            signal = reference.iq(payload, sf=sf, cr=int(rng.integers(1, 5)),
                cfo=float(rng.uniform(-30000, 30000)), pad=int(rng.integers(0, 4*(1 << sf))))
            if number % 3 == 0:
                begin = int(rng.integers(0, len(signal)))
                signal[begin:min(len(signal), begin + int(rng.integers(1, 2*(1 << sf))))] = 0
            elif number % 3 == 1:
                noise = rng.normal(0, 1, len(signal)) + 1j*rng.normal(0, 1, len(signal))
                signal = (signal + noise * float(rng.uniform(.1, 4))).astype('<c8')
            else:
                signal = signal[:int(rng.integers(1, len(signal)))]
            frames, _ = receive(signal, sf=sf, chunk=int(rng.integers(1, 16385)))
            assert all(not frame['crcValid'] or frame['bytes'] == bytes(payload).hex() for frame in frames)

        for sf, snr_db in ((7, -5), (12, -15)):
            parts = []
            for number in range(8):
                signal = reference.iq([sf, number, 2, 3, 7, 8, 9], sf=sf)
                noise = (rng.normal(0, 1, len(signal)) + 1j*rng.normal(0, 1, len(signal))) * np.sqrt(10**(-snr_db/10)/2)
                parts.append((signal + noise).astype('<c8'))
            frames, _ = receive(np.concatenate(parts), sf=sf)
            assert len(frames) == 8 and all(f['crcValid'] for f in frames), (sf, snr_db, frames)

        # Unknown SF uses a bounded six-receiver bank sharing one filtered input.
        parts = [reference.iq([sf, 2, 3], sf=sf) for sf in range(7, 13)]
        frames, _ = receive(np.concatenate(parts), sf=0)
        assert [(f['sf'], f['bytes']) for f in frames] == [(sf, bytes([sf, 2, 3]).hex()) for sf in range(7, 13)]
        assert all(f['crcValid'] for f in frames)
        noise = (rng.normal(0, 1, 2000000) + 1j*rng.normal(0, 1, 2000000)).astype('<c8')
        frames, _ = receive(noise, sf=0)
        assert not frames

        # Data arriving in tiny or irregular host batches produces identical bytes.
        for chunk in (1, 17, 4093, 65537):
            frames, _ = receive(good, chunk=chunk)
            assert len(frames) == 1 and frames[0]['bytes'] == '0102030405' and frames[0]['crcValid']
    print(f'{cases} independent LoRa receive cases passed in {time.monotonic()-started:.2f}s; '
          '72 SF/BW/CR combinations, all four USB rates, CRC/bounds/noise/header negatives')


if __name__ == '__main__':
    verify(sys.argv[1])
