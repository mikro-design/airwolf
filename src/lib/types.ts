export interface WifiHt {
  mcs: number;
  guardNs: 400 | 800;
  coding: 'bcc' | 'ldpc';
  format: 'mixed' | 'greenfield';
  stbc: 0 | 1;
  extensionStreams: number;
  psduLength: number;
  symbols: number;
  aggregateOffset?: number;
}
export type Protocol =
  'zigbee' | '15p4' | 'ble' | 'enocean' | 'enocean2' | 'wifi' | 'lte' | 'lora' | 'gps';
export type BlePhy = '1m' | '2m' | 'coded';
export type ReceivedBlePhy = '1m' | '2m' | 'coded-s2' | 'coded-s8';
export type BleDirection = 'central-to-peripheral' | 'peripheral-to-central';
export type LteChannel = 'bcch-bch' | 'bcch-dl-sch' | 'pcch';
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
export interface LoraSettings {
  bandwidth: 125000 | 250000 | 500000;
  spreadingFactor: 0 | 7 | 8 | 9 | 10 | 11 | 12;
  syncWord: 0x12 | 0x34;
  inverted: boolean;
  macVersion: 'unknown' | '1.0' | '1.1';
}
export interface LoraMetadata extends Omit<LoraSettings, 'spreadingFactor'> {
  spreadingFactor: 7 | 8 | 9 | 10 | 11 | 12;
  codingRate: 1 | 2 | 3 | 4;
  crcPresent: boolean;
  crcReceived?: number;
  crcCalculated?: number;
  headerValid?: boolean;
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
  provenance?: 'captured' | 'decrypted' | 'reassembled' | 'generated' | 'derived';
  children?: Field[];
  text?: { value: string; offset: number; length: number; inferred: boolean }[];
}
export interface GpsMetadata {
  gpsPrn?: number;
  gpsSubframe?: number;
  gpsTow?: number;
  gpsCn0?: number;
  gpsDopplerHz?: number;
  gpsNavFirstSample?: number;
  gpsNavEndSample?: number;
}
export interface GpsSatellite {
  prn: number;
  acquiring: boolean;
  tracking: boolean;
  bitSync: boolean;
  frameSync: boolean;
  cn0: number;
  dopplerHz: number;
  lockSeconds: number;
  frames: number;
  parityFailures: number;
}
export interface Frame extends GpsMetadata {
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
  bleRole?: 'periodic-advertising';
  periodicEvent?: number;
  bleCteUs?: number;
  bleCteComplete?: boolean;
  captureContext?: 'matched-observation';
  bleAuxType?: 'aux-adv' | 'aux-chain' | 'aux-sync' | 'aux-scan-response';
  captureIntegrity?: 'valid' | 'invalid' | 'unchecked';
  captureMic?: 'valid' | 'invalid' | 'unchecked';
  lora?: LoraMetadata;
  loraReplayEndSample?: number;
  wifiRateMbps?: number;
  wifiPhy?: 'ofdm' | 'dsss' | 'cck' | 'ht';
  wifiHt?: WifiHt;
  wifiPreamble?: 'long' | 'short';
  ltePci?: number;
  ltePrb?: number;
  ltePorts?: number;
  lteSfn?: number;
  lteTdd?: boolean;
  lteChannel?: LteChannel;
  lteRnti?: 65534 | 65535;
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
export interface ZigbeeAuthentication {
  layer: 'nwk' | 'aps';
  status:
    | 'authenticated'
    | 'key-unavailable'
    | 'no-matching-key'
    | 'authentication-failed'
    | 'source-unavailable'
    | 'unauthenticated'
    | 'truncated';
  securityLevel: number;
  keyId?: number;
}
export interface ZigbeeKeyInput {
  label: string;
  kind: 'network' | 'link';
  key: string;
  panId?: number;
  sourceEui64?: string;
  keySequence?: number;
}
export interface ZigbeeKeyState {
  keys: { id: number; label: string }[];
  securityLevel: number;
  revision: number;
  storage: 'os-protected' | 'session-only';
  notice: string;
}
export interface ZigbeeKeyBridge {
  list(): Promise<ZigbeeKeyState>;
  add(entry: ZigbeeKeyInput): Promise<ZigbeeKeyState>;
  remove(id: number): Promise<ZigbeeKeyState>;
  setLevel(level: number): Promise<ZigbeeKeyState>;
}
export interface Dissection {
  security?: ZigbeeAuthentication[];
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
  | 'bleRole'
  | 'periodicEvent'
  | 'timeUncertaintyUs'
  | 'crcInit'
  | 'connectionEvent'
  | 'captureEpoch'
  | 'deviceSerial'
  | 'gpsPrn'
  | 'lteChannel'
  | 'lora'
>;
export interface RadioDeviceInfo {
  iioDevices?: { uri: string; description: string }[];
  iio?: {
    uri: string;
    channels: number;
    adcBits: number;
    frequencyRange: string;
    sampleRateRange: string;
    gainRange: string;
    bandwidthRange: string;
  };
  available: boolean;
  details: string;
  serials?: string[];
}
export interface RadioConfig {
  backend?: 'hackrf' | 'pluto';
  iio?: {
    uri: string;
    channel: number;
    gain: number;
    gainMode: 'manual' | 'slow_attack' | 'fast_attack';
    bandwidth: number;
    adcBits: number;
  };
  gpsContext?: { prn: number; dopplerHz: number };
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
  blePeriodicFollow?: boolean;
  bleRole?: 'periodic-advertising';
  bleAdvertising?: boolean;
  lteContext?: LteReceiveContext;
  lora?: LoraSettings;
}
export interface SpectrumData {
  adcBits?: number;
  transportContinuity?: 'unverified';
  gpsSatellites?: GpsSatellite[];
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
  lteMibCandidates?: number;
  lteSiFrames?: number;
  ltePagingFrames?: number;
  lteSiAttempts?: number;
  lteSiCrcFailures?: number;
  lteSiInvalidBlocks?: number;
  lteSiQueueDrops?: number;
  lteBandwidthLimited?: boolean;
  lteRequiredSampleRateHz?: number;
}
export interface BleFollowStatus {
  phy?: BlePhy;
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
  periodicFollow?: BlePeriodicFollowStatus;
  state: 'idle' | 'starting' | 'streaming' | 'error';
  message: string;
}
export interface BlePeriodicFollowStatus {
  state: 'waiting' | 'acquiring' | 'tracking' | 'lost' | 'stopped';
  message: string;
  channel: number;
  frequencyHz: number;
  phy: BlePhy;
  intervalUs: number;
  accessAddress: number;
  crcInit: number;
  event?: number;
  verifiedEvents: number;
  verifiedChains: number;
  missedWindows: number;
  skippedWindows: number;
  rejectedPackets: number;
  ambiguousPackets: number;
  skippedChains: number;
  retunes: number;
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
export interface NativePacket extends GpsMetadata {
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
  bleRole?: 'periodic-advertising';
  periodicEvent?: number;
  bleCteUs?: number;
  bleCteComplete?: boolean;
  lora?: LoraMetadata;
  loraReplayEndSample?: number;
  wifiRateMbps?: number;
  wifiPhy?: 'ofdm' | 'dsss' | 'cck' | 'ht';
  wifiHt?: WifiHt;
  wifiPreamble?: 'long' | 'short';
  ltePci?: number;
  ltePrb?: number;
  ltePorts?: number;
  lteSfn?: number;
  lteTdd?: boolean;
  lteChannel?: LteChannel;
  lteRnti?: 65534 | 65535;
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
  info(request?: { backend: 'pluto'; uri?: string }): Promise<RadioDeviceInfo>;
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
    zigbeeKeys?: ZigbeeKeyBridge;
  }
}

export interface IqTake {
  datatype?: 'ci8' | 'ci16_le';
  adcBits?: number;
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
  captures: (Omit<IqTake, 'packets'> & { packetCount: number })[];
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
  take(id: string): Promise<IqTake>;
  start(config: RadioConfig, seconds: number): Promise<IqState>;
  stop(): Promise<IqState>;
  overview(
    id: string,
    first: number,
    end: number,
    columns: number,
    slot?: 'timeline' | 'detail',
  ): Promise<IqOverview>;
  decode(
    id: string,
    first: number,
    end: number,
    settings?: RadioConfig,
    selectedPacket?: number,
  ): Promise<IqDecodeResult>;
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
