// The network a cell belongs to, from its SIB1 (TS 36.331
// SystemInformationBlockType1, unaligned PER as carried on BCCH-DL-SCH): the
// PLMN identities (MCC/MNC) it broadcasts, its tracking area and cell
// identity. Same field walk as native/lte/si_schedule.c.

export interface CellNetwork {
  /** "MCC-MNC", e.g. "242-01"; the first is the primary network, others share the cell. */
  plmns: string[];
  tac: number;
  cellId: number;
}

export function sib1Network(bytes: readonly number[]): CellNetwork | undefined {
  let at = 0,
    ok = true;
  const take = (n: number) => {
    if (!ok || at + n > bytes.length * 8) {
      ok = false;
      return 0;
    }
    let v = 0;
    for (let i = 0; i < n; i++, at++) v = v * 2 + ((bytes[at >> 3] >> (7 - (at & 7))) & 1);
    return v;
  };
  const digit = () => {
    const d = take(4);
    if (d > 9) ok = false;
    return d;
  };
  if (take(2) !== 1) return; // BCCH-DL-SCH c1, systemInformationBlockType1
  take(3); // p-Max, tdd-Config and nonCriticalExtension present
  const csg = take(1),
    count = take(3) + 1;
  if (count > 6) return;
  const plmns: string[] = [];
  let mcc = '';
  for (let p = 0; p < count; p++) {
    // The MCC may be omitted after the first: it is then the previous one's.
    if (take(1)) mcc = `${digit()}${digit()}${digit()}`;
    else if (!p) return;
    const digits = take(1) + 2;
    let mnc = '';
    for (let d = 0; d < digits; d++) mnc += digit();
    take(1); // cellReservedForOperatorUse
    plmns.push(`${mcc}-${mnc}`);
  }
  const tac = take(16),
    cellId = take(28);
  void csg;
  return ok ? { plmns, tac, cellId } : undefined;
}

// Mobile country codes (ITU-T E.212) for the countries most users are in.
const countries: Record<string, string> = {
  '202': 'Greece',
  '204': 'Netherlands',
  '206': 'Belgium',
  '208': 'France',
  '214': 'Spain',
  '222': 'Italy',
  '226': 'Romania',
  '228': 'Switzerland',
  '230': 'Czechia',
  '232': 'Austria',
  '234': 'United Kingdom',
  '235': 'United Kingdom',
  '238': 'Denmark',
  '240': 'Sweden',
  '242': 'Norway',
  '244': 'Finland',
  '246': 'Lithuania',
  '247': 'Latvia',
  '248': 'Estonia',
  '260': 'Poland',
  '262': 'Germany',
  '268': 'Portugal',
  '272': 'Ireland',
  '274': 'Iceland',
  '302': 'Canada',
  '310': 'United States',
  '311': 'United States',
  '312': 'United States',
  '313': 'United States',
  '314': 'United States',
  '315': 'United States',
  '316': 'United States',
  '440': 'Japan',
  '450': 'South Korea',
  '505': 'Australia',
  '530': 'New Zealand',
};
// A small table of major networks; anything else shows its code and country.
const operators: Record<string, string> = {
  '242-01': 'Telenor',
  '242-02': 'Telia',
  '242-14': 'ice',
  '240-01': 'Telia',
  '240-02': '3',
  '240-07': 'Tele2',
  '240-08': 'Telenor',
  '238-01': 'TDC',
  '238-02': 'Telenor',
  '238-06': '3',
  '238-20': 'Telia',
  '244-05': 'Elisa',
  '244-12': 'DNA',
  '244-91': 'Telia',
  '234-10': 'O2',
  '234-15': 'Vodafone',
  '234-20': 'Three',
  '234-30': 'EE',
  '262-01': 'Telekom',
  '262-02': 'Vodafone',
  '262-03': 'O2',
  '310-260': 'T-Mobile',
  '310-410': 'AT&T',
  '311-480': 'Verizon',
};

/** "Telenor (242-01)", "Norway 242-05", or the bare code. */
export function networkName(plmn: string) {
  const name = operators[plmn];
  if (name) return `${name} (${plmn})`;
  const country = countries[plmn.split('-')[0]];
  return country ? `${country} ${plmn}` : plmn;
}
