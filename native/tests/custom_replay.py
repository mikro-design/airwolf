# IQ replay of custom formats finds exactly the frames live reception found:
# same bytes, sample positions and CRC result (native/tests/custom_gfsk_test.cpp
# --write saves the recordings and the live results).
import json, pathlib, subprocess, sys, tempfile

tests, iq = sys.argv[1], sys.argv[2]
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run([tests, '--write', tmp], check=True, capture_output=True, timeout=300)
    for name in ('gfsk', 'oqpsk'):
        case = json.loads((pathlib.Path(tmp) / f'{name}.json').read_text())
        frequency = 868300000
        lo = frequency + case['rate'] // 4  # the recordings are tuned a quarter rate above the channel
        run = subprocess.run([iq, 'decode', str(pathlib.Path(tmp) / f'{name}.ci8'), '0', str(case['samples']), 'custom',
                              str(case['rate']), str(frequency), str(lo), '1m', '0', '0', case['options']],
                             capture_output=True, text=True, timeout=120)
        assert run.returncode == 0, run.stderr
        replay = json.loads(run.stdout)['packets']
        live = case['packets']
        assert len(live) >= 12, (name, len(live))
        got = [(p['firstSample'], p['endSample'], p['integrity'], p['bytes']) for p in replay]
        want = [(p['firstSample'], p['endSample'], p['integrity'], p['bytes']) for p in live]
        assert got == want, (name, got[:2], want[:2])
        assert all(p['protocol'] == 'custom' and p['channel'] == 0 and p['customSyncErrors'] == 0 for p in replay), replay[:1]
        print(f'{name}: {len(replay)} frames replayed identically to live reception', flush=True)
