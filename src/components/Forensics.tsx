import { Search } from 'lucide-react';
import Discovery from './Discovery';
import type { SurveyTarget } from '../lib/forensics';
import type { RadioConfig } from '../lib/types';

interface Props {
  visible: boolean;
  config: RadioConfig;
  onBegin(): Promise<void>;
  onEnd(): void;
  onOpen(target: SurveyTarget): Promise<void>;
  onControls(controls: { start(): void; stop(): Promise<void> }): void;
}
// One flow: map where the energy is, let the decoders say what it is, and
// list what was found by protocol. No channel lists to pick from.
export default function Forensics({ visible, config, onBegin, onEnd, onOpen, onControls }: Props) {
  // Hidden, not unmounted: the results stay for when the user comes back.
  return (
    <main
      className="workspace forensics-workspace"
      aria-label="Discovery"
      style={visible ? undefined : { display: 'none' }}
    >
      <div className="forensics-heading">
        <div>
          <h1>
            <Search size={19} /> Discovery
          </h1>
          <p>
            Find the LTE, Wi-Fi, Bluetooth, GPS and other signals around you, then open one in Live
            analysis.
          </p>
        </div>
      </div>
      <Discovery
        visible={visible}
        config={config}
        onBegin={onBegin}
        onEnd={onEnd}
        onOpen={onOpen}
        onControls={onControls}
      />
    </main>
  );
}
