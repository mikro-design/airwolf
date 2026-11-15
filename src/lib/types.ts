export type Protocol = 'zigbee' | '15p4' | 'ble' | 'enocean' | 'enocean2' | 'wifi' | 'lte';
export type BlePhy = '1m' | '2m' | 'coded';
export type ReceivedBlePhy = '1m' | '2m' | 'coded-s2' | 'coded-s8';
export type BleDirection = 'central-to-peripheral' | 'peripheral-to-central';
export type LteChannel = 'bcch-bch' | 'bcch-dl-sch';
export interface LteReceiveContext {
  pci: number;
  prb: number;
  ports: number;
  tdd: boolean;
  extendedCp: boolean;
  phichExtended: boolean;
  phichResources: number;
  cfoHz: number;
}
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
  bleDirection?: BleDirection;
  bleCteUs?: number;
  bleCteComplete?: boolean;
  captureContext?: 'matched-observation';
  bleAuxType?: 'aux-adv' | 'aux-chain' | 'aux-sync' | 'aux-scan-response';
  captureIntegrity?: 'valid' | 'invalid' | 'unchecked';
  captureMic?: 'valid' | 'invalid' | 'unchecked';
  wifiRateMbps?: number;
  wifiPhy?: 'ofdm' | 'dsss' | 'cck';
  wifiPreamble?: 'long' | 'short';
  ltePci?: number;
  ltePrb?: number;
  ltePorts?: number;
  lteSfn?: number;
  lteTdd?: boolean;
  lteChannel?: LteChannel;
  lteSubframe?: number;
  lteMcs?: number;
  lteRv?: number;
  lteContext?: LteReceiveContext;
  lteTransportFirstSample?: number;
  lteTransportEndSample?: number;
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
  decode(request: { frames: DissectorFrame[]; selected: number }): Promise<Dissection>;
  stop(): Promise<void>;
}
export type DissectorFrame = Pick<
  Frame,
  | 'protocol'
  | 'hasFcs'
  | 'bytes'
  | 'time'
  | 'channel'
  | 'frequency'
  | 'phy'
  | 'bleDirection'
  | 'bleAuxType'
  | 'timeUncertaintyUs'
  | 'crcInit'
  | 'connectionEvent'
  | 'captureEpoch'
  | 'deviceSerial'
  | 'lteChannel'
>;
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
  bleAuxFollow?: boolean;
  bleAdvertising?: boolean;
  lteContext?: LteReceiveContext;
}
export interface SpectrumData {
  blePhy?: BlePhy;
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
  lteSiFrames?: number;
  lteSiAttempts?: number;
  lteSiCrcFailures?: number;
  lteSiInvalidBlocks?: number;
  lteBandwidthLimited?: boolean;
  lteRequiredSampleRateHz?: number;
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
  auxFollow?: BleAuxFollowStatus;
  state: 'idle' | 'starting' | 'streaming' | 'error';
  message: string;
}
export interface BleAuxFollowStatus {
  state: 'waiting' | 'scheduled' | 'receiving' | 'stopped';
  message: string;
  channel: number;
  frequencyHz: number;
  phy: BlePhy;
  observedPointers: number;
  verifiedPackets: number;
  skippedLate: number;
  missedWindows: number;
  rejectedPointers: number;
  retunes: number;
}
export interface NativePacket {
  captureContext?: 'matched-observation';
  bleAuxType?: Frame['bleAuxType'];
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
  bleDirection?: BleDirection;
  bleCteUs?: number;
  bleCteComplete?: boolean;
  wifiRateMbps?: number;
  wifiPhy?: 'ofdm' | 'dsss' | 'cck';
  wifiPreamble?: 'long' | 'short';
  ltePci?: number;
  ltePrb?: number;
  ltePorts?: number;
  lteSfn?: number;
  lteTdd?: boolean;
  lteChannel?: LteChannel;
  lteSubframe?: number;
  lteMcs?: number;
  lteRv?: number;
  lteContext?: LteReceiveContext;
  lteTransportFirstSample?: number;
  lteTransportEndSample?: number;
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
  overview(
    id: string,
    first: number,
    end: number,
    columns: number,
    slot?: 'timeline' | 'detail',
  ): Promise<IqOverview>;
  decode(id: string, first: number, end: number, settings?: RadioConfig): Promise<IqDecodeResult>;
  cancelDecode(): Promise<void>;
  cancelAnalysis(): Promise<void>;
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
export interface IqDecodeResult {
  firstSample: number;
  endSample: number;
  processedSamples: number;
  omittedPackets: number;
  elapsedMs: number;
  config: RadioConfig;
  packets: (NativePacket & { referenceIndex?: number })[];
}
