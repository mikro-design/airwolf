"""Exact production selection replay. Independent BLE/WPAN/Wi-Fi generators;
LTE is explicitly a shared-library TX fixture, not an independent oracle.
No USB, RF transmission or packet annotations are available to the decoder.
"""
import json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np

native, lte, fixture = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='airwolf-selection-') as tmp:
    root=Path(tmp)
    expected=json.loads(subprocess.check_output([sys.executable,str(Path(__file__).with_name('reception_fixtures.py')),tmp,fixture],text=True))
    def replay(proto,first=0,count=None,*,file=None,rate=None,lo=None,ok=True):
        file=file or root/(proto+'.iq')
        hz=(rate or (20 if proto=='wifi' else 8))*1000000
        frequency={'ble':2402000000,'wifi':5300000000,'15p4':2405000000,'zigbee':2405000000,'lte':2660000000}[proto]
        center=lo or (frequency if proto in ['wifi','lte'] else frequency+hz//4)
        args=[lte if proto=='lte' else native,'decode',str(file),str(first),str(count if count is not None else file.stat().st_size//2-first),proto,str(hz),str(frequency),str(center),'coded',str(0x8e89bed6),str(0x555555)]
        r=subprocess.run(args,capture_output=True,text=True,timeout=30)
        if not ok:
            assert r.returncode!=0,(proto,r.stdout); return
        assert r.returncode==0,(proto,r.stderr)
        data=json.loads(r.stdout)
        assert data['firstSample']==first
        assert data['endSample']==first+data['processedSamples']
        for p in data['packets']:
            assert first<=p['firstSample']<p['endSample']<=data['endSample']
        return data
    for proto in ['ble','wifi','15p4','zigbee','lte']:
        full=replay(proto)
        assert full['packets'],proto
        assert all(p['integrity']=='valid' for p in full['packets']),proto
        if proto in expected:
            assert bytes(full['packets'][0]['bytes']).hex()==expected[proto],proto
            p=full['packets'][0]
            # A crop through the payload must not replay cached or annotated bytes.
            cut=(p['firstSample']+p['endSample'])//2
            assert not replay(proto,cut,p['endSample']-cut)['packets'],proto
            # Original sample offsets must survive a nonzero file seek.
            start=max(0,p['firstSample']-800)
            selected=replay(proto,start)
            assert bytes(selected['packets'][0]['bytes']).hex()==expected[proto],proto
        assert not replay(proto,0,64)['packets'],proto
        noise=root/'noise.iq';np.random.default_rng(19).integers(-8,9,32000,dtype=np.int8).tofile(noise)
        assert not replay(proto,file=noise)['packets'],proto
        replay(proto,lo=1234567890,ok=False)
        print(proto,'exact replay, incomplete range, noise and LO validation passed')
    # Correct radio framing with intentionally wrong MAC FCS: recovered is not
    # synonymous with valid. The UI must receive the failed integrity verdict.
    sys.path.insert(0,str(Path(__file__).parent/'independent'))
    import gen
    bad=bytearray(gen.wpan_frame(bytes.fromhex('020001')));bad[-1]^=1
    invalid=root/'bad-fcs.iq'
    gen.to_radio(gen.oqpsk(bad,8000000,300.37),8000000,0,30,0,0,np.random.default_rng(33)).tofile(invalid)
    corrupt=replay('15p4',file=invalid)
    assert corrupt['packets'] and corrupt['packets'][0]['integrity']=='invalid',corrupt
    assert bytes(corrupt['packets'][0]['bytes'])==bad
    print('Corrupt FCS recovered and labelled invalid')
    # Offline backpressure: a long file must not overflow the live queue. Output
    # remains bounded and omitted results are reported explicitly.
    long=root/'long.iq';long.write_bytes((root/'lte.iq').read_bytes()*5)
    result=replay('lte',file=long)
    assert len(result['packets'])==256 and result['omittedPackets']>0,result
    print('LTE offline queue and bounded results passed')
