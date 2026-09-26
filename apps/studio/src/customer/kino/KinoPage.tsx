import { useEffect } from 'react';
import { APP_VERSION } from '../../app/version';
import { supports, useDeviceStore } from '../../state/deviceStore';
import { helpUrl } from '../copy';
import { CameraSettings } from './CameraSettings';
import { Maintenance } from './Maintenance';
import { MatchLenses } from './MatchLenses';
import { UpdateFlow } from './UpdateFlow';
import { WifiSettings } from './WifiSettings';

export type KinoView = 'settings' | 'wifi' | 'update' | 'match';

/**
 * KINO: a quiet list in four groups. Camera, Connection, Maintenance, About.
 * No control panel, no camera drawing. The two flows that need the whole
 * page (an update, matching the lenses) take it and come back here.
 */
export function KinoPage({ view, nonce, onView }: { view: KinoView; nonce: number; onView: (v: KinoView) => void }) {
  const state = useDeviceStore();
  const hasNetwork = supports(state, 'network');

  useEffect(() => {
    if (view === 'wifi') document.getElementById('c-wifi')?.scrollIntoView({ block: 'start' });
  }, [view, nonce]);

  if (view === 'update') return <UpdateFlow onDone={() => onView('settings')} onBack={() => onView('settings')} />;
  if (view === 'match') return <MatchLenses onClose={() => onView('settings')} />;

  return (
    <section className="c-kino" aria-label="KINO">
      <CameraSettings />
      {hasNetwork ? <WifiSettings focus={view === 'wifi'} /> : null}
      <Maintenance onUpdate={() => onView('update')} onMatch={() => onView('match')} />
      <h2>About</h2>
      <div className="c-setting">
        <span className="c-setting-label">Studio</span>
        <span className="c-setting-body">{APP_VERSION}</span>
      </div>
      <div className="c-setting">
        <span className="c-setting-label">KINO</span>
        <span className="c-setting-body">{state.info?.p4Firmware ?? '—'}</span>
      </div>
      <div className="c-setting">
        <span className="c-setting-label">Serial</span>
        <span className="c-setting-body">{state.info?.serial ?? '—'}</span>
      </div>
      <div className="c-setting">
        <span className="c-setting-label">Help</span>
        <span className="c-setting-body">
          <a href={helpUrl(state.info, APP_VERSION)} target="_blank" rel="noreferrer noopener">
            Get help with this KINO
          </a>
        </span>
      </div>
    </section>
  );
}
