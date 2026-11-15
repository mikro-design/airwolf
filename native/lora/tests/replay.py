# SPDX-License-Identifier: GPL-3.0-or-later
"""Replay actual native frame bounds with retained, unmodified trailing IQ.

Two chirps plus 100 us are capture context, not packet airtime. The receiver
needs its real lookahead; this test neither pads with invented IQ nor extends a
truncated transmission to force a successful decode.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from scipy.signal import resample_poly
import reference


def verify(binary):
    count = 0
    with tempfile.TemporaryDirectory(prefix='airwolf-lora-replay-') as directory:
        path = pathlib.Path(directory) / 'samples.ci8'

        def receive(raw, sf, bw, rate, inverted=False, sync=0x34, chunk=4093):
            raw.tofile(path)
            result = subprocess.run([binary, str(path), 'ci8', str(sf), str(bw),
                str(rate), format(sync, 'x'), '1', str(chunk), str(int(inverted))],
                text=True, capture_output=True, timeout=45)
            assert result.returncode == 0, (result.stdout, result.stderr)
            assert 'pipeline_resets=0' in result.stderr, result.stderr
            return [json.loads(line) for line in result.stdout.splitlines()]

        def replay(raw, sf, bw, rate, inverted=False, sync=0x34, negative=False, chunk=4093):
            nonlocal count
            original = receive(raw, sf, bw, rate, inverted, sync, chunk)
            assert len(original) == 1, (sf, bw, rate, original)
            frame = original[0]
            first, end = frame['firstSample'], frame['endSample']
            # An exact or short crop really fails; the context protects a
            # measured receiver dependency, rather than mirroring a formula.
            if negative:
                short_end = min(len(raw)//2, end + (rate + 9999)//10000)
                assert receive(raw[2*first:2*short_end], sf, bw, rate, inverted, sync) == []
            tail = 2 * (1 << frame['sf']) * rate // bw + (rate + 9999)//10000
            retained_end = frame['replayEndSample']
            assert end <= retained_end <= min(len(raw)//2, end + tail)
            # Captures ending during the required context remain unmodified.
            # The published recording has less than the conservative maximum
            # available, but its actual recorded remainder is sufficient.
            crop = raw[2*first:2*retained_end]
            received = receive(crop, sf, bw, rate, inverted, sync, chunk)
            assert len(received) == 1, (sf, bw, rate, frame, received, retained_end-end)
            actual = received[0]
            for key in ('bytes', 'sf', 'cr', 'bandwidth', 'crcPresent', 'crcValid',
                        'crcReceived', 'crcCalculated'):
                assert actual[key] == frame[key], (key, frame, actual)
            assert actual['endSample'] <= len(crop)//2
            count += 1

        def generated(sf, bw, rate, length=9, crc=True, corrupt=False,
                      inverted=False, sync=0x34, cfo=0):
            payload = [(index * 47 + sf) & 255 for index in range(length)]
            encoding = {}
            if corrupt:
                check = reference.checksum(payload)
                encoding['crc_bytes'] = [check[0] ^ 1, check[1]]
            base = reference.iq(payload, sf=sf, bw=bw, fs=4*bw,
                pad=1709, crc=crc, sync=sync, cfo=cfo, **encoding)
            if inverted:
                base = base.conjugate()
            signal = resample_poly(base, rate//(4*bw), 1).astype(np.complex64)
            signal[1::4] *= -1j
            signal[2::4] *= -1
            signal[3::4] *= 1j
            raw = np.clip(np.round(signal.view(np.float32)*70), -127, 127).astype(np.int8)
            replay(raw, sf, bw, rate, inverted, sync, negative=True)

        for bw in (125000, 250000, 500000):
            for sf in range(7, 13):
                generated(sf, bw, 8000000)
        for rate in (10000000, 16000000, 20000000):
            for sf, bw in ((7, 125000), (9, 250000), (12, 500000)):
                generated(sf, bw, rate)
        for crc, corrupt, inverted, sync in (
                (False, False, False, 0x34), (True, True, False, 0x34),
                (True, False, True, 0x34), (True, False, False, 0x12)):
            generated(9, 250000, 10000000, crc=crc, corrupt=corrupt,
                      inverted=inverted, sync=sync)
        for sf, bw in ((7, 125000), (12, 500000)):
            generated(sf, bw, 8000000, length=255)
        for cfo in (-20000, 20000):
            generated(9, 125000, 8000000, cfo=cfo)
        recorded = pathlib.Path(__file__).parent / 'fixtures' / 'hackrf-zero4.ci8'
        raw = np.fromfile(recorded, dtype=np.int8)
        replay(raw, 7, 125000, 10000000, negative=True)
        replay(raw, 0, 125000, 10000000)
        for chunk in (17, 255, 65537):
            replay(raw, 7, 125000, 10000000, chunk=chunk)
    print(f'{count} exact selected-frame LoRa IQ replays passed; original bytes/CRC '
          'preserved with bounded real trailing context, including public HackRF RF')


if __name__ == '__main__':
    verify(sys.argv[1])
