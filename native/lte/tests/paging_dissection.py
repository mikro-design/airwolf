# SPDX-License-Identifier: AGPL-3.0-or-later
"""Native RRC corroboration of independently assembled PCCH payloads."""
import json
import struct
import sys
import checked_subprocess as subprocess
from paging_vectors import VECTORS

def request(payload,name='lte-rrc.pcch'):
    name=name.encode();size=(len(name)+3)//4*4
    prefix=struct.pack('>HH',12,size)+name.ljust(size,b'\0')+bytes(4)
    frame=prefix+payload
    pcap=struct.pack('<IHHIIII',0xa1b2c3d4,2,4,0,0,8192,252)+struct.pack('<IIII',1,0,len(frame),len(frame))+frame
    return struct.pack('<II',len(pcap),0)+pcap

def flatten(fields):
    return [f for item in fields for f in [item,*flatten(item.get('children',[]))]]

cases=[(name,payload) for name,payload in VECTORS.items()]
messages=b''.join(request(payload) for _,payload in cases)
messages+=b''.join(request(VECTORS['stmsi'][:n]) for n in (1,3,6))
messages+=request(VECTORS['stmsi'],'lte-rrc.dl.dcch')
run=subprocess.run([sys.argv[1]],input=messages,capture_output=True)
assert run.returncode==0,run.stderr.decode(errors='replace')
results=[json.loads(line) for line in run.stdout.splitlines()]
assert len(results)==len(cases)+4
for (name,payload),row in zip(cases,results):
    result=row['result'];fields=flatten(result['fields']);by_filter={f.get('filter'):f for f in fields}
    expected_warnings=['SIBs changing in next BCCH modification period - signalled in Paging message'] if name in ('modification','multiple') else []
    if name in ('etws','multiple'):expected_warnings.append('Earthquake and Tsunami Warning System Indication!')
    assert result['warnings']==expected_warnings,(name,result)
    assert 'lte_rrc' in result['protocols'] and 'lte-rrc.paging_element' in by_filter,(name,result)
    assert 'integrity' not in result  # ASN.1 parsing cannot verify physical CRC.
    assert all(f['offset']+f['length']<=len(payload) for f in fields),(name,fields)
    if name=='stmsi':
        assert 'decimal value 18' in by_filter['lte-rrc.mmec']['value']
        assert '3456789a' in by_filter['lte-rrc.m_TMSI']['value']
        assert by_filter['lte-rrc.cn_Domain']['value']=='ps (0)'
        assert not by_filter['lte-rrc.m_TMSI']['mapped']
    if name=='imsi':
        assert by_filter['lte-rrc.ue_Identity']['value']=='imsi (1)'
        assert by_filter['lte-rrc.cn_Domain']['value']=='cs (1)'
    if name in ('modification','multiple'):assert 'lte-rrc.systemInfoModification' in by_filter
    if name in ('etws','multiple'):assert 'lte-rrc.etws_Indication' in by_filter
    if name=='multiple':assert by_filter['lte-rrc.pagingRecordList']['value']=='2 items'
for row in results[len(cases):-1]:
    assert any('Malformed' in warning for warning in row['result']['warnings']),row
assert results[-1].get('error')=='Unsupported LTE exported PDU',results[-1]
print('Six independent PCCH vectors: native fields, empty paging, truncation and constrained dispatch pass')
