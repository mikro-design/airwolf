"""Multipath regression through the production receive chain, without cell hints.

The shared srsRAN transmitter supplies symbols; the channel model is separate.
This covers two paths inside the normal cyclic prefix, not hardware RF quality.
"""
import json
from pathlib import Path
import sys
import tempfile
import checked_subprocess as subprocess
from channel_signal import gen

fixture, worker = map(lambda p: str(Path(p).resolve()), sys.argv[1:3])
expected = {
    '6040040300011a2d4018028180420c8000000000000000000000000000000000',
    '000149001250400800094000a03f01000a7fc9800104286c000c000000000000',
}
with tempfile.TemporaryDirectory(prefix='airwolf-lte-multipath-') as directory:
    iq = Path(directory) / 'channel.iq'
    for rate, prb, ports in ((8000000,25,1),(8000000,25,2),(10000000,50,1),
                             (16000000,75,2),(20000000,100,2)):
        for delay, phase in ((2,1.1),(2,2.5),(3,.3)):
            count = gen(fixture,iq,rate,prb,640,30,ports=ports,
                        echo_db=-3,echo_us=delay,echo_phase=phase,seed=6)
            run = subprocess.run([worker,'decode',str(iq),'0',str(count),'lte',str(rate),
                                  '2660000000','2660000000','1m','2391391958','5592405'],
                                 check=True,capture_output=True,text=True,timeout=60)
            packets = json.loads(run.stdout)['packets']
            mib = [p for p in packets if p['lteChannel']=='bcch-bch']
            si = [p for p in packets if p['lteChannel']=='bcch-dl-sch']
            assert len(mib)>=20 and len(si)>=10,(rate,prb,ports,delay,phase,len(mib),len(si))
            assert all(p['integrity']=='valid' and p['ltePci']==42 and
                       p['ltePrb']==prb and p['ltePorts']==ports for p in packets)
            assert {bytes(p['bytes']).hex() for p in si}==expected,(rate,si)
            print(f'{rate/1e6:g} MS/s, {ports} ports, -3 dB echo {delay} us/{phase} rad: '
                  f'{len(mib)} MIB, {len(si)} exact SI',flush=True)
