"""Independent DSSS/CCK transmitter, IEEE Std 802.11b-1999 clauses 18.2/18.4.
Uses no receiver or libcrafter generator code; polynomial CRC, serial feedback,
Barker spreading and CCK's phase equation are implemented here with NumPy/SciPy.
"""
import math,pathlib,subprocess,tempfile,zlib,json,sys,time
import numpy as np
from scipy.signal import resample_poly
BARKER=np.array([1,-1,1,1,-1,1,1,1,-1,-1,-1])

def bits(data):
 return np.unpackbits(np.frombuffer(bytes(data),dtype=np.uint8),bitorder='little').tolist()

def crc16(data):
 # MSB polynomial arithmetic followed by wire bit reflection; independent of
 # the receiver's reflected shift-register implementation.
 register=65535
 for bit in bits(data):
  feedback=(register>>15)^bit
  register=(register<<1)&65535
  if feedback: register^=0x1021
 return int(f'{register^65535:016b}'[::-1],2)

def frame(length=120):
 data=bytes.fromhex('80000000ffffffffffff0200000000010200000000011000')
 data=(data+bytes((i*29+7)%256 for i in range(length)))[:length-4]
 return data+zlib.crc32(data).to_bytes(4,'little')

def waveform(data,rate,short=False,seed=91,header=None):
 units=int(rate*10); duration=math.ceil(len(data)*80/units)
 service=128 if rate==11 and 11*duration-8*len(data)>=8 else 0
 head=bytes([units,service])+duration.to_bytes(2,'little')
 head+=crc16(head).to_bytes(2,'little')
 if header is not None:head=header
 preamble=56 if short else 128
 raw=[int(not short)]*preamble+bits((0x05cf if short else 0xf3a0).to_bytes(2,'little'))+bits(head)+bits(data)
 emitted=[(seed>>i)&1 for i in range(6,-1,-1)]
 for bit in raw:emitted.append(bit^emitted[-4]^emitted[-7])
 serial=np.array(emitted[7:],dtype=int)
 phase=0.;chips=[]
 def barker(part,width):
  nonlocal phase
  for word in part.reshape(-1,width):
   phase+=(math.pi*word[0] if width==1 else {(0,0):0,(0,1):math.pi/2,(1,1):math.pi,(1,0):-math.pi/2}[tuple(word)])
   chips.extend(BARKER*np.exp(1j*phase))
 n=preamble+16;barker(serial[:n],1);barker(serial[n:n+48],2 if short else 1)
 payload=serial[n+48:]
 if rate in (1,2):barker(payload,int(rate))
 else:
  width=4 if rate==5.5 else 8
  for index,word in enumerate(payload.reshape(-1,width)):
   phase+={(0,0):0,(0,1):math.pi/2,(1,1):math.pi,(1,0):-math.pi/2}[tuple(word[:2])]+(index%2)*math.pi
   if rate==5.5:a,b,c=word[2]*math.pi+math.pi/2,0,word[3]*math.pi
   else:a,b,c=[word[k]*math.pi+word[k+1]*math.pi/2 for k in (2,4,6)]
   angles=np.array([a+b+c,b+c,a+c,c,a+b,b,a,0])+phase
   chips.extend(np.exp(1j*angles)*np.array([1,1,1,-1,1,1,-1,1]))
 return resample_poly(np.repeat(chips,8),5,22)

def iq(data,rate,short=False,cfo=0,ppm=0,fraction=0,noise=0,seed=91,header=None,echo=False):
 signal=waveform(data,rate,short,seed,header)
 if echo:signal=np.convolve(signal,[1,0,.2+.12j])
 signal=np.r_[np.zeros(512),signal,np.zeros(1000)]
 if fraction or ppm:
  high=resample_poly(signal,8,1);grid=np.arange(len(high))/8
  t=np.arange(len(signal))*(1+ppm*1e-6)-fraction
  signal=np.interp(t,grid,high.real)+1j*np.interp(t,grid,high.imag)
 signal*=np.exp(1j*(.73+2*np.pi*cfo*np.arange(len(signal))/20e6))
 signal*=75/np.max(abs(signal));rng=np.random.default_rng(seed)
 signal+=noise*(rng.standard_normal(len(signal))+1j*rng.standard_normal(len(signal)))
 raw=np.empty(2*len(signal),np.int8);raw[::2]=np.clip(np.round(signal.real),-127,127);raw[1::2]=np.clip(np.round(signal.imag),-127,127)
 return raw

def run(binary):
 results=[]
 with tempfile.TemporaryDirectory() as directory:
  file=pathlib.Path(directory)/'fixture.iq'
  for rate in (1,2,5.5,11):
   for short in (False,True):
    if short and rate==1:continue
    for n,cfo,ppm,fraction,noise in [(120,0,0,0,0),(120,100000,40,.31,1),(120,-100000,-40,.77,1),(4095,0,0,.47,0),(4095,100000,40,.23,1),(4095,-100000,-40,.61,1)]:
     expected=frame(n);x=iq(expected,rate,short,cfo,ppm,fraction,noise);x.tofile(file)
     t=time.perf_counter();p=subprocess.run([binary,str(file)],text=True,capture_output=True,check=True);elapsed=time.perf_counter()-t
     rows=[r.split() for r in p.stdout.splitlines()]
     correct=len(rows)==1 and float(rows[0][2])==rate and rows[0][3]=='1' and rows[0][4]==str(int(short)) and rows[0][5]==expected.hex()
     result=dict(rate=rate,short=short,length=n,cfo=cfo,ppm=ppm,correct=correct,rows=len(rows),msps=len(x)/2/elapsed/1e6,stderr=p.stderr.strip())
     results.append(result);print(json.dumps(result),flush=True)

  # Correct header CRC must not make unsupported or impossible layouts valid.
  expected=frame(120)
  for signal,service,duration in [(0,0,960),(10,8,960),(10,1,960),(10,0,8),(10,0,0),(10,0,32768),(110,128,9)]:
   head=bytes([signal,service])+duration.to_bytes(2,'little');head+=crc16(head).to_bytes(2,'little')
   iq(expected,1,header=head).tofile(file)
   p=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
   assert not p.stdout,('invalid PLCP',signal,service,duration,p.stderr)
  # Failed FCS remains a failed candidate even when every symbol is strong.
  for rate in (1,2,5.5,11):
   damaged=bytearray(frame());damaged[-1]^=1;iq(damaged,rate).tofile(file)
   p=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
   rows=[line.split() for line in p.stdout.splitlines()]
   assert len(rows)==1 and rows[0][3]=='0' and rows[0][-1]==damaged.hex(),('bad FCS',rate,p.stderr)
  # Half a second of independent wideband noise; no PLCP/packet invention.
  rng=np.random.default_rng(822)
  np.clip(np.round(rng.normal(0,25,20000000)),-127,127).astype(np.int8).tofile(file)
  p=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
  assert not p.stdout and 'candidates=0 ' in p.stderr,('noise',p.stderr)
  # Repeated difficult CCK payloads exhaust a finite recovery allowance.
  # Test work counters, not wall time: CI hosts have different CPU capacities.
  damaged=bytearray(frame(4095));damaged[-1]^=1
  x=iq(damaged,11,True,noise=14,seed=19);np.tile(x,24).tofile(file)
  p=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
  stats=dict(item.split('=') for item in p.stderr.split())
  assert int(stats['recovery_attempts'])>0 and int(stats['recovery_budget_skips'])>0,p.stderr
  assert all(row.split()[3]=='0' for row in p.stdout.splitlines()),'Damaged CCK became CRC-valid'
  assert all(x['correct'] for x in results), [x for x in results if not x['correct']]
  print('PASS',sum(x['correct'] for x in results),'/',len(results))
if __name__=='__main__':run(sys.argv[1])
