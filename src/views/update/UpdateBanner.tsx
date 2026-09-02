import { useEffect, useState, type ReactNode } from 'react';
import { checkForUpdate, type AvailableUpdate } from '../../update/check';
import styles from './UpdateBanner.module.css';

/**
 * Tells the user a newer Krakenless exists, and installs it if they say so.
 *
 * The check runs once per launch and only when the setting allows it; there is
 * no polling, because an app that has been open for a day has nothing to gain
 * from learning about a release the moment it lands. What it finds is offered,
 * never applied: the click is the consent, and until it happens nothing has
 * been downloaded (ADR-0036).
 *
 * "Later" dismisses for this launch only. It is not a preference — a version
 * declined on Monday is one the user should be asked about again, and the
 * setting is where declining permanently lives.
 */
export function UpdateBanner({ enabled }: { enabled: boolean }): ReactNode {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void checkForUpdate().then((found) => {
      if (!cancelled) setUpdate(found);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the setting alone: turning the check on in
    // Settings should look immediately, and nothing else should make the app
    // ask again within one launch.
  }, [enabled]);

  if (update === null || dismissed) return null;

  const install = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      await update.apply();
      // Reaching here means the process was not replaced. Both paths end in a
      // restart, so a quiet return is a failure that reported nothing, and
      // saying so beats a button that stays greyed out forever.
      setError('The update finished without restarting the app. Restart it yourself.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className={styles.bar} role="status">
      <div className={styles.body}>
        <p className={styles.message}>
          Krakenless {update.version} is available.
          {update.kind === 'portable' && ' It will replace this file and restart.'}
        </p>
        {update.notes !== '' && <p className={styles.notes}>{update.notes}</p>}
        {error !== null && (
          <p className={styles.error} role="alert">
            Could not update: {error}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={installing}
          onClick={() => void install()}
        >
          {installing ? 'Updating…' : 'Update'}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={installing}
          onClick={() => setDismissed(true)}
        >
          Later
        </button>
      </div>
    </div>
  );
}
