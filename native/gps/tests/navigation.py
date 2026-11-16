"""LNAV inspection against independently expressed parity and field vectors.
The receiver uses PocketSDR; this gate uses neither its generator nor decoder.
Bit positions/scales: IS-GPS-200N sections 20.3.3 and table 20-XIV.
"""
import json, math, struct, subprocess, sys

MASKS = (0xBB1F3480, 0x5D8F9A40, 0xAEC7CD00, 0x5763E680, 0x6BB1F340, 0x8B7A89C0)
def put(bits, offset, length, value):
    value &= (1 << length) - 1
    bits[offset:offset+length] = [(value >> n) & 1 for n in range(length-1, -1, -1)]
def parity(word):
    value = 0
    for mask in MASKS:
        value = (value << 1) | ((word & mask).bit_count() & 1)
    return value

def encode(bits):
    previous, words = 0, []
    for w in range(10):
        data = 0
        for bit in bits[w*24:(w+1)*24]: data = (data << 1) | bit
        if w in (1, 9):
            for solved in range(4):
                candidate = (data & ~3) | solved
                check = parity((previous << 30) | (candidate << 6))
                if check & 3 == 0:
                    data = candidate
                    break
            else: raise AssertionError('No parity termination')
        check = parity((previous << 30) | (data << 6))
        transmitted = data ^ (0xFFFFFF if previous & 1 else 0)
        words.append((transmitted << 6) | check)
        previous = check & 3
    return struct.pack('<10I', *words)
def frame(sf, page=0):
    bits = [0]*240
    put(bits,0,8,0x8B);put(bits,24,17,1000);put(bits,43,3,sf)
    if sf >= 4: put(bits,48,2,1);put(bits,50,6,page)
    return bits

def inspect(raw, prn=7):
    result = subprocess.run([sys.argv[1], raw.hex(), str(prn)], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert 'runtime error:' not in result.stderr and 'AddressSanitizer' not in result.stderr
    doc = json.loads(result.stdout)
    assert all(0 <= f['offset'] <= 40 and 0 <= f['length'] <= 40-f['offset'] for f in doc['fields'])
    return doc, {f['filter']: f['value'] for f in doc['fields']}
def valid(bits):
    doc, fields = inspect(encode(bits))
    assert doc['integrity'] == 'valid', doc
    assert fields['gps.tow'] == '6000 s (GPS week)'
    return fields

if __name__ == '__main__':
    a=frame(1);put(a,48,10,1023);put(a,70,2,2);put(a,168,8,173);put(a,160,8,-3);put(a,192,8,-5);put(a,200,16,-1234);put(a,216,22,-54321)
    f=valid(a);assert f['gps.week_mod1024']=='1023';assert f['gps.iodc']=='685'
    assert math.isclose(float(f['gps.af0'].split()[0]), -54321*2**-31, rel_tol=1e-10)
    for sf in (2,3):
        a=frame(sf)
        for offset,length,value in ((48,8,73),(88,32,-12345678),(136,32,12345678),(184,32,2718187520)) if sf==2 else ((64,32,-12345678),(112,32,12345678),(160,32,-12345678),(192,24,-3456),(224,14,-123)):
            put(a,offset,length,value)
        f=valid(a)
        if sf==2:
            assert math.isclose(float(f['gps.m0'].split()[0]),-12345678*2**-31*math.pi,rel_tol=1e-10)
            assert math.isclose(float(f['gps.sqrt_a'].split()[0]),2718187520*2**-19,rel_tol=1e-10)
        else: assert math.isclose(float(f['gps.idot'].split()[0]),-123*2**-43*math.pi,rel_tol=1e-10)
    for sv in range(1,33):
        a=frame(5 if sv<=24 else 4,sv);put(a,216,8,0xFF);put(a,235,3,7);put(a,224,11,-1)
        f=valid(a);assert f['gps.almanac.af0']==str(-2**-20)+' s' or math.isclose(float(f['gps.almanac.af0'].split()[0]),-2**-20,rel_tol=1e-10)
    for sf,page in ((4,56),(5,51),(4,63),(4,52),(4,58)):
        a=frame(sf,page);f=valid(a)
        if page==63: assert all(f'gps.configuration.{sv}' in f for sv in range(1,33))
        if page==52: assert 'gps.nmct.erd.7' not in f and 'gps.nmct.erd.31' in f
    for availability in (1,2,3):
        a=frame(4,52);put(a,56,2,availability);f=valid(a);assert not any(k.startswith('gps.nmct.erd.') for k in f)
    a=frame(4,55);message=b'GPS NAV TEST 123456789';assert len(message)==22
    for i,b in enumerate(message): put(a,56+i*8,8,b)
    f=valid(a);assert f['gps.special_message']==message.decode()
    # Every one of the 300 physical bits must be rejected on single-bit corruption.
    raw=encode(frame(1))
    for word in range(10):
        for bit in range(30):
            changed=bytearray(raw);changed[word*4+bit//8]^=1<<(bit%8)
            doc,_=inspect(changed);assert doc['integrity']=='invalid',(word,bit)
    # Nonzero storage padding and malformed sizes are rejected, never treated as RF bits.
    for bad in (raw[:-1],raw+b'\0',bytes([*raw[:3],raw[3]|128,*raw[4:]])):
        result=subprocess.run([sys.argv[1],bad.hex(),'7'],capture_output=True,text=True);assert result.returncode!=0
        assert 'runtime error:' not in result.stderr and 'AddressSanitizer' not in result.stderr
    print('GPS LNAV: five subframes, 32 almanacs, UTC/health/configuration/NMCT/message fields and all 300 single-bit corruptions passed')
