import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  Activity,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileCode2,
  FolderOpen,
  Gauge,
  Info,
  Layers3,
  Minus,
  Maximize2,
  Pause,
  Play,
  Printer,
  RefreshCw,
  Settings,
  ShieldCheck,
  Square,
  Thermometer,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from './cn';
import type { GCodeInfo, Port, PrintState } from './types';

const activeStates = new Set(['connecting', 'heating', 'printing', 'paused', 'stopping']);

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function temp(value: number | null | undefined) {
  return value == null ? '-' : `${Math.round(value)}°`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function MenuButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="menu-trigger">
        {label}<ChevronDown aria-hidden="true" size={13} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" sideOffset={2} align="start">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({ icon: Icon, children, onSelect, disabled = false }: {
  icon: typeof FolderOpen;
  children: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item className="menu-item" onSelect={onSelect} disabled={disabled}>
      <Icon aria-hidden="true" size={16} />
      <span>{children}</span>
    </DropdownMenu.Item>
  );
}

function BevelButton({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn('bevel-button', className)} {...props}>{children}</button>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field-row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

export function App() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [selectedPort, setSelectedPort] = useState('COM11');
  const [info, setInfo] = useState<GCodeInfo | null>(null);
  const [status, setStatus] = useState<PrintState>({ status: 'idle', message: 'Ready', progress: 0 });
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [nozzleTemp, setNozzleTemp] = useState(230);
  const [antiOoze, setAntiOoze] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readiness, setReadiness] = useState({ bed: false, filament: false, supervise: false });
  const [uiScale, setUiScale] = useState(() => Number(localStorage.getItem('kino-print-ui-scale') || 1.25));
  const [clock, setClock] = useState(Date.now());

  const refreshPorts = useCallback(async () => {
    try {
      const next = await window.kinoPrint.listPorts();
      setPorts(next);
      const prusa = next.find((port) => port.isPrusa);
      if (prusa) setSelectedPort(prusa.device);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not scan serial ports.');
    }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    setFileError('');
    try {
      const inspected = await window.kinoPrint.inspectFile(path);
      setInfo(inspected);
      setNozzleTemp(inspected.recommendedNozzle);
      setAntiOoze(inspected.recommendedAntiOoze);
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : 'Could not read this G-code file.');
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const openFile = useCallback(async () => {
    const path = await window.kinoPrint.openFile();
    if (path) await loadFile(path);
  }, [loadFile]);

  const dropFile = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setFileError('Drop one G-code file at a time.');
      return;
    }
    const file = files[0];
    if (!/\.(gcode|gco)$/i.test(file.name)) {
      setFileError('Use a .gcode or .gco file.');
      return;
    }
    const path = window.kinoPrint.getDroppedFilePath(file);
    if (!path) {
      setFileError('Windows did not provide a file path. Use Open G-code instead.');
      return;
    }
    await loadFile(path);
  }, [loadFile]);

  useEffect(() => {
    void refreshPorts();
    const id = window.setInterval(() => {
      if (!activeStates.has(status.status)) void refreshPorts();
    }, 3000);
    return () => window.clearInterval(id);
  }, [refreshPorts, status.status]);
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * uiScale}px`;
    localStorage.setItem('kino-print-ui-scale', String(uiScale));
  }, [uiScale]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await window.kinoPrint.getStatus();
        if (alive) setStatus(next);
      } catch { /* A single missed UI poll must not affect the worker. */ }
    };
    void poll();
    const id = window.setInterval(poll, 1000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const prusa = ports.find((port) => port.device === selectedPort);
  const recoveredStartupError = Boolean(
    prusa?.isPrusa
    && status.status === 'error'
    && (status.commands_sent ?? 0) === 0
    && /could not open port|cannot find the file specified|usb connection is unavailable/i.test(status.message || ''),
  );
  const disconnectedWhileHot = Boolean(
    status.status === 'error'
    && ((status.hotend_target ?? 0) > 0 || (status.bed_target ?? 0) > 0),
  );
  const communicationFailure = status.status === 'error'
    && /ClearCommError|PermissionError|does not recognize the command/i.test(status.message || '');
  const displayStatus: PrintState = recoveredStartupError
    ? {
        status: 'idle',
        message: 'Printer reconnected. Ready to start.',
        progress: 0,
        current_layer: 0,
        total_layers: status.total_layers,
        commands_sent: 0,
        commands_total: status.commands_total,
      }
    : communicationFailure
      ? { ...status, message: 'USB disconnected during the print. Cool the printer before continuing.' }
      : status;
  const active = activeStates.has(displayStatus.status);
  const canStart = Boolean(info?.safeToPrint && prusa?.isPrusa && !active && !disconnectedWhileHot);
  const readinessComplete = Object.values(readiness).every(Boolean);
  const progress = Math.min(100, Math.max(0, displayStatus.progress || 0));
  const elapsedEnd = displayStatus.completed_at ? new Date(displayStatus.completed_at).getTime() : clock;
  const elapsedSeconds = displayStatus.started_at ? Math.max(0, (elapsedEnd - new Date(displayStatus.started_at).getTime()) / 1000) : 0;
  const repairCount = useMemo(() => {
    if (!info) return 0;
    return info.issues.filter((issue) => issue.id !== 'printer-mismatch').length;
  }, [info]);

  async function startPrint() {
    if (!info || !canStart || !readinessComplete) return;
    setError('');
    try {
      const currentPorts = await window.kinoPrint.listPorts();
      setPorts(currentPorts);
      const connectedPrusa = currentPorts.find((port) => port.device === selectedPort && port.isPrusa)
        ?? currentPorts.find((port) => port.isPrusa);
      if (!connectedPrusa) throw new Error('The Prusa is not connected. Reconnect USB and wait a moment.');
      setSelectedPort(connectedPrusa.device);
      await window.kinoPrint.startPrint({ port: connectedPrusa.device, file: info.path, nozzleTemp, antiOoze });
      setConfirmOpen(false);
      setReadiness({ bed: false, filament: false, supervise: false });
    } catch (reason) {
      setConfirmOpen(false);
      setError(reason instanceof Error ? reason.message : 'The print could not be started.');
    }
  }

  async function control(action: 'pause' | 'resume' | 'stop') {
    try {
      if (action === 'stop' && disconnectedWhileHot) await window.kinoPrint.emergencyCooldown();
      else await window.kinoPrint.sendControl(action);
      if (action === 'stop') setStopOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not ${action} the print.`);
    }
  }

  async function acknowledgePowerOff() {
    try {
      await window.kinoPrint.acknowledgePowerOff();
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not clear the stopped print.');
    }
  }

  return (
    <div
      className="app-shell"
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => void dropFile(event)}
    >
      {dragging && <div className="global-drop-overlay" aria-hidden="true"><FolderOpen size={42} /><strong>Drop G-code to open it</strong><span>.gcode and .gco files</span></div>}
      <header className="title-bar">
        <div className="title-brand">
          <img src="./kino-print-logo.png" alt="" />
          <span>KINO Print</span>
        </div>
        <div className="window-actions">
          <button aria-label="Minimize KINO Print" onClick={() => void window.kinoPrint.minimizeWindow()}><Minus size={16} /></button>
          <button aria-label="Maximize or restore KINO Print" onClick={() => void window.kinoPrint.maximizeWindow()}><Maximize2 size={14} /></button>
          <button aria-label="Close KINO Print" onClick={() => void window.kinoPrint.closeWindow()}><X size={17} /></button>
        </div>
      </header>

      <nav className="menu-bar" aria-label="Application menu">
        <MenuButton label="File">
          <MenuItem icon={FolderOpen} onSelect={() => void openFile()}>Open G-code…</MenuItem>
          <MenuItem icon={FileCode2} onSelect={() => void window.kinoPrint.showLog()}>Open print log</MenuItem>
          <DropdownMenu.Separator className="menu-separator" />
          <MenuItem icon={X} onSelect={() => void window.kinoPrint.closeWindow()}>Exit</MenuItem>
        </MenuButton>
        <MenuButton label="Printer">
          <MenuItem icon={RefreshCw} onSelect={() => void refreshPorts()}>Refresh devices</MenuItem>
          <MenuItem icon={Pause} onSelect={() => void control('pause')} disabled={!['heating', 'printing'].includes(status.status)}>Pause print</MenuItem>
          <MenuItem icon={Play} onSelect={() => void control('resume')} disabled={status.status !== 'paused'}>Resume print</MenuItem>
          <MenuItem icon={Square} onSelect={() => setStopOpen(true)} disabled={!active}>Stop and cool down…</MenuItem>
        </MenuButton>
        <MenuButton label="View">
          <MenuItem icon={Settings} onSelect={() => setSettingsOpen(true)}>Interface size…</MenuItem>
        </MenuButton>
        <MenuButton label="Help">
          <MenuItem icon={CircleHelp} onSelect={() => void window.kinoPrint.showUserGuide()}>Prusa user guide</MenuItem>
          <MenuItem icon={Info} onSelect={() => setAboutOpen(true)}>About KINO Print</MenuItem>
        </MenuButton>
        <div className="menu-spacer" />
        <span className={cn('connection-chip', prusa?.isPrusa && 'is-online')}>
          <span aria-hidden="true" className="status-dot" />
          {prusa?.isPrusa ? `${prusa.device} · MK3S connected` : 'Printer offline'}
        </span>
      </nav>

      <main className="workspace">
        {error && (
          <div className="inline-error" role="alert">
            <AlertTriangle aria-hidden="true" size={20} />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button>
          </div>
        )}

        <section className="hero-panel">
          <div className="hero-copy">
            <p className="eyebrow">PRUSA MK3S · USB</p>
            <h1>Open a G-code file and print it over USB.</h1>
          </div>
          <img className="hero-logo" src="./kino-print-logo.png" alt="KINO Print" />
        </section>

        <div className="content-grid">
          <section
            className={cn('panel file-panel drop-zone', dragging && 'is-dragging')}
            aria-label="G-code file drop area"
          >
            <div className="panel-heading">
              <div><FileCode2 aria-hidden="true" size={20} /><h2>Print job</h2></div>
              {info && <span className={cn('result-badge', info.safeToPrint ? 'is-good' : 'is-error')}>{info.safeToPrint ? 'Checked' : 'Blocked'}</span>}
            </div>
            {!info ? (
              <div className="empty-state">
                <div className="empty-icon"><FolderOpen aria-hidden="true" size={34} /></div>
                <h3>{loadingFile ? 'Reading G-code…' : 'Open or drop a G-code file'}</h3>
                <p>KINO Print reads the slicer settings and checks the startup sequence.</p>
                <BevelButton onClick={() => void openFile()} disabled={loadingFile}><FolderOpen size={17} />Open G-code…</BevelButton>
                {fileError && <p className="file-error" role="alert">{fileError}</p>}
              </div>
            ) : (
              <div className="job-content">
                <button className="file-card" onClick={() => void openFile()} title="Choose a different file">
                  <FileCode2 aria-hidden="true" size={30} />
                  <span><strong>{info.name}</strong><small>{formatBytes(info.size_bytes)} · {info.command_count.toLocaleString()} commands</small></span>
                  <FolderOpen aria-hidden="true" size={18} />
                </button>
                <dl className="details-grid">
                  <Field label="Printer" value={info.printer_profile} />
                  <Field label="Material" value={info.filament_type} />
                  <Field label="Estimated time" value={info.estimated_time} />
                  <Field label="Filament" value={`${info.filament_grams} g`} />
                  <Field label="Sliced nozzle" value={`${info.nozzle_temperature}°C`} />
                  <Field label="Bed" value={`${info.bed_temperature}°C`} />
                  <Field label="Layers" value={info.total_layers.toLocaleString()} />
                  <Field label="Nozzle size" value={`${info.nozzle_diameter} mm`} />
                </dl>
                {fileError && <p className="file-error" role="alert">{fileError}</p>}
              </div>
            )}
          </section>

          <section className="panel fixes-panel">
            <div className="panel-heading">
              <div><ShieldCheck aria-hidden="true" size={20} /><h2>Checks and fixes</h2></div>
              {info && <span className="result-badge">{repairCount} fix{repairCount === 1 ? '' : 'es'}</span>}
            </div>
            {!info ? (
              <div className="muted-empty"><ShieldCheck aria-hidden="true" size={28} /><p>Open a file to check it.</p></div>
            ) : (
              <div className="fixes-content">
                {info.issues.length === 0 ? (
                  <div className="all-clear"><Check size={20} /><span>No problems found.</span></div>
                ) : info.issues.map((issue) => (
                  <article className={cn('issue', `issue-${issue.severity}`)} key={issue.id}>
                    <AlertTriangle aria-hidden="true" size={18} />
                    <div><h3>{issue.title}</h3><p>{issue.detail}</p><small><Wrench size={13} />{issue.fix}</small></div>
                  </article>
                ))}
                <div className="repair-controls">
                  <label>
                    <span><Thermometer size={17} />Print nozzle temperature</span>
                    <span className="number-input"><input type="number" min={180} max={280} value={nozzleTemp} onChange={(event) => setNozzleTemp(Number(event.target.value))} /><b>°C</b></span>
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={antiOoze} onChange={(event) => setAntiOoze(event.target.checked)} />
                    <span><strong>Keep nozzle cool until leveling</strong><small>Hold at 170°C while the bed heats and the printer levels.</small></span>
                  </label>
                  <p className="non-destructive"><ShieldCheck size={14} />Changes apply only while printing. The file on disk stays as-is.</p>
                </div>
              </div>
            )}
          </section>

          <section className="panel printer-panel">
            <div className="panel-heading">
              <div><Printer aria-hidden="true" size={20} /><h2>Printer</h2></div>
              <span className={cn('result-badge', prusa?.isPrusa ? 'is-good' : 'is-error')}>{prusa?.isPrusa ? 'Connected' : 'Offline'}</span>
            </div>
            <div className="printer-body">
              <dl className="details-grid printer-details">
                <Field label="Model" value={status.machine_type || (prusa?.isPrusa ? 'Original Prusa i3 MK3S' : '-')} />
                <Field label="Firmware" value={status.firmware || '-'} />
                <Field label="Port" value={status.port || prusa?.device || '-'} />
                <Field label="Link" value={status.baud ? `USB · ${status.baud} baud` : 'USB · 115200 baud'} />
                <Field label="USB device" value={prusa?.description || '-'} />
                <Field label="Serial" value={prusa?.serialNumber || '-'} />
              </dl>
              <div className="live-settings">
                <div><span>Speed</span><strong>{Math.round(status.speed_percent ?? 100)}%</strong></div>
                <div><span>Flow</span><strong>{Math.round(status.flow_percent ?? 100)}%</strong></div>
                <div><span>Fan</span><strong>{Math.round(status.fan_percent ?? 0)}%</strong></div>
              </div>
              <BevelButton onClick={() => void refreshPorts()}><RefreshCw size={16} />Refresh printer</BevelButton>
            </div>
          </section>

          <section className="panel monitor-panel">
            <div className="panel-heading">
              <div><Gauge aria-hidden="true" size={20} /><h2>Current print</h2></div>
              <span className={cn('state-badge', `state-${displayStatus.status}`)}>{displayStatus.nozzle_interlock === 'locked' && active ? 'EXTRUSION LOCKED' : displayStatus.status}</span>
            </div>
            <div className="monitor-body">
              <div className="monitor-status"><strong>{displayStatus.message || 'Ready'}</strong><span>{displayStatus.file_name || (!info ? 'Open or drop a G-code file' : !prusa?.isPrusa ? 'Connect the Prusa MK3S' : 'Ready to start')}</span></div>
              <div className="time-grid">
                <div><Clock3 size={17} /><span>Elapsed</span><strong>{active || displayStatus.status === 'completed' ? formatDuration(elapsedSeconds) : '-'}</strong></div>
                <div><Clock3 size={17} /><span>Remaining</span><strong>{displayStatus.remaining_minutes != null ? formatDuration(displayStatus.remaining_minutes * 60) : '-'}</strong></div>
                <div><Layers3 size={17} /><span>Layer</span><strong>{displayStatus.current_layer || 0} <small>/ {displayStatus.total_layers || info?.total_layers || 0}</small></strong></div>
                <div><Activity size={17} /><span>Height</span><strong>{displayStatus.layer_z != null ? `${displayStatus.layer_z.toFixed(2)} mm` : '-'}</strong></div>
              </div>
              <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Print progress">
                <div style={{ transform: `scaleX(${progress / 100})` }} />
              </div>
              <div className="progress-meta"><span>{progress.toFixed(1)}%</span><span>LCD {displayStatus.firmware_progress ?? 0}%</span><span>{displayStatus.commands_sent?.toLocaleString() || 0} / {displayStatus.commands_total?.toLocaleString() || 0} commands</span></div>
              <div className="temperature-grid">
                <div><Thermometer size={19} /><span>Hotend</span><strong>{temp(displayStatus.hotend)} <small>/ {temp(displayStatus.hotend_target)}</small></strong><em>PWM {Math.round(displayStatus.hotend_power ?? 0)}</em></div>
                <div><Thermometer size={19} /><span>Bed</span><strong>{temp(displayStatus.bed)} <small>/ {temp(displayStatus.bed_target)}</small></strong><em>PWM {Math.round(displayStatus.bed_power ?? 0)}</em></div>
              </div>
              <div className="position-grid">
                <span>Position</span>
                <strong>X {displayStatus.position_x?.toFixed(2) ?? '-'}</strong>
                <strong>Y {displayStatus.position_y?.toFixed(2) ?? '-'}</strong>
                <strong>Z {displayStatus.position_z?.toFixed(2) ?? '-'}</strong>
              </div>
              <div className="monitor-actions">
                {disconnectedWhileHot ? (
                  <BevelButton className="primary" onClick={() => void acknowledgePowerOff()}><Check size={18} />Printer is off</BevelButton>
                ) : !active ? (
                  <BevelButton className="primary" disabled={!canStart} onClick={() => setConfirmOpen(true)}><Play size={18} />Start print</BevelButton>
                ) : displayStatus.status === 'paused' ? (
                  <BevelButton className="primary" onClick={() => void control('resume')}><Play size={18} />Resume</BevelButton>
                ) : (
                  <BevelButton onClick={() => void control('pause')} disabled={!['heating', 'printing'].includes(displayStatus.status)}><Pause size={18} />Pause</BevelButton>
                )}
                <BevelButton className="danger" onClick={() => setStopOpen(true)} disabled={!active && !disconnectedWhileHot}><Square size={17} />{disconnectedWhileHot ? 'Retry cooldown' : 'Stop & cool'}</BevelButton>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="status-bar"><span>KINO Print 1.0.3</span><span>Local only · 115200 baud</span><span>{prusa?.description || 'No printer detected'}</span></footer>

      <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="dialog-overlay" />
          <AlertDialog.Content className="dialog-content">
            <AlertDialog.Title>Start this USB print?</AlertDialog.Title>
            <AlertDialog.Description>The PC must stay on and connected by USB for the whole print. Check the printer before starting.</AlertDialog.Description>
            <div className="confirmation-summary"><strong>{info?.name}</strong><span>{nozzleTemp}°C nozzle · {info?.bed_temperature}°C bed · {info?.estimated_time}</span><span>{antiOoze ? 'Nozzle held at 170°C until leveling' : 'Using the file’s warm-up order'}</span></div>
            <div className="readiness-list">
              {[
                ['bed', 'The build plate is clean and clear.'],
                ['filament', `${info?.filament_type || 'Correct filament'} is loaded and feeding cleanly.`],
                ['supervise', 'I will stay for heating, homing, and the first layer.'],
              ].map(([key, label]) => (
                <label key={key}><input type="checkbox" checked={readiness[key as keyof typeof readiness]} onChange={(event) => setReadiness((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>
              ))}
            </div>
            <div className="dialog-actions"><AlertDialog.Cancel asChild><BevelButton>Cancel</BevelButton></AlertDialog.Cancel><BevelButton className="primary" disabled={!readinessComplete} onClick={() => void startPrint()}><Play size={17} />Start print</BevelButton></div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={stopOpen} onOpenChange={setStopOpen}>
        <AlertDialog.Portal><AlertDialog.Overlay className="dialog-overlay" /><AlertDialog.Content className="dialog-content compact"><AlertDialog.Title>Stop and cool down?</AlertDialog.Title><AlertDialog.Description>{disconnectedWhileHot ? 'The app will reconnect only to turn both heaters off. If confirmation fails, turn the printer off with its power switch.' : 'The app will stop sending commands, turn both heaters off, stop the fan, and release the motors.'}</AlertDialog.Description><div className="dialog-actions"><AlertDialog.Cancel asChild><BevelButton>Keep printing</BevelButton></AlertDialog.Cancel><BevelButton className="danger-solid" onClick={() => void control('stop')}><Square size={17} />Stop print</BevelButton></div></AlertDialog.Content></AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content compact"><Dialog.Title>Interface size</Dialog.Title><Dialog.Description>Choose the size that is easiest to read. The app stays sharp at each setting.</Dialog.Description><div className="scale-options">{[[1, '100%', 'Compact'], [1.25, '125%', 'Recommended for 4K'], [1.5, '150%', 'Large']].map(([value, label, note]) => <button key={value} className={uiScale === value ? 'selected' : ''} onClick={() => setUiScale(Number(value))}><strong>{label}</strong><span>{note}</span>{uiScale === value && <Check size={18} />}</button>)}</div><div className="dialog-actions"><Dialog.Close asChild><BevelButton className="primary">Done</BevelButton></Dialog.Close></div></Dialog.Content></Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={aboutOpen} onOpenChange={setAboutOpen}>
        <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content about-dialog"><img src="./kino-print-logo.png" alt="KINO Print" /><Dialog.Title>KINO Print 1.0.3</Dialog.Title><Dialog.Description>USB printing for the Original Prusa i3 MK3S. File checks and temperature changes run locally on this PC.</Dialog.Description><p>KINO D4 workshop utility.</p><div className="dialog-actions"><Dialog.Close asChild><BevelButton className="primary">OK</BevelButton></Dialog.Close></div></Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
