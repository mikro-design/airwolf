"""12-bit file entry points for LTE/LoRa/GPS through production receive chains.
The public LTE/LoRa captures were acquired on other hardware. Conversion verifies
sample-format integration; it does not establish Pluto hardware sensitivity.
"""
import json, pathlib, subprocess, sys, tempfile
import numpy as np
from scipy.signal import resample_poly
ROOT=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'native/gps/tests'))
from gps_signal import generate

def run(binary,file,count,protocol,rate,frequency,lo,extra=()):
    p=subprocess.run([str(binary),'decode',str(file),'0',str(count),protocol,str(rate),str(frequency),str(lo),'1m',str(0x8e89bed6),str(0x555555),*map(str,extra),'--iq-format','ci16_le','12'],capture_output=True,text=True,timeout=90)
    assert p.returncode==0,p.stderr
    return json.loads(p.stdout)['packets']
def verify(build):
    build=pathlib.Path(build)
    def worker(protocol):return build/'bin'/('airwolf-'+protocol+'-radio'+('.exe' if sys.platform=='win32' else ''))
    with tempfile.TemporaryDirectory(prefix='airwolf-iio-replay-') as tmp:
        tmp=pathlib.Path(tmp);file=tmp/'samples.ci16'
        sources=ROOT/'native/tests/fixtures/lte-cell-scanner'
        for case in json.loads((sources/'sources.json').read_text()):
            raw=np.fromfile(sources/case['file'],np.int8).astype(np.float32)
            wave=resample_poly(raw[::2]+1j*raw[1::2],25,6)
            codes=np.empty(len(wave)*2,dtype='<i2');codes[::2]=np.clip(np.rint(wave.real*16),-2048,2047);codes[1::2]=np.clip(np.rint(wave.imag*16),-2048,2047);codes.tofile(file)
            frames=run(worker('lte'),file,len(wave),'lte',8000000,1860000000,1860000000)
            assert len(frames)>=case['minimum_mibs'],frames
            assert all(p['ltePci'] in case['pci'] and p['integrity']=='valid' for p in frames),frames
            print('LTE 12-bit recorded',case['file'],len(frames),'verified MIBs',flush=True)
        source=ROOT/'native/lora/tests/fixtures';meta=json.loads((source/'sources.json').read_text())
        codes=np.fromfile(source/meta['file'],np.int8).astype('<i2')*16;codes.tofile(file)
        frames=run(worker('lora'),file,len(codes)//2,'lora',10000000,868100000,870600000,(125000,7,52,0,0))
        assert len(frames)==1 and bytes(frames[0]['bytes']).hex()==meta['expectedPayload'] and frames[0]['integrity']=='valid',frames
        print('LoRa 12-bit recorded exact frame',flush=True)
        original=tmp/'gps.ci8';expected=generate(original,rate=8000000,seconds=13)
        with original.open('rb') as src,file.open('wb') as out:
            while data:=src.read(262144):out.write((np.frombuffer(data,np.int8).astype('<i2')*16).tobytes())
        frames=run(worker('gps'),file,expected['samples'],'gps',8000000,1575420000,1577420000,(17,1800))
        assert any(p['bytes']==expected['bytes'] and p['integrity']=='valid' for p in frames),frames
        print('GPS 12-bit generated IQ: exact parity-verified navigation',flush=True)
if __name__=='__main__':verify(sys.argv[1])
