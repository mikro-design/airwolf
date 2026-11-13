// Receive-only channel plans. Regional availability does not imply TX permission.
// LTE: 3GPP TS 36.101 §5.7.3, table 5.7.3-1 (Release 17).
// https://www.etsi.org/deliver/etsi_ts/136100_136199/136101/17.11.00_60/ts_136101v171100p.pdf
// Wi-Fi: IEEE 802.11 global operating classes (20 MHz channel centers).
export interface ChannelGuide {
  label: string;
  spacingMHz: number;
  deviationKHz: number | null;
  bandwidth?: boolean;
}
export interface WifiChannel {
  value: string;
  band: string;
  channel: number;
  frequency: number;
  bandwidth: number;
}
export const wifiChannels: WifiChannel[] = [
  ...Array.from({ length: 14 }, (_, i) => ({
    value: `2.4-${i + 1}`,
    band: '2.4 GHz',
    channel: i + 1,
    frequency: i === 13 ? 2484 : 2412 + 5 * i,
    bandwidth: i === 13 ? 22 : 20,
  })),
  ...[
    36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149,
    153, 157, 161, 165, 169, 173, 177,
  ].map((channel) => ({
    value: `5-${channel}`,
    band: '5 GHz',
    channel,
    frequency: 5000 + 5 * channel,
    bandwidth: 20,
  })),
  // Only 6 GHz centers within HackRF's 6 GHz tuning ceiling. Channel 2 is
  // the separate 5935 MHz operating class; ordinary centers use 5950+5*k.
  ...[2, 1, 5, 9].map((channel) => ({
    value: `6-${channel}`,
    band: '6 GHz',
    channel,
    frequency: channel === 2 ? 5935 : 5950 + 5 * channel,
    bandwidth: 20,
  })),
];
type Range = readonly [lowMHz: number, first: number, last: number];
export interface LteBand {
  band: number;
  duplex: 'FDD' | 'TDD' | 'SDL';
  downlink: Range;
  uplink?: Range;
}
const fdd = (band: number, downlink: Range, uplink: Range): LteBand => ({
  band,
  duplex: 'FDD',
  downlink,
  uplink,
});
const tdd = (band: number, range: Range): LteBand => ({
  band,
  duplex: 'TDD',
  downlink: range,
  uplink: range,
});
const sdl = (band: number, range: Range): LteBand => ({ band, duplex: 'SDL', downlink: range });
export const lteBands: LteBand[] = [
  fdd(1, [2110, 0, 599], [1920, 18000, 18599]),
  fdd(2, [1930, 600, 1199], [1850, 18600, 19199]),
  fdd(3, [1805, 1200, 1949], [1710, 19200, 19949]),
  fdd(4, [2110, 1950, 2399], [1710, 19950, 20399]),
  fdd(5, [869, 2400, 2649], [824, 20400, 20649]),
  fdd(6, [875, 2650, 2749], [830, 20650, 20749]),
  fdd(7, [2620, 2750, 3449], [2500, 20750, 21449]),
  fdd(8, [925, 3450, 3799], [880, 21450, 21799]),
  fdd(9, [1844.9, 3800, 4149], [1749.9, 21800, 22149]),
  fdd(10, [2110, 4150, 4749], [1710, 22150, 22749]),
  fdd(11, [1475.9, 4750, 4949], [1427.9, 22750, 22949]),
  fdd(12, [729, 5010, 5179], [699, 23010, 23179]),
  fdd(13, [746, 5180, 5279], [777, 23180, 23279]),
  fdd(14, [758, 5280, 5379], [788, 23280, 23379]),
  fdd(17, [734, 5730, 5849], [704, 23730, 23849]),
  fdd(18, [860, 5850, 5999], [815, 23850, 23999]),
  fdd(19, [875, 6000, 6149], [830, 24000, 24149]),
  fdd(20, [791, 6150, 6449], [832, 24150, 24449]),
  fdd(21, [1495.9, 6450, 6599], [1447.9, 24450, 24599]),
  fdd(22, [3510, 6600, 7399], [3410, 24600, 25399]),
  fdd(23, [2180, 7500, 7699], [2000, 25500, 25699]),
  fdd(24, [1525, 7700, 8039], [1626.5, 25700, 26039]),
  fdd(25, [1930, 8040, 8689], [1850, 26040, 26689]),
  fdd(26, [859, 8690, 9039], [814, 26690, 27039]),
  fdd(27, [852, 9040, 9209], [807, 27040, 27209]),
  fdd(28, [758, 9210, 9659], [703, 27210, 27659]),
  sdl(29, [717, 9660, 9769]),
  fdd(30, [2350, 9770, 9869], [2305, 27660, 27759]),
  fdd(31, [462.5, 9870, 9919], [452.5, 27760, 27809]),
  sdl(32, [1452, 9920, 10359]),
  tdd(33, [1900, 36000, 36199]),
  tdd(34, [2010, 36200, 36349]),
  tdd(35, [1850, 36350, 36949]),
  tdd(36, [1930, 36950, 37549]),
  tdd(37, [1910, 37550, 37749]),
  tdd(38, [2570, 37750, 38249]),
  tdd(39, [1880, 38250, 38649]),
  tdd(40, [2300, 38650, 39649]),
  tdd(41, [2496, 39650, 41589]),
  tdd(42, [3400, 41590, 43589]),
  tdd(43, [3600, 43590, 45589]),
  tdd(44, [703, 45590, 46589]),
  tdd(45, [1447, 46590, 46789]),
  tdd(46, [5150, 46790, 54539]),
  tdd(47, [5855, 54540, 55239]),
  tdd(48, [3550, 55240, 56739]),
  tdd(49, [3550, 56740, 58239]),
  tdd(50, [1432, 58240, 59089]),
  tdd(51, [1427, 59090, 59139]),
  tdd(52, [3300, 59140, 60139]),
  tdd(53, [2483.5, 60140, 60254]),
  fdd(65, [2110, 65536, 66435], [1920, 131072, 131971]),
  fdd(66, [2110, 66436, 67335], [1710, 131972, 132671]),
  sdl(67, [738, 67336, 67535]),
  fdd(68, [753, 67536, 67835], [698, 132672, 132971]),
  sdl(69, [2570, 67836, 68335]),
  fdd(70, [1995, 68336, 68585], [1695, 132972, 133121]),
  fdd(71, [617, 68586, 68935], [663, 133122, 133471]),
  fdd(72, [461, 68936, 68985], [451, 133472, 133521]),
  fdd(73, [460, 68986, 69035], [450, 133522, 133571]),
  fdd(74, [1475, 69036, 69465], [1427, 133572, 134001]),
  sdl(75, [1432, 69466, 70315]),
  sdl(76, [1427, 70316, 70365]),
  fdd(85, [728, 70366, 70545], [698, 134002, 134181]),
  fdd(87, [420, 70546, 70595], [410, 134182, 134231]),
  fdd(88, [422, 70596, 70645], [412, 134232, 134281]),
];
export function lteFrequency(range: Range, earfcn: number): number | null {
  if (!Number.isInteger(earfcn) || earfcn < range[1] || earfcn > range[2]) return null;
  return Math.round((range[0] + (earfcn - range[1]) / 10) * 1000) / 1000;
}
export function lteEarfcn(range: Range, frequency: number): number | null {
  const n = range[1] + Math.round((frequency - range[0]) * 10);
  const expected = lteFrequency(range, n);
  return expected !== null && Math.abs(expected - frequency) < 0.000001 ? n : null;
}
