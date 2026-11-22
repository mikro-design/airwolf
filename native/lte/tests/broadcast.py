# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared-library TX/RX integration tests; not independent reception evidence."""
import sys, tempfile, json
import checked_subprocess as subprocess
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
        if rate==8000000:
            import os
            failed=subprocess.run([sys.argv[2],str(rate),str(iq)],text=True,capture_output=True,timeout=20,env={**os.environ,'AIRWOLF_LTE_TEST_CALLBACK_FAILURE':'1'})
            assert failed.returncode==3 and 'test callback failure' in failed.stderr,(failed.returncode,failed.stderr[-500:])
            print('A failing MIB callback stops the receiver with its error instead of terminating the process')
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
    # Regression: a wrong-cell hypothesis (here PCI 387 or TDD/extended CP,
    # decoded from SSS under residual CFO) left state in the reused MIB
    # synchronizer, so the later correct PCI 0 hypothesis never decoded PBCH.
    # A start 40 samples later than the case above produced zero MIBs from
    # 1.2 s of clean signal. Half-speed pacing: this checks acquisition, not
    # real-time capacity.
    late=np.random.default_rng(56431)
    subprocess.run([sys.argv[1],str(cf),'0','100','1200'],check=True)
    x=np.fromfile(cf,np.complex64);divisor=np.gcd(20000000,1920000);x=resample_poly(x,20000000//divisor,1920000//divisor)
    x=x*(28/np.sqrt(np.mean(abs(x)**2)))
    x=np.r_[np.zeros(int(20000000*.0072317)+37+40),x]
    x*=np.exp(2j*np.pi*-18000*np.arange(len(x))/20000000)
    x+=4+1j+(.5*late.normal(size=len(x))+.5j*late.normal(size=len(x)))
    data=np.empty(len(x)*2,np.int8);data[::2]=np.clip(np.round(x.real),-127,127);data[1::2]=np.clip(np.round(x.imag),-127,127);data.tofile(iq)
    run=subprocess.run([sys.argv[2],'20000000',str(iq),'2'],text=True,capture_output=True,timeout=30)
    frames=[json.loads(line) for line in run.stdout.splitlines()]
    assert run.returncode==0 and len(frames)>=100 and all(f['pci']==0 for f in frames),(len(frames),run.stderr[-1000:])
    print(f'Late start after a wrong-cell attempt: {len(frames)} MIBs from a fresh synchronizer')
