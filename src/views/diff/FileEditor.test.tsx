import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditor } from './FileEditor';
import { FileError, type OpenFile } from '../../fs/file';
import { openFileForEdit, saveEditedFile } from '../../state/actions';
import { StoreProvider } from '../../state/hooks';
import { createStore, type Store } from '../../state/store';

vi.mock('../../state/actions', () => ({
  openFileForEdit: vi.fn(),
  saveEditedFile: vi.fn(),
}));

const open = vi.mocked(openFileForEdit);
const save = vi.mocked(saveEditedFile);

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    path: 'src/a.ts',
    text: 'one\ntwo\n',
    shape: { bom: false, eol: 'lf', finalNewline: true },
    stamp: '8-abc',
    ...overrides,
  };
}

function renderEditor(onClose = vi.fn(), store: Store = createStore()) {
  render(
    <StoreProvider store={store}>
      <FileEditor path="src/a.ts" onClose={onClose} />
    </StoreProvider>,
  );
  return { onClose, store };
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText('Contents of src/a.ts') as HTMLTextAreaElement;
}

beforeEach(() => {
  open.mockReset();
  save.mockReset();
});

describe('FileEditor', () => {
  it('shows the file once it has been read', async () => {
    open.mockResolvedValue(file());
    renderEditor();
    await waitFor(() => expect(box()).toHaveValue('one\ntwo\n'));
  });

  it('cannot save until something is actually different', async () => {
    open.mockResolvedValue(file());
    renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(box(), { target: { value: 'one\nchanged\n' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('writes the file back in its own line endings, not the text box’s', async () => {
    // This is the whole reason the shape is carried around: saving LF into a
    // CRLF file rewrites every line of it.
    open.mockResolvedValue(
      file({
        text: 'one\ntwo\n',
        shape: { bom: false, eol: 'crlf', finalNewline: true },
      }),
    );
    save.mockResolvedValue(file({ text: 'one\nchanged\n', stamp: '12-def' }));
    renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.change(box(), { target: { value: 'one\nchanged\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ path: 'src/a.ts' }),
        'one\r\nchanged\r\n',
      );
    });
  });

  it('saves again against the stamp the last write returned', async () => {
    open.mockResolvedValue(file());
    save.mockResolvedValueOnce(file({ text: 'two\n', stamp: 'second' }));
    save.mockResolvedValueOnce(file({ text: 'three\n', stamp: 'third' }));
    renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.change(box(), { target: { value: 'two\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved to disk/);

    fireEvent.change(box(), { target: { value: 'three\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(save).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ stamp: 'second' }),
        'three\n',
      );
    });
  });

  it('says so when the file changed underneath, and keeps the typed text', async () => {
    // Losing what the user typed here would be the worst possible reaction to
    // a refusal that exists to protect their work.
    open.mockResolvedValue(file());
    save.mockRejectedValue(
      new FileError('changed-on-disk', 'src/a.ts changed on disk since it was opened'),
    );
    renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.change(box(), { target: { value: 'mine\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed on disk/);
    expect(box()).toHaveValue('mine\n');
  });

  it('does not claim a save that failed', async () => {
    open.mockResolvedValue(file());
    save.mockRejectedValue(new FileError('write-failed', 'disk is full'));
    renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.change(box(), { target: { value: 'x\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing was written/);
    expect(screen.queryByText(/Saved to disk/)).not.toBeInTheDocument();
  });

  it('explains a file it will not open instead of showing an empty box', async () => {
    open.mockRejectedValue(
      new FileError('not-editable', 'This file contains NUL bytes, so it is binary.'),
    );
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent(/NUL bytes/);
    expect(screen.queryByLabelText('Contents of src/a.ts')).not.toBeInTheDocument();
  });

  it('closes straight away when nothing was typed', async () => {
    open.mockResolvedValue(file());
    const { onClose } = renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before throwing away unsaved text', async () => {
    open.mockResolvedValue(file());
    const { onClose } = renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.change(box(), { target: { value: 'unsaved\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/unsaved changes/i);

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes and close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('takes back the question when the user keeps typing', async () => {
    open.mockResolvedValue(file());
    renderEditor();
    await waitFor(() => expect(box()).toBeInTheDocument());

    fireEvent.change(box(), { target: { value: 'unsaved\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.change(box(), { target: { value: 'still going\n' } });

    expect(
      screen.queryByRole('button', { name: 'Discard changes and close' }),
    ).not.toBeInTheDocument();
  });

  it('says which endings it will write, so saving holds no surprises', async () => {
    open.mockResolvedValue(
      file({ shape: { bom: true, eol: 'crlf', finalNewline: false } }),
    );
    renderEditor();

    expect(await screen.findByText(/CRLF endings/)).toHaveTextContent(
      /byte-order mark.*no trailing newline/,
    );
  });
});
