import type { Frame, NativePacket } from './types';
import { decode } from './decoder';
import { EnOceanProfileContext } from './enocean-profile';
export function iqFrames(packets: readonly NativePacket[]): Frame[] {
  const profiles = new EnOceanProfileContext();
  return packets.map((packet, i) => profiles.apply(iqFrame(packet, i + 1)));
}
export function iqFrame(packet: NativePacket, id: number): Frame {
  const frame = decode(packet.bytes, packet.protocol, {
    id,
    time: packet.time / 1000,
    channel: packet.channel,
    origin: 'live',
    crcInit: packet.crcInit,
    lteChannel: packet.lteChannel,
  });
  return {
    ...frame,
    captureContext: packet.captureContext,
    warnings:
      packet.captureContext === 'matched-observation'
        ? [
            ...frame.warnings,
            'Receive context restored from matching capture metadata; PHY and CRC were decoded from this IQ selection.',
          ]
        : frame.warnings,
    iqRef: packet.iqRef,
    firstSample: packet.firstSample,
    endSample: packet.endSample,
    phy: packet.phy,
    bleDirection: packet.bleDirection,
    bleAuxType: packet.bleAuxType,
    wifiRateMbps: packet.wifiRateMbps,
    ltePci: packet.ltePci,
    ltePrb: packet.ltePrb,
    lteSfn: packet.lteSfn,
    ltePorts: packet.ltePorts,
    lteTdd: packet.lteTdd,
    lteChannel: packet.lteChannel,
    lteSubframe: packet.lteSubframe,
    lteMcs: packet.lteMcs,
    lteRv: packet.lteRv,
    lteContext: packet.lteContext,
    timeUncertaintyUs: packet.timeUncertaintyUs,
    fecErrors: packet.fecErrors,
    deviceSerial: packet.deviceSerial,
    captureEpoch: packet.captureEpoch,
    connectionEvent: packet.connectionEvent,
    id,
    time: packet.time / 1000,
    frequency: packet.frequencyHz / 1e6,
    integrity: packet.integrity ?? frame.integrity,
    ...(packet.protocol === 'lte'
      ? {
          source: `PCI ${packet.ltePci}`,
          summary: `${frame.type} · PCI ${packet.ltePci} · ${packet.ltePrb} PRB · SFN ${packet.lteSfn}`,
        }
      : {}),
  };
}
export function iqLane(frame: Frame): string {
  if (frame.integrity === 'invalid') return 'Failed candidates';
  if (!frame.source || ['—', 'Unknown', 'unknown', 'N/A'].includes(frame.source))
    return 'Unattributed frames';
  return frame.source;
}

// Non-HT OFDM timing follows the receiver's verified L-SIG rate/length.
// DATA bytes are coded/interleaved; this is deliberately not a byte-to-IQ map.
export function iqPhySections(frame: Frame, rate: number) {
  if (
    frame.protocol !== 'wifi' ||
    !frame.wifiRateMbps ||
    frame.firstSample === undefined ||
    frame.endSample === undefined
  )
    return [];
  const first = frame.firstSample;
  const symbols = Math.ceil((16 + frame.bytes.length * 8 + 6) / (frame.wifiRateMbps * 4));
  return [
    { label: 'Preamble', first, end: first + Math.round(rate * 16e-6) },
    {
      label: 'L-SIG',
      first: first + Math.round(rate * 16e-6),
      end: first + Math.round(rate * 20e-6),
    },
    {
      label: `DATA · ${symbols} symbols`,
      first: first + Math.round(rate * 20e-6),
      end: Math.min(frame.endSample, first + Math.round(rate * (20 + symbols * 4) * 1e-6)),
    },
  ];
}
