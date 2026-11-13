"""Spec-literal extended advertising through the real ChannelReceiver.
The generator does not import receiver code. Includes max PDUs, fractional timing,
frequency error, all sample rates, both primary and secondary RF channels.
"""
import sys, tempfile, subprocess
from pathlib import Path
import numpy as np
import gen
from coded import coded_bits

def verify(feed):
    rng=np.random.default_rng(74419); tested=0
    with tempfile.TemporaryDirectory() as tmp:
        filename=str(Path(tmp)/'extended.iq')
        for rate in (8000000,10000000,16000000,20000000):
            for channel,phy,spread in ((37,'1m',0),(38,'coded',2),(39,'coded',8),(0,'1m',0),(16,'2m',0),(36,'coded',2),(16,'coded',8)):
                expected=[];waves=[]
                for length in (1,20,255):
                    # Header length 0, or AdvA + ADI + AuxPtr + TxPower.
                    payload=bytes([0]) if length==1 else bytes([13,0x59,1,2,3,4,5,6,0x34,0x12,16,1,0,0xf6])+bytes(rng.integers(0,256,length-14,dtype=np.uint8))
                    pdu=bytes([7,length])+payload
                    if spread: bits,want=coded_bits(pdu,channel,0x8e89bed6,0x555555,spread)
                    else: bits,want=gen.ble_air_bits(pdu,channel,0x8e89bed6,0x555555,phy)
                    waves.append(gen.gfsk(bits,rate,2e6 if phy=='2m' else 1e6,300+rng.uniform(0,rate/1e6)))
                    expected.append(want.hex())
                gen.to_radio(np.concatenate(waves),rate,150000,30,1,10,rng).tofile(filename)
                run=subprocess.run([feed,'ble',str(channel),str(rate),phy,'8e89bed6','555555',filename],capture_output=True,text=True,timeout=30,check=True)
                got=[line.split()[3] for line in run.stdout.splitlines()]
                assert got==expected, (rate,channel,phy,spread,[len(x) for x in got],run.stderr)
                tested+=len(expected)
    print(f'{tested} extended advertising packets recovered exactly, primary/auxiliary, 1M/2M/S2/S8, all input rates')
if __name__=='__main__': verify(sys.argv[1])
