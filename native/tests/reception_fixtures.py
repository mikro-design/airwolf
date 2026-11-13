"""IQ for Electron integration tests. No transmitter/hardware access."""
import json,sys,subprocess
from pathlib import Path
import numpy as np
from scipy.signal import resample_poly
sys.path.insert(0,str(Path(__file__).parent/'independent'))
import wifi,gen
from coded import coded_bits
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
# Beacon, intentionally named fixture (no product tags in captured radio fields).
b=bytes.fromhex('80000000ffffffffffff0200000000010200000000011000')+bytes(8)+bytes.fromhex('640001040007')+b'fixture'+bytes.fromhex('01018c')
b+=wifi.zlib.crc32(b).to_bytes(4,'little');wifi.iq(b,54,150000,1,.37,20).tofile(out/'wifi.iq')
pdu=bytes([7,8,7,1,1,2,3,4,5,6]);bits,expected= coded_bits(pdu,37,0x8e89bed6,0x555555,8)
rng=np.random.default_rng(47);gen.to_radio(gen.gfsk(bits,8000000,1000000,300.37),8000000,150000,30,1,10,rng).tofile(out/'ble.iq')
subprocess.run([sys.argv[2],str(out/'lte.cf32'),'42','50'],check=True)
x=np.fromfile(out/'lte.cf32',np.complex64);x=resample_poly(x,25,6);x*=30/np.sqrt(np.mean(abs(x)**2));x+=3+2j
raw=np.empty(len(x)*2,np.int8);raw[::2]=np.clip(np.round(x.real),-127,127);raw[1::2]=np.clip(np.round(x.imag),-127,127);raw.tofile(out/'lte.iq')
print(json.dumps({'wifi':b.hex(),'ble':expected.hex()}))
