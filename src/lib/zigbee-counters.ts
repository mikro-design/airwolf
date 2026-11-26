import type { Frame } from './types';

// Zigbee NWK security requires each sender's outgoing frame counter to
// increase for a given network key; a receiver rejects a counter that does
// not (frame-counter freshness, Zigbee spec 4.3.1.2). This context follows
// the counters in the captured, clear auxiliary security header per sender
// EUI-64 and key sequence, and flags a frame whose counter did not advance.
//
// It is evidence, not authentication: without the network key the counter
// is not verified, and a sender that lost its counter (factory reset) looks
// the same as a replay. Every relaying hop re-secures a frame under its own
// EUI-64 and counter, so relays are not mistaken for replays. A frame repeated
// byte for byte within a short time (MAC retries) is a retransmission.
const RETRY_SECONDS = 2;

interface Sender {
  highest: number;
  frameId: number;
  last: { counter: number; time: number; bytes: string };
}

const value = (frame: Frame, id: string) => frame.fields.find((f) => f.id === id)?.value;

/** Capture-local, bounded frame-counter observations. Never persist. */
export class ZigbeeCounterContext {
  private senders = new Map<string, Sender>();
  constructor(private readonly limit = 1024) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
      throw new Error('Invalid Zigbee frame-counter context bound');
  }
  get size() {
    return this.senders.size;
  }
  reset() {
    this.senders.clear();
  }
  apply(input: Frame): Frame {
    if (input.protocol !== 'zigbee' || input.integrity !== 'valid') return input;
    const source = value(input, 'nwk-sec-source'),
      counterText = value(input, 'nwk-sec-counter');
    // Without the extended nonce the sender is not identified in the header.
    if (source === undefined || counterText === undefined) return input;
    const counter = Number(counterText),
      key = `${source}/${value(input, 'nwk-key-seq') ?? '-'}`,
      bytes = input.bytes.join(','),
      seen = this.senders.get(key);
    if (!seen) {
      this.remember(key, {
        highest: counter,
        frameId: input.id,
        last: { counter, time: input.time, bytes },
      });
      return input;
    }
    // Most recently used last, so the bound evicts the stalest sender.
    this.senders.delete(key);
    this.senders.set(key, seen);
    const retry =
      seen.last.counter === counter &&
      seen.last.bytes === bytes &&
      input.time >= seen.last.time &&
      input.time - seen.last.time <= RETRY_SECONDS;
    seen.last = { counter, time: input.time, bytes };
    if (counter > seen.highest) {
      seen.highest = counter;
      seen.frameId = input.id;
      return input;
    }
    if (retry) return input;
    const frame: Frame = { ...input, fields: [...input.fields], warnings: [...input.warnings] };
    frame.warnings.push(
      `NWK frame counter ${counter} did not advance past ${seen.highest} (frame ${seen.frameId}) from ${source}: a replayed frame, or the sender's counter was reset. A receiver holding the network key would reject it.`,
    );
    const field = frame.fields.find((f) => f.id === 'nwk-sec-counter');
    if (field) {
      const index = frame.fields.indexOf(field);
      frame.fields[index] = { ...field, value: `${field.value} · not above ${seen.highest}` };
    }
    return frame;
  }
  private remember(key: string, sender: Sender) {
    this.senders.set(key, sender);
    while (this.senders.size > this.limit) this.senders.delete(this.senders.keys().next().value!);
  }
}
