# SPDX-License-Identifier: GPL-3.0-or-later
import hashlib
import json
import pathlib
import subprocess
import sys


def verify(binary):
    root = pathlib.Path(__file__).parent / 'fixtures'
    source = json.loads((root / 'sources.json').read_text())
    path = root / source['file']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source['sha256']
    for sf in (7, 0):
        for chunk in (4093, 32768, 65537):
            result = subprocess.run([binary, str(path), 'ci8', str(sf), '125000',
                '10000000', '34', '1', str(chunk)], text=True, capture_output=True, timeout=30)
            assert result.returncode == 0, result.stderr
            frames = [json.loads(line) for line in result.stdout.splitlines()]
            assert len(frames) == 1, (result.stdout, result.stderr)
            frame = frames[0]
            assert frame['bytes'] == source['expectedPayload'] and frame['sf'] == 7
            assert frame['cr'] == source['expectedCodingRate']
            assert frame['crcPresent'] and frame['crcValid']
            assert frame['crcReceived'] == 0 and frame['crcCalculated'] == 0
            assert 0 <= frame['firstSample'] < frame['endSample'] <= path.stat().st_size // 2
            assert 'pipeline_resets=0' in result.stderr
    print('Public HackRF LoRa RF crop: exact payload/CRC/bounds through the full ci8 receive chain, six chunk/SF cases')


if __name__ == '__main__':
    verify(sys.argv[1])
