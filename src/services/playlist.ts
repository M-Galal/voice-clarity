/**
 * Folder play lists. On Android the folder is chosen with the system folder picker (Storage
 * Access Framework); expo-file-system takes a persistable read grant, so the folder stays readable
 * after the app restarts until the folder is moved or deleted. Files are read in place; a file is
 * copied into the library only when it is played, so speech detection and the other tools work.
 */
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';
import { displayName, extOfName, type PlaylistItem } from '../playlist/filter';
import { SUPPORTED_EXTENSIONS, yieldToUi } from './audio';

const MAX_DEPTH = 6;
const MAX_FILES = 5000;

export class FolderUnavailableError extends Error {
  constructor(public detail: string) {
    super('folder_unavailable');
    this.name = 'FolderUnavailableError';
  }
}

/** Opens the system folder picker. Returns the folder URI, or null if the user backed out. */
export async function pickFolder(initialUri?: string): Promise<string | null> {
  try {
    const dir = await Directory.pickDirectoryAsync(initialUri);
    return dir?.uri ?? null;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    if (/cancel/i.test(msg)) return null;
    throw e;
  }
}

/** Lists every supported audio file in the folder (and its subfolders when asked). */
export async function scanFolder(folderUri: string, includeSubfolders: boolean): Promise<PlaylistItem[]> {
  const out: PlaylistItem[] = [];
  let visited = 0;
  const walk = async (dir: Directory, sub: string, depth: number) => {
    let entries: (Directory | File)[];
    try {
      entries = dir.list();
    } catch (e) {
      if (depth === 0) throw new FolderUnavailableError(e instanceof Error ? e.message : String(e));
      return; // an unreadable subfolder is skipped
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (++visited % 50 === 0) await yieldToUi();
      const name = displayName(entry.uri);
      if (entry instanceof Directory) {
        if (includeSubfolders && depth < MAX_DEPTH && !name.startsWith('.')) await walk(entry, sub ? `${sub}/${name}` : name, depth + 1);
        continue;
      }
      if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extOfName(name))) continue;
      let size = 0;
      let modified: number | undefined;
      try { size = entry.size ?? 0; } catch { /* unknown */ }
      try { modified = entry.modificationTime ?? undefined; } catch { /* unknown */ }
      out.push({ uri: entry.uri, name, subfolder: sub, size, modified });
    }
  };
  await walk(new Directory(folderUri), '', 0);
  return out;
}

/**
 * Samsung's Secure Folder accepts files from other apps through the Android share menu
 * (Share > Secure Folder > unlock > choose the app inside). Samsung documents no API for other
 * apps, so the option is offered on Samsung phones and opens the share menu.
 */
export function secureFolderLikely(): boolean {
  if (Platform.OS !== 'android') return false;
  const c = Platform.constants as { Manufacturer?: string; Brand?: string };
  return /samsung/i.test(`${c.Manufacturer ?? ''} ${c.Brand ?? ''}`);
}
