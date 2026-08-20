import { useEffect, useState, type ReactNode } from 'react';
import { revealFolder } from '../../config/launch';
import { saveConfig, configFolder } from '../../config/store';
import type { AppConfig } from '../../config/schema';
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
          your own <code>git</code> and nothing leaves this machine.
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
