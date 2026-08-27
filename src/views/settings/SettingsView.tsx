import { useEffect, useState, type ReactNode } from 'react';
import { revealFolder } from '../../config/launch';
import { saveConfig, configFolder } from '../../config/store';
import { AUTO_FETCH_CHOICES, type AppConfig } from '../../config/schema';
import { useAppState, useStore } from '../../state/hooks';
import styles from './SettingsView.module.css';

/**
 * Settings, backed by the same JSON file the user can edit by hand.
 *
 * Every field is written straight through to `config.json`; there is no hidden
 * state and no database, which is what makes "backup = copy that folder" true.
 */
export function SettingsView({ onClose }: { onClose: () => void }): ReactNode {
  const store = useStore();
  const config = useAppState((state) => state.config);
  const [draft, setDraft] = useState<AppConfig>(config);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void configFolder()
      .then((path) => {
        if (!cancelled) setFolder(path);
      })
      .catch(() => {
        // Not knowing the folder is cosmetic; the settings still save.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await saveConfig(draft);
      store.dispatch({ type: 'config/loaded', config: draft });
      setSaved(true);
    } catch (failure) {
      // A failed save must not look like a successful one: the next session
      // would start with the old settings and no explanation.
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <section className={styles.panel} aria-label="Settings">
      <header className={styles.header}>
        <h2 className={styles.title}>Settings</h2>
        <button type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </header>

      <label className={styles.field}>
        <span className={styles.label}>Editor command</span>
        <input
          className={styles.input}
          value={draft.editorCommand}
          placeholder="code -g"
          onChange={(event) => update('editorCommand', event.target.value)}
        />
        <span className={styles.hint}>
          Used to open a file from a diff. The file path is appended as the last argument.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Merge tool</span>
        <input
          className={styles.input}
          value={draft.mergetool}
          placeholder="(git default)"
          onChange={(event) => update('mergetool', event.target.value)}
        />
        <span className={styles.hint}>
          Passed to <code>git mergetool --tool=…</code>. Leave empty to use whatever your
          git config already specifies.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.checkbox}>
          <input
            type="checkbox"
            checked={draft.remoteAvatars}
            onChange={(event) => update('remoteAvatars', event.target.checked)}
          />
          <span className={styles.label}>
            Show author pictures from Gravatar and GitHub
          </span>
        </span>
        <span className={styles.hint}>
          Off by default, and the only setting here that makes Krakenless talk to anything
          but your git remotes. With it on, every author whose picture is not already
          cached costs one request: authors who commit as{' '}
          <code>id+name@users.noreply.github.com</code> are looked up on{' '}
          <code>avatars.githubusercontent.com</code> by the account number in that address
          — and on Gravatar too, but only if that account no longer exists. Everyone else
          is looked up on <code>www.gravatar.com</code>, which receives a hash of their
          email address and your IP address. No account, no token, and no email address is
          sent in the clear — but a hash identifies a person just as well to anyone who
          already has their address, so this is a real thing to send and that is why it is
          off until you say otherwise. Each answer, picture or none, is cached in the{' '}
          <code>avatars</code> folder next to this config for thirty days, so the same
          author is never asked about twice. Everybody without a picture keeps the
          initials badge, which is drawn from their identity and never leaves this
          machine.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Fetch in the background</span>
        <select
          className={styles.input}
          value={String(draft.autoFetchMinutes)}
          onChange={(event) => update('autoFetchMinutes', Number(event.target.value))}
        >
          {AUTO_FETCH_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? 'Off' : `Every ${String(minutes)} minutes`}
            </option>
          ))}
        </select>
        <span className={styles.hint}>
          Runs <code>git fetch --prune</code> against your remotes on this schedule, so
          branches and commits pushed by other people show up without you asking. It only
          moves remote-tracking refs — your branches, your working tree and your commits
          are never touched, and nothing is ever merged into them. It is quiet by design:
          nothing blinks while it runs, and a fetch that fails because you are offline or
          your key is not unlocked says nothing. Use the Fetch button when you want to be
          told why one failed.
        </span>
      </label>

      <fieldset className={styles.field}>
        <legend className={styles.label}>Theme</legend>
        {(['dark', 'light', 'system'] as const).map((theme) => (
          <label key={theme} className={styles.radio}>
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={draft.theme === theme}
              onChange={() => update('theme', theme)}
            />
            {theme}
          </label>
        ))}
      </fieldset>

      <div className={styles.actions}>
        <button type="button" className={styles.save} onClick={() => void save()}>
          Save
        </button>
        {saved && <span className={styles.saved}>Saved.</span>}
        {error !== null && (
          <span className={styles.error} role="alert">
            Could not save: {error}
          </span>
        )}
      </div>

      <section className={styles.about} aria-label="About">
        <h3 className={styles.label}>About Krakenless</h3>
        <p className={styles.hint}>
          A fast, private Git client. No account, no telemetry, no subscription — it runs
          your own <code>git</code>, and the only thing it ever contacts is your git
          remotes
          {draft.remoteAvatars
            ? ', plus Gravatar and GitHub for the author pictures you turned on above'
            : ''}
          .
        </p>
        <p className={styles.hint}>
          Free and open source under AGPL-3.0. If it saves you time, sponsoring the
          project is the only thing it will ever ask for.
        </p>
      </section>

      <footer className={styles.footer}>
        <p className={styles.hint}>
          Settings live in a plain JSON file you can edit or copy. Backing it up is just
          copying that folder.
        </p>
        {folder !== null && (
          <>
            <code className={styles.folder}>{folder}</code>
            <button
              type="button"
              className={styles.close}
              onClick={() => {
                void revealFolder(folder).catch((failure: unknown) => {
                  setError(failure instanceof Error ? failure.message : String(failure));
                });
              }}
            >
              Open config folder
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
