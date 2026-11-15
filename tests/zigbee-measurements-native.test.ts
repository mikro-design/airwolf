import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { flattenFields } from '../src/lib/dissection';
import type { Dissection } from '../src/lib/types';
const { createDissector } = createRequire(import.meta.url)('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
});
const le = (value: number) => [value & 255, (value >>> 8) & 255];
const record = (id: number, value: number, signed = false) => [
  ...le(id),
  signed ? 0x29 : 0x21,
  ...le(value),
];
const clusters = { illumi: 0x400, temp: 0x402, press: 0x403, flow: 0x404, relhum: 0x405 };
const filter = (kind: keyof typeof clusters, id: number) =>
  `zbee_zcl_meas_sensing.${kind === 'illumi' ? 'illum' : kind}meas.attr.${id === 3 ? 'tolerance' : `value${id === 1 ? '.min' : id === 2 ? '.max' : ''}`}`;
function frame(cluster: number, attributes: number[]) {
  const bytes = [
    0x61,
    0x88,
    9,
    0x34,
    0x12,
    0,
    0,
    0x22,
    0x11,
    8,
    0,
    0,
    0,
    0x22,
    0x11,
    30,
    1,
    0,
    1,
    ...le(cluster),
    4,
    1,
    1,
    2,
    0x18,
    3,
    0x0a,
    ...attributes,
  ];
  return { protocol: 'zigbee', bytes, time: 1, hasFcs: false };
}
function session() {
  const worker = createDissector();
  workers.push(worker);
  return async (kind: keyof typeof clusters, id: number, value: number) => {
    const selected = frame(
      clusters[kind],
      record(id, value, id !== 3 && (kind === 'temp' || kind === 'press')),
    );
    const result: Dissection = await worker.dissect({ frames: [selected], selected: 0 });
    expect(result.protocols).not.toContain('_ws.malformed');
    const fields = flattenFields(result.fields);
    for (const field of fields)
      if (field.mapped)
        expect(field.offset + field.length).toBeLessThanOrEqual(selected.bytes.length);
    const field = fields.find((f) => f.filter === filter(kind, id));
    expect(field).toMatchObject({ offset: 31, length: 2, mapped: true });
    return field!.value;
  };
}
describe('ZCL measurement units and unavailable sentinels from chapter 4 formulas', () => {
  test('illuminance logarithm is inverted before adding units, including the one-lux endpoint', async () => {
    const inspect = session();
    for (const [encoded, lux] of [
      [1, 1],
      [10001, 10],
      [20001, 100],
      [30001, 1000],
    ]) {
      expect(await inspect('illumi', 0, encoded)).toContain(`${lux.toFixed(6)} [lx]`);
      expect(await inspect('illumi', 1, encoded)).toContain(`${lux.toFixed(6)} [lx]`);
      expect(await inspect('illumi', 2, encoded + 1)).toContain(
        (10 ** (encoded / 10000)).toFixed(6),
      );
    }
    expect(await inspect('illumi', 0, 0)).toContain('too low');
    expect(await inspect('illumi', 0, 0xffff)).toContain('Invalid');
    expect(await inspect('illumi', 0, 0x8000)).not.toContain('Invalid');
  });
  test('temperature tolerance retains hundredths and below-absolute-zero values stay invalid', async () => {
    const inspect = session();
    for (const value of [0, 1, 5, 9, 99, 100, 105, 2048])
      expect(await inspect('temp', 3, value)).toBe(`${(value / 100).toFixed(2)} [°C]`);
    expect(await inspect('temp', 0, -27315)).toBe('-273.15 [°C]');
    expect(await inspect('temp', 0, -27316)).toContain('Out of range');
    expect(await inspect('temp', 0, -32768)).toContain('Invalid');
    expect(await inspect('temp', 3, 2049)).toContain('Out of range');
  });
  test('negative pressure keeps its sign and invalid readings are not ordinary measurements', async () => {
    const inspect = session();
    for (const value of [-32767, -105, -10, -5, -1, 0, 1, 5, 1013, 32767])
      expect(await inspect('press', 0, value)).toBe(`${(value / 10).toFixed(1)} [kPa]`);
    expect(await inspect('press', 0, -32768)).toContain('Invalid');
    expect(await inspect('press', 1, -5)).toBe('-0.5 [kPa]');
    expect(await inspect('press', 2, -5)).toBe('-0.5 [kPa]');
  });
  test('flow zero is a valid zero and tolerance uses the same physical scale', async () => {
    const inspect = session();
    expect(await inspect('flow', 0, 0)).toContain('0.000000 [m^3/h]');
    expect(await inspect('flow', 0, 65534)).toContain('6553.400000 [m^3/h]');
    expect(await inspect('flow', 0, 65535)).toContain('Invalid');
    for (const value of [0, 1, 15, 2048])
      expect(await inspect('flow', 3, value)).toBe(`${(value / 10).toFixed(1)} [m^3/h]`);
  });
  test('humidity accepts 0–100 percent and separates invalid from out-of-range readings', async () => {
    const inspect = session();
    for (const value of [0, 1, 5005, 10000])
      expect(await inspect('relhum', 0, value)).toBe(`${(value / 100).toFixed(2)} [%]`);
    expect(await inspect('relhum', 0, 10001)).toContain('Out of range');
    expect(await inspect('relhum', 0, 65535)).toContain('Invalid');
    expect(await inspect('relhum', 2, 0)).toContain('Out of range');
  });
  test('undefined min/max values do not acquire fabricated units or ordinary out-of-range labels', async () => {
    const inspect = session();
    for (const kind of Object.keys(clusters) as (keyof typeof clusters)[])
      for (const id of [1, 2])
        expect(
          await inspect(kind, id, kind === 'temp' || kind === 'press' ? 0x8000 : 0xffff),
        ).toContain('Unknown');
  });
  test('declared sensor-limit ranges retain their edge values and reject the adjacent reserved codes', async () => {
    const inspect = session();
    for (const [kind, id, value] of [
      ['illumi', 1, 0],
      ['illumi', 2, 1],
      ['temp', 1, 32767],
      ['temp', 2, -27315],
      ['press', 1, 32767],
      ['press', 2, -32767],
      ['flow', 1, 65534],
      ['flow', 2, 0],
      ['relhum', 1, 10000],
      ['relhum', 2, 0],
    ] as const)
      expect(await inspect(kind, id, value)).toContain('Out of range');
    for (const [kind, id, value] of [
      ['illumi', 1, 1],
      ['illumi', 2, 2],
      ['temp', 1, -27315],
      ['temp', 2, -27314],
      ['press', 1, -32767],
      ['press', 2, -32766],
      ['flow', 1, 0],
      ['flow', 2, 1],
      ['relhum', 1, 9999],
      ['relhum', 2, 10000],
    ] as const)
      expect(await inspect(kind, id, value)).not.toMatch(/Invalid|Unknown|Out of range/);
  });
  test('illuminance target uses its different logarithmic formula and accepts zero as one lux', async () => {
    const worker = createDissector();
    workers.push(worker);
    for (const [encoded, lux] of [
      [0, 1],
      [10000, 10],
      [20000, 100],
      [0x8000, 10 ** (0x8000 / 10000)],
    ]) {
      const result: Dissection = await worker.dissect({
        frames: [frame(0x401, record(0x10, encoded))],
        selected: 0,
      });
      expect(
        flattenFields(result.fields).find(
          (f) => f.filter === 'zbee_zcl_meas_sensing.illumlevelsen.attr.target_level',
        )?.value,
      ).toContain(`${lux.toFixed(6)} [lx]`);
    }
  });
  test('illuminance target uses FFFF rather than 8000 as its invalid sentinel', async () => {
    const worker = createDissector();
    workers.push(worker);
    for (const [value, invalid] of [
      [0x8000, false],
      [0xffff, true],
    ] as const) {
      const result: Dissection = await worker.dissect({
        frames: [frame(0x401, record(0x10, value))],
        selected: 0,
      });
      const field = flattenFields(result.fields).find(
        (f) => f.filter === 'zbee_zcl_meas_sensing.illumlevelsen.attr.target_level',
      );
      expect(field?.value.includes('Invalid')).toBe(invalid);
    }
  });
  test('battery readings keep half-percent and hundred-millivolt scales with invalid and reserved negatives', async () => {
    const worker = createDissector();
    workers.push(worker);
    for (const [id, encoded, suffix, expected] of [
      [0x20, 30, 'batt_voltage', '3.0 [V]'],
      [0x20, 255, 'batt_voltage', 'Invalid or unknown'],
      [0x21, 69, 'batt_percentage', '34.5 [%]'],
      [0x21, 200, 'batt_percentage', '100.0 [%]'],
      [0x21, 201, 'batt_percentage', 'Out of range'],
      [0x21, 254, 'batt_percentage', 'Out of range'],
      [0x21, 255, 'batt_percentage', 'Invalid or unknown'],
    ] as const) {
      const result: Dissection = await worker.dissect({
        frames: [frame(1, [...le(id), 0x20, encoded])],
        selected: 0,
      });
      expect(
        flattenFields(result.fields).find(
          (f) => f.filter === `zbee_zcl_general.power_config.attr.${suffix}`,
        ),
      ).toMatchObject({ value: expected, offset: 31, length: 1, mapped: true });
    }
    // The same 0xff bytes in a 16-bit mains reading are an ordinary 25.5V.
    const result: Dissection = await worker.dissect({
      frames: [frame(1, record(0, 255))],
      selected: 0,
    });
    expect(
      flattenFields(result.fields).find(
        (f) => f.filter === 'zbee_zcl_general.power_config.attr.mains_voltage',
      )?.value,
    ).toBe('25.5 [V]');
  });
  test('every truncated value remains malformed, without mapped bytes beyond capture', async () => {
    const worker = createDissector();
    workers.push(worker);
    for (const cluster of Object.values(clusters))
      for (const missing of [1, 2]) {
        const selected = frame(cluster, record(0, 123, cluster === 0x402 || cluster === 0x403));
        selected.bytes.splice(-missing);
        const result: Dissection = await worker.dissect({ frames: [selected], selected: 0 });
        expect(result.warnings.join(' ')).toMatch(/Malformed|truncat/i);
        for (const field of flattenFields(result.fields))
          if (field.mapped)
            expect(field.offset + field.length).toBeLessThanOrEqual(selected.bytes.length);
      }
  });
});
