import { useEffect, useState, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkForUpdate, installKind, type InstallKind } from '../../update/check';
import styles from './UpdateBanner.module.css';

type Outcome =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'found'; version: string };

/**
 * The manual half of the updater: which version is running, how this copy was
 * installed, and a button that asks GitHub right now.
 *
 * Deliberately separate from the banner. The banner is the automatic path and
 * says nothing when there is nothing to say; this one answers a question the
 * user asked, so "you are up to date" is a result worth printing.
 *
 * Finding an update here does not install it — it lets the banner do that on
 * the next launch, or the user download it themselves. Two "Update" buttons in
 * two places, one of which sits behind a Settings screen the app is about to
 * restart out from under, is a worse experience than one.
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
    setOutcome(
      found === null ? { state: 'current' } : { state: 'found', version: found.version },
    );
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
        className={styles.button}
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
      {outcome.state === 'found' && (
        <span role="status">
          Krakenless {outcome.version} is available — it will be offered the next time you
          start the app.
        </span>
      )}
    </>
  );
}
