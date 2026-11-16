"""Independent GPS L1 C/A waveform: IS-GPS-200N §§3.3.2.3, 20.3.3.
No PocketSDR/production generator functions. Optional original-IQ fixture output.
"""
from pathlib import Path
import json, math, struct, sys
import numpy as np
from navigation import encode, frame, put

# Table 3-Ia, PRN 17: G2 stages 1 XOR 4; first ten chips octal 1156.
def ca17():
    g1, g2, chips = [1]*10, [1]*10, []
    for _ in range(1023):
        chips.append(g1[9] ^ g2[0] ^ g2[3])
        g1 = [g1[2] ^ g1[9]] + g1[:9]
        g2 = [g2[1]^g2[2]^g2[5]^g2[7]^g2[8]^g2[9]] + g2[:9]
    assert int(''.join(map(str,chips[:10])),2) == int('1156',8)
    return np.array(chips,dtype=np.int8)

def navigation():
    payloads=[]
    for sf,tow in [(4,5994),(5,6000),(1,6006)]:
        bits=frame(sf,55 if sf==4 else 51)
        # Vary payload bits so a synchronization fixture has representative transitions.
        rng=np.random.default_rng(sf+917)
        bits[72:]=rng.integers(0,2,len(bits)-72).tolist()
        put(bits,24,17,tow//6)
        if sf==4:
            for i,b in enumerate(b'AIR NAV TEST 1234567890'): put(bits,56+8*i,8,b)
        elif sf==5: put(bits,64,8,211)
        else: put(bits,48,10,357)
        payloads.append(encode(bits))
    return payloads

def generate(path,rate=8000000,doppler=1800,ppm=None,cn0=47,seconds=15,offset=True,noise_only=False):
    if ppm is None: ppm=doppler/1575.42
    chips=ca17();payloads=navigation()
    bits=np.array([(w>>b)&1 for raw in payloads for w in struct.unpack('<10I',raw) for b in range(29,-1,-1)],np.int8)
    sigma=18;amplitude=math.sqrt(10**(cn0/10)*2*sigma*sigma/rate)
    rng=np.random.default_rng(9472);count=round(seconds*rate);delay=.03137537
    with Path(path).open('wb') as f:
        for first in range(0,count,262144):
            n=np.arange(first,min(count,first+262144));t=n/rate
            tx=(t-delay)*(1+ppm*1e-6)
            ci=np.floor(tx*1023000).astype(np.int64)%1023
            ni=np.floor(tx*50).astype(np.int64)
            signal=amplitude*(1-2*(chips[ci]^bits[np.clip(ni,0,len(bits)-1)]))
            signal[(tx<0)|(ni>=len(bits))]=0
            if noise_only: signal*=0
            phase=2*np.pi*(doppler-(rate/4 if offset else 0))*t+.71
            z=signal*np.exp(1j*phase)
            iq=np.column_stack((z.real,z.imag))+rng.normal(0,sigma,(len(n),2))
            f.write(np.clip(np.rint(iq),-127,127).astype(np.int8).tobytes())
    return {'prn':17,'bytes':list(payloads[1]),'subframe':5,'tow':6000,'navFirstSample':round((delay+6/(1+ppm*1e-6))*rate),'navEndSample':round((delay+12/(1+ppm*1e-6))*rate),'samples':count,'cn0':cn0,'dopplerHz':doppler,'clockPpm':ppm}

if __name__=='__main__':
    print(json.dumps(generate(sys.argv[1])))
