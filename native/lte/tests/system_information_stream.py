# SPDX-License-Identifier: AGPL-3.0-or-later
"""Production streaming receiver and exact selected-IQ LTE context replay.

The TX PHY is shared with the receiver; this is integration and state-lifetime
coverage, not independent PHY conformance. Hints contain no payload or SFN.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly

fixture, worker, stream_feed = sys.argv[1:4]
rates={6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
expected=bytes.fromhex('6040040300011a2d4018028180420c800000').ljust(32,b'\0').hex()
keys=['pci','prb','ports','tdd','extendedCp','phichExtended','phichResources','cfoHz']

def replay(file,rate,first=0,count=None,context=None,ok=True):
    count=file.stat().st_size//2-first if count is None else count
    args=[worker,'decode',str(file),str(first),str(count),'lte',str(rate),'2660000000','2660000000','1m','2391391958','5592405']
    if context is not None:args.extend(str(int(context[k])) if isinstance(context[k],bool) else str(context[k]) for k in keys)
    run=subprocess.run(args,capture_output=True,text=True,timeout=30)
    if not ok:
        assert run.returncode!=0,(run.returncode,run.stdout,run.stderr)
        return
    assert run.returncode==0,(run.returncode,run.stderr[-1500:])
    result=json.loads(run.stdout)
    assert result['processedSamples']==count and result['firstSample']==first and result['endSample']==first+count,result
    for p in result['packets']:
        assert first<=p['firstSample']<p['endSample']<=first+count,p
        assert p['integrity']=='valid',p
    return result

def system_information(result):
    return [p for p in result['packets'] if p.get('lteChannel')=='bcch-dl-sch']

with tempfile.TemporaryDirectory(prefix='airwolf-lte-stream-') as directory:
    cf=Path(directory)/'signal.cf32';iq=Path(directory)/'signal.iq'
    rng=np.random.default_rng(0xC0F0)
    last=None
    for rate,prb,ports,cfo in ((8000000,25,1,18000),(10000000,50,2,-18000),(16000000,75,2,18000),(20000000,100,4,-18000)):
        subprocess.run([fixture,str(cf),str(prb),'42',str(ports),'640'],capture_output=True,check=True)
        raw=np.fromfile(cf,np.complex64)
        divisor=np.gcd(rate,rates[prb]);x=resample_poly(raw,rate//divisor,rates[prb]//divisor)
        x*=20/np.sqrt(np.mean(abs(x)**2));x=np.r_[np.zeros(1377),x]
        x*=np.exp(2j*np.pi*cfo*np.arange(len(x))/rate)
        x+=3-2j+rng.normal(0,.2,len(x))+1j*rng.normal(0,.2,len(x))
        data=np.empty(len(x)*2,np.int8);data[::2]=np.clip(np.rint(x.real),-127,127);data[1::2]=np.clip(np.rint(x.imag),-127,127);data.tofile(iq)
        result=replay(iq,rate);frames=system_information(result)
        assert len(frames)>=2,(rate,prb,[(p.get('lteChannel'),p['ltePci'],p['ltePorts']) for p in result['packets']])
        assert all(bytes(p['bytes']).hex()==expected for p in frames),(rate,frames)
        for frame in frames:
            c=frame['lteContext']
            assert (c['pci'],c['prb'],c['ports'],c['tdd'])==(42,prb,ports,False),c
            assert c['phichResources']==2 and not c['extendedCp'] and not c['phichExtended'],c
            assert abs(c['cfoHz']-cfo)<2500,c
        selected=[frames[0],frames[len(frames)//2],frames[-1]]
        for frame in selected:
            chosen=replay(iq,rate,frame['firstSample'],frame['endSample']-frame['firstSample'],frame['lteContext'])
            assert any(p['lteSfn']==frame['lteSfn'] and p['bytes']==frame['bytes'] for p in system_information(chosen)),(rate,frame,chosen)
        print(f'{rate/1e6:g}MS/s {prb}PRB/{ports}ports: {len(frames)} SI blocks, exact first/middle/last selected replay',flush=True)
        last=frames[-1]
    # Correct hints can never substitute a payload for corrupted IQ.
    noise=Path(directory)/'noise.iq';rng.integers(-4,5,20000000//5*2,dtype=np.int8).tofile(noise)
    assert not replay(noise,20000000,context=last['lteContext'])['packets']
    assert not replay(iq,20000000,0,64,last['lteContext'])['packets']
    for key,value in (('pci',43),('prb',50),('ports',1),('cfoHz',180000)):
        wrong=dict(last['lteContext']);wrong[key]=value
        selected=replay(iq,20000000,last['firstSample'],last['endSample']-last['firstSample'],wrong)
        assert not system_information(selected),(key,selected)
    for key,value in (('pci',504),('ports',3),('phichResources',4),('cfoHz','nan'),('tdd',2)):
        invalid=dict(last['lteContext']);invalid[key]=value
        replay(iq,20000000,context=invalid,ok=False)
    print('Wrong-cell/ports/CFO hints, invalid fields, short range and noise never manufacture SI',flush=True)
    # A declared gap discards pending channel/combining context. The fake input
    # skips the same original IQ interval, preserving subsequent RF timestamps.
    run=subprocess.run([stream_feed,'20000000',str(iq),'offline','5000000','200000'],capture_output=True,text=True,timeout=30)
    assert run.returncode==0,run.stderr
    rows=[json.loads(line) for line in run.stdout.splitlines()]
    frames=[p for p in rows if p['kind']=='si']
    assert frames and all(p['endSample']<=5000000 or p['firstSample']>=5200000 for p in frames),frames
    assert all(p['data']==expected for p in frames),frames
    assert 'dropped_samples=0' in run.stderr,run.stderr
    print(f'Input gap: {len(frames)} valid SI contexts; none bridge the missing interval',flush=True)
    # The central MIB is still available when capture bandwidth cannot include
    # the advertised downlink. No SI search attempts or invented edge carriers.
    narrow=resample_poly(np.fromfile(iq,np.int8).astype(np.float32).reshape(-1,2).view(np.complex64).ravel(),2,5)
    data=np.empty(len(narrow)*2,np.int8);data[::2]=np.clip(np.rint(narrow.real),-127,127);data[1::2]=np.clip(np.rint(narrow.imag),-127,127);data.tofile(iq)
    run=subprocess.run([stream_feed,'8000000',str(iq)],capture_output=True,text=True,timeout=30)
    assert run.returncode==0 and 'bandwidth_limited=1 required_rate=20000000' in run.stderr and 'attempts=0' in run.stderr,run.stderr
    assert not any(json.loads(line)['kind']=='si' for line in run.stdout.splitlines())
    print('100PRB captured at8MS/s: MIB remains available, explicit bandwidth limitation, zero SI attempts',flush=True)
