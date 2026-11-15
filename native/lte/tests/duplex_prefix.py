# SPDX-License-Identifier: AGPL-3.0-or-later
"""TDD/extended-CP integration. PHY TX is shared; grid timing is separately mapped."""
import json
import math
from pathlib import Path
import checked_subprocess as subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly

fixture, decoder, native = sys.argv[1:4]
rates={6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
expected=bytes.fromhex('6040040300011a2d4018028180420c800000').ljust(32,b'\0').hex()
rng=np.random.default_rng(0xC02026)

def generate(path,prb,ports,tdd,cp,duration=160,cfi=None):
    if cfi is None:cfi=3
    subprocess.run([fixture,str(path),str(prb),'42',str(ports),str(duration),'normal',str(tdd),str(cp),str(cfi)],check=True,capture_output=True)

def receive(path,prb,ports,tdd,cp,cfo=0):
    result=subprocess.run([decoder,str(path),str(prb),'42',str(ports),str(cfo),str(tdd),str(cp)],capture_output=True,text=True,timeout=30)
    assert result.returncode in (0,1),(result.returncode,result.stderr[-1000:])
    frames=[json.loads(line) for line in result.stdout.splitlines()]
    assert all(f['data']==expected for f in frames),frames
    return frames

with tempfile.TemporaryDirectory(prefix='airwolf-lte-duplex-') as directory:
    path=Path(directory)/'signal.cf32'
    for tdd,cp in ((1,0),(0,1),(1,1)):
        for prb in rates:
            for ports in (1,2,4):
                generate(path,prb,ports,tdd,cp)
                frames=receive(path,prb,ports,tdd,cp)
                assert len(frames)==7,(prb,ports,tdd,cp,len(frames))
        print(f'TDD={tdd}, extended CP={cp}: six bandwidths × three port counts, seven exact blocks each',flush=True)
        for prb in (6,100):
            generate(path,prb,2,tdd,cp,240)
            raw=np.fromfile(path,np.complex64)
            raw=np.fft.ifft(np.fft.fft(raw)*np.exp(-2j*np.pi*np.fft.fftfreq(len(raw))*.37))
            x=np.r_[np.zeros(871),raw]
            x*=np.exp(2j*np.pi*31500*np.arange(len(x))/rates[prb])
            sigma=np.sqrt(np.mean(abs(x)**2)/200)
            x+=rng.normal(0,sigma,len(x))+1j*rng.normal(0,sigma,len(x))
            x.astype(np.complex64).tofile(path)
            frames=receive(path,prb,2,tdd,cp,30000)
            assert len(frames)>=8,(prb,tdd,cp,len(frames))
            assert not receive(path,prb,2,1-tdd,cp,30000)
            assert not receive(path,prb,2,tdd,1-cp,30000)
            print(f'{prb}PRB TDD={tdd} extended CP={cp}: CFO/fractional timing/AWGN {len(frames)} exact blocks; wrong layouts rejected',flush=True)
    # The pinned resource-count bug was specifically 6PRB, extended CP, CFI3.
    for tdd in (0,1):
        for ports in (1,2,4):
            generate(path,6,ports,tdd,1,cfi=3)
            frames=receive(path,6,ports,tdd,1)
            assert len(frames)==7,(tdd,ports,len(frames))
    print('6PRB extended CP CFI3: all port counts recover valid blocks after corrected resource count',flush=True)
    # Full production path must discover CP and duplex from IQ, with no hint.
    for rate,prb in ((8000000,25),(10000000,50),(16000000,75),(20000000,100)):
        for tdd,cp in ((1,0),(0,1),(1,1)):
            generate(path,prb,2,tdd,cp,640)
            raw=np.fromfile(path,np.complex64);g=math.gcd(rate,rates[prb])
            x=resample_poly(raw,rate//g,rates[prb]//g)
            x=np.r_[np.zeros(1377),x]
            x*=np.exp(2j*np.pi*18000*np.arange(len(x))/rate)
            x*=32/max(abs(x));x+=1.3-0.7j
            signed=np.clip(np.rint(np.column_stack((x.real,x.imag))),-127,127).astype(np.int8)
            iq=Path(directory)/'signal.iq';signed.tofile(iq)
            run=subprocess.run([native,'decode',str(iq),'0',str(len(x)),'lte',str(rate),'2660000000','2660000000','1m','2391391958','5592405'],capture_output=True,text=True,timeout=30)
            assert run.returncode==0,run.stderr[-1000:]
            result=json.loads(run.stdout)
            frames=result['packets'];mibs=[f for f in frames if f['lteChannel']=='bcch-bch'];si=[f for f in frames if f['lteChannel']=='bcch-dl-sch']
            assert mibs and len(si)>=5,(rate,tdd,cp,len(mibs),len(si),run.stderr[-1000:])
            for f in frames:
                assert f['ltePci']==42 and f['ltePrb']==prb and f['ltePorts']==2 and f['lteTdd']==bool(tdd),f
                assert f['lteContext']['extendedCp']==bool(cp),f
            assert all(bytes(f['bytes']).hex()==expected for f in si),si
            print(f'{rate}S/s cold production acquisition TDD={tdd}, extended CP={cp}: {len(mibs)} MIB + {len(si)} SI',flush=True)
