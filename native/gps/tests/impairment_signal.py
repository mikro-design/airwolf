"""Multi-satellite GPS L1 C/A impairment generator. Uses the gps_signal.py model
(IS-GPS-200 G2 phase-selector codes for PRN 1-32, LNAV subframes 1-5 cycling with consecutive TOW,
Doppler/code coupling, independent receiver clock ppm, AWGN sigma=18, offset tuning +fs/4) and adds
CW / pulsed-noise interference and clipping. Writes int8 IQ and a JSON truth file (expected words per PRN/TOW).
Usage: python3 gen_gps.py OUT.iq SECONDS 'prn:cn0:doppler[:delay_ms],...' [key=value]"""
import sys, json, math, struct
from pathlib import Path
import numpy as np
from navigation import encode, frame, put
TAPS={1:(2,6),2:(3,7),3:(4,8),4:(5,9),5:(1,9),6:(2,10),7:(1,8),8:(2,9),9:(3,10),10:(2,3),11:(3,4),12:(5,6),13:(6,7),14:(7,8),15:(8,9),16:(9,10),
17:(1,4),18:(2,5),19:(3,6),20:(4,7),21:(5,8),22:(6,9),23:(1,3),24:(4,6),25:(5,7),26:(6,8),27:(7,9),28:(8,10),29:(1,6),30:(2,7),31:(3,8),32:(4,9)}
def ca(prn):
    a,b=TAPS[prn]; g1,g2,c=[1]*10,[1]*10,[]
    for _ in range(1023):
        c.append(g1[9]^g2[a-1]^g2[b-1]); g1=[g1[2]^g1[9]]+g1[:9]; g2=[g2[1]^g2[2]^g2[5]^g2[7]^g2[8]^g2[9]]+g2[:9]
    return np.array(c,np.int8)
assert int(''.join(map(str,ca(17)[:10])),2)==int('1156',8) and int(''.join(map(str,ca(1)[:10])),2)==int('1440',8)
def nav(prn,nsub,tow0=6000):
    out=[]
    for k in range(nsub):
        sf=(k%5)+1; bits=frame(sf,1 if sf>=4 else 0)
        rng=np.random.default_rng(prn*1000+k); bits[72:]=rng.integers(0,2,len(bits)-72).tolist()
        if sf>=4: put(bits,48,2,1); put(bits,50,6,(prn+k)%25+1)
        put(bits,24,17,(tow0+6*k)//6); put(bits,43,3,sf)
        out.append((sf,tow0+6*k,encode(bits)))
    return out
def gen(path,seconds,sats,rate=8000000,rx_ppm=0.0,sigma=18,cw_dbc=None,cw_hz=1.0e3,burst_db=None,burst_ms=1.0,burst_period_ms=10.0,gain=1.0,offset=True,seed=1,gap_at_s=None):
    count=round(seconds*rate); rng=np.random.default_rng(seed); truth=[]; S=[]
    # An optional fifth value makes a cross-correlation phantom of that source
    # PRN as the correlator of this PRN sees it: this Doppler and power, a code
    # the tracking loops can hold (the persistent kind), and the source's
    # navigation bits with the source's bit edges.
    source={p:dl for p,_,_,dl,*_ in sats}
    for (prn,cn0,dop,delay,*echo) in sats:
        code_dop=dop
        if echo: delay=source[echo[0]]
        subs=nav(echo[0] if echo else prn,int(seconds/6)+2); bits=np.array([(w>>b)&1 for _,_,raw in subs for w in struct.unpack('<10I',raw) for b in range(29,-1,-1)],np.int8)
        # TOW field = time of NEXT subframe start; our subframe k starts at tx time 6k s; label as in shipped generator
        for k,(sf,tow,raw) in enumerate(subs if not echo else []): truth.append({'prn':prn,'subframe':sf,'tow':tow,'hex':raw.hex()})
        amp=math.sqrt(10**(cn0/10)*2*sigma*sigma/rate); fd=dop-rx_ppm*1575.42
        S.append((ca(prn),bits,amp,fd,delay/1000.0,(code_dop/1575.42)-rx_ppm))
    with Path(path).open('wb') as f:
        for first in range(0,count,262144):
            n=np.arange(first,min(count,first+262144)); t=n/rate; z=np.zeros(len(n),np.complex128)
            for chips,bits,amp,fd,delay,ppm in S:
                tx=(t-delay)*(1+ppm*1e-6); ci=np.floor(tx*1023000).astype(np.int64)%1023; ni=np.floor(tx*50).astype(np.int64)
                s=amp*(1-2*(chips[ci]^bits[np.clip(ni,0,len(bits)-1)])); s[(tx<0)|(ni>=len(bits))]=0
                z+=s*np.exp(1j*(2*np.pi*fd*t+.71+prn_phase(chips)))
            if cw_dbc is not None: z+=sigma*10**(cw_dbc/20)*np.exp(2j*np.pi*cw_hz*t)
            if burst_db is not None:
                ph=(t*1000)%burst_period_ms; m=ph<burst_ms; a=sigma*10**(burst_db/20)
                z[m]+=rng.normal(0,a,m.sum())+1j*rng.normal(0,a,m.sum())
            if offset: z*=np.exp(-2j*np.pi*(rate/4)*t)
            iq=np.column_stack((z.real,z.imag))+rng.normal(0,sigma,(len(n),2))
            f.write(np.clip(np.rint(iq*gain),-127,127).astype(np.int8).tobytes())
    json.dump(truth,open(str(path)+'.truth.json','w'))
def prn_phase(chips): return float(int(chips[:16].dot(1<<np.arange(16)))%628)/100
