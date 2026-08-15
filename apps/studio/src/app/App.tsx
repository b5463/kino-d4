import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { MenuBar } from '../components/MenuBar';
import type { MenuSpec } from '../components/MenuBar';
import { Toolbar } from '../components/Toolbar';
import { StatusBar } from '../components/StatusBar';
import { Sidebar, PAGE_LABEL } from '../components/Sidebar';
import type { PageId } from '../components/Sidebar';
import { ConnectHome } from '../components/ConnectHome';
import { DebugPanel } from '../components/DebugPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Led } from '../components/Led';
import { useConnectionStore } from '../state/connectionStore';
import { useDeviceStore } from '../state/deviceStore';
import { usePrefs, setDensity, setDeveloperMode } from '../state/prefs';
import { emitUi } from '../state/uiBus';
import { useNavRequest } from '../state/navRequest';
import { blockedBy } from '../state/deviceBusy';
import { useDraftStore } from '../state/draftStore';
import {
  connectSerial,
  connectDemo,
  disconnect,
  isDemo,
  rebootAndReconnect,
  refreshAll,
} from './session';
import { OverviewPage } from '../pages/Overview/OverviewPage';
import { ShootPage } from '../pages/Shoot/ShootPage';
import { WigglePage } from '../pages/Wiggle/WigglePage';
import { QuadPage } from '../pages/Quad/QuadPage';
import { LooksPage } from '../pages/Looks/LooksPage';
import { CalibrationPage } from '../pages/Calibration/CalibrationPage';
import { GalleryPage } from '../pages/Gallery/GalleryPage';
import { DevicePage } from '../pages/Device/DevicePage';
import { UpdatesPage } from '../pages/Updates/UpdatesPage';
import { DeveloperPage } from '../pages/Developer/DeveloperPage';
import { BringUpPage } from '../pages/BringUp/BringUpPage';

const PAGE_KEY = 'kino-studio.page';
export const APP_VERSION = '1.0.0';

const PAGES: Record<PageId, ComponentType> = {
  overview: OverviewPage,
  shoot: ShootPage,
  wiggle: WigglePage,
  quad: QuadPage,
  looks: LooksPage,
  calibration: CalibrationPage,
  gallery: GalleryPage,
  device: DevicePage,
  updates: UpdatesPage,
  developer: DeveloperPage,
  bringup: BringUpPage,
};

function loadPage(): PageId {
  const saved = localStorage.getItem(PAGE_KEY);
  return saved && saved in PAGES ? (saved as PageId) : 'overview';
}

export function App() {
  const phase = useConnectionStore((s) => s.phase);
  const serialSupported = useConnectionStore((s) => s.serialSupported);
  const hasInfo = useDeviceStore((s) => s.info !== null);
  const density = usePrefs((s) => s.density);
  const developerMode = usePrefs((s) => s.developerMode);
  const [page, setPage] = useState<PageId>(loadPage);
  const [rebootOpen, setRebootOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const dirtyDrafts = useDraftStore((s) => s.dirty);
  const workRef = useRef<HTMLElement>(null);
  const syncRef = useRef<() => void>(() => {});

  // A readout in one section linking to the section that measured it. The
  // target page reads the `tab` out of the same request.
  const navRequest = useNavRequest((s) => s.request);
  useEffect(() => {
    if (navRequest) setPage(navRequest.page);
  }, [navRequest]);

  useEffect(() => {
    localStorage.setItem(PAGE_KEY, page);
    // The old scroll offset was carried across and merely clamped, so a new
    // section opened part-way down.
    workRef.current?.scrollTo({ top: 0 });
  }, [page]);

  // Drafts survive the page swap, so navigating away is safe — closing the
  // tab is not. This is the only place unsaved work can actually be lost.
  useEffect(() => {
    const sections = Object.values(dirtyDrafts);
    if (sections.length === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyDrafts]);

  const inSession =
    (phase === 'connected' || phase === 'maintenance' || phase === 'updating' || phase === 'reconnecting') && hasInfo;
  const connected = phase === 'connected' || phase === 'maintenance';

  useEffect(() => {
    if (!developerMode && (page === 'developer' || page === 'bringup')) setPage('overview');
  }, [developerMode, page]);

  // Desktop-utility keys: Ctrl+S saves the open section, F5 re-reads the
  // camera. Both are no-ops unless a camera is actually attached.
  useEffect(() => {
    if (!connected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        emitUi('apply');
        return;
      }
      if (e.key === 'F5' && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        syncRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connected]);

  // One entry point for SYNC and F5 so both report progress and both respect
  // the exclusive link claim.
  const sync = () => {
    if (syncBusy) return;
    setSyncBusy(true);
    setSyncNote(null);
    void refreshAll()
      .then((r) => {
        if (r === 'blocked') {
          setSyncNote(`${blockedBy('sync') ?? 'Another operation'} is using the link — SYNC skipped`);
        }
      })
      .finally(() => setSyncBusy(false));
  };

  syncRef.current = sync;

  const goto = (target: PageId) => setPage(target);

  const runSelfTest = () => {
    goto('overview');
    emitUi('self-test');
  };

  const menus: MenuSpec[] = [
    {
      label: 'File',
      items: [
        {
          label: 'Back Up Camera…',
          disabled: !connected,
          action: () => {
            goto('device');
            emitUi('backup');
          },
        },
        {
          label: 'Restore From File…',
          disabled: !connected,
          action: () => {
            goto('device');
            emitUi('restore');
          },
        },
        {
          label: 'Disconnect',
          disabled: !inSession || phase === 'updating' || phase === 'reconnecting',
          separatorAbove: true,
          action: () => void disconnect(),
        },
      ],
    },
    {
      label: 'Camera',
      items: [
        { label: 'Connect Kino Camera…', disabled: inSession || !serialSupported, action: () => void connectSerial() },
        { label: 'Open Demo Device', disabled: inSession, action: () => void connectDemo() },
        { label: 'Run Self Test', disabled: !connected, separatorAbove: true, action: runSelfTest },
        { label: 'Reboot Camera…', disabled: !connected, action: () => setRebootOpen(true) },
        { label: 'Update Firmware…', disabled: !connected, separatorAbove: true, action: () => goto('updates') },
      ],
    },
    {
      label: 'View',
      items: [
        ...(
          [
            ['Overview', 'overview'],
            ['Shoot', 'shoot'],
            ['Wiggle', 'wiggle'],
            ['Quad', 'quad'],
            ['Looks', 'looks'],
            ['Calibration', 'calibration'],
            ['Gallery', 'gallery'],
            ['Device', 'device'],
            ['Updates', 'updates'],
          ] as [string, PageId][]
        ).map(([label, id]) => ({
          label,
          disabled: !inSession,
          checked: page === id,
          action: () => goto(id),
        })),
        {
          label: 'Compact Density',
          separatorAbove: true,
          checked: density === 'compact',
          action: () => setDensity('compact'),
        },
        {
          label: 'Comfortable Density',
          checked: density === 'comfortable',
          action: () => setDensity('comfortable'),
        },
      ],
    },
    {
      label: 'Tools',
      items: [
        {
          label: 'Developer Mode',
          checked: developerMode,
          action: () => setDeveloperMode(!developerMode),
        },
        {
          label: 'Simulator Faults',
          disabled: !isDemo() || !inSession,
          action: () => emitUi('toggle-faults'),
        },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About KINO Studio…', action: () => setAboutOpen(true) }],
    },
  ];

  const Page = PAGES[page];

  return (
    <div className="frame">
      <a
        className="skiplink"
        href="#work"
        onClick={(e) => {
          e.preventDefault();
          workRef.current?.focus();
        }}
      >
        SKIP TO {inSession ? PAGE_LABEL[page].toUpperCase() : 'CONNECT'}
      </a>
      <MenuBar menus={menus} version={APP_VERSION} />
      <Toolbar onNavigate={goto} onSelfTest={runSelfTest} onSync={sync} syncBusy={syncBusy} />
      {/* Section changes are a page change in every way except the URL, so
          they get announced like one. */}
      <p className="sr-only" role="status">
        {syncNote ?? (inSession ? `${PAGE_LABEL[page]} — KINO Studio` : '')}
      </p>
      <div className="mainrow">
        {inSession ? (
          <Sidebar
            page={page}
            onNavigate={goto}
            locked={phase === 'updating' ? 'Not while firmware is being written' : null}
          />
        ) : null}
        <main className="workspace" id="work" tabIndex={-1} ref={workRef} aria-label={inSession ? PAGE_LABEL[page] : 'Connect'}>
          {inSession ? (
            <>
              {phase === 'reconnecting' ? (
                <div className="reconnectbar" role="status">
                  <Led state="busy" label="" />
                  KINO IS REBOOTING — RECONNECTING…
                </div>
              ) : null}
              <div className="workspace-inner">
                <Page />
              </div>
            </>
          ) : (
            <ConnectHome />
          )}
        </main>
      </div>
      {inSession && isDemo() ? <DebugPanel /> : null}
      <StatusBar />

      <ConfirmDialog
        open={rebootOpen}
        focusCancel
        title="REBOOT KINO"
        confirmLabel="REBOOT"
        onCancel={() => setRebootOpen(false)}
        onConfirm={() => {
          setRebootOpen(false);
          void rebootAndReconnect();
        }}
      >
        <p>Restart the camera now? KINO Studio reconnects automatically after boot.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={aboutOpen}
        title="ABOUT KINO STUDIO"
        confirmLabel="OK"
        onCancel={() => setAboutOpen(false)}
        onConfirm={() => setAboutOpen(false)}
      >
        <p>
          <strong>KINO Studio {APP_VERSION}</strong>
          <br />
          Programmer and configuration utility for the KINO four-lens camera.
          <br />
          <br />
          No account, no cloud, no telemetry. Everything stays between the camera and this computer.
        </p>
      </ConfirmDialog>
    </div>
  );
}
