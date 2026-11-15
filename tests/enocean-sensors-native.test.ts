import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { flattenFields } from '../src/lib/dissection';
import { EnOceanProfileContext } from '../src/lib/enocean-profile';
import type { Dissection } from '../src/lib/types';
const { createDissector } = createRequire(import.meta.url)('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
});
// Polynomial division independent of production ERP CRC helpers.
function crc8(bytes: number[]) {
  let value = 0;
  for (const byte of [...bytes, 0])
    for (let bit = 7; bit >= 0; bit--) {
      value = (value << 1) | ((byte >>> bit) & 1);
      if (value & 256) value ^= 0x107;
    }
  return value;
}
function packet(data: number[], erp2: boolean, time: number) {
  const body = erp2 ? [0x22, 1, 2, 3, 4, ...data] : [0xa5, ...data, 1, 2, 3, 4, 0];
  const bytes = erp2
    ? [body.length + 1, ...body, crc8(body)]
    : [...body, body.reduce((a, b) => a + b, 0) & 255];
  return {
    protocol: erp2 ? ('enocean2' as const) : ('enocean' as const),
    frequency: erp2 ? 902.875 : 868.3,
    time,
    bytes,
  };
}
function session() {
  const worker = createDissector();
  workers.push(worker);
  return async (func: number, type: number, data: number[], erp2 = false) => {
    const teach = packet([(func << 2) | (type >>> 5), (type << 3) & 255, 11, 0x80], erp2, 1);
    const selected = packet(data, erp2, 2);
    const result: Dissection = await worker.dissect({ frames: [teach, selected], selected: 1 });
    expect(result.integrity).toBe('valid');
    expect(result.warnings.join(' ')).not.toMatch(/not implemented|absent|malformed/i);
    const fields = flattenFields(result.fields);
    for (const field of fields)
      if (field.mapped)
        expect(field.offset + field.length).toBeLessThanOrEqual(selected.bytes.length);
    expect(fields.find((f) => f.filter === 'enocean.eep.context')?.value).toContain(
      'sender not authenticated',
    );
    const context = new EnOceanProfileContext();
    context.apply({
      ...decode(teach.bytes, teach.protocol, { id: 1, time: 1 }),
      frequency: teach.frequency,
    });
    const summary = context.apply({
      ...decode(selected.bytes, selected.protocol, { id: 2, time: 2 }),
      frequency: selected.frequency,
    });
    for (const field of fields.filter((f) => f.filter?.startsWith('enocean.eep.') && f.mapped)) {
      const id = field.filter!.replace('enocean.eep.', 'eep-').replaceAll('_', '-');
      expect(
        summary.fields.find((f) => f.id === id),
        field.filter,
      ).toMatchObject({ value: field.value, offset: field.offset, length: field.length });
    }
    return (name: string) => fields.find((f) => f.filter === `enocean.eep.${name}`);
  };
}
const physical = (value: number, unit: string, raw: number) =>
  `${Number(value.toFixed(2))} ${unit} · raw ${raw}`;
describe('native EnOcean light and occupancy profiles from explicit teach-in', () => {
  test('light range selector chooses the declared byte and scale at both endpoints', async () => {
    const inspect = session();
    for (const erp2 of [false, true])
      for (const type of [1, 2, 5])
        for (const low of [false, true])
          for (const raw of [0, 127, 255]) {
            const data = [125, 17, 99, 8 | Number(low)];
            const index = low ? 1 : 2;
            data[index] = raw;
            const fields = await inspect(6, type, data, erp2);
            const minimum = type === 1 ? (low ? 300 : 600) : 0;
            const maximum =
              type === 1
                ? low
                  ? 30000
                  : 60000
                : type === 2
                  ? low
                    ? 510
                    : 1020
                  : low
                    ? 5100
                    : 10200;
            expect(fields('illumination')).toMatchObject({
              value: physical(minimum + (raw * (maximum - minimum)) / 255, 'lx', raw),
              offset: (erp2 ? 6 : 1) + index,
              length: 1,
            });
            expect(fields('illumination_range')?.value).toBe(
              low ? 'DB2 (lower range)' : 'DB1 (upper range)',
            );
            expect(fields('supply_voltage')?.value).toBe('2.5 V · raw 125');
          }
  });
  test('ten-bit light values span DB2 and the high bits of DB1, with over-range separate from reserved', async () => {
    const inspect = session();
    for (const erp2 of [false, true])
      for (const func of [6, 7])
        for (const raw of [0, 1, 255, 256, 999, 1000, 1001, 1002, 1023]) {
          const fields = await inspect(func, 3, [250, raw >>> 2, (raw & 3) << 6, 8], erp2);
          const expected =
            raw <= 1000
              ? physical(raw, 'lx', raw)
              : raw === 1001
                ? 'Over range (>1000 lx) · raw 1001'
                : `Reserved raw value ${raw}; illumination unavailable`;
          expect(fields('illumination')).toMatchObject({
            value: expected,
            offset: erp2 ? 7 : 2,
            length: 2,
          });
          expect(fields('supply_voltage')?.value).toBe('5 V · raw 250');
        }
  });
  test('supply voltage error codes and optional availability cannot become physical readings', async () => {
    const inspect = session();
    for (const raw of [251, 252, 253, 254, 255])
      for (const [func, type] of [
        [6, 3],
        [7, 1],
        [7, 2],
        [7, 3],
      ]) {
        const fields = await inspect(func, type, [raw, 0, 0, 9]);
        expect(fields('supply_voltage')?.value).toBe(
          `Reserved/error code ${raw}; voltage unavailable`,
        );
      }
    const unavailable = await inspect(7, 1, [255, 0, 128, 8]);
    expect(unavailable('supply_available')?.value).toBe('Not supported');
    expect(unavailable('supply_voltage')).toBeUndefined();
    const ordinary = await inspect(6, 1, [255, 0, 0, 8]);
    expect(ordinary('supply_voltage')?.value).toBe('5.1 V · raw 255');
  });
  test('occupancy profiles retain their different PIR semantics and bit positions', async () => {
    const inspect = session();
    for (const erp2 of [false, true]) {
      for (const raw of [0, 127, 128, 255]) {
        const fields = await inspect(7, 1, [125, 0, raw, 9], erp2);
        expect(fields('pir')).toMatchObject({
          value: raw >= 128 ? 'PIR on' : 'PIR off',
          offset: erp2 ? 8 : 3,
          length: 1,
        });
      }
      for (const type of [2, 3])
        for (const motion of [false, true]) {
          const fields = await inspect(7, type, [125, 0, 0, 8 | (motion ? 128 : 0)], erp2);
          expect(fields('pir')?.value).toBe(
            motion ? 'Motion detected' : 'Occupancy status uncertain',
          );
          expect(fields('supply_available')).toBeUndefined(); // Required by profile, not an on-air availability flag.
        }
    }
  });
  test('combined sensors expose actual temperature ranges and active-low PIR/button flags', async () => {
    const inspect = session();
    for (const erp2 of [false, true])
      for (const type of [1, 2, 3])
        for (const raw of [0, 128, 255])
          for (const flags of [0, 1, 2, 3]) {
            const fields = await inspect(8, type, [255, raw, raw, 8 | flags], erp2);
            expect(fields('supply_voltage')?.value).toBe('5.1 V · raw 255');
            expect(fields('illumination')?.value).toBe(physical(raw * type * 2, 'lx', raw));
            expect(fields('temperature')?.value).toBe(
              physical(type === 3 ? -30 + (raw * 80) / 255 : raw / 5, '°C', raw),
            );
            expect(fields('pir')?.value).toBe(flags & 2 ? 'PIR off' : 'PIR on');
            expect(fields('occupancy_button')?.value).toBe(flags & 1 ? 'Released' : 'Pressed');
          }
  });
  test('absent, corrupt, later or mismatched teach-in does not invent light or occupancy units', async () => {
    const worker = createDissector();
    workers.push(worker);
    for (const erp2 of [false, true]) {
      const selected = packet([125, 128, 192, 8], erp2, 2);
      const teach = packet([24, 24, 11, 0x80], erp2, 1);
      const bad = { ...teach, bytes: [...teach.bytes] };
      bad.bytes[bad.bytes.length - 1] ^= 1;
      for (const frames of [
        [selected],
        [bad, selected],
        [{ ...teach, time: 3 }, selected],
        [{ ...teach, frequency: erp2 ? 928.35 : undefined }, selected],
      ]) {
        const result: Dissection = await worker.dissect({ frames, selected: frames.length - 1 });
        expect(
          flattenFields(result.fields).filter((f) => f.filter === 'enocean.eep.illumination'),
        ).toHaveLength(0);
      }
      const corrupt = { ...selected, bytes: [...selected.bytes] };
      corrupt.bytes[corrupt.bytes.length - 1] ^= 1;
      const result: Dissection = await worker.dissect({ frames: [teach, corrupt], selected: 1 });
      expect(result.integrity).toBe('invalid');
      expect(result.warnings.join(' ')).toContain('values are untrusted');
    }
  });
});
