// Frequency allocations from 1 MHz to 6 GHz, to name what a detected emission
// most likely is when no decoder can confirm it. An allocation says which
// services may use a band, not which one is on the air: every match is a
// "likely" label, never a confirmation. Ranges follow the ITU Radio
// Regulations (Region 1 unless marked) and the common European (CEPT/ERC
// 70-03) and US (FCC) channelisations; regional entries carry the region.
// MHz: [low, high, label, service]
export type Service =
  | 'broadcast'
  | 'cellular'
  | 'wlan'
  | 'ism'
  | 'aviation'
  | 'maritime'
  | 'satellite'
  | 'navigation'
  | 'amateur'
  | 'land-mobile'
  | 'radar'
  | 'other';
export interface Allocation {
  low: number;
  high: number;
  label: string;
  service: Service;
  region?: 'EU' | 'US';
}

const a = (
  low: number,
  high: number,
  label: string,
  service: Service,
  region?: 'EU' | 'US',
): Allocation => ({ low, high, label, service, region });

export const allocations: Allocation[] = [
  // HF
  a(0.5265, 1.6065, 'AM broadcast (MW)', 'broadcast', 'EU'),
  a(0.53, 1.71, 'AM broadcast (MW)', 'broadcast', 'US'),
  a(1.81, 2, 'Amateur 160 m', 'amateur'),
  a(3.5, 3.8, 'Amateur 80 m', 'amateur'),
  a(3.9, 4, 'Shortwave broadcast 75 m', 'broadcast'),
  a(4.75, 5.06, 'Shortwave broadcast 60 m', 'broadcast'),
  a(5.9, 6.2, 'Shortwave broadcast 49 m', 'broadcast'),
  a(6.765, 6.795, 'ISM 6.78 MHz', 'ism'),
  a(7, 7.2, 'Amateur 40 m', 'amateur'),
  a(7.2, 7.45, 'Shortwave broadcast 41 m', 'broadcast'),
  a(9.4, 9.9, 'Shortwave broadcast 31 m', 'broadcast'),
  a(10.1, 10.15, 'Amateur 30 m', 'amateur'),
  a(11.6, 12.1, 'Shortwave broadcast 25 m', 'broadcast'),
  a(13.553, 13.567, 'ISM 13.56 MHz · NFC / RFID', 'ism'),
  a(13.57, 13.87, 'Shortwave broadcast 22 m', 'broadcast'),
  a(14, 14.35, 'Amateur 20 m', 'amateur'),
  a(15.1, 15.8, 'Shortwave broadcast 19 m', 'broadcast'),
  a(17.48, 17.9, 'Shortwave broadcast 16 m', 'broadcast'),
  a(18.068, 18.168, 'Amateur 17 m', 'amateur'),
  a(21, 21.45, 'Amateur 15 m', 'amateur'),
  a(21.45, 21.85, 'Shortwave broadcast 13 m', 'broadcast'),
  a(24.89, 24.99, 'Amateur 12 m', 'amateur'),
  a(25.67, 26.1, 'Shortwave broadcast 11 m', 'broadcast'),
  a(26.957, 27.283, 'ISM 27 MHz', 'ism'),
  a(26.965, 27.405, 'CB radio', 'land-mobile'),
  a(28, 29.7, 'Amateur 10 m', 'amateur'),
  // VHF
  a(40.66, 40.7, 'ISM 40.68 MHz', 'ism'),
  a(50, 52, 'Amateur 6 m', 'amateur', 'EU'),
  a(50, 54, 'Amateur 6 m', 'amateur', 'US'),
  a(87.5, 108, 'FM broadcast', 'broadcast'),
  a(108, 117.975, 'Aeronautical navigation (VOR / ILS)', 'aviation'),
  a(118, 137, 'Airband voice (AM)', 'aviation'),
  a(137, 138, 'Weather satellites (NOAA / Meteor)', 'satellite'),
  a(144, 146, 'Amateur 2 m', 'amateur', 'EU'),
  a(144, 148, 'Amateur 2 m', 'amateur', 'US'),
  a(146, 174, 'VHF land mobile (PMR, business, rail)', 'land-mobile'),
  a(156, 162.025, 'Maritime VHF', 'maritime'),
  a(161.95, 162.05, 'AIS ship tracking', 'maritime'),
  a(162.4, 162.55, 'NOAA weather radio', 'broadcast', 'US'),
  a(169.4, 169.475, 'SRD 169 MHz · metering / paging', 'ism', 'EU'),
  a(174, 240, 'DAB digital radio / TV band III', 'broadcast', 'EU'),
  a(174, 216, 'TV band III', 'broadcast', 'US'),
  a(225, 400, 'Military aviation UHF', 'aviation'),
  a(380, 400, 'TETRA emergency services', 'land-mobile', 'EU'),
  a(400.15, 406, 'Radiosondes (weather balloons)', 'other'),
  a(406, 406.1, 'COSPAS-SARSAT distress beacons', 'satellite'),
  a(410, 430, 'TETRA / UHF land mobile', 'land-mobile', 'EU'),
  a(430, 440, 'Amateur 70 cm', 'amateur'),
  a(433.05, 434.79, 'ISM 433 MHz · remotes, sensors, LoRa', 'ism', 'EU'),
  a(446, 446.2, 'PMR446 walkie-talkies', 'land-mobile', 'EU'),
  a(440, 470, 'UHF land mobile', 'land-mobile'),
  a(462.55, 467.725, 'FRS / GMRS walkie-talkies', 'land-mobile', 'US'),
  a(470, 694, 'TV broadcast (DVB-T)', 'broadcast', 'EU'),
  a(470, 608, 'TV broadcast (ATSC)', 'broadcast', 'US'),
  a(617, 652, 'Cellular 600 MHz downlink (n71)', 'cellular', 'US'),
  a(663, 698, 'Cellular 600 MHz uplink (n71)', 'cellular', 'US'),
  a(703, 748, 'Cellular 700 MHz uplink (B28)', 'cellular', 'EU'),
  a(758, 803, 'Cellular 700 MHz downlink (B28)', 'cellular', 'EU'),
  a(699, 716, 'Cellular 700 MHz uplink (B12)', 'cellular', 'US'),
  a(729, 746, 'Cellular 700 MHz downlink (B12)', 'cellular', 'US'),
  a(746, 756, 'Cellular 700 MHz downlink (B13)', 'cellular', 'US'),
  a(777, 787, 'Cellular 700 MHz uplink (B13)', 'cellular', 'US'),
  a(791, 821, 'Cellular 800 MHz downlink (B20)', 'cellular', 'EU'),
  a(832, 862, 'Cellular 800 MHz uplink (B20)', 'cellular', 'EU'),
  a(824, 849, 'Cellular 850 MHz uplink (B5)', 'cellular', 'US'),
  a(869, 894, 'Cellular 850 MHz downlink (B5)', 'cellular', 'US'),
  a(863, 870, 'SRD 868 MHz · LoRa, Sigfox, Z-Wave, wM-Bus, alarms', 'ism', 'EU'),
  a(880, 915, 'GSM / LTE 900 uplink (B8)', 'cellular', 'EU'),
  a(925, 960, 'GSM / LTE 900 downlink (B8)', 'cellular', 'EU'),
  a(902, 928, 'ISM 915 MHz · LoRa, Z-Wave, meters, RFID', 'ism', 'US'),
  a(960, 1215, 'Aeronautical navigation (DME / TACAN)', 'aviation'),
  a(1029, 1031, 'Secondary radar interrogation (1030 MHz)', 'aviation'),
  a(1089, 1091, 'ADS-B / Mode S (1090 MHz)', 'aviation'),
  a(1164, 1215, 'GNSS L5 / E5', 'navigation'),
  a(1215, 1300, 'GNSS L2 / E6 · long-range radar', 'navigation'),
  a(1240, 1300, 'Amateur 23 cm', 'amateur'),
  a(1427, 1518, 'Cellular L-band downlink (B32 / n75)', 'cellular', 'EU'),
  a(1525, 1559, 'Mobile satellite downlink (Inmarsat)', 'satellite'),
  a(1559, 1610, 'GNSS L1 / E1 · GPS, Galileo, GLONASS, BeiDou', 'navigation'),
  a(1610, 1626.5, 'Satellite phones (Iridium / Globalstar)', 'satellite'),
  a(1710, 1785, 'GSM / LTE 1800 uplink (B3)', 'cellular', 'EU'),
  a(1805, 1880, 'GSM / LTE 1800 downlink (B3)', 'cellular', 'EU'),
  a(1850, 1915, 'Cellular PCS uplink (B2 / B25)', 'cellular', 'US'),
  a(1930, 1995, 'Cellular PCS downlink (B2 / B25)', 'cellular', 'US'),
  a(1880, 1900, 'DECT cordless phones', 'land-mobile', 'EU'),
  a(1920, 1930, 'DECT 6.0 cordless phones', 'land-mobile', 'US'),
  a(1920, 1980, 'UMTS / LTE 2100 uplink (B1)', 'cellular', 'EU'),
  a(2110, 2170, 'UMTS / LTE 2100 downlink (B1)', 'cellular', 'EU'),
  a(1710, 1780, 'Cellular AWS uplink (B4 / B66)', 'cellular', 'US'),
  a(2110, 2200, 'Cellular AWS downlink (B4 / B66)', 'cellular', 'US'),
  a(2300, 2400, 'LTE 2300 TDD (B40)', 'cellular'),
  a(2400, 2483.5, 'ISM 2.4 GHz · Wi-Fi, Bluetooth, Zigbee, microwave ovens', 'ism'),
  a(2483.5, 2500, 'Globalstar satellite downlink', 'satellite'),
  a(2500, 2690, 'Cellular 2600 (B7 / B38 / B41)', 'cellular'),
  a(2700, 2900, 'Air traffic control radar (S-band)', 'radar'),
  a(2900, 3100, 'Maritime radar (S-band)', 'radar'),
  a(3300, 3800, '5G NR 3.5 GHz (n78)', 'cellular', 'EU'),
  a(3550, 3700, 'CBRS (n48)', 'cellular', 'US'),
  a(3700, 3980, '5G NR C-band (n77)', 'cellular', 'US'),
  a(3800, 4200, 'Satellite C-band downlink', 'satellite'),
  a(4200, 4400, 'Aircraft radio altimeters', 'aviation'),
  a(4400, 5000, '5G NR 4.7 GHz (n79) / military', 'cellular'),
  a(5030, 5091, 'Aeronautical MLS / drone control', 'aviation'),
  a(5150, 5350, 'Wi-Fi 5 GHz (U-NII-1/2)', 'wlan'),
  a(5470, 5725, 'Wi-Fi 5 GHz (U-NII-2C)', 'wlan'),
  a(5600, 5650, 'Weather radar (C-band)', 'radar'),
  a(5725, 5875, 'ISM 5.8 GHz · Wi-Fi (U-NII-3), FPV video', 'ism'),
  a(5795, 5815, 'CEN DSRC road tolling', 'other', 'EU'),
  a(5855, 5925, 'ITS vehicle-to-vehicle (V2X)', 'other'),
  a(5925, 6425, 'Wi-Fi 6E (6 GHz)', 'wlan'),
];

/** Allocations that contain the emission's center in the region's band plan,
 * narrowest first (the more specific use), at most `limit`. */
export type Region = 'EU' | 'US';
export function likelyUses(centerHz: number, region: Region, limit = 2): Allocation[] {
  const mhz = centerHz / 1e6;
  return allocations
    .filter((x) => mhz >= x.low && mhz < x.high && (!x.region || x.region === region))
    .sort((x, y) => x.high - x.low - (y.high - y.low))
    .slice(0, limit);
}
