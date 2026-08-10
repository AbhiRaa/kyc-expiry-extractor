'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PreviewModal from './PreviewModal';
import styles from './UploadZone.module.css';

/**
 * Vercel's request body cap. This is INFRASTRUCTURE-LEVEL — it is enforced at the
 * edge before the function runs and cannot be raised by config, so client-side
 * downscaling is mandatory, not an optimisation (§11.1 #11: "Must not 413").
 */
export const BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;

/**
 * What we actually aim for. The multipart envelope, boundary and headers all sit
 * on top of the payload, and a phone on a flaky connection is not the place to
 * discover we were 20 KB over. 3.4 MB leaves ~25% headroom.
 */
const TARGET_BYTES = 3.4 * 1024 * 1024;

/** Longest edge after downscale. 2000px keeps ~300 DPI over a credit-card-sized
 *  document, which is what the OCR/barcode tiers need; beyond that we are paying
 *  upload seconds for pixels the decoder throws away. */
const MAX_EDGE = 2000;

/** Thumbnail longest edge — purely for the preview, kept tiny. */
const THUMB_EDGE = 320;

const JPEG_QUALITY_LADDER = [0.85, 0.72, 0.6, 0.45];

/** A file that has been made safe to POST, plus its preview. */
export interface PreparedUpload {
  /** The file to send. May be a re-encoded JPEG rather than the original. */
  file: File;
  /** Object/data URL for the thumbnail, or null for PDFs (no client rasterizer). */
  thumbnailUrl: string | null;
  /**
   * Full-size preview for the click-to-enlarge modal — the same pixels being uploaded,
   * not a separate re-derivation, so what the user previews is exactly what the server
   * sees. Null for PDFs, same reason `thumbnailUrl` is: no client-side rasterizer.
   */
  previewUrl: string | null;
  /** Human-readable note about what we did, e.g. "downscaled 4032×3024 → 2000×1500". */
  note: string;
  /** Original file name, for display. */
  originalName: string;
  /** Bytes actually being uploaded. */
  bytes: number;
}

/** Thrown for anything the user needs to fix themselves. Message is user-facing. */
export class UploadPrepError extends Error {}

const ACCEPTED_PREFIXES = ['image/'];
const ACCEPTED_EXACT = ['application/pdf'];
/** Browsers sometimes hand us an empty `type` for HEIC from the iOS picker. */
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif|pdf)$/i;

function isAccepted(file: File): boolean {
  if (ACCEPTED_EXACT.includes(file.type)) return true;
  if (ACCEPTED_PREFIXES.some((p) => file.type.startsWith(p))) return true;
  // Empty/unknown MIME: fall back to the extension rather than rejecting a
  // legitimate iPhone HEIC. The server still sniffs magic bytes (§11.1 #1).
  return file.type === '' && ACCEPTED_EXTENSIONS.test(file.name);
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function drawScaled(bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new UploadPrepError('This browser could not open a canvas to resize the image.');
  // White matte: JPEG has no alpha, and a transparent PNG would otherwise
  // composite onto black and destroy the contrast the OCR tier depends on.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Client-side preparation (§10): apply EXIF orientation, downscale under the body
 * limit, and produce a thumbnail.
 *
 * `createImageBitmap(file, { imageOrientation: 'from-image' })` is the whole EXIF
 * story in modern browsers — it bakes the orientation tag into the bitmap, so the
 * canvas re-encode below emits an upright image with no EXIF at all. That is a
 * privacy win as well as a correctness one: GPS and device tags in a photographed
 * passport never leave the phone (§15).
 *
 * PDFs are passed through untouched — rasterizing a PDF in the browser would ship
 * a copy of pdf.js to a phone to do work the server does better, and it would
 * throw away the text layer that makes text-native PDFs cheap (§11.1 #6).
 */
export async function prepareUpload(file: File): Promise<PreparedUpload> {
  if (file.size === 0) {
    throw new UploadPrepError('That file is empty (0 bytes). Try re-exporting it.');
  }
  if (!isAccepted(file)) {
    throw new UploadPrepError(
      `“${file.name}” is not an image or a PDF. Upload a photo, a scan, or a PDF of the document.`,
    );
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    if (file.size > BODY_LIMIT_BYTES) {
      throw new UploadPrepError(
        `That PDF is ${mb(file.size)}. The upload limit is ${mb(BODY_LIMIT_BYTES)} and a PDF ` +
          'cannot be shrunk in the browser — export fewer pages or at a lower resolution.',
      );
    }
    return {
      file,
      thumbnailUrl: null,
      previewUrl: null,
      note: `PDF, ${mb(file.size)}, sent as-is`,
      originalName: file.name,
      bytes: file.size,
    };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Formats the browser cannot decode (commonly HEIC outside Safari, or TIFF).
    // The server converts those (§11.1 #3/#4), so pass the original through when
    // it fits and fail with a readable message when it does not.
    if (file.size <= BODY_LIMIT_BYTES) {
      return {
        file,
        thumbnailUrl: null,
        previewUrl: null,
        note: `${mb(file.size)}, not previewable in this browser — converting server-side`,
        originalName: file.name,
        bytes: file.size,
      };
    }
    throw new UploadPrepError(
      `This browser cannot open “${file.name}” to resize it, and at ${mb(file.size)} it is over ` +
        `the ${mb(BODY_LIMIT_BYTES)} upload limit. Try a JPEG or PNG export.`,
    );
  }

  try {
    const source = `${bitmap.width}×${bitmap.height}`;
    let maxEdge = MAX_EDGE;
    let out: { blob: Blob; canvas: HTMLCanvasElement } | null = null;

    // Two nested ladders: quality first (cheap, preserves resolution — which is
    // what the barcode decoder cares about), then resolution. Give up only after
    // both are exhausted.
    for (let pass = 0; pass < 3 && !out; pass += 1) {
      const canvas = drawScaled(bitmap, maxEdge);
      for (const quality of JPEG_QUALITY_LADDER) {
        const blob = await canvasToBlob(canvas, quality);
        if (!blob) continue;
        if (blob.size <= TARGET_BYTES) {
          out = { blob, canvas };
          break;
        }
      }
      maxEdge = Math.round(maxEdge * 0.7);
    }

    if (!out) {
      throw new UploadPrepError(
        'Could not compress this image under the upload limit. Try a smaller photo.',
      );
    }

    const prepared = new File([out.blob], file.name.replace(/\.\w+$/, '') + '.jpg', {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });

    const thumbCanvas = drawScaled(bitmap, THUMB_EDGE);
    const thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
    // Reuses the exact canvas that produced the upload blob — the preview modal shows
    // precisely what was sent, not a separately re-derived rendering of it.
    const previewUrl = out.canvas.toDataURL('image/jpeg', 0.85);

    const resized = `${out.canvas.width}×${out.canvas.height}`;
    const note =
      source === resized
        ? `${resized}, ${mb(prepared.size)}, EXIF applied and stripped`
        : `${source} → ${resized}, ${mb(prepared.size)}, EXIF applied and stripped`;

    return {
      file: prepared,
      thumbnailUrl,
      previewUrl,
      note,
      originalName: file.name,
      bytes: prepared.size,
    };
  } finally {
    bitmap.close();
  }
}

export interface UploadZoneProps {
  /** Called with a prepared file. The parent owns the POST. */
  onFile: (prepared: PreparedUpload) => void;
  /** Called with a user-facing message when preparation fails. */
  onError: (message: string) => void;
  /** Disables interaction while a request is in flight. */
  busy: boolean;
  /** Preview of the currently selected document, rendered inside the zone. */
  preview: PreparedUpload | null;
}

/**
 * The single input surface (§10): drag-and-drop, file picker, and clipboard paste
 * in one control.
 *
 * Accessibility notes, because a div-as-dropzone is the classic way to ship an
 * unusable control:
 *   - the zone is a real `<button>`, so it is tabbable, Enter/Space-operable and
 *     announced as a control without any ARIA guesswork;
 *   - drag-and-drop is an enhancement layered on top of that button, never the
 *     only path — pointer-only affordances exclude keyboard and screen-reader users;
 *   - paste is bound to `document`, since on a phone there is no focused element
 *     to paste "into" and Ctrl/Cmd-V on desktop rarely lands on the zone itself.
 */
export default function UploadZone({ onFile, onError, busy, preview }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const dragDepth = useRef(0);

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const file = files && files.length > 0 ? files[0] : null;
      if (!file) return;
      setPreparing(true);
      try {
        onFile(await prepareUpload(file));
      } catch (err) {
        onError(
          err instanceof UploadPrepError
            ? err.message
            : 'Could not read that file. Try a different image or PDF.',
        );
      } finally {
        setPreparing(false);
      }
    },
    [onFile, onError],
  );

  // Clipboard paste (§10). Screenshot → Cmd-V is how a reviewer at a desk will
  // actually try this, and it costs eight lines.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (busy) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        void handleFiles(files);
      }
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleFiles, busy]);

  const disabled = busy || preparing;

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.zone} ${dragging ? styles.dragging : ''} ${disabled ? styles.zoneDisabled : ''}`}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!disabled) void handleFiles(e.dataTransfer.files);
        }}
      >
        {preview ? (
          <span className={styles.previewRow}>
            {preview.previewUrl ? (
              <button
                type="button"
                className={styles.thumbBox}
                onClick={() => setPreviewOpen(true)}
                // Deliberately not gated on `disabled`: looking at a larger preview of the
                // document already selected doesn't touch the in-flight request or let you
                // swap files, so there's no reason to block it while busy/preparing.
                aria-label={`Preview ${preview.originalName} — opens larger`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- client-generated data URI; next/image cannot optimise it */}
                <img
                  src={preview.thumbnailUrl ?? preview.previewUrl}
                  alt=""
                  className={styles.thumb}
                />
              </button>
            ) : (
              <span className={styles.thumbBox}>
                <span className={styles.thumbFallback} aria-hidden="true">
                  PDF
                </span>
              </span>
            )}
            <button
              type="button"
              className={styles.previewTextButton}
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              aria-describedby="upload-hint"
            >
              <span className={styles.previewText}>
                <span className={styles.previewName}>{preview.originalName}</span>
                <span className={styles.previewNote}>{preview.note}</span>
                <span className={styles.previewSwap}>Tap to choose a different document</span>
              </span>
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={styles.emptyButton}
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            aria-describedby="upload-hint"
          >
            <span className={styles.empty}>
              <span className={styles.icon} aria-hidden="true">
                ⇪
              </span>
              <span className={styles.title}>
                {preparing ? 'Preparing…' : 'Upload a document'}
              </span>
              <span className={styles.sub}>Tap to browse · drag and drop · paste</span>
            </span>
          </button>
        )}
      </div>

      {previewOpen && preview?.previewUrl ? (
        <PreviewModal
          src={preview.previewUrl}
          alt={`Full preview of ${preview.originalName}`}
          caption={preview.originalName}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}

      <p id="upload-hint" className={styles.hint}>
        Images and PDFs. Photos are rotated by their EXIF tag, stripped of metadata
        and downscaled in your browser before they are sent.
      </p>

      <input
        ref={inputRef}
        type="file"
        className={styles.input}
        accept="image/*,application/pdf"
        onChange={(e) => {
          void handleFiles(e.target.files);
          // Reset so re-selecting the same file fires `change` again.
          e.target.value = '';
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}
