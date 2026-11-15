"""Pinned external HT20 waveforms: original bytes, FCS, timing and PHY context.
The oracle is independent Python encoding from the MIT libcrafter corpus;
expected values are never produced by Airwolf. No network/hardware is needed.
"""
import hashlib,json,pathlib,subprocess,sys,tempfile,zipfile,zlib
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
   assert [r[4] for r in rows if r[3]=='1']==expected,(name,run.stderr)
   for row in rows:
    data=bytes.fromhex(row[4]);assert zlib.crc32(data[:-4])==int.from_bytes(data[-4:],'little'),name
    if case.get('frame_end'):assert abs(int(row[1])-int(case['frame_end']))<=2,(name,'timing',row[:2])
   # Production parser+metadata for each PHY combination and all aggregates.
   if 'len100-clean' in name or 'ampdu' in name:
    command=[sys.argv[2],'decode',str(path),'0',str(len(raw)//2),'wifi','20000000','5300000000','5300000000','1m',str(0x8e89bed6),str(0x555555)]
    packets=json.loads(subprocess.run(command,capture_output=True,text=True,check=True,timeout=30).stdout)['packets']
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
print(f'{count} pinned external HT20 waveforms; {production} production IQ metadata cases passed')
