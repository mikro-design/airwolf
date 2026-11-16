import { memo } from 'react';
import type { GpsSatellite } from '../lib/types';
export default memo(function GpsStatus({ satellites }: { satellites?: GpsSatellite[] }) {
  const tracked = satellites?.filter((s) => s.tracking) ?? [];
  const synced = tracked.filter((s) => s.bitSync).length;
  return (
    <details className="gps-status" open>
      <summary>
        GPS · {synced} synchronized / {tracked.length} tracking
      </summary>
      {tracked.length ? (
        <table aria-label="GPS satellite tracking">
          <thead>
            <tr>
              <th>PRN</th>
              <th>C/N₀</th>
              <th>Doppler</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {tracked.map((s) => (
              <tr key={s.prn}>
                <td>{s.prn}</td>
                <td title="Carrier to noise density, dB-Hz">{s.cn0.toFixed(1)}</td>
                <td title="Carrier offset including receiver clock error, Hz">
                  {s.dopplerHz.toFixed(0)}
                </td>
                <td>{s.frameSync ? 'Word' : s.bitSync ? 'Bit' : 'Code'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Searching PRNs 1–32. Use a GPS L1 antenna with sky view.</p>
      )}
      <p>
        L1 C/A navigation · 8 MS/s. Six seconds per subframe after synchronization. Antenna power is
        off. No position solution.
      </p>
    </details>
  );
});
