import { useEffect, useRef, useState } from 'react';
import type { SelfTestEvent } from '@kino/kdp';
import { factoryResetAndReconnect, getDevice, onSelfTestEvent, rebootAndReconnect, resetConfigToDefaults } from '../../app/session';
import { useDeviceStore } from '../../state/deviceStore';
import { ConfirmSheet } from '../Dialog';
import { useReadOnly } from '../useReadOnly';
import { dayName } from '../copy';
import { BackupRestore } from './BackupRestore';
import { checkSentences } from './matchCopy';
import { SettingRow } from './Setting';
import { useUpdateCheckStore } from './useUpdateCheck';

const CHECK_TIMEOUT_MS = 60_000;
type Dialog = 'restart' | 'reset' | 'erase' | null;

/**
 * Maintenance: the things KINO cannot do for itself, each a sentence and
 * one word. The heading is the one place the warning red is used as a
 * heading. Nothing here says firmware, reboot, calibration or factory.
 */
export function Maintenance({ onUpdate, onMatch }: { onUpdate: () => void; onMatch: () => void }) {
  const state = useDeviceStore();
  const readOnly = useReadOnly();
  const available = useUpdateCheckStore((s) => s.available);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string[] | null>(null);
  const checkingRef = useRef(false);
  checkingRef.current = checking;

  useEffect(
    () =>
      onSelfTestEvent((e: SelfTestEvent) => {
        if (!e.done || !checkingRef.current) return;
        setChecking(false);
        setCheckResult(checkSentences(e.results ?? []));
      }),
    [],
  );

  useEffect(() => {
    if (!checking) return;
    const t = setTimeout(() => {
      setChecking(false);
      setCheckResult(["KINO didn't finish the check. Try again."]);
    }, CHECK_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [checking]);

  const check = async () => {
    const dev = getDevice();
    if (!dev || checking) return;
    setCheckResult(null);
    setChecking(true);
    try {
      await dev.startSelfTest();
    } catch {
      setChecking(false);
      setCheckResult(["KINO didn't start the check. Try again."]);
    }
  };

  const act = async (work: () => Promise<void>, failed: string) => {
    setDialog(null);
    setNote(null);
    try {
      await work();
    } catch {
      setNote(failed);
    }
  };

  const matched = state.calibration?.capturedAt ? `Matched on ${dayName(new Date(state.calibration.capturedAt))}.` : 'Not matched yet. The first photo you take matches them.';
  const version = state.info?.p4Firmware ?? '';

  return (
    <>
      <h2 className="is-maintenance">Maintenance</h2>
      <SettingRow label="Update" action={available ? 'Update KINO' : undefined} disabled={readOnly} onAction={onUpdate}>
        {available ? `KINO ${available.release} is ready.` : `KINO is up to date, ${version}.`}
      </SettingRow>
      <SettingRow label="Match the lenses" action="Match again" disabled={readOnly} onAction={onMatch}>
        {matched}
      </SettingRow>
      <BackupRestore />
      <SettingRow label="Restart" action="Restart" disabled={readOnly} onAction={() => setDialog('restart')}>
        KINO restarts and comes back in about ten seconds.
      </SettingRow>
      <SettingRow label="Reset settings" action="Reset settings…" disabled={readOnly} onAction={() => setDialog('reset')}>
        Every setting back to how KINO shipped. Photos, looks you made, Wi-Fi and Roll stay.
      </SettingRow>
      <SettingRow label="Erase KINO" action="Erase…" warning disabled={readOnly} onAction={() => setDialog('erase')}>
        Settings, networks and Roll are erased. Photos on the card are not touched.
      </SettingRow>
      <SettingRow label="Check KINO" action={checking ? undefined : 'Check KINO'} disabled={readOnly} onAction={() => void check()}>
        {checking ? 'Checking… about twenty seconds.' : 'About twenty seconds.'}
        {checkResult ? <span className="c-quiet">{checkResult.length === 0 ? 'Nothing to fix.' : checkResult.join(' ')}</span> : null}
      </SettingRow>
      {note ? <p className="c-quiet">{note}</p> : null}

      <ConfirmSheet open={dialog === 'restart'} confirmLabel="Restart" onCancel={() => setDialog(null)} onConfirm={() => void act(rebootAndReconnect, "KINO didn't restart. Try again.")}>
        <p>Back in a moment? KINO restarts and comes back in about ten seconds.</p>
      </ConfirmSheet>
      <ConfirmSheet open={dialog === 'reset'} confirmLabel="Reset settings" warning onCancel={() => setDialog(null)} onConfirm={() => void act(resetConfigToDefaults, "KINO didn't reset its settings. Try again.")}>
        <p>Every setting back to how KINO shipped? Photos, looks you made, Wi-Fi and Roll stay. This cannot be undone.</p>
      </ConfirmSheet>
      <ConfirmSheet open={dialog === 'erase'} confirmLabel="Erase everything" warning onCancel={() => setDialog(null)} onConfirm={() => void act(factoryResetAndReconnect, "KINO didn't erase. Try again.")}>
        <p>Erase KINO? Settings, networks and Roll are erased. Photos on the card are not touched. This cannot be undone.</p>
      </ConfirmSheet>
    </>
  );
}
