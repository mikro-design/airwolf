import { useEffect, useState } from 'react';
import { lteBands, lteEarfcn, lteFrequency } from '../lib/wideband';
export default function LteControls({
  band,
  uplink,
  bandwidth,
  frequency,
  onPlan,
  onBandwidth,
  onTune,
}: {
  band: number;
  uplink: boolean;
  bandwidth: number;
  frequency: number;
  onPlan: (band: number, uplink: boolean) => void;
  onBandwidth: (value: number) => void;
  onTune: (value: number) => void;
}) {
  const plan = lteBands.find((p) => p.band === band)!;
  const range = uplink && plan.uplink ? plan.uplink : plan.downlink;
  const channel = lteEarfcn(range, frequency);
  const [input, setInput] = useState(String(channel ?? ''));
  useEffect(() => setInput(String(channel ?? '')), [channel]);
  function commit() {
    const next = input.trim() ? lteFrequency(range, Number(input)) : null;
    if (next !== null) onTune(next);
    else setInput(String(channel ?? ''));
  }
  return (
    <>
      <label className="control-label">
        LTE band
        <select
          aria-label="LTE band"
          title="Downlink band range. Selecting a band tunes to its middle EARFCN; set EARFCN to choose the carrier center."
          value={band}
          onChange={(e) => onPlan(Number(e.target.value), uplink)}
        >
          {lteBands.map((p) => (
            <option key={p.band} value={p.band}>
              B{p.band} · {p.duplex} · DL {p.downlink[0]}–
              {Number((p.downlink[0] + (p.downlink[2] - p.downlink[1] + 1) / 10).toFixed(3))} MHz
            </option>
          ))}
        </select>
      </label>
      {plan.duplex === 'FDD' && (
        <label className="control-label">
          Receive link
          <select
            aria-label="LTE receive link"
            value={uplink ? 'ul' : 'dl'}
            onChange={(e) => onPlan(band, e.target.value === 'ul')}
          >
            <option value="dl">Downlink · base station</option>
            <option value="ul">Uplink · device</option>
          </select>
        </label>
      )}
      <label className="control-label">
        EARFCN{' '}
        <span>
          {range[1]}–{range[2]}
        </span>
        <input
          aria-label="LTE EARFCN"
          inputMode="numeric"
          value={input}
          placeholder="Off channel raster"
          onChange={(e) => setInput(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
      <label className="control-label">
        Bandwidth guide
        <select
          aria-label="LTE bandwidth guide"
          value={bandwidth}
          onChange={(e) => onBandwidth(Number(e.target.value))}
        >
          {[1.4, 3, 5, 10, 15, 20].map((width) => (
            <option key={width} value={width}>
              {width} MHz
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
