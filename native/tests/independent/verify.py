"""Independent signal regressions: no production encoder code or radio required."""
import os, sys, math
os.environ['AIRWOLF_TEST_FEED'] = os.path.abspath(sys.argv[1])
import gen
from sweep import run
from coded import run as coded_run, fec
from noise_only import verify_noise_only

assert gen.crc16(bytes.fromhex('020001')) == 0xa431
assert gen.crc16(b'123456789') == 0x2189
bits, packet = gen.ble_air_bits(bytes.fromhex('16050102030405'), 16, 0xaa08192b, 0xc4c181, '1m')
assert packet.hex() == '2b1908aa1605010203040545d0d2'
assert gen.bytes_from_bits(bits[40:]).hex() == 'c69b5231dbbe9d4df419'
# Bluetooth Core Vol 6 Part C 2.2: published unwhitened FEC/TERM2 example.
expected_fec = ('00000000000000001101010011000000001110111100111011111101010000100001000111111110'
                '000111001000011111111000011111000011011010000001010011')
assert ''.join(map(str, fec(gen.bits_lsb(bytes.fromhex('0003424c45290ace')) + [0, 0, 0]))) == expected_fec
print('Independent CRC, whitening and SIG FEC known-answer vectors passed.', flush=True)

for rate in (8000000, 10000000, 16000000, 20000000):
    # Clean reception at fractional phases, both frequency-error signs, long
    # payloads and clock drift. Exact byte equality includes independently built CRC.
    for phy, channel, cfo in [('1m',37,-150000), ('1m',16,150000), ('2m',16,-250000), ('2m',16,250000)]:
        success, extra, timing, _ = run('ble',rate,phy,cfo,None,npk=24,seed=17,channel=channel)
        assert success == 1 and extra == 0, (rate,phy,channel,cfo,success,extra)
        assert max(abs(timing[1]),abs(timing[2])) <= rate / (2000000 if phy == '2m' else 1000000), timing
    for ppm in (-80,80):
        success, extra, timing, _ = run('15p4',rate,'1m',0,None,npk=24,seed=17,ppm=ppm,plen=125)
        assert success == 1 and extra == 0, (rate,ppm,success,extra)
        assert max(abs(timing[1]),abs(timing[2])) < rate/2000000, timing
    for scheme in (2,8):
        assert coded_run(rate,scheme,None,cfo=-100000,npk=16,seed=17) == 1, (rate,scheme,'clean')
    # Deterministic noise gates are deliberately below the measured rates. They
    # detect the previous failures without imposing a statistical RF sensitivity spec.
    for cfo in (-150000,150000):
        success, extra, _, _ = run('ble',rate,'1m',cfo,16,npk=60,seed=5,channel=37)
        assert success >= .8, (rate,'BLE CFO',cfo,success,extra)
        print(f'{rate/1e6:g} MS/s BLE 1M CFO {cfo/1000:+g} kHz, Eb/N0 16 dB: {success:.1%}', flush=True)
    for cfo in (-200000,0,200000):
        success, extra, _, _ = run('15p4',rate,'1m',cfo,14,npk=60,seed=5)
        assert success >= .95, (rate,'O-QPSK noise/CFO',cfo,success,extra)
        print(f'{rate/1e6:g} MS/s O-QPSK CFO {cfo/1000:+g} kHz, Eb/N0 14 dB: {success:.1%}', flush=True)
    # Coherent O-QPSK detection: the differential receiver decoded nothing at
    # 10 dB. Gates stay below the measured 99-100% to allow for seed variation.
    for cfo in (-200000,0,250000):
        success, extra, _, _ = run('15p4',rate,'1m',cfo,10,npk=60,seed=5)
        assert success >= .9, (rate,'O-QPSK coherent',cfo,success,extra)
        print(f'{rate/1e6:g} MS/s O-QPSK CFO {cfo/1000:+g} kHz, Eb/N0 10 dB: {success:.1%}', flush=True)
    # Maximum-length frames with clock drift and noise need sample-phase following.
    for ppm in (-80,80):
        success, extra, _, _ = run('15p4',rate,'1m',0,11,npk=24,seed=3,ppm=ppm,plen=125)
        assert success >= .75, (rate,'O-QPSK drift in noise',ppm,success,extra)
        print(f'{rate/1e6:g} MS/s O-QPSK {ppm:+d} ppm, 125-byte PSDU, Eb/N0 11 dB: {success:.1%}', flush=True)
    s8 = coded_run(rate,8,7+10*math.log10(8),npk=40,seed=5)
    assert s8 >= .9, (rate,'Coded S8 Es/N0 7 dB',s8)
    print(f'{rate/1e6:g} MS/s Coded S8 Es/N0 7 dB: {s8:.1%}', flush=True)
print('Independent fractional-timing, CFO, AWGN, clock-drift and coding regressions passed.')
verify_noise_only(os.environ['AIRWOLF_TEST_FEED'])
