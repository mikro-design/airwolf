import numpy as np
from scipy.special import erf
# ---- Spec-literal BLE (Core Vol 6 Part B 3.1.1 CRC, 3.2 whitening) ----
def ble_whiten_seq(channel, nbits):
    # positions 0..6; pos0=1, pos1..6 = channel MSB..LSB
    r=[1]+[(channel>>(5-i))&1 for i in range(6)]
    out=[]
    for _ in range(nbits):
        o=r[6]; out.append(o)
        r=[o,r[0],r[1],r[2],r[3]^o,r[4],r[5]]
    return out
def ble_crc_bits(bits, init):
    # 24-bit LFSR, positions 0..23, preset: pos0 = LSB of init ... ; poly x^24+x^10+x^9+x^6+x^4+x^3+x+1
    r=[(init>>i)&1 for i in range(24)]
    for b in bits:
        fb=r[23]^b
        n=[0]*24
        n[0]=fb
        for i in range(1,24): n[i]=r[i-1]^(fb if i in (1,3,4,6,9,10) else 0)
        r=n
    return [r[23-i] for i in range(24)]  # transmitted MSB (pos 23) first
def bits_lsb(bs): return [(b>>i)&1 for b in bs for i in range(8)]
def bytes_from_bits(bits): return bytes(sum(bits[i+k]<<k for k in range(8)) for i in range(0,len(bits),8))
def ble_air_bits(pdu, channel, aa, crcinit, phy):
    pb=bits_lsb(pdu); crc=ble_crc_bits(pb,crcinit)
    body=pb+crc; w=ble_whiten_seq(channel,len(body))
    body=[a^b for a,b in zip(body,w)]
    aab=[(aa>>i)&1 for i in range(32)]
    npre=16 if phy=='2m' else 8
    # preamble starts so it alternates and its first bit equals first AA bit
    pre=[aab[0]^(i&1) for i in range(npre)]
    return pre+aab+body, bytes_from_bits(aab)+bytes(pdu)+bytes_from_bits(crc)
def gfsk(bits, fs, rs, start, bt=0.5, h=0.5):
    sps=fs/rs; n=int(start+ (len(bits)+6)*sps)+200
    u=(np.arange(n)-start)/sps
    a=np.pi*bt*np.sqrt(2/np.log(2))
    b=np.array(bits)*2-1; f=np.zeros(n); k0=np.floor(u).astype(int)
    for d in range(-3,4):
        k=k0+d; ok=(k>=0)&(k<len(b)); x=u-k
        f+=np.where(ok,b[np.clip(k,0,len(b)-1)],0)*0.5*(erf(a*x)-erf(a*(x-1)))
    ph=np.cumsum(2*np.pi*(h/2*rs)*f/fs)
    env=((u>=-1)&(u<=len(b)+1)).astype(float)
    return env*np.exp(1j*ph)
# ---- 802.15.4 ----
S0=[1,1,0,1,1,0,0,1,1,1,0,0,0,0,1,1,0,1,0,1,0,0,1,0,0,0,1,0,1,1,1,0]
def chips_for(sym):
    c=S0[-4*(sym&7):]+S0[:-4*(sym&7)] if sym&7 else list(S0)
    if sym&8: c=[x^1 if i%2 else x for i,x in enumerate(c)]
    return c
def crc16(data):
    r=0
    for byte in data:
        for i in range(8):
            bit=(byte>>i)&1
            fb=(r&1)^bit; r>>=1
            if fb: r^=0x8408
    return r
def wpan_frame(payload):
    f=crc16(payload); return bytes(payload)+bytes([f&255,f>>8])
def oqpsk(psdu, fs, start):
    phy=bytes([0,0,0,0,0xa7,len(psdu)])+psdu
    c=[]
    for byte in phy:
        for nib in (byte&15, byte>>4): c+=chips_for(nib)
    c=np.array(c)*2-1; spc=fs/2e6
    n=int(start+(len(c)+4)*spc)+200; u=(np.arange(n)-start)/spc; k=np.floor(u).astype(int)
    ev=k-(k%2); od=np.where(k%2==1,k,k-1)
    def comp(idx):
        ok=(idx>=0)&(idx<len(c)); return np.where(ok,c[np.clip(idx,0,len(c)-1)]*np.sin(np.pi*(u-idx)/2),0)
    return comp(ev)+1j*comp(od)
def to_radio(x, fs, cfo, amp, sigma, dc, rng, offset=True):
    n=np.arange(len(x)); x=x*np.exp(2j*np.pi*cfo*n/fs+1j*rng.uniform(0,6.28))
    if offset: x=x*np.exp(-2j*np.pi*0.25*n)   # wanted channel is Fs/4 below the LO
    y=amp*x+dc*(1+0.3j)+sigma*(rng.standard_normal(len(x))+1j*rng.standard_normal(len(x)))
    out=np.empty(2*len(x),np.int8)
    out[0::2]=np.clip(np.round(y.real),-127,127); out[1::2]=np.clip(np.round(y.imag),-127,127)
    return out
