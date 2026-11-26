import './lora-settings.css';

import type { LoraSettings as LoraUiSettings } from '../lib/types';
export type { LoraSettings as LoraUiSettings } from '../lib/types';
export const defaultLoraSettings: Readonly<LoraUiSettings> = Object.freeze({
  bandwidth: 125000,
  spreadingFactor: 0,
  syncWord: 0x34,
  inverted: false,
  macVersion: 'unknown',
});

export default function LoraSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: LoraUiSettings;
  onChange: (value: LoraUiSettings) => void;
  disabled?: boolean;
}) {
  const beacon = !!value.beacon;
  return (
    <div className="lora-settings" aria-label="LoRa settings">
      <label className="control-label">
        Bandwidth
        <select
          aria-label="LoRa bandwidth"
          value={value.bandwidth}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...value, bandwidth: Number(e.target.value) as LoraUiSettings['bandwidth'] })
          }
        >
          {[125000, 250000, 500000].map((bandwidth) => (
            <option key={bandwidth} value={bandwidth}>
              {bandwidth / 1000} kHz
            </option>
          ))}
        </select>
      </label>
      <label className="control-label">
        Spreading factor
        <select
          aria-label="LoRa spreading factor"
          value={value.spreadingFactor}
          disabled={disabled}
          title={`Auto listens for SF${beacon ? 8 : 7}–12 on this bandwidth and frequency.`}
          onChange={(e) =>
            onChange({
              ...value,
              spreadingFactor: Number(e.target.value) as LoraUiSettings['spreadingFactor'],
            })
          }
        >
          <option value={0}>Auto {beacon ? 8 : 7}–12</option>
          {(beacon ? [8, 9, 10, 11, 12] : [7, 8, 9, 10, 11, 12]).map((sf) => (
            <option key={sf} value={sf}>
              SF{sf}
            </option>
          ))}
        </select>
      </label>
      <label className="control-label">
        Sync word
        <select
          aria-label="LoRa sync word"
          value={value.syncWord}
          disabled={disabled}
          title="Public 0x34 is used by LoRaWAN, 0x2B by Meshtastic. Private 0x12 and Meshtastic payloads remain raw (Meshtastic packets are encrypted)."
          onChange={(e) =>
            onChange({ ...value, syncWord: Number(e.target.value) as LoraUiSettings['syncWord'] })
          }
        >
          <option value={0x34}>Public · 34</option>
          <option value={0x12}>Private · 12</option>
          <option value={0x2b}>Meshtastic · 2B</option>
        </select>
      </label>
      <label className="control-label">
        MAC version
        <select
          aria-label="LoRaWAN version context"
          value={value.macVersion}
          disabled={disabled}
          title="Select a known network version to interpret frame options. Unknown leaves options opaque; 1.1 options are encrypted."
          onChange={(e) =>
            onChange({ ...value, macVersion: e.target.value as LoraUiSettings['macVersion'] })
          }
        >
          <option value="unknown">Unknown</option>
          <option value="1.0">1.0</option>
          <option value="1.1">1.1</option>
        </select>
      </label>
      <label className="lora-inverted">
        <input
          type="checkbox"
          checked={value.inverted}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, inverted: e.target.checked })}
        />
        Inverted chirps
      </label>
      <label
        className="lora-inverted"
        title="LoRaWAN Class B beacons: implicit header, CR 4/5, no PHY CRC, SF8–12 (EU868: 869.525 MHz, SF9, 125 kHz; US915: SF12, 500 kHz). Beacons use normal chirps. Ordinary explicit-header packets are not received in this mode."
      >
        <input
          type="checkbox"
          aria-label="LoRaWAN Class B beacons"
          checked={beacon}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...value,
              beacon: e.target.checked,
              ...(e.target.checked
                ? {
                    inverted: false,
                    spreadingFactor: value.spreadingFactor === 7 ? 0 : value.spreadingFactor,
                  }
                : {}),
            })
          }
        />
        Class B beacons
      </label>
    </div>
  );
}
