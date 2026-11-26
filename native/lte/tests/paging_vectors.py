# SPDX-License-Identifier: AGPL-3.0-or-later
"""Independent TS36.331 unaligned-PER payloads; no srsRAN encoder imports."""
def packed(bits):
    return int(bits.ljust((len(bits)+7)//8*8,'0'),2).to_bytes((len(bits)+7)//8,'big')

def stmsi_record(mmec=0x12, mtmsi=0x3456789a, cs=False):
    # PagingRecord extension absent, root identity/s-TMSI, two fixed bitstrings.
    return '000'+f'{mmec:08b}{mtmsi:032b}'+str(int(cs))

def imsi_record(digits='001010123456789', cs=True):
    assert 6<=len(digits)<=21 and digits.isdecimal()
    return '001'+f'{len(digits)-6:04b}'+''.join(f'{int(d):04b}' for d in digits)+str(int(cs))

def paging(records=(), modification=False, etws=False):
    bits='0'+str(int(bool(records)))+str(int(modification))+str(int(etws))+'0'
    if records:
        assert 1<=len(records)<=16
        bits+=f'{len(records)-1:04b}'+''.join(records)
    return packed(bits)

STMSI=paging([stmsi_record()])
assert STMSI.hex()=='400123456789a0'
VECTORS={'stmsi':STMSI,'imsi':paging([imsi_record()]),'empty':paging(),
         'modification':paging(modification=True),'etws':paging(etws=True),
         'multiple':paging([stmsi_record(),imsi_record()],modification=True,etws=True)}

def sib1(tdd=False, special=7, assignment=2, v1130=None):
    # Test network001/01; one rf16 SI schedule/ms40 window. The optional TDD
    # fields are needed to derive DwPTS rather than trusting an external hint.
    bits=''
    def put(n,v):
        nonlocal bits;bits+=f'{v:0{n}b}'
    put(2,1);put(1,0);put(1,tdd);put(1,v1130 is not None);put(1,0);put(3,0)
    put(1,1);put(4,0);put(4,0);put(4,1);put(1,0);put(4,0);put(4,1);put(1,1)
    put(16,1);put(28,0x1a2d401);put(3,4);put(1,0);put(6,0);put(6,6)
    put(5,0);put(3,1);put(5,0)
    if tdd:put(3,assignment);put(4,special)
    put(3,6);put(5,8)
    if v1130 is not None:
        # TS36.331 v890 (no late extension) -> v920 (empty) -> v1130 with
        # tdd-Config-v1130 only: specialSubframePatterns-v1130 ssp7/ssp9.
        put(1,0);put(1,1);put(3,1);put(3,4);put(1,v1130==9)
    return packed(bits)
