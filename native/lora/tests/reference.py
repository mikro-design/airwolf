# SPDX-License-Identifier: MIT
# Independent transmitter fixture adapted from MIT-licensed LoRaPHY.m
# Copyright (C) 2020-2022 jkadbear; source revision 4fddd9a7b47682781c663608bfc4f196e4bf656d.
# This reference never imports the receiver's encoding tables or DSP helpers.
import math
import numpy as np

def checksum(payload):
    if len(payload)==0:return [0,0]
    if len(payload)==1:return [payload[0],0]
    rem=0
    for byte in list(payload[:-2])+[0,0]:
        for bit in range(7,-1,-1):
            rem=(rem<<1)|((byte>>bit)&1)
            if rem&0x10000:rem^=0x11021
    rem^=payload[-1]|(payload[-2]<<8)
    return [rem&255,rem>>8]

def symbols(payload,sf=7,cr=4,bw=125000,crc=True,padding=None,crc_bytes=None,header_rate=None,header_checksum_error=False,implicit=False):
    ldro=(2**sf/bw)>0.016
    count=8+max((cr+4)*math.ceil((2*len(payload)-sf+7+4*crc-5*implicit)/(sf-2*ldro)),0)
    nibbles_total=sf-2+(count-8)//(cr+4)*(sf-2*ldro)
    header=[len(payload)>>4,len(payload)&15,(cr if header_rate is None else header_rate)*2+crc]
    matrix=[[1,1,1,1,0,0,0,0,0,0,0,0],[1,0,0,0,1,1,1,0,0,0,0,1],[0,1,0,0,1,0,0,1,1,0,1,0],[0,0,1,0,0,1,0,1,0,1,1,1],[0,0,0,1,0,0,1,0,1,1,1,1]]
    bits=[(n>>b)&1 for n in header for b in range(3,-1,-1)]
    parity=[sum(a*b for a,b in zip(row,bits))%2 for row in matrix]
    header += [parity[0],sum(parity[k+1]<<(3-k) for k in range(4))]
    if header_checksum_error:header[4]^=1
    reg=255;data=[]
    for byte in payload:
        data.append(byte^reg)
        reg=((reg<<1)|(((reg>>7)^(reg>>5)^(reg>>4)^(reg>>3))&1))&255
    if crc:data+=checksum(payload) if crc_bytes is None else list(crc_bytes)
    nibbles=([] if implicit else header)+[n for byte in data for n in [byte&15,byte>>4]]
    nibbles += (padding if padding is not None else [15]*max(0,nibbles_total-len(nibbles)))
    code=[]
    for idx,n in enumerate(nibbles):
        bit=lambda i:(n>>(i-1))&1
        p1=bit(1)^bit(3)^bit(4);p2=bit(1)^bit(2)^bit(4);p3=bit(1)^bit(2)^bit(3);p4=bit(1)^bit(2)^bit(3)^bit(4);p5=bit(2)^bit(3)^bit(4)
        rate=4 if idx<sf-2 else cr
        code.append(n|([p4<<4,(p5<<5)|(p3<<4),(p2<<6)|(p5<<5)|(p3<<4),(p1<<7)|(p2<<6)|(p5<<5)|(p3<<4)][rate-1]))
    def interleave(block,width):
        return [sum(((block[(j+c)%len(block)]>>c)&1)<<j for j in range(len(block))) for c in range(width)]
    inter=interleave(code[:sf-2],8)
    width=sf-2*ldro
    for at in range(sf-2,len(code)-width+1,width):inter+=interleave(code[at:at+width],cr+4)
    output=[]
    for idx,g in enumerate(inter):
        n=g;mask=g>>1
        while mask:n^=mask;mask>>=1
        output.append((n*(4 if idx<8 or ldro else 1)+1)%(1<<sf))
    return output

def chirp(sf,bw,fs,h=0,up=True):
    N=2**sf;T=N/bw;M=round(fs*T);fold=round(M*(N-h)/N)
    k=(1 if up else -1)*bw/T;f0=(-1 if up else 1)*bw/2
    t1=np.arange(fold+1)/fs
    p1=2*np.pi*t1*(f0+k*T*h/N+.5*k*t1)
    t2=np.arange(M-fold)/fs
    p2=p1[-1]+2*np.pi*t2*(f0+.5*k*t2)
    return np.exp(1j*np.r_[p1[:-1],p2]).astype('<c8')

def iq(payload,sf=7,cr=4,bw=125000,fs=500000,crc=True,sync=0x34,cfo=0,pad=173,preamble=8,**encoding):
    up=chirp(sf,bw,fs);down=chirp(sf,bw,fs,up=False)
    syms=symbols(payload,sf,cr,bw,crc,**encoding)
    signal=np.concatenate([np.zeros(pad,dtype=np.complex64),np.tile(up,preamble),chirp(sf,bw,fs,(sync>>4)*8),chirp(sf,bw,fs,(sync&15)*8),down,down,down[:len(down)//4]]+[chirp(sf,bw,fs,s) for s in syms]+[np.zeros(len(up)*4,dtype=np.complex64)])
    if cfo:signal*=np.exp(2j*np.pi*cfo*np.arange(len(signal))/fs)
    return signal.astype('<c8')
