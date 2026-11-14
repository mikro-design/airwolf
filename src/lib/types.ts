export type Protocol = 'zigbee' | '15p4' | 'ble' | 'enocean' | 'enocean2' | 'wifi' | 'lte';
export type BlePhy = '1m' | '2m' | 'coded';
export type ReceivedBlePhy = '1m' | '2m' | 'coded-s2' | 'coded-s8';
export type Layer = 'mac' | 'network' | 'application' | 'payload' | 'check';
export interface Field {
  id: string;
  name: string;
  value: string;
  offset: number;
  length: number;
  layer: Layer;
  filter?: string;
  mapped?: boolean;
  children?: Field[];
  text?: { value: string; offset: number; length: number; inferred: boolean }[];
}
export interface Frame {
  id: number;
  time: number;
  protocol: Protocol;
  channel: number | null;
  frequency: number | null;
  rssi: number | null;
  bytes: number[];
  fields: Field[];
  source: string;
  destination: string;
  type: string;
  summary: string;
  hasFcs: boolean;
  integrity: 'valid' | 'invalid' | 'unchecked';
  checksum?: { received: string; calculated: string; algorithm: string };
  warnings: string[];
  origin: 'demo' | 'import' | 'live';
  iqRef?: string;
  firstSample?: number;
  endSample?: number;
  crcInit?: number;
  phy?: ReceivedBlePhy;
  wifiRateMbps?: number;
  ltePci?: number;
  ltePrb?: number;
  ltePorts?: number;
  lteSfn?: number;
  lteTdd?: boolean;
  fecErrors?: number;
  deviceSerial?: string;
  captureEpoch?: number;
  timeUncertaintyUs?: number;
  connectionEvent?: number;
  dissection?: Dissection;
}
export interface Dissection {
  fields: Field[];
  protocols: string[];
  warnings: string[];
  summary: string;
  integrity?: Frame['integrity'];
}
export interface DissectorBridge {
  info(): Promise<{ available: boolean; details: string }>;
  decode(request: {
    frames: Pick<Frame, 'protocol' | 'hasFcs' | 'bytes' | 'time'>[];
    selected: number;
  }): Promise<Dissection>;
  stop(): Promise<void>;
}
export interface RadioDeviceInfo {
  available: boolean;
  details: string;
  serials?: string[];
}
export interface RadioConfig {
  serial?: string;
  frequency: number;
  sampleRate: number;
  lna: number;
  vga: number;
  decoder?: Protocol | 'none';
  bleAccessAddress?: number;
  bleCrcInit?: number;
  blePhy?: BlePhy;
  bleFollow?: boolean;
  bleAdvertising?: boolean;
}
export interface SpectrumData {
  deviceSerial?: string;
  frequencyHz: number;
  centerFrequencyHz?: number;
  sampleRateHz: number;
  bins: number[];
  meanBins?: number[];
  time: number;
  samples: number;
  spectrumWindows?: number;
  spectrumHopSamples?: number;
  firstSample: number;
  endSample: number;
  queueDroppedSamples: number;
  displaySkipped: number;
  packetQueueDrops: number;
  decoder: Protocol | 'none';
  decodedFrames: number;
  syncCandidates: number;
  crcFailures: number;
}
export interface BleFollowStatus {
  state: 'waiting' | 'acquiring' | 'tracking' | 'lost' | 'stopped';
  message: string;
  channel: number;
  frequencyHz: number;
  accessAddress: number;
  crcInit: number;
  intervalUs: number;
  clockUncertaintyUs: number;
  retunes: number;
  skippedEvents: number;
  verifiedEvents: number;
}
export interface RadioStatus {
  follow?: BleFollowStatus;
  state: 'idle' | 'starting' | 'streaming' | 'error';
  message: string;
}
export interface NativePacket {
  iqRef?: string;
  integrity?: Frame['integrity'];
  protocol: Protocol;
  bytes: number[];
  time: number;
  channel: number;
  frequencyHz: number;
  sampleRateHz: number;
  firstSample: number;
  endSample: number;
  crcInit?: number;
  phy?: ReceivedBlePhy;
  wifiRateMbps?: number;
  ltePci?: number;
  ltePrb?: number;
  ltePorts?: number;
  lteSfn?: number;
  lteTdd?: boolean;
  fecErrors?: number;
  deviceSerial?: string;
  captureEpoch?: number;
  timeUncertaintyUs?: number;
  connectionEvent?: number;
}
export interface RadioBridge {
  info(): Promise<RadioDeviceInfo>;
  start(config: RadioConfig): Promise<void>;
  stop(): Promise<void>;
  onPackets(fn: (batch: { packets: NativePacket[]; dropped: number }) => void): () => void;
  onSpectrum(fn: (data: SpectrumData) => void): () => void;
  onStatus(fn: (data: RadioStatus) => void): () => void;
}
declare global {
  interface Window {
    iq?: IqBridge;
    radio?: RadioBridge;
    dissector?: DissectorBridge;
  }
}

export interface IqTake {
  id: string;
  name: string;
  created: string;
  imported: boolean;
  samples: number;
  firstSample: number;
  sampleRateHz: number;
  centerFrequencyHz: number;
  config?: RadioConfig;
  epochMs?: number;
  synthetic?: boolean;
  reason: string;
  queueDroppedSamples: number;
  packetOverflow: number;
  packets: NativePacket[];
}
export interface IqState {
  active: { id: string; started: number; seconds: number; saving: boolean } | null;
  captures: IqTake[];
  error?: string;
}
export interface IqOverview {
  activity: {
    firstSample: number;
    endSample: number;
    lowBin: number;
    highBin: number;
    peakDb: number;
  }[];
  firstSample: number;
  sampleCount: number;
  totalSamples: number;
  columns: number;
  fftSize: number;
  timeColumns: number;
  frequencyBins: number;
  envelope: number[][];
  spectrumWindows: number[];
  spectrum: number[];
}
export interface IqBridge {
  frame(reference: string): Promise<{ id: string; packet: number }>;
  list(): Promise<IqState>;
  start(config: RadioConfig, seconds: number): Promise<IqState>;
  stop(): Promise<IqState>;
  overview(id: string, first: number, end: number, columns: number): Promise<IqOverview>;
  save(
    id: string,
    first: number,
    end: number,
    description: string,
  ): Promise<{ path: string; samples: number; sha512: string } | null>;
  open(): Promise<string | null>;
  remove(id: string): Promise<void>;
  onState(fn: (state: IqState) => void): () => void;
}
