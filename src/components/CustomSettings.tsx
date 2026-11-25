import './lora-settings.css';
import {
  chipPresets,
  defaultCustomSettings,
  crcPresets,
  customBitrates,
  customProblem,
  type CustomSettings as Settings,
} from '../lib/custom-format';

const rateLabel = (b: number) => (b >= 1e6 ? `${b / 1e6}M` : `${b / 1000}k`);
const crcId = (s: Settings) =>
  crcPresets.find((p) => JSON.stringify(p.crc) === JSON.stringify(s.crc))?.id ?? 'other';
const number = (text: string, fallback: number) => {
  const n = Number(text);
  return Number.isInteger(n) ? n : fallback;
};

export default function CustomSettings({
  value,
  onChange,
  sampleRate,
  disabled = false,
}: {
  value: Settings;
  onChange: (value: Settings) => void;
  sampleRate: number;
  disabled?: boolean;
}) {
  const problem = customProblem(value, sampleRate);
  const oqpsk = value.modulation === 'oqpsk';
  const set = (patch: Partial<Settings>) => onChange({ ...value, ...patch });
  return (
    <div className="lora-settings" aria-label="Custom format settings">
      <label className="control-label custom-preset">
        Start from
        <select
          aria-label="Custom format preset"
          value=""
          disabled={disabled}
          onChange={(e) => {
            const preset = chipPresets.find((p) => p.id === e.target.value);
            if (preset) onChange({ ...value, whitening: 'none', ...preset.settings });
          }}
        >
          <option value="">Chip preset…</option>
          {chipPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="control-label">
        Modulation
        <select
          aria-label="Custom modulation"
          value={oqpsk ? 'oqpsk' : 'gfsk'}
          disabled={disabled}
          onChange={(e) =>
            // Each modulation starts from a coherent format: 802.15.4 framing
            // for O-QPSK, the CC1101-style default for GFSK.
            onChange(
              e.target.value === 'oqpsk'
                ? {
                    ...defaultCustomSettings,
                    ...chipPresets.find((p) => p.id === 'oqpsk-154')!.settings,
                  }
                : defaultCustomSettings,
            )
          }
        >
          <option value="gfsk">2-FSK / GFSK</option>
          <option value="oqpsk">O-QPSK (802.15.4)</option>
        </select>
      </label>
      {oqpsk ? (
        <p className="custom-note">
          250 kb/s, 2 Mchip/s DSSS as the 2.4 GHz IEEE 802.15.4 PHY; the SFD and framing are yours.
        </p>
      ) : (
        <>
          <label className="control-label">
            Bit rate <span>b/s</span>
            <select
              aria-label="Custom bit rate"
              value={value.bitrate}
              disabled={disabled}
              onChange={(e) => {
                const bitrate = Number(e.target.value);
                set({ bitrate, deviation: Math.round(bitrate / 2) });
              }}
            >
              {customBitrates.map((b) => (
                <option key={b} value={b}>
                  {rateLabel(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="control-label">
            Deviation <span>kHz</span>
            <input
              aria-label="Custom deviation"
              type="number"
              min={1}
              step={1}
              value={Math.round((value.deviation ?? value.bitrate / 2) / 1000)}
              disabled={disabled}
              onChange={(e) => set({ deviation: number(e.target.value, 0) * 1000 })}
            />
          </label>
        </>
      )}
      <label className="control-label">
        {oqpsk ? 'SFD' : 'Sync word'} <span>hex</span>
        <input
          className="custom-input"
          aria-label="Custom sync word"
          value={value.sync}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => set({ sync: e.target.value.replace(/^0x/i, '').trim() })}
        />
      </label>
      <label className="control-label">
        Sync length
        <select
          aria-label="Custom sync length"
          value={value.syncBits}
          disabled={disabled}
          onChange={(e) => set({ syncBits: Number(e.target.value) })}
        >
          {(oqpsk ? [8, 16] : [16, 24, 32]).map((n) => (
            <option key={n} value={n}>
              {n} bits
            </option>
          ))}
        </select>
      </label>
      {!oqpsk && (
        <label className="control-label">
          Sync errors
          <select
            aria-label="Custom sync errors"
            value={value.syncErrors}
            disabled={disabled}
            onChange={(e) => set({ syncErrors: Number(e.target.value) })}
          >
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="control-label">
        Bit order
        <select
          aria-label="Custom bit order"
          value={value.bitOrder}
          disabled={disabled}
          onChange={(e) => set({ bitOrder: e.target.value as Settings['bitOrder'] })}
        >
          <option value="msb">MSB</option>
          <option value="lsb">LSB</option>
        </select>
      </label>
      <label className="control-label">
        Length
        <select
          aria-label="Custom length mode"
          value={value.length.mode}
          disabled={disabled}
          onChange={(e) =>
            set({
              length:
                e.target.value === 'fixed'
                  ? { mode: 'fixed', bytes: Math.min(16, value.maxLength) }
                  : { mode: 'field', offset: 0, adjust: 0 },
            })
          }
        >
          <option value="field">Byte</option>
          <option value="fixed">Fixed</option>
        </select>
      </label>
      {value.length.mode === 'fixed' ? (
        <label className="control-label">
          Data bytes
          <input
            aria-label="Custom fixed length"
            type="number"
            min={1}
            max={255}
            value={value.length.bytes}
            disabled={disabled}
            onChange={(e) => set({ length: { mode: 'fixed', bytes: number(e.target.value, 1) } })}
          />
        </label>
      ) : (
        <>
          <label className="control-label">
            Length byte at
            <input
              aria-label="Custom length offset"
              type="number"
              min={0}
              max={254}
              value={value.length.offset}
              disabled={disabled}
              onChange={(e) =>
                value.length.mode === 'field' &&
                set({ length: { ...value.length, offset: number(e.target.value, 0) } })
              }
            />
          </label>
          <label
            className="control-label"
            title="Data bytes after the length byte = its value + this adjustment"
          >
            Length adjust
            <input
              aria-label="Custom length adjustment"
              type="number"
              min={-255}
              max={255}
              value={value.length.adjust}
              disabled={disabled}
              onChange={(e) =>
                value.length.mode === 'field' &&
                set({ length: { ...value.length, adjust: number(e.target.value, 0) } })
              }
            />
          </label>
        </>
      )}
      <label className="control-label">
        Max length
        <input
          aria-label="Custom maximum length"
          type="number"
          min={1}
          max={255}
          value={value.maxLength}
          disabled={disabled}
          onChange={(e) =>
            set({ maxLength: Math.max(1, Math.min(255, number(e.target.value, 64))) })
          }
        />
      </label>
      <label className="control-label">
        Whitening
        <select
          aria-label="Custom whitening"
          value={value.whitening}
          disabled={disabled}
          onChange={(e) => {
            const whitening = e.target.value as Settings['whitening'];
            set({
              whitening,
              bleChannel: whitening === 'ble' ? (value.bleChannel ?? 37) : undefined,
            });
          }}
        >
          <option value="none">None</option>
          <option value="pn9">PN9</option>
          <option value="ble">BLE</option>
        </select>
      </label>
      {value.whitening === 'ble' && (
        <label className="control-label">
          Whitening channel
          <input
            aria-label="Custom whitening channel"
            type="number"
            min={0}
            max={39}
            value={value.bleChannel ?? 37}
            disabled={disabled}
            onChange={(e) =>
              set({ bleChannel: Math.max(0, Math.min(39, number(e.target.value, 37))) })
            }
          />
        </label>
      )}
      <label className="control-label custom-preset">
        CRC
        <select
          aria-label="Custom CRC"
          value={crcId(value)}
          disabled={disabled}
          onChange={(e) => {
            const crc = crcPresets.find((p) => p.id === e.target.value)?.crc ?? null;
            set({ crc, crcFrom: crc ? (value.crcFrom ?? 0) : undefined });
          }}
        >
          {crcPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {crcId(value) === 'other' && <option value="other">From preset</option>}
        </select>
      </label>
      {value.crc && (
        <label className="control-label" title="First data byte the CRC covers">
          CRC from byte
          <input
            aria-label="Custom CRC start"
            type="number"
            min={0}
            max={254}
            value={value.crcFrom ?? 0}
            disabled={disabled}
            onChange={(e) => set({ crcFrom: Math.max(0, number(e.target.value, 0)) })}
          />
        </label>
      )}
      {!oqpsk && (
        <label className="lora-inverted">
          <input
            type="checkbox"
            aria-label="Custom invert tones"
            checked={value.invert}
            disabled={disabled}
            onChange={(e) => set({ invert: e.target.checked })}
          />
          Invert tones
        </label>
      )}
      <p
        className={problem ? 'custom-note problem' : 'custom-note'}
        role={problem ? 'alert' : undefined}
      >
        {problem ??
          (oqpsk
            ? 'Needs the 802.15.4 preamble (zero symbols) before the SFD. Frames are shown flagged as a user-defined format.'
            : 'Needs at least 8 alternating preamble bits before the sync word. Frames are shown flagged as a user-defined format.')}
      </p>
    </div>
  );
}
