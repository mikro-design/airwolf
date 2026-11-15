import type { Frame, ReceivedBlePhy } from './types';

export type BleDirection = 'central-to-peripheral' | 'peripheral-to-central';
type BleCaptureFrame = Pick<Frame, 'bytes' | 'channel' | 'phy' | 'rssi' | 'integrity'> & {
  bleDirection?: BleDirection;
};
export interface BleRadioPacket {
  bytes: number[];
  channel: number;
  frequency: number;
  phy: ReceivedBlePhy;
  rssi: number | null;
  bleDirection?: BleDirection;
  captureIntegrity: 'valid' | 'invalid' | 'unchecked';
  captureMic: 'valid' | 'invalid' | 'unchecked';
  auxType?: 'aux-adv' | 'aux-chain' | 'aux-sync' | 'aux-scan-response';
  warnings: string[];
}

const PHYS: ReceivedBlePhy[] = ['1m', '2m', 'coded-s2', 'coded-s8'];
export function hasBleRadioMetadata(frame: BleCaptureFrame): boolean {
  return (
    Number.isInteger(frame.channel) &&
    frame.channel! >= 0 &&
    frame.channel! <= 39 &&
    frame.phy !== undefined &&
    PHYS.includes(frame.phy)
  );
}
function rfChannel(channel: number) {
  return channel === 37
    ? 0
    : channel === 38
      ? 12
      : channel === 39
        ? 39
        : channel < 11
          ? channel + 1
          : channel + 2;
}
function logicalChannel(rf: number) {
  return rf === 0 ? 37 : rf === 12 ? 38 : rf === 39 ? 39 : rf < 12 ? rf - 1 : rf - 2;
}

// LINKTYPE_BLUETOOTH_LE_LL_WITH_PHDR (256), exactly the standard ten-octet
// header. No private initializer/event metadata is hidden in reserved fields.
export function writeBleRadioPacket(frame: BleCaptureFrame): Uint8Array<ArrayBuffer> {
  if (!hasBleRadioMetadata(frame))
    throw new Error('BLE RF capture requires a known channel and received PHY');
  if (
    !frame.bytes.length ||
    frame.bytes.length > 4096 ||
    frame.bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
  )
    throw new Error('Invalid BLE capture bytes');
  const coded = frame.phy === 'coded-s2' || frame.phy === 'coded-s8';
  if (coded && frame.bytes.length < 4)
    throw new Error('LE Coded capture is missing its access address');
  const output = new Uint8Array(10 + frame.bytes.length + (coded ? 1 : 0));
  const view = new DataView(output.buffer);
  output[0] = rfChannel(frame.channel!);
  let flags = 1 | (frame.phy === '2m' ? 0x4000 : coded ? 0x8000 : 0); // dewhitened, never claims decrypted
  if (Number.isInteger(frame.rssi) && frame.rssi! >= -128 && frame.rssi! <= 127) {
    flags |= 2;
    view.setInt8(1, frame.rssi!);
  }
  if (frame.integrity !== 'unchecked') flags |= 0x400 | (frame.integrity === 'valid' ? 0x800 : 0);
  if (frame.bleDirection === 'central-to-peripheral') flags |= 2 << 7;
  else if (frame.bleDirection === 'peripheral-to-central') flags |= 3 << 7;
  else if (frame.bleDirection !== undefined) throw new Error('Invalid BLE capture direction');
  view.setUint16(8, flags, true);
  if (coded) {
    output.set(frame.bytes.slice(0, 4), 10);
    output[14] = frame.phy === 'coded-s2' ? 1 : 0;
    output.set(frame.bytes.slice(4), 15);
  } else output.set(frame.bytes, 10);
  return output;
}

export function readBleRadioPacket(packet: Uint8Array): BleRadioPacket {
  if (packet.length < 11 || packet.length > 4107) throw new Error('Invalid BLE RF packet length');
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = view.getUint16(8, true),
    rf = packet[0],
    mode = flags >>> 14,
    type = (flags >>> 7) & 7;
  if (rf > 39 || mode === 3 || type >= 4)
    throw new Error('Unsupported BLE RF channel, PHY or isochronous PDU type');
  if (!(flags & 1)) throw new Error('Whitened BLE captures must be dewhitened before import');
  // A plaintext replacement no longer has the original on-air CRC bytes. Until
  // that provenance has a full native contract, reject rather than mischeck it.
  if (flags & 8)
    throw new Error(
      'Decrypted BLE RF captures require plaintext/CRC provenance not supported by this importer',
    );
  if (flags & 0x800 && !(flags & 0x400))
    throw new Error('BLE RF CRC valid flag requires a checked flag');
  if (type !== 1 && flags & 0x2000 && !(flags & 0x1000))
    throw new Error('BLE RF MIC valid flag requires a checked flag');
  const coded = mode === 2;
  if (coded && (packet.length < 15 || packet[14] > 1))
    throw new Error('Invalid LE Coded coding indicator');
  const bytes = coded ? [...packet.slice(10, 14), ...packet.slice(15)] : [...packet.slice(10)];
  if (!bytes.length || bytes.length > 4096) throw new Error('Invalid BLE capture bytes');
  const channel = logicalChannel(rf);
  const captureIntegrity = flags & 0x400 ? (flags & 0x800 ? 'valid' : 'invalid') : 'unchecked';
  const captureMic =
    type !== 1 && flags & 0x1000 ? (flags & 0x2000 ? 'valid' : 'invalid') : 'unchecked';
  const warnings = [];
  if (flags & 0x40)
    warnings.push(
      'Capture reports RF channel aliasing; nominal channel frequency may be ambiguous.',
    );
  if (captureIntegrity !== 'unchecked')
    warnings.push(
      `Capture reports CRC ${captureIntegrity === 'valid' ? 'correct' : 'incorrect'}; this metadata is not an independent CRC calculation.`,
    );
  if (captureMic !== 'unchecked')
    warnings.push(
      `Capture reports MIC ${captureMic === 'valid' ? 'correct' : 'incorrect'}; authentication has not been independently verified.`,
    );
  return {
    bytes,
    channel,
    frequency: 2402 + 2 * rf,
    phy: mode === 0 ? '1m' : mode === 1 ? '2m' : packet[14] === 1 ? 'coded-s2' : 'coded-s8',
    rssi: flags & 2 ? view.getInt8(1) : null,
    ...(type === 2
      ? { bleDirection: 'central-to-peripheral' as const }
      : type === 3
        ? { bleDirection: 'peripheral-to-central' as const }
        : {}),
    ...(type === 1
      ? {
          auxType: (['aux-adv', 'aux-chain', 'aux-sync', 'aux-scan-response'] as const)[
            (flags >>> 12) & 3
          ],
        }
      : {}),
    captureIntegrity,
    captureMic,
    warnings,
  };
}
