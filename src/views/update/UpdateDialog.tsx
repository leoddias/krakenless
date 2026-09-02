import { useEffect, useRef, useState, type ReactNode } from 'react';
import { plainNotes } from '../../update/notes';
import { subscribeUpdateOffers } from '../../update/offers';
import { startUpdateChecks } from '../../update/schedule';
import type { AvailableUpdate } from '../../update/check';
import { trapTab } from '../shell/trapTab';
import styles from './UpdateDialog.module.css';

/**
 * Asks whether to install a newer Krakenless.
 *
 * This used to be a bar above the window. It was the wrong shape twice over:
 * the release notes are Markdown of arbitrary length, so the bar either grew
 * without limit or clipped them mid-sentence, and a strip of text at the top of
 * a window is the thing users have learned to stop seeing. Replacing your
 * running application is not a background notice — it is a question, and a
 * question gets a dialog.
 *
 * What it does *not* do is take the decision. "Later" is a real answer, the
 * dialog closes on Escape, and until Update is pressed nothing has been
 * downloaded.
 *
 * Nagging is the failure mode of an hourly check, so a declined version stays
 * declined for the rest of the session. Only a version newer than the one that
 * was turned down asks again — which is the only case where the answer might
 * genuinely have changed.
 */
export function UpdateDialog({ enabled }: { enabled: boolean }): ReactNode {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Versions the user has already said "later" to.
   *
   * A ref rather than state: the schedule's callback closes over it once, and a
   * re-render must not hand a stale set back to a running timer.
   */
  const declined = useRef(new Set<string>());
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const handle = startUpdateChecks((found) => {
      if (declined.current.has(found.version)) return;
      // Only ever fills an empty slot. That covers the install in progress too:
      // while it runs the dialog is open, so `current` is not null and a tick
      // landing mid-install cannot swap the offer under the user's click.
      setUpdate((current) => current ?? found);
    });
    return () => {
      handle.stop();
    };
    // Keyed on the setting alone: turning the check on in Settings should start
    // looking, and nothing else should restart the schedule underneath it.
  }, [enabled]);

  // Settings' own *Check for updates* button, which found something and has
  // nowhere to show it. Not gated on `enabled`: the user pressed a button, and
  // a setting about *automatic* checking does not get to swallow the answer to
  // a question they asked directly. A version declined earlier is offered
  // again here for the same reason.
  useEffect(
    () =>
      subscribeUpdateOffers((found) => {
        declined.current.delete(found.version);
        setUpdate((current) => current ?? found);
      }),
    [],
  );

  // The dialog is the task while it is open, so focus belongs in it — otherwise
  // the first Tab walks into the window behind.
  useEffect(() => {
    if (update !== null) dialog.current?.focus();
  }, [update]);

  if (update === null) return null;

  const notes = plainNotes(update.notes);

  const later = (): void => {
    declined.current.add(update.version);
    setUpdate(null);
    setError(null);
  };

  const install = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      await update.apply();
      // Both paths end by replacing this process, so returning at all means it
      // did not happen. Saying so beats a button that spins forever.
      setError('The update finished without restarting the app. Restart it yourself.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation">
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Krakenless ${update.version} is available`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !installing) {
            event.stopPropagation();
            later();
            return;
          }
          trapTab(event);
        }}
      >
        <h2 className={styles.title}>Krakenless {update.version} is available</h2>
        <p className={styles.summary}>
          {update.kind === 'portable'
            ? 'Updating replaces this program file and restarts it. Nothing else on your machine is touched, and your repositories are not affected.'
            : 'Updating runs the installer for the new version and restarts the app. Your repositories are not affected.'}
        </p>

        {notes !== '' && (
          <>
            <p className={styles.notesLabel}>Release notes</p>
            <div
              className={styles.notes}
              tabIndex={0}
              role="group"
              aria-label="Release notes"
            >
              {notes}
            </div>
          </>
        )}

        {error !== null && (
          <p className={styles.error} role="alert">
            Could not update: {error}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={installing}
            onClick={later}
          >
            Later
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? 'Updating…' : 'Update and restart'}
          </button>
        </div>
      </div>
    </div>
  );
}
