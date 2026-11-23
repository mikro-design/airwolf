import { PlutoSettings } from './components/PlutoSettings';
import { buildRevision } from './lib/build';
import GpsStatus from './components/GpsStatus';
import Forensics from './components/Forensics';
import type { SurveyTarget } from './lib/forensics';
import { gpsMetadata } from './lib/gps';
import ZigbeeKeys from './components/ZigbeeKeys';
import ProtocolPanel from './components/ProtocolPanel';
import { addressExample, matchesAddress, parseAddressFilter } from './lib/address-filter';
import LoraSettings, { defaultLoraSettings } from './components/LoraSettings';
import EsbSettings, { defaultEsbUiSettings } from './components/EsbSettings';
import { esbPacketMetadata, esbRateLabel, packetBlePhy, parseEsbAddress } from './lib/esb';
import { dsrcPacketMetadata } from './lib/dsrc';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Antenna,
  ArrowDownToLine,
  Bluetooth,
  BookOpen,
  Check,
  CircleHelp,
  FileCode2,
  FolderOpen,
  Layers,
  ListFilter,
  Pause,
  Play,
  Radio,
  Search,
  Square,
  RefreshCw,
  Trash2,
  ListEnd,
  Wifi,
  X,
} from 'lucide-react';
import IqCapture from './components/IqCapture';
import SpectrumSplit from './components/SpectrumSplit';
import LteControls from './components/LteControls';
import { lteBands, lteEarfcn, lteFrequency, wifiChannels, type ChannelGuide } from './lib/wideband';
import Inspector from './components/Inspector';
import PacketSplit from './components/PacketSplit';
import PacketTable from './components/PacketTable';
import { touchDissection } from './lib/dissection-cache';
import Catalog from './components/Catalog';
import { demoFrame, demoFrames } from './lib/demo';
import { decodeHex, readPcap, writePcap } from './lib/capture';
import { decode, integrityLabel } from './lib/decoder';
import {
  inspectedFrame,
  flattenFields,
  dissectionRequest,
  nativeDissection,
} from './lib/dissection';
import { profiles, type Profile } from './lib/protocols';
import { bleFrequency, blePhyLabel, receiverPreset, receiverPresets } from './lib/receiver';
import { connectionFromFrame, parseBleConnection } from './lib/ble-connection';
import { EnOceanProfileContext } from './lib/enocean-profile';
import type {
  BlePhy,
  Field,
  IqState,
  RadioConfig,
  Frame,
  Protocol,
  RadioStatus,
  RadioDeviceInfo,
  SpectrumData,
} from './lib/types';
import {
  FRAME_HISTORY_OPTIONS,
  appendBounded,
  loadFrameHistory,
  saveFrameHistory,
} from './lib/frame-history';
// Desktop starts idle with no fabricated traffic. Browser previews have no USB bridge.
const initialMode = window.radio ? 'live' : 'demo';
const initial = initialMode === 'demo' ? demoFrames() : [];
// Two receiver configurations are the same receiver when their set fields
// match: an absent option and a false flag both mean off. On a primary
// advertising channel the native BLE receiver is always in advertising mode,
// so an explicit bleAdvertising flag changes nothing.
function receiverKey(config: RadioConfig) {
  const primary = config.decoder === 'ble' && [2402, 2426, 2480].includes(config.frequency);
  const effective = { ...config, bleAdvertising: primary ? undefined : config.bleAdvertising };
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(effective)
        .filter(([, value]) => value !== undefined && value !== false)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
// Live batches re-run the filter over every retained frame; flatten each field tree once.
const fieldSearchCache = new WeakMap<Field[], string>();
function fieldSearchText(fields: Field[]) {
  let text = fieldSearchCache.get(fields);
  if (text === undefined) {
    text = flattenFields(fields)
      .map((field) => field.value)
      .join(' ')
      .toLowerCase();
    fieldSearchCache.set(fields, text);
  }
  return text;
}
export default function App() {
  const [iqFocus, setIqFocus] = useState<{ id: string; packet: number } | null>(null);
  const [iqRetrieving, setIqRetrieving] = useState(false);
  const [workspace, setWorkspace] = useState<'live' | 'iq' | 'forensics'>('live');
  const [surveyActive, setSurveyActive] = useState(false);
  const surveyOwner = useRef(false);
  const resumePacketsAt = useRef(0);
  const sourceRequest = useRef(0);
  const pendingSource = useRef<{
    mode: 'demo' | 'live' | 'import';
    backend: typeof backend;
  } | null>(null);
  // Effective configuration of the last receiver start (see receiverKey).
  const startedReceiver = useRef('');
  const surveyControls = useRef({ start: () => {}, stop: async () => {} });
  const registerSurveyControls = useCallback((controls: typeof surveyControls.current) => {
    surveyControls.current = controls;
  }, []);
  async function chooseWorkspace(next: typeof workspace) {
    try {
      await surveyControls.current.stop();
      setWorkspace(next);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  const [iqState, setIqState] = useState<IqState>({ active: null, captures: [] });
  const iqBusy = Boolean(iqState.active);
  useEffect(() => {
    if (!window.iq) return;
    let live = true;
    void window.iq
      .list()
      .then((state) => {
        if (live) setIqState(state);
      })
      .catch((error) => setNotice(error.message));
    const unsubscribe = window.iq.onState(setIqState);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const [profile, setProfile] = useState(profiles.find((p) => p.id === 'zigbee')!),
    [mode, setMode] = useState<'demo' | 'live' | 'import'>(initialMode);
  const [frames, setFrames] = useState<Frame[]>(initial),
    [selected, setSelected] = useState<number | null>(null),
    [running, setRunning] = useState(false);
  const equipmentProfiles = useRef(new EnOceanProfileContext());
  const [frequency, setFrequency] = useState(2425),
    [frequencyInput, setFrequencyInput] = useState('2425.000'),
    [sampleRate, setSampleRate] = useState(8),
    // Measured live with a HackRF on BLE channel 37: LNA 40/VGA 30 decoded
    // 736 valid advertisements in 8 s, LNA 16/VGA 20 only 136, while the
    // strongest nearby device stayed far from 8-bit full scale.
    [lna, setLna] = useState(40),
    [vga, setVga] = useState(30),
    [amp, setAmp] = useState(false),
    [antennaPower, setAntennaPower] = useState(false);
  const [query, setQuery] = useState(''),
    // Device-address filter per protocol, so switching protocol keeps each one.
    [addressFilters, setAddressFilters] = useState<Record<string, string>>({}),
    [integrity, setIntegrity] = useState('all'),
    [view, setView] = useState<'table' | 'frames'>('table');
  const [followLatest, setFollowLatest] = useState(initialMode === 'live');
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const changePacketFollow = useCallback((enabled: boolean) => {
    setFollowLatest(enabled);
  }, []);
  const selectPacket = useCallback(
    (id: number) => {
      if (id !== selected) setDissectorFailure(null);
      setSelected(id);
    },
    [selected],
  );
  const captureOrigin = useRef<number | null>(initial[0]?.time ?? null);
  const dissectionRecency = useRef(new Set<number>());
  const [keyRevision, setKeyRevision] = useState(0);
  const keysChanged = useCallback((revision: number) => {
    setKeyRevision(revision);
    dissectionRecency.current.clear();
    setDissectorFailure(null);
    setFrames((old) =>
      old.map((frame) => (frame.dissection ? { ...frame, dissection: undefined } : frame)),
    );
    setDecodeAttempt((value) => value + 1);
  }, []);
  // Live/demo history length, a user setting (read by long-lived listeners).
  const [frameHistory, setFrameHistory] = useState(loadFrameHistory);
  const frameHistoryRef = useRef(frameHistory);
  function chooseFrameHistory(limit: number) {
    saveFrameHistory(limit);
    frameHistoryRef.current = limit;
    setFrameHistory(limit);
    // A shorter history applies at once; imported captures stay complete.
    if (mode !== 'import') setFrames((old) => (old.length > limit ? old.slice(-limit) : old));
  }
  function replaceFrames(next: Frame[]) {
    captureOrigin.current = next[0]?.time ?? null;
    dissectionRecency.current.clear();
    setFrames(next);
  }
  const [backend, setBackend] = useState<'hackrf' | 'pluto'>('hackrf');
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const [iioSettings, setIioSettings] = useState<NonNullable<RadioConfig['iio']>>({
    uri: '',
    channel: 0,
    gain: 30,
    gainMode: 'manual',
    bandwidth: 0,
    adcBits: 12,
  });
  const [deviceSerial, setDeviceSerial] = useState('');
  const [bleFollow, setBleFollow] = useState(false);
  const [bleAuxFollow, setBleAuxFollow] = useState(false);
  const [blePeriodicFollow, setBlePeriodicFollow] = useState(false);
  const [loraSettings, setLoraSettings] = useState({ ...defaultLoraSettings });
  const [esbUi, setEsbUi] = useState({ ...defaultEsbUiSettings });
  const [blePhy, setBlePhy] = useState<BlePhy>('1m');
  const [blePrimaryPhy, setBlePrimaryPhy] = useState<BlePhy>('1m');
  const [bleAuxiliary, setBleAuxiliary] = useState(false);
  // A data channel receives everything by default: advertising-address
  // packets (test setups often advertise off channels 37-39) and connections
  // found from their own traffic.
  const [bleDiscover, setBleDiscover] = useState(true);
  const [lteBand, setLteBand] = useState(3),
    [lteUplink, setLteUplink] = useState(false),
    [lteBandwidth, setLteBandwidth] = useState(10);
  const [bleAddress, setBleAddress] = useState(''),
    [bleInit, setBleInit] = useState('');
  const [dissectorFailure, setDissectorFailure] = useState<{
    frame: Frame;
    message: string;
  } | null>(null);
  const [decodeAttempt, setDecodeAttempt] = useState(0);
  const contextFrames = useRef(frames);
  contextFrames.current = frames;
  const [catalog, setCatalog] = useState(false),
    [help, setHelp] = useState(false),
    [hexModal, setHexModal] = useState(false),
    [hexInput, setHexInput] = useState(''),
    [hexProtocol, setHexProtocol] = useState<Protocol>('zigbee'),
    [hexError, setHexError] = useState('');
  const [notice, setNotice] = useState(''),
    [packetDrops, setPacketDrops] = useState(0),
    [data, setData] = useState<SpectrumData | null>(null),
    [radioStatus, setRadioStatus] = useState<RadioStatus>({
      state: 'idle',
      message: 'Receiver idle',
    }),
    [device, setDevice] = useState<RadioDeviceInfo | null>(null),
    [fileName, setFileName] = useState(initialMode === 'live' ? 'Live capture' : 'Demo session');
  const fileRef = useRef<HTMLInputElement>(null),
    filterRef = useRef<HTMLInputElement>(null),
    packetScroll = useRef<HTMLDivElement>(null),
    nextId = useRef(initial.length + 1),
    receiverWanted = useRef(false),
    desiredTuning = useRef({ frequency: 2425, sampleRate: 8, mode, bleFollow: false, serial: '' });

  const presets = receiverPresets(profile.id);
  const preset = receiverPreset(profile.id, frequency);
  const channel = preset?.channel;
  const hasParser =
    profile.id === 'lora' || profile.id === 'lte' || presets.some((p) => p.decoder !== 'none');
  const widebandGuide = useMemo<ChannelGuide | undefined>(() => {
    if (profile.id === 'gps' && frequency === 1575.42)
      return {
        label: 'GPS L1 C/A · first nulls',
        spacingMHz: 2.046,
        deviationKHz: null,
        bandwidth: true,
      };
    if (profile.id === 'lora' && frequency >= 137 && frequency <= 2500)
      return {
        label: 'LoRa CSS',
        spacingMHz: loraSettings.bandwidth / 1e6,
        deviationKHz: null,
        bandwidth: true,
      };
    if (profile.id === 'wifi') {
      const channel = wifiChannels.find((p) => p.frequency === frequency);
      return channel
        ? {
            label: `Wi-Fi ${channel.band} CH ${channel.channel}`,
            spacingMHz: channel.bandwidth,
            deviationKHz: null,
            bandwidth: true,
          }
        : undefined;
    }
    if (profile.id === 'lte') {
      const band = lteBands.find((p) => p.band === lteBand)!;
      const range = lteUplink && band.uplink ? band.uplink : band.downlink;
      const n = lteEarfcn(range, frequency);
      if (n === null) return undefined;
      return {
        label: `LTE B${band.band} ${band.duplex === 'TDD' ? 'TDD' : lteUplink ? 'UL' : 'DL'}${n !== null ? ` · EARFCN ${n}` : ''}`,
        spacingMHz: lteBandwidth,
        deviationKHz: null,
        bandwidth: true,
      };
    }
  }, [profile.id, frequency, lteBand, lteUplink, lteBandwidth, loraSettings.bandwidth]);
  const bleDataChannel = profile.id === 'ble' && channel !== undefined && channel < 37;
  const connection =
    bleDataChannel && !bleAuxiliary && !bleDiscover
      ? parseBleConnection(bleAddress, bleInit)
      : null;
  const receiverBleAdvertising =
    profile.id === 'ble' &&
    bleDataChannel &&
    ((bleAuxiliary && !bleDiscover) || (bleDiscover && blePhy === 'coded'))
      ? true
      : undefined;
  // Connection discovery: LE 1M/2M only (LE Coded falls back to advertising).
  const receiverBleDiscover =
    profile.id === 'ble' && bleDataChannel && bleDiscover && blePhy !== 'coded' ? true : undefined;
  const bleAccessAddress = connection?.bleAccessAddress,
    bleCrcInit = connection?.bleCrcInit;
  // ESB: an empty address is promiscuous (CRC-16 only); a malformed one
  // turns decoding off rather than silently receiving every address.
  const esbAddress = parseEsbAddress(esbUi.address);
  const esbSettings = useMemo<RadioConfig['esb']>(
    () =>
      esbAddress === null
        ? undefined
        : esbAddress
          ? { rate: esbUi.rate, address: esbAddress, crc: esbUi.crc }
          : { rate: esbUi.rate, crc: 2 },
    [esbAddress, esbUi.rate, esbUi.crc],
  );
  const decoder: Protocol | 'none' =
    connection || receiverBleAdvertising || receiverBleDiscover
      ? 'ble'
      : profile.id === 'lora' && widebandGuide
        ? 'lora'
        : profile.id === 'lte' && !lteUplink && widebandGuide
          ? 'lte'
          : (preset?.decoder === 'wifi' && sampleRate !== 20) ||
              (preset?.decoder === 'esb' && !esbSettings) ||
              (preset?.decoder === 'dsrc' &&
                (sampleRate === 8 || (preset.channel === 0 && sampleRate !== 20)))
            ? 'none'
            : (preset?.decoder ?? 'none');
  const receiverBlePhy = decoder === 'ble' ? (bleDataChannel ? blePhy : blePrimaryPhy) : undefined;
  const receiverBleFollow =
    backend === 'hackrf' &&
    bleFollow &&
    decoder === 'ble' &&
    !bleDataChannel &&
    receiverBlePhy === '1m';
  const receiverBleAuxFollow =
    backend === 'hackrf' &&
    (bleAuxFollow || blePeriodicFollow) &&
    !receiverBleFollow &&
    decoder === 'ble' &&
    !bleDataChannel &&
    receiverBlePhy !== '2m';
  const receiverBlePeriodicFollow = blePeriodicFollow && receiverBleAuxFollow;
  const iqConfig = useMemo<RadioConfig>(
    () => ({
      frequency,
      sampleRate,
      lna,
      vga,
      ...(backend === 'hackrf' && amp ? { amp } : {}),
      ...(backend === 'hackrf' && antennaPower ? { antennaPower } : {}),
      decoder,
      lora: decoder === 'lora' ? loraSettings : undefined,
      esb: decoder === 'esb' ? esbSettings : undefined,
      bleAccessAddress,
      bleCrcInit,
      blePhy: receiverBlePhy,
      bleAdvertising: receiverBleAdvertising,
      bleDiscover: receiverBleDiscover,
      bleFollow: receiverBleFollow,
      bleAuxFollow: receiverBleAuxFollow,
      blePeriodicFollow: receiverBlePeriodicFollow,
      serial: backend === 'hackrf' ? deviceSerial || undefined : undefined,
      backend,
      iio: backend === 'pluto' ? iioSettings : undefined,
    }),
    [
      frequency,
      sampleRate,
      lna,
      vga,
      amp,
      antennaPower,
      decoder,
      bleAccessAddress,
      bleCrcInit,
      receiverBlePhy,
      receiverBleAdvertising,
      receiverBleDiscover,
      receiverBleFollow,
      receiverBleAuxFollow,
      receiverBlePeriodicFollow,
      loraSettings,
      esbSettings,
      deviceSerial,
      backend,
      iioSettings,
    ],
  );
  desiredTuning.current = {
    // Session changes take effect before asynchronous receiver shutdown.
    // Status updates during shutdown must not restore the old mode.
    ...desiredTuning.current,
    frequency,
    sampleRate,
    bleFollow: receiverBleFollow || receiverBleAuxFollow,
    serial: backend === 'hackrf' ? deviceSerial : '',
  };
  const needsDeviceSelection =
    backend === 'pluto'
      ? !device?.available || !iioSettings.uri
      : !device ||
        (!!device.serials &&
          ((!deviceSerial && device.serials.length > 1) ||
            device.serials.filter((serial) => serial === deviceSerial).length > 1));
  function applyDeviceInfo(info: RadioDeviceInfo) {
    if (backendRef.current !== 'hackrf') return;
    setDevice(info);
    // Preserve an explicit selection across unplug/reorder; never substitute another board.
    setDeviceSerial((current) => current || (info.serials?.length === 1 ? info.serials[0] : ''));
  }
  const following = mode === 'live' && receiverBleFollow ? radioStatus.follow : undefined;
  const auxiliary = mode === 'live' && receiverBleAuxFollow ? radioStatus.auxFollow : undefined;
  const periodic =
    mode === 'live' && receiverBlePeriodicFollow ? radioStatus.periodicFollow : undefined;
  const tracking = periodic ?? following ?? auxiliary;
  const displayFrequency = tracking ? tracking.frequencyHz / 1e6 : frequency;
  const demoProtocol: Protocol | undefined =
    preset?.decoder === 'none' ||
    preset?.decoder === 'wifi' ||
    preset?.decoder === 'gps' ||
    preset?.decoder === 'esb' ||
    preset?.decoder === 'dsrc'
      ? undefined
      : preset?.decoder;
  const liveActive = mode === 'live' && ['starting', 'streaming'].includes(radioStatus.state);
  const active = mode === 'demo' ? running : liveActive;
  const addressFilter = addressFilters[profile.id] ?? '';
  const addressEntries = useMemo(() => parseAddressFilter(addressFilter), [addressFilter]);
  const filtered = useMemo(() => {
    const search = query.toLowerCase();
    if (!search && integrity === 'all' && !addressEntries.length) return frames;
    return frames.filter(
      (f) =>
        (integrity === 'all' || f.integrity === integrity) &&
        matchesAddress(f, addressEntries) &&
        (!search ||
          `${f.protocol} ${f.source} ${f.destination} ${f.type} ${f.summary} ${f.id} `
            .toLowerCase()
            .concat(fieldSearchText(f.fields))
            .includes(search)),
    );
  }, [frames, query, integrity, addressEntries]);
  const selectedFrame = frames.find((f) => f.id === selected);
  const needsDissection =
    workspace === 'live' &&
    !!window.dissector &&
    !!selectedFrame &&
    nativeDissection(selectedFrame.protocol);
  // Pending is derived before paint: never show a provisional field tree.
  const inspectorLoading =
    needsDissection && !selectedFrame?.dissection && dissectorFailure?.frame !== selectedFrame;
  const decodeStatus =
    dissectorFailure && dissectorFailure.frame === selectedFrame
      ? `Detailed decoding failed · showing captured frame fields · ${dissectorFailure.message}`
      : '';
  const inspectorFrame = useMemo(
    () => (selectedFrame ? inspectedFrame(selectedFrame) : undefined),
    [selectedFrame],
  );
  const selectedConnection = connectionFromFrame(selectedFrame);
  useEffect(() => {
    if (!needsDissection || !window.dissector || !selectedFrame) return;
    if (selectedFrame.dissection) {
      touchDissection(dissectionRecency.current, selectedFrame.id);
      return;
    }
    let cancelled = false;
    const target = selectedFrame;
    const timer = setTimeout(() => {
      if (!contextFrames.current.includes(target)) return;
      window
        .dissector!.decode(
          dissectionRequest(
            contextFrames.current,
            target,
            equipmentProfiles.current.evidenceFor(target),
          ),
        )
        .then((dissection) => {
          if (cancelled) return;
          touchDissection(dissectionRecency.current, target.id);
          setFrames((old) => {
            return old.map((f) => {
              if (f === target) return { ...f, dissection };
              if (f.dissection && !dissectionRecency.current.has(f.id))
                return { ...f, dissection: undefined };
              return f;
            });
          });
        })
        .catch((error) => {
          if (!cancelled) setDissectorFailure({ frame: target, message: error.message });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void window.dissector?.stop();
    };
  }, [selectedFrame, needsDissection, decodeAttempt]);

  const errors = useMemo(() => frames.filter((f) => f.integrity === 'invalid').length, [frames]);
  const devices = useMemo(
    () => new Set(frames.map((f) => f.source).filter((s) => s !== '—')).size,
    [frames],
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!window.radio) return;
    window.radio
      .info()
      .then(applyDeviceInfo)
      .catch((e) => setNotice(`Device list unavailable: ${(e as Error).message}`));
    const a = window.radio.onSpectrum((event) => {
        if (surveyOwner.current) return;
        if (
          desiredTuning.current.mode === 'live' &&
          (!desiredTuning.current.serial ||
            !event.deviceSerial ||
            event.deviceSerial === desiredTuning.current.serial) &&
          (desiredTuning.current.bleFollow ||
            event.frequencyHz === Math.round(desiredTuning.current.frequency * 1e6)) &&
          event.sampleRateHz === desiredTuning.current.sampleRate * 1e6
        )
          setData(event);
      }),
      b = window.radio.onStatus((status) => {
        setRadioStatus(status);
        if (
          status.state === 'error' ||
          (status.state === 'idle' && (status.follow || status.auxFollow || status.periodicFollow))
        )
          receiverWanted.current = false;
      }),
      c = window.radio.onPackets(({ packets, dropped }) => {
        // Retain the final queued packets after native shutdown; status can arrive
        // before the renderer acknowledges the last packet batch.
        if (surveyOwner.current || desiredTuning.current.mode !== 'live') return;
        const decoded = packets
          .filter((packet) => packet.time >= resumePacketsAt.current)
          .map((packet) =>
            equipmentProfiles.current.apply({
              ...decode(packet.bytes, packet.protocol, {
                id: nextId.current++,
                time: packet.time / 1000,
                channel: packet.protocol.startsWith('enocean') ? null : packet.channel,
                origin: 'live',
                crcInit: packet.crcInit,
                bleRole: packet.bleRole,
                periodicEvent: packet.periodicEvent,
                bleAuxType: packet.bleAuxType,
                lteChannel: packet.lteChannel,
                lteRnti: packet.lteRnti,
                lora: packet.lora,
                ...esbPacketMetadata(packet),
                ...dsrcPacketMetadata(packet),
                fecErrors: packet.fecErrors,
              }),
              frequency: packet.frequencyHz / 1e6,
              iqRef: packet.iqRef,
              ...gpsMetadata(packet),
              firstSample: packet.firstSample,
              endSample: packet.endSample,
              phy: packetBlePhy(packet),
              bleDirection: packet.bleDirection,
              ...(packet.bleDiscovered ? { bleDiscovered: true } : {}),
              bleCteUs: packet.bleCteUs,
              bleCteComplete: packet.bleCteComplete,
              bleAuxType: packet.bleAuxType,
              lora: packet.lora,
              loraReplayEndSample: packet.loraReplayEndSample,
              ...(packet.protocol === 'lora'
                ? { integrity: packet.integrity ?? ('unchecked' as const) }
                : {}),
              wifiRateMbps: packet.wifiRateMbps,
              wifiPhy: packet.wifiPhy,
              wifiPreamble: packet.wifiPreamble,
              wifiHt: packet.wifiHt,
              ...(packet.protocol === 'lte'
                ? {
                    integrity: packet.integrity ?? ('unchecked' as const),
                    source: `PCI ${packet.ltePci}`,
                    ltePci: packet.ltePci,
                    ltePrb: packet.ltePrb,
                    ltePorts: packet.ltePorts,
                    lteSfn: packet.lteSfn,
                    lteTdd: packet.lteTdd,
                    lteChannel: packet.lteChannel,
                    lteRnti: packet.lteRnti,
                    lteSubframe: packet.lteSubframe,
                    lteMcs: packet.lteMcs,
                    lteRv: packet.lteRv,
                    lteContext: packet.lteContext,
                    lteTransportFirstSample: packet.lteTransportFirstSample,
                    lteTransportEndSample: packet.lteTransportEndSample,
                  }
                : {}),
              fecErrors: packet.fecErrors,
              deviceSerial: packet.deviceSerial,
              captureEpoch: packet.captureEpoch,
              timeUncertaintyUs: packet.timeUncertaintyUs,
              connectionEvent: packet.connectionEvent,
            }),
          );
        if (captureOrigin.current === null && decoded.length)
          captureOrigin.current = decoded[0].time;
        setFrames((old) => appendBounded(old, decoded, frameHistoryRef.current));
        setPacketDrops(dropped);
      });
    return () => {
      a();
      b();
      c();
    };
  }, []);
  useEffect(() => {
    if (mode !== 'live' || !receiverWanted.current || !window.radio) return;
    // Coalesce slider edits and serialize stop/configure/start in the native adapter.
    const timer = setTimeout(() => {
      if (!receiverWanted.current) return;
      // Opening a Forensics result starts its exact configuration; the state
      // updates that follow must not restart an identical receiver.
      if (receiverKey(iqConfig) === startedReceiver.current) return;
      setData(null);
      startReceiver(iqConfig).catch((error) => {
        receiverWanted.current = false;
        setRadioStatus({ state: 'error', message: error.message });
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [mode, iqConfig]);
  useEffect(() => {
    if (mode !== 'demo' || !running || !demoProtocol) return;
    const t = setInterval(() => {
      const f = demoFrame(nextId.current++, demoProtocol!, channel ?? profile.channel ?? 15);
      setFrames((old) => appendBounded(old, [f], frameHistoryRef.current));
    }, 450);
    return () => clearInterval(t);
  }, [mode, running, profile, channel, hasParser, demoProtocol]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setCatalog(false);
        setHexModal(false);
        setHelp(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        filterRef.current?.focus();
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!catalog && !hexModal && !help) return;
    const regions = document.querySelectorAll<HTMLElement>('.sidebar, .workspace, .statusbar');
    regions.forEach((region) => (region.inert = true));
    const dialog = document.querySelector<HTMLElement>('[role=dialog]');
    const targets = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]') ??
          [],
      ).filter((el) => !el.hasAttribute('disabled'));
    if (!dialog?.contains(document.activeElement)) targets()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = targets(),
        first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      regions.forEach((region) => (region.inert = false));
      document.removeEventListener('keydown', trap);
    };
  }, [catalog, hexModal, help]);
  function tune(value: number) {
    if (iqBusy) return;
    if (!Number.isFinite(value) || value < 1 || value > 6000) {
      setNotice('Choose a frequency from 1 to 6000 MHz.');
      setFrequencyInput(frequency.toFixed(3));
      return;
    }
    setFrequency(value);
    setFrequencyInput(value.toFixed(3));
    if (value !== frequency) setData(null);
    const next = receiverPreset(profile.id, value);
    if (mode === 'demo') {
      const supported =
        next &&
        next.decoder !== 'none' &&
        next.decoder !== 'wifi' &&
        next.decoder !== 'gps' &&
        next.decoder !== 'esb' &&
        next.decoder !== 'dsrc';
      replaceFrames(supported ? demoFrames(next.decoder as Protocol, next.channel) : []);
      if (!supported) setRunning(false);
      setSelected(null);
      nextId.current = 37;
      setFileName(`${profile.short} ${next?.phy ?? 'spectrum'} sample session`);
    }
  }
  // Live batches still queued in the main process arrive after stop(), so the
  // next mode is marked first. If stop() fails, the live session stays current.
  // A start still in flight when the source changes resolves afterwards:
  // stop it again rather than leave the radio streaming under another mode.
  async function startReceiver(config: RadioConfig) {
    startedReceiver.current = receiverKey(config);
    const request = sourceRequest.current;
    await window.radio!.start(config);
    if (
      request !== sourceRequest.current ||
      pendingSource.current ||
      desiredTuning.current.mode !== 'live'
    ) {
      startedReceiver.current = '';
      await window.radio!.stop();
    }
  }
  // The mode last applied to the UI. A failed stop returns the packet gate to
  // it, never to the value an earlier, still pending choice had set: that
  // left the gate on Demo while the UI showed HackRF live, dropping packets.
  const appliedMode = useRef(mode);
  function applyMode(value: typeof mode) {
    appliedMode.current = value;
    setMode(value);
  }
  async function stopForMode(next: typeof mode) {
    desiredTuning.current.mode = next;
    try {
      await window.radio?.stop();
    } catch (error) {
      desiredTuning.current.mode = appliedMode.current;
      throw error;
    }
  }
  async function chooseMode(value: 'demo' | 'live' | 'import', nextBackend = backend) {
    if (iqBusy) return;
    // Compare with the latest choice, never with this render's state: a
    // choice can be applied, or still awaiting the radio stop, before React
    // re-renders this handler. The latest choice is the one applied.
    const current = pendingSource.current ?? {
      mode: desiredTuning.current.mode,
      backend: backendRef.current,
    };
    if (value === current.mode && nextBackend === current.backend) return;
    const request = ++sourceRequest.current;
    pendingSource.current = { mode: value, backend: nextBackend };
    const backendChanged = nextBackend !== backendRef.current;
    receiverWanted.current = false;
    // Close the packet gate before awaiting shutdown, including live-to-live
    // changes of hardware. A pending stop must never mix two radio sessions.
    try {
      if (mode === 'live') await stopForMode(backendChanged ? 'import' : value);
    } finally {
      if (request === sourceRequest.current) pendingSource.current = null;
    }
    if (request !== sourceRequest.current) return;
    desiredTuning.current.mode = value;
    if (backendChanged) {
      backendRef.current = nextBackend;
      setBackend(nextBackend);
      setDevice(null);
      setBleFollow(false);
      setBleAuxFollow(false);
      setBlePeriodicFollow(false);
      if (nextBackend === 'hackrf')
        void window.radio
          ?.info()
          .then(applyDeviceInfo)
          .catch((error) => setNotice(`Device list unavailable: ${(error as Error).message}`));
    }
    setRunning(false);
    applyMode(value);
    changePacketFollow(value === 'live');
    setSelected(null);
    setData(null);
    setQuery('');
    setIntegrity('all');
    if (value === 'demo') {
      replaceFrames(demoProtocol ? demoFrames(demoProtocol, channel ?? profile.channel ?? 15) : []);
      setSelected(null);
      nextId.current = 37;
      setFileName(`${profile.short} sample session`);
    } else {
      replaceFrames([]);
      nextId.current = 1;
      setFileName(value === 'live' ? 'Live capture' : 'Imported capture');
    }
  }
  const recordIqRef = useRef<(seconds: number) => Promise<void>>(async () => {});
  recordIqRef.current = async (seconds) => {
    receiverWanted.current = false;
    if (mode !== 'live') await chooseMode('live');
    setData(null);
    setIqState(await window.iq!.start(iqConfig, seconds));
  };
  const recordIq = useCallback((seconds: number) => recordIqRef.current(seconds), []);
  async function chooseProfile(p: Profile) {
    if (iqBusy || surveyOwner.current) return;
    // Every profile sets its own rate so one protocol's choice never carries
    // into the next. BLE and the narrowband protocols use 8 MS/s: on air
    // (2026-11-22, DK sending numbered BLE 1M frames to a HackRF, one hour per
    // rate) 16 MS/s lost 2.6x as many frames as 8 MS/s through twice as many
    // USB overruns, used ~65% more CPU and was slightly less sensitive; 20 MS/s
    // adds bit errors in the samples. BLE following keeps 20 MS/s for its
    // shorter USB delivery interval (it caught more events than 16 MS/s).
    const following =
      p.id === 'ble' && backend === 'hackrf' && (bleFollow || bleAuxFollow || blePeriodicFollow);
    setSampleRate(p.id === 'wifi' || p.id === 'dsrc' || following ? 20 : 8);
    if (p.id === 'lte') {
      setLteBand(3);
      setLteUplink(false);
    }
    setProfile(p);
    setCatalog(false);
    tune(p.frequency);
    setRunning(false);
    setQuery('');
    setIntegrity('all');
    if (mode === 'demo') {
      const next = receiverPreset(p.id, p.frequency);
      replaceFrames(
        next &&
          next.decoder !== 'none' &&
          next.decoder !== 'wifi' &&
          next.decoder !== 'gps' &&
          next.decoder !== 'esb' &&
          next.decoder !== 'dsrc'
          ? demoFrames(next.decoder, next.channel)
          : [],
      );
      setSelected(null);
      nextId.current = 37;
      setFileName(`${p.short} sample session`);
    }
  }
  async function toggleCapture() {
    if (iqBusy) return;
    if (mode === 'demo') {
      if (!demoProtocol) {
        setNotice(
          'This profile has no demo decoder yet. Use live spectrum or choose a parser-enabled profile.',
        );
        return;
      }
      if (!running) changePacketFollow(true);
      setRunning(!running);
      return;
    }
    if (mode === 'import') {
      setNotice('Imported captures are static. Choose a receiver input for streaming.');
      return;
    }
    if (!window.radio) {
      setNotice('Live reception is available in the desktop app.');
      return;
    }
    try {
      if (receiverWanted.current || liveActive) {
        receiverWanted.current = false;
        await window.radio.stop();
      } else {
        receiverWanted.current = true;
        setData(null);
        await startReceiver(iqConfig);
      }
    } catch (e) {
      receiverWanted.current = false;
      setRadioStatus({ state: 'error', message: (e as Error).message });
    }
  }
  async function importCapture(file?: File) {
    if (!file || iqBusy) return;
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error('File exceeds 32 MB. Split the capture before import.');
      const report = { truncatedBytes: 0 };
      const loaded = readPcap(await file.arrayBuffer(), profile.id === 'zigbee', report);
      await surveyControls.current.stop();
      setWorkspace('live');
      receiverWanted.current = false;
      await stopForMode('import');
      setRunning(false);
      applyMode('import');
      nextId.current = loaded.length + 1;
      setData(null);
      replaceFrames(loaded);
      setSelected(null);
      changePacketFollow(false);
      setQuery('');
      setIntegrity('all');
      setFileName(file.name);
      setNotice(
        `Imported ${loaded.length} frames. Radio metadata is shown when the capture supplies it.${report.truncatedBytes ? ` The file ends partway through a record; its last ${report.truncatedBytes} bytes were ignored.` : ''}`,
      );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  function exportCapture() {
    try {
      const bytes = writePcap(filtered);
      const url = URL.createObjectURL(
        new Blob([bytes.buffer as ArrayBuffer], { type: 'application/vnd.tcpdump.pcap' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `airwolf-${mode}-${Date.now()}.pcap`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        `Exported ${filtered.length} visible frames${mode === 'demo' ? ' (synthetic demo)' : ''}.${filtered[0]?.protocol === 'ble' ? (new DataView(bytes.buffer).getUint32(20, true) === 256 ? (filtered.some((f) => f.bleRole === 'periodic-advertising') ? ' BLE radio subtype retained. PCAP does not retain periodic CRC init or event counters; use SigMF for complete IQ context.' : ' BLE radio metadata retained; include CONNECT_IND when exporting connection traffic for CRC context.') : ' BLE radio metadata was unavailable; exported raw link-layer frames.') : ''}`,
      );
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  async function importHex() {
    try {
      const f = decodeHex(hexInput, hexProtocol, 1);
      receiverWanted.current = false;
      await stopForMode('import');
      applyMode('import');
      nextId.current = 2;
      setData(null);
      setRunning(false);
      replaceFrames([f]);
      setSelected(1);
      setQuery('');
      setIntegrity('all');
      setFileName('Raw frame');
      setHexModal(false);
      setHexError('');
    } catch (e) {
      setHexError((e as Error).message);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Receiver settings">
        <div className="sidebar-brand">
          <div className="brand">
            <span className="brand-symbol">
              <img src="./airwolf-mark.png" alt="" className="brand-logo" />
            </span>
            AIRWOLF
            <span className="version" title={`Build ${buildRevision}`}>
              0.1
            </span>
          </div>
          <button
            className="icon-button"
            title="Workspace help"
            aria-label="Workspace help"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={15} />
          </button>
        </div>
        <button
          className={`nav-item ${workspace === 'live' ? 'active' : ''}`}
          onClick={() => void chooseWorkspace('live')}
        >
          <Activity size={17} /> Live analysis
        </button>
        <button
          className={`nav-item ${workspace === 'forensics' ? 'active' : ''}`}
          disabled={iqBusy}
          onClick={() => void chooseWorkspace('forensics')}
        >
          <Search size={17} /> Forensics
        </button>
        <button
          className={`nav-item ${workspace === 'iq' ? 'active' : ''}`}
          onClick={() => {
            // View IQ targets one frame; opening the workspace directly shows the newest take.
            setIqFocus(null);
            void chooseWorkspace('iq');
          }}
        >
          <Radio size={17} /> IQ Capture
        </button>
        <button
          className="nav-item"
          disabled={iqBusy || surveyActive}
          onClick={() => fileRef.current?.click()}
        >
          <FolderOpen size={17} /> Open capture
        </button>
        <button className="nav-item" onClick={() => setCatalog(true)}>
          <Layers size={17} /> Protocol catalog <span className="nav-count">{profiles.length}</span>
        </button>
        <div className="receiver-scroll">
          <fieldset className="receiver-locked" disabled={iqBusy || surveyActive}>
            <div className="sidebar-section-title">
              <span title={device?.details ?? (backend === 'pluto' ? 'Pluto+' : 'HackRF One')}>
                <i className={`dot ${device?.available ? 'green' : ''}`} />{' '}
                {backend === 'pluto' ? 'PLUTO+' : 'HACKRF ONE'}
              </span>
              <button
                className="icon-button"
                aria-label="Refresh device"
                title="Refresh device"
                onClick={() =>
                  window.radio
                    ?.info(
                      backend === 'pluto'
                        ? { backend: 'pluto', ...(iioSettings.uri ? { uri: iioSettings.uri } : {}) }
                        : undefined,
                    )
                    .then((d) => {
                      if (backend === 'pluto') {
                        if (backendRef.current === 'pluto') setDevice(d);
                      } else applyDeviceInfo(d);
                      setNotice(d.details);
                    })
                    .catch((e) => setNotice(`Device list unavailable: ${(e as Error).message}`))
                }
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <label className="control-label">
              Input source
              <select
                value={mode === 'live' && backend === 'pluto' ? 'pluto' : mode}
                onChange={(e) => {
                  const value = e.target.value;
                  void chooseMode(
                    value === 'pluto' ? 'live' : (value as typeof mode),
                    value === 'pluto' ? 'pluto' : value === 'live' ? 'hackrf' : backend,
                  ).catch((error) => setRadioStatus({ state: 'error', message: error.message }));
                }}
              >
                <option value="demo">Demo · synthetic packets</option>
                <option value="live">HackRF One · USB</option>
                <option value="pluto">Pluto+ · USB / Ethernet</option>
                <option value="import">Imported packets</option>
              </select>
            </label>
            {mode === 'live' && backend === 'pluto' && (
              <PlutoSettings
                initialInfo={device}
                value={iioSettings}
                onChange={setIioSettings}
                onDevice={setDevice}
              />
            )}
            {mode === 'live' &&
              backend === 'hackrf' &&
              (!!device?.serials?.length || deviceSerial) && (
                <label className="control-label">
                  Device{' '}
                  {device?.serials?.length
                    ? `· ${device.serials.length} connected`
                    : '· disconnected'}
                  <select
                    aria-label="HackRF device"
                    value={deviceSerial}
                    title={deviceSerial || 'Select a HackRF by serial number'}
                    onChange={(e) => setDeviceSerial(e.target.value)}
                  >
                    <option value="" disabled>
                      Select a HackRF
                    </option>
                    {deviceSerial && !device?.serials?.includes(deviceSerial) && (
                      <option value={deviceSerial}>
                        Disconnected · …{deviceSerial.slice(-12)}
                      </option>
                    )}
                    {device?.serials?.map((serial, index) => (
                      <option
                        key={`${serial}-${index}`}
                        value={serial}
                        title={serial}
                        disabled={device.serials!.filter((s) => s === serial).length > 1}
                      >
                        HackRF {index + 1} · …{serial.slice(-12)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            {mode === 'live' && backend === 'hackrf' && needsDeviceSelection && (
              <p className="tuning-note">
                {device?.serials?.some((serial, index) => device.serials!.indexOf(serial) !== index)
                  ? 'Duplicate serials: disconnect one board.'
                  : 'Select a HackRF to start.'}
              </p>
            )}
            <div className="sidebar-section-title">PROTOCOL</div>
            <div className="profile-buttons">
              {profiles
                .filter((p) =>
                  [
                    'zigbee',
                    'ble',
                    '15p4',
                    'esb',
                    'dsrc',
                    'enocean',
                    'wifi',
                    'lte',
                    'lora',
                    'gps',
                  ].includes(p.id),
                )
                .map((p) => (
                  <button
                    key={p.id}
                    className={profile.id === p.id ? 'selected' : ''}
                    onClick={() => void chooseProfile(p)}
                  >
                    {p.id === 'ble' ? <Bluetooth size={14} /> : <Wifi size={14} />}
                    <span>{p.short}</span>
                    {profile.id === p.id && <Check size={13} />}
                  </button>
                ))}
            </div>
            <label className="control-label">
              Center frequency <span>MHz</span>
              <div className="frequency-input">
                <input
                  aria-label="Center frequency MHz"
                  value={frequencyInput}
                  onChange={(e) => setFrequencyInput(e.target.value)}
                  onBlur={() => tune(Number(frequencyInput))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                <Radio size={14} />
              </div>
            </label>
            <label className="control-label">
              Sample rate
              <select
                aria-label="Sample rate"
                value={sampleRate}
                onChange={(e) => {
                  setSampleRate(Number(e.target.value));
                  setData(null);
                }}
              >
                {[8, 10, 16, 20].map((n) => (
                  <option
                    key={n}
                    value={n}
                    disabled={
                      (profile.id === 'gps' && n !== 8) ||
                      (profile.id === 'dsrc' && (n === 8 || (channel === 0 && n !== 20)))
                    }
                  >
                    {n}.0 MS/s
                  </option>
                ))}
              </select>
            </label>
            {!!presets.length && (
              <label className="control-label">
                {profile.id === 'enocean'
                  ? 'PHY / band'
                  : profile.id === 'wifi'
                    ? 'Wi-Fi channel'
                    : 'Decode channel'}
                <select
                  aria-label={
                    profile.id === 'enocean'
                      ? 'PHY / band'
                      : profile.id === 'wifi'
                        ? 'Wi-Fi channel'
                        : 'Decode channel'
                  }
                  value={preset?.value ?? ''}
                  onChange={(e) => {
                    const next = presets.find((p) => p.value === e.target.value);
                    if (next && profile.id === 'dsrc' && next.channel === 0) setSampleRate(20);
                    if (next) tune(next.frequency);
                  }}
                >
                  <option value="" disabled>
                    Off channel · spectrum only
                  </option>
                  {presets.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ProtocolPanel
              protocol={profile.short}
              address={{
                value: addressFilter,
                placeholder: addressExample(profile.id),
                onChange: (value) => setAddressFilters((all) => ({ ...all, [profile.id]: value })),
                fromSelected:
                  selectedFrame && selectedFrame.source !== '—'
                    ? () =>
                        setAddressFilters((all) => ({
                          ...all,
                          [profile.id]: selectedFrame.source,
                        }))
                    : undefined,
              }}
            >
              {profile.id === 'zigbee' && !!window.zigbeeKeys && (
                <ZigbeeKeys onRevision={keysChanged} />
              )}
              {profile.id === 'lora' && (
                <LoraSettings value={loraSettings} onChange={setLoraSettings} disabled={iqBusy} />
              )}
              {profile.id === 'esb' && (
                <EsbSettings value={esbUi} onChange={setEsbUi} disabled={iqBusy} />
              )}
              {profile.id === 'lte' && (
                <LteControls
                  band={lteBand}
                  uplink={lteUplink}
                  bandwidth={lteBandwidth}
                  frequency={frequency}
                  onBandwidth={setLteBandwidth}
                  onTune={tune}
                  onPlan={(id, up) => {
                    const band = lteBands.find((p) => p.band === id)!;
                    const uplink = up && !!band.uplink;
                    const range = uplink ? band.uplink! : band.downlink;
                    setLteBand(id);
                    setLteUplink(uplink);
                    tune(lteFrequency(range, Math.round((range[1] + range[2]) / 2))!);
                  }}
                />
              )}
              {profile.id === 'lte' && data?.decoder === 'lte' && data.lteBandwidthLimited && (
                <p className="tuning-note" role="status">
                  System information needs {data.lteRequiredSampleRateHz! / 1e6} MS/s.{' '}
                  <button
                    type="button"
                    disabled={iqBusy}
                    onClick={() => setSampleRate(data.lteRequiredSampleRateHz! / 1e6)}
                  >
                    Use {data.lteRequiredSampleRateHz! / 1e6} MS/s
                  </button>
                </p>
              )}
              {(profile.id === 'wifi' || profile.id === 'lte') && (
                <p className="tuning-note">
                  {profile.id === 'lte'
                    ? decoder === 'lte'
                      ? 'Native LTE MIB, system information and paging. Wide cells need enough sampled bandwidth; user traffic and LTE-M/NB-IoT are not implemented.'
                      : 'Uplink spectrum only; SC-FDMA reception is not implemented.'
                    : decoder === 'wifi'
                      ? 'Native DSSS/CCK, legacy OFDM and single-stream HT20. Wider channels, VHT/HE/EHT and Wi-Fi decryption are not implemented.'
                      : preset?.decoder === 'wifi'
                        ? 'Select 20 MS/s for Wi-Fi packet reception.'
                        : 'Spectrum only on this channel; its PHY is not implemented.'}
                  {widebandGuide && widebandGuide.spacingMHz > sampleRate
                    ? ` ${sampleRate} MHz of the ${widebandGuide.spacingMHz} MHz channel is sampled.`
                    : ''}
                  {profile.id === 'wifi' &&
                  widebandGuide &&
                  frequency + widebandGuide.spacingMHz / 2 > 6000
                    ? ' The channel extends beyond HackRF’s 6 GHz RF range.'
                    : ''}
                </p>
              )}
              {profile.id === 'ble' && !bleDataChannel && decoder === 'ble' && (
                <label className="control-label">
                  BLE PHY
                  <select
                    aria-label="BLE PHY"
                    value={blePrimaryPhy}
                    onChange={(e) => setBlePrimaryPhy(e.target.value as BlePhy)}
                  >
                    <option value="1m">LE 1M</option>
                    <option value="2m">LE 2M</option>
                    <option value="coded">LE Coded · S2/S8 auto</option>
                  </select>
                </label>
              )}
              {backend === 'hackrf' &&
                profile.id === 'ble' &&
                !bleDataChannel &&
                decoder === 'ble' &&
                receiverBlePhy === '1m' && (
                  <label
                    className="ble-follow-control"
                    title="Experimental following from a fresh CONNECT_IND, including verified interval/window and symmetric PHY updates. USB retuning misses events. Stops on encryption, subrate, unresolvable timing or unsupported asymmetric PHY changes."
                  >
                    <input
                      type="checkbox"
                      checked={receiverBleFollow}
                      onChange={(e) => {
                        setBleFollow(e.target.checked);
                        if (e.target.checked) {
                          setBleAuxFollow(false);
                          setBlePeriodicFollow(false);
                          setSampleRate(20);
                        }
                      }}
                    />
                    Follow new connection
                  </label>
                )}
              {backend === 'hackrf' &&
                profile.id === 'ble' &&
                !bleDataChannel &&
                decoder === 'ble' &&
                receiverBlePhy !== '2m' && (
                  <label
                    className="ble-follow-control"
                    title="Experimental auxiliary advertising capture. USB retuning can miss short pointer windows; skipped and missed windows are counted."
                  >
                    <input
                      type="checkbox"
                      checked={receiverBleAuxFollow}
                      onChange={(e) => {
                        setBleAuxFollow(e.target.checked);
                        if (!e.target.checked) setBlePeriodicFollow(false);
                        if (e.target.checked) {
                          setBleFollow(false);
                          setSampleRate(20);
                        }
                      }}
                    />
                    Follow auxiliary advertising
                  </label>
                )}
              {backend === 'hackrf' &&
                profile.id === 'ble' &&
                !bleDataChannel &&
                decoder === 'ble' &&
                receiverBlePhy !== '2m' && (
                  <label
                    className="ble-follow-control"
                    title="Follow one periodic advertising train from observed SyncInfo, including supported auxiliary chains. USB retuning can miss events. PAwR and ACAD updates are not supported."
                  >
                    <input
                      type="checkbox"
                      checked={receiverBlePeriodicFollow}
                      onChange={(e) => {
                        setBlePeriodicFollow(e.target.checked);
                        if (e.target.checked) {
                          setBleAuxFollow(true);
                          setBleFollow(false);
                          setSampleRate(20);
                        }
                      }}
                    />
                    Follow periodic advertising
                  </label>
                )}
              {profile.id === 'ble' && (bleDataChannel || selectedConnection) && (
                <div className="ble-connection">
                  {bleDataChannel && (
                    <>
                      <label className="control-label">
                        Receive
                        <select
                          aria-label="BLE receive mode"
                          value={
                            bleDiscover ? 'discover' : bleAuxiliary ? 'advertising' : 'connection'
                          }
                          onChange={(e) => {
                            setBleAuxiliary(e.target.value === 'advertising');
                            setBleDiscover(e.target.value === 'discover');
                          }}
                        >
                          <option value="discover">Advertising + find connections</option>
                          <option value="advertising">Advertising only</option>
                          <option value="connection">Connection data</option>
                        </select>
                      </label>
                      <label className="control-label">
                        BLE PHY
                        <select
                          aria-label="BLE PHY"
                          value={blePhy}
                          onChange={(e) => setBlePhy(e.target.value as BlePhy)}
                        >
                          <option value="1m">LE 1M</option>
                          <option value="2m">LE 2M</option>
                          <option value="coded">LE Coded · S2/S8 auto</option>
                        </select>
                      </label>
                      {!bleAuxiliary && !bleDiscover && (
                        <div className="connection-inputs">
                          <label className="control-label">
                            Access address
                            <input
                              aria-label="BLE access address"
                              placeholder="AA08192B"
                              value={bleAddress}
                              maxLength={10}
                              onChange={(e) => setBleAddress(e.target.value)}
                              spellCheck={false}
                            />
                          </label>
                          <label className="control-label">
                            CRC init
                            <input
                              aria-label="BLE CRC init"
                              placeholder="C4C181"
                              value={bleInit}
                              maxLength={8}
                              onChange={(e) => setBleInit(e.target.value)}
                              spellCheck={false}
                            />
                          </label>
                        </div>
                      )}
                      <p className="connection-note">
                        {bleDiscover && blePhy === 'coded'
                          ? `${blePhyLabel(blePhy)} · advertising packets · finding connections needs LE 1M or LE 2M`
                          : bleDiscover
                            ? `${blePhyLabel(blePhy)} · advertising packets, and connections found from their traffic: one appears once two of its packets agree on access address and CRC init. Select one and use it below.`
                            : bleAuxiliary
                              ? `${blePhyLabel(blePhy)} · advertising access address · fixed channel`
                              : connection
                                ? `${blePhyLabel(blePhy)} · fixed channel · no hopping`
                                : 'Enter connection hex values to decode. Spectrum only until set.'}
                      </p>
                    </>
                  )}
                  {selectedConnection && (
                    <button
                      className="button"
                      onClick={() => {
                        setBleAddress(selectedConnection.address);
                        setBleInit(selectedConnection.crc);
                        setBlePhy(
                          'discovered' in selectedConnection ? selectedConnection.phy : '1m',
                        );
                        setBleAuxiliary(false);
                        setBleDiscover(false);
                        if (!bleDataChannel || !selectedConnection.channels.includes(channel!))
                          tune(bleFrequency(selectedConnection.channels[0])!);
                        setNotice(
                          'Connection settings loaded. Fixed-channel reception. To follow a new connection, enable following on an advertising channel.',
                        );
                      }}
                    >
                      {'discovered' in selectedConnection
                        ? 'Use selected connection'
                        : 'Use selected CONNECT_IND'}
                    </button>
                  )}
                </div>
              )}
            </ProtocolPanel>
            {backend === 'hackrf' && (
              <div className="gain-control">
                <label htmlFor="lna">
                  LNA gain <span>{lna} dB</span>
                </label>
                <input
                  id="lna"
                  type="range"
                  min="0"
                  max="40"
                  step="8"
                  value={lna}
                  onChange={(e) => setLna(Number(e.target.value))}
                />
                <label htmlFor="vga">
                  VGA gain <span>{vga} dB</span>
                </label>
                <input
                  id="vga"
                  type="range"
                  min="0"
                  max="62"
                  step="2"
                  value={vga}
                  onChange={(e) => setVga(Number(e.target.value))}
                />
                <label
                  className="check"
                  title="Front-end amplifier, +14 dB and a lower noise figure. Can overload next to strong transmitters."
                >
                  <input type="checkbox" checked={amp} onChange={(e) => setAmp(e.target.checked)} />{' '}
                  RF amp (+14 dB)
                </label>
                <label
                  className="check"
                  title="3.3 V on the antenna port for active antennas such as GPS patches. Never with a DC-shorted antenna or a direct connection to test equipment."
                >
                  <input
                    type="checkbox"
                    checked={antennaPower}
                    onChange={(e) => setAntennaPower(e.target.checked)}
                  />{' '}
                  Antenna power (3.3 V)
                </label>
              </div>
            )}
          </fieldset>
        </div>
        {(mode !== 'import' || workspace === 'forensics') && (
          <div className="receiver-actions">
            {' '}
            <button
              className="button primary"
              disabled={
                iqBusy ||
                ((mode === 'live' || workspace === 'forensics') && !active && needsDeviceSelection)
              }
              onClick={() => {
                if (workspace === 'forensics') {
                  if (surveyActive)
                    void surveyControls.current.stop().catch((e) => setNotice(e.message));
                  else surveyControls.current.start();
                } else void toggleCapture();
              }}
            >
              {(workspace === 'forensics' ? surveyActive : active) ? (
                mode === 'demo' ? (
                  <Pause size={14} />
                ) : (
                  <Square size={13} />
                )
              ) : (
                <Play size={14} />
              )}{' '}
              {workspace === 'forensics'
                ? surveyActive
                  ? 'Stop scan'
                  : 'Start scan'
                : active
                  ? mode === 'demo'
                    ? 'Pause demo'
                    : 'Stop receiver'
                  : mode === 'demo'
                    ? 'Run demo'
                    : 'Start receiver'}
            </button>
          </div>
        )}
        {mode === 'live' && (
          <p className="tuning-note">Receiver changes briefly restart reception.</p>
        )}
      </aside>
      <Forensics
        visible={workspace === 'forensics'}
        protocol={profile.id}
        band={lteBand}
        config={iqConfig}
        onControls={registerSurveyControls}
        onBegin={async () => {
          surveyOwner.current = true;
          receiverWanted.current = false;
          setSurveyActive(true);
          setRunning(false);
          // A scan is a new live session: frames from an imported or demo
          // session must not mix with what the scan receives.
          if (appliedMode.current !== 'live') {
            replaceFrames([]);
            setSelected(null);
            nextId.current = 1;
            setFileName('Live capture');
          }
          await stopForMode('live');
          applyMode('live');
          setData(null);
        }}
        onEnd={() => {
          resumePacketsAt.current = Date.now();
          surveyOwner.current = false;
          setSurveyActive(false);
        }}
        onOpen={async (target: SurveyTarget) => {
          receiverWanted.current = false;
          await chooseMode('live');
          await chooseProfile(profiles.find((p) => p.id === target.protocol)!);
          if (target.protocol === 'lte') {
            setLteBand(target.lteBand ?? lteBand);
            setLteUplink(false);
          }
          if (target.protocol === 'ble') {
            setBleFollow(false);
            setBleAuxFollow(false);
            setBlePeriodicFollow(false);
            if (target.config.decoder === 'none') {
              setBleAddress('');
              setBleInit('');
              setBleAuxiliary(false);
            }
          }
          setFrequency(target.config.frequency);
          setFrequencyInput(target.config.frequency.toFixed(3));
          setSampleRate(target.config.sampleRate);
          if (target.config.blePhy)
            setBlePrimaryPhy(target.config.blePhy === 'coded' ? 'coded' : '1m');
          replaceFrames([]);
          setSelected(null);
          setData(null);
          // The scan row holds the radio it was scanned with; open it on the
          // receiver selected now.
          const current = backendRef.current;
          if (current === 'pluto' && !iioSettings.uri)
            throw new Error('Choose a Pluto receiver before opening this result');
          // Same receiver: keep the scan's own gain (Find activity sets it per
          // emission). Another receiver: use its sidebar settings.
          const same = (target.config.backend ?? 'hackrf') === current;
          await startReceiver(
            same
              ? {
                  ...target.config,
                  serial: current === 'hackrf' ? deviceSerial || undefined : undefined,
                  iio: current === 'pluto' ? iioSettings : undefined,
                }
              : {
                  ...target.config,
                  backend: current,
                  serial: current === 'hackrf' ? deviceSerial || undefined : undefined,
                  iio: current === 'pluto' ? iioSettings : undefined,
                  lna,
                  vga,
                  amp: current === 'hackrf' && amp ? true : undefined,
                  antennaPower: current === 'hackrf' && antennaPower ? true : undefined,
                },
          );
          receiverWanted.current = true;
          setWorkspace('live');
        }}
      />
      {workspace === 'forensics' ? null : workspace === 'iq' ? (
        <IqCapture
          keyRevision={keyRevision}
          state={iqState}
          focus={iqFocus}
          config={iqConfig}
          onNotice={setNotice}
          onRecord={recordIq}
        />
      ) : (
        <SpectrumSplit
          spectrum={{
            frequency:
              mode === 'live' && (receiverBleFollow || receiverBleAuxFollow) && data
                ? data.frequencyHz / 1e6
                : frequency,
            sampleRate,
            profile: profile.id,
            blePhy: data?.blePhy ?? (bleDataChannel ? blePhy : blePrimaryPhy),
            channelGuide: widebandGuide,
            running: active,
            mode,
            data,
            selected: selectedFrame,
            onTune: tune,
          }}
        >
          <PacketSplit expanded={inspectorExpanded} onResize={() => setInspectorExpanded(false)}>
            <section
              id="packet-list-pane"
              className="panel packet-panel"
              aria-label="Captured packets"
            >
              <div className="panel-heading">
                <div className="panel-title">
                  <ListFilter size={15} /> Packets{' '}
                  <span className="tag">{frames.length.toLocaleString()}</span>
                  {mode === 'demo' && <span className="tag">Synthetic</span>}
                </div>
                <div className="filter-bar">
                  <label className="search">
                    <Search size={14} />
                    <input
                      ref={filterRef}
                      aria-label="Filter packets"
                      placeholder="Filter by text, address, protocol…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <kbd>⌘ / Ctrl K</kbd>
                  </label>
                  <select
                    aria-label="Integrity filter"
                    value={integrity}
                    onChange={(e) => setIntegrity(e.target.value)}
                  >
                    <option value="all">All integrity states</option>
                    <option value="valid">CRC / FCS correct</option>
                    <option value="invalid">CRC / FCS incorrect</option>
                    <option value="unchecked">Not checked</option>
                  </select>
                  <button
                    className="icon-button"
                    aria-label="Decode raw hex frame"
                    title="Decode raw hex frame"
                    onClick={() => {
                      setHexModal(true);
                      setHexError('');
                    }}
                  >
                    <FileCode2 size={16} />
                  </button>
                </div>
                <div className="panel-actions">
                  {mode !== 'import' && (
                    <button
                      className={`text-button follow-latest ${followLatest ? 'selected' : ''}`}
                      aria-pressed={followLatest}
                      aria-label="Follow latest"
                      onClick={() => changePacketFollow(!followLatest)}
                      title="Scroll to new packets without changing the inspector. Scroll up to pause; return to the bottom to resume."
                    >
                      <ListEnd size={14} /> Follow
                    </button>
                  )}
                  <div className="segmented">
                    <button
                      aria-pressed={view === 'table'}
                      className={view === 'table' ? 'selected' : ''}
                      onClick={() => setView('table')}
                    >
                      Table
                    </button>
                    <button
                      aria-pressed={view === 'frames'}
                      className={view === 'frames' ? 'selected' : ''}
                      onClick={() => setView('frames')}
                    >
                      Frames
                    </button>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => {
                      setFrames([]);
                      setSelected(null);
                      changePacketFollow(mode !== 'import');
                    }}
                    disabled={!frames.length}
                    aria-label="Clear packets"
                    title="Clear all packets from this list. Reception continues."
                  >
                    <Trash2 size={14} /> Clear
                  </button>
                  <button
                    className="text-button"
                    aria-label="Export PCAP"
                    onClick={exportCapture}
                    disabled={!filtered.length}
                  >
                    <ArrowDownToLine size={14} /> Export
                  </button>
                </div>
              </div>
              {profile.id === 'gps' && (
                <GpsStatus
                  satellites={data?.decoder === 'gps' ? data.gpsSatellites : undefined}
                  running={liveActive}
                />
              )}
              <div className="packet-scroll" ref={packetScroll}>
                <PacketTable
                  frames={filtered}
                  selectedId={selectedFrame?.id}
                  timeOrigin={captureOrigin.current ?? 0}
                  view={view}
                  onSelect={selectPacket}
                  scrollRef={packetScroll}
                  followLatest={mode !== 'import' && followLatest}
                  followEnabled={mode !== 'import'}
                  onFollowChange={changePacketFollow}
                />
                {!filtered.length && (
                  <div className="empty">
                    <Radio size={22} />
                    <strong>
                      {mode === 'live'
                        ? frames.length
                          ? 'No matching packets'
                          : active
                            ? 'Waiting for packets'
                            : 'Receiver stopped'
                        : frames.length
                          ? 'No matching packets'
                          : 'No packets in this session'}
                    </strong>
                    <span>
                      {mode === 'live'
                        ? frames.length
                          ? 'Try another address or integrity filter.'
                          : !active
                            ? 'Choose a channel and start the receiver, or open a saved capture.'
                            : decoder === 'none'
                              ? profile.id === 'wifi' ||
                                profile.id === 'lte' ||
                                profile.id === 'lora'
                                ? 'No packet receiver is active at these settings. Check the channel, link direction and sample rate.'
                                : profile.id === 'ble' && channel !== undefined && channel < 37
                                  ? `Enter the connection access address and CRC init to decode data on channel ${channel}.`
                                  : profile.id === 'dsrc' && preset
                                    ? preset.channel === 0
                                      ? 'All DSRC channels need 20 MS/s; choose 20 MS/s or a single channel.'
                                      : 'CEN DSRC needs 10, 16 or 20 MS/s; choose a higher sample rate.'
                                    : profile.id === 'esb' && preset
                                      ? 'Enter a 3–5 byte hex ESB address, or clear it for promiscuous reception.'
                                      : 'Choose a supported decode channel or EnOcean PHY / band to enable decoding.'
                              : decoder === 'gps'
                                ? 'Acquiring GPS satellites. A complete LNAV subframe needs six seconds after synchronization; allow time for acquisition.'
                                : decoder === 'lte'
                                  ? 'Searching for an LTE downlink cell and CRC-verified broadcast MIB.'
                                  : decoder === 'dsrc'
                                    ? `Listening for CEN DSRC downlink and uplink frames on ${channel === 0 ? 'all four channels (5797.5–5812.5 MHz)' : `channel ${channel} (${displayFrequency.toFixed(1)} MHz)`}. Receive-only; tolling traffic appears only near an active roadside unit.`
                                    : decoder === 'esb'
                                      ? `Listening for Nordic ESB at ${esbRateLabel(esbSettings!.rate)} on channel ${channel} (${displayFrequency.toFixed(0)} MHz)${esbSettings!.address ? ` for address ${esbSettings!.address.toUpperCase()}.` : '. Promiscuous: an address appears after two CRC-valid frames from it.'} Match the data rate and channel.`
                                      : decoder === 'lora'
                                        ? `Listening for LoRa at ${displayFrequency.toFixed(3)} MHz. Match bandwidth, sync word and chirp polarity; Auto listens for SF7–12.`
                                        : decoder === 'enocean2'
                                          ? `Listening for EnOcean ERP2 FSK telegrams at ${displayFrequency.toFixed(3)} MHz.`
                                          : decoder === 'enocean'
                                            ? 'Listening for EnOcean ERP1 ASK telegrams at 868.3 MHz. Adjust receiver gain to match the signal.'
                                            : `Listening on channel ${channel}. ${decoder === 'ble' ? (connection ? `${blePhyLabel(blePhy)} data; fixed channel.` : `${blePhyLabel(receiverBlePhy ?? '1m')} advertising.`) : decoder === 'wifi' ? 'Legacy DSSS/CCK and non-HT OFDM frames.' : '250 kbps O-QPSK frames.'} Match the transmitter channel and adjust receiver gain.`
                        : frames.length
                          ? 'Try another address or integrity filter.'
                          : hasParser
                            ? 'Open a PCAP or decode a raw hex frame.'
                            : profile.id === 'wifi' ||
                                profile.id === 'lte' ||
                                profile.id === 'lora' ||
                                profile.id === 'gps'
                              ? 'No packet receiver is active at these settings. Check the channel, link direction and sample rate.'
                              : 'This protocol is planned. Its tuning preset is available for spectrum analysis.'}
                    </span>
                  </div>
                )}
              </div>
              <div className="table-footer">
                <span>
                  {filtered.length} of {frames.length} frames · {devices} sources · {errors}{' '}
                  integrity errors <span className="divider-text">|</span>{' '}
                  {mode === 'import' ? (
                    'Imported capture'
                  ) : (
                    <label className="frame-history">
                      Latest{' '}
                      <select
                        aria-label="Live frame history"
                        title="How many of the newest live frames are kept. Older frames are discarded; long histories use more memory (large Wi-Fi frames about 12 kB each)."
                        value={frameHistory}
                        onChange={(e) => chooseFrameHistory(Number(e.target.value))}
                      >
                        {FRAME_HISTORY_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n.toLocaleString('en-US')}
                          </option>
                        ))}
                      </select>{' '}
                      frames
                    </label>
                  )}
                  {mode === 'live' &&
                    ` · ${packetDrops + (data?.packetQueueDrops ?? 0)} delivery drops`}
                </span>
                <span>
                  {selectedFrame
                    ? `Selected #${selectedFrame.id} · ${selectedFrame.bytes.length} bytes`
                    : 'No frame selected'}
                </span>
              </div>
            </section>
            <Inspector
              expanded={inspectorExpanded}
              onExpand={() => setInspectorExpanded(!inspectorExpanded)}
              frame={inspectorFrame}
              loading={inspectorLoading}
              onNotice={setNotice}
              iqRetrieving={iqRetrieving}
              onViewIq={
                selectedFrame?.iqRef && window.iq
                  ? async () => {
                      setIqRetrieving(true);
                      try {
                        const focus = await window.iq!.frame(selectedFrame.iqRef!);
                        setIqState(await window.iq!.list());
                        setIqFocus(focus);
                        setWorkspace('iq');
                      } catch (e) {
                        setNotice((e as Error).message);
                      } finally {
                        setIqRetrieving(false);
                      }
                    }
                  : undefined
              }
              decodeStatus={decodeStatus}
              onRetry={
                decodeStatus
                  ? () => {
                      setDissectorFailure(null);
                      setDecodeAttempt((attempt) => attempt + 1);
                    }
                  : undefined
              }
            />
          </PacketSplit>
        </SpectrumSplit>
      )}
      <footer className="statusbar" aria-label="Capture status">
        <span className={`session-badge ${mode === 'live' && active ? 'live' : ''}`}>
          <i className="dot" />
          {mode === 'demo'
            ? 'DEMO'
            : mode === 'live'
              ? backend === 'pluto'
                ? 'PLUTO RX'
                : 'HACKRF RX'
              : 'IMPORTED'}
        </span>
        <strong className="status-file" title={fileName}>
          {fileName}
        </strong>
        <span
          className={`status-message ${mode === 'live' && radioStatus.state === 'error' ? 'error' : ''}`}
          role={mode === 'live' && radioStatus.state === 'error' ? 'alert' : undefined}
          aria-live="polite"
          title={
            mode === 'live'
              ? `${radioStatus.message}${periodic ? ` · ${periodic.message} · ${periodic.verifiedEvents} verified events · ${periodic.verifiedChains} chains · ${periodic.skippedWindows} late · ${periodic.missedWindows} missed · ${periodic.ambiguousPackets} unresolved` : following ? ` · ${following.verifiedEvents} verified events · ${following.skippedEvents} skipped` : auxiliary ? ` · ${auxiliary.observedPointers} pointers · ${auxiliary.verifiedPackets} verified · ${auxiliary.skippedLate} late · ${auxiliary.missedWindows} missed · ${auxiliary.rejectedPointers} rejected` : ''}`
              : undefined
          }
        >
          {mode === 'demo'
            ? `Demo ${running ? 'running' : 'paused'} · synthetic ${demoProtocol ? 'frames & spectrum' : 'spectrum only'}`
            : mode === 'import'
              ? 'Packet bytes · no IQ'
              : periodic
                ? `${periodic.message} · ${periodic.verifiedEvents} verified · ${periodic.verifiedChains} chains · ${periodic.skippedWindows} late · ${periodic.missedWindows} missed`
                : following
                  ? ['waiting', 'acquiring', 'tracking'].includes(following.state)
                    ? `${following.state === 'waiting' ? 'Awaiting CONNECT_IND' : following.state === 'acquiring' ? 'Acquiring connection' : 'Following connection'} · ${following.verifiedEvents} verified · ${following.skippedEvents} skipped`
                    : following.message
                  : auxiliary
                    ? `${auxiliary.state === 'waiting' ? 'Awaiting auxiliary pointer' : auxiliary.state === 'receiving' ? 'Receiving auxiliary advertising' : auxiliary.message} · ${auxiliary.verifiedPackets} verified · ${auxiliary.skippedLate} late · ${auxiliary.missedWindows} missed`
                    : radioStatus.state === 'error'
                      ? radioStatus.message
                      : !window.radio
                        ? 'USB reception requires the desktop app'
                        : `${radioStatus.state === 'streaming' ? 'Live' : radioStatus.state === 'starting' ? 'Starting' : 'Receiver idle'} · ${decoder === 'none' ? 'spectrum only' : 'spectrum & packets · experimental'}`}
        </span>
        <span className="status-right">
          {mode === 'import' ? (
            'Channel / RSSI unknown'
          ) : (
            <>
              {profile.short}
              {periodic
                ? ` · ${blePhyLabel(periodic.phy)} · ${periodic.state}`
                : following
                  ? ` · ${blePhyLabel(following.phy ?? '1m')} · ${following.state}`
                  : auxiliary
                    ? ` · ${blePhyLabel(auxiliary.phy)} · ${auxiliary.state}`
                    : receiverBlePhy
                      ? ` · ${blePhyLabel(receiverBlePhy)} · ${connection ? 'fixed data channel' : receiverBleAdvertising ? 'fixed auxiliary advertising' : 'advertising'}`
                      : preset
                        ? ` · ${preset.phy}${decoder === 'esb' ? ` · ${esbRateLabel(esbSettings!.rate)}` : ''}`
                        : ''}
              {channel !== undefined && profile.id !== 'enocean'
                ? profile.id === 'dsrc' && channel === 0
                  ? ' · CH 1–4'
                  : ` · CH ${tracking?.channel ?? channel}`
                : ''}{' '}
              <span className="divider-text">|</span> {displayFrequency.toFixed(3)} MHz{' '}
              <span className="divider-text">|</span> {sampleRate}.0 MS/s
            </>
          )}
          <span className="divider-text">|</span> RX ONLY
        </span>
      </footer>
      <input
        hidden
        ref={fileRef}
        type="file"
        accept=".pcap,.cap"
        onChange={(e) => void importCapture(e.target.files?.[0])}
      />
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {catalog && (
        <Catalog onClose={() => setCatalog(false)} onSelect={(p) => void chooseProfile(p)} />
      )}
      {hexModal && (
        <div className="modal-backdrop" onClick={() => setHexModal(false)}>
          <section
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hex-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">FRAME LAB</span>
                <h2 id="hex-title">Decode raw bytes</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close raw frame decoder"
                onClick={() => setHexModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>
              802.15.4: MAC frame including FCS. BLE: dewhitened access address, advertising or data
              PDU, and CRC. Data CRC needs connection context. EnOcean: raw ERP1 subtelegram
              including HASH. ERP2: length byte + radio data, including CRC when present. No
              preamble.
            </p>
            <select
              aria-label="Raw frame protocol"
              value={hexProtocol}
              onChange={(e) => setHexProtocol(e.target.value as Protocol)}
            >
              <option value="zigbee">Zigbee over IEEE 802.15.4</option>
              <option value="15p4">IEEE 802.15.4 MAC</option>
              <option value="ble">BLE link layer</option>
              <option value="enocean">EnOcean ERP1 radio subtelegram</option>
              <option value="enocean2">EnOcean ERP2 length + radio data</option>
            </select>
            <textarea
              autoFocus
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              placeholder="61 88 01 CD AB 00 00 41 19 …"
              aria-label="Frame hex bytes"
            />
            <p className="error">{hexError}</p>
            <button className="button primary" onClick={() => void importHex()}>
              <FileCode2 size={15} /> Decode frame
            </button>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow" aria-label="Airwolf build">
                  AIRWOLF 0.1 · {buildRevision}
                </span>
                <h2 id="help-title">A closer look at the air.</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close help"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="help-step">
              <Activity size={20} />
              <div>
                <strong>Explore a demo</strong>
                <p>
                  Run synthetic packets, switch to Frames to see the field layout, and select fields
                  to highlight their bytes.
                </p>
              </div>
            </div>
            <div className="help-step">
              <FolderOpen size={20} />
              <div>
                <strong>Bring your captures</strong>
                <p>
                  Open supported PCAP captures or enter raw frame bytes. Select a frame to inspect
                  its decoded layers and byte ranges. Zigbee keys can authenticate and decrypt
                  supported secured frames; other encrypted payloads remain opaque.
                </p>
              </div>
            </div>
            <div className="help-step">
              <Antenna size={20} />
              <div>
                <strong>Connect a receiver</strong>
                <p>
                  Connect your receiver and select HackRF One or Pluto+ as the input source. Choose
                  a decode channel, then start the receiver. Experimental native decoders support
                  BLE 1M advertisements, fixed-channel BLE 1M / 2M / Coded data, 2.4 GHz 802.15.4
                  O-QPSK, and EnOcean ERP1 / ERP2. Receiver changes briefly restart reception.
                </p>
              </div>
            </div>
            <div className="help-step">
              <BookOpen size={20} />
              <div>
                <strong>Track protocol support</strong>
                <p>
                  The catalog lists decoder availability for each protocol. The parsers cover
                  limited frame formats with experimental live reception; remaining protocols are
                  planned.
                </p>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
