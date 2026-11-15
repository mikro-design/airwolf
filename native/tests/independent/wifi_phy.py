"""Production IQ command preserves DSSS/CCK metadata and rejects it on 5 GHz."""
import hashlib,json,pathlib,subprocess,sys,zlib
root=pathlib.Path(__file__).resolve().parents[1]/'fixtures'/'libcrafter-dsss'
cases=json.loads((root/'sources.json').read_text())['cases']
for case in cases:
 file=root/(case['name']+'.cs8');raw=file.read_bytes()
 assert hashlib.sha256(raw).hexdigest()==case['sha256']
 command=[sys.argv[1],'decode',str(file),'0',str(len(raw)//2),'wifi','20000000','2412000000','2412000000','1m',str(0x8e89bed6),str(0x555555)]
 run=subprocess.run(command,capture_output=True,text=True,check=True,timeout=20)
 result=json.loads(run.stdout);packets=result['packets']
 assert result['omittedPackets']==0 and result['processedSamples']==len(raw)//2
 if case['expected']=='frame':
  assert len(packets)==1,(case['name'],run.stderr)
  p=packets[0];rate=int(case['rate_bps'])/1e6
  assert bytes(p['bytes']).hex()==case['psdu_hex'] and p['integrity']=='valid'
  assert p['wifiPhy']==('dsss' if rate<=2 else 'cck') and p['wifiRateMbps']==rate
  assert p['wifiPreamble']==case['preamble'] and p['channel']==1
 else:assert all(p['integrity']=='invalid' for p in packets),case['name']
 for p in packets:
  data=bytes(p['bytes']);assert (p['integrity']=='valid')==(zlib.crc32(data[:-4])==int.from_bytes(data[-4:],'little'))
 # No legacy DSSS decoder runs on a 5 GHz capture, even for perfect synthetic IQ.
 command[7]=command[8]='5300000000'
 absent=subprocess.run(command,capture_output=True,text=True,check=True,timeout=20)
 assert not json.loads(absent.stdout)['packets'],case['name']
print(f'{len(cases)} production IQ cases preserve raw bytes, PHY, preamble and independent FCS; 5 GHz has no false DSSS rows')
