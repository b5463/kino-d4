import { useId } from 'react';
import { Panel } from '../../components/Panel';
import { Button } from '../../components/Button';
import { Led } from '../../components/Led';
import { FieldRow } from '../../components/fields';
import { DEFAULT_ROLL_SERVER_URL } from '../../roll/RollServerClient';

export interface ServerTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Roll server (02 §17, 03 §27). The URL is a Studio-side setting: it tells
 * this app where Rolls are published. Wi-Fi credentials are not part of it and
 * never travel here — they go to the camera and stay there (05 §13).
 */
export function ServerPanel({
  url,
  busy,
  result,
  onUrlChange,
  onTest,
}: {
  url: string;
  busy: boolean;
  result: ServerTestResult | null;
  onUrlChange: (url: string) => void;
  onTest: () => Promise<void>;
}) {
  const urlId = useId();
  const lamp =
    result === null ? { state: 'off' as const, label: 'SERVER UNTESTED' }
    : result.ok ? { state: 'ok' as const, label: 'SERVER REACHABLE' }
    : { state: 'err' as const, label: 'SERVER UNREACHABLE' };

  return (
    <Panel title="ROLL SERVER" actions={<Led state={lamp.state} label={lamp.label} />}>
      <FieldRow
        label="SERVER URL"
        htmlFor={urlId}
        hint={url === DEFAULT_ROLL_SERVER_URL ? 'Default KINO Roll server.' : 'Custom server.'}
      >
        <input
          id={urlId}
          type="url"
          className="input"
          value={url}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => onUrlChange(e.target.value)}
        />
      </FieldRow>

      {result ? (
        <p className={result.ok ? 'notice notice--ok' : 'notice notice--err'}>
          {result.ok
            ? `Server answered${result.latencyMs === undefined ? '' : ` in ${result.latencyMs} ms`}.`
            : (result.error ?? 'Server did not answer.')}
        </p>
      ) : null}

      <div className="panel-actions">
        <Button busy={busy} onClick={() => void onTest()}>
          Test server
        </Button>
      </div>
    </Panel>
  );
}
