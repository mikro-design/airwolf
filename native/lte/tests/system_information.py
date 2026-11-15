# SPDX-License-Identifier: AGPL-3.0-or-later
"""Full-band SI-RNTI PDCCH/PDSCH tests.

Generated vectors deliberately use the pinned PHY transmitter and are integration,
not independent conformance, evidence. The separate pinned upstream Amar vector
was already present before this receiver was written; its origin is not asserted.
"""
import hashlib
import json
from pathlib import Path
import re
import checked_subprocess as subprocess
import sys
import tempfile
import numpy as np
from scipy.signal import resample

fixture, decoder = sys.argv[1:3]
rng = np.random.default_rng(0x51B12026)
rates = {6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
expected = bytes.fromhex('6040040300011a2d4018028180420c800000').ljust(32,b'\0').hex()

def decode(path, prb, pci, ports, cfo=0):
    run = subprocess.run([decoder,str(path),str(prb),str(pci),str(ports),str(cfo)],capture_output=True,text=True,timeout=20)
    assert run.returncode in (0,1), (run.returncode,run.stderr[-2000:])
    frames = [json.loads(line) for line in run.stdout.splitlines()]
    counts = re.search(r'subframes=(\d+) mib=(\d+) dci=(\d+) crc_failures=(\d+) invalid_blocks=(\d+) blocks=(\d+)',run.stderr)
    assert counts, run.stderr[-2000:]
    return frames, list(map(int,counts.groups()))

with tempfile.TemporaryDirectory(prefix='airwolf-lte-si-') as directory:
    path=Path(directory)/'signal.cf32'
    for prb in rates:
        for ports in (1,2,4):
            pci=(prb*7+ports*43)%504
            subprocess.run([fixture,str(path),str(prb),str(pci),str(ports),'160'],check=True,capture_output=True)
            clean,clean_counts=decode(path,prb,pci,ports)
            assert len(clean)==7 and all(f['data']==expected for f in clean),(prb,ports,clean_counts,clean)
            assert {f['rv'] for f in clean}=={0,1,2,3}
            raw=np.fromfile(path,np.complex64)
            # Fractional timing, arbitrary capture start, CFO and AWGN. SNR here
            # is time-domain waveform power/noise power, not claimed Eb/N0.
            delay=float(rng.uniform(-.45,.45))
            raw=np.fft.ifft(np.fft.fft(raw)*np.exp(-2j*np.pi*np.fft.fftfreq(len(raw))*delay))
            pad=int(rng.integers(103,1103)); x=np.r_[np.zeros(pad),raw]
            cfo=(-1 if ports==2 else 1)*31500
            x*=np.exp(2j*np.pi*cfo*np.arange(len(x))/rates[prb])
            noise=np.sqrt(np.mean(abs(x)**2)/200)
            x+=rng.normal(0,noise,len(x))+1j*rng.normal(0,noise,len(x))
            x.astype(np.complex64).tofile(path)
            frames,counts=decode(path,prb,pci,ports,cfo-1500)
            assert len(frames)>=4,(prb,ports,counts,frames)
            assert {f['rv'] for f in frames}=={0,1,2,3},(prb,ports,frames)
            for f in frames:
                assert f['data']==expected,(prb,ports,f)
                assert f['subframe']==5 and f['sfn']%2==0 and f['mcs']==6,f
                assert 0<=f['firstSample']<f['endSample']<=len(x),f
                start=pad+(f['sfn']*10+5)*rates[prb]/1000
                assert abs(f['endSample']-rates[prb]/1000-start)<rates[prb]/15000,(prb,ports,f,start)
                assert f['firstSample']<=start+rates[prb]/15000 and f['endSample']-f['firstSample']<=rates[prb]*.0611,f
            print(f'{prb} PRB, {ports} ports: {len(frames)} exact CRC24A-valid blocks, all RVs, fractional timing/CFO/AWGN',flush=True)
    for prb in (6,100):
        for mode in ('format1c','no-pdsch','no-pdcch','wrong-rnti'):
            subprocess.run([fixture,str(path),str(prb),'42','1','160',mode],check=True,capture_output=True)
            frames,counts=decode(path,prb,42,1)
            if mode=='format1c':
                assert len(frames)==7 and all(f['data']==expected[:44] for f in frames),(prb,mode,frames,counts)
            else:
                assert not frames,(prb,mode,frames,counts)
                if mode=='no-pdsch': assert counts[2]>=7 and (counts[3]+counts[4])>=7,(prb,mode,counts)
            print(f'{prb} PRB {mode}: {len(frames)} blocks, {counts[3]} rejected transport CRCs, {counts[4]} rejected erasures/messages',flush=True)
    for ppm in (-40,40):
        subprocess.run([fixture,str(path),'100','42','2','240'],check=True,capture_output=True)
        x=np.fromfile(path,np.complex64)
        x=resample(x,round(len(x)*(1+ppm/1e6)))
        x.astype(np.complex64).tofile(path)
        frames,counts=decode(path,100,42,2)
        assert len(frames)>=10 and all(f['data']==expected for f in frames),(ppm,counts,frames)
        print(f'100 PRB clock {ppm:+} ppm: {len(frames)} exact blocks',flush=True)
    for prb in (6,100):
        for kind in ('noise','dc'):
            n=rates[prb]//5
            x=(rng.normal(0,.2,n)+1j*rng.normal(0,.2,n) if kind=='noise' else np.full(n,.1+.2j))
            x.astype(np.complex64).tofile(path)
            frames,counts=decode(path,prb,42,1)
            assert not frames and counts[1]==0,(prb,kind,counts)
            print(f'{prb} PRB {kind}: no MIB or broadcast block',flush=True)
    upstream=Path(__file__).resolve().parents[2]/'lte-deps'/'srsRAN_4G-cc8f48a78464c4f1ac70201073279296caa827fd'/'lib/src/phy/phch/test/signal.1.92M.amar.dat'
    raw=upstream.read_bytes()
    assert len(raw)==153600
    assert hashlib.sha256(raw).hexdigest()=='3a6ad6def43478254fef7b58b3ddfdc18c83afd152fcd1a6c6d432ce178ee097'
    # A 10-ms upstream vector needs repetition for acquisition. This is not a
    # claim of continuous-air SFN progression; all repetitions carry SFN656.
    path.write_bytes(raw*12)
    frames,counts=decode(path,6,1,1)
    assert len(frames)>=10,(counts,frames)
    sib1=[f for f in frames if f['subframe']==5];si=[f for f in frames if f['subframe']==2]
    assert len(sib1)>=10 and len(si)>=10 and len(sib1)+len(si)==len(frames),frames
    assert all(f['sfn']==656 and f['data']=='6040040300011a2d4018028180420c800000' for f in sib1),sib1
    # The independently pinned waveform also contains SIB2+SIB3 at SF2. Native
    # Wireshark RRC independently corroborates this exact32-byte payload.
    assert all(f['sfn']==656 and f['data']=='00800c61bc8ca883d601ba01000408019739dcb2d5425c700308518b613a9690' for f in si),si
    print(f'Pinned upstream Amar vector SHA256 {hashlib.sha256(raw).hexdigest()}: {len(sib1)} exact SIB1 and {len(si)} exact SIB2+SIB3 blocks',flush=True)
