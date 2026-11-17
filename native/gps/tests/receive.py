"""Generated RF enters the production filter/tracker; annotations cannot supply bits."""
import json, os, subprocess, sys, tempfile
from pathlib import Path
from gps_signal import generate
feed=Path(sys.argv[1]).resolve()
worker=Path(sys.argv[2]).resolve()
def run(file, rate, prn=None, cfo=0, gap=None, repeat=False):
    env={**os.environ}
    if gap: env['AIRWOLF_GPS_TEST_GAP_SAMPLE']=str(gap)
    if repeat: env['AIRWOLF_GPS_TEST_REPEAT_AFTER_GAP']='1'
    args=[str(feed),str(file),str(rate),'1']+([str(prn),str(cfo)] if prn else [])
    p=subprocess.run(args,text=True,capture_output=True,env=env,timeout=90)
    assert p.returncode==0,p.stderr
    assert 'runtime error:' not in p.stderr and 'AddressSanitizer' not in p.stderr,p.stderr
    return [json.loads(line) for line in p.stdout.splitlines()]
with tempfile.TemporaryDirectory(prefix='airwolf-gps-rf-') as temp:
    file=Path(temp)/'gps.iq'
    # Fractional sample timing, physical Doppler/code clock coupling, both signs,
    # and a small independent clock error. 8 MS/s is the offered USB/replay rate.
    for rate,cfo,cn0,error in [(8000000,1800,47,0),(2000000,-3500,43,0),
                               (2000000,4882.8125,43,0),(2000000,-4882.8125,43,0),
                               (2000000,5100,43,0),(2000000,-5100,43,0),
                               (2000000,23000,47,.05),(2000000,-41000,47,-.05)]:
        expected=generate(file,rate=rate,doppler=cfo,cn0=cn0,ppm=cfo/1575.42+error)
        frames=run(file,rate,17 if abs(cfo)>10000 else None,cfo)
        wanted=[p for p in frames if p['prn']==17 and p['subframe']==5 and p['tow']==6000 and bytes.fromhex(p['hex'])==bytes(expected['bytes'])]
        assert len(wanted)==1,(rate,cfo,frames)
        p=wanted[0]
        assert abs(p['navFirstSample']-expected['navFirstSample'])<rate*.002,p
        assert abs(p['navEndSample']-expected['navEndSample'])<rate*.002,p
        assert abs(p['dopplerHz']-cfo)<30,p
        if rate==2000000 and cfo==-3500:
            recovered=run(file,rate,repeat=True)
            assert len(recovered)==2 and all(bytes.fromhex(p['hex'])==bytes(expected['bytes']) for p in recovered),recovered
            assert abs(recovered[1]['navFirstSample']-recovered[0]['navFirstSample']-expected['samples']-17)<rate*.002,recovered
        if rate==8000000:
            args=[str(worker),'decode',str(file),str(p['firstSample']),str(p['endSample']-p['firstSample']),'gps',str(rate),'1575420000','1577420000','1m','2391391958','5592405','17',str(p['dopplerHz'])]
            replay=subprocess.run(args,text=True,capture_output=True,timeout=90)
            assert replay.returncode==0,replay.stderr
            assert 'runtime error:' not in replay.stderr and 'AddressSanitizer' not in replay.stderr,replay.stderr
            results=json.loads(replay.stdout)['packets'];assert len(results)==1,results
            assert results[0]['bytes']==expected['bytes'] and results[0]['integrity']=='valid'
            assert not run(file,rate,17,cfo,gap=rate*9),'Navigation cannot cross a missing sample interval'
        print(f'GPS RF {rate} Hz, CFO {cfo:+} Hz, C/N0 {cn0} dB-Hz: exact navigation',flush=True)
    generate(file,rate=2000000,noise_only=True)
    assert not run(file,2000000),'Noise produced a navigation frame'
    generate(file,rate=8000000,seconds=10)
    assert not run(file,8000000,17,1800),'Incomplete first navigation interval was fabricated'
    # Parity and preamble are valid, but the TOW count (110000 * 6 s) exceeds a
    # week. PocketSDR accepts the subframe; Airwolf must drop it, not stop.
    generate(file,rate=8000000,tows=(5994,660000,6006))
    args=[str(worker),'decode',str(file),'0',str(8000000*15),'gps','8000000','1575420000','1577420000','1m','2391391958','5592405','17','1800']
    replay=subprocess.run(args,text=True,capture_output=True,timeout=90)
    assert replay.returncode==0,replay.stderr
    assert all(p['gpsTow']!=660000 for p in json.loads(replay.stdout)['packets'])
print('GPS RF: Doppler/clock/noise, exact excerpt replay, gaps, truncation and out-of-range TOW passed')
