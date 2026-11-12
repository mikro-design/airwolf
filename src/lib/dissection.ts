import type { Field, Frame } from './types';
export function flattenFields(fields: Field[]): Field[] {
  return fields.flatMap((field) => [field, ...flattenFields(field.children ?? [])]);
}
export function inspectedFrame(frame: Frame, wireshark: boolean): Frame {
  const decoded = wireshark && frame.dissection;
  if (!decoded) return frame;
  const warnings = [...decoded.warnings];
  let fields = decoded.fields;
  if (frame.protocol === 'ble' && frame.bytes.slice(0, 4).join(',') !== '214,190,137,142') {
    warnings.push(...frame.warnings);
    if (!decoded.integrity && frame.checksum) {
      for (let i = 0; i < warnings.length; i++)
        if (/CRC unchecked/i.test(warnings[i])) warnings[i] = `Wireshark: ${warnings[i]}`;
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
      `Integrity disagreement: built-in ${frame.integrity}, Wireshark ${decoded.integrity}.`,
    );
  return {
    ...frame,
    fields,
    summary: decoded.summary,
    warnings,
    integrity: decoded.integrity ?? frame.integrity,
  };
}
