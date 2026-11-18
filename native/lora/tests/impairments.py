"""Independent LoRaPHY symbols: weak signals and stronger overlapping packets."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import numpy as np
import reference

worker = str(Path(sys.argv[1]).resolve())
bw = 125000

def noise(signal, snr, rng):
    sigma = np.sqrt(4 * 10**(-snr/10) / 2) # Noise over fs=4*BW; SNR is in-band.
    return (signal + rng.normal(0,sigma,len(signal)) +
            1j*rng.normal(0,sigma,len(signal))).astype('<c8')

def receive(path, signal, sf):
    signal.tofile(path)
    run = subprocess.run([worker,str(path),'cf32',str(sf),str(bw),'8000000','34','1','32768','0'],
                         check=True,capture_output=True,text=True,timeout=60)
    assert not any(s in run.stderr for s in ('runtime error:','AddressSanitizer','UndefinedBehaviorSanitizer')),run.stderr
    return [p['bytes'] for p in map(json.loads,run.stdout.splitlines()) if p['crcValid']]

with tempfile.TemporaryDirectory(prefix='airwolf-lora-impairments-') as directory:
    file = Path(directory)/'signal.cf32'
    for sf, snr in ((7,-6),(9,-12),(12,-20)):
        rng = np.random.default_rng(sf*100+int(snr*10))
        parts, expected = [], []
        for _ in range(20):
            payload = rng.integers(0,256,16).tolist(); expected.append(bytes(payload).hex())
            parts.append(reference.iq(payload,sf=sf,cr=1,bw=bw,fs=4*bw,
                                      pad=int(rng.integers(100,4*(1<<sf)))))
        signal = noise(np.concatenate(parts),snr,rng)
        for mode in (sf,0):
            received = receive(file,signal,mode)
            assert len(set(received)&set(expected))>=19,(sf,snr,mode,len(received))
            assert set(received)<=set(expected),(sf,received)
        print(f'SF{sf}, {snr} dB in-band: >=19/20 exact frames, fixed SF and bank',flush=True)
    for sf in (7,9):
        a = bytes([1]*3+list(range(13))); b = bytes([2]*3+list(range(13)))
        earlier = reference.iq(list(a),sf=sf,cr=1,bw=bw,fs=4*bw,pad=500)
        later = reference.iq(list(b),sf=sf,cr=1,bw=bw,fs=4*bw,pad=0)
        for db in (6,10):
            offset = len(earlier)//2
            signal = np.zeros(max(len(earlier),offset+len(later)),complex)
            signal[:len(earlier)] += earlier
            signal[offset:offset+len(later)] += later*10**(db/20)
            signal = noise(signal,10,np.random.default_rng(77))
            for mode in (sf,0):
                received = receive(file,signal,mode)
                assert b.hex() in received,(sf,db,mode,received)
                assert set(received)<={a.hex(),b.hex()},received
            print(f'SF{sf}: later packet +{db} dB captured with exact CRC/bytes',flush=True)
