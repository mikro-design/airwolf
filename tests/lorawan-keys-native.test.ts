import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { flattenFields } from '../src/lib/dissection';
import type { Dissection } from '../src/lib/types';
import {
  appKey,
  cmac,
  dataUp,
  devAddr,
  devEui,
  hex,
  joinAccept,
  joinRequest,
  loraFrame,
  nwkSKey,
  root,
  session,
} from './lorawan-frames';

const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { lorawanEnvelope } = require('../electron/lorawan-secrets.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
const worker = () => {
  const value = createDissector();
  workers.push(value);
  return value;
};
afterEach(() => {
  for (const value of workers.splice(0)) value.close();
});

const find = (result: Dissection, filter: string) =>
  flattenFields(result.fields).filter((f) => f.filter === filter);
const dissect = (bytes: number[], lorawan: object[] = [], w = worker()): Promise<Dissection> =>
  w.dissect({ frames: [loraFrame(bytes)], selected: 0 }, { lorawan });

describe('LoRaWAN keys in native inspection', () => {
  test('the test CMAC matches RFC 4493', () => {
    const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
    expect(cmac(key, Buffer.alloc(0)).toString('hex')).toBe('bb1d6929e95937287fa37d129b756746');
    expect(cmac(key, hex('6bc1bee22e409f96e93d7e117393172a')).toString('hex')).toBe(
      '070a16b46b4d4144f79bdd9dd04a287c',
    );
    expect(
      cmac(
        key,
        hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'),
      ).toString('hex'),
    ).toBe('dfa66747de9ae63030ca32611497c827');
  });

  test('session keys verify the MIC and decrypt the application payload', async () => {
    const plain = [...Buffer.from('Airwolf LoRaWAN!+')]; // 17 bytes: two keystream blocks
    const w = worker();
    const result = await dissect(dataUp(plain), [session], w);
    expect(find(result, 'lorawan.mic')[0]?.value).toContain('verified with the supplied key');
    expect(find(result, 'lorawan.mic.status')[0]?.value).toBe('Good');
    const decrypted = find(result, 'lorawan.frmpayload_decrypted')[0];
    expect(decrypted?.provenance).toBe('decrypted');
    expect(decrypted?.value.replace(/[^0-9a-f]/gi, '').toLowerCase()).toBe(
      Buffer.from(plain).toString('hex'),
    );
    expect(result.warnings.join(' ')).not.toMatch(/MIC not verified|remain encrypted/);
    // Without keys the same frame stays encrypted and unverified.
    const plainResult = await dissect(dataUp(plain), [], w);
    expect(find(plainResult, 'lorawan.frmpayload_decrypted')).toHaveLength(0);
    expect(plainResult.warnings.join(' ')).toContain('MIC not verified');
  });

  test('port 0 MAC commands are decrypted with NwkSKey', async () => {
    // LinkCheckReq (0x02) and DevStatusAns (0x06: battery 200, margin 10).
    const result = await dissect(dataUp([0x02, 0x06, 200, 10], { port: 0, key: nwkSKey }), [
      session,
    ]);
    expect(find(result, 'lorawan.mic.status')[0]?.value).toBe('Good');
    const commands = find(result, 'lorawan.mac_command_uplink');
    expect(commands.length).toBe(2);
    expect(commands.every((f) => f.provenance === 'decrypted')).toBe(true);
  });

  test('a wrong session key fails the MIC and withholds the decrypted payload', async () => {
    const wrong = { ...session, nwkSKey: '00'.repeat(16) };
    const result = await dissect(dataUp([1, 2, 3, 4]), [wrong]);
    expect(find(result, 'lorawan.mic')[0]?.value).toContain('incorrect for the supplied key');
    expect(find(result, 'lorawan.frmpayload_decrypted')).toHaveLength(0);
    expect(flattenFields(result.fields).some((f) => f.provenance === 'decrypted')).toBe(false);
    expect(result.warnings.join(' ')).toContain('MIC is incorrect for the supplied key');
    expect(result.warnings.join(' ')).not.toContain('MIC not verified');
    // A counter above 65535 also fails: only the low 16 bits travel.
    const high = await dissect(dataUp([1, 2, 3, 4], { fcnt: 0x10005 }), [session]);
    expect(find(high, 'lorawan.mic.status')[0]?.value).toBe('Bad');
  });

  test('keys for another DevAddr leave the frame unverified', async () => {
    const other = { ...session, devAddr: '26011BDB' };
    const result = await dissect(dataUp([1, 2, 3]), [other]);
    expect(find(result, 'lorawan.mic')[0]?.value).toMatch(/unverified|not verified/);
    expect(find(result, 'lorawan.frmpayload_decrypted')).toHaveLength(0);
  });

  test('a root key verifies join requests and decrypts join accepts', async () => {
    const w = worker();
    const request = await dissect(joinRequest(), [root], w);
    expect(find(request, 'lorawan.mic')[0]?.value).toContain('verified with the supplied key');
    const wrongRequest = await dissect(joinRequest(hex('11'.repeat(16))), [root], w);
    expect(find(wrongRequest, 'lorawan.mic.status')[0]?.value).toBe('Bad');

    const accept = await dissect(joinAccept(), [root], w);
    expect(find(accept, 'lorawan.join_accept.devaddr')[0]?.value).toMatch(/26011bda/i);
    expect(accept.warnings.join(' ')).not.toMatch(/root key|keys unavailable/);
    const unknown = await dissect(joinAccept(hex('22'.repeat(16))), [root], w);
    expect(find(unknown, 'lorawan.join_accept.devaddr')).toHaveLength(0);
    expect(unknown.warnings.join(' ')).toContain('No supplied root key decrypts this join accept');
    // Without any root key the join accept keeps Airwolf's own opaque view.
    const none = await dissect(joinAccept(), [], w);
    expect(none.warnings.join(' ')).toContain('Join-accept keys unavailable');
  });

  test('the key envelope is validated before anything reaches the worker', () => {
    expect(() => lorawanEnvelope(Buffer.alloc(24), [{ ...session, nwkSKey: 'xyz' }])).toThrow(
      'Invalid LoRaWAN key configuration',
    );
    expect(() => lorawanEnvelope(Buffer.alloc(24), [session, { ...session, id: 3 }])).toThrow(
      'already configured',
    );
    const wire = lorawanEnvelope(Buffer.alloc(24), [root, session]);
    expect(wire.subarray(0, 8)).toEqual(Buffer.from([65, 87, 76, 75, 1, 1, 1, 0]));
    // DevEUI goes on-air order (reversed), DevAddr little-endian.
    expect(wire.subarray(8, 16)).toEqual(hex(devEui).reverse());
    expect(wire.readUInt32LE(32)).toBe(devAddr);
  });
});
