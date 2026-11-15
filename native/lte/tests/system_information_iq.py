# SPDX-License-Identifier: AGPL-3.0-or-later
"""Quantized HackRF-rate SI integration through the real full-band resampler.

TX uses the pinned shared PHY. SciPy performs the independent fixture-rate
conversion; production receive conversion is the native polyphase FIR.
"""
import json
from pathlib import Path
import checked_subprocess as subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly

fixture, decoder = sys.argv[1:3]
rates={6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
expected=bytes.fromhex('6040040300011a2d4018028180420c800000').ljust(32,b'\0').hex()
rng=np.random.default_rng(0xD15C)
with tempfile.TemporaryDirectory(prefix='airwolf-lte-si-iq-') as directory:
    cf=Path(directory)/'signal.cf32';iq=Path(directory)/'signal.iq'
    for rate,prb in ((8000000,6),(8000000,15),(8000000,25),(10000000,25),(10000000,50),(16000000,50),(16000000,75),(20000000,6),(20000000,100)):
        subprocess.run([fixture,str(cf),str(prb),'42','4','160'],capture_output=True,check=True)
        raw=np.fromfile(cf,np.complex64)
        divisor=np.gcd(rate,rates[prb]);x=resample_poly(raw,rate//divisor,rates[prb]//divisor)
        x*=20/np.sqrt(np.mean(abs(x)**2))
        x=np.r_[np.zeros(777),x]
        x*=np.exp(2j*np.pi*18000*np.arange(len(x))/rate)
        x+=3-2j+rng.normal(0,.35,len(x))+1j*rng.normal(0,.35,len(x))
        data=np.empty(len(x)*2,np.int8);data[::2]=np.clip(np.rint(x.real),-127,127);data[1::2]=np.clip(np.rint(x.imag),-127,127);data.tofile(iq)
        run=subprocess.run([decoder,str(rate),str(prb),'42','4',str(iq),'18000','0','160'],capture_output=True,text=True,timeout=20)
        frames=[json.loads(line) for line in run.stdout.splitlines()]
        assert run.returncode==0 and len(frames)>=4,(rate,prb,run.returncode,run.stderr)
        assert all(f['data']==expected for f in frames),(rate,prb,frames)
        for f in frames:
            assert 0<=f['firstSample']<f['endSample']<=rate*.16,f
            true_end=777+(f['sfn']*10+6)*rate/1000
            assert abs(f['endSample']-true_end)<rate/15000,(rate,prb,f,true_end)
        print(f'{rate/1e6:g}MS/s, {prb}PRB,4ports,18kHz CFO,DC/noise/int8 quantization: {len(frames)} exact SI blocks',flush=True)
    run=subprocess.run([decoder,'8000000','100','42','4',str(iq)],capture_output=True,text=True,timeout=20)
    assert run.returncode==2 and not run.stdout and 'bandwidth' in run.stderr,run
    print('8MS/s cannot cover100PRB: explicitly rejected without fabricated SI',flush=True)
