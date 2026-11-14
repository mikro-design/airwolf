"""Receive-pipeline retention cost, without USB. Unix wait4 measures child CPU only.

Run after the native build, on an otherwise idle machine. This compares a
20 MS/s synthetic tone with/without IQ history, including native FFT and BLE
search. It is not a packet-heavy or calibrated hardware benchmark.
"""
import json,os,sys,time,statistics,tempfile
from pathlib import Path
binary=str(Path(sys.argv[1] if len(sys.argv)>1 else 'native/build/bin/airwolf-radio').resolve())
rows=[]
for pair in range(3):
    for retain in (False,True):
        args=[binary,'--simulate','--sample-rate','20000000','--frequency','2402000000','--decoder','ble','--duration-ms','3000']+(['--retain-iq'] if retain else [])
        with tempfile.TemporaryFile() as errors:
            start=time.monotonic();pid=os.fork()
            if pid==0:
                with open(os.devnull,'wb') as null:os.dup2(null.fileno(),1)
                os.dup2(errors.fileno(),2);os.execv(binary,args)
            _,status,usage=os.wait4(pid,0);elapsed=time.monotonic()-start
            errors.seek(0);stats=errors.read().decode()
            assert os.waitstatus_to_exitcode(status)==0,stats
            assert 'queue_dropped_samples=0' in stats,stats
            rows.append({'pair':pair,'retain':retain,'cpuPercentOneCore':100*(usage.ru_utime+usage.ru_stime)/elapsed,
                'maxRssMiB':usage.ru_maxrss/(1024**2 if sys.platform=='darwin' else 1024),'drops':0})
print(json.dumps({'samplesPerSecond':20000000,'secondsPerRun':3,'runs':rows,
    'medianCpuWithout':statistics.median(r['cpuPercentOneCore'] for r in rows if not r['retain']),
    'medianCpuWith':statistics.median(r['cpuPercentOneCore'] for r in rows if r['retain'])},indent=2))
