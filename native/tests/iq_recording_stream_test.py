"""Production native controller -> bounded IQ take, without hardware."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
with tempfile.TemporaryDirectory(prefix='airwolf-iq-record-') as directory:
    target = Path(directory)/'native take.iq'
    count = 300003
    run = subprocess.run([sys.argv[1], '--simulate', '--sample-rate', '20000000', '--record-iq', str(target), '--record-samples', str(count)], capture_output=True, timeout=10)
    assert run.returncode == 0, run.stderr
    events = [json.loads(line) for line in run.stdout.splitlines()]
    recordings = [e for e in events if e['type'] == 'iq-recording']
    assert len(recordings) == 1
    result = recordings[0]
    assert result['error'] == '' and result['reason'] == 'limit'
    assert result['samples'] == count and result['firstSample'] == 0 and result['endSample'] == count
    assert result['queueDroppedSamples'] == 0
    iq = np.frombuffer(target.read_bytes(), np.int8).reshape(-1, 2)
    assert len(iq) == count
    phase = 2*np.pi*128*np.arange(count)/2048
    expected = np.column_stack((np.round(64*np.cos(phase)), np.round(64*np.sin(phase)))).astype(np.int8)
    assert np.array_equal(iq, expected), 'Recording changed original IQ bytes'
    original = target.read_bytes()
    refused = subprocess.run([sys.argv[1], '--simulate', '--record-iq', str(target), '--record-samples', '10'], capture_output=True, timeout=5)
    assert refused.returncode != 0 and target.read_bytes() == original
print('Native IQ recording auto-stop, exact original bytes, metadata and overwrite protection passed.')
