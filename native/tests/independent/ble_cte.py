"""Independent CTE IQ interval and discontinuity regression; no radio hardware."""
import json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
import gen
from coded import coded_bits

binary = sys.argv[1]
replay = sys.argv[2] if len(sys.argv) > 2 else None
rng = np.random.default_rng(83116)
count = 0
with tempfile.TemporaryDirectory() as directory:
    filename = str(Path(directory) / 'cte.iq')
    def run(rate, phy, info=20, advertising=False, damage=False, primary=False,
            stop=False, gap=False, following=False, bad_header=False):
        global count
        rs = 2000000 if phy == '2m' else 1000000
        channel = 37 if primary else 16
        aa, init = (0x8e89bed6, 0x555555) if advertising else (0x12345678, 0xabcdef)
        if advertising:
            body = bytes([4, 0x0c, info, 0x34, 0x12, 5, 9, 84, 101, 115, 116])
            if bad_header: body = bytes([10, 0x0d, 1, 2, 3, 4, 5, 6, info, 0x34, 0x12, 5, 9, 84, 101, 115, 116])
            pdu = bytes([7, len(body)]) + body
        else: pdu = bytes([0x22, 7, info, 3, 0, 4, 0, 0x0a, 0x25, 0])
        if phy == 'coded': bits, raw = coded_bits(pdu, channel, aa, init, 8)
        else: bits, raw = gen.ble_air_bits(pdu, channel, aa, init, phy)
        if damage:
            bits[-1] ^= 1
            raw = raw[:-1] + bytes([raw[-1] ^ 0x80])
        first = 300 + rng.uniform(0, rate / rs)
        crc_end = first + len(bits) * rate / rs
        duration = (info & 31) * 8
        legal = (not advertising and not damage and not primary and not bad_header and phy != 'coded' and
                 not info & 0x20 and info >> 6 != 3 and 2 <= info & 31 <= 20)
        wanted_end = crc_end + duration * rate / 1e6 if legal else crc_end
        # The actual test transmitter sends a tone after the CRC, unwhitened.
        waveform = gen.gfsk(bits + [1] * int(max(160, duration) * rs / 1e6), rate, rs, first)
        if gap: waveform = np.concatenate([waveform, np.zeros(rate // 1000)])
        gen.to_radio(waveform, rate, 0, 45, 0, 0, rng).tofile(filename)
        cut = int(crc_end + rate * 30 / 1e6) if stop or gap else 0
        skipped = int(rate * 200 / 1e6) if gap else 0
        result = subprocess.run([binary, phy, str(rate), str(channel), f'{aa:x}', f'{init:x}', filename,
            str(cut), str(skipped), str(int(following))], capture_output=True, text=True, timeout=10, check=True)
        rows = [line.split() for line in result.stdout.splitlines()]
        # Coded data CP is prohibited by the PHY gate, so it must not decode.
        if phy == 'coded' and not advertising:
            assert not rows, (rows, result.stderr); return
        matches = [row for row in rows if row[6] == raw.hex()]
        assert len(matches) == 1 and len(rows) == 1, (rate, phy, info, advertising, rows, raw.hex(), result.stderr)
        row = matches[0]; start, end, cte, complete, available, token = map(int, row[:6])
        assert abs(start - first) <= rate / rs, (rate, phy, start, first)
        assert end <= available and token > 0, row
        assert cte == (duration if legal else 0), (row, legal)
        if legal and (stop or gap):
            assert not complete and crc_end - rate / rs <= end <= cut, (row, crc_end, cut)
            assert end == cut, row
        else:
            assert complete == int(legal), row
            assert abs(end - wanted_end) <= rate / rs, (row, wanted_end)
        count += 1
        if replay and rate == 8000000 and legal and info == 20 and not gap:
            samples = cut if stop else len(waveform)
            output = subprocess.run([replay, 'decode', filename, '0', str(samples), 'ble', str(rate),
                '2438000000', str(2438000000 + rate // 4), phy, str(aa), str(init)],
                capture_output=True, text=True, timeout=10, check=True)
            packets = json.loads(output.stdout)['packets']
            matching = [packet for packet in packets if bytes(packet['bytes']).hex() == raw.hex()]
            assert len(matching) == 1, packets
            packet = matching[0]
            assert packet['integrity'] == 'valid' and packet['bleCteUs'] == 160, packet
            assert packet['bleCteComplete'] is (not stop), packet
            assert packet['endSample'] <= samples, packet
        if legal and not stop and not gap and info == 20:
            # Exact acquired-sample boundary, not a rounded duration: one missing
            # sample must not claim complete coverage. No waveform is altered.
            for boundary in (end - 1, end, end + 1):
                clipped = subprocess.run([binary, phy, str(rate), str(channel), f'{aa:x}', f'{init:x}', filename,
                    str(boundary), '0', str(int(following))], capture_output=True, text=True, timeout=10, check=True)
                selected = [row.split() for row in clipped.stdout.splitlines() if row.split()[6] == raw.hex()]
                assert len(selected) == 1, clipped.stdout
                selected = list(map(int, selected[0][:6]))
                assert selected[1] == min(end, boundary) and selected[3] == int(boundary >= end), (boundary, end, selected)
                assert selected[5] > 0, selected

    for rate in (8000000, 10000000, 16000000, 20000000):
        for phy in ('1m', '2m'):
            for advertising in (False, True):
                for time in (2, 20):
                    for kind in (0, 1, 2): run(rate, phy, time | kind << 6, advertising)
                for follow in (False, True):
                    run(rate, phy, 20, advertising, stop=True, following=follow)
                    run(rate, phy, 20, advertising, gap=True, following=follow)
            for invalid in (0, 1, 21, 0x22, 0xc2):
                run(rate, phy, invalid); run(rate, phy, invalid, advertising=True)
            run(rate, phy, damage=True)
            run(rate, phy, advertising=True, damage=True)
            run(rate, phy, advertising=True, bad_header=True)
        run(rate, '1m', advertising=True, primary=True)
        run(rate, 'coded', advertising=True)
        run(rate, 'coded')
print(f'{count} CRC-complete CTE frames: exact bounds, all rates/uncoded PHYs,16–160us, gaps/EOF, invalid negatives and retained IQ passed')
