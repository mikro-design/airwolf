"""Independent NumPy HT20 transmitter, IEEE 802.11-2020 clause 19.
No receiver code/tables are imported. Shared legacy primitives are from the
independent transmitter in wifi.py; IQ remains synthetic and RX-only.
"""
import pathlib
import subprocess
import sys
import tempfile
import zlib
import numpy as np
from scipy.signal import resample_poly
from wifi import lsb, scramble, encode, interleave, symbols, LTF, DATA, waveform as legacy, packet

MCS = [(1,26,[1,1]), (2,52,[1,1]), (2,78,[1,1,1,0,0,1]),
       (4,104,[1,1]), (4,156,[1,1,1,0,0,1]), (6,208,[1,1,1,0]),
       (6,234,[1,1,1,0,0,1]), (6,260,[1,1,1,0,0,1,1,0,0,1])]

def crc8(bits):
    register = [1]*8
    for bit in bits:
        feedback = register[0] ^ bit
        register = register[1:] + [0]
        for tap in (5,6,7): register[tap] ^= feedback
    return [bit ^ 1 for bit in register]

def ampdu(packets):
    result = bytearray()
    for p in packets:
        header = (len(p) << 4).to_bytes(2, 'little')
        checksum = sum(bit << n for n,bit in enumerate(crc8([b for byte in header for b in lsb(byte,8)])))
        result += header + bytes([checksum,0x4e]) + p
        result += bytes((-len(result)) % 4)
    return bytes(result)

def waveform(payload, mcs, short=False, greenfield=False, aggregate=False, extension=0, sig_flip=None):
    bpsc, dbps, puncture = MCS[mcs]
    guard=8 if short else 16
    count=(16+8*len(payload)+6+dbps-1)//dbps
    data=scramble([0]*16+[bit for byte in payload for bit in lsb(byte,8)]+[0]*(count*dbps-16-8*len(payload)),93)
    data[16+8*len(payload):22+8*len(payload)]=[0]*6
    coded=[bit for n,bit in enumerate(encode(data)) if puncture[n%len(puncture)]]
    ht_sig=lsb(mcs,7)+[0]+lsb(len(payload),16)+[1,1,1,int(aggregate),0,0,0,int(short)]+lsb(extension,2)
    ht_sig+=crc8(ht_sig)+[0]*6
    if sig_flip is not None: ht_sig[sig_flip]^=1
    signal_coded=encode(ht_sig)
    def sig_symbol(bits):
        bins=np.zeros(64,complex);bins[np.array(DATA)%64]=1j*(2*np.array(interleave(bits,1))-1)
        bins[np.array([-21,-7,7,21])%64]=[1,1,1,-1]
        x=np.fft.ifft(bins);return np.r_[x[-16:],x]
    training=np.zeros(64,complex);training[np.arange(-28,29)%64]=np.r_[1,1,LTF,-1,-1];training=np.fft.ifft(training)
    old=legacy(packet(),6)
    if greenfield:
        parts=[old[:160],training[-32:],training,training]
    else:
        # L-SIG duration covers the full HT PPDU, independent of payload length.
        duration=320+count*(64+guard)+extension*80
        legacy_length=3*((duration+79)//80+3)-3
        lsig=[1,1,0,1,0]+lsb(legacy_length,12);lsig += [sum(lsig)%2]+[0]*6
        bins=np.zeros(64,complex);bins[np.array(DATA)%64]=symbols(interleave(encode(lsig),1),1)
        bins[np.array([-21,-7,7,21])%64]=[1,1,1,-1];x=np.fft.ifft(bins)
        parts=[old[:320],np.r_[x[-16:],x]]
    parts += [sig_symbol(signal_coded[:48]),sig_symbol(signal_coded[48:])]
    if not greenfield: parts += [old[:80],np.r_[training[-16:],training]]
    for _ in range(4 if extension==3 else extension): parts += [np.r_[training[-16:],training]]
    polarity=[1-2*b for b in scramble([0]*127,127)]
    carriers=[k for k in range(-28,29) if k not in (0,-21,-7,7,21)]
    for n in range(count):
        block=coded[n*52*bpsc:(n+1)*52*bpsc];mapped=[0]*len(block);s=max(bpsc//2,1)
        for k,bit in enumerate(block):
            i=(len(block)//13)*(k%13)+k//13;j=s*(i//s)+(i+len(block)-(13*i)//len(block))%s;mapped[j]=bit
        bins=np.zeros(64,complex);bins[np.array(carriers)%64]=symbols(mapped,bpsc)
        bins[np.array([-21,-7,7,21])%64]=np.roll([1,1,1,-1],-n)*polarity[(n+(2 if greenfield else 3))%127]
        x=np.fft.ifft(bins);parts.append(np.r_[x[-guard:],x])
    return np.concatenate(parts)

def iq(signal,cfo=0,noise=0,fraction=0,ppm=0,seed=1):
    rng=np.random.default_rng(seed);signal=np.convolve(signal,[1,0,0,.15+.1j]);signal=np.r_[np.zeros(256),signal,np.zeros(700)]
    positions=np.arange(len(signal))*(1+ppm*1e-6)-fraction
    up=resample_poly(signal,8,1);grid=np.arange(len(up))/8
    signal=np.interp(positions,grid,up.real)+1j*np.interp(positions,grid,up.imag)
    signal*=np.exp(1j*(2*np.pi*cfo/20e6*np.arange(len(signal))+rng.uniform(-np.pi,np.pi)))
    signal*=80/max(abs(signal));signal+=noise*(rng.standard_normal(len(signal))+1j*rng.standard_normal(len(signal)))
    result=np.empty(2*len(signal),np.int8);result[::2]=np.clip(np.round(signal.real),-127,127);result[1::2]=np.clip(np.round(signal.imag),-127,127)
    return result

def run(binary):
    count=0
    with tempfile.TemporaryDirectory(prefix='airwolf-ht-') as directory:
        path=pathlib.Path(directory)/'synthetic.iq'
        for mcs in range(8):
            for short,greenfield in [(False,False),(True,False),(False,True)]:
                for cfo,noise,fraction,ppm in [(0,0,0,0),(150000,1,.23,20),(-150000,1,.71,-20)]:
                    expected=packet(240)
                    iq(waveform(expected,mcs,short,greenfield),cfo,noise,fraction,ppm,seed=mcs).tofile(path)
                    result=subprocess.run([binary,str(path)],capture_output=True,text=True,check=True)
                    rows=[line.split() for line in result.stdout.splitlines()]
                    assert len(rows)==1 and rows[0][3:]==['1',expected.hex()], (mcs,short,greenfield,cfo,result.stdout,result.stderr)
                    count+=1
        print(f'{count} HT20 IQ cases passed')
if __name__=='__main__':run(sys.argv[1])
