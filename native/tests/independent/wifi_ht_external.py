"""Pinned external HT20 waveforms: original bytes, FCS, timing and PHY context.
The oracle is independent Python encoding from the MIT libcrafter corpus;
expected values are never produced by Airwolf. No network/hardware is needed.
"""
import hashlib,json,pathlib,subprocess,sys,tempfile,zipfile,zlib,random
root=pathlib.Path(__file__).resolve().parents[1]/'fixtures'/'libcrafter-ht'
manifest=json.loads((root/'sources.json').read_text())
archive=root/'iq.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==manifest['archiveSha256']
count=production=0
with zipfile.ZipFile(archive) as z, tempfile.TemporaryDirectory(prefix='airwolf-ht-external-') as directory:
 path=pathlib.Path(directory)/'synthetic.cs8'
 for case in manifest['cases']:
  name=case['name'];raw=z.read(name+'.cs8')
  assert hashlib.sha256(raw).hexdigest()==case['sha256'],name
  path.write_bytes(raw)
  run=subprocess.run([sys.argv[1],str(path)],capture_output=True,text=True,check=True,timeout=30)
  rows=[line.split() for line in run.stdout.splitlines()]
  if 'result' in case:
   if case['result']=='invalid_fcs':assert len(rows)==1 and rows[0][3]=='0',name
   else:assert not rows,(name,run.stdout)
  else:
   expected=case['mpdu_hex'].split(',') if 'mpdu_hex' in case else [case['psdu_hex']]
   # Source oracle heuristically scans inside a CRC-valid delimiter's declared
   # MPDU after FCS failure. Airwolf rejects that ambiguous interpretation: an
   # embedded CRC-valid payload must not become a fabricated aggregate member.
   if case.get('airwolfPolicy')=='reject-ambiguous-delimiter-span':expected=[]
   assert [r[4] for r in rows if r[3]=='1']==expected,(name,run.stderr)
   # Only a deliberately impaired member may be reported with a bad FCS, and
   # then exactly one; clean waveforms must produce no invalid rows at all.
   impaired=1 if any(k in name for k in ('bad_fcs','damaged_codeword','false_long_delimiter')) else 0
   assert sum(r[3]!='1' for r in rows)==impaired,(name,'invalid rows',run.stdout)
   for row in rows:
    # Bad-FCS aggregate members are reported in place, flagged invalid.
    data=bytes.fromhex(row[4]);assert (zlib.crc32(data[:-4])==int.from_bytes(data[-4:],'little'))==(row[3]=='1'),name
    if case.get('frame_end'):assert abs(int(row[1])-int(case['frame_end']))<=2,(name,'timing',row[:2])
   # Production parser+metadata for each PHY combination and all aggregates.
   if 'len100-clean' in name or 'ampdu' in name:
    command=[sys.argv[2],'decode',str(path),'0',str(len(raw)//2),'wifi','20000000','5300000000','5300000000','1m',str(0x8e89bed6),str(0x555555)]
    packets=json.loads(subprocess.run(command,capture_output=True,text=True,check=True,timeout=30).stdout)['packets']
    for p in packets:
     data=bytes(p['bytes']);assert (zlib.crc32(data[:-4])==int.from_bytes(data[-4:],'little'))==(p['integrity']=='valid'),(name,'production integrity')
    assert sum(p['integrity']!='valid' for p in packets)==impaired,(name,'production invalid packets')
    packets=[p for p in packets if p['integrity']=='valid']
    assert [bytes(p['bytes']).hex() for p in packets]==expected,(name,'production bytes')
    for index,p in enumerate(packets):
     h=p['wifiHt'];assert p['wifiPhy']=='ht' and p['integrity']=='valid'
     assert h['mcs']==int(case['mcs']) and h['guardNs']==int(case['guard_samples'])*50
     assert h['coding']==('ldpc' if '-ldpc' in name else 'bcc')
     assert h['format']==('greenfield' if 'greenfield' in name or '-gf-' in name else 'mixed')
     assert h['stbc']==int(case.get('stbc','1' if 'ht-stbc' in name else '0'))
     assert h['extensionStreams']==int(case.get('extension','0'))
     assert h['psduLength']==len(bytes.fromhex(case['psdu_hex']))
     if 'frame_offsets' in case:assert h['aggregateOffset']==int(case['frame_offsets'].split(',')[index])-4
     assert h['symbols']>0 and (p['endSample']-p['firstSample'])==(480 if h['format']=='greenfield' else 720)+80*(h['stbc']+(4 if h['extensionStreams']==3 else h['extensionStreams']))+h['symbols']*(64+h['guardNs']//50)
    production+=1
  count+=1
 if len(sys.argv)>3:
  clean=next(c['name'] for c in manifest['cases'] if c['name'].startswith('ht-ldpc-7-') and c['name'].endswith('len100-clean'))
  good=pathlib.Path(directory)/'clean.cs8';bad=pathlib.Path(directory)/'malformed.cs8'
  good.write_bytes(z.read(clean+'.cs8'));bad.write_bytes(z.read('ht-ldpc-7-nonconvergence.cs8'))
  bcc=bytearray(z.read('ht-bcc-7-gi800-len4095-clean.cs8'))
  rng=random.Random(8301)
  for i in range(4000,len(bcc)-800):bcc[i]=rng.randrange(256)
  damaged=pathlib.Path(directory)/'corrupt-bcc.cs8';damaged.write_bytes(bcc)
  subprocess.run([sys.argv[3],str(good),str(bad),str(damaged)],check=True,timeout=30)
print(f'{count} pinned external HT20 waveforms; {production} production IQ metadata cases passed')
