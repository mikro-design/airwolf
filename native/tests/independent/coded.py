import gen, numpy as np, subprocess, os, tempfile
from sweep import FEED
def fec(bits):
    d=[0,0,0]; out=[]
    for b in bits:
        out+= [b^d[0]^d[1]^d[2], b^d[1]^d[2]]; d=[b,d[0],d[1]]
    return out
def spread(bits):
    o=[]
    for b in bits: o+= [1,1,0,0] if b else [0,0,1,1]
    return o
def coded_bits(pdu,ch,aa,crcinit,S):
    pb=gen.bits_lsb(pdu); crc=gen.ble_crc_bits(pb,crcinit); body=pb+crc
    body=[a^b for a,b in zip(body,gen.ble_whiten_seq(ch,len(body)))]
    aab=[(aa>>i)&1 for i in range(32)]
    ci=[1,0] if S==2 else [0,0]
    b1=fec(aab+ci+[0,0,0]); b2=fec(body+[0,0,0])
    return [0,0,1,1,1,1,0,0]*10+spread(b1)+(spread(b2) if S==8 else b2), gen.bytes_from_bits(aab)+bytes(pdu)+gen.bytes_from_bits(crc)
def run(rate,S,ebn0,cfo=0,npk=60,seed=2,amp=30):
    rng=np.random.default_rng(seed); parts=[];exp=[]
    for i in range(npk):
        ln=int(rng.integers(1,30)); pdu=bytes([int(rng.integers(1,4)),ln])+bytes(rng.integers(0,256,ln,dtype=np.uint8))
        bits,e=coded_bits(pdu,16,0xaa08192b,0xc4c181,S); exp.append(e.hex())
        parts.append(gen.gfsk(bits,rate,1e6,300+rng.uniform(0,rate/1e6)))
    x=np.concatenate(parts); rb=1e6/(8 if S==8 else 2)
    sigma=0 if ebn0 is None else amp/np.sqrt(2*10**(ebn0/10)*rb/rate)
    with tempfile.TemporaryDirectory() as temp:
        fn=os.path.join(temp,'input.iq');gen.to_radio(x,rate,cfo,amp,sigma,10,rng).tofile(fn)
        r=subprocess.run([FEED,"ble","16",str(int(rate)),"coded","aa08192b","c4c181",fn],capture_output=True,text=True,check=True,timeout=30)
    got=[l.split() for l in r.stdout.splitlines()]
    return sum(1 for e in exp if any(g[3]==e for g in got))/npk
