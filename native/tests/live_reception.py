"""Opt-in receive-only acceptance report. Never run by unattended CI.

Records aggregate evidence, not device identities or received payloads. Zero
decoded frames are reported as UNVERIFIED, never accepted as a decoder pass.
"""
import argparse
import datetime
import json
import math
import pathlib
import platform
import statistics
import subprocess
import time
import zlib
try:
    import resource
except ImportError:
    resource = None


def ble_valid(data, initial):
    if len(data) < 9:
        return False
    # Independent bit-array LFSR (Core Vol 6 Part B 3.1.1), unlike the native
    # word/reflected implementation. Includes only PDU in the CRC calculation.
    state = [(initial >> i) & 1 for i in range(24)]
    for byte in data[4:-3]:
        for shift in range(8):
            feedback = state[23] ^ ((byte >> shift) & 1)
            state = [feedback] + [state[i-1] ^ (feedback if i in (1, 3, 4, 6, 9, 10) else 0) for i in range(1, 24)]
    return state[::-1] == [(byte >> i) & 1 for byte in data[-3:] for i in range(8)]


def wpan_valid(data):
    if len(data)<5:return False
    # Bit-array reflected x^16 + x^12 + x^5 + 1, independent of native word CRC.
    state=[0]*16
    for byte in data[:-2]:
        for bit in range(8):
            feedback=state[0]^((byte>>bit)&1)
            state=state[1:]+[0]
            for k in (3,10,15):state[k]^=feedback
    return sum(v<<i for i,v in enumerate(state))==int.from_bytes(data[-2:],'little')


def cpu_seconds():
    if resource is None:
        return None
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--radio', default='native/build/bin/airwolf-radio')
    parser.add_argument('--lte-radio', default='native/build/bin/airwolf-lte-radio')
    parser.add_argument('--serial')
    parser.add_argument('--seconds', type=int, default=15)
    parser.add_argument('--lna', type=int, default=24)
    parser.add_argument('--vga', type=int, default=20)
    parser.add_argument('--ble', default='2402,2426,2480', help='comma-separated MHz; empty disables')
    parser.add_argument('--wifi', default='2412,2462,5200', help='20 MHz non-HT OFDM centers')
    parser.add_argument('--wpan', default='', help='comma-separated IEEE 802.15.4 channel centers in MHz')
    parser.add_argument('--iq-directory', type=pathlib.Path, help='Keep original IQ and packet events locally for diagnosis')
    parser.add_argument('--lte', default='', help='exact downlink carrier centers in MHz, not band midpoints')
    parser.add_argument('--output', default='.local/live-reception.json')
    args = parser.parse_args()
    if not 5 <= args.seconds <= 120:
        parser.error('--seconds must be 5..120')
    # SIG non-default CRCInit vector, before checking any live integrity.
    assert wpan_valid(bytes.fromhex('02000131a4'))
    assert ble_valid(bytes.fromhex('2b1908aa1605010203040545d0d2'), 0xc4c181)
    probe = subprocess.run([args.radio, '--list'], capture_output=True, text=True, check=True, timeout=5)
    devices = json.loads(probe.stdout)['serials']
    serial = args.serial or (devices[0] if len(devices) == 1 else None)
    if serial is None or devices.count(serial) != 1:
        parser.error('Specify one unique connected --serial')
    report = {
        'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'host': platform.platform(), 'receiveOnly': True, 'lnaDb': args.lna, 'vgaDb': args.vga,
        'limits': 'Ambient reception is not a sensitivity or calibrated-power test. CPU is native process only; 100% is one core. LTE CRC is checked by the native PHY; MIB bytes alone cannot independently prove it.',
        'results': [],
    }
    for protocol, centers in [('ble', args.ble), ('wifi', args.wifi), ('15p4',args.wpan), ('lte', args.lte)]:
        for frequency in filter(None, centers.split(',')):
            rate = 20000000 if protocol == 'wifi' else 8000000
            binary = args.lte_radio if protocol == 'lte' else args.radio
            command = [binary, '--serial', serial, '--decoder', protocol, '--frequency', str(round(float(frequency)*1e6)),
                       '--sample-rate', str(rate), '--lna', str(args.lna), '--vga', str(args.vga), '--duration-ms', str(args.seconds*1000)]
            raw_path = None
            if args.iq_directory:
                if args.seconds*rate > 134217728: parser.error('Keep takes at most 256 MiB (6 seconds at 20 MS/s)')
                args.iq_directory.mkdir(parents=True,exist_ok=True)
                raw_path=args.iq_directory/f'{protocol}-{frequency}-{args.lna}-{args.vga}.iq'
                command=command[:-2]+['--record-iq',str(raw_path),'--record-samples',str(args.seconds*rate)]
            before = cpu_seconds()
            start = time.monotonic()
            run = subprocess.run(command, capture_output=True, timeout=args.seconds+20)
            elapsed = time.monotonic()-start
            after = cpu_seconds()
            if run.returncode:
                raise RuntimeError(run.stderr.decode(errors='replace'))
            events = [json.loads(line) for line in run.stdout.splitlines()]
            spectra = [e for e in events if e['type'] == 'spectrum']
            packets = [e for e in events if e['type'] == 'packet']
            if len(spectra) < 2 or any(e['synthetic'] for e in events):
                raise RuntimeError('Missing real native capture evidence')
            if raw_path:
                raw_path.with_suffix('.events.json').write_text(json.dumps({'config':command,'packets':packets,'spectrum':spectra[-1]},indent=2))
            valid = invalid = native_mibs = 0
            for packet in packets:
                data = bytes(packet['bytes'])
                assert packet['firstSample'] < packet['endSample'] <= spectra[-1]['samples'] + rate
                if protocol == 'lte':
                    assert packet['integrity'] == 'valid' and len(data) == 3
                    assert packet['ltePrb'] in (6,15,25,50,75,100) and packet['ltePorts'] in (1,2,4)
                    assert data[0] >> 5 == (6,15,25,50,75,100).index(packet['ltePrb'])
                    native_mibs += 1
                    continue
                ok = ble_valid(data, packet['crcInit']) if protocol == 'ble' else wpan_valid(data) if protocol == '15p4' else len(data) >= 4 and zlib.crc32(data[:-4]) == int.from_bytes(data[-4:], 'little')
                valid += ok
                invalid += not ok
            for event in spectra:
                assert len(event['bins']) == len(event['meanBins']) == 2048
                assert all(math.isfinite(x) for x in event['bins']+event['meanBins'])
                assert event['endSample']-event['firstSample'] == 2048+(event['spectrumWindows']-1)*event.get('spectrumHopSamples', 2048)
                assert all(a <= b+.02 for a, b in zip(event['meanBins'], event['bins']))
            powers = [sum(10**(v/10) for v in e['meanBins'])/(1.5*2048/2047) for e in spectra[1:]]
            result = {
                'protocol': protocol, 'frequencyMHz': float(frequency), 'sampleRate': rate,
                'wallSeconds': round(elapsed, 3),
                'cpuPercent': round(100*(after-before)/elapsed, 2) if before is not None else None,
                'spectrumEvents': len(spectra), 'independentlyValidFrames': valid, 'invalidFrames': invalid,
                'nativeVerifiedMibs': native_mibs,
                'maxQueueDroppedSamples': max(e['queueDroppedSamples'] for e in spectra),
                'maxPacketQueueDrops': max(e['packetQueueDrops'] for e in spectra),
                'syncCandidates': spectra[-1]['syncCandidates'],
                'medianInputPowerDbfs': round(10*math.log10(statistics.median(powers)), 2),
                'recordedIq': str(raw_path) if raw_path else None,
                'reception': 'observed' if valid or native_mibs else 'UNVERIFIED: no valid frame received',
            }
            report['results'].append(result)
            output = pathlib.Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2)+'\n')
            print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
