import type { Field, Frame } from './types';
import { textRuns } from './text';
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
  let fields = decoded.fields.map(withText);
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
          name: 'Connection CRC check',
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
    warnings,
    integrity: decoded.integrity ?? frame.integrity,
  };
}
