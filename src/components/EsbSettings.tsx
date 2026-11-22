import './lora-settings.css';
import type { EsbRate } from '../lib/types';
import { esbRateLabel, parseEsbAddress } from '../lib/esb';

export interface EsbUiSettings {
  rate: EsbRate;
  /** As typed; empty is promiscuous. */
  address: string;
  crc: 1 | 2;
}
export const defaultEsbUiSettings: Readonly<EsbUiSettings> = Object.freeze({
  rate: '2m',
  address: '',
  crc: 2,
});

export default function EsbSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: EsbUiSettings;
  onChange: (value: EsbUiSettings) => void;
  disabled?: boolean;
}) {
  const address = parseEsbAddress(value.address);
  return (
    <div className="lora-settings" aria-label="ESB settings">
      <label className="control-label">
        Data rate
        <select
          aria-label="ESB data rate"
          value={value.rate}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, rate: e.target.value as EsbRate })}
        >
          {(['250k', '1m', '2m'] as const).map((rate) => (
            <option key={rate} value={rate}>
              {esbRateLabel(rate)}
            </option>
          ))}
        </select>
      </label>
      <label className="control-label">
        CRC
        <select
          aria-label="ESB CRC"
          value={address ? value.crc : 2}
          disabled={disabled}
          title="CRC-8 needs a configured address; promiscuous reception uses CRC-16."
          onChange={(e) => onChange({ ...value, crc: Number(e.target.value) as 1 | 2 })}
        >
          <option value={2}>CRC-16</option>
          <option value={1} disabled={!address}>
            CRC-8
          </option>
        </select>
      </label>
      <label className="control-label esb-address">
        Address <span>hex, on-air order</span>
        <input
          aria-label="ESB address"
          placeholder="Empty: promiscuous"
          value={value.address}
          maxLength={14}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={address === null}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
        />
      </label>
      <p className="esb-note">
        {address === null
          ? 'Enter 3–5 bytes of hex (6–10 digits). Decoding is off until the address is valid.'
          : address
            ? 'Only this address is received; frames with a bad CRC are kept.'
            : 'Promiscuous: any 3–5 byte address with CRC-16. An address is shown once a second CRC-valid frame from it arrives within 4 s.'}
      </p>
    </div>
  );
}
