# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exact selected MIB IQ replay with physical hints and fresh confirmation.

Generated PHY cases share the pinned TX library; public FDD/TDD recordings do
not. Neither path supplies recorded bytes, SFN or a CRC verdict to reception.
"""
import hashlib
import json
from pathlib import Path
import checked_subprocess as subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample_poly

fixture, worker, pbch_fixture = sys.argv[1:4]
keys = ['pci', 'prb', 'ports', 'tdd', 'extendedCp', 'phichExtended', 'phichResources', 'cfoHz']
phy_rates = {6:1920000, 15:3840000, 25:5760000, 50:11520000, 75:15360000, 100:23040000}
rng = np.random.default_rng(0xB0C412)

def write_iq(path, values):
    np.clip(np.rint(np.column_stack((values.real, values.imag))), -127, 127).astype(np.int8).tofile(path)

def decode(path, rate, first=0, count=None, context=None):
    count = path.stat().st_size//2-first if count is None else count
    args = [worker, 'decode', str(path), str(first), str(count), 'lte', str(rate),
            '2660000000', '2660000000', '1m', '2391391958', '5592405']
    if context is not None:
        assert set(context) == set(keys), context
        args.extend(str(int(context[k])) if isinstance(context[k], bool) else str(context[k]) for k in keys)
    run = subprocess.run(args, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr[-1500:]
    result = json.loads(run.stdout)
    assert result['firstSample'] == first and result['endSample'] == first+count, result
    frames = [p for p in result['packets'] if p['lteChannel'] == 'bcch-bch']
    for p in frames:
        assert first <= p['firstSample'] < p['endSample'] <= first+count, p
        assert p['integrity'] == 'valid' and len(p['bytes']) == 3, p
        # Confirmation pairs observations up to 30 frames apart; each PBCH
        # observation depends on at most its latest 4 frames; plus FIR,
        # resampler and 1 ms acquisition support: 34 frames + 2 ms.
        assert p['endSample']-p['firstSample'] <= rate*.342, p
    return frames

def selected(path, rate, frame):
    result = decode(path, rate, frame['firstSample'], frame['endSample']-frame['firstSample'], frame['lteContext'])
    same = [p for p in result if p['bytes'] == frame['bytes'] and p['lteSfn'] == frame['lteSfn']
            and all(p['lteContext'][k] == frame['lteContext'][k] for k in keys[:-1])]
    assert same, (rate, frame, result)
    return same[-1]

with tempfile.TemporaryDirectory(prefix='airwolf-mib-replay-') as directory:
    cf = Path(directory)/'signal.cf32'
    iq = Path(directory)/'signal.iq'
    cases = ((8000000,25,1,False,False), (10000000,50,2,False,False),
             (16000000,75,2,False,False), (20000000,100,4,False,False),
             (8000000,25,2,True,False), (20000000,100,2,True,False),
             (8000000,25,1,False,True), (20000000,100,4,True,True))
    for number, (rate, prb, ports, tdd, extended) in enumerate(cases):
        subprocess.run([fixture, str(cf), str(prb), '42', str(ports), '320', 'normal',
                        str(int(tdd)), str(int(extended)), '2'], check=True, capture_output=True)
        raw = np.fromfile(cf, np.complex64)
        divisor = np.gcd(rate, phy_rates[prb])
        x = resample_poly(raw, rate//divisor, phy_rates[prb]//divisor)
        x *= 20/np.sqrt(np.mean(abs(x)**2))
        x = np.r_[np.zeros(1377), x]
        cfo = 18000 if number%2 else -18000
        x *= np.exp(2j*np.pi*cfo*np.arange(len(x))/rate)
        x += 3-2j+rng.normal(0,.2,len(x))+1j*rng.normal(0,.2,len(x))
        write_iq(iq, x)
        frames = decode(iq, rate)
        assert len(frames) >= 5, (cases[number], len(frames))
        for p in frames:
            c = p['lteContext']
            assert (c['pci'],c['prb'],c['ports'],c['tdd'],c['extendedCp']) == (42,prb,ports,tdd,extended), c
            assert p['firstSample'] % (25*(rate//2000000)) == 0, p
        for frame in (frames[0], frames[len(frames)//2], frames[-1]):
            again = selected(iq, rate, frame)
            selected(iq, rate, again)  # Re-exported selection remains self-contained.
        # One independent radio frame cannot satisfy the two-observation rule.
        last = frames[-1]
        assert not decode(iq, rate, last['endSample']-rate//500, rate//500, last['lteContext'])
        for key, value in (('pci',43), ('tdd',not tdd), ('extendedCp',not extended), ('cfoHz',180000)):
            wrong = dict(last['lteContext']); wrong[key] = value
            result = decode(iq, rate, last['firstSample'], last['endSample']-last['firstSample'], wrong)
            # A receiver may reacquire actual physical properties, never report
            # a fresh CRC-success packet with the incorrect supplied identity.
            assert all(p['lteContext']['pci']==42 and p['lteContext']['tdd']==tdd and p['lteContext']['extendedCp']==extended for p in result), (key,result)
        print(f'{rate/1e6:g}MS/s {prb}PRB/{ports}ports TDD={tdd} extendedCP={extended}: exact and nested first/middle/last replay', flush=True)

    fixtures = Path(__file__).resolve().parents[2]/'tests'/'fixtures'/'lte-cell-scanner'
    for case in json.loads((fixtures/'sources.json').read_text()):
        raw = (fixtures/case['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == case['sha256']
        v = np.frombuffer(raw,np.int8).astype(np.float32)
        x = v[::2]+1j*v[1::2]
        for rate in (8000000,20000000):
            divisor=np.gcd(rate,1920000)
            write_iq(iq,resample_poly(x,rate//divisor,1920000//divisor))
            frames=decode(iq,rate)
            assert len(frames)>=case['minimum_mibs'],(case['file'],rate,len(frames))
            for frame in (frames[0],frames[len(frames)//2],frames[-1]):
                selected(iq,rate,selected(iq,rate,frame))
            print(f"{case['file']} {rate/1e6:g}MS/s: exact and nested first/middle/last recorded replay",flush=True)

    # Physical hints cannot supply missing PBCH or synchronization. Also test
    # zero/noise selections of the exact duration expected by the tail fallback.
    context=dict(pci=42,prb=6,ports=1,tdd=False,extendedCp=False,
                 phichExtended=False,phichResources=0,cfoHz=18000)
    for rate in (8000000,20000000):
        for mode in ('zero','noise','no-pbch','no-sync','repeated-observation'):
            if mode in ('no-pbch','no-sync','repeated-observation'):
                subprocess.run([pbch_fixture,str(cf),'42','6','320','0','0',
                                'no-pbch' if mode=='no-pbch' else 'normal'],check=True,capture_output=True)
                raw=np.fromfile(cf,np.complex64)
                if mode=='no-sync':
                    # FDD normal CP: first-slot symbols5/6 hold SSS/PSS.
                    # Keep PBCH (second slot) and all remaining IQ intact.
                    for start in range(0,len(raw),9600):raw[start+686:start+960]=0
                elif mode=='repeated-observation':
                    # Identical physical frame repeated: fresh sample positions
                    # and valid CRCs, but no real SFN progression.
                    raw=np.tile(raw[:19200],len(raw)//19200)
                divisor=np.gcd(rate,1920000);x=resample_poly(raw,rate//divisor,1920000//divisor)
                x*=20/np.sqrt(np.mean(abs(x)**2))
                x*=np.exp(2j*np.pi*18000*np.arange(len(x))/rate)
                x+=rng.normal(0,2,len(x))+1j*rng.normal(0,2,len(x))
            else:
                x=np.zeros(rate//40,dtype=np.complex64)
                if mode=='noise':x+=rng.normal(0,4,len(x))+1j*rng.normal(0,4,len(x))
            write_iq(iq,x)
            assert not decode(iq,rate,context=context),(rate,mode)
            print(f'{rate/1e6:g}MS/s {mode}: zero MIBs with supplied physical context',flush=True)

    # Fine CFO: srsRAN ignores PSS CFO residuals under 400 Hz, and the cell
    # search's estimate is typically ~270 Hz off. Without the CRS loop the
    # reported (and applied) CFO stayed at that error for the whole capture.
    # 300 subframes = 0.3 s; the loop must settle within the first 150 ms.
    cf = Path(directory)/'cfo.cf32'
    subprocess.run([pbch_fixture, str(cf), '42', '25', '300'], check=True, capture_output=True)
    for true_cfo in (2750.0, -3330.0):
        x = resample_poly(np.fromfile(cf, np.complex64), 25, 6)
        x *= 20/np.sqrt(np.mean(abs(x)**2))
        x = x*np.exp(2j*np.pi*true_cfo*np.arange(len(x))/8000000)+rng.normal(0, 3, len(x))+1j*rng.normal(0, 3, len(x))
        write_iq(iq, x)
        frames = decode(iq, 8000000)
        late = [p['lteContext']['cfoHz'] for p in frames if p['endSample'] > 1200000]
        assert len(frames) >= 25 and len(late) >= 10 and all(abs(c-true_cfo) < 25 for c in late), (true_cfo, len(frames), late)
        print(f'CFO {true_cfo:g} Hz: tracked to within {max(abs(c-true_cfo) for c in late):.0f} Hz after 150 ms', flush=True)

