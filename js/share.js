// Sharing to X and credits.
//
// X's web intent cannot carry a file, so on desktop we save the file and open a pre-filled post
// for the user to attach it to. On phones the system share sheet sends the file itself (the user
// picks X), which is the only way to post a video in one step.

export const SITE_URL = 'https://winchxyz.github.io/spiralist/';
export const REPO_URL = 'https://github.com/winchxyz/spiralist';
export const AUTHOR = { handle: 'winchxyz', url: 'https://x.com/winchxyz' };

export function xIntentUrl(text, url = SITE_URL) {
  const q = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${q}`;
}

export const shareText = kind => (kind === 'video'
  ? `Watch my photo turn into one continuous line. Made with Spiralist by @${AUTHOR.handle}`
  : `My photo, redrawn as one continuous line. Made with Spiralist by @${AUTHOR.handle}`);

/**
 * Share a file to X. Must be called from a click handler: the new tab is opened synchronously so
 * popup blockers allow it, before the (possibly slow) file is ready.
 * @param getBlob  () => Promise<Blob> | Blob
 * @param opts     { filename, kind: 'image'|'video', download(blob, name), canShare(type) }
 * @returns 'shared' | 'cancelled' | 'intent'
 */
export async function shareToX(getBlob, { filename, kind, download, canShare, mime }) {
  const text = shareText(kind);
  const nativeFiles = canShare?.(mime);
  if (nativeFiles) {
    // Phones: hand the actual file to the share sheet (X accepts images and videos from it).
    try {
      const blob = await getBlob();
      const file = new File([blob], filename, { type: blob.type || mime });
      await navigator.share({ files: [file], text: `${text} ${SITE_URL}` });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // fall through to the intent
    }
  }
  const tab = window.open(xIntentUrl(text), '_blank', 'noopener');
  const blob = await getBlob();
  download(blob, filename);
  if (!tab) location.href = xIntentUrl(text);
  return 'intent';
}

/** GitHub star count, cached for an hour; null when offline or rate-limited. */
export async function starCount() {
  const KEY = 'spiralist:stars';
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && Date.now() - c.t < 3600e3) return c.n;
  } catch { /* storage blocked */ }
  try {
    const r = await fetch('https://api.github.com/repos/winchxyz/spiralist', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const n = (await r.json()).stargazers_count;
    try { localStorage.setItem(KEY, JSON.stringify({ n, t: Date.now() })); } catch { /* ignore */ }
    return n;
  } catch { return null; }
}
