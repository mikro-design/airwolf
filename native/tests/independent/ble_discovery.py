"""BLE connection discovery: access address and CRC init recovered from
traffic alone (no CONNECT_IND), through the real native DSP.
Independent spec-literal packets (gen.py); no receiver imports.

adversarial() covers what produced phantom connections before: readings of
an address one bit late or early, address bit errors, repeated non-connection
frames (retransmissions), and a packet embedded in another's payload.
"""
import subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import gen

def valid_aa(a):
    # Core Vol 6 Part B 2.1.2 (LE 1M/2M rules)
    if a == 0x8e89bed6 or bin(a ^ 0x8e89bed6).count('1') <= 1: return False
    if len({(a >> s) & 0xff for s in (0, 8, 16, 24)}) == 1: return False
    bits = [(a >> i) & 1 for i in range(32)]
    run, transitions = 1, 0
    for i in range(1, 32):
        if bits[i] != bits[i - 1]: transitions += 1; run = 1
        else:
            run += 1
            if run > 6: return False
    top = sum(bits[i] != bits[i - 1] for i in range(27, 32))
    return transitions <= 24 and top >= 2

def connection(rng, rate, channel, phy, aa, crc, events, snr_db, lead=0, damage=None, embed=None):
    waves, expected, t = [], [], 0.0
    for e in range(events):
        for role in range(2):  # central then peripheral, 150 us apart
            if rng.random() < 0.3:  # LL data with a payload
                body = bytes(rng.integers(0, 256, int(rng.integers(1, 28)), dtype=np.uint8))
                pdu = bytes([0x02 | (e & 1) << 2 | (e & 1) << 3, len(body)]) + body
            else:  # empty PDU
                pdu = bytes([0x01 | (e & 1) << 2 | (e & 1) << 3, 0])
            if embed is not None and e >= 2 and role == 0:
                pdu = embed(e)
            bits, raw = gen.ble_air_bits(pdu, channel, aa, crc, phy)
            # Random modulated bits before the preamble (ramp-up, or the end of
            # another transmission): the alternation may then start early.
            bits = list(rng.integers(0, 2, lead)) + bits
            if damage is not None and damage(rng):
                n = (16 if phy == '2m' else 8) + int(rng.integers(1, 32))
                bits[lead + n] ^= 1  # one access address bit error; PDU intact
            rs = 2e6 if phy == '2m' else 1e6
            gap = int(rng.uniform(150, 400) * rate / 1e6)
            waves.append(np.zeros(gap, complex))
            waves.append(gen.gfsk(bits, rate, rs, 300 + rng.uniform(0, rate / rs), h=0.5))
            expected.append(raw.hex())
        waves.append(np.zeros(int(rate * 2e-3), complex))
    return np.concatenate(waves), expected

def run(feed, path, channel, rate, phy, *, address='00000000', crc='555555'):
    out = subprocess.run([feed, 'ble', str(channel), str(rate), phy, address, crc, path],
                         capture_output=True, text=True, timeout=60, check=True).stdout
    return [line.split() for line in out.splitlines()]

def verify(feed):
    rng = np.random.default_rng(31337)
    total = 0
    with tempfile.TemporaryDirectory() as temporary:
        path = str(Path(temporary) / 'connection.iq')
        for rate in (8000000, 16000000, 20000000):
            for phy in ('1m', '2m'):
                channel = int(rng.integers(0, 37))
                while True:
                    aa = int(rng.integers(0, 2**32))
                    if valid_aa(aa): break
                crc = int(rng.integers(0, 2**24))
                wave, expected = connection(rng, rate, channel, phy, aa, crc, 12, 25)
                gen.to_radio(wave, rate, 120000, 25, 1, 10, rng).tofile(path)
                rows = run(feed, path, channel, rate, phy)
                assert rows, (rate, phy, 'no connection found')
                # Every reported packet is a real one, with the right init.
                for row in rows:
                    assert row[4:] == ['discovered', f'{crc:06x}'], (rate, phy, row)
                    assert row[3] in expected, (rate, phy, row[3])
                # At most the first proposal per address is withheld, plus
                # rare misses; most of the connection must be reported.
                assert len(rows) >= len(expected) - 3, (rate, phy, len(rows), len(expected))
                total += len(rows)
        # Noise alone must never report a connection.
        noise = (rng.normal(0, 12, 2 * 20000000 * 2)).clip(-127, 127).astype(np.int8)
        noise.tofile(path)
        for phy in ('1m', '2m'):
            assert run(feed, path, 10, 20000000, phy) == [], phy
    # Legacy advertising on a data channel (test firmware does this): the
    # advertising access address and CRC init still identify it.
    pdu = bytes.fromhex('4210efbeedfea0c10201060609504958454c')  # ADV_NONCONN_IND "PIXEL"
    waves = []
    for _ in range(5):
        bits, raw = gen.ble_air_bits(pdu, 17, 0x8e89bed6, 0x555555, '1m')
        waves += [np.zeros(3000, complex), gen.gfsk(bits, 8000000, 1e6, 300 + rng.uniform(0, 8))]
    with tempfile.TemporaryDirectory() as temporary:
        path = str(Path(temporary) / 'legacy.iq')
        gen.to_radio(np.concatenate(waves), 8000000, 80000, 25, 4, 10, rng).tofile(path)
        rows = run(feed, path, 17, 8000000, '1m', address='8e89bed6', crc='555555')
        assert [r[3] for r in rows] == [raw.hex()] * 5, rows
        # The default data-channel mode (advertising + find connections)
        # receives them too, as ordinary advertising (no discovery tag).
        rows = run(feed, path, 17, 8000000, '1m')
        assert [r[3:] for r in rows] == [[raw.hex()]] * 5, rows
        # LE 2M advertising on a primary channel (test setups do this).
        waves = []
        for _ in range(5):
            bits, raw = gen.ble_air_bits(pdu, 37, 0x8e89bed6, 0x555555, '2m')
            waves += [np.zeros(3000, complex), gen.gfsk(bits, 8000000, 2e6, 300 + rng.uniform(0, 4))]
        gen.to_radio(np.concatenate(waves), 8000000, 80000, 25, 4, 10, rng).tofile(path)
        rows = run(feed, path, 37, 8000000, '2m', address='8e89bed6', crc='555555')
        assert [r[3] for r in rows] == [raw.hex()] * 5, rows
    print(f'{total} connection packets from 6 discovered connections (1M/2M, 8-20 MS/s); none from 4 s of noise')

def random_aa(rng, condition=lambda a: True):
    while True:
        aa = int(rng.integers(0, 2**32))
        if valid_aa(aa) and condition(aa): return aa

def adversarial(feed):
    rng = np.random.default_rng(4242)
    rate, channel = 8000000, 9
    with tempfile.TemporaryDirectory() as temporary:
        path = str(Path(temporary) / 'adversarial.iq')
        def check(wave, phy, truth, minimum, label):
            gen.to_radio(wave, rate, 120000, 25, 1, 10, rng).tofile(path)
            rows = run(feed, path, channel, rate, phy)
            for row in rows:
                assert row[3][:8] in truth, (label, 'phantom connection', row)
                aa = row[3][:8]
                assert row[4:] == ['discovered', f'{truth[aa][0]:06x}'], (label, row)
                assert row[3] in truth[aa][1], (label, 'not a sent packet', row[3])
            for aa, (crc, expected) in truth.items():
                got = sum(r[3][:8] == aa for r in rows)
                assert got >= len(expected) - minimum, (label, aa, got, len(expected))
            return rows
        key = lambda aa: aa.to_bytes(4, 'little').hex()

        # Shift readings: an address whose first two bits differ is always
        # also read one bit late; random bits before the preamble make an
        # early reading half the time. Two connections, each kind.
        for phy in ('1m', '2m'):
            truth, waves = {}, []
            for differ in (True, False):
                aa = random_aa(rng, lambda a: ((a ^ (a >> 1)) & 1) == differ)
                crc = int(rng.integers(0, 2**24))
                wave, expected = connection(rng, rate, channel, phy, aa, crc, 20, 25, lead=6)
                truth[key(aa)] = (crc, expected); waves.append(wave)
            check(np.concatenate(waves), phy, truth, 4, f'shift {phy}')

        # Address bit errors on a third of the packets: published under the
        # connection's address only with an intact CRC, never as a connection.
        aa, crc = random_aa(rng), int(rng.integers(0, 2**24))
        wave, expected = connection(rng, rate, channel, '1m', aa, crc, 30, 25, damage=lambda r: r.random() < 0.33)
        rows = check(wave, '1m', {key(aa): (crc, expected)}, 30, 'address errors')
        assert len(rows) >= 0.8 * len(expected), (len(rows), len(expected))

        # Repeated frames that are no connection (another protocol's, or
        # retransmissions): each distinct frame three times. A repeat proposes
        # the same CRC init again, so it must not confirm anything.
        waves = []
        for _ in range(120):
            aa = random_aa(rng)
            body = list(rng.integers(0, 2, 8 * 30))
            bits = [((aa & 1) ^ (i & 1)) for i in range(8)] + [(aa >> i) & 1 for i in range(32)] + body
            burst = gen.gfsk(bits, rate, 1e6, 300 + rng.uniform(0, 8))
            for _ in range(3): waves += [np.zeros(int(rng.uniform(200, 600) * 8), complex), burst]
        gen.to_radio(np.concatenate(waves), rate, 120000, 25, 1, 10, rng).tofile(path)
        assert run(feed, path, channel, rate, '1m') == [], 'repeated frames confirmed a connection'

        # A packet carried in another connection's payload (a sniffer trace
        # being retransmitted, say): reported as the outer packet only.
        inner_aa, inner_crc = random_aa(rng), int(rng.integers(0, 2**24))
        whitening = gen.ble_whiten_seq(channel, 8 * 255)
        def embed(e):
            inner, _ = gen.ble_air_bits(bytes([0x02, 4]) + bytes([e & 255, 1, 2, 3]), channel, inner_aa, inner_crc, '1m')
            start = 16 + 32  # header plus four payload octets
            payload = list(rng.integers(0, 2, 32)) + [b ^ w for b, w in zip(inner, whitening[start:])] + list(rng.integers(0, 2, 32))
            body = gen.bytes_from_bits(payload)
            return bytes([0x02, len(body)]) + body
        aa, crc = random_aa(rng), int(rng.integers(0, 2**24))
        wave, expected = connection(rng, rate, channel, '1m', aa, crc, 20, 25, embed=embed)
        check(wave, '1m', {key(aa): (crc, expected)}, 3, 'embedded')
    print('discovery: no phantom connection from shift readings, address errors, repeats or embedded packets')

if __name__ == '__main__':
    verify(sys.argv[1])
    adversarial(sys.argv[1])
