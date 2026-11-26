import { memo, useEffect, useRef, useState } from 'react';
import type { GpsSatellite } from '../lib/types';

function stage(s?: GpsSatellite) {
  if (s?.tracking && s.frameSync && s.frames > 0) return 'Navigation';
  if (s?.tracking && s.bitSync) return 'Bit sync';
  if (s?.tracking) return 'Code lock';
  if (s?.acquiring) return 'Candidate';
  return 'Searching';
}

export default memo(function GpsStatus({
  satellites,
  running,
  antennaPower,
}: {
  satellites?: GpsSatellite[];
  running: boolean;
  /** Bias-tee state requested for this receiver; omitted where unknown. */
  antennaPower?: boolean;
}) {
  const latest = useRef(satellites);
  const [displayed, setDisplayed] = useState(satellites);
  useEffect(() => {
    latest.current = satellites;
  }, [satellites]);
  useEffect(() => {
    setDisplayed(latest.current);
    if (!running) return;
    const timer = setInterval(() => setDisplayed(latest.current), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const rows = Array.from({ length: 32 }, (_, i) => displayed?.find((s) => s.prn === i + 1));
  const navigation = rows.filter((s) => stage(s) === 'Navigation').length;
  const bits = rows.filter((s) => s?.tracking && s.bitSync).length;
  const tracking = rows.filter((s) => s?.tracking).length;
  const heading = !running
    ? displayed
      ? 'Stopped · last status'
      : 'Ready'
    : navigation
      ? 'Receiving navigation'
      : bits
        ? 'Synchronizing navigation'
        : 'Searching for navigation';
  return (
    <section className="gps-status" aria-label="GPS reception">
      <div className="gps-heading">GPS · {heading}</div>
      <p className="gps-counts">
        <span title="Satellites with parity-checked navigation">{navigation} nav</span> ·{' '}
        <span title="Satellites with synchronized bit timing">{bits} bits</span> ·{' '}
        <span title="Sustained code and carrier tracking">{tracking} locks</span>
      </p>
      <div className="gps-prns" aria-label="GPS PRNs 1–32">
        {rows.map((s, i) => {
          const state = stage(s);
          const confirmed = s?.tracking;
          return (
            <span
              key={i}
              className={
                confirmed ? `gps-prn gps-prn-${state.split(' ')[0].toLowerCase()}` : 'gps-prn'
              }
              title={`PRN ${i + 1}: ${confirmed ? state : 'Searching'}${!running ? ' (last status)' : ''}`}
            >
              {i + 1}
            </span>
          );
        })}
      </div>
      <p className="gps-message">
        {navigation
          ? 'Navigation words have passed parity checks.'
          : bits
            ? 'Bit timing found; waiting for a complete, parity-valid subframe.'
            : 'No verified navigation. Acquisition candidates are not confirmed satellites.'}
      </p>
      <details className="gps-diagnostics">
        <summary>Satellite details</summary>
        <div className="gps-satellite-scroll">
          <table aria-label="GPS satellite tracking">
            <thead>
              <tr>
                <th>PRN</th>
                <th>State</th>
                <th>C/N₀</th>
                <th>Lock s</th>
                <th title="Navigation subframes that passed parity">Frames</th>
                <th title="Subframes that failed parity">Failed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{stage(s)}</td>
                  <td title="Estimated carrier to noise density, dB-Hz">
                    {s?.tracking || s?.acquiring ? s.cn0.toFixed(1) : '—'}
                  </td>
                  <td
                    title={
                      s?.tracking || s?.acquiring
                        ? `Carrier offset: ${s.dopplerHz.toFixed(0)} Hz, including receiver clock error`
                        : undefined
                    }
                  >
                    {s?.tracking || s?.acquiring ? s.lockSeconds.toFixed(1) : '—'}
                  </td>
                  <td title="Navigation subframes that passed parity on this channel">
                    {s?.tracking || s?.frames ? s.frames : '—'}
                  </td>
                  <td
                    className={s?.parityFailures ? 'survey-invalid' : undefined}
                    title="Subframes that failed parity on this channel; they are not listed as packets"
                  >
                    {s?.tracking || s?.parityFailures ? s.parityFailures : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Candidate: acquisition peak under evaluation. Code lock: carrier tracking sustained
          through pull-in. Bit sync: 20 ms bit timing. Navigation: parity-checked words. Frames and
          Failed count subframes that passed or failed parity since the receiver started; a failed
          subframe is not listed as a packet. Values update once per second.
        </p>
      </details>
      <p className="gps-setup">
        L1 C/A · 8 MS/s
        {antennaPower === undefined
          ? ''
          : ` · antenna power ${antennaPower ? 'on (3.3 V)' : 'off'}`}
        . Use a GPS L1 antenna with sky view
        {antennaPower ? '' : '; an active antenna needs antenna power'}. No position solution.
      </p>
    </section>
  );
});
