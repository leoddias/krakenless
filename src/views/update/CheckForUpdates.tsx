import { useEffect, useState, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkForUpdate, installKind, type InstallKind } from '../../update/check';
import { offerUpdate } from '../../update/offers';
import styles from './UpdateDialog.module.css';

type Outcome = { state: 'idle' } | { state: 'checking' } | { state: 'current' };

/**
 * The manual half of the updater: which version is running, how this copy was
 * installed, and a button that asks GitHub right now.
 *
 * Deliberately separate from the dialog. The dialog is the automatic path and
 * says nothing when there is nothing to say; this one answers a question the
 * user asked, so "you are up to date" is a result worth printing.
 *
 * When it *does* find something it hands it to the dialog rather than growing a
 * second Update button — one that would sit behind a Settings screen the app is
 * about to restart out from under. So the successful case prints nothing here:
 * the answer arrives as the dialog opening over the top.
 */
export function CheckForUpdates(): ReactNode {
  const [version, setVersion] = useState<string | null>(null);
  const [kind, setKind] = useState<InstallKind | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getVersion().catch(() => null), installKind()]).then(
      ([running, how]) => {
        if (cancelled) return;
        setVersion(running);
        setKind(how);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const check = async (): Promise<void> => {
    setOutcome({ state: 'checking' });
    const found = await checkForUpdate();
    setOutcome({ state: found === null ? 'current' : 'idle' });
    if (found !== null) offerUpdate(found);
  };

  return (
    <>
      <span>
        {version === null ? 'Version unknown' : `Version ${version}`}
        {kind === 'portable' && ' · portable'}
        {kind === 'unknown' &&
          ' · this copy cannot update itself, because it is not where its installer put it'}
      </span>{' '}
      <button
        type="button"
        className={styles.secondary}
        disabled={outcome.state === 'checking' || kind === 'unknown'}
        onClick={() => void check()}
      >
        {outcome.state === 'checking' ? 'Checking…' : 'Check for updates'}
      </button>{' '}
      {outcome.state === 'current' && (
        <span role="status">
          Nothing newer was found. If you are offline, that is also what this says.
        </span>
      )}
    </>
  );
}
