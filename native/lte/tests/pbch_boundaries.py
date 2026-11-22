# SPDX-License-Identifier: AGPL-3.0-or-later
"""Legal zero MIB and missing-PBCH negatives through production reception.

The OFDM transmitter shares the pinned PHY. The zero payload is specified
literally from TS36.331 MIB enums, independently of its packer. Repeating that
payload is intentional and is not evidence of continuous SFN progression.
"""
import json
import re
from pathlib import Path
import checked_subprocess as subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly

fixture,worker,stream=sys.argv[1:4]
rng=np.random.default_rng(0xB0A0D2026)
def decode(iq,rate):
    run=subprocess.run([worker,'decode',str(iq),'0',str(iq.stat().st_size//2),'lte',str(rate),'2660000000','2660000000','1m','2391391958','5592405'],capture_output=True,text=True,timeout=30)
    assert run.returncode==0,run.stderr[-1500:]
    return json.loads(run.stdout)['packets']
with tempfile.TemporaryDirectory(prefix='airwolf-lte-pbch-') as directory:
    cf=Path(directory)/'signal.cf32';iq=Path(directory)/'signal.iq'
    for mode in ('zero-mib','no-pbch'):
        subprocess.run([fixture,str(cf),'42','6','800','0','0',mode],check=True,capture_output=True)
        raw=np.fromfile(cf,np.complex64)
        for rate in (8000000,20000000):
            divisor=np.gcd(rate,1920000);base=resample_poly(raw,rate//divisor,1920000//divisor)
            base*=20/np.sqrt(np.mean(abs(base)**2))
            for noise in ((0,.2) if mode=='zero-mib' else (0,.2,2,10)):
                x=base.copy()*np.exp(2j*np.pi*18000*np.arange(len(base))/rate)
                x+=2-1j+rng.normal(0,noise,len(x))+1j*rng.normal(0,noise,len(x))
                np.clip(np.rint(np.column_stack((x.real,x.imag))),-127,127).astype(np.int8).tofile(iq)
                frames=decode(iq,rate)
                if mode=='zero-mib':
                    assert len(frames)>=8,(mode,rate,noise,len(frames))
                    assert all(p['lteChannel']=='bcch-bch' and p['bytes']==[0,0,0] and p['ltePci']==42 and p['ltePrb']==6 and p['ltePorts']==1 and p['lteSfn']<4 for p in frames),frames
                    assert all(p['lteContext']['phichResources']==0 for p in frames),frames
                else:
                    assert not frames,(mode,rate,noise,frames)
                    if rate==20000000 and noise==2:
                        # Without PBCH, noise alone passes CRC16 now and then
                        # (about 1 run in 4 here). Search fixed noise vectors
                        # until one does, so the check never depends on one
                        # front-end's exact arithmetic: that CRC-valid
                        # candidate, and every other run, must stay unpublished.
                        search=np.random.default_rng(0xC4C2026);spurious=0
                        for attempt in range(40):
                            sigma=(2,10)[attempt%2]
                            y=base*np.exp(2j*np.pi*18000*np.arange(len(base))/rate)+2-1j+search.normal(0,sigma,len(base))+1j*search.normal(0,sigma,len(base))
                            np.clip(np.rint(np.column_stack((y.real,y.imag))),-127,127).astype(np.int8).tofile(iq)
                            run=subprocess.run([stream,str(rate),str(iq)],capture_output=True,text=True,timeout=30)
                            candidates=re.search(r'mib_candidates=(\d+)',run.stderr)
                            assert run.returncode==1 and not run.stdout and candidates,run.stderr[-1500:]
                            spurious=int(candidates[1])
                            if spurious:break
                        assert spurious>=1,'no CRC16-valid noise candidate in 40 vectors'
                        print(f'no-pbch: noise vector {attempt} passed CRC16 {spurious}x; nothing published',flush=True)
                print(f'{mode}, {rate}S/s, ADC noise sigma={noise}: {len(frames)} frames',flush=True)
