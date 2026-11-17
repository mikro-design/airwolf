"""Unpaced GPS throughput plus wall-clock USB/filter/spectrum/retained-IQ reception.

No controlled sample clock. Reports overruns explicitly on shared CI runners.
Pass --require-realtime to require zero drops and exact navigation from the
independent generated waveform. This is a benchmark, not a hardware RF claim.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
from gps_signal import generate

parser = argparse.ArgumentParser()
parser.add_argument('benchmark')
parser.add_argument('transport')
parser.add_argument('--output', required=True)
parser.add_argument('--require-realtime', action='store_true')
parser.add_argument('--profile', action='store_true')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='airwolf-gps-perf-') as tmp:
    file = Path(tmp) / 'generated.iq'
    expected = generate(file)
    run = subprocess.run([args.benchmark, str(file)], check=True,
                         capture_output=True, text=True, timeout=120)
    dsp = json.loads(run.stdout)
    env = {k: v for k, v in os.environ.items() if not k.startswith('AIRWOLF_FAKE_')}
    env['AIRWOLF_FAKE_IQ_FILE'] = str(file)
    command = [args.transport, '--decoder', 'gps', '--frequency', '1575420000',
               '--sample-rate', '8000000', '--duration-ms', '16000', '--retain-iq']
    if args.profile:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        child = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        profiler = subprocess.Popen(['/usr/bin/sample', str(child.pid), '14', '5',
                                     '-mayDie', '-file', str(output.with_suffix('.sample.txt'))],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        stdout, stderr = child.communicate(input='', timeout=120)
        _, profile_error = profiler.communicate(timeout=30)
        print('Profiler exit:', profiler.returncode, profile_error, flush=True)
        run = subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
    else:
        run = subprocess.run(command, env=env, input='', capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    events = [json.loads(line) for line in run.stdout.splitlines()]
    spectra = [e for e in events if e['type'] == 'spectrum']
    packets = [e for e in events if e['type'] == 'packet']
    assert spectra, run.stderr
    drops = max(s['queueDroppedSamples'] for s in spectra)
    # The shutdown statistic includes any drops after the final spectrum update.
    for token in run.stderr.split():
        if token.startswith('queue_dropped_samples='):
            drops = max(drops, int(token.split('=')[1]))
    exact = any(p['bytes'] == expected['bytes'] and p['gpsPrn'] == 17 for p in packets)
    report = dict(profiled=args.profile, platform=platform.platform(), machine=platform.machine(), dsp=dsp,
                  realtime=dict(durationSeconds=16, spectra=len(spectra), frames=len(packets),
                                droppedSamples=drops, exactNavigation=exact,
                                passed=drops == 0 and exact))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    if args.require_realtime:
        assert report['realtime']['passed'], 'Unrestricted real-time GPS failed; see benchmark report'
