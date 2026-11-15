# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ordinary SI scheduling/transport and selected-IQ replay, with no cached ASN.1."""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly
fixture,decoder,worker=sys.argv[1:4]
rates={6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
# Existing public pinned srsRAN lib/test/asn1/rrc_test.cc SIB2 vector; native
# Wireshark RRC independently corroborates its structure and expected fields.
sib2=bytes.fromhex('000149001250400800094000a03f01000a7fc9800104286c000c')
keys=['pci','prb','ports','tdd','extendedCp','phichExtended','phichResources','cfoHz']
rng=np.random.default_rng(0x51B22026)

def sib1(tdd=False,period=1,window=6,special=7,multiple=False):
    bits=''
    def put(n,v):
        nonlocal bits;bits+=f'{v:0{n}b}'
    put(2,1);put(1,0);put(1,tdd);put(1,0);put(1,0);put(3,0)
    put(1,1);put(4,0);put(4,0);put(4,1);put(1,0);put(4,0);put(4,1);put(1,1)
    put(16,1);put(28,0x1a2d401);put(3,4);put(1,0);put(6,0);put(6,6)
    put(5,int(multiple));put(3,period);put(5,0) # SIB2 implicitly present in the first SI.
    if multiple:put(3,period);put(5,1);put(1,0);put(4,6) # second SI carries SIB9.
    if tdd:put(3,2);put(4,special)
    put(3,window);put(5,8)
    return int(bits.ljust((len(bits)+7)//8*8,'0'),2).to_bytes((len(bits)+7)//8,'big')

def run_native(path,rate,first=0,count=None,context=None):
    if count is None:count=path.stat().st_size//2-first
    args=[worker,'decode',str(path),str(first),str(count),'lte',str(rate),'2660000000','2660000000','1m','2391391958','5592405']
    if context:args += [str(int(context[k])) if isinstance(context[k],bool) else str(context[k]) for k in keys]
    run=subprocess.run(args,capture_output=True,text=True,timeout=30)
    assert run.returncode==0,run.stderr[-1500:]
    return json.loads(run.stdout)

def si_packets(result):
    return [p for p in result['packets'] if p.get('lteChannel')=='bcch-dl-sch' and p['bytes'][0]&0xc0==0]

with tempfile.TemporaryDirectory(prefix='airwolf-lte-scheduled-') as directory:
    cf=Path(directory)/'signal.cf32';s1=Path(directory)/'sib1.bin';iq=Path(directory)/'signal.iq'
    s1.write_bytes(sib1())
    for mode in ('scheduled','scheduled-1c'):
        for prb in rates:
            for ports in (1,2,4):
                subprocess.run([fixture,str(cf),str(prb),'42',str(ports),'640',mode,'0','0','3',str(s1)],check=True,capture_output=True)
                run=subprocess.run([decoder,str(cf),str(prb),'42',str(ports)],capture_output=True,text=True,timeout=30)
                assert run.returncode==0,run.stderr[-1000:]
                frames=[json.loads(l) for l in run.stdout.splitlines()];si=[p for p in frames if int(p['data'][:2],16)&0xc0==0]
                expected=sib2.ljust(28 if mode.endswith('1c') else 32,b'\0').hex()
                assert len(si)==12 and all(p['data']==expected for p in si),(mode,prb,ports,len(si),si)
                assert {p['rv'] for p in si}=={0,1,2,3}
        print(f'{mode}: six bandwidths × three port counts, exact SIB2 and all four RVs',flush=True)
    s1.write_bytes(sib1(multiple=True))
    for mode in ('scheduled-multiple','scheduled-multiple-1c'):
        subprocess.run([fixture,str(cf),'25','42','2','640',mode,'0','0','3',str(s1)],check=True,capture_output=True)
        run=subprocess.run([decoder,str(cf),'25','42','2'],capture_output=True,text=True,timeout=30)
        assert run.returncode==0,run.stderr[-1000:]
        frames=[json.loads(l) for l in run.stdout.splitlines()];si=[p for p in frames if int(p['data'][:2],16)&0xc0==0]
        size=28 if mode.endswith('1c') else 32
        expected=[sib2.ljust(size,b'\0').hex(),bytes.fromhex('001d09318588').ljust(size,b'\0').hex()]
        assert len(si)==28 and {p['data'] for p in si}==set(expected),(mode,len(si),si)
        for p in si:assert p['data']==expected[((p['sfn']*10+p['subframe'])%160)//40],p
        print(f'{mode}:28 exact SIB2/SIB9 blocks across separate windows and interleaved SIB1',flush=True)
    for cp in (0,1):
        s1.write_bytes(sib1(tdd=True,special=0 if cp else 7))
        for prb in (6,100):
            for ports in (1,4):
                subprocess.run([fixture,str(cf),str(prb),'42',str(ports),'640','scheduled','1',str(cp),'3',str(s1)],check=True,capture_output=True)
                run=subprocess.run([decoder,str(cf),str(prb),'42',str(ports),'0','1',str(cp)],capture_output=True,text=True,timeout=30)
                assert run.returncode==0,run.stderr[-1000:]
                frames=[json.loads(l) for l in run.stdout.splitlines()];si=[p for p in frames if int(p['data'][:2],16)&0xc0==0]
                assert len(frames)==34 and len(si)==3,(cp,prb,ports,len(frames),len(si))
                assert all(p['subframe']==8 and p['data']==sib2.ljust(32,b'\0').hex() for p in si),si
        print(f'TDD configuration2 extendedCP={cp}: schedule-derived PHICH mapping and only ordinary downlink SI',flush=True)
    s1.write_bytes(sib1())
    # Weak PDSCHs need repetitions. A SIB1 between those attempts must not
    # clear the separate SI softbuffer. SNR is whole-waveform power/noise,
    # explicitly not a claimed LTE Eb/N0 sensitivity measurement.
    subprocess.run([fixture,str(cf),'25','42','2','960','scheduled','0','0','3',str(s1)],check=True,capture_output=True)
    raw=np.fromfile(cf,np.complex64);weak_rng=np.random.default_rng(5102)
    sigma=np.sqrt(np.mean(abs(raw)**2)/10**(-12/10)/2)
    (raw+weak_rng.normal(0,sigma,len(raw))+1j*weak_rng.normal(0,sigma,len(raw))).astype(np.complex64).tofile(cf)
    run=subprocess.run([decoder,str(cf),'25','42','2'],capture_output=True,text=True,timeout=30)
    assert run.returncode==0,run.stderr[-1000:]
    frames=[json.loads(l) for l in run.stdout.splitlines()];si=[p for p in frames if int(p['data'][:2],16)&0xc0==0]
    assert len(si)>=4 and all(p['data']==sib2.ljust(32,b'\0').hex() for p in si),si
    combined=[p for p in si if p['endSample']-p['firstSample']>5*5760]
    assert len(combined)>=2,si
    print(f'Weak scheduled SI: {len(si)} exact blocks; {len(combined)} combine across an interleaved SIB1 subframe',flush=True)
    # CRC-valid PDCCH alone, wrong RNTI, absent SIB1 and a grant outside the
    # advertised window never produce a scheduled-SI packet. Include noise on
    # the erased PDSCH case to test beyond the all-zero-LLR special case.
    for mode in ('scheduled-no-pdsch','scheduled-wrong-window','scheduled-wrong-rnti','scheduled-no-sib1'):
        subprocess.run([fixture,str(cf),'25','42','1','640',mode,'0','0','3',str(s1)],check=True,capture_output=True)
        raw=np.fromfile(cf,np.complex64)
        for noise in ((None,30,10,0) if mode=='scheduled-no-pdsch' else (None,)):
            x=raw.copy()
            if noise is not None:
                sigma=np.sqrt(np.mean(abs(x)**2)/10**(noise/10)/2)
                x+=rng.normal(0,sigma,len(x))+1j*rng.normal(0,sigma,len(x))
            x.astype(np.complex64).tofile(cf)
            run=subprocess.run([decoder,str(cf),'25','42','1'],capture_output=True,text=True,timeout=30)
            assert run.returncode in (0,1),run.stderr[-1000:]
            frames=[json.loads(l) for l in run.stdout.splitlines()]
            assert not any(int(p['data'][:2],16)&0xc0==0 for p in frames),(mode,noise,frames)
        print(f'{mode}: no false scheduled SI',flush=True)
    for rate,prb,ports in ((8000000,25,1),(10000000,50,2),(16000000,75,2),(20000000,100,4)):
        subprocess.run([fixture,str(cf),str(prb),'42',str(ports),'960','scheduled','0','0','3',str(s1)],check=True,capture_output=True)
        raw=np.fromfile(cf,np.complex64);g=math.gcd(rate,rates[prb]);x=resample_poly(raw,rate//g,rates[prb]//g)
        x=np.r_[np.zeros(1377),x];x*=20/np.sqrt(np.mean(abs(x)**2));x*=np.exp(2j*np.pi*18000*np.arange(len(x))/rate)
        x+=2-1j+rng.normal(0,.2,len(x))+1j*rng.normal(0,.2,len(x))
        np.clip(np.rint(np.column_stack((x.real,x.imag))),-127,127).astype(np.int8).tofile(iq)
        result=run_native(iq,rate);si=si_packets(result)
        assert len(si)>=8,(rate,len(si))
        assert all(bytes(p['bytes'])==sib2.ljust(32,b'\0') for p in si),si
        assert all(p['lteSubframe'] in (1,6,7,8) and p['integrity']=='valid' for p in si),si
        for p in (si[0],si[len(si)//2],si[-1]):
            replay=run_native(iq,rate,p['firstSample'],p['endSample']-p['firstSample'],p['lteContext'])
            assert any(q['bytes']==p['bytes'] and q['lteSfn']==p['lteSfn'] and q['lteSubframe']==p['lteSubframe'] for q in si_packets(replay)),(p,replay)
        print(f'{rate}S/s: {len(si)} exact scheduled SI, first/middle/last selected IQ replay',flush=True)
