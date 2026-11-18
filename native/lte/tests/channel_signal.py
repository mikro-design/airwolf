"""LTE channel-impairment generator: srsRAN si-fixture (shared TX PHY, as in shipped tests)
-> exact rational resample to the HackRF rate -> CFO, sample-clock error, AWGN at a given
in-band SNR (over the occupied N_PRB*180 kHz), optional CW interferer / noise bursts / 2-path channel,
int8 quantisation. Usage: python3 gen_lte.py OUT.iq RATE PRB TTIS SNR_DB [key=value ...]"""
import sys, subprocess, numpy as np, os, tempfile
from scipy.signal import resample_poly
RATES={6:1920000,15:3840000,25:5760000,50:11520000,75:15360000,100:23040000}
def gen(fixture,out,rate,prb,ttis,snr,cfo=0.0,ppm=0.0,rms=20.0,ports=1,pci=42,mode='scheduled',cw_db=None,cw_hz=1.2e6,
        burst_db=None,burst_ms=2,burst_period_ms=50,echo_db=None,echo_us=2.0,echo_phase=1.1,seed=1,lead=1377,tdd=0):
    rng=np.random.default_rng(seed)
    with tempfile.TemporaryDirectory() as d:
        cf=os.path.join(d,'s.cf32')
        subprocess.run([str(fixture),cf,str(prb),str(pci),str(ports),str(ttis),mode,str(tdd)],check=True,capture_output=True)
        raw=np.fromfile(cf,np.complex64)
    src=RATES[prb]; r=rate*(1+ppm*1e-6)
    g=np.gcd(int(rate),src); up,down=int(rate)//g,src//g
    x=resample_poly(raw,up,down).astype(np.complex64)
    if ppm:
        # independent sample-clock error: re-interpolate onto a stretched grid
        t=np.arange(int(len(x)/(1+ppm*1e-6)))*(1+ppm*1e-6)
        x=np.interp(t,np.arange(len(x)),x.real)+1j*np.interp(t,np.arange(len(x)),x.imag)
    if echo_db is not None:
        k=int(round(echo_us*1e-6*rate)); e=np.zeros_like(x); e[k:]=x[:-k]*10**(echo_db/20)*np.exp(1j*echo_phase); x=x+e
    p=np.mean(abs(x)**2); x=x*(rms/np.sqrt(p))
    x=np.r_[np.zeros(lead,np.complex64),x]
    n=np.arange(len(x))
    x=x*np.exp(2j*np.pi*cfo*n/rate)
    # in-band SNR: noise PSD so that signal/noise over occupied BW = snr
    bw=prb*180e3; sig_psd=rms**2/bw; noise_total=sig_psd/10**(snr/10)*rate
    s=np.sqrt(noise_total/2)
    y=x+rng.normal(0,s,len(x))+1j*rng.normal(0,s,len(x))
    if cw_db is not None: y=y+rms*10**(cw_db/20)*np.exp(2j*np.pi*cw_hz*n/rate)
    if burst_db is not None:
        per=int(burst_period_ms*rate/1000); L=int(burst_ms*rate/1000); amp=rms*10**(burst_db/20)/np.sqrt(2)
        for a in range(per//2,len(y),per): y[a:a+L]+=rng.normal(0,amp,min(L,len(y)-a))+1j*rng.normal(0,amp,min(L,len(y)-a))
    d=np.empty(len(y)*2,np.int8); d[::2]=np.clip(np.rint(y.real),-127,127); d[1::2]=np.clip(np.rint(y.imag),-127,127)
    d.tofile(out); return len(y)
