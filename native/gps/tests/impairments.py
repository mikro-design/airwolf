"""Near/far ambiguity, weak acquisition and GPS interference through real DSP."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from impairment_signal import gen

worker = str(Path(sys.argv[1]).resolve())

def satellites(values):
    return [(p,c,d,31.37537*(p%7+1)/7) for p,c,d in values]

def receive(file,rate,allowed):
    run = subprocess.run([worker,str(file),str(rate),'1'],check=True,capture_output=True,
                         text=True,timeout=180,env={**os.environ,'AIRWOLF_GPS_TEST_STATUS':'1'})
    assert not any(s in run.stderr for s in ('runtime error:','AddressSanitizer','UndefinedBehaviorSanitizer')),run.stderr
    truth = {(p['prn'],p['tow']):p for p in json.loads(Path(str(file)+'.truth.json').read_text())}
    packets = [json.loads(line) for line in run.stdout.splitlines()]
    for packet in packets:
        expected = truth.get((packet['prn'],packet['tow']))
        assert packet['prn'] in allowed and expected and packet['hex']==expected['hex'] and packet['subframe']==expected['subframe'],packet
    tracked = {int(line.split()[2]) for line in run.stderr.splitlines() if line.startswith('GPS_TRACK ')}
    assert tracked<=allowed,('Phantom tracked satellite',tracked,allowed)
    return packets

with tempfile.TemporaryDirectory(prefix='airwolf-gps-impairments-') as directory:
    file = Path(directory)/'gps.iq'
    strong = satellites([(2,55,1000),(9,55,1000),(16,54,1500)])
    gen(file,90,strong,rate=2000000,seed=51)
    packets = receive(file,2000000,{2,9,16})
    assert all(sum(p['prn']==prn for p in packets)>=12 for prn in (2,9,16)),packets
    print('90 s near/far cross-correlation: exact navigation, no phantom PRNs at any status update',flush=True)
    gen(file,42,satellites([(17,35,-2300)]),rate=8000000,seed=11)
    packets = receive(file,8000000,{17})
    assert len(packets)>=5,packets
    print('35 dB-Hz cold acquisition: five exact navigation subframes',flush=True)
    sources = satellites([(5,45,-1200),(12,42,2700),(20,40,-3300),(25,38,900)])
    for name, impairment, required in [('tone',dict(cw_dbc=7,cw_hz=300000),4),
                                      ('pulses',dict(burst_db=20,burst_ms=1,burst_period_ms=10),3)]:
        gen(file,30,sources,rate=8000000,seed=41,**impairment)
        packets = receive(file,8000000,{5,12,20,25})
        assert len({p['prn'] for p in packets})>=required and len(packets)>=3*required,(name,packets)
        print(f'{name}: {len(packets)} exact subframes from {len({p["prn"] for p in packets})} satellites',flush=True)
    for impairment in ({},dict(cw_dbc=7,cw_hz=300000),dict(burst_db=20,burst_ms=1,burst_period_ms=10)):
        gen(file,12,[],rate=2000000,seed=41,**impairment)
        assert not receive(file,2000000,set())
    print('Noise, tone-only and pulsed noise: no navigation or confirmed satellites',flush=True)
