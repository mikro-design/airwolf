"""DSSS/CCK acquisition after a brief preamble fade and exact original-IQ replay.

Independent generated payloads only; no private recorded traffic is committed.
The fade reproduces a live CCK frame lost when its excerpt starts at a different
sample phase. Every result must match the original bytes and independent FCS.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zlib

import numpy as np
from wifi_dsss import frame, iq

worker = str(Path(sys.argv[1]).resolve())


def decode(file, first=0, count=None):
    count = file.stat().st_size // 2 - first if count is None else count
    run = subprocess.run([
        worker, 'decode', str(file), str(first), str(count), 'wifi', '20000000',
        '2462000000', '2462000000', '1m', '2391391958', '5592405',
    ], capture_output=True, text=True, check=True, timeout=20)
    return json.loads(run.stdout)['packets']


with tempfile.TemporaryDirectory(prefix='airwolf-dsss-replay-') as directory:
    file = Path(directory) / 'generated.iq'
    cases = 0
    for rate, short in [(1, False), (2, False), (2, True), (5.5, False),
                        (5.5, True), (11, False), (11, True)]:
        expected = frame(336)
        assert zlib.crc32(expected[:-4]) == int.from_bytes(expected[-4:], 'little')
        waveform = iq(expected, rate, short, fraction=.37, cfo=100000, noise=1)
        # One microsecond fade late in sync, then enough intact sync/SFD/header
        # to acquire. The old receiver lost the frame at every PHY/preamble.
        start = 512 + ((56 if short else 128) - 32) * 20
        waveform[2 * start:2 * (start + 20)] = 0
        for phase in range(20):
            np.r_[np.zeros(2 * phase, np.int8), waveform].tofile(file)
            packets = decode(file)
            assert len(packets) == 1, (rate, short, phase, packets)
            p = packets[0]
            assert p['integrity'] == 'valid' and bytes(p['bytes']) == expected
            assert p['wifiRateMbps'] == rate
            # No extra samples, padding or packet annotations are supplied.
            exact = decode(file, p['firstSample'], p['endSample'] - p['firstSample'])
            assert len(exact) == 1, (rate, short, phase, 'exact excerpt', exact)
            assert bytes(exact[0]['bytes']) == expected and exact[0]['integrity'] == 'valid'
            assert p['firstSample'] <= exact[0]['firstSample'] < exact[0]['endSample'] <= p['endSample']
            cut = (p['firstSample'] + p['endSample']) // 2
            assert not decode(file, p['firstSample'], cut - p['firstSample'])
            cases += 1
        print(f'{rate} Mb/s {"short" if short else "long"}: 20 sample phases, exact replay and truncation passed', flush=True)
    print(f'{cases} faded-preamble acquisition and original-IQ replay cases passed')
