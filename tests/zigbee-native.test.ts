import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { flattenFields } from '../src/lib/dissection';
import type { Dissection, Frame } from '../src/lib/types';

const { createDissector } = createRequire(import.meta.url)('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
const worker = () => {
  const value = createDissector();
  workers.push(value);
  return value;
};
afterEach(() => {
  for (const value of workers.splice(0)) value.close();
});
const le = (n: number) => [n & 255, n >>> 8];
const text = (s: string) => Array.from(new TextEncoder().encode(s));
const mac = [0x61, 0x88, 9, 0x34, 0x12, 0, 0, 0x22, 0x11];
const nwk = [8, 0, 0, 0, 0x22, 0x11, 30, 1];
function packet(
  payload: number[],
  {
    cluster = 0xfc00,
    profile = 0x0104,
    control = 0,
    extension = [] as number[],
    index = 0,
    source = 0x1122,
  } = {},
) {
  const bytes = [
    ...mac,
    ...nwk,
    control,
    profile ? 1 : 0,
    ...le(cluster),
    ...le(profile),
    profile ? 1 : 0,
    2,
    ...extension,
    ...payload,
  ];
  bytes.splice(13, 2, ...le(source));
  return decode(bytes, 'zigbee', { id: index + 1, time: 1 + index * 0.01, fcs: false });
}
const attributes = (records: number[], header = [0x18, 3, 0x0a]) => [...header, ...records];
const record = (id: number, type: number, value: number[]) => [...le(id), type, ...value];
const find = (result: Dissection, filter: string) =>
  flattenFields(result.fields).filter((f) => f.filter === filter);
function bounded(result: Dissection, size: number) {
  for (const field of flattenFields(result.fields))
    if (field.mapped) {
      expect(field.offset).toBeGreaterThanOrEqual(0);
      expect(field.offset + field.length).toBeLessThanOrEqual(size);
    }
}
async function inspect(
  w: ReturnType<typeof createDissector>,
  frames: Frame[],
  selected = frames.length - 1,
): Promise<Dissection> {
  const result = await w.dissect({ frames, selected });
  bounded(result, frames[selected].bytes.length);
  return result;
}
function complete(result: Dissection) {
  expect(result.protocols).not.toContain('_ws.malformed');
  expect(result.warnings.join(' ')).not.toMatch(/malformed|truncat/i);
}

describe('native Zigbee application corpus from explicit wire-format fixtures', () => {
  test('ZCL scalar types preserve signedness, 64-bit precision, floating values and UTF-8 byte lengths', async () => {
    const label = text('Temp æ°');
    const body = attributes([
      ...record(0xf001, 0x29, [0x9c, 0xff]), // -100, signed 16-bit.
      ...record(0xf002, 0x27, [0xfe, 255, 255, 255, 255, 255, 255, 255]),
      ...record(0xf003, 0x39, [0, 0, 0xc0, 0x3f]), // IEEE754 little endian 1.5.
      ...record(0xf004, 0x42, [label.length, ...label]),
      ...record(0xf005, 0x10, [1]),
    ]);
    const frame = packet(body),
      result = await inspect(worker(), [frame]);
    complete(result);
    expect(find(result, 'zbee_zcl.attr.int16')[0]?.value).toBe('-100');
    expect(find(result, 'zbee_zcl.attr.uint64')[0]?.value).toContain('18446744073709551614');
    expect(find(result, 'zbee_zcl.attr.float')[0]?.value).toBe('1.5');
    expect(find(result, 'zbee_zcl.attr.str')[0]).toMatchObject({
      value: 'Temp æ°',
      length: label.length + 1,
      mapped: true,
    });
    expect(find(result, 'zbee_zcl.attr.boolean')[0]?.value).toContain('True');
  });
  test('arrays and structures retain element types and values', async () => {
    const frame = packet(
      attributes([
        ...record(0xf001, 0x48, [0x21, 3, 0, 1, 0, 2, 0, 0xfe, 0xff]),
        ...record(0xf002, 0x4c, [2, 0, 0x10, 1, 0x42, 3, ...text('abc')]),
      ]),
    );
    const result = await inspect(worker(), [frame]);
    complete(result);
    expect(find(result, 'zbee_zcl.attr.array.elements_num')[0]?.value).toBe('3');
    expect(find(result, 'zbee_zcl.attr.uint16').map((f) => f.value)).toEqual([
      '1 (0x0001)',
      '2 (0x0002)',
      '65534 (0xfffe)',
    ]);
    expect(find(result, 'zbee_zcl.attr.str')[0]?.value).toBe('abc');
  });
  test('manufacturer-specific header remains a two-byte field before sequence and command', async () => {
    const frame = packet(
      attributes(record(0xf001, 0x21, [0x34, 0x12]), [0x1c, 0x34, 0x12, 7, 0x0a]),
    );
    const result = await inspect(worker(), [frame]);
    complete(result);
    expect(find(result, 'zbee_zcl.cmd.mc')[0]).toMatchObject({
      offset: 26,
      length: 2,
      mapped: true,
    });
    expect(find(result, 'zbee_zcl.cmd.tsn')[0]).toMatchObject({ value: '7', offset: 28 });
    expect(find(result, 'zbee_zcl.attr.uint16')[0]?.value).toBe('4660 (0x1234)');
  });
  test('global command payloads and common cluster commands reach the native application dissector', async () => {
    const w = worker();
    const global = [
      [0x10, 1, 0x00, 0, 0, 5, 0], // Read attributes.
      [0x18, 2, 0x01, 1, 0xf0, 0, 0x42, 3, ...text('abc'), 2, 0xf0, 0x86],
      [0x10, 3, 0x02, 1, 0xf0, 0x21, 0x34, 0x12],
      [0x10, 4, 0x06, 0, 0, 0, 0x29, 10, 0, 0x2c, 1, 5, 0],
      [0x18, 5, 0x0b, 1, 0],
      [0x18, 6, 0x0d, 1, 0, 0, 0x21],
    ];
    for (const body of global) {
      const result = await inspect(w, [packet(body)]);
      complete(result);
      expect(result.protocols).toContain('zbee_zcl');
      expect(find(result, 'zbee_zcl.cmd.id')[0]?.value).not.toMatch(/Unknown/);
    }
    for (const [cluster, body] of [
      [0x0006, [0x01, 1, 1]], // On.
      [0x0008, [0x01, 2, 0, 128, 10, 0]], // Move to level.
      [0x0300, [0x01, 3, 0x0a, 0x2c, 1, 10, 0]], // Move to color temperature.
      [0x0500, [0x19, 4, 0, 1, 0, 0, 7, 0x2c, 1]], // IAS status notification.
    ] as const) {
      const result = await inspect(w, [packet([...body], { cluster })]);
      complete(result);
      expect(result.protocols).toContain('zbee_zcl');
      expect(flattenFields(result.fields).some((f) => f.filter?.startsWith('zbee_zcl_'))).toBe(
        true,
      );
    }
  });
  test('ZDO announcements, active endpoints and simple descriptors decode real address/profile/cluster fields', async () => {
    const w = worker();
    const announce = packet([1, 0x22, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x8e], {
      profile: 0,
      cluster: 0x0013,
    });
    const a = await inspect(w, [announce]);
    complete(a);
    expect(a.protocols).toContain('zbee_zdp');
    expect(find(a, 'zbee_zdp.nwk_addr')[0]?.value).toBe('0x1122');
    expect(find(a, 'zbee_zdp.ext_addr')[0]).toMatchObject({ offset: 28, length: 8, mapped: true });
    const endpoints = await inspect(w, [
      packet([2, 0, 0x22, 0x11, 2, 1, 2], { profile: 0, cluster: 0x8005 }),
    ]);
    complete(endpoints);
    expect(find(endpoints, 'zbee_zdp.ep_count')[0]?.value).toBe('2');
    const descriptor = [1, 4, 1, 0, 0, 0, 2, 0, 0, 6, 0, 1, 8, 0];
    const simple = await inspect(w, [
      packet([3, 0, 0x22, 0x11, descriptor.length, ...descriptor], { profile: 0, cluster: 0x8004 }),
    ]);
    complete(simple);
    expect(find(simple, 'zbee_zdp.in_cluster').map((f) => f.value)).toHaveLength(2);
    expect(find(simple, 'zbee_zdp.out_cluster')).toHaveLength(1);
  });
  test('APS fragments reassemble with context and derived fields never highlight original bytes', async () => {
    const w = worker(),
      body = attributes(record(0xf001, 0x42, [11, ...text('Hello world')]));
    const frames = [
      packet(body.slice(0, 8), { control: 0x80, extension: [1, 2] }),
      packet(body.slice(8), { control: 0x80, extension: [2, 1], index: 1 }),
    ];
    const result = await inspect(w, frames);
    complete(result);
    expect(result.protocols).toContain('zbee_zcl');
    expect(find(result, 'zbee_zcl.attr.str')[0]).toMatchObject({
      value: 'Hello world',
      mapped: false,
    });
    expect(find(result, 'zbee_aps.fragment.count')[0]?.value).toBe('2');
    expect(find(result, 'zbee_aps.reassembled.length')[0]?.value).toBe(String(body.length));
    for (const field of flattenFields(result.fields).filter((f) =>
      f.filter?.startsWith('zbee_zcl'),
    ))
      expect(field.mapped).toBe(false);
    const incomplete = await inspect(w, [frames[1]]);
    expect(incomplete.protocols).not.toContain('zbee_zcl');
    const first = await inspect(w, frames, 0);
    expect(find(first, 'zbee_zcl.attr.str')).toHaveLength(0);
    const wrongSource = { ...frames[1], bytes: [...frames[1].bytes] };
    wrongSource.bytes[13] ^= 1;
    expect((await inspect(w, [frames[0], wrongSource])).protocols).not.toContain('zbee_zcl');
  });
  test('duplicate or conflicting APS fragments do not become an unrelated completed message', async () => {
    const w = worker(),
      body = attributes(record(0xf001, 0x42, [5, ...text('Hello')]));
    const a = packet(body.slice(0, 8), { control: 0x80, extension: [1, 2] });
    const b = packet(body.slice(8), { control: 0x80, extension: [2, 1], index: 2 });
    const duplicate = { ...a, id: 2, time: 1.01 };
    const result = await inspect(w, [a, duplicate, b]);
    complete(result);
    expect(find(result, 'zbee_zcl.attr.str')[0]?.value).toBe('Hello');
    const missingFirst = await inspect(w, [b, { ...b, id: 4, time: 1.03 }]);
    expect(missingFirst.protocols).not.toContain('zbee_zcl');
  });
  test('NWK and APS encrypted bytes never become application fields or verified MICs', async () => {
    const w = worker();
    const security = [
      0x28,
      1,
      0,
      0,
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      0,
      ...text('not plaintext'),
      0,
      0,
      0,
      0,
    ];
    const aps = packet(security, { control: 0x20 });
    const network = decode([...mac, 8, 2, ...nwk.slice(2), ...security], 'zigbee', {
      id: 1,
      time: 1,
      fcs: false,
    });
    for (const frame of [network, aps]) {
      const result = await inspect(w, [frame]);
      expect(result.protocols).not.toContain('zbee_zcl');
      expect(result.warnings.join(' ')).toContain('No Zigbee key supplied; MIC not verified.');
      expect(result.warnings.join(' ')).not.toMatch(/MIC (correct|valid)|authenticated/i);
      expect(find(result, 'zbee_zcl.attr.str')).toHaveLength(0);
      expect(result.integrity).toBeUndefined();
    }
  });
  test('every truncation of a complete typed report returns bounded fields and the next request recovers', async () => {
    const w = worker(),
      frame = packet(attributes(record(0xf001, 0x42, [11, ...text('Hello world')])));
    for (let size = 1; size < frame.bytes.length; size++) {
      const result = await inspect(w, [{ ...frame, bytes: frame.bytes.slice(0, size) }]);
      expect(find(result, 'zbee_zcl.attr.str').some((f) => f.value === 'Hello world')).toBe(false);
    }
    const recovered = await inspect(w, [frame]);
    complete(recovered);
    expect(find(recovered, 'zbee_zcl.attr.str')[0]?.value).toBe('Hello world');
  });
  test('empty strings and invalid short/long sentinels remain distinct and aligned', async () => {
    const result = await inspect(worker(), [
      packet(
        attributes([
          ...record(0xf001, 0x42, [0xff]),
          ...record(0xf002, 0x42, [0]),
          ...record(0xf003, 0x44, [0xff, 0xff]),
          ...record(0xf004, 0x44, [0, 0]),
          ...record(0xf005, 0x29, [0x9c, 0xff]),
        ]),
      ),
    ]);
    complete(result);
    expect(find(result, 'zbee_zcl.attr.str').map((f) => [f.value, f.length])).toEqual([
      ['Invalid character string (0xFF)', 1],
      ['', 1],
      ['Invalid character string (0xFFFF)', 2],
      ['', 2],
    ]);
    expect(find(result, 'zbee_zcl.attr.int16')[0]?.value).toBe('-100');
  });
  test('long UTF-8 values preserve byte lengths and invalid UTF-8 remains visibly invalid', async () => {
    const w = worker(),
      label = text('Snø ❄'),
      good = packet(attributes(record(0xf001, 0x44, [...le(label.length), ...label])));
    const result = await inspect(w, [good]);
    complete(result);
    expect(find(result, 'zbee_zcl.attr.str')[0]).toMatchObject({
      value: 'Snø ❄',
      length: label.length + 2,
    });
    for (const invalid of [
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
    ]) {
      const bad = await inspect(w, [
        packet(attributes(record(0xf001, 0x42, [invalid.length, ...invalid]))),
      ]);
      expect(find(bad, 'zbee_zcl.attr.str')[0]?.value).toContain('�');
      expect(find(bad, 'zbee_zcl.attr.str')[0]?.length).toBe(invalid.length + 1);
    }
  });
  test('collections distinguish empty, undefined and no-data counts without field expansion', async () => {
    const w = worker();
    for (const type of [0x48, 0x50, 0x51, 0x4c]) {
      const prefix = type === 0x4c ? [] : [0x21];
      for (const count of [0, 65535]) {
        const result = await inspect(w, [
          packet(
            attributes([
              ...record(0xf001, type, [...prefix, ...le(count)]),
              ...record(0xf002, 0x29, [0x9c, 0xff]),
            ]),
          ),
        ]);
        complete(result);
        expect(find(result, 'zbee_zcl.attr.int16')[0]?.value).toBe('-100');
        const countField = flattenFields(result.fields).find((f) =>
          f.filter?.endsWith('.elements_num'),
        );
        expect(countField?.value).toContain(String(count));
      }
    }
    const noData = await inspect(w, [packet(attributes(record(0xf001, 0x48, [0, 0xfe, 0xff])))]);
    complete(noData);
    expect(flattenFields(noData.fields).length).toBeLessThan(100);
  });
  test('all collection counts require their declared data, unknown structure types stop safely', async () => {
    const w = worker();
    for (const [type, wire] of [
      [0x48, [0x21, 1, 0]],
      [0x50, [0x21, 2, 0, 1, 0]],
      [0x51, [0x21, 2, 0, 1, 0]],
      [0x4c, [1, 0]],
      [0x4c, [2, 0, 0x10, 1]],
      [0x4c, [1, 0, 0xff]],
    ] as const) {
      const result = await inspect(w, [packet(attributes(record(0xf001, type, [...wire])))]);
      expect(result.warnings.join(' ')).toMatch(/malformed|nesting|truncat/i);
    }
    complete(await inspect(w, [packet(attributes(record(0xf001, 0x4c, [1, 0, 0x10, 1])))]));
  });
  test('mixed collection nesting accepts 15 levels, rejects 16 and resets after exceptions', async () => {
    const w = worker();
    const nested = (depth: number): number[] => {
      let value = [0x10, 1];
      for (let i = 0; i < depth; i++)
        value = i % 2 ? [0x48, value[0], 1, 0, ...value.slice(1)] : [0x4c, 1, 0, ...value];
      return value;
    };
    for (const depth of [15, 16, 1, 16, 15]) {
      const value = nested(depth),
        result = await inspect(w, [packet(attributes(record(0xf001, value[0], value.slice(1))))]);
      if (depth <= 15) {
        complete(result);
        expect(find(result, 'zbee_zcl.attr.boolean')[0]?.value).toContain('True');
      } else expect(result.warnings.join(' ')).toMatch(/malformed|nesting|truncat/i);
    }
  });
  test('Level Control options are optional as a pair but not silently truncated', async () => {
    const w = worker(),
      base = [1, 2, 0, 128, 10, 0];
    for (const options of [[], [1, 1]])
      complete(await inspect(w, [packet([...base, ...options], { cluster: 8 })]));
    const bad = await inspect(w, [packet([...base, 1], { cluster: 8 })]);
    expect(bad.warnings.join(' ')).toMatch(/malformed|truncat/i);
  });
  test('MAC authentication-only security never claims that clear bytes need decryption', async () => {
    const clear = packet(attributes(record(0xf001, 0x42, [3, ...text('abc')])));
    const frame = decode(
      [0x69, 0x98, ...clear.bytes.slice(2, 9), 1, 1, 0, 0, 0, ...clear.bytes.slice(9), 0, 0, 0, 0],
      'zigbee',
      { id: 1, time: 1, fcs: false },
    );
    const result = await inspect(worker(), [frame]);
    expect(result.warnings).toContain(
      'MAC authentication key unavailable; MIC not verified; clear payload retained.',
    );
    expect(result.warnings.join(' ')).not.toMatch(/can.t decrypt|MIC correct|authenticated/i);
  });
  test('deterministic malformed collection and string mutations stay bounded and the worker recovers', async () => {
    const w = worker();
    const seeds = [
      record(0xf001, 0x4c, [2, 0, 0x10, 1, 0x42, 3, ...text('abc')]),
      record(0xf001, 0x48, [0x21, 3, 0, 1, 0, 2, 0, 3, 0]),
      record(0xf001, 0x44, [6, 0, ...text('Snø!x')]),
    ];
    let random = 0x5a17c0de;
    const next = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return random >>> 0;
    };
    for (let index = 0; index < 512; index++) {
      let bytes = [...seeds[index % seeds.length]];
      for (let mutation = 0; mutation < 1 + (index % 3); mutation++)
        bytes[next() % bytes.length] = next() & 255;
      if (index % 4 === 0) bytes = bytes.slice(0, next() % bytes.length);
      const result = await inspect(w, [packet(attributes(bytes))]);
      expect(flattenFields(result.fields).length).toBeLessThanOrEqual(8000);
    }
    const recovered = await inspect(w, [
      packet(attributes(record(0xf001, 0x42, [3, ...text('abc')]))),
    ]);
    complete(recovered);
    expect(find(recovered, 'zbee_zcl.attr.str')[0]?.value).toBe('abc');
  });
});
