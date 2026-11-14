# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared-library TX/RX integration tests; not independent reception evidence."""
import sys, subprocess, tempfile, json
from pathlib import Path
import numpy as np
from scipy.signal import resample_poly
rng=np.random.default_rng(56431)
with tempfile.TemporaryDirectory() as tmp:
    cf=Path(tmp)/'broadcast.cf32';iq=Path(tmp)/'broadcast.iq'
    for rate,pci,prb,cfo in ((8000000,42,6,2500),(10000000,43,25,-2500),(16000000,503,50,18000),(20000000,0,100,-18000)):
        subprocess.run([sys.argv[1],str(cf),str(pci),str(prb),'1200'],check=True)
        x=np.fromfile(cf,np.complex64)
        divisor=np.gcd(rate,1920000);x=resample_poly(x,rate//divisor,1920000//divisor)
        x=x*(28/np.sqrt(np.mean(abs(x)**2)))
        # Start between radio-frame boundaries to exercise synchronization
        # discards, whose upstream receive callback has no timestamp pointer.
        x=np.r_[np.zeros(int(rate*.0072317)+37),x]
        x*=np.exp(2j*np.pi*cfo*np.arange(len(x))/rate)
        x+=4+1j+(.5*rng.normal(size=len(x))+.5j*rng.normal(size=len(x)))
        data=np.empty(len(x)*2,np.int8);data[::2]=np.clip(np.round(x.real),-127,127);data[1::2]=np.clip(np.round(x.imag),-127,127);data.tofile(iq)
        run=subprocess.run([sys.argv[2],str(rate),str(iq)],text=True,capture_output=True,timeout=20)
        assert run.returncode==0,(rate,run.returncode,run.stderr[-2000:])
        frames=[json.loads(line) for line in run.stdout.splitlines()]
        assert len(frames)>=20,(rate,len(frames))
        for f in frames:
            assert f['pci']==pci and f['prb']==prb and f['ports']==1,(rate,f)
            assert 0<=f['firstSample']<f['endSample']<=len(x),(rate,f)
            assert int(f['mib'],16)>>21==[6,15,25,50,75,100].index(prb)
        print(f'{rate/1e6:g} MS/s: {len(frames)} CRC-valid MIBs, PCI {pci}, {prb} PRB, CFO {cfo} Hz')
    for reserved in (6,7):
        subprocess.run([sys.argv[1],str(cf),'42','6','800',str(reserved)],check=True)
        x=resample_poly(np.fromfile(cf,np.complex64),25,6)
        x*=28/np.sqrt(np.mean(abs(x)**2))
        data=np.empty(len(x)*2,np.int8);data[::2]=np.clip(np.round(x.real),-127,127);data[1::2]=np.clip(np.round(x.imag),-127,127);data.tofile(iq)
        run=subprocess.run([sys.argv[2],'8000000',str(iq)],capture_output=True,text=True,timeout=20)
        assert run.returncode==1 and not run.stdout,('reserved bandwidth',reserved,run.stdout,run.stderr[-500:])
    print('CRC-valid reserved bandwidth encodings: zero published MIBs')
    for kind in ('noise','dc'):
        data=(rng.normal(0,20,16000000).clip(-127,127).astype(np.int8) if kind=='noise' else np.full(16000000,24,np.int8));data.tofile(iq)
        run=subprocess.run([sys.argv[2],'8000000',str(iq)],capture_output=True,text=True,timeout=20)
        assert run.returncode==1 and not run.stdout,(kind,run.stdout,run.stderr[-500:])
    print('Noise and DC: zero MIBs')
