/**
 * Playlist rules: which files in a folder make the play list, and in what order.
 * Pure functions, no React Native imports, so they run in unit tests.
 */

export interface PlaylistItem {
  uri: string;
  /** File name with extension, decoded for display. */
  name: string;
  /** Folder path inside the picked folder ('' for the top level). */
  subfolder: string;
  size: number;
  /** Milliseconds since 1970, when known. */
  modified?: number;
}

export type PlaylistSort = 'name' | 'newest' | 'oldest';

export interface PlaylistFilter {
  /** Part of the name, or a pattern with * and ?; several separated by ; */
  name: string;
  /** Extensions without dots; empty = every supported extension. */
  extensions: string[];
  sort: PlaylistSort;
}

/** "m4a, .MP3; wav" → ["m4a", "mp3", "wav"] */
export function parseExtensions(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,;|]+/)) {
    const e = part.trim().replace(/^\*?\./, '').toLowerCase();
    if (e && /^[a-z0-9]+$/.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

export const extOfName = (name: string) => {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
};

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a name test. Each ;-separated term is either a pattern (has * or ?), matched against
 * the whole file name, or plain text, matched anywhere in the name. Case is ignored.
 * An empty filter matches everything.
 */
export function nameMatcher(filter: string): (name: string) => boolean {
  const terms = filter.split(';').map((s) => s.trim()).filter(Boolean);
  if (terms.length === 0) return () => true;
  const tests = terms.map((term) => {
    if (/[*?]/.test(term)) {
      const re = new RegExp(`^${term.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c))).join('')}$`, 'i');
      // "call_*" should also match "call_01.m4a": try with and without the extension
      return (name: string) => re.test(name) || re.test(name.replace(/\.[^.]+$/, ''));
    }
    const needle = term.toLowerCase();
    return (name: string) => name.toLowerCase().includes(needle);
  });
  return (name) => tests.some((f) => f(name));
}

/** Natural order, so "part 2" comes before "part 10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function applyFilter(items: PlaylistItem[], filter: PlaylistFilter, supported: readonly string[]): PlaylistItem[] {
  const allowed = filter.extensions.length ? filter.extensions.filter((e) => supported.includes(e)) : [...supported];
  const matchName = nameMatcher(filter.name);
  const kept = items.filter((it) => allowed.includes(extOfName(it.name)) && matchName(it.name));
  const byName = (a: PlaylistItem, b: PlaylistItem) =>
    collator.compare(a.subfolder, b.subfolder) || collator.compare(a.name, b.name);
  return kept.sort((a, b) => {
    if (filter.sort === 'name') return byName(a, b);
    const ta = a.modified ?? 0, tb = b.modified ?? 0;
    return (filter.sort === 'newest' ? tb - ta : ta - tb) || byName(a, b);
  });
}

/**
 * Display name of a file from its URI. Storage Access Framework URIs end in an encoded
 * document id such as "primary%3AMusic%2FCalls%2Fcall%2001.m4a"; file:// URIs end in the name.
 */
export function displayName(uri: string): string {
  const clean = uri.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep as is */ }
  const afterSlash = decoded.slice(decoded.lastIndexOf('/') + 1);
  return afterSlash.includes(':') ? afterSlash.slice(afterSlash.lastIndexOf(':') + 1) : afterSlash;
}

/**
 * Readable folder path for a picked folder. SAF tree URIs carry "primary:Music/Calls" (internal
 * storage) or "1A2B-3C4D:Recordings" (SD card); file:// URIs carry a normal path.
 */
export function folderLabel(uri: string, internalName = 'Internal storage', cardName = 'SD card'): string {
  const tree = /\/tree\/([^/]+)/.exec(uri);
  if (tree) {
    let id = tree[1];
    try { id = decodeURIComponent(id); } catch { /* keep */ }
    const i = id.indexOf(':');
    const volume = i >= 0 ? id.slice(0, i) : '';
    const path = i >= 0 ? id.slice(i + 1) : id;
    const root = volume === 'primary' ? internalName : volume === 'home' ? 'Documents' : volume ? `${cardName} (${volume})` : '';
    return [root, path].filter(Boolean).join('/');
  }
  let p = uri.replace(/^file:\/\//, '');
  try { p = decodeURI(p); } catch { /* keep */ }
  return p.replace(/\/+$/, '') || '/';
}

/** Next / previous index in a play list, or null at the ends. */
export function stepIndex(index: number, length: number, step: 1 | -1): number | null {
  const n = index + step;
  return n >= 0 && n < length ? n : null;
}
