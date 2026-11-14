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
import { inspectedFrame, flattenFields } from './lib/dissection';
import { profiles, type Profile } from './lib/protocols';
import { bleFrequency, blePhyLabel, receiverPreset, receiverPresets } from './lib/receiver';
import { connectionFromFrame, parseBleConnection } from './lib/ble-connection';
import type {
  BlePhy,
  Frame,
  Protocol,
  RadioStatus,
  RadioDeviceInfo,
  SpectrumData,
} from './lib/types';
// Desktop starts idle with no fabricated traffic. Browser previews have no USB bridge.
const initialMode = window.radio ? 'live' : 'demo';
const initial = initialMode === 'demo' ? demoFrames() : [];
export default function App() {
  const [profile, setProfile] = useState(profiles.find((p) => p.id === 'zigbee')!),
    [mode, setMode] = useState<'demo' | 'live' | 'import'>(initialMode);
  const [frames, setFrames] = useState<Frame[]>(initial),
    [selected, setSelected] = useState<number | null>(null),
    [running, setRunning] = useState(false);
  const [frequency, setFrequency] = useState(2425),
    [frequencyInput, setFrequencyInput] = useState('2425.000'),
    [sampleRate, setSampleRate] = useState(8),
    [lna, setLna] = useState(16),
    [vga, setVga] = useState(20);
  const [query, setQuery] = useState(''),
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
  function replaceFrames(next: Frame[]) {
    captureOrigin.current = next[0]?.time ?? null;
    dissectionRecency.current.clear();
    setFrames(next);
  }
  const [deviceSerial, setDeviceSerial] = useState('');
  const [bleFollow, setBleFollow] = useState(false);
  const [blePhy, setBlePhy] = useState<BlePhy>('1m');
  const [blePrimaryPhy, setBlePrimaryPhy] = useState<BlePhy>('1m');
  const [bleAuxiliary, setBleAuxiliary] = useState(false);
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
  const hasParser = profile.id === 'lte' || presets.some((p) => p.decoder !== 'none');
  const widebandGuide = useMemo<ChannelGuide | undefined>(() => {
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
  }, [profile.id, frequency, lteBand, lteUplink, lteBandwidth]);
  const bleDataChannel = profile.id === 'ble' && channel !== undefined && channel < 37;
  const connection =
    bleDataChannel && !bleAuxiliary ? parseBleConnection(bleAddress, bleInit) : null;
  const receiverBleAdvertising =
    profile.id === 'ble' && bleDataChannel && bleAuxiliary ? true : undefined;
  const bleAccessAddress = connection?.bleAccessAddress,
    bleCrcInit = connection?.bleCrcInit;
  const decoder: Protocol | 'none' =
    connection || receiverBleAdvertising
      ? 'ble'
      : profile.id === 'lte' && !lteUplink && widebandGuide
        ? 'lte'
        : preset?.decoder === 'wifi' && sampleRate !== 20
          ? 'none'
          : (preset?.decoder ?? 'none');
  const receiverBlePhy = decoder === 'ble' ? (bleDataChannel ? blePhy : blePrimaryPhy) : undefined;
  const receiverBleFollow =
    bleFollow && decoder === 'ble' && !bleDataChannel && receiverBlePhy === '1m';
  desiredTuning.current = {
    frequency,
    sampleRate,
    mode,
    bleFollow: receiverBleFollow,
    serial: deviceSerial,
  };
  const needsDeviceSelection =
    !!device?.serials &&
    ((!deviceSerial && device.serials.length > 1) ||
      device.serials.filter((serial) => serial === deviceSerial).length > 1);
  function applyDeviceInfo(info: RadioDeviceInfo) {
    setDevice(info);
    // Preserve an explicit selection across unplug/reorder; never substitute another board.
    setDeviceSerial((current) => current || (info.serials?.length === 1 ? info.serials[0] : ''));
  }
  const following = mode === 'live' && receiverBleFollow ? radioStatus.follow : undefined;
  const displayFrequency = following ? following.frequencyHz / 1e6 : frequency;
  const demoProtocol: Protocol | undefined =
    preset?.decoder === 'none' || preset?.decoder === 'wifi' ? undefined : preset?.decoder;
  const liveActive = mode === 'live' && ['starting', 'streaming'].includes(radioStatus.state);
  const active = mode === 'demo' ? running : liveActive;
  const filtered = useMemo(() => {
    const search = query.toLowerCase();
    if (!search && integrity === 'all') return frames;
    return frames.filter(
      (f) =>
        (integrity === 'all' || f.integrity === integrity) &&
        (!search ||
          `${f.protocol} ${f.source} ${f.destination} ${f.type} ${f.summary} ${f.id} ${flattenFields(
            f.fields,
          )
            .map((field) => field.value)
            .join(' ')}`
            .toLowerCase()
            .includes(search)),
    );
  }, [frames, query, integrity]);
  const selectedFrame = frames.find((f) => f.id === selected);
  const needsDissection =
    !!window.dissector && !!selectedFrame && !selectedFrame.protocol.startsWith('enocean');
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
      const context = contextFrames.current.filter(
        (f) =>
          (f.protocol === target.protocol ||
            (['zigbee', '15p4'].includes(f.protocol) &&
              ['zigbee', '15p4'].includes(target.protocol))) &&
          !f.protocol.startsWith('enocean') &&
          f.hasFcs === target.hasFcs,
      );
      const index = context.indexOf(target);
      if (index < 0) return;
      window
        .dissector!.decode({
          frames: context.map(({ protocol, hasFcs, bytes, time }) => ({
            protocol,
            hasFcs,
            bytes,
            time,
          })),
          selected: index,
        })
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
    window.radio.info().then(applyDeviceInfo);
    const a = window.radio.onSpectrum((event) => {
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
        if (status.state === 'error' || (status.state === 'idle' && status.follow))
          receiverWanted.current = false;
      }),
      c = window.radio.onPackets(({ packets, dropped }) => {
        // Retain the final queued packets after native shutdown; status can arrive
        // before the renderer acknowledges the last packet batch.
        if (desiredTuning.current.mode !== 'live') return;
        const decoded = packets.map((packet) => ({
          ...decode(packet.bytes, packet.protocol, {
            id: nextId.current++,
            time: packet.time / 1000,
            channel: packet.protocol.startsWith('enocean') ? null : packet.channel,
            origin: 'live',
            crcInit: packet.crcInit,
          }),
          frequency: packet.frequencyHz / 1e6,
          firstSample: packet.firstSample,
          endSample: packet.endSample,
          phy: packet.phy,
          wifiRateMbps: packet.wifiRateMbps,
          ...(packet.protocol === 'lte'
            ? {
                integrity: packet.integrity ?? ('unchecked' as const),
                source: `PCI ${packet.ltePci}`,
                ltePci: packet.ltePci,
                ltePrb: packet.ltePrb,
                ltePorts: packet.ltePorts,
                lteSfn: packet.lteSfn,
                lteTdd: packet.lteTdd,
              }
            : {}),
          fecErrors: packet.fecErrors,
          deviceSerial: packet.deviceSerial,
          captureEpoch: packet.captureEpoch,
          timeUncertaintyUs: packet.timeUncertaintyUs,
          connectionEvent: packet.connectionEvent,
        }));
        if (captureOrigin.current === null && decoded.length)
          captureOrigin.current = decoded[0].time;
        setFrames((old) => [...old, ...decoded].slice(-2000));
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
      setData(null);
      window
        .radio!.start({
          frequency,
          sampleRate,
          lna,
          vga,
          decoder,
          bleAccessAddress,
          bleCrcInit,
          blePhy: receiverBlePhy,
          bleAdvertising: receiverBleAdvertising,
          bleFollow: receiverBleFollow,
          serial: deviceSerial || undefined,
        })
        .catch((error) => {
          receiverWanted.current = false;
          setRadioStatus({ state: 'error', message: error.message });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [
    frequency,
    sampleRate,
    lna,
    vga,
    mode,
    decoder,
    bleAccessAddress,
    bleCrcInit,
    receiverBlePhy,
    receiverBleAdvertising,
    receiverBleFollow,
    deviceSerial,
  ]);
  useEffect(() => {
    if (mode !== 'demo' || !running || !demoProtocol) return;
    const t = setInterval(() => {
      const f = demoFrame(nextId.current++, demoProtocol!, channel ?? profile.channel ?? 15);
      setFrames((old) => [...old, f].slice(-2000));
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
      const supported = next && next.decoder !== 'none' && next.decoder !== 'wifi';
      replaceFrames(supported ? demoFrames(next.decoder as Protocol, next.channel) : []);
      if (!supported) setRunning(false);
      setSelected(null);
      nextId.current = 37;
      setFileName(`${profile.short} ${next?.phy ?? 'spectrum'} sample session`);
    }
  }
  async function chooseMode(value: 'demo' | 'live' | 'import') {
    if (value === mode) return;
    receiverWanted.current = false;
    if (mode === 'live') await window.radio?.stop();
    setRunning(false);
    setMode(value);
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
  async function chooseProfile(p: Profile) {
    if (p.id === 'wifi') setSampleRate(20);
    if (p.id === 'lte') setSampleRate(8);
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
        next && next.decoder !== 'none' && next.decoder !== 'wifi'
          ? demoFrames(next.decoder, next.channel)
          : [],
      );
      setSelected(null);
      nextId.current = 37;
      setFileName(`${p.short} sample session`);
    }
  }
  async function toggleCapture() {
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
      setNotice('Imported captures are static. Choose Demo or HackRF for streaming.');
      return;
    }
    if (!window.radio) {
      setNotice('USB capture is available in the desktop app. Run npm run desktop.');
      return;
    }
    try {
      if (receiverWanted.current || liveActive) {
        receiverWanted.current = false;
        await window.radio.stop();
      } else {
        receiverWanted.current = true;
        setData(null);
        await window.radio.start({
          frequency,
          sampleRate,
          lna,
          vga,
          decoder,
          bleAccessAddress,
          bleCrcInit,
          blePhy: receiverBlePhy,
          bleAdvertising: receiverBleAdvertising,
          bleFollow: receiverBleFollow,
          serial: deviceSerial || undefined,
        });
      }
    } catch (e) {
      receiverWanted.current = false;
      setRadioStatus({ state: 'error', message: (e as Error).message });
    }
  }
  async function importCapture(file?: File) {
    if (!file) return;
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error('File exceeds 32 MB. Split the capture before import.');
      const loaded = readPcap(await file.arrayBuffer(), profile.id === 'zigbee');
      receiverWanted.current = false;
      await window.radio?.stop();
      setRunning(false);
      setMode('import');
      setData(null);
      replaceFrames(loaded);
      setSelected(null);
      changePacketFollow(false);
      setQuery('');
      setIntegrity('all');
      setFileName(file.name);
      setNotice(
        `Imported ${loaded.length} frames. Classic PCAP does not include channel or RSSI metadata.`,
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
        `Exported ${filtered.length} visible frames${mode === 'demo' ? ' (synthetic demo)' : ''}.`,
      );
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  async function importHex() {
    try {
      const f = decodeHex(hexInput, hexProtocol, 1);
      receiverWanted.current = false;
      await window.radio?.stop();
      setMode('import');
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
            AIRWOLF<span className="version">0.1</span>
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
        <button className="nav-item" onClick={() => fileRef.current?.click()}>
          <FolderOpen size={17} /> Open capture
        </button>
        <button className="nav-item" onClick={() => setCatalog(true)}>
          <Layers size={17} /> Protocol catalog <span className="nav-count">{profiles.length}</span>
        </button>
        <div className="sidebar-section-title">
          <span title={device?.details ?? 'HackRF One'}>
            <i className={`dot ${device?.available ? 'green' : ''}`} /> HACKRF ONE
          </span>
          <button
            className="icon-button"
            aria-label="Refresh device"
            title="Refresh device"
            onClick={() =>
              window.radio?.info().then((d) => {
                applyDeviceInfo(d);
                setNotice(d.details);
              })
            }
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <label className="control-label">
          Input source
          <select value={mode} onChange={(e) => void chooseMode(e.target.value as typeof mode)}>
            <option value="demo">Demo · synthetic packets</option>
            <option value="live">HackRF One · USB</option>
            <option value="import">Imported packets</option>
          </select>
        </label>
        {mode === 'live' && (!!device?.serials?.length || deviceSerial) && (
          <label className="control-label">
            Device{' '}
            {device?.serials?.length ? `· ${device.serials.length} connected` : '· disconnected'}
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
                <option value={deviceSerial}>Disconnected · …{deviceSerial.slice(-12)}</option>
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
        {mode === 'live' && needsDeviceSelection && (
          <p className="tuning-note">
            {device?.serials?.some((serial, index) => device.serials!.indexOf(serial) !== index)
              ? 'Duplicate serials: disconnect one board.'
              : 'Select a HackRF to start.'}
          </p>
        )}
        <div className="sidebar-section-title">PROTOCOL</div>
        <div className="profile-buttons">
          {profiles
            .filter((p) => ['zigbee', 'ble', '15p4', 'enocean', 'wifi', 'lte'].includes(p.id))
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
              <option key={n} value={n}>
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
        {(profile.id === 'wifi' || profile.id === 'lte') && (
          <p className="tuning-note">
            {profile.id === 'lte'
              ? decoder === 'lte'
                ? 'Native LTE cell search and CRC-verified MIB reception. PDSCH/SIB, paging and user traffic are not implemented.'
                : 'Uplink spectrum only; SC-FDMA reception is not implemented.'
              : decoder === 'wifi'
                ? 'Native non-HT OFDM · 6–54 Mb/s. DSSS, HT/VHT/HE and decryption are not implemented.'
                : preset?.decoder === 'wifi'
                  ? 'Select 20 MS/s for OFDM packet reception.'
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
              <option value="coded">LE Coded · S2/S8 auto</option>
            </select>
          </label>
        )}
        {profile.id === 'ble' &&
          !bleDataChannel &&
          decoder === 'ble' &&
          receiverBlePhy === '1m' && (
            <label
              className="ble-follow-control"
              title="Experimental LE 1M following from a fresh CONNECT_IND. USB retuning misses events. Stops on encryption, timing or PHY changes."
            >
              <input
                type="checkbox"
                checked={receiverBleFollow}
                onChange={(e) => {
                  setBleFollow(e.target.checked);
                  if (e.target.checked) setSampleRate(20);
                }}
              />
              Follow new connection
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
                    value={bleAuxiliary ? 'advertising' : 'connection'}
                    onChange={(e) => setBleAuxiliary(e.target.value === 'advertising')}
                  >
                    <option value="connection">Connection data</option>
                    <option value="advertising">Auxiliary advertising</option>
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
                {!bleAuxiliary && (
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
                  {bleAuxiliary
                    ? `${blePhyLabel(blePhy)} · auxiliary advertising · fixed channel`
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
                  setBlePhy('1m');
                  setBleAuxiliary(false);
                  if (!bleDataChannel || !selectedConnection.channels.includes(channel!))
                    tune(bleFrequency(selectedConnection.channels[0])!);
                  setNotice(
                    'Connection settings loaded. Fixed-channel reception. To follow a new connection, enable following on an advertising channel.',
                  );
                }}
              >
                Use selected CONNECT_IND
              </button>
            )}
          </div>
        )}
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
        </div>
        {mode !== 'import' && (
          <div className="receiver-actions">
            {' '}
            <button
              className="button primary"
              disabled={mode === 'live' && !active && needsDeviceSelection}
              onClick={() => void toggleCapture()}
            >
              {active ? (
                mode === 'demo' ? (
                  <Pause size={14} />
                ) : (
                  <Square size={13} />
                )
              ) : (
                <Play size={14} />
              )}{' '}
              {active
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
      <SpectrumSplit
        spectrum={{
          frequency:
            mode === 'live' && receiverBleFollow && data ? data.frequencyHz / 1e6 : frequency,
          sampleRate,
          profile: profile.id,
          blePhy: bleDataChannel ? blePhy : blePrimaryPhy,
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
                            ? profile.id === 'wifi' || profile.id === 'lte'
                              ? 'No packet receiver is active at these settings. Check the channel, link direction and sample rate.'
                              : profile.id === 'ble' && channel !== undefined && channel < 37
                                ? `Enter the connection access address and CRC init to decode data on channel ${channel}.`
                                : 'Choose a supported decode channel or EnOcean PHY / band to enable decoding.'
                            : decoder === 'lte'
                              ? 'Searching for an LTE downlink cell and CRC-verified broadcast MIB.'
                              : decoder === 'enocean2'
                                ? `Listening for EnOcean ERP2 FSK telegrams at ${displayFrequency.toFixed(3)} MHz.`
                                : decoder === 'enocean'
                                  ? 'Listening for EnOcean ERP1 ASK telegrams at 868.3 MHz. Adjust receiver gain to match the signal.'
                                  : `Listening on channel ${channel}. ${decoder === 'ble' ? (connection ? `${blePhyLabel(blePhy)} data; fixed channel.` : `${blePhyLabel(receiverBlePhy ?? '1m')} advertising.`) : decoder === 'wifi' ? 'Non-HT OFDM frames.' : '250 kbps O-QPSK frames.'} Match the transmitter channel and adjust receiver gain.`
                      : frames.length
                        ? 'Try another address or integrity filter.'
                        : hasParser
                          ? 'Open a PCAP or decode a raw hex frame.'
                          : profile.id === 'wifi' || profile.id === 'lte'
                            ? 'No packet receiver is active at these settings. Check the channel, link direction and sample rate.'
                            : 'This protocol is planned. Its tuning preset is available for spectrum analysis.'}
                  </span>
                </div>
              )}
            </div>
            <div className="table-footer">
              <span>
                {filtered.length} of {frames.length} frames · {devices} sources · {errors} CRC/FCS
                errors <span className="divider-text">|</span>{' '}
                {mode === 'import' ? 'Imported capture' : 'Latest 2,000 frames'}
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
      <footer className="statusbar" aria-label="Capture status">
        <span className={`session-badge ${mode === 'live' && active ? 'live' : ''}`}>
          <i className="dot" />
          {mode === 'demo' ? 'DEMO' : mode === 'live' ? 'HACKRF RX' : 'IMPORTED'}
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
              ? `${radioStatus.message}${following ? ` · ${following.verifiedEvents} verified events · ${following.skippedEvents} skipped` : ''}`
              : undefined
          }
        >
          {mode === 'demo'
            ? `Demo ${running ? 'running' : 'paused'} · synthetic ${demoProtocol ? 'frames & spectrum' : 'spectrum only'}`
            : mode === 'import'
              ? 'Packet bytes · no IQ'
              : following
                ? ['waiting', 'acquiring', 'tracking'].includes(following.state)
                  ? `${following.state === 'waiting' ? 'Awaiting CONNECT_IND' : following.state === 'acquiring' ? 'Acquiring connection' : 'Following connection'} · ${following.verifiedEvents} verified · ${following.skippedEvents} skipped`
                  : following.message
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
              {following
                ? ` · LE 1M · ${following.state}`
                : connection
                  ? ` · ${blePhyLabel(blePhy)} · fixed data channel`
                  : preset
                    ? ` · ${preset.phy}`
                    : ''}
              {channel !== undefined && profile.id !== 'enocean'
                ? ` · CH ${following?.channel ?? channel}`
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
                <span className="eyebrow">AIRWOLF 0.1</span>
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
                  Open classic PCAP with link types 195, 230, 251, or Airwolf EnOcean (USER0).
                  Export filtered frames back to PCAP. PCAPNG and encrypted payload decoding are
                  pending.
                </p>
              </div>
            </div>
            <div className="help-step">
              <Antenna size={20} />
              <div>
                <strong>Connect a HackRF One</strong>
                <p>
                  Connect your receiver and select HackRF One · USB as the input source. Choose a
                  decode channel, then start the receiver. Experimental native decoders support BLE
                  1M advertisements, fixed-channel BLE 1M / 2M / Coded data, 2.4 GHz 802.15.4
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
