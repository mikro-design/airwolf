import { Children, type ReactNode } from 'react';

/**
 * The one place a protocol's own settings live. Its contents change with
 * the selected protocol; the frame, title and position stay the same so
 * every protocol's options are found in the same spot.
 */
export default function ProtocolPanel({
  protocol,
  children,
}: {
  /** Short protocol name, shown in the title. */
  protocol: string;
  children?: ReactNode;
}) {
  const empty = Children.toArray(children).length === 0;
  return (
    <section className="protocol-panel" aria-label={`${protocol} settings`}>
      <div className="protocol-panel-title">{protocol} settings</div>
      {empty ? (
        <p className="protocol-panel-empty">No settings beyond channel and sample rate.</p>
      ) : (
        children
      )}
    </section>
  );
}
