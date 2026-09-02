import { useEffect, useState, type ReactNode } from 'react';
import { revealFolder } from '../../config/launch';
import { saveConfig, configFolder } from '../../config/store';
import {
  AUTO_FETCH_CHOICES,
  HISTORY_LIMIT_CHOICES,
  type AppConfig,
} from '../../config/schema';
import { useAppState, useStore } from '../../state/hooks';
import { CheckForUpdates } from '../update';
import styles from './SettingsView.module.css';

/**
 * Settings, backed by the same JSON file the user can edit by hand.
 *
 * Every field is written straight through to `config.json`; there is no hidden
 * state and no database, which is what makes "backup = copy that folder" true.
 *
 * The screen is a rail of sections beside one page of settings, rather than
 * every setting stacked into a single column. The reason is the prose: this app
 * explains what each option actually does — which host it contacts, what that
 * host receives, what is never touched — and those paragraphs are the point,
 * not filler to be cut. Stacked, they turned four settings into a wall nobody
 * reads. A section at a time is short enough to be read, and the rail says what
 * else exists without making it all present at once.
 *
 * One draft, one Save, whichever section is open: the settings are a single
 * file and a single answer, and a per-section save would leave the user
 * guessing which of their changes had been written.
 */

type SectionId = 'general' | 'ai' | 'appearance' | 'privacy' | 'about';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy', label: 'Privacy & updates' },
  { id: 'about', label: 'About' },
];

/** Writes one field of the draft. */
type Update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;

export function SettingsView({ onClose }: { onClose: () => void }): ReactNode {
  const store = useStore();
  const config = useAppState((state) => state.config);
  const [draft, setDraft] = useState<AppConfig>(config);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [section, setSection] = useState<SectionId>('general');

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

  const update: Update = (key, value) => {
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

  const current = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  return (
    <section className={styles.panel} aria-label="Settings">
      <nav className={styles.rail} aria-label="Settings sections">
        <div className={styles.railHead}>
          <h2 className={styles.title}>Settings</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        </div>
        <ul className={styles.railList}>
          {SECTIONS.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={entry.id === section ? styles.railItemActive : styles.railItem}
                // Not a tablist: these are pages of one form, and the tab
                // pattern would put the arrow keys on the rail, where a user
                // moving between fields does not expect to land.
                aria-current={entry.id === section ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className={styles.content}>
        <div className={styles.scroll}>
          <h3 className={styles.sectionTitle}>{current?.label}</h3>

          {section === 'general' && <GeneralSection draft={draft} update={update} />}
          {section === 'ai' && <AiSection draft={draft} update={update} />}
          {section === 'appearance' && (
            <AppearanceSection draft={draft} update={update} />
          )}
          {section === 'privacy' && <PrivacySection draft={draft} update={update} />}
          {section === 'about' && (
            <AboutSection draft={draft} folder={folder} onFolderError={setError} />
          )}
        </div>

        {/*
          The save bar belongs to the whole screen, not to a section: there is
          one draft behind all of them, and a Save that scrolled away with the
          field it followed was a Save people missed.
        */}
        <footer className={styles.bar}>
          <button type="button" className={styles.save} onClick={() => void save()}>
            Save
          </button>
          {saved && <span className={styles.saved}>Saved.</span>}
          {error !== null && (
            <span className={styles.error} role="alert">
              Could not save: {error}
            </span>
          )}
        </footer>
      </div>
    </section>
  );
}

/**
 * One setting: its name on the left, the control and everything the app has to
 * say about it on the right.
 *
 * A `label` element, so the name is the control's accessible name and clicking
 * it focuses the control — the two columns are a grid, not two fields that
 * happen to sit side by side.
 */
function Row({
  label,
  children,
  hints,
}: {
  label: string;
  children: ReactNode;
  hints: ReactNode[];
}): ReactNode {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowControl}>
        {children}
        {hints.map((hint, index) => (
          <span key={index} className={styles.hint}>
            {hint}
          </span>
        ))}
      </span>
    </label>
  );
}

/** The same shape for a switch, whose name reads better beside the box. */
function CheckRow({
  label,
  checked,
  onChange,
  hints,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hints: ReactNode[];
}): ReactNode {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel} />
      <span className={styles.rowControl}>
        <span className={styles.checkbox}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className={styles.checkboxLabel}>{label}</span>
        </span>
        {hints.map((hint, index) => (
          <span key={index} className={styles.hint}>
            {hint}
          </span>
        ))}
      </span>
    </label>
  );
}

function GeneralSection({ draft, update }: { draft: AppConfig; update: Update }) {
  return (
    <>
      <Row
        label="Editor command"
        hints={[
          'Used to open a file from a diff. The file path is appended as the last argument.',
        ]}
      >
        <input
          className={styles.input}
          value={draft.editorCommand}
          placeholder="code -g"
          onChange={(event) => update('editorCommand', event.target.value)}
        />
      </Row>

      <Row
        label="Merge tool"
        hints={[
          <>
            Passed to <code>git mergetool --tool=…</code>. Leave empty to use whatever
            your git config already specifies.
          </>,
        ]}
      >
        <input
          className={styles.input}
          value={draft.mergetool}
          placeholder="(git default)"
          onChange={(event) => update('mergetool', event.target.value)}
        />
      </Row>

      <Row
        label="Commits in the graph"
        hints={[
          <>
            How far back the history panel reads when a repository is opened or refreshed.
            Every commit read becomes a row with a graph cell and an author badge, so this
            is what a slow, heavy graph costs you — raise it when you genuinely look
            further back than this, and expect the panel to take longer to build.
          </>,
        ]}
      >
        <select
          className={styles.input}
          value={String(draft.historyLimit)}
          onChange={(event) => update('historyLimit', Number(event.target.value))}
        >
          {HISTORY_LIMIT_CHOICES.map((count) => (
            <option key={count} value={count}>
              {count.toLocaleString('en-US')}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label="Fetch in the background"
        hints={[
          <>
            Runs <code>git fetch --prune</code> against your remotes on this schedule, so
            branches and commits pushed by other people show up without you asking. It
            only moves remote-tracking refs — your branches, your working tree and your
            commits are never touched, and nothing is ever merged into them. It is quiet
            by design: nothing blinks while it runs, and a fetch that fails because you
            are offline or your key is not unlocked says nothing. Use the Fetch button
            when you want to be told why one failed.
          </>,
        ]}
      >
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
      </Row>
    </>
  );
}

function AiSection({ draft, update }: { draft: AppConfig; update: Update }) {
  return (
    <>
      <Row
        label="AI command"
        hints={[
          <>
            Program run by the <strong>AI Commit</strong> button, which writes a commit
            message from your staged changes. A program name or path — not a command line;
            the arguments are Krakenless&apos;s to decide. Defaults to <code>claude</code>
            . Leave it empty to turn the button off.
          </>,
          <>
            Krakenless has no API key and opens no connection of its own: it runs a CLI
            you already installed and signed in to, the same way it runs <code>git</code>.
            Your <strong>staged diff is written to that program</strong>, so where the
            code goes next is decided by the tool you name here.
          </>,
        ]}
      >
        <input
          className={styles.input}
          value={draft.aiCommand}
          placeholder="(off)"
          onChange={(event) => update('aiCommand', event.target.value)}
        />
      </Row>

      <Row
        label="AI model"
        hints={[
          <>
            Passed to that program as <code>--model</code>. A commit subject is a small
            job, so the default is the cheap one: <code>haiku</code>.
          </>,
        ]}
      >
        <input
          className={styles.input}
          value={draft.aiModel}
          onChange={(event) => update('aiModel', event.target.value)}
        />
      </Row>
    </>
  );
}

function AppearanceSection({ draft, update }: { draft: AppConfig; update: Update }) {
  return (
    <fieldset className={styles.row}>
      <legend className={styles.rowLabel}>Theme</legend>
      <span className={styles.rowControl}>
        <span className={styles.radios}>
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
        </span>
        <span className={styles.hint}>
          <code>system</code> follows whatever the desktop is set to, and changes with it.
        </span>
      </span>
    </fieldset>
  );
}

function PrivacySection({ draft, update }: { draft: AppConfig; update: Update }) {
  return (
    <>
      <CheckRow
        label="Show author pictures from Gravatar and GitHub"
        checked={draft.remoteAvatars}
        onChange={(value) => update('remoteAvatars', value)}
        hints={[
          <>
            Off by default, and the only setting here that makes Krakenless talk to
            anything but your git remotes. With it on, every author whose picture is not
            already cached costs one request: authors who commit as{' '}
            <code>id+name@users.noreply.github.com</code> are looked up on{' '}
            <code>avatars.githubusercontent.com</code> by the account number in that
            address — and on Gravatar too, but only if that account no longer exists.
            Everyone else is looked up on <code>www.gravatar.com</code>, which receives a
            hash of their email address and your IP address. No account, no token, and no
            email address is sent in the clear — but a hash identifies a person just as
            well to anyone who already has their address, so this is a real thing to send
            and that is why it is off until you say otherwise. Each answer, picture or
            none, is cached in the <code>avatars</code> folder next to this config for
            thirty days, so the same author is never asked about twice. Everybody without
            a picture keeps the initials badge, which is drawn from their identity and
            never leaves this machine.
          </>,
        ]}
      />

      <CheckRow
        label="Check for a new version of Krakenless"
        checked={draft.autoUpdateCheck}
        onChange={(value) => update('autoUpdateCheck', value)}
        hints={[
          <>
            On by default. Shortly after the app starts and once an hour after that, it
            asks <code>leoddias.github.io</code> for a small JSON file naming the newest
            release. There is no account, no identifier and no request body — what the
            request costs you is what any HTTPS request costs: your IP address, and the
            fact that something asked. If the file names the version you are already
            running, nothing else happens at all. Turning this off means the app makes no
            such request, not that it hides the answer; the button below still works
            whenever you press it. Finding an update never installs one: a dialog asks,
            and Later is a real answer — a version you turn down is not raised again until
            a newer one exists. Whatever is downloaded is checked against a signature made
            by this project&apos;s release key before it is allowed to run — without that,
            an auto-updater would be a way to run any program that could reach you.
          </>,
          <CheckForUpdates key="check" />,
        ]}
      />
    </>
  );
}

function AboutSection({
  draft,
  folder,
  onFolderError,
}: {
  draft: AppConfig;
  folder: string | null;
  onFolderError: (message: string) => void;
}) {
  return (
    <section className={styles.about} aria-label="About">
      <p className={styles.prose}>
        A fast, private Git client. No account, no telemetry, no subscription — it runs
        your own <code>git</code>, and the only thing it ever contacts is your git remotes
        {draft.autoUpdateCheck ? ', its own release page once per launch' : ''}
        {draft.remoteAvatars
          ? ', plus Gravatar and GitHub for the author pictures you turned on'
          : ''}
        .
      </p>
      <p className={styles.prose}>
        Free and open source under AGPL-3.0. If it saves you time, sponsoring the project
        is the only thing it will ever ask for.
      </p>

      <h4 className={styles.subTitle}>Where your settings live</h4>
      <p className={styles.prose}>
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
                onFolderError(
                  failure instanceof Error ? failure.message : String(failure),
                );
              });
            }}
          >
            Open config folder
          </button>
        </>
      )}
    </section>
  );
}
