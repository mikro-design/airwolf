import { useEffect, useRef, useState } from 'react';
import type { RadioConfig, RadioDeviceInfo } from '../lib/types';
type Settings = NonNullable<RadioConfig['iio']>;
export function PlutoSettings({
  value,
  initialInfo,
  onChange,
  onDevice,
}: {
  value: Settings;
  initialInfo: RadioDeviceInfo | null;
  onChange: (settings: Settings) => void;
  onDevice: (info: RadioDeviceInfo) => void;
}) {
  const [uri, setUri] = useState(value.uri),
    [info, setInfo] = useState<RadioDeviceInfo | null>(initialInfo);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const current = useRef(value);
  current.current = value;
  useEffect(
    () => () => {
      ++sequence.current;
    },
    [],
  );
  function editUri(next: string) {
    ++sequence.current;
    setBusy(false);
    setUri(next);
    setInfo(null);
    onDevice({ available: false, details: 'Connect to apply the receiver URI.' });
  }
  async function query(connect: boolean) {
    const id = ++sequence.current;
    setBusy(true);
    try {
      const result = await window.radio!.info({
        backend: 'pluto',
        ...(connect ? { uri: uri.trim() } : {}),
      });
      if (id !== sequence.current) return;
      setInfo(result);
      if (connect) {
        onDevice(result);
        if (result.available && result.iio)
          onChange({
            ...current.current,
            uri: result.iio.uri,
            adcBits: result.iio.adcBits,
            channel: current.current.channel < result.iio.channels ? current.current.channel : 0,
          });
      } else if (result.iioDevices?.length === 1) setUri(result.iioDevices[0].uri);
    } catch (e) {
      if (id === sequence.current) {
        const failed = { available: false, details: (e as Error).message };
        setInfo(failed);
        if (connect) onDevice(failed);
      }
    } finally {
      if (id === sequence.current) setBusy(false);
    }
  }
  return (
    <div className="pluto-settings">
      <label className="control-label">
        Receiver URI
        <input
          aria-label="Pluto receiver URI"
          value={uri}
          placeholder="ip:hostname or usb:bus.address.interface"
          maxLength={256}
          spellCheck={false}
          onChange={(e) => editUri(e.target.value)}
        />
      </label>
      {!!info?.iioDevices?.length && (
        <label className="control-label">
          Discovered receivers
          <select
            aria-label="Discovered Pluto receivers"
            value={uri}
            onChange={(e) => editUri(e.target.value)}
          >
            <option value="">Select receiver</option>
            {info.iioDevices.map((d) => (
              <option key={d.uri} value={d.uri}>
                {d.description} · {d.uri}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="pluto-actions">
        <button
          type="button"
          className="button subtle"
          disabled={busy}
          onClick={() => void query(false)}
        >
          Discover
        </button>
        <button
          type="button"
          className="button subtle"
          disabled={busy || !uri.trim()}
          onClick={() => void query(true)}
        >
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
      {info && (
        <p className="tuning-note" role="status">
          {info.details}
        </p>
      )}
      <label className="control-label">
        RX input
        <select
          aria-label="Pluto RX input"
          value={value.channel}
          onChange={(e) => onChange({ ...value, channel: Number(e.target.value) })}
        >
          <option value="0">RX1</option>
          {(info?.iio?.channels ?? 1) > 1 && <option value="1">RX2</option>}
        </select>
      </label>
      <label className="control-label">
        Gain control
        <select
          aria-label="Pluto gain control"
          value={value.gainMode}
          onChange={(e) => onChange({ ...value, gainMode: e.target.value as Settings['gainMode'] })}
        >
          <option value="manual">Manual</option>
          <option value="slow_attack">Slow AGC</option>
          <option value="fast_attack">Fast AGC</option>
        </select>
      </label>
      {value.gainMode === 'manual' && (
        <label className="control-label">
          RX gain · dB
          <input
            aria-label="Pluto RX gain"
            type="number"
            min="-10"
            max="80"
            step="1"
            value={value.gain}
            title={info?.iio?.gainRange}
            onChange={(e) => onChange({ ...value, gain: Number(e.target.value) })}
          />
        </label>
      )}
      <label className="control-label">
        RX filter · MHz (0 = auto)
        <input
          aria-label="Pluto RX bandwidth"
          type="number"
          min="0"
          max="20"
          step="0.1"
          value={value.bandwidth / 1e6}
          title={info?.iio?.bandwidthRange}
          onChange={(e) =>
            onChange({ ...value, bandwidth: Math.round(Number(e.target.value) * 1e6) })
          }
        />
      </label>
      <p className="tuning-note">One RX input at a time · fixed-channel BLE.</p>
    </div>
  );
}
