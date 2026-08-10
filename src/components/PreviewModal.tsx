'use client';

import { useEffect, useRef } from 'react';
import styles from './PreviewModal.module.css';

export interface PreviewModalProps {
  src: string;
  alt: string;
  /** Shown under the image, e.g. the original filename. */
  caption?: string;
  onClose: () => void;
}

/**
 * A minimal, dependency-free lightbox for the document thumbnail (§10 — the upload
 * preview should let a reviewer actually look at what they're about to send, not just a
 * postage-stamp thumbnail).
 *
 * Accessibility, same standard as the rest of this app's hand-rolled interaction code
 * (see `UploadZone`'s drag/drop and paste handling):
 *   - `role="dialog"` + `aria-modal="true"`, labelled by the caption when there is one;
 *   - focus moves to the close button on open and returns to whatever triggered the
 *     modal on close, so a keyboard/screen-reader user is never dropped back at the top
 *     of the page;
 *   - Escape closes, and so does a click on the backdrop — but not a click on the image
 *     itself, which would be a surprising way to lose your place;
 *   - background scroll is suspended while open, restored on close.
 */
export default function PreviewModal({ src, alt, caption, onClose }: PreviewModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
    // onClose is a stable callback from the parent's perspective for the lifetime of one
    // modal instance; re-running this effect on every render would re-fire the focus/
    // scroll-lock setup and fight the cleanup above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={caption ? `Preview of ${caption}` : 'Document preview'}
      >
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close preview"
        >
          ✕
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- client-generated data URI; next/image cannot optimise it */}
        <img src={src} alt={alt} className={styles.image} />
        {caption ? <p className={styles.caption}>{caption}</p> : null}
      </div>
    </div>
  );
}
