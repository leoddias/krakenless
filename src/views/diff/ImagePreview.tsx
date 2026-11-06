/**
 * Before and after, drawn, for an image the diff can only call binary.
 *
 * Each side loads on its own and fails on its own: a "before" that no longer
 * exists in the object store must not hide the "after" the user came to see.
 * A side that is absent by nature — no before for a new file, no after for a
 * deleted one — is said in words rather than left as an empty frame.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { loadImage, type LoadedImage } from '../../fs/preview';
import type { FileDiff } from '../../git/types';
import { useAppState } from '../../state/hooks';
import styles from './DiffView.module.css';
import {
  displayScale,
  formatBytes,
  imageMime,
  type ImageSides,
  type ImageSource,
} from './imageSides';

export function ImagePreview({
  file,
  sides,
}: {
  file: FileDiff;
  sides: ImageSides;
}): ReactNode {
  // Either name gives the format: a rename keeps its bytes' type on both sides.
  const mime = imageMime(file.newPath) ?? imageMime(file.oldPath) ?? 'image/png';
  const both = sides.before !== null && sides.after !== null;
  // The `index <old>..<new>` line names the exact blobs the diff compared, so
  // it changes whenever either side's content does — including an edit on
  // disk at the same path. Without it in the key a refreshed diff would keep
  // drawing the bytes of the first load, right beside Stage and Discard.
  const version = file.headerLines.find((line) => line.startsWith('index ')) ?? '';
  return (
    <div className={styles.imagePreview} aria-label={`Image preview of ${file.newPath}`}>
      {sides.before !== null && (
        <ImagePane
          title={both ? 'Before' : 'Deleted'}
          source={sides.before}
          mime={mime}
          version={version}
        />
      )}
      {sides.after !== null && (
        <ImagePane
          title={both ? 'After' : 'Added'}
          source={sides.after}
          mime={mime}
          version={version}
        />
      )}
    </div>
  );
}

type PaneState =
  | { state: 'loading' }
  | { state: 'ready'; image: LoadedImage }
  | { state: 'failed'; reason: string };

function ImagePane({
  title,
  source,
  mime,
  version,
}: {
  title: string;
  source: ImageSource;
  mime: string;
  /** Changes when the content behind either side does; see `ImagePreview`. */
  version: string;
}): ReactNode {
  const root = useAppState((state) =>
    state.repo.state === 'ready' && !state.repo.value.bare ? state.repo.value.root : null,
  );
  const [pane, setPane] = useState<PaneState>({ state: 'loading' });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // The source object is rebuilt on every render; what identifies the version
  // is its kind, revision and path — and the blobs the diff compared.
  const key = `${
    source.from === 'worktree'
      ? `worktree:${source.path}`
      : `${JSON.stringify(source.source)}:${source.path}`
  }|${version}`;

  useEffect(() => {
    let cancelled = false;
    setPane({ state: 'loading' });
    setSize(null);
    if (root === null) {
      setPane({ state: 'failed', reason: 'The repository path is not known yet.' });
      return;
    }
    void loadImage(root, source, mime).then(
      (image) => {
        if (!cancelled) setPane({ state: 'ready', image });
      },
      (error: unknown) => {
        if (!cancelled) {
          setPane({
            state: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // `source` is followed through `key`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, key, mime]);

  const scale = size === null ? 1 : displayScale(size.width, size.height);

  return (
    <figure className={styles.imagePane}>
      <figcaption className={styles.imageCaption}>
        <span className={styles.imageTitle}>{title}</span>
        {pane.state === 'ready' && (
          <span className={styles.imageMeta}>
            {[
              size === null ? null : `${String(size.width)} × ${String(size.height)}`,
              formatBytes(pane.image.bytes),
              scale > 1 ? `shown at ${String(scale)}×` : null,
            ]
              .filter((part) => part !== null)
              .join(' · ')}
          </span>
        )}
      </figcaption>
      {pane.state === 'loading' && <p className={styles.fileNote}>Reading the image…</p>}
      {pane.state === 'failed' && (
        <p
          className={styles.fileNote}
        >{`This version cannot be shown: ${pane.reason}`}</p>
      )}
      {pane.state === 'ready' && (
        <div className={styles.imageFrame}>
          <img
            className={
              scale > 1 ? `${styles.image} ${styles.imagePixelated}` : styles.image
            }
            src={pane.image.url}
            alt={`${title}: ${source.path}`}
            style={
              size === null ? undefined : { width: `${String(size.width * scale)}px` }
            }
            onLoad={(event) => {
              const img = event.currentTarget;
              setSize({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() =>
              setPane({
                state: 'failed',
                reason: 'the bytes are not an image this window can draw.',
              })
            }
          />
        </div>
      )}
    </figure>
  );
}
