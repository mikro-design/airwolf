from sweep import run
from concurrent.futures import ThreadPoolExecutor
def table(title,proto,phy,ch,ebs,cfos,rates=(8e6,10e6,16e6,20e6),npk=100,**kw):
    print(f"\n== {title}: packet success rate ({npk} packets, random fractional timing) ==",flush=True)
    jobs=[(r,c,e) for r in rates for c in cfos for e in ebs]
    with ThreadPoolExecutor(8) as ex:
        res=list(ex.map(lambda j: run(proto,int(j[0]),phy,j[1],j[2],npk=npk,channel=ch,seed=5,**kw), jobs))
    it=iter(res)
    print("rate  cfo(kHz) | "+" ".join(f"{str(e):>5}dB" for e in ebs)+"   (Eb/N0)")
    for r in rates:
        for c in cfos:
            row=[next(it) for _ in ebs]
            print(f"{int(r/1e6):2d}M  {c/1e3:+7.0f}  | "+" ".join(f"{x[0]*100:6.0f}%" for x in row)+f"   extra={sum(x[1] for x in row)}",flush=True)
if __name__=="__main__":
    table("BLE LE 1M advertising ch37","ble","1m",37,[10,12,14,16,18,22],[0,50e3,-100e3,150e3])
    table("BLE LE 2M data ch16","ble","2m",16,[10,12,14,16,18,22],[0,100e3,-200e3])
    table("802.15.4 O-QPSK ch15","15p4","1m",None,[2,4,6,8,10,14],[0,100e3,-200e3])
