"""Hash-pinned external transmitter corpus; no local waveform generation."""
import hashlib,json,pathlib,subprocess,sys,zlib
root=pathlib.Path(__file__).resolve().parents[1]/'fixtures'/'libcrafter-dsss'
cases=json.loads((root/'sources.json').read_text())['cases']
for case in cases:
 file=root/(case['name']+'.cs8');raw=file.read_bytes()
 assert hashlib.sha256(raw).hexdigest()==case['sha256'],case['name']
 assert len(raw)==2*int(case['sample_count']),case['name']
 run=subprocess.run([sys.argv[1],str(file)],capture_output=True,text=True,check=True,timeout=20)
 rows=[line.split() for line in run.stdout.splitlines()]
 if case['expected']=='frame':
  assert len(rows)==1,(case['name'],run.stderr)
  first,end,rate,valid,short,payload=rows[0]
  assert float(rate)*1e6==int(case['rate_bps']) and short==str(int(case['preamble']=='short')),case['name']
  assert valid=='1' and payload==case['psdu_hex'],(case['name'],run.stderr)
  assert 0<=int(first)<int(end)<=len(raw)//2,case['name']
 else:
  assert all(row[3]=='0' for row in rows),(case['name'],run.stderr)
 for row in rows:
  data=bytes.fromhex(row[-1]);valid=zlib.crc32(data[:-4])==int.from_bytes(data[-4:],'little')
  assert valid==bool(int(row[3])),case['name']
print(f'{len(cases)} hash-pinned external DSSS/CCK cases passed with independent FCS checks')
