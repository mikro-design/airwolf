import { afterEach, describe, expect, test } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { flattenFields } from '../src/lib/dissection';
import type { Dissection, Frame } from '../src/lib/types';
const { createDissector, pcap, validateResult } = createRequire(import.meta.url)(
  '../electron/dissector.cjs',
);
const { envelope } = createRequire(import.meta.url)('../electron/zigbee-secrets.cjs');
const { createZigbeeKeyStore } = createRequire(import.meta.url)('../electron/zigbee-key-store.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
const worker = () => {
  const w = createDissector();
  workers.push(w);
  return w;
};
afterEach(() => {
  for (const w of workers.splice(0)) w.close();
});
const bytes = (hex: string) => Buffer.from(hex.replaceAll(' ', ''), 'hex');
const key = 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf';
const linkKey = '00112233445566778899aabbccddeeff';
const source = bytes('a0a1a2a3a4a5a6a7');
const counter = bytes('03020100');
const mac = bytes('618809341200002211');
const nwk = bytes('0800000022111e01');
const aps = bytes('000100fc04010102');
const zcl = bytes('18030a01f0420568656c6c6f'); // explicit generic attribute UTF-8 "hello".
function ccm(k: string, nonce: Buffer, aad: Buffer, message: Buffer, length: number) {
  const cipher = createCipheriv('aes-128-ccm', bytes(k), nonce, { authTagLength: length });
  cipher.setAAD(aad, { plaintextLength: message.length });
  return Buffer.concat([cipher.update(message), cipher.final(), cipher.getAuthTag()]);
}
// Independent AES-MMO and keyed hash, CSA Zigbee R23 Annex B.1.3/B.1.4.
// OpenSSL AES primitive only; no Wireshark generator/helper is used.
function mmo(input: Buffer) {
  const padded = Buffer.alloc(Math.ceil((input.length + 3) / 16) * 16);
  input.copy(padded);
  padded[input.length] = 0x80;
  padded.writeUInt16BE(input.length * 8, padded.length - 2);
  let state = Buffer.alloc(16);
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = padded.subarray(offset, offset + 16);
    const cipher = createCipheriv('aes-128-ecb', state, null);
    cipher.setAutoPadding(false);
    const out = Buffer.concat([cipher.update(block), cipher.final()]);
    state = Buffer.from(out.map((x, i) => x ^ block[i]));
  }
  return state;
}
function derived(k: string, input: number) {
  const raw = bytes(k);
  return mmo(
    Buffer.concat([
      raw.map((b) => b ^ 0x5c),
      mmo(Buffer.concat([raw.map((b) => b ^ 0x36), Buffer.from([input])])),
    ]),
  ).toString('hex');
}
function protect(
  header: Buffer,
  payload: Buffer,
  {
    k = key,
    keyId = 1,
    sequence = 7,
    level = 5,
    extended = true,
    src = source,
    count = counter,
  } = {},
) {
  const control = (keyId << 3) | (extended ? 0x20 : 0) | level;
  const auxiliary = Buffer.concat([
    Buffer.from([control]),
    count,
    extended ? src : Buffer.alloc(0),
    keyId === 1 ? Buffer.from([sequence]) : Buffer.alloc(0),
  ]);
  const effectiveKey = keyId === 2 ? derived(k, 0) : keyId === 3 ? derived(k, 2) : k;
  const tagLength = [0, 4, 8, 16, 0, 4, 8, 16][level];
  const aad = Buffer.concat([header, auxiliary]);
  let ciphertext: Buffer;
  if (level >= 1 && level <= 3)
    ciphertext = Buffer.concat([
      payload,
      ccm(
        effectiveKey,
        Buffer.concat([src, count, Buffer.from([control])]),
        Buffer.concat([aad, payload]),
        Buffer.alloc(0),
        tagLength,
      ),
    ]);
  else
    ciphertext = ccm(
      effectiveKey,
      Buffer.concat([src, count, Buffer.from([control])]),
      aad,
      payload,
      tagLength || 4,
    );
  auxiliary[0] &= 0xf8; // On-air security level is suppressed by Zigbee.
  return Buffer.concat([header, auxiliary, ciphertext]);
}
function frame(network: Buffer, index = 0): Frame {
  return decode(Array.from(Buffer.concat([mac, network])), 'zigbee', {
    id: index + 1,
    time: 1 + index * 0.01,
    fcs: false,
  });
}
const securedNwk = (payload = Buffer.concat([aps, zcl]), options = {}) => {
  const h = Buffer.from(nwk);
  h[1] |= 2;
  return frame(protect(h, payload, options));
};
const securedAps = (options = {}) => {
  const h = Buffer.from(aps);
  h[0] |= 0x20;
  return frame(Buffer.concat([nwk, protect(h, zcl, { k: linkKey, keyId: 0, ...options })]));
};
const secrets = (k = key, extras = {}) => ({
  zigbee: { keys: [{ id: 17, kind: 'network', key: k, ...extras }] },
});
const flat = (r: Dissection) => flattenFields(r.fields);
const field = (r: Dissection, id: string) => flat(r).filter((f) => f.filter === id);
const assertPrivate = (r: Dissection) => {
  expect(JSON.stringify(r).toLowerCase()).not.toContain(key);
  expect(JSON.stringify(r).toLowerCase()).not.toContain(key.match(/../g)!.join(':'));
  expect(field(r, 'zbee.sec.key')).toHaveLength(0);
  expect(field(r, 'zbee.sec.decryption_key')).toHaveLength(0);
};

describe('request-scoped native Zigbee authentication and application decoding', () => {
  test('independent generator matches CSA R23 Annex C.3/C.4 published ciphertext and MIC', () => {
    expect(
      ccm(
        key,
        bytes('a0a1a2a3a4a5a6a70302010006'),
        bytes('0001020304050607'),
        bytes('08090a0b0c0d0e0f101112131415161718191a1b1c1d1e'),
        8,
      ).toString('hex'),
    ).toBe('1a55a36abb6c610d066b3375649cef10d4664ecad854a80a895cc1d8ff9469');
  });
  test('network-key CCM* decrypts through actual native NWK/APS/ZCL with exact captured-byte provenance', async () => {
    const r = await worker().dissect({ frames: [securedNwk()], selected: 0 }, secrets());
    expect(r.security).toEqual([
      { layer: 'nwk', status: 'authenticated', securityLevel: 5, keyId: 17 },
    ]);
    expect(field(r, 'zbee_zcl.attr.str')[0]).toMatchObject({
      value: 'hello',
      mapped: false,
      offset: 0,
      length: 0,
      provenance: 'decrypted',
    });
    expect(field(r, 'zbee.sec.counter')[0]).toMatchObject({
      mapped: true,
      offset: 18,
      length: 4,
      provenance: 'captured',
    });
    expect(r.protocols).toContain('zbee_zcl');
    assertPrivate(r);
  });
  test('user PCAP export retains encrypted radio bytes and excludes keys and substituted plaintext', async () => {
    const f = securedNwk(),
      r = await worker().dissect({ frames: [f], selected: 0 }, secrets());
    const saved = writePcap([{ ...f, dissection: r }]);
    const exported = Buffer.from(saved);
    expect(exported.includes(bytes(key))).toBe(false);
    expect(exported.includes(Buffer.from(key))).toBe(false);
    expect(exported.includes(Buffer.from('hello'))).toBe(false);
    const restored = readPcap(saved.buffer);
    expect(restored[0].bytes).toEqual(f.bytes);
    expect(restored[0].dissection).toBeUndefined();
  });
  test('missing, wrong and cleared keys never feed ciphertext to application dissection', async () => {
    const w = worker(),
      request = { frames: [securedNwk()], selected: 0 };
    const missing = await w.dissect(request);
    expect(missing.security[0].status).toBe('key-unavailable');
    const wrong = await w.dissect(request, secrets('f'.repeat(32)));
    expect(wrong.security[0].status).toBe('authentication-failed');
    expect((await w.dissect(request, secrets())).security[0].status).toBe('authenticated');
    const cleared = await w.dissect(request);
    expect(cleared.security[0].status).toBe('key-unavailable');
    for (const r of [missing, wrong, cleared]) {
      expect(field(r, 'zbee_zcl.attr.str')).toHaveLength(0);
      assertPrivate(r);
    }
  });
  test('PAN, sender, sequence and key-kind selectors are enforced and never inferred', async () => {
    const w = worker(),
      request = { frames: [securedNwk()], selected: 0 };
    for (const restriction of [
      { panId: 0xabcd },
      { sourceEui64: '0000000000000001' },
      { keySequence: 8 },
      { kind: 'link' },
    ]) {
      const r = await w.dissect(request, secrets(key, restriction));
      expect(r.security[0].status).toBe('no-matching-key');
      expect(field(r, 'zbee_zcl.attr.str')).toHaveLength(0);
    }
    expect(
      (
        await w.dissect(
          request,
          secrets(key, { panId: 0x1234, sourceEui64: 'a7a6a5a4a3a2a1a0', keySequence: 7 }),
        )
      ).security[0].status,
    ).toBe('authenticated');
  });
  test('damaged payload/MIC/counter and key selector produce authentication failure', async () => {
    const original = securedNwk(),
      w = worker();
    for (const offset of [18, 22, 30, 33, original.bytes.length - 1]) {
      const corrupt = { ...original, bytes: [...original.bytes] };
      corrupt.bytes[offset] ^= 1;
      const r = await w.dissect({ frames: [corrupt], selected: 0 }, secrets());
      expect(r.security[0].status).toBe('authentication-failed');
      expect(field(r, 'zbee_zcl.attr.str')).toHaveLength(0);
    }
  });
  test('APS link, transport and load key derivations authenticate using supplied link keys', async () => {
    const w = worker();
    for (const keyId of [0, 2, 3]) {
      const r = await w.dissect(
        { frames: [securedAps({ keyId })], selected: 0 },
        secrets(linkKey, { kind: 'link' }),
      );
      expect(r.security).toEqual([
        { layer: 'aps', status: 'authenticated', securityLevel: 5, keyId: 17 },
      ]);
      expect(field(r, 'zbee_zcl.attr.str')[0]).toMatchObject({
        value: 'hello',
        mapped: false,
        provenance: 'decrypted',
      });
      assertPrivate(r);
    }
  });
  test('a link key added from an install code authenticates APS security natively', async () => {
    // Published install-code vector; its AES-MMO hash is the trust-center link key.
    const derived = '66b6900981e1ee3ca4206b6b861c02bb';
    const store = createZigbeeKeyStore({
      file: path.join(process.cwd(), 'never-written.bin'),
      safeStorage: { isEncryptionAvailable: () => false },
    });
    store.add({ label: 'Lock', kind: 'link', installCode: '83FED3407A939723A5C639B26916D505C3B5' });
    const w = worker();
    for (const keyId of [0, 2]) {
      const r = await w.dissect(
        { frames: [securedAps({ k: derived, keyId })], selected: 0 },
        store.secrets(),
      );
      expect(r.security[0]).toMatchObject({ layer: 'aps', status: 'authenticated' });
      expect(field(r, 'zbee_zcl.attr.str')[0]).toMatchObject({ value: 'hello' });
      expect(JSON.stringify(r).toLowerCase()).not.toContain(derived);
    }
    store.clearSession();
  });
  test('a decrypted APS Transport-Key never reveals the transported key', async () => {
    const transported = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    const header = Buffer.from([0x21, 0x05]); // APS command frame, security, counter 5.
    const command = Buffer.concat([
      Buffer.from([0x05, 0x01]), // Transport-Key, standard network key.
      bytes(transported),
      Buffer.from([0x09]),
      bytes('1112131415161718'),
      source,
    ]);
    const secured = frame(Buffer.concat([nwk, protect(header, command, { k: linkKey, keyId: 2 })]));
    const r = await worker().dissect(
      { frames: [secured], selected: 0 },
      secrets(linkKey, { kind: 'link' }),
    );
    expect(r.security).toEqual([
      { layer: 'aps', status: 'authenticated', securityLevel: 5, keyId: 17 },
    ]);
    expect(field(r, 'zbee_aps.cmd.id')[0]?.value).toMatch(/Transport Key/);
    expect(field(r, 'zbee_aps.cmd.key')).toHaveLength(0);
    const text = JSON.stringify(r).toLowerCase();
    expect(text).not.toContain(transported);
    expect(text).not.toContain(transported.match(/../g)!.join(':'));
    expect(text).not.toContain(linkKey);
    // The same command sent unprotected is already in the captured bytes.
    const clear = frame(Buffer.concat([nwk, Buffer.from([0x01, 0x05]), command]));
    const shown = await worker().dissect({ frames: [clear], selected: 0 });
    expect(field(shown, 'zbee_aps.cmd.key')[0]).toMatchObject({ mapped: true });
  });
  test('nested NWK and APS security require independent keys before native ZCL decoding', async () => {
    const a = Buffer.from(aps);
    a[0] |= 0x20;
    const f = securedNwk(protect(a, zcl, { k: linkKey, keyId: 0 })),
      w = worker(),
      request = { frames: [f], selected: 0 };
    const partial = await w.dissect(request, secrets());
    expect(partial.security.map((s: { status: string }) => s.status)).toEqual([
      'authenticated',
      'no-matching-key',
    ]);
    expect(field(partial, 'zbee_zcl.attr.str')).toHaveLength(0);
    const r = await w.dissect(request, {
      zigbee: {
        keys: [
          { id: 17, kind: 'network', key },
          { id: 18, kind: 'link', key: linkKey },
        ],
      },
    });
    expect(r.security).toEqual([
      { layer: 'nwk', status: 'authenticated', securityLevel: 5, keyId: 17 },
      { layer: 'aps', status: 'authenticated', securityLevel: 5, keyId: 18 },
    ]);
    expect(field(r, 'zbee_zcl.attr.str')[0]?.value).toBe('hello');
    assertPrivate(r);
  });
  test('authentication-only MIC32/64/128 verifies clear payload; encrypted MIC64/128 also verifies', async () => {
    const w = worker();
    for (const level of [1, 2, 3, 6, 7]) {
      const f = securedNwk(undefined, { level }),
        s = secrets();
      Object.assign(s.zigbee, { securityLevel: level });
      const r = await w.dissect({ frames: [f], selected: 0 }, s);
      expect(r.security[0].status).toBe('authenticated');
      expect(field(r, 'zbee_zcl.attr.str')[0]?.value).toBe('hello');
      expect(field(r, 'zbee_zcl.attr.str')[0].mapped).toBe(level < 4);
      const bad = { ...f, bytes: [...f.bytes] };
      bad.bytes[bad.bytes.length - 1] ^= 1;
      expect((await w.dissect({ frames: [bad], selected: 0 }, s)).security[0].status).toBe(
        'authentication-failed',
      );
    }
  });
  test('configured levels without authentication and incomplete MIC remain explicit and opaque', async () => {
    const w = worker(),
      f = securedNwk();
    for (const level of [0, 4]) {
      const s = secrets();
      Object.assign(s.zigbee, { securityLevel: level });
      const r = await w.dissect({ frames: [f], selected: 0 }, s);
      expect(r.security[0].status).toBe('unauthenticated');
      expect(field(r, 'zbee_zcl.attr.str')).toHaveLength(0);
    }
    const short = { ...f, bytes: f.bytes.slice(0, 32) };
    expect((await w.dissect({ frames: [short], selected: 0 }, secrets())).security[0].status).toBe(
      'truncated',
    );
  });
  test('omitted nonces require an earlier authenticated address, never later or corrupt context', async () => {
    const w = worker(),
      first = securedNwk(),
      next = securedNwk(undefined, { extended: false });
    next.id = 2;
    next.time = 1.01;
    const request = { frames: [first, next], selected: 1 };
    expect((await w.dissect(request, secrets())).security[0].status).toBe('authenticated');
    expect((await w.dissect({ frames: [next], selected: 0 }, secrets())).security[0].status).toBe(
      'source-unavailable',
    );
    expect(
      (await w.dissect({ frames: [next, { ...first, id: 3, time: 1.02 }], selected: 0 }, secrets()))
        .security[0].status,
    ).toBe('source-unavailable');
    const corrupt = { ...first, bytes: [...first.bytes] };
    corrupt.bytes[corrupt.bytes.length - 1] ^= 1;
    expect(
      (await w.dissect({ frames: [corrupt, next], selected: 1 }, secrets())).security[0].status,
    ).toBe('source-unavailable');
    // A clear NWK extended-source header does not establish authenticated identity.
    const clearHeader = Buffer.from(nwk);
    clearHeader[1] |= 0x10;
    const plain = frame(Buffer.concat([clearHeader, source, aps, zcl]));
    expect(
      (await w.dissect({ frames: [plain, next], selected: 1 }, secrets())).security[0].status,
    ).toBe('source-unavailable');
  });
  test('encrypted APS fragments reassemble only after both MICs authenticate; no derived byte highlighting', async () => {
    const w = worker(),
      firstHeader = Buffer.concat([Buffer.from(aps), bytes('0102')]),
      nextHeader = Buffer.concat([Buffer.from(aps), bytes('0201')]);
    firstHeader[0] = nextHeader[0] = 0x80;
    const a = securedNwk(Buffer.concat([firstHeader, zcl.subarray(0, 8)]));
    const b = securedNwk(Buffer.concat([nextHeader, zcl.subarray(8)]), {
      count: bytes('04020100'),
    });
    b.id = 2;
    b.time = 1.01;
    const r = await w.dissect({ frames: [a, b], selected: 1 }, secrets());
    expect(field(r, 'zbee_zcl.attr.str')[0]).toMatchObject({
      value: 'hello',
      mapped: false,
      offset: 0,
      length: 0,
      provenance: 'reassembled',
    });
    const broken = { ...a, bytes: [...a.bytes] };
    broken.bytes[broken.bytes.length - 1] ^= 1;
    expect(
      field(await w.dissect({ frames: [broken, b], selected: 1 }, secrets()), 'zbee_zcl.attr.str'),
    ).toHaveLength(0);
    const brokenLast = { ...b, bytes: [...b.bytes] };
    brokenLast.bytes[brokenLast.bytes.length - 1] ^= 1;
    expect(
      field(
        await w.dissect({ frames: [a, brokenLast], selected: 1 }, secrets()),
        'zbee_zcl.attr.str',
      ),
    ).toHaveLength(0);
    expect(
      field(await w.dissect({ frames: [b], selected: 0 }, secrets()), 'zbee_zcl.attr.str'),
    ).toHaveLength(0);
  });
  test('every secured header/payload truncation stays bounded and cannot authenticate', async () => {
    const w = worker(),
      f = securedNwk();
    for (let length = 17; length < f.bytes.length; length++) {
      const truncated = { ...f, bytes: f.bytes.slice(0, length) };
      const r = await w.dissect({ frames: [truncated], selected: 0 }, secrets());
      expect(r.security?.some((s: { status: string }) => s.status === 'authenticated')).not.toBe(
        true,
      );
      expect(field(r, 'zbee_zcl.attr.str')).toHaveLength(0);
      assertPrivate(r);
    }
  });
  test('host rejects impossible authentication and derived-byte provenance claims', () => {
    const base = { fields: [], protocols: [], warnings: [], summary: '' };
    expect(() =>
      validateResult(
        {
          ...base,
          security: [{ layer: 'nwk', status: 'authenticated', securityLevel: 0, keyId: 1 }],
        },
        [],
      ),
    ).toThrow('Invalid native authentication metadata');
    expect(() =>
      validateResult(
        {
          ...base,
          security: [{ layer: 'nwk', status: 'authentication-failed', securityLevel: 5, keyId: 1 }],
        },
        [],
      ),
    ).toThrow('Invalid native authentication metadata');
    const f = {
      id: 'x',
      name: 'x',
      value: 'x',
      filter: 'x',
      offset: 0,
      length: 1,
      mapped: true,
      layer: 'application',
      provenance: 'decrypted',
    };
    expect(() => validateResult({ ...base, fields: [f] }, [1])).toThrow(
      'Invalid native field range',
    );
  });
  test('native AWKY parser rejects malformed bounds/reserved fields and clears keys after errors', () => {
    const request = { frames: [securedNwk()], selected: 0 },
      capture = pcap(request);
    const valid = envelope(capture, secrets()),
      malformed: Buffer[] = [];
    for (const [offset, value] of [
      [4, 2],
      [6, 33],
      [12, 2],
      [13, 8],
      [15, 1],
      [18, 1],
    ] as const) {
      const valueBytes = Buffer.from(valid);
      valueBytes[offset] = value;
      malformed.push(valueBytes);
    }
    const second = envelope(capture, {
      zigbee: {
        keys: [
          { id: 17, kind: 'network', key },
          { id: 18, kind: 'network', key },
        ],
      },
    });
    second.writeUInt32LE(17, 44);
    malformed.push(second);
    malformed.push(valid.subarray(0, 44));
    const wrap = (payload: Buffer) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(payload.length);
      return Buffer.concat([h, payload]);
    };
    const input = Buffer.concat([valid, ...malformed, envelope(capture)].map(wrap));
    const run = spawnSync(
      process.env.AIRWOLF_DECODER_PATH ?? path.resolve('native/build/bin/airwolf-decode'),
      [],
      { input, maxBuffer: 4 * 1024 * 1024, timeout: 30000 },
    );
    input.fill(0);
    expect(run.status, run.stderr.toString()).toBe(0);
    const rows = run.stdout
      .toString()
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(rows[0].result.security[0].status).toBe('authenticated');
    for (const row of rows.slice(1, -1))
      expect(row.error).toMatch(/Invalid private|Duplicate private/);
    expect(rows.at(-1).result.security[0].status).toBe('key-unavailable');
    expect(run.stdout.toString() + run.stderr.toString()).not.toContain(key);
  });
  test('private transport is separate from exported PCAP and rejects malformed key contexts without echoing secrets', () => {
    const request = { frames: [securedNwk()], selected: 0 },
      capture = pcap(request),
      config = secrets();
    expect(envelope(capture, config).subarray(44)).toEqual(capture);
    expect(capture.includes(bytes(key))).toBe(false);
    expect(pcap({ ...request, zigbeeKeys: config })).toEqual(capture);
    for (const entry of [
      { key: 'secret-not-valid' },
      { id: -1 },
      { kind: 'other' },
      { panId: 65536 },
      { keySequence: 256 },
      { sourceEui64: 'a' },
      { kind: 'link', keySequence: 1 },
    ])
      expect(() => envelope(capture, secrets(key, entry))).toThrow(
        'Invalid Zigbee key configuration',
      );
    expect(() =>
      envelope(capture, { zigbee: { keys: Array(33).fill(config.zigbee.keys[0]) } }),
    ).toThrow('Invalid Zigbee security configuration');
    expect(() =>
      envelope(capture, { zigbee: { keys: [config.zigbee.keys[0], config.zigbee.keys[0]] } }),
    ).toThrow('Invalid Zigbee key configuration');
  });
});
