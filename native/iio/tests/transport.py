"""Production Pluto worker against a test-only 12-bit source, then exact IQ replay.
No libiio/device is emulated as a hardware reception result. Waveforms are generated
independently of the receiver or come from the existing external Wi-Fi fixtures.
"""
import json, os, pathlib, queue, subprocess, sys, tempfile, threading, time
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'native/tests/independent'))
import gen
from coded import coded_bits

def radio_codes(wave):
    n=np.arange(len(wave)); shifted=wave*np.exp(-.5j*np.pi*n)
    # Full 12-bit precision, including samples not representable as signed8.
    values=np.empty(len(wave)*2,dtype='<i2')
    values[::2]=np.rint(480*shifted.real+35).astype(np.int16)
    values[1::2]=np.rint(480*shifted.imag-23).astype(np.int16)
    return values

def verify(worker,iq_tool):
    passed=0
    with tempfile.TemporaryDirectory(prefix='airwolf-iio-') as tmp:
        tmp=pathlib.Path(tmp)
        def exercise(protocol,rate,frequency,raw,wanted,phy='1m',record=False):
            nonlocal passed
            raw=np.pad(raw,(0,max(0,rate//5*2-len(raw))))
            source=tmp/'input.ci16';raw.tofile(source);dest=tmp/f'clip-{passed}.ci16'
            env={**os.environ,'AIRWOLF_IIO_TEST_IQ':str(source)}
            args=[worker,'--live','--uri','usb:1.2.3','--frequency',str(frequency),'--sample-rate',str(rate),'--bandwidth',str(min(rate,20000000)),
                  '--decoder',protocol,'--ble-phy',phy,'--stop-on-stdin-eof','--retain-iq']
            if record:args+=['--record-iq',str(dest),'--record-samples','300001']
            p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
            events=queue.Queue();errors=[]
            def output():
                for line in p.stdout:
                    try:events.put(json.loads(line))
                    except Exception as e:events.put(e)
                events.put(None)
            threading.Thread(target=output,daemon=True).start()
            threading.Thread(target=lambda:errors.extend(p.stderr),daemon=True).start()
            def receive(kind):
                deadline=time.monotonic()+15
                while True:
                    remaining=deadline-time.monotonic()
                    assert remaining>0,("No event",kind,protocol,rate,phy,errors)
                    e=events.get(timeout=remaining)
                    assert isinstance(e,dict),(e,errors,p.poll())
                    if e['type']==kind:return e
            try:
                if record:
                    result=receive('iq-recording');assert result['samples']==300001 and result['adcBits']==12 and not result['error'],result
                    assert dest.read_bytes()==raw[:600002].tobytes();assert p.wait(timeout=5)==0
                else:
                    spectrum=receive('spectrum');assert spectrum['adcBits']==12 and spectrum['transportContinuity']=='unverified'
                    packet=receive('packet');assert bytes(packet['bytes'])==wanted,(protocol,rate,phy,packet)
                    p.stdin.write('pause\n');p.stdin.flush();receive('iq-retained')
                    p.stdin.write(f'iq-snapshot 1 {packet["iqToken"]} {str(dest).encode().hex()}\n');p.stdin.flush()
                    snap=receive('iq-snapshot');assert not snap['error'],snap
                    if passed==0:
                        # More than the eight-reply bound must be serviced without
                        # losing retained IQ or ending the receiver.
                        p.stdin.write(''.join(f'iq-snapshot {n} {packet["iqToken"]} {str(tmp/f"burst-{n}.ci16").encode().hex()}\n' for n in range(2,22)));p.stdin.flush()
                        for n in range(2,22):
                            reply=receive('iq-snapshot');assert reply['request']==n and not reply['error'],reply
                    first,end=snap['firstSample'],snap['endSample']
                    assert dest.read_bytes()==raw[2*first:2*end].tobytes(),'View IQ changed ADC codes'
                    lo=frequency+(0 if protocol=='wifi' else rate//4)
                    result=subprocess.run([iq_tool,'decode',str(dest),'0',str(end-first),protocol,str(rate),str(frequency),str(lo),phy,str(0x8e89bed6),str(0x555555),'--iq-format','ci16_le','12'],capture_output=True,text=True,timeout=30)
                    assert result.returncode==0,result.stderr
                    replay=json.loads(result.stdout)['packets']
                    assert any(bytes(p['bytes'])==wanted and p['integrity']=='valid' for p in replay),(protocol,phy,replay)
                    p.stdin.write('stop\n');p.stdin.flush();assert p.wait(timeout=5)==0,errors
                passed+=1;print(protocol,rate,phy,"passed",flush=True)
            finally:
                if p.poll() is None:p.kill();p.wait()
        for rate in (8000000,10000000,16000000,20000000):
            for phy,spread,channel in (('1m',0,37),('2m',0,0),('coded',2,37),('coded',8,37)):
                pdu=bytes([7,13,0,1,2,3,4,5,6,7,8,9,10,11,12])
                bits,want=coded_bits(pdu,channel,0x8e89bed6,0x555555,spread) if spread else gen.ble_air_bits(pdu,channel,0x8e89bed6,0x555555,phy)
                wave=gen.gfsk(bits,rate,2e6 if phy=='2m' else 1e6,900.37)
                exercise('ble',rate,2402000000 if channel==37 else 2404000000,radio_codes(wave),want,phy)
            frame=gen.wpan_frame(bytes.fromhex('61880134127856bc9a0102030405'))
            exercise('15p4',rate,2405000000,radio_codes(gen.oqpsk(frame,rate,900.37)),frame)
        fixture=ROOT/'native/tests/fixtures/libcrafter-dsss/dsss-110-short-channel_echo-64.cs8'
        raw=np.fromfile(fixture,dtype=np.int8).astype('<i2')*16
        baseline=tmp/'wifi.ci8';(raw//16).astype(np.int8).tofile(baseline)
        result=subprocess.run([iq_tool,'decode',str(baseline),'0',str(len(raw)//2),'wifi','20000000','2412000000','2412000000','1m',str(0x8e89bed6),str(0x555555)],capture_output=True,text=True,check=True)
        wanted=bytes(json.loads(result.stdout)['packets'][0]['bytes'])
        exercise('wifi',20000000,2412000000,raw,wanted)
        exercise('none',8000000,2402000000,np.arange(4096,dtype='<i2')-2048,b'',record=True)
        p=subprocess.run([worker,'--live','--uri','usb:1.2.3','--frequency','2402000000','--sample-rate','8000000','--bandwidth','7000000'],input='',capture_output=True,text=True,env={**os.environ,'AIRWOLF_IIO_TEST_DISCONNECT':'1'},timeout=10)
        assert p.returncode==1 and 'Test device disconnected' in p.stderr,p.stderr
        # Every exercise above ran with the LO read back as an AD9361 synthesizes
        # it (mostly 1 Hz off). A real mismatch is still refused.
        for offset in ('11','-11'):
            p=subprocess.run([worker,'--live','--uri','usb:1.2.3','--frequency','2402000000','--sample-rate','8000000','--bandwidth','7000000'],input='',capture_output=True,text=True,env={**os.environ,'AIRWOLF_IIO_TEST_LO_OFFSET_HZ':offset},timeout=10)
            assert p.returncode==1 and 'refusing mislabeled samples' in p.stderr,p.stderr
        # A host stall: 600 blocks (2 s at 20 MS/s) arrive at once while Wi-Fi
        # decodes. Late blocks past the 250 ms queue are dropped and counted
        # in whole blocks; reception continues past the gap and a recording
        # running across it seals with reason "gap" instead of splicing.
        source=tmp/'stall.ci16';np.zeros(2,dtype='<i2').tofile(source)
        for record in (False,True):
            dest=tmp/f'stall-{record}.ci16'
            args=[worker,'--live','--uri','usb:1.2.3','--frequency','2412000000','--sample-rate','20000000','--bandwidth','20000000','--decoder','wifi','--stop-on-stdin-eof']
            if record:args+=['--record-iq',str(dest),'--record-samples','60000000']
            p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                               env={**os.environ,'AIRWOLF_IIO_TEST_IQ':str(source),'AIRWOLF_IIO_TEST_BURST_BLOCKS':'600'})
            try:
                dropped=0;recording=None
                for line in p.stdout:
                    event=json.loads(line)
                    if event['type']=='iq-recording':recording=event;break
                    if event['type']!='spectrum':continue
                    dropped=event['queueDroppedSamples'];assert dropped%65536==0,event
                    if not record and dropped and event['firstSample']>600*65536:break
                if record:
                    assert recording and recording['reason']=='gap' and recording['error']=='' and recording['queueDroppedSamples']>0,(recording,p.stderr.read())
                    assert recording['endSample']<=600*65536,recording
                else:
                    assert dropped>0 and p.poll() is None,(dropped,p.stderr.read())
                    p.stdin.write('stop\n');p.stdin.flush();assert p.wait(timeout=10)==0,p.stderr.read()
            finally:
                if p.poll() is None:p.kill();p.wait()
        print('Host stall: late blocks dropped and counted, reception continued, recording sealed at the gap',flush=True)
        # Deliberately stop draining stdout long enough to fill the OS pipe.
        # Acquisition/DSP must keep running; only display events may be replaced.
        p=subprocess.Popen([worker,'--live','--uri','usb:1.2.3','--frequency','2402000000','--sample-rate','8000000','--bandwidth','7000000','--retain-iq','--stop-on-stdin-eof'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            time.sleep(.8)
            events=queue.Queue()
            def drain():
                for line in p.stdout:events.put(json.loads(line))
                events.put(None)
            threading.Thread(target=drain,daemon=True).start()
            while True:
                event=events.get(timeout=10);assert event is not None,p.stderr.read()
                if event['type']=='spectrum':
                    assert event['queueDroppedSamples']==0,event
                    if event['endSample']>=4000000:break
            p.stdin.write('pause\n');p.stdin.flush()
            while True:
                event=events.get(timeout=10);assert event is not None,p.stderr.read()
                if event['type']=='iq-retained':break
            p.stdin.write('stop\n');p.stdin.flush();assert p.wait(timeout=5)==0,p.stderr.read()
        finally:
            if p.poll() is None:p.kill();p.wait()
        print('Stalled output and 20 snapshot requests: reception/retained session survived',flush=True)
    print(f'{passed} 12-bit Pluto live/snapshot/replay/recording cases passed; disconnect exits cleanly')
if __name__=='__main__':verify(sys.argv[1],sys.argv[2])
