"""Opt-in-by-execution RX hardware check. Never included in unattended CI/CTest."""
import argparse
import datetime
import json
import math
import pathlib
import platform
import re
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description='Receive-only native HackRF acceptance test')
parser.add_argument('--binary', default='native/build/bin/airwolf-radio')
parser.add_argument('--seconds', type=int, default=30)
parser.add_argument('--output', default='docs/hardware-validation.json')
args = parser.parse_args()
if not 5 <= args.seconds <= 300:
    parser.error('--seconds must be between 5 and 300')
probe = subprocess.run([args.binary, '--list'], capture_output=True, text=True, timeout=5, check=True)
device = json.loads(probe.stdout)
if not device['available']:
    raise SystemExit('No HackRF detected; hardware test was not run.')
serial = device['serials'][0]
report = {
    'tested_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'host': platform.platform(),
    'device_serial_suffix': serial[-8:],
    'frequency_hz': 2425000000,
    'lna_db': 16,
    'vga_db': 20,
    'rf_amplifier': False,
    'antenna_power': False,
    'receive_only': True,
    'results': [],
    'limits': 'Host queue drops only; no hardware timestamps, end-to-end USB loss proof, calibration, packet decoding, or other-OS validation.',
}


def counters(stderr):
    values = dict(re.findall(r'(delivered_samples|queue_dropped_samples|malformed_transfers)=(\d+)', stderr))
    if len(values) != 3:
        raise RuntimeError('Native receiver did not report final counters: ' + stderr)
    return {key: int(value) for key, value in values.items()}


def validate(events, rate, seconds, stats):
    assert len(events) >= 2, 'No sustained spectrum output'
    previous = -1
    for event in events:
        assert event['version'] == 1 and event['type'] == 'spectrum'
        assert event['synthetic'] is False, 'A hardware test must not consume synthetic data'
        assert len(event['bins']) == 2048 and all(math.isfinite(n) and -120 <= n <= 10 for n in event['bins'])
        assert len(event['meanBins']) == 2048
        assert all(math.isfinite(mean) and -120 <= mean <= peak + .02 for mean, peak in zip(event['meanBins'], event['bins']))
        assert event['samples'] > previous, 'Sample counter did not advance'
        assert event['spectrumWindows'] > 0
        assert event['endSample'] - event['firstSample'] == 2048 + (event['spectrumWindows'] - 1) * event['spectrumHopSamples']
        assert event['endSample'] <= event['samples']
        previous = event['samples']
    assert stats['delivered_samples'] >= rate * seconds * 0.9, 'Sample throughput below 90% of requested rate'
    assert stats['queue_dropped_samples'] == 0, 'Acquisition queue dropped samples'
    assert stats['malformed_transfers'] == 0, 'Malformed USB transfers'


def capture(rate, seconds, stall=False):
    command = [args.binary, '--serial', serial, '--frequency', '2425000000', '--sample-rate', str(rate),
               '--lna', '16', '--vga', '20', '--duration-ms', str(seconds * 1000)]
    start = time.monotonic()
    with tempfile.TemporaryFile(mode='w+b') as output:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE if stall else output, stderr=subprocess.PIPE)
        try:
            if stall:
                # Let the stdout pipe fill; raw IQ must keep flowing in the native process.
                time.sleep(seconds + 0.4)
                raw, errors = process.communicate(timeout=10)
            else:
                process.wait(timeout=seconds + 10)
                errors = process.stderr.read()
                process.stdin.close()
                output.seek(0)
                raw = output.read()
            elapsed = time.monotonic() - start
            errors = errors.decode()
            if process.returncode != 0:
                raise RuntimeError(errors)
            events = [json.loads(line) for line in raw.splitlines()]
            stats = counters(errors)
            validate(events, rate, seconds, stats)
            first, last = events[0], events[-1]
            span = (last['time'] - first['time']) / 1000
            observed = (last['samples'] - first['samples']) / span if span else None
            result = {
                'mode': 'stalled_output' if stall else 'continuous_output',
                'requested_samples_per_second': rate,
                'requested_seconds': seconds,
                'wall_seconds': round(elapsed, 3),
                'spectrum_events': len(events),
                'observed_rate_between_publications': round(observed) if observed is not None and not stall else None,
                'display_snapshots_replaced': max(event['displaySkipped'] for event in events),
                **stats,
            }
            report['results'].append(result)
            pathlib.Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps(result), flush=True)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


capture(8000000, args.seconds)
capture(20000000, args.seconds)
capture(20000000, 5, stall=True)
print('Hardware RX checks passed; report: ' + args.output, flush=True)
