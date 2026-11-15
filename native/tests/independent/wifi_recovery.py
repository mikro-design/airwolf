"""Controlled pilot interference, independent MAC CRC and recovery-work bounds.

An asynchronous narrowband interferer appears after the L-LTF and falls on a
pilot bin. This is deliberately harder than ordinary AWGN; no receiver helper
or tentative decoded bits are used to construct the waveform or expected PSDU.
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

import numpy as np
from wifi import packet, waveform


def interfered(payload, rate, pilot, seed, level=.02):
    rng = np.random.default_rng(seed)
    x = waveform(payload, rate)
    n = np.arange(len(x))
    x += (n >= 400) * level * np.exp(2j*np.pi*pilot*n/64 + 1j*rng.uniform(-np.pi, np.pi))
    x = np.r_[np.zeros(256), x, np.zeros(700)]
    x *= 70 / max(abs(x))
    x += .3 * (rng.normal(size=len(x)) + 1j*rng.normal(size=len(x)))
    raw = np.empty(len(x)*2, np.int8)
    raw[::2] = np.round(x.real)
    raw[1::2] = np.round(x.imag)
    return raw


def run(binary, benchmark):
    recovered = {}
    with tempfile.TemporaryDirectory(prefix='airwolf-wifi-recovery-') as directory:
        file = pathlib.Path(directory) / 'pilot.iq'
        expected = packet(512)
        # Counts cover all four pilot positions and three asynchronous phases.
        # They describe this fixed impairment only, not calibrated sensitivity.
        for rate, minimum in [(6, 12), (12, 9), (24, 6), (36, 2), (48, 1), (54, 1)]:
            valid = 0
            for pilot in [-21, -7, 7, 21]:
                for seed in range(3):
                    interfered(expected, rate, pilot, seed).tofile(file)
                    result = subprocess.run([binary, str(file)], capture_output=True, text=True, check=True)
                    for row in map(str.split, result.stdout.splitlines()):
                        if row[3] == '1':
                            assert row[2:] == [str(rate), '1', expected.hex()], ('invented valid payload', rate)
                            valid += 1
            assert valid >= minimum, (rate, valid, minimum)
            recovered[rate] = valid
        # A valid convolutional codeword with a deliberately incorrect MAC FCS
        # must stay failed, without spending three decodes on an exact path.
        damaged = bytearray(packet(4095))
        damaged[60] ^= 1
        for rate in [6, 24, 54]:
            interfered(damaged, rate, -7, 0, level=0).tofile(file)
            result = subprocess.run([binary, str(file)], capture_output=True, text=True, check=True)
            rows = list(map(str.split, result.stdout.splitlines()))
            assert len(rows) == 1 and rows[0][2:] == [str(rate), '0', damaged.hex()], ('bad FCS', rate)
            assert 'recovery_attempts=0 ' in result.stderr, ('needless retries', rate, result.stderr)
        # Persistent difficult maximum PSDUs exercise the deterministic token
        # budget, independently of CPU speed and the machine running CI.
        interfered(packet(4095), 54, -21, 2, level=.12).tofile(file)
        result = subprocess.run([benchmark, str(file), '100', 'spectrum'], capture_output=True, text=True, check=True)
        stats = json.loads(result.stdout)
        bits = 16 + 8*4095 + 6
        assert stats['recoveryAttempts'] * bits * 16 <= 2*bits*16 + stats['samples'], stats
        assert stats['recoveryBudgetSkips'] > 0, stats
    print(json.dumps({'pilot_interference_recovered_of_12': recovered, 'recovery_work_bound': stats, 'result': 'passed'}))


if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2])
