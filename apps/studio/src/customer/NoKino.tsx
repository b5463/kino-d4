import { useEffect, useState } from 'react';
import { BroadcastTransport, TWIN_WS_URL, WebSocketTransport } from '@kino/kdp';
import { canStartConnection, useConnectionStore } from '../state/connectionStore';
import { useKnownCameras } from '../state/knownCameras';
import { connectSerial, connectTwin } from '../app/session';
import { APP_VERSION } from '../app/version';
import { KinoFront } from './physical/KinoFront';
import { connectCopy, helpUrl } from './copy';

/** Service builds may reach the simulated camera; a customer build never shows this. */
function serviceEntry(): boolean {
  if (import.meta.env.DEV) return true;
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('service');
}

const PROBE_MS = 3000;
/** 5.5 px/mm is the Shoot scale; No KINO draws the same body at the same size. */
const SCALE = 5.5;

/** The relay a simulated camera is reached over: `?twinWs=ws://host:port`, else the default. */
function relayUrl(): string {
  const given = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('twinWs') : null;
  return given ?? TWIN_WS_URL;
}

/**
 * No KINO. The front of the camera with its cover closed, one sentence, one
 * button. No header, no nav. On recognition the cover drops to its shooting
 * position, the cells appear behind it, the sentence names the camera for
 * one beat, and the shell cuts to Shoot.
 */
export function NoKino({
  recognised,
  reduced,
  onOpenFolder,
}: {
  /** The camera's name during the recognition beat, else null. */
  recognised: string | null;
  reduced: boolean;
  onOpenFolder: () => void;
}) {
  const phase = useConnectionStore((s) => s.phase);
  const fault = useConnectionStore((s) => s.fault);
  const error = useConnectionStore((s) => s.error);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const known = useKnownCameras((s) => s.cameras);
  const remembered = known.find((c) => !c.demo) ?? null;
  const copy = connectCopy(phase, fault, error, serialSupported, remembered);

  const service = serviceEntry();
  const [simulatedAt, setSimulatedAt] = useState<string | null>(null);
  const busy = phase === 'requesting-port' || phase === 'connecting' || phase === 'handshaking';

  useEffect(() => {
    if (!service || !canStartConnection(phase)) return;
    let cancelled = false;
    const relay = relayUrl();
    const check = () => {
      void BroadcastTransport.probe().then((present) => {
        if (!cancelled && present) setSimulatedAt('same-origin');
      });
      void WebSocketTransport.probe(relay).then((present) => {
        if (!cancelled) setSimulatedAt((cur) => (present ? relay : cur === relay ? null : cur));
      });
    };
    check();
    const timer = setInterval(check, PROBE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service, phase]);

  const sentence = recognised ? `This is ${recognised}.` : copy.sentence;
  const body = recognised ? null : copy.body;
  const recovery = phase === 'recovery' && !recognised;

  return (
    <div className="c-nokino">
      <div className="c-nokino-body">
        <KinoFront
          pxPerMm={SCALE}
          cover={recognised ? 'open' : 'closed'}
          cells={null}
          identity={recognised}
          showUsb={!recognised}
          faint={!recognised && copy.faint}
          reduced={reduced}
        />
      </div>
      <div className="c-nokino-text">
        <h1 className="c-nokino-sentence" role="status">
          {sentence}
        </h1>
        {recovery ? (
          <ol className="c-flow-steps" aria-label="What to do">
            <li>
              <span className="c-step-n">1</span>
              <span>Unplug KINO. Wait ten seconds.</span>
            </li>
            <li>
              <span className="c-step-n">2</span>
              <span>Plug it back in. Studio is watching for it.</span>
            </li>
            <li>
              <span className="c-step-n">3</span>
              <span>
                If it is still absent after a minute, press Connect KINO. If nothing answers,{' '}
                <a href={helpUrl(null, APP_VERSION)} target="_blank" rel="noreferrer noopener">
                  get help
                </a>
                .
              </span>
            </li>
          </ol>
        ) : body ? (
          <p className="c-nokino-line">
            {body}
            {copy.help ? (
              <>
                {' '}
                <a href={helpUrl(null, APP_VERSION)} target="_blank" rel="noreferrer noopener">
                  Get help.
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {!recognised && copy.button && !busy ? (
          <div className="c-nokino-actions">
            <button type="button" className="c-button" onClick={() => void connectSerial()}>
              {copy.button === 'retry' ? 'Try again' : 'Connect KINO'}
            </button>
            {service && simulatedAt ? (
              <p className="c-nokino-service">
                Service:{' '}
                <button type="button" onClick={() => void connectTwin(simulatedAt === 'same-origin' ? undefined : simulatedAt)}>
                  connect the simulated camera
                </button>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <footer className="c-nokino-foot">
        <span>Studio {APP_VERSION}</span>
        <button type="button" onClick={onOpenFolder}>
          Open photos from a card or folder.
        </button>
      </footer>
    </div>
  );
}
