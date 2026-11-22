"""Native periodic controller + independent RF construction + exact original IQ.
No device, RF transmission, process retries, deadline weakening or decoded stubs.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading

binary, iq_binary = sys.argv[1:3]
decoder = sys.argv[3] if len(sys.argv) > 3 else os.environ.get('AIRWOLF_DECODER_PATH')
env = {**os.environ, 'AIRWOLF_FAKE_CLOCK': 'controlled', 'AIRWOLF_FAKE_CPU_DELAY_MS': '25'}

def args(rate=20000000, duration=1000):
    return [binary, '--decoder', 'ble', '--frequency', '2402000000', '--sample-rate', str(rate),
            '--ble-periodic-follow', '--retain-iq', '--duration-ms', str(duration)]

def run(mode, rate=20000000, duration=1000, extra=None):
    p = subprocess.run(args(rate, duration), capture_output=True, text=True, timeout=40,
                       env={**env, 'AIRWOLF_FAKE_PERIODIC': mode, **(extra or {})})
    assert p.returncode == 0 and 'RETUNE_WHILE_STREAMING' not in p.stderr, p.stderr
    events = [json.loads(x) for x in p.stdout.splitlines()]
    states = [x for x in events if x['type'] == 'periodic-follow']
    packets = [x for x in events if x['type'] == 'packet']
    assert states and states[-1]['state'] == 'stopped', states
    return states, packets, events

def inspect(packets):
    capture = bytearray(struct.pack('<IHHIIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 147))
    for p in packets:
        h = bytearray(b'AWBL' + bytes(16))
        periodic = p.get('bleRole') == 'periodic-advertising'
        event = p.get('periodicEvent')
        flags = (1 if 'crcInit' in p else 0) | (2 if event is not None else 0) | 4 | (8 if periodic else 0)
        h[4:8] = bytes((1, p['channel'], {'1m':1,'2m':2,'coded-s2':3,'coded-s8':4}[p['phy']], flags))
        struct.pack_into('<I', h, 8, p.get('crcInit', 0))
        struct.pack_into('<H', h, 12, event or 0)
        h[15] = {'aux-adv':1,'aux-chain':2,'aux-sync':3}.get(p.get('bleAuxType'),0)
        struct.pack_into('<I', h, 16, p.get('timeUncertaintyUs',0))
        raw = h + bytes(p['bytes']); t = round(p['time'] * 1000)
        capture += struct.pack('<IIII',t//1000000,t%1000000,len(raw),len(raw)) + raw
    request = struct.pack('<II',len(capture),len(packets)-1) + capture
    p = subprocess.run([decoder], input=request, capture_output=True, timeout=20)
    assert p.returncode == 0, p.stderr
    answer = json.loads(p.stdout)
    assert 'result' in answer, answer
    return answer['result']

def fields(result):
    def walk(nodes):
        for node in nodes:
            yield node
            yield from walk(node.get('children',[]))
    return list(walk(result['fields']))

for extra in (['--ble-follow'],['--simulate'],['--record-iq','unused.iq','--record-samples','10']):
    rejected=subprocess.run(args()+extra,capture_output=True,text=True,timeout=5,env=env)
    assert rejected.returncode and 'opened_serial=' not in rejected.stderr,rejected.stderr

for mode in ('chain-1m', 'chain', 'chain-coded'):
    for rate in (8000000,10000000,16000000,20000000):
        states, packets, events = run(mode,rate)
        sync = [p for p in packets if p.get('bleRole') and p.get('bleAuxType') == 'aux-sync']
        chains = [p for p in packets if p.get('bleRole') and p.get('bleAuxType') == 'aux-chain']
        assert len(sync) >= 8 and len(chains) >= 8, (mode,rate,states[-1])
        assert states[-1]['verifiedEvents'] == len(sync) and states[-1]['verifiedChains'] == len(chains), states[-1]
        assert any(p['periodicEvent'] == 0 for p in sync), sync
        assert len({p['captureEpoch'] for p in sync+chains}) == len(sync+chains)
        for p in sync+chains:
            assert p['crcInit'] == 0xc4c181 and p['iqToken'] > 0 and p['firstSample'] < p['endSample'], p
            assert 'connectionEvent' not in p and p['channel'] <= 36
        for p in chains:
            assert any(s['periodicEvent'] == p['periodicEvent'] and s['time'] < p['time'] for s in sync), p
        if decoder:
            selected = chains[-1]
            result = inspect([p for p in packets if p['time'] <= selected['time']])
            assert result['integrity'] == 'valid', result
            assert any(f.get('filter') == 'btcommon.eir_ad.entry.device_name' and f['value'] == 'Hello' for f in fields(result)), result
            assert not any('no matching' in w or 'ambiguous' in w for w in result['warnings']), result
            assert not any(f.get('filter','').startswith(('btl2cap','btatt')) for f in fields(result)), result
        print(mode,rate,'verified sync/chain, CSA2 wrap, independent native CRC and reassembly passed')

for mode in ('invalid-map','bad-source-crc','wrong-channel','wrong-aa','bad-crc','missing','cte-coded'):
    states, packets, _ = run(mode)
    assert states[-1]['verifiedEvents'] == 0 and not any('periodicEvent' in p for p in packets), (mode,states[-1],packets)
    if mode in ('invalid-map','bad-source-crc'):
        assert not any(p.get('bleRole') for p in packets), packets
    else:
        assert any(s['state'] == 'lost' for s in states), states
    print(mode,'cannot establish periodic packet identity')
states, packets, _ = run('wrong-chain-adi')
assert states[-1]['verifiedEvents'] >= 8 and states[-1]['verifiedChains'] == 0 and states[-1]['rejectedPackets'] > 0, states[-1]
# ACAD without a channel-map update (e.g. BIGInfo in every LE Audio broadcast)
# does not change the schedule: following continues through it.
states, packets, _ = run('acad',duration=1250)
assert not any(s['state']=='lost' for s in states), states
acad_events = [p['periodicEvent'] for p in packets if p.get('bleRole') == 'periodic-advertising' and p['bytes'][6] == 4]
assert len(acad_events) >= 3 and states[-1]['verifiedEvents'] >= 11, (acad_events, states[-1])
# A malformed ACAD might hide a map update: stop rather than guess.
states, packets, _ = run('acad-bad',duration=1250)
assert any(s['state']=='lost' and 'ACAD' in s['message'] for s in states), states
states, packets, _ = run('chain',extra={'AIRWOLF_FAKE_STOP_DELAY_US':'40000','AIRWOLF_FAKE_STOP_DELAY_AFTER':'2'})
assert states[-1]['skippedWindows'] + states[-1]['skippedChains'] > 0, states[-1]
print('Wrong chain ADI, ACAD continuation, malformed ACAD and measured-latency deadline rejection passed')

states, packets, _ = run('gap')
assert any(s['state']=='lost' and 'gap' in s['message'] for s in states), states
assert 2<=states[-1]['verifiedEvents']<=4, states[-1]
print('Malformed USB sample block invalidates periodic timing/context and returns to primary acquisition')

states, packets, _ = run('reacquire',duration=2400)
assert any(s['state']=='lost' for s in states), states
new=[p for p in packets if p.get('crcInit')==0x123456 and 'periodicEvent' in p]
assert len(new)>=8 and all(p['channel'] in (0,1) and p['periodicEvent']>=400 for p in new), (states,new)
assert states[-1]['verifiedEvents']>=11, states[-1]
print('Six missed events release the train; fresh observed source replaces map, CRCInit and event counter')

if decoder:
    _, packets, _ = run('chain')
    sync = next(p for p in packets if p.get('bleRole') and p.get('bleAuxType') == 'aux-sync')
    unresolved = {k:v for k,v in sync.items() if k not in ('bleAuxType','periodicEvent')}
    result = inspect([unresolved])
    assert result['integrity'] == 'valid' and 'unresolved' in result['summary'], result
    assert not any(f.get('filter','').startswith(('btl2cap','btatt','btcommon.eir_ad')) for f in fields(result)), result
    unknown_crc = {k:v for k,v in unresolved.items() if k != 'crcInit'}
    assert inspect([unknown_crc])['integrity'] == 'unchecked'
    wrong_crc = {**sync,'crcInit':0x123456}
    assert inspect([wrong_crc])['integrity'] == 'invalid'
    # A retained tail alone must never fabricate a complete reassembly.
    chain = next(p for p in packets if p.get('bleAuxType') == 'aux-chain')
    result = inspect([chain])
    assert result['integrity']=='valid' and any('no matching' in w for w in result['warnings']), result
    print('Standalone context: role-only stays opaque, absent init unchecked, wrong init invalid, orphan fragment explicit')

for mode in ('chain-1m','chain','chain-coded','chain-cte'):
    with tempfile.TemporaryDirectory(prefix='airwolf-periodic-iq-') as directory:
        path=Path(directory)/'periodic.iq'
        p=subprocess.Popen(args(duration=5000),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                           env={**env,'AIRWOLF_FAKE_PERIODIC':mode})
        guard=threading.Timer(40,p.kill);guard.start()
        try:
            selected=None
            for line in p.stdout:
                item=json.loads(line)
                if item['type']=='packet' and item.get('bleRole') and item.get('bleAuxType')=='aux-chain':selected=item;break
            assert selected and selected.get('iqToken')
            p.stdin.write(f"pause\niq-snapshot 1 {selected['iqToken']} {str(path).encode().hex()}\n");p.stdin.flush()
            reply=None;retained=False
            for line in p.stdout:
                item=json.loads(line)
                if item['type']=='iq-retained':retained=True
                if item['type']=='iq-snapshot':reply=item
                if retained and reply:break
            assert reply and not reply['error'],reply
            assert reply['firstSample']<=selected['firstSample']<selected['endSample']<=reply['endSample'],(reply,selected)
            count=reply['endSample']-reply['firstSample']
            assert path.stat().st_size==count*2
            p.stdin.write('stop\n');p.stdin.flush();p.communicate(timeout=10);assert p.returncode==0
            frequency=selected['frequencyHz'];phy='coded' if selected['phy'].startswith('coded') else selected['phy']
            command=[iq_binary,'decode',str(path),'0',str(count),'ble','20000000',str(frequency),str(frequency+5000000),phy,
                     str(0xaa08192b),str(selected['crcInit']),'periodic-advertising']
            replay=subprocess.run(command,capture_output=True,text=True,timeout=20)
            assert replay.returncode==0,replay.stderr
            decoded=json.loads(replay.stdout)['packets']
            matches=[x for x in decoded if x.get('type')=='packet' and x['bytes']==selected['bytes']]
            assert len(matches)==1 and matches[0]['integrity']=='valid' and matches[0]['phy']==selected['phy'],decoded
            frame=matches[0]
            assert frame['bleRole']=='periodic-advertising' and 'periodicEvent' not in frame and 'bleAuxType' not in frame,frame
            assert abs(frame['firstSample']+reply['firstSample']-selected['firstSample'])<=40,(frame,selected)
            assert abs(frame['endSample']+reply['firstSample']-selected['endSample'])<=40,(frame,selected)
            if mode=='chain-cte':
                assert selected['bleCteUs']==160 and selected['bleCteComplete'] and frame['bleCteUs']==160 and frame['bleCteComplete']
                clipped=command.copy();clipped[4]=str(selected['endSample']-reply['firstSample']-80)
                cut=subprocess.run(clipped,capture_output=True,text=True,timeout=20)
                assert cut.returncode==0,cut.stderr
                found=[f for f in json.loads(cut.stdout)['packets'] if f['bytes']==selected['bytes']]
                assert len(found)==1 and found[0]['integrity']=='valid' and found[0]['bleCteUs']==160 and not found[0]['bleCteComplete'],found
                assert found[0]['endSample']==int(clipped[4]),found
            wrong=subprocess.run(command[:-1]+['connection'],capture_output=True,text=True,timeout=10)
            assert wrong.returncode!=0
        finally:
            guard.cancel()
            if p.poll() is None:p.kill();p.wait()
    print(mode,'retained exact IQ survives pause/retune/release, independent replay bytes/CRC/PHY/bounds passed')
