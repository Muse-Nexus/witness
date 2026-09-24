import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { ImageUpload, Item, NewItem } from '../api/types';
import { fromDateInputValue } from '../lib/format';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

function mediaTypeOf(file: File): string | null {
  if (file.type in ACCEPTED) return file.type;
  // Some browsers leave HEIC photos untyped.
  if (!file.type && /\.hei[cf]$/i.test(file.name)) return 'image/heic';
  return null;
}

/**
 * The file exactly as it is. Evidence is the original image, so nothing here redraws or
 * re-encodes it (that would change its pixels and drop its details). A HEIC photo stays
 * HEIC: where a browser or mail app cannot show one, the app offers the original to open
 * elsewhere, and Witness never puts an image-only HEIC photo in an email.
 */
export function readImage(file: File): Promise<ImageUpload> {
  const mediaType = mediaTypeOf(file);
  if (!mediaType) return Promise.reject(new Error('That kind of file is not supported. Try a JPEG, PNG, WebP, GIF, or HEIC image.'));
  if (file.size > MAX_IMAGE_BYTES) return Promise.reject(new Error('That image is larger than 10 MB.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That image could not be read.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve({ base64: result.slice(result.indexOf(',') + 1), mediaType });
    };
    reader.readAsDataURL(file);
  });
}

/** A quiet box for adding something by hand: paste words, or drop an image. */
export function AddSomething({ onAdded }: { onAdded: (item: Item) => void }) {
  const api = useApi();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [quote, setQuote] = useState('');
  const [fromName, setFromName] = useState('');
  const [date, setDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function chooseFile(next: File | null | undefined) {
    setError(null);
    if (!next) return;
    if (!mediaTypeOf(next)) {
      setError('That kind of file is not supported. Try a JPEG, PNG, WebP, GIF, or HEIC image.');
      return;
    }
    if (next.size > MAX_IMAGE_BYTES) {
      setError('That image is larger than 10 MB.');
      return;
    }
    setFile(next);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0]);
  }

  // Who and when appear once there is something to describe, so the box stays one quiet row until used.
  const expanded = Boolean(quote.trim() || file || fromName || date);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const text = quote.trim();
    if (!text && !file) {
      setError('Paste the words, or add an image.');
      return;
    }
    setBusy(true);
    try {
      const input: NewItem = {};
      if (text) input.quote = text;
      if (fromName.trim()) input.fromName = fromName.trim();
      const occurredAt = fromDateInputValue(date);
      if (occurredAt !== undefined) input.occurredAt = occurredAt;
      if (file) input.image = await readImage(file);
      const item = await api.addItem(input);
      onAdded(item);
      setQuote('');
      setFromName('');
      setDate('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setMessage('Kept.');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That was not kept. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={dragging ? 'add-box is-dragging' : 'add-box'}
      onSubmit={submit}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="add-box__title">
        Add something
      </h2>
      <label htmlFor={`${id}-quote`} className="visually-hidden">
        What they said, in their exact words
      </label>
      <textarea
        id={`${id}-quote`}
        className="add-box__quote"
        rows={1}
        placeholder="Paste what someone said, word for word, or drop an image here"
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
      />
      {preview && (
        <div className="add-box__preview">
          <img src={preview} alt="The image you are adding" />
          <button type="button" className="btn btn--quiet btn--small" onClick={() => setFile(null)}>
            Remove image
          </button>
        </div>
      )}
      {expanded && (
        <div className="add-box__details">
          <div className="field">
            <label htmlFor={`${id}-who`}>
              Who said it <span className="optional">(optional)</span>
            </label>
            <input id={`${id}-who`} value={fromName} onChange={(e) => setFromName(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor={`${id}-when`}>
              When <span className="optional">(optional)</span>
            </label>
            <input id={`${id}-when`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
      )}
      <div className="add-box__actions">
        <div className="add-box__file">
          <label htmlFor={`${id}-file`} className="btn btn--ghost btn--small file-button">
            {file ? 'Another image' : 'Add an image'}
          </label>
          <input
            ref={fileInput}
            id={`${id}-file`}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/heic,.heic"
            onChange={(e) => chooseFile(e.target.files?.[0])}
          />
        </div>
        <button type="submit" className="btn btn--primary btn--small" disabled={busy}>
          Keep it
        </button>
      </div>
      <div className="add-box__messages">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="form-status" role="status">
          {message}
        </p>
      </div>
    </form>
  );
}
