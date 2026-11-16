"""Replay Daniel Estévez's CC-BY-4.0 GPS L1 recording, Zenodo 6394603.
Usage: recorded.py ORIGINAL_SIGMF_DATA GPS_WORKER [OUTPUT_DIRECTORY]
Download separately from https://zenodo.org/records/6394603 (240 MB).
Original IQ is never committed. The checksum pins the independent RF oracle.
"""
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from scipy.signal import resample_poly
source,worker=Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve()
root=Path(__file__).resolve().parents[3]
manifest=json.loads((root/'tests/fixtures/gps/recorded.json').read_text())
with source.open('rb') as f: assert hashlib.file_digest(f,'sha512').hexdigest()==manifest['sha512'],'Public GPS IQ checksum mismatch'
with tempfile.TemporaryDirectory(prefix='airwolf-gps-recorded-') as temp:
    directory=Path(sys.argv[3]) if len(sys.argv)>3 else Path(temp);directory.mkdir(parents=True,exist_ok=True)
    file=directory/'gps-public-8M.iq';data=np.memmap(source,dtype='<i2',mode='r').reshape(-1,2)
    with file.open('wb') as f:
        for first in range(0,len(data),1000000):
            end=min(len(data),first+1000000);lo=max(0,first-64);hi=min(len(data),end+64)
            z=data[lo:hi,0].astype(np.float32)+1j*data[lo:hi,1].astype(np.float32)
            z=resample_poly(z,2,1)[2*(first-lo):2*(end-lo)]/64
            z*=np.resize(np.array([1,-1j,-1,1j],np.complex64),len(z))
            iq=np.column_stack((z.real,z.imag));f.write(np.clip(np.rint(iq),-127,127).astype(np.int8).tobytes())
    def decode(first,count,context=()):
        r=subprocess.run([str(worker),'decode',str(file),str(first),str(count),'gps','8000000','1575420000','1577420000','1m','2391391958','5592405',*map(str,context)],text=True,capture_output=True,timeout=120)
        assert r.returncode==0,r.stderr
        assert 'runtime error:' not in r.stderr and 'AddressSanitizer' not in r.stderr,r.stderr
        return json.loads(r.stdout)
    result=decode(0,120000000);expected={p['gpsPrn']:p['bytes'] for p in manifest['packets']}
    packets=result['packets'];assert len(packets)==7 and {p['gpsPrn']:p['bytes'] for p in packets}==expected
    report={'source':manifest['source'],'satellites':sorted(expected),'elapsedMs':result['elapsedMs'],'exactExcerptReplays':[]}
    for p in packets:
        selection=decode(p['firstSample'],p['endSample']-p['firstSample'],(p['gpsPrn'],p['gpsDopplerHz']))
        found=selection['packets'];assert len(found)==1 and found[0]['bytes']==p['bytes'] and found[0]['gpsPrn']==p['gpsPrn'] and found[0]['integrity']=='valid'
        report['exactExcerptReplays'].append({'prn':p['gpsPrn'],'elapsedMs':selection['elapsedMs']})
    (directory/'gps-public-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
