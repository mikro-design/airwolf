"""IQ for Electron integration tests. No transmitter/hardware access."""
import json,sys,subprocess,os,zipfile,hashlib
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
if os.environ.get('AIRWOLF_TEST_WIFI_PHY') == 'cck':
    from wifi_dsss import iq as cck_iq
    signal=cck_iq(b,5.5,fraction=.37,cfo=100000,noise=1)
    start=512+(128-32)*20
    signal[2*start:2*(start+20)]=0
    signal.tofile(out/'wifi.iq')
if os.environ.get('AIRWOLF_TEST_WIFI_PHY') in ('ht','ht-aggregate'):
    source=Path(__file__).parent/'fixtures'/'libcrafter-ht'
    manifest=json.loads((source/'sources.json').read_text())
    name='ht-ampdu-7-gi400-ldpc-duplicate' if os.environ['AIRWOLF_TEST_WIFI_PHY']=='ht-aggregate' else 'ht-ldpc-7-gi400-len100-clean'
    case=next(c for c in manifest['cases'] if c['name']==name)
    with zipfile.ZipFile(source/'iq.zip') as archive:raw=archive.read(name+'.cs8')
    assert hashlib.sha256(raw).hexdigest()==case['sha256']
    (out/'wifi.iq').write_bytes(raw)
    b=bytes.fromhex(case['mpdu_hex'].split(',')[1] if 'mpdu_hex' in case else case['psdu_hex'])

pdu=bytes([7,8,7,1,1,2,3,4,5,6]);bits,expected= coded_bits(pdu,37,0x8e89bed6,0x555555,8)
rng=np.random.default_rng(47);gen.to_radio(gen.gfsk(bits,8000000,1000000,300.37),8000000,150000,30,1,10,rng).tofile(out/'ble.iq')
subprocess.run([sys.argv[2],str(out/'lte.cf32'),'42','50'],check=True)
x=np.fromfile(out/'lte.cf32',np.complex64);x=resample_poly(x,25,6);x*=30/np.sqrt(np.mean(abs(x)**2));x+=3+2j
raw=np.empty(len(x)*2,np.int8);raw[::2]=np.clip(np.round(x.real),-127,127);raw[1::2]=np.clip(np.round(x.imag),-127,127);raw.tofile(out/'lte.iq')
wpan=gen.wpan_frame(bytes.fromhex('020001'))
raw=gen.to_radio(gen.oqpsk(wpan,8000000,300.37),8000000,150000,30,1,10,rng)
raw.tofile(out/'15p4.iq')
# MAC short addresses/PAN compression; NWK data; APS HA On/Off cluster; ZCL On.
zigbee=gen.wpan_frame(bytes.fromhex('6188013412ffff2211 0800ffff22111e01 0001060004010101 010101'))
gen.to_radio(gen.oqpsk(zigbee,8000000,300.37),8000000,150000,30,1,10,rng).tofile(out/'zigbee.iq')
# Nordic ESB, 2 Mb/s: the same frame twice from one address, so promiscuous
# reception confirms the address and reports both (frames built in esb.py).
import esb
esb_frame=esb.frame(bytes.fromhex('e73a5c19b2'),b'airwolf',pid=1)
esb.capture([esb_frame,esb_frame],8000000,'2m',40000,6,48).tofile(out/'esb.iq')
# CEN DSRC at 20 MS/s: one downlink (ASK/FM0) frame, then one uplink frame
# backscattered on a 2.0 MHz subcarrier (frames and waveforms from dsrc.py).
import dsrc
dsrc_down=dsrc.frame(bytes([0xFF,0xFF,0xFF,0xFF,0xA0,0x03])+b'airwolf downlink')
dsrc_up=dsrc.frame(bytes([0x12,0x34,0x56,0x79,0xC0,0x77])+b'uplink')
wave=np.concatenate([dsrc.downlink(dsrc.hdlc_bits([dsrc_down]),20000000),dsrc.uplink(dsrc.hdlc_bits([dsrc_up]),20000000,2000000)])
dsrc.radio(wave,20000000,40000,1.5,49).tofile(out/'dsrc.iq')
print(json.dumps({'wifi':b.hex(),'ble':expected.hex(),'15p4':wpan.hex(),'zigbee':zigbee.hex(),'esb':esb_frame[1].hex(),'dsrc':dsrc_down.hex()}))
