import { useEffect, useMemo, useRef, useState } from 'react';
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
import Spectrum from './components/Spectrum';
import Inspector from './components/Inspector';
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
const initial = demoFrames();
export default function App() {
  const [profile, setProfile] = useState(profiles[0]),
    [mode, setMode] = useState<'demo' | 'live' | 'import'>('demo');
  const [frames, setFrames] = useState<Frame[]>(initial),
    [selected, setSelected] = useState(3),
    [running, setRunning] = useState(false);
  const [frequency, setFrequency] = useState(2425),
    [frequencyInput, setFrequencyInput] = useState('2425.000'),
    [sampleRate, setSampleRate] = useState(8),
    [lna, setLna] = useState(16),
    [vga, setVga] = useState(20);
  const [query, setQuery] = useState(''),
    [integrity, setIntegrity] = useState('all'),
    [view, setView] = useState<'table' | 'frames'>('table');
  const [followLatest, setFollowLatest] = useState(false);
  const packetFollowWanted = useRef(false);
  function changePacketFollow(enabled: boolean) {
    packetFollowWanted.current = enabled;
    setFollowLatest(enabled);
  }
  const [deviceSerial, setDeviceSerial] = useState('');
  const [bleFollow, setBleFollow] = useState(false);
  const [blePhy, setBlePhy] = useState<BlePhy>('1m');
  const [bleAddress, setBleAddress] = useState(''),
    [bleInit, setBleInit] = useState('');
  const [packetEngine, setPacketEngine] = useState<'builtin' | 'wireshark'>('builtin');
  const [dissectorInfo, setDissectorInfo] = useState({
    available: false,
    details: 'Built-in packet fields',
  });
  const [dissectorStatus, setDissectorStatus] = useState('');
  const contextFrames = useRef(frames);
  contextFrames.current = frames;
  useEffect(() => {
    window.dissector
      ?.info()
      .then((info) => {
        setDissectorInfo(info);
        if (info.available) setPacketEngine('wireshark');
      })
      .catch(() => setDissectorInfo({ available: false, details: 'Wireshark unavailable' }));
  }, []);
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
    [fileName, setFileName] = useState('Zigbee sensor network');
  const fileRef = useRef<HTMLInputElement>(null),
    filterRef = useRef<HTMLInputElement>(null),
    packetScroll = useRef<HTMLDivElement>(null),
    nextId = useRef(37),
    receiverWanted = useRef(false),
    desiredTuning = useRef({ frequency: 2425, sampleRate: 8, mode, bleFollow: false, serial: '' });

  const presets = receiverPresets(profile.id);
  const preset = receiverPreset(profile.id, frequency);
  const channel = preset?.channel;
  const hasParser = presets.length > 0;
  const bleDataChannel = profile.id === 'ble' && channel !== undefined && channel < 37;
  const connection = bleDataChannel ? parseBleConnection(bleAddress, bleInit) : null;
  const bleAccessAddress = connection?.bleAccessAddress,
    bleCrcInit = connection?.bleCrcInit;
  const decoder: Protocol | 'none' = connection ? 'ble' : (preset?.decoder ?? 'none');
  const receiverBlePhy = decoder === 'ble' ? (connection ? blePhy : '1m') : undefined;
  const receiverBleFollow = bleFollow && decoder === 'ble' && !bleDataChannel;
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
    preset?.decoder === 'none' ? undefined : preset?.decoder;
  const liveActive = mode === 'live' && ['starting', 'streaming'].includes(radioStatus.state);
  const active = mode === 'demo' ? running : liveActive;
  const filtered = useMemo(
    () =>
      frames.filter(
        (f) =>
          (integrity === 'all' ||
            inspectedFrame(f, packetEngine === 'wireshark').integrity === integrity) &&
          `${f.protocol} ${f.source} ${f.destination} ${f.type} ${f.summary} ${f.dissection?.summary ?? ''} ${f.id} ${flattenFields(
            f.dissection?.fields ?? f.fields,
          )
            .map((field) => field.value)
            .join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [frames, query, integrity, packetEngine],
  );
  const selectedFrame = filtered.find((f) => f.id === selected) ?? filtered[0];
  const selectedConnection = connectionFromFrame(selectedFrame);
  useEffect(() => {
    setDissectorStatus('');
    if (packetEngine !== 'wireshark' || !window.dissector || !selectedFrame) return;
    if (selectedFrame.protocol.startsWith('enocean')) {
      setDissectorStatus('Built-in EnOcean decoder');
      return;
    }
    if (selectedFrame.dissection) return;
    let cancelled = false;
    const target = selectedFrame;
    setDissectorStatus('Built-in fields · loading Wireshark…');
    const timer = setTimeout(() => {
      const context = contextFrames.current.filter(
        (f) =>
          (f.protocol === 'ble') === (target.protocol === 'ble') &&
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
          setFrames((old) => {
            let cached = 0;
            return old.map((f) => {
              if (f === target) return { ...f, dissection };
              if (f.dissection && ++cached > 31) return { ...f, dissection: undefined };
              return f;
            });
          });
          setDissectorStatus('');
        })
        .catch((error) => {
          if (!cancelled) setDissectorStatus(`Built-in fields · ${error.message}`);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void window.dissector?.stop();
    };
  }, [selectedFrame, packetEngine]);

  const newestId = filtered.at(-1)?.id;
  useEffect(() => {
    if (!followLatest || !packetFollowWanted.current || newestId === undefined) return;
    setSelected(newestId);
    const list = packetScroll.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [followLatest, newestId]);
  const errors = frames.filter(
    (f) => inspectedFrame(f, packetEngine === 'wireshark').integrity === 'invalid',
  ).length;
  const devices = new Set(frames.map((f) => f.source).filter((s) => s !== '—')).size;
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
          fecErrors: packet.fecErrors,
          deviceSerial: packet.deviceSerial,
          captureEpoch: packet.captureEpoch,
          timeUncertaintyUs: packet.timeUncertaintyUs,
          connectionEvent: packet.connectionEvent,
        }));
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
    setData(null);
    const next = receiverPreset(profile.id, value);
    if (mode === 'demo') {
      const supported = next && next.decoder !== 'none';
      setFrames(supported ? demoFrames(next.decoder as Protocol, next.channel) : []);
      if (!supported) setRunning(false);
      setSelected(3);
      nextId.current = 37;
      setFileName(`${profile.short} ${next?.phy ?? 'spectrum'} sample session`);
    }
  }
  async function chooseMode(value: 'demo' | 'live' | 'import') {
    receiverWanted.current = false;
    if (mode === 'live') await window.radio?.stop();
    setRunning(false);
    setMode(value);
    setData(null);
    setQuery('');
    setIntegrity('all');
    if (value === 'demo') {
      setFrames(demoProtocol ? demoFrames(demoProtocol, channel ?? profile.channel ?? 15) : []);
      setSelected(3);
      nextId.current = 37;
      setFileName(`${profile.short} sample session`);
    } else {
      setFrames([]);
      nextId.current = 1;
      setFileName(value === 'live' ? 'Live capture' : 'Imported capture');
    }
  }
  async function chooseProfile(p: Profile) {
    setProfile(p);
    setCatalog(false);
    tune(p.frequency);
    setRunning(false);
    setQuery('');
    setIntegrity('all');
    if (mode === 'demo') {
      const next = receiverPreset(p.id, p.frequency);
      setFrames(next && next.decoder !== 'none' ? demoFrames(next.decoder, next.channel) : []);
      setSelected(3);
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
      setFrames(loaded);
      setSelected(loaded[0]?.id ?? 0);
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
      setFrames([f]);
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
          <Layers size={17} /> Protocol catalog <span className="nav-count">14</span>
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
            <option value="demo">Demo session</option>
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
            .filter((p) => ['zigbee', 'ble', '15p4', 'enocean'].includes(p.id))
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
        {hasParser && (
          <label className="control-label">
            {profile.id === 'enocean' ? 'PHY / band' : 'Decode channel'}
            <select
              aria-label={profile.id === 'enocean' ? 'PHY / band' : 'Decode channel'}
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
        {profile.id === 'ble' && !bleDataChannel && decoder === 'ble' && (
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
                <p className="connection-note">
                  {connection
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
      <main className="workspace" aria-label="Spectrum and packet analysis">
        <Spectrum
          frequency={
            mode === 'live' && receiverBleFollow && data ? data.frequencyHz / 1e6 : frequency
          }
          sampleRate={sampleRate}
          running={active}
          mode={mode}
          data={data}
          selected={selectedFrame}
          onTune={tune}
        />
        <section className="panel packet-panel" aria-label="Captured packets">
          <div className="panel-heading">
            <div className="panel-title">
              <ListFilter size={15} /> Packets{' '}
              <span className="tag">{frames.length.toLocaleString()}</span>
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
                  title="Select and scroll to each new packet. Selecting an older frame pauses following; reception continues."
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
                  setSelected(0);
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
          <div
            className="packet-scroll"
            ref={packetScroll}
            onPointerDownCapture={() => changePacketFollow(false)}
            onScroll={(event) => {
              const list = event.currentTarget;
              if (
                packetFollowWanted.current &&
                list.scrollHeight - list.clientHeight - list.scrollTop > 2
              )
                changePacketFollow(false);
            }}
          >
            <table className={view === 'frames' ? 'frame-table' : ''}>
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Time (s)</th>
                  <th>Protocol</th>
                  {view === 'table' ? (
                    <>
                      <th>Source</th>
                      <th>Destination</th>
                      <th>Type / info</th>
                    </>
                  ) : (
                    <th className="frame-column">Decoded frame structure</th>
                  )}
                  <th>Length</th>
                  <th>RSSI</th>
                  <th>FCS / CRC</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((rawFrame) => {
                  const f = inspectedFrame(rawFrame, packetEngine === 'wireshark');
                  return (
                    <tr
                      key={f.id}
                      className={f.id === selectedFrame?.id ? 'selected' : ''}
                      onClick={() => {
                        changePacketFollow(false);
                        setSelected(f.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          changePacketFollow(false);
                          setSelected(f.id);
                        }
                      }}
                      tabIndex={0}
                      aria-selected={f.id === selectedFrame?.id}
                    >
                      <td className="packet-number">{f.id.toString().padStart(4, '0')}</td>
                      <td>{(f.time - (frames[0]?.time ?? 0)).toFixed(6)}</td>
                      <td>
                        <span className={`protocol-chip ${f.protocol}`}>
                          {f.protocol.startsWith('enocean')
                            ? f.protocol === 'enocean2'
                              ? 'EnOcean 2'
                              : 'EnOcean 1'
                            : f.protocol === 'zigbee'
                              ? 'Zigbee'
                              : f.protocol === 'ble'
                                ? 'BLE'
                                : '802.15.4'}
                        </span>
                      </td>
                      {view === 'table' ? (
                        <>
                          <td>{f.source}</td>
                          <td>{f.destination}</td>
                          <td className="summary-cell">{f.summary}</td>
                        </>
                      ) : (
                        <td>
                          <div className="inline-frame">
                            {f.fields.map((field) => (
                              <span
                                key={field.id}
                                className={`${field.layer} ${field.layer === 'check' ? `checksum-${f.integrity}` : ''}`}
                                style={{ flex: Math.max(field.length, 2) }}
                                title={`${field.name}: ${field.value}`}
                              >
                                {field.text?.length
                                  ? `${field.text.some((t) => t.inferred) ? 'Text? ' : ''}${field.text.map((t) => JSON.stringify(t.value)).join(' / ')}`
                                  : field.value}
                              </span>
                            ))}
                          </div>
                        </td>
                      )}
                      <td>
                        {f.bytes.length} <span className="muted">B</span>
                      </td>
                      <td>
                        {f.rssi ?? '—'}
                        {f.rssi !== null && <span className="muted"> dBm</span>}
                      </td>
                      <td>
                        <span className={`integrity ${f.integrity}`}>
                          <i className="dot" />
                          {integrityLabel(f)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!filtered.length && (
              <div className="empty">
                <Radio size={22} />
                <strong>
                  {mode === 'live'
                    ? frames.length
                      ? 'No matching packets'
                      : 'Waiting for packets'
                    : frames.length
                      ? 'No matching packets'
                      : 'No packets in this session'}
                </strong>
                <span>
                  {mode === 'live'
                    ? frames.length
                      ? 'Try another address or integrity filter.'
                      : decoder === 'none'
                        ? profile.id === 'ble' && channel !== undefined && channel < 37
                          ? `Enter the connection access address and CRC init to decode data on channel ${channel}.`
                          : 'Choose a supported decode channel or EnOcean PHY / band to enable decoding.'
                        : decoder === 'enocean2'
                          ? `Listening for EnOcean ERP2 FSK telegrams at ${displayFrequency.toFixed(3)} MHz.`
                          : decoder === 'enocean'
                            ? 'Listening for EnOcean ERP1 ASK telegrams at 868.3 MHz. Adjust receiver gain to match the signal.'
                            : `Listening on channel ${channel}. ${decoder === 'ble' ? (connection ? `${blePhyLabel(blePhy)} data; fixed channel.` : 'Legacy 1M advertisements.') : '250 kbps O-QPSK frames.'} Match the transmitter channel and adjust receiver gain.`
                    : frames.length
                      ? 'Try another address or integrity filter.'
                      : hasParser
                        ? 'Open a PCAP or decode a raw hex frame.'
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
          frame={
            selectedFrame ? inspectedFrame(selectedFrame, packetEngine === 'wireshark') : undefined
          }
          onNotice={setNotice}
          engine={packetEngine}
          onEngine={setPacketEngine}
          engineAvailable={dissectorInfo.available}
          engineDetails={dissectorInfo.details}
          engineStatus={dissectorStatus}
        />
      </main>
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
