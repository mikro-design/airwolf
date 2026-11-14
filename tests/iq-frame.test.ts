import { expect, it } from 'vitest';
import { iqFrame, iqLane } from '../src/lib/iq';
it('keeps transport envelope tags out of frame summaries and unattributed ACK lanes', () => {
  const frame = iqFrame(
    {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: '15p4',
      bytes: [2, 0, 1, 49, 164],
      channel: 11,
      time: 0,
      firstSample: 10,
      endSample: 100,
      sampleRateHz: 8000000,
      frequencyHz: 2405000000,
    } as Parameters<typeof iqFrame>[0],
    1,
  );
  expect(frame.type).toBe('ACK');
  expect(frame.integrity).toBe('valid');
  expect(iqLane(frame)).toBe('Unattributed frames');
  expect(iqLane({ ...frame, integrity: 'invalid' })).toBe('Failed candidates');
});
