# SPDX-License-Identifier: AGPL-3.0-or-later
"""Paging PHY integration and exact native IQ replay.

PCCH payloads are assembled independently from TS36.331. Radio coding/modulation
uses the pinned srsRAN TX and is shared-library integration, not a PHY oracle.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly
import checked_subprocess as subprocess
from paging_vectors import VECTORS, STMSI, sib1

fixture,decoder,worker=sys.argv[1:4]
rates={6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
context_keys=['pci','prb','ports','tdd','extendedCp','phichExtended','phichResources','cfoHz']
rng=np.random.default_rng(0xFE2026)

def receive(path,prb,ports,tdd=False,cp=False):
    run=subprocess.run([decoder,str(path),str(prb),'42',str(ports),'0',str(int(tdd)),str(int(cp))],capture_output=True,text=True,timeout=30)
    assert run.returncode in (0,1),run.stderr[-1500:]
    return [json.loads(line) for line in run.stdout.splitlines()]

def decode(path,rate,first=0,count=None,context=None):
    if count is None:count=path.stat().st_size//2-first
    args=[worker,'decode',str(path),str(first),str(count),'lte',str(rate),'2660000000','2660000000','1m','2391391958','5592405']
    if context:args += [str(int(context[k])) if isinstance(context[k],bool) else str(context[k]) for k in context_keys]
    run=subprocess.run(args,capture_output=True,text=True,timeout=30)
    assert run.returncode==0,run.stderr[-1500:]
    result=json.loads(run.stdout)
    for p in result['packets']:
        assert first<=p['firstSample']<p['endSample']<=first+count,p
        if p.get('lteChannel')=='pcch':
            assert p['lteRnti']==65534 and p['integrity']=='valid',p
            assert p['firstSample']<=p['lteTransportFirstSample']<p['lteTransportEndSample']<=p['endSample'],p
            assert abs(p['lteTransportEndSample']-p['lteTransportFirstSample']-rate/1000)<2,p
        elif p.get('lteChannel')=='bcch-dl-sch':assert p['lteRnti']==65535,p
        else:assert 'lteRnti' not in p,p
    return result

def pages(rows):return [p for p in rows if p.get('rnti')==65534 or p.get('lteChannel')=='pcch']

with tempfile.TemporaryDirectory(prefix='airwolf-paging-') as directory:
    path=Path(directory);cf=path/'signal.cf32';s1=path/'sib1.bin';page=path/'paging.bin';iq=path/'signal.iq'
    def generate(prb=25,ports=2,tdd=False,cp=False,mode='paging',payload=STMSI,duration=160,cfi=3,special=None,v1130=None,dwpts=None):
        s1.write_bytes(sib1(tdd,special=(0 if cp else 7) if special is None else special,v1130=v1130));page.write_bytes(payload)
        env=None if dwpts is None else {**os.environ,'AIRWOLF_FIXTURE_SSP':str(dwpts)}
        subprocess.run([fixture,str(cf),str(prb),'42',str(ports),str(duration),mode,str(int(tdd)),str(int(cp)),str(cfi),str(s1),str(page)],check=True,capture_output=True,env=env)

    count=0
    for tdd in (False,True):
        for mode in ('paging','paging-1c'):
            for prb in rates:
                for ports in (1,2,4):
                    generate(prb,ports,tdd,mode=mode)
                    rows=receive(cf,prb,ports,tdd);pcch=pages(rows)
                    assert len(pcch)>=12,(prb,ports,tdd,mode,len(pcch))
                    assert all(bytes.fromhex(p['data'])==STMSI.ljust(len(bytes.fromhex(p['data'])),b'\0') for p in pcch),(prb,ports,tdd,mode)
                    assert all(p['rv']==0 and p['subframe']==(0 if tdd else 9) for p in pcch),pcch
                    si=[p for p in rows if p['rnti']==65535]
                    assert len(si)==7 and all(bytes.fromhex(p['data']).startswith(s1.read_bytes()) for p in si),(prb,ports,tdd,mode,si)
                    count+=1
            print(f'TDD={tdd} {mode}: six bandwidths × three port counts, paging + exact SIB1',flush=True)
    for tdd in (False,True):
        for prb in (6,100):
            for ports in (1,2,4):
                generate(prb,ports,tdd,True)
                pcch=pages(receive(cf,prb,ports,tdd,True))
                assert len(pcch)>=12 and all(bytes.fromhex(p['data']).startswith(STMSI) for p in pcch),(prb,ports,tdd,len(pcch))
                count+=1
    print(f'{count} ordinary paging matrices including extended CP passed',flush=True)
    # Every PDCCH paging subframe from TS36.3047.2, including TDD DwPTS
    # whose length/layout is derived from the freshly received SIB1.
    for tdd in (False,True):
        generate(tdd=tdd,mode='paging-all-occasions',cfi=2)
        pcch=pages(receive(cf,25,2,tdd))
        expected={0,1,5,6} if tdd else {0,4,5,9}
        assert {p['subframe'] for p in pcch}==expected,(tdd,{p['subframe'] for p in pcch})
        assert all(bytes.fromhex(p['data']).startswith(STMSI) for p in pcch)
    for name,payload in VECTORS.items():
        generate(payload=payload)
        pcch=pages(receive(cf,25,2))
        assert len(pcch)>=12 and all(bytes.fromhex(p['data'])==payload.ljust(len(bytes.fromhex(p['data'])),b'\0') for p in pcch),name
    print('All paging occasions and six independent PCCH payloads, including legal empty Paging, passed',flush=True)
    for mode in ('paging-wrong-rnti','paging-no-pdcch','paging-no-pdsch','paging-off-occasion'):
        generate(mode=mode)
        rows=receive(cf,25,2)
        assert not pages(rows),(mode,rows)
        assert len([p for p in rows if p['rnti']==65535])==7,(mode,rows)
    generate(payload=b'\x80')
    assert not pages(receive(cf,25,2)) # Future PCCH message class is not Paging.
    generate(tdd=True,mode='paging-special-no-sib1',cfi=2)
    assert not pages(receive(cf,25,2,True)) # Never invent the DwPTS configuration.
    # DwPTS length from SIB1: Rel-11 ssp9 (6 symbols) overrides the Rel-8
    # field, and extended-CP patterns map to the same DwPTS length (5 and 8
    # symbols have no upstream layout and are not decoded). The fixture fills
    # the guard period and UpPTS with energy: reading the 10-symbol ssp7
    # layout over a 6-symbol DwPTS then loses nearly every page (1 of 27 here).
    for cp,special,v1130,dwpts,expect in ((False,7,9,9,True),(False,7,None,9,False),(True,2,None,1,True),(True,6,None,1,True),(True,1,None,0,False),(True,7,None,0,False)):
        generate(tdd=True,cp=cp,mode='paging-special',cfi=2,special=special,v1130=v1130,dwpts=dwpts)
        rows=receive(cf,25,2,True,cp);pcch=pages(rows)
        assert len([p for p in rows if p['rnti']==65535])==7,(cp,special,v1130,rows)
        if expect:assert len(pcch)>=12 and {p['subframe'] for p in pcch}=={1,6} and all(bytes.fromhex(p['data']).startswith(STMSI) for p in pcch),(cp,special,v1130,len(pcch))
        else:assert len(pcch)<=3,(cp,special,v1130,len(pcch))
    print('TDD special subframes: Rel-11 ssp9 override and extended-CP DwPTS lengths',flush=True)
    generate(mode='paging-no-sib1')
    assert len(pages(receive(cf,25,2)))>=12 # Ordinary paging needs fresh MIB, not SIB1.
    generate(mode='paging-alternating')
    rows=receive(cf,25,2)
    for p in pages(rows):
        expected=bytearray(STMSI);expected[5]^=p['sfn']&1
        assert bytes.fromhex(p['data']).startswith(expected),p
    assert len([p for p in rows if p['rnti']==65535])==7
    print('Wrong RNTI, missing PDCCH/PDSCH, off-occasion, unknown layout and alternating-message isolation passed',flush=True)
    for rate,prb,ports,tdd in ((8000000,25,1,False),(10000000,50,2,True),(16000000,75,2,False),(20000000,100,4,True)):
        generate(prb,ports,tdd,duration=640,cfi=2)
        raw=np.fromfile(cf,np.complex64);divisor=np.gcd(rate,rates[prb]);x=resample_poly(raw,rate//divisor,rates[prb]//divisor)
        #20ppm relative sample clock; linear interpolation introduces fractional
        # timing continuously, beyond merely shifting by whole input samples.
        at=np.arange(len(x),dtype=np.float64);clock=1+(-1 if tdd else 1)*20e-6
        x=np.interp(at/clock,at,x.real)+1j*np.interp(at/clock,at,x.imag)
        x*=20/np.sqrt(np.mean(abs(x)**2));x=np.r_[np.zeros(1377),x]
        cfo=-18000 if tdd else 18000;x*=np.exp(2j*np.pi*cfo*np.arange(len(x))/rate)
        x+=2-1j+rng.normal(0,.2,len(x))+1j*rng.normal(0,.2,len(x))
        np.clip(np.rint(np.column_stack((x.real,x.imag))),-127,127).astype(np.int8).tofile(iq)
        result=decode(iq,rate);pcch=pages(result['packets'])
        assert len(pcch)>=8,(rate,len(pcch))
        assert all(bytes(p['bytes']).startswith(STMSI) for p in pcch)
        for p in (pcch[0],pcch[len(pcch)//2],pcch[-1]):
            replay=decode(iq,rate,p['firstSample'],p['endSample']-p['firstSample'],p['lteContext'])
            assert any(q['bytes']==p['bytes'] and q['lteSfn']==p['lteSfn'] and q['lteSubframe']==p['lteSubframe'] for q in pages(replay['packets'])),(rate,p,replay)
        print(f'{rate/1e6:g}MS/s TDD={tdd}: CFO/clock/DC/noise and exact first/middle/last selected replay',flush=True)
    noise=path/'noise.iq';rng.integers(-12,13,2000000,dtype=np.int8).tofile(noise)
    assert not decode(noise,20000000,context=pcch[-1]['lteContext'])['packets']
    print('Noise with physical context produces no frames',flush=True)
