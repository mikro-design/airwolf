import type { DissectorBridge, Field, Frame, Protocol } from './types';
import { textRuns } from './text';
// The host IQ reference starts with a UUID for this native receiver process.
// captureEpoch changes on BLE retunes, so it must not break connection context.
// Frames are immutable once received and their byte arrays are shared by every
// copy of a frame, so each converts once.
const wireBytes = new WeakMap<readonly number[], Uint8Array>();
function wire(bytes: readonly number[]): Uint8Array {
  let out = wireBytes.get(bytes);
  if (!out) wireBytes.set(bytes, (out = Uint8Array.from(bytes)));
  return out;
}
// ESB has no Wireshark dissector: its inspection is the TypeScript decode alone.
export const nativeDissection = (protocol: Protocol) => protocol !== 'esb';
export function dissectionRequest(
  frames: readonly Frame[],
  target: Frame,
  retainedEvidence?: Frame,
): Parameters<DissectorBridge['decode']>[0] {
  const isWpan = (frame: Frame) => frame.protocol === 'zigbee' || frame.protocol === '15p4';
  const session = (frame: Frame) => frame.iqRef?.split(':')[0];
  const available =
    retainedEvidence &&
    !frames.some((f) => f.id === retainedEvidence.id && f.iqRef === retainedEvidence.iqRef)
      ? [retainedEvidence, ...frames]
      : frames;
  if (!nativeDissection(target.protocol))
    throw new Error('This protocol has no native dissector; its fields are decoded here.');
  if (!target.bytes.length) throw new Error('This frame has no bytes to decode.');
  const context = available.filter(
    (frame) =>
      // An empty record (valid in PCAP) gives no context and the worker rejects it.
      frame.bytes.length > 0 &&
      (frame.protocol === target.protocol || (isWpan(frame) && isWpan(target))) &&
      frame.hasFcs === target.hasFcs &&
      frame.origin === target.origin &&
      session(frame) === session(target) &&
      (!target.protocol.startsWith('enocean') || frame.captureEpoch === target.captureEpoch) &&
      (!isWpan(target) ||
        (frame.frequency === target.frequency &&
          frame.channel === target.channel &&
          frame.captureEpoch === target.captureEpoch)) &&
      frame.deviceSerial === target.deviceSerial,
  );
  const selected = context.indexOf(target);
  if (selected < 0) throw new Error('The selected frame is no longer in this capture.');
  return {
    frames: context.map(
      ({
        protocol,
        hasFcs,
        bytes,
        time,
        channel,
        frequency,
        phy,
        bleDirection,
        bleAuxType,
        bleRole,
        periodicEvent,
        timeUncertaintyUs,
        crcInit,
        connectionEvent,
        captureEpoch,
        deviceSerial,
        gpsPrn,
        lteChannel,
        lora,
      }) => ({
        protocol,
        hasFcs,
        bytes: wire(bytes),
        time,
        channel,
        frequency,
        phy,
        bleDirection,
        bleAuxType,
        bleRole,
        periodicEvent,
        timeUncertaintyUs,
        crcInit,
        connectionEvent,
        captureEpoch,
        deviceSerial,
        gpsPrn,
        lteChannel,
        lora,
      }),
    ),
    selected,
  };
}
export function flattenFields(fields: Field[]): Field[] {
  return fields.flatMap((field) => [field, ...flattenFields(field.children ?? [])]);
}
export function inspectedFrame(frame: Frame): Frame {
  const decoded = frame.dissection;
  if (!decoded) return frame;
  const warnings = [...decoded.warnings];
  const withText = (field: Field): Field => ({
    ...field,
    ...(field.mapped && field.filter === 'btatt.value'
      ? {
          text: textRuns(
            frame.bytes.slice(field.offset, field.offset + field.length),
            field.offset,
          ),
        }
      : {}),
    ...(field.children ? { children: field.children.map(withText) } : {}),
  });
  let fields = [
    ...decoded.fields.map(withText),
    ...frame.fields.filter((field) => field.id === 'capture-crc' || field.id === 'capture-mic'),
  ];
  warnings.push(...frame.warnings.filter((warning) => warning.startsWith('Capture ')));
  if (frame.protocol === 'ble' && frame.bytes.slice(0, 4).join(',') !== '214,190,137,142') {
    warnings.push(...frame.warnings);
    if (!decoded.integrity && frame.checksum) {
      for (let i = 0; i < warnings.length; i++)
        if (/CRC unchecked/i.test(warnings[i])) warnings[i] = `Packet decoder: ${warnings[i]}`;
      warnings.push(
        `Receiver CRC ${frame.integrity === 'valid' ? 'correct' : 'incorrect'} · ${frame.checksum.algorithm}.`,
      );
      fields = [
        ...fields,
        {
          id: 'receiver-crc',
          name:
            frame.bleRole === 'periodic-advertising'
              ? 'Periodic advertising CRC check'
              : 'Connection CRC check',
          value: `CRC ${frame.integrity === 'valid' ? 'correct' : 'incorrect'} · received ${frame.checksum.received} · calculated ${frame.checksum.calculated} · ${frame.checksum.algorithm}`,
          offset: frame.bytes.length - 3,
          length: 3,
          layer: 'check',
          mapped: true,
        },
      ];
    }
  }
  if (frame.integrity !== 'unchecked' && decoded.integrity && frame.integrity !== decoded.integrity)
    warnings.push(
      `Integrity disagreement: receiver ${frame.integrity}, packet decoder ${decoded.integrity}.`,
    );
  return {
    ...frame,
    fields,
    summary: decoded.summary,
    warnings: [...new Set(warnings)],
    integrity: decoded.integrity ?? frame.integrity,
  };
}
