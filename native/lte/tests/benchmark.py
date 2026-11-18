"""Wall-clock LTE acquisition and broadcast reception, with optional CPU load.

The transmitter shares srsRAN with production. These are throughput and queue
checks, not independent PHY conformance or hardware reception evidence.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly
from channel_signal import gen

parser = argparse.ArgumentParser()
parser.add_argument('build', type=Path)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--load-processes', type=int, default=0)
parser.add_argument('--require-realtime', action='store_true')
parser.add_argument('--repetitions', type=int, default=1)
args = parser.parse_args()
if not 0 <= args.load_processes <= (os.cpu_count() or 1):
    parser.error('Load processes must be between zero and the logical CPU count')
if not 1 <= args.repetitions <= 100:
    parser.error('Repetitions must be 1..100')
build = args.build.resolve() / 'lte'
exe = '.exe' if os.name == 'nt' else ''
worker = build / ('airwolf-lte-si-stream-feed' + exe)
reports = []

with tempfile.TemporaryDirectory(prefix='airwolf-lte-perf-') as directory:
    directory = Path(directory)
    for name, rate, seconds in [('search-without-pbch', 8000000, 2.56),
                                ('broadcast-20msps', 20000000, 3.2)]:
        iq = directory / 'signal.iq'
        if name == 'search-without-pbch':
            cf = directory / 'signal.cf32'
            subprocess.run([str(build / ('airwolf-lte-fixture' + exe)), str(cf),
                            '42', '6', str(round(seconds*1000)), '0', '2', 'no-pbch'],
                           check=True, capture_output=True)
            signal = resample_poly(np.fromfile(cf, np.complex64), 25, 6)
            signal *= 20 / np.sqrt(np.mean(abs(signal)**2))
            rng = np.random.default_rng(525)
            samples = np.column_stack((signal.real, signal.imag))
            samples += rng.normal(0, .1, samples.shape)
            np.clip(np.rint(samples), -127, 127).astype(np.int8).tofile(iq)
            del signal, samples
        else:
            gen(build / ('airwolf-lte-si-fixture' + exe), iq, rate, 100,
                round(seconds*1000), 30, ports=2, seed=525)
        load = []
        try:
            for _ in range(args.load_processes):
                load.append(subprocess.Popen([sys.executable, '-c',
                    'import math\nx=1.0\nwhile True: x=math.sin(x)+1.0'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            run = subprocess.run([str(worker), str(rate), str(iq), 'live', '0', '0', str(args.repetitions)],
                                 capture_output=True, text=True, timeout=120)
        finally:
            for child in load:
                child.terminate()
            for child in load:
                child.wait(timeout=10)
        assert run.returncode in (0, 1), run.stderr
        packets = [json.loads(line) for line in run.stdout.splitlines()]
        metrics = {}
        for token in run.stderr.split():
            if '=' in token:
                key, value = token.split('=', 1)
                try:
                    metrics[key] = float(value)
                except ValueError:
                    pass
        assert 'cpu_seconds' in metrics, run.stderr
        if name == 'search-without-pbch':
            exact = len(packets) == 0
        else:
            expected = {
                '6040040300011a2d4018028180420c8000000000000000000000000000000000',
                '000149001250400800094000a03f01000a7fc9800104286c000c000000000000',
            }
            si = [p for p in packets if p['kind'] == 'si']
            exact = len(si) >= 60*args.repetitions and {p['data'] for p in si} == expected
            exact &= all(p['pci'] == 42 and p['prb'] == 100 and p['ports'] == 2
                         for p in packets)
        seconds *= args.repetitions
        passed = (exact and metrics['dropped_samples'] == 0 and
                  metrics['broadcast_queue_drops'] == 0 and
                  metrics['elapsed_seconds'] < seconds * 1.2)
        report = dict(case=name, rate=rate, seconds=seconds, packets=len(packets),
                      exact=exact, cpuPercentOneCore=100*metrics['cpu_seconds']/seconds,
                      passed=passed, **metrics)
        reports.append(report)
        print(json.dumps(report), flush=True)

report = dict(platform=platform.platform(), machine=platform.machine(),
              loadProcesses=args.load_processes, runs=reports,
              passed=all(r['passed'] for r in reports))
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
if args.require_realtime:
    assert report['passed'], 'LTE missed the wall-clock gate; see benchmark report'
