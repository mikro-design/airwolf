import gen, numpy as np, subprocess, sys, os, tempfile, pathlib
FEED = os.environ.get("AIRWOLF_TEST_FEED", str(pathlib.Path(__file__).resolve().parents[2] / "build" / "airwolf-iq-feed"))
def run(proto, rate, phy, cfo, ebn0, npk=40, seed=1, channel=None, dc=10, amp=30, plen=20, timing=None, ppm=0):
    rng=np.random.default_rng(seed)
    rb={'1m':1e6,'2m':2e6}.get(phy,1e6) if proto=='ble' else 250e3
    sigma=0 if ebn0 is None else amp/np.sqrt(2*10**(ebn0/10)*rb/rate)
    parts=[]; expect=[]; pos=0
    aa,crc=(0x8e89bed6,0x555555) if (channel if channel is not None else 37)>=37 else (0xaa08192b,0xc4c181)
    ch=channel if channel is not None else (37 if proto=='ble' else 15)
    for i in range(npk):
        start=300+ (rng.uniform(0,rate/ (rb if proto=='ble' else 2e6)) if timing is None else timing)
        if proto=='ble':
            if ch>=37:
                ln=rng.integers(6,38); pdu=bytes([int(rng.integers(0,7)),ln])+bytes(rng.integers(0,256,ln,dtype=np.uint8))
            else:
                ln=plen; pdu=bytes([int(rng.integers(1,4)),ln])+bytes(rng.integers(0,256,ln,dtype=np.uint8))
            bits,exp=gen.ble_air_bits(pdu,ch,aa,crc,phy)
            x=gen.gfsk(bits,rate*(1+ppm*1e-6),rb,start); aastart=start+(16 if phy=='2m' else 8)*rate/rb
        else:
            ln=int(rng.integers(3,60)) if plen==20 else plen; exp=gen.wpan_frame(bytes(rng.integers(0,256,ln,dtype=np.uint8)))
            x=gen.oqpsk(exp,rate*(1+ppm*1e-6),start); aastart=start
        expect.append((exp,pos+aastart,pos+len(x)))
        parts.append(x); pos+=len(x)
    x=np.concatenate(parts)
    iq=gen.to_radio(x,rate,cfo,amp,sigma,dc,rng)
    with tempfile.TemporaryDirectory() as temp:
        fn=os.path.join(temp, 'input.iq'); iq.tofile(fn)
        r=subprocess.run([FEED,proto,str(ch),str(rate),phy,f"{aa:x}",f"{crc:x}",fn],capture_output=True,text=True,check=True,timeout=30)
    got=[l.split() for l in r.stdout.splitlines()]
    hexes={g[3]:g for g in got}
    ok=0; terr=[]
    for exp,a,_ in expect:
        g=hexes.get(exp.hex())
        if g: ok+=1; terr.append(int(g[0])-a)
    extra=len(got)-ok
    return ok/npk, extra, (np.mean(terr),np.min(terr),np.max(terr)) if terr else None, r.stderr.strip()
if __name__=="__main__":
    pass
