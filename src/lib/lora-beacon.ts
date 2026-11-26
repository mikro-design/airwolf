// LoRaWAN Class B beacon layout (LoRaWAN L2 1.0.4 section 13, Table 74),
// received in implicit-header mode at SF8-12. RFU, Param, Time, CRC,
// GwSpecific (InfoDesc + Info), RFU, CRC; multi-byte fields little-endian.
// Both CRCs are CRC-16 0x1021, initial value 0, MSB-first over the bytes in air
// order, sent least-significant byte first; this reproduces the
// specification's examples. CRCs detect errors; they do not authenticate.
export function beaconLayout(sf: number) {
  if (!Number.isInteger(sf) || sf < 8 || sf > 12) return undefined;
  const prefix = sf - 8,
    trailer = [3, 0, 1, 2, 3][sf - 8],
    common = prefix + 5,
    gateway = common + 2,
    gatewaySize = 7 + trailer;
  return { prefix, trailer, common, gateway, gatewaySize, length: gateway + gatewaySize + 2 };
}
export function beaconCrc(bytes: readonly number[]): number {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      value = value & 0x8000 ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
  }
  return value;
}
export function beaconCheck(bytes: readonly number[], sf: number) {
  const layout = beaconLayout(sf);
  if (!layout || bytes.length !== layout.length) return undefined;
  const stored = (at: number) => bytes[at] | (bytes[at + 1] << 8),
    end = layout.gateway + layout.gatewaySize;
  const common = {
      received: stored(layout.common),
      calculated: beaconCrc(bytes.slice(0, layout.common)),
    },
    gateway = { received: stored(end), calculated: beaconCrc(bytes.slice(layout.gateway, end)) };
  return {
    common,
    gateway,
    valid: common.received === common.calculated && gateway.received === gateway.calculated,
  };
}
