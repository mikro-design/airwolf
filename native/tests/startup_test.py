"""DSP setup must finish before USB can fill the bounded sample queue."""
import json, os, subprocess, sys
binary = sys.argv[1]
args = [binary, '--decoder', 'none', '--frequency', '2402000000', '--sample-rate', '8000000', '--duration-ms', '2000']
r = subprocess.run(args, input='', capture_output=True, text=True, timeout=8,
                   env={**os.environ, 'AIRWOLF_FAKE_DSP_INIT_DELAY_MS': '1500'})
assert r.returncode == 0, r.stderr
spectra = [e for line in r.stdout.splitlines() if (e := json.loads(line))['type'] == 'spectrum']
assert spectra and spectra[0]['firstSample'] == 0, r.stderr
assert all(e['queueDroppedSamples'] == 0 for e in spectra), r.stderr
assert 'queue_dropped_samples=0 ' in r.stderr, r.stderr
r = subprocess.run(args, input='', capture_output=True, text=True, timeout=8,
                   env={**os.environ, 'AIRWOLF_FAKE_DSP_INIT_FAIL': '1'})
assert r.returncode == 1 and 'Injected DSP initialization failure' in r.stderr, r.stderr
assert 'start=' not in r.stderr, r.stderr
print('Delayed DSP initialization: zero sample drops; setup failure: no USB streaming, clean exit')
