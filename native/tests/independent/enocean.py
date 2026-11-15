# Independent continuous-phase ERP2 FSK/GFSK reference, no production helpers.
# The complete emitted bytes and every CRC bit are constructed in this file.
import pathlib
import re
import subprocess
import sys
import tempfile

import numpy as np
from scipy.ndimage import gaussian_filter1d

BIT_RATE = 125000


def checksum(data):
    value = 0
    for byte in data:
        for bit in range(7, -1, -1):
            feedback = (value >> 7) ^ ((byte >> bit) & 1)
            value = (value << 1) & 255
            if feedback:
                value ^= 7
    return value


def signal(frame, rate, rng, cfo=0, eb_n0=100, bt=.5, deviation=62500,
           ppm=0, sync=0xa93c, amplitude=20):
    # Literal MSB-first preamble/sync; Gaussian FIR applied to the NRZ level
    # before integrating instantaneous frequency into continuous complex phase.
    prefix = bytes([0xaa, 0xaa, sync >> 8, sync & 255])
    bits = np.unpackbits(np.frombuffer(prefix + frame, dtype=np.uint8)).astype(float)*2-1
    samples_per_bit = rate/(BIT_RATE*(1 + ppm*1e-6))
    start = rate*.000125 + rng.uniform(0, samples_per_bit)
    count = int(start + samples_per_bit*len(bits) + rate*.0005)
    # Keep concatenation aligned to the quarter-rate hardware LO offset.
    count = (count + 3)//4*4
    at = np.arange(count)
    bit_index = np.floor((at-start)/samples_per_bit).astype(int)
    active = (bit_index >= 0) & (bit_index < len(bits))
    levels = bits[np.clip(bit_index, 0, len(bits)-1)]
    if bt:
        sigma = np.sqrt(np.log(2))/(2*np.pi*bt)*samples_per_bit
        levels = gaussian_filter1d(levels, sigma, mode='nearest', truncate=5)
    phase = np.cumsum(2*np.pi*(cfo + deviation*levels)/rate)
    iq = amplitude*active*np.exp(1j*phase)
    noise = amplitude*np.sqrt(rate/(2*BIT_RATE*10**(eb_n0/10)))
    iq += noise*(rng.normal(size=count) + 1j*rng.normal(size=count))
    iq *= np.exp(-1j*np.pi/2*(at % 4))
    raw = np.clip(np.rint(np.column_stack([iq.real, iq.imag])), -127, 127).astype(np.int8).ravel()
    return raw


def verify(binary):
    known = bytes.fromhex('0a22008045d8555555554d')
    assert checksum(known[1:-1]) == 0x4d
    rng = np.random.default_rng(0xe0ce2)
    cases = packets = 0
    with tempfile.TemporaryDirectory(prefix='airwolf-erp2-') as directory:
        path = pathlib.Path(directory)/'samples.ci8'

        def receive(raw, rate, sample_count=None):
            nonlocal cases
            if raw is not None:
                raw.tofile(path)
                sample_count = len(raw)//2
            result = subprocess.run([binary, 'enocean2', '0', str(rate),
                '1m', '8e89bed6', '555555', str(path)],
                text=True, capture_output=True, timeout=45)
            assert result.returncode == 0, (result.stdout, result.stderr)
            frames = [bytes.fromhex(line.split()[-1]) for line in result.stdout.splitlines()]
            for line in result.stdout.splitlines():
                first, end = [int(value) for value in line.split()[:2]]
                assert 0 <= first < end <= sample_count, (line, sample_count)
            stats = {key: int(value) for key, value in re.findall(r'(cand|crcfail)=(\d+)', result.stderr)}
            cases += 1
            return frames, stats

        def batch(rate, count, length=9, **kwargs):
            nonlocal packets
            expected, samples = [], []
            for _ in range(count):
                data = bytes([0x22]) + rng.integers(0, 256, length-1, dtype=np.uint8).tobytes()
                frame = bytes([len(data)+1]) + data + bytes([checksum(data)])
                expected.append(frame)
                samples.append(signal(frame, rate, rng, **kwargs))
            got, stats = receive(np.concatenate(samples), rate)
            correct = sum(frame in expected for frame in got)
            packets += count
            assert len(got) <= count, (kwargs, count, len(got))
            return correct, stats

        # Literal published bytes, each source rate and modulation/deviation.
        for rate in (8000000, 10000000, 16000000, 20000000):
            for bt in (0, .5):
                for cfo in (-50000, -36000, 0, 36000, 50000):
                    for deviation in (55000, 70000):
                        got, stats = receive(signal(known, rate, rng, cfo=cfo,
                            bt=bt, deviation=deviation), rate)
                        assert got == [known] and stats['crcfail'] == 0, (rate, bt, cfo, deviation, got)

        # The offset cases previously collapsed even at 18dB. A conservative
        # exact-byte gate includes fractional timing, both polarities and AWGN.
        for rate in (8000000, 10000000, 16000000, 20000000):
            for bt in (0, .5):
                for cfo in (-50000, -36000, 0, 36000, 50000):
                    correct, stats = batch(rate, 24, bt=bt, cfo=cfo, eb_n0=18)
                    assert correct >= 23, (rate, bt, cfo, correct, stats)

        # Clock difference exceeds the specified transmitter-only64ppm bound.
        # Maximum ERP2 DATA_PL length and long repeated levels stress timing.
        for rate in (8000000, 10000000, 16000000, 20000000):
            for ppm in (-84, 84):
                correct, stats = batch(rate, 6, length=254, ppm=ppm, cfo=36000,
                    bt=.5, deviation=55000)
                assert correct == 6 and stats['crcfail'] == 0, (rate, ppm, correct, stats)
        corrupt = known[:-1] + bytes([known[-1] ^ 1])
        got, stats = receive(signal(corrupt, 8000000, rng, cfo=-50000), 8000000)
        assert got == [corrupt] and stats['crcfail'] == 1
        for sync in (0xa93d, 0x593c, 0x0000, 0xffff):
            assert receive(signal(known, 8000000, rng, sync=sync), 8000000)[0] == []
        assert receive(signal(b'\x00', 8000000, rng), 8000000)[0] == []
        complete = signal(known, 8000000, rng)
        for keep in (.1, .3, .5):
            assert receive(complete[:int(len(complete)*keep)//2*2], 8000000)[0] == []
        # Pure noise at both extreme input rates must create no rows or sync
        # candidates; this exercises the CFO-invariant synchronization guard.
        for rate in (8000000, 20000000):
            with path.open('wb') as output:
                remaining = rate*4*2
                while remaining:
                    count = min(remaining, 262144)
                    noise = np.clip(np.rint(rng.normal(0, 20, count)), -127, 127).astype(np.int8)
                    output.write(noise.tobytes())
                    remaining -= count
            got, stats = receive(None, rate, sample_count=rate*4)
            assert not got and stats == {'cand': 0, 'crcfail': 0}, (rate, got, stats)
    print(f'{cases} independent ERP2 receive cases passed; {packets} randomized packets, '
          'all USB rates, FSK/GFSK, frequency/clock/noise and exact CRC boundaries')


if __name__ == '__main__':
    verify(sys.argv[1])
