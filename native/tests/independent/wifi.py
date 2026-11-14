"""Independent IEEE 802.11 non-HT OFDM IQ fixtures; never imports receiver code.
20 MHz, all eight legacy OFDM rates. NumPy supplies the reference IFFT and zlib
supplies the independent MAC FCS. The receiver under test consumes signed IQ.
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import zlib
import numpy as np
from scipy.signal import resample_poly

# RATE field in transmitted order, NOT a little-endian integer. These bit
# strings are also exercised by externally recorded OpenOFDM fixtures.
RATES = {6: ('1101', 1, 24, [1, 1]), 9: ('1111', 1, 36, [1, 1, 1, 0, 0, 1]),
         12: ('0101', 2, 48, [1, 1]), 18: ('0111', 2, 72, [1, 1, 1, 0, 0, 1]),
         24: ('1001', 4, 96, [1, 1]), 36: ('1011', 4, 144, [1, 1, 1, 0, 0, 1]),
         48: ('0001', 6, 192, [1, 1, 1, 0]), 54: ('0011', 6, 216, [1, 1, 1, 0, 0, 1])}
# Frequency-domain L-LTF ordered from -26 to +26, including zero at DC.
LTF = np.array([1,1,-1,-1,1,1,-1,1,-1,1,1,1,1,1,1,-1,-1,1,1,-1,1,-1,1,1,1,1,
                0,1,-1,-1,1,1,-1,1,-1,1,-1,-1,-1,-1,-1,1,1,-1,-1,1,-1,1,-1,1,1,1,1])
DATA = [k for k in range(-26, 27) if k not in (0, -21, -7, 7, 21)]

def lsb(value, count):
    return [(value >> b) & 1 for b in range(count)]

def scramble(bits, initial):
    state = [(initial >> b) & 1 for b in range(7)]
    result = []
    for bit in bits:
        feedback = state[6] ^ state[3]
        result.append(bit ^ feedback)
        state = [feedback] + state[:6]
    return result

def encode(bits):
    delay = [0] * 6
    output = []
    for b in bits:
        r = [b] + delay
        output += [r[0] ^ r[2] ^ r[3] ^ r[5] ^ r[6], r[0] ^ r[1] ^ r[2] ^ r[3] ^ r[6]]
        delay = r[:6]
    return output

def interleave(bits, bpsc):
    n = len(bits)
    s = max(bpsc // 2, 1)
    first = [None] * n
    for k, bit in enumerate(bits):
        first[(n // 16) * (k % 16) + k // 16] = bit
    second = [None] * n
    for i, bit in enumerate(first):
        second[s * (i // s) + (i + n - (16 * i) // n) % s] = bit
    return second

def symbols(bits, bpsc):
    b = np.array(bits).reshape(-1, bpsc)
    def pam(v):
        if len(v) == 1:
            return 2 * v[0] - 1
        if len(v) == 2:
            return (2 * v[0] - 1) * (3 - 2 * v[1])
        return (2 * v[0] - 1) * (4 - (2 * v[1] - 1) * (2 - (2 * v[2] - 1)))
    if bpsc == 1:
        return np.array([pam(v) for v in b])
    norm = np.sqrt({2: 2, 4: 10, 6: 42}[bpsc])
    return np.array([complex(pam(v[:bpsc//2]), pam(v[bpsc//2:])) / norm for v in b])

def waveform(payload, mbps, seed=93, errors=()):
    code, bpsc, dbps, puncture = RATES[mbps]
    n_symbols = (16 + 8 * len(payload) + 6 + dbps - 1) // dbps
    service_payload = [0]*16 + [b for byte in payload for b in lsb(byte, 8)]
    data = scramble(service_payload + [0] * (n_symbols * dbps - len(service_payload)), seed)
    data[len(service_payload):len(service_payload)+6] = [0]*6
    coded = [b for i, b in enumerate(encode(data)) if puncture[i % len(puncture)]]
    for bit in errors: coded[bit]^=1
    signal = [int(b) for b in code] + [0] + lsb(len(payload), 12)
    signal += [sum(signal) % 2] + [0]*6
    polarity = [1 - 2*b for b in scramble([0]*127, 127)]
    def ofdm(bits, modulation, index):
        bins = np.zeros(64, complex)
        bins[np.array(DATA) % 64] = symbols(interleave(bits, modulation), modulation)
        bins[np.array([-21, -7, 7, 21]) % 64] = np.array([1, 1, 1, -1]) * polarity[index % 127]
        time = np.fft.ifft(bins)
        return np.r_[time[-16:], time]
    short = np.zeros(64, complex)
    short[np.array([-24,-20,-16,-12,-8,-4,4,8,12,16,20,24]) % 64] = np.sqrt(13/6) * (1+1j) * np.array([1,-1,1,-1,-1,1,-1,-1,1,1,1,1])
    short = np.tile(np.fft.ifft(short)[:16], 10)
    long = np.zeros(64, complex)
    long[np.arange(-26, 27) % 64] = LTF
    long = np.fft.ifft(long)
    parts = [short, long[-32:], long, long, ofdm(encode(signal), 1, 0)]
    for i in range(n_symbols):
        parts.append(ofdm(coded[i*48*bpsc:(i+1)*48*bpsc], bpsc, i+1))
    return np.concatenate(parts)

def iq(payload, mbps, cfo=0, noise=0, fraction=0, ppm=0, seed=1, errors=()):
    rng = np.random.default_rng(seed)
    signal = waveform(payload, mbps, errors=errors)
    signal = np.convolve(signal, [1, 0, 0, .15+.1j])
    signal = np.r_[np.zeros(256), signal, np.zeros(700)]
    positions = np.arange(len(signal)) * (1+ppm*1e-6) - fraction
    oversampled = resample_poly(signal, 8, 1)
    grid = np.arange(len(oversampled))/8
    signal = np.interp(positions, grid, oversampled.real) + 1j*np.interp(positions, grid, oversampled.imag)
    signal *= np.exp(1j*(2*np.pi*cfo/20e6*np.arange(len(signal)) + rng.uniform(-np.pi, np.pi)))
    signal *= 80 / np.max(np.abs(signal))
    signal += noise*(rng.standard_normal(len(signal)) + 1j*rng.standard_normal(len(signal)))
    output = np.empty(2*len(signal), np.int8)
    output[0::2] = np.clip(np.round(signal.real), -127, 127)
    output[1::2] = np.clip(np.round(signal.imag), -127, 127)
    return output

def packet(length=120):
    # Beacon with stable fixture addresses; the remainder is deterministic data.
    data = bytes.fromhex('80000000ffffffffffff0200000000010200000000011000')
    data += bytes((i*37+11) % 256 for i in range(max(0, length-28)))
    return data + zlib.crc32(data).to_bytes(4, 'little')

def run(binary):
    count=0
    with tempfile.TemporaryDirectory(prefix='airwolf-wifi-') as directory:
        file=pathlib.Path(directory)/'signal.iq'
        for rate in RATES:
            for cfo, noise, fraction, ppm in [(0,0,0,0), (150000,1,.23,20), (-150000,1,.71,-20)]:
                expected = packet()
                iq(expected,rate,cfo,noise,fraction,ppm,seed=rate).tofile(file)
                result=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
                rows=[line.split() for line in result.stdout.splitlines()]
                assert len(rows)==1 and rows[0][2:]==[str(rate),'1',expected.hex()], (rate,cfo,result.stdout,result.stderr)
                count+=1
            # A coded-bit error defeats greedy transition decoding. The soft
            # Viterbi fallback must recover the unchanged PSDU and valid FCS.
            expected=packet();iq(expected,rate,cfo=250000,errors=(19,)).tofile(file)
            result=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
            rows=[line.split() for line in result.stdout.splitlines()]
            assert len(rows)==1 and rows[0][2:]==[str(rate),'1',expected.hex()], ('FEC recovery',rate,result.stdout,result.stderr)
            count+=1
            expected=packet(4095)
            iq(expected,rate,-150000,1,.67,-40,seed=rate).tofile(file)
            result=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
            rows=[line.split() for line in result.stdout.splitlines()]
            assert len(rows)==1 and rows[0][2:]==[str(rate),'1',expected.hex()], ('maximum length',rate,result.stderr)
            count+=1
            damaged=bytearray(packet());damaged[60]^=1
            iq(damaged,rate).tofile(file)
            result=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
            rows=[line.split() for line in result.stdout.splitlines()]
            assert len(rows)==1 and rows[0][2:]==[str(rate),'0',damaged.hex()], ('bad FCS',rate,result.stderr)
            count+=1
        # Short high-rate ACKs separated by the 10 us 2.4 GHz SIFS. No idle
        # padding from iq(): exercises search reset while frames are contiguous.
        ack=bytes.fromhex('d4000000020000000001');ack+=zlib.crc32(ack).to_bytes(4,'little')
        for rate in (6,54):
            x=np.concatenate([np.r_[waveform(ack,rate),np.zeros(200)] for _ in range(20)])
            x=np.r_[np.zeros(256),x,np.zeros(700)];x*=80/np.max(abs(x))
            raw=np.empty(2*len(x),np.int8);raw[::2]=np.round(x.real);raw[1::2]=np.round(x.imag);raw.tofile(file)
            result=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
            rows=[line.split() for line in result.stdout.splitlines()]
            assert len(rows)==20 and all(r[2:]==[str(rate),'1',ack.hex()] for r in rows), ('SIFS',rate,len(rows),result.stderr)
            count+=20
        rng=np.random.default_rng(41)
        for kind in ['noise','dc','tone','multitone']:
            n=np.arange(2000000)
            x=(30 if kind=='dc' else 50*np.exp(2j*np.pi*.13*n) if kind=='tone' else 25*np.exp(2j*np.pi*.125*n)+25*np.exp(2j*np.pi*.25*n) if kind=='multitone' else 0) + 5*(rng.normal(size=len(n))+1j*rng.normal(size=len(n)))
            raw=np.empty(2*len(n),np.int8);raw[0::2]=np.round(x.real);raw[1::2]=np.round(x.imag);raw.tofile(file)
            result=subprocess.run([binary,str(file)],capture_output=True,text=True,check=True)
            assert not result.stdout.strip(), (kind,result.stdout,result.stderr)
            count+=1
    print(json.dumps({'wifi_iq_cases':count,'rates_mbps':list(RATES),'result':'passed'}))

if __name__ == '__main__':
    run(sys.argv[1])
