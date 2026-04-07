import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; current: string }
  | { kind: 'available'; current: string; next: string; update: Update }
  | { kind: 'downloading'; progress: number }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

export async function getCurrentVersion(): Promise<string> {
  return await getVersion();
}

export async function checkForUpdates(): Promise<UpdateState> {
  try {
    const current = await getVersion();
    const update = await check();
    if (update) {
      return { kind: 'available', current, next: update.version, update };
    }
    return { kind: 'up-to-date', current };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message ?? String(e) };
  }
}

export async function downloadAndInstall(
  update: Update,
  onProgress: (state: UpdateState) => void,
): Promise<void> {
  try {
    let downloaded = 0;
    let total = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? 0;
          onProgress({ kind: 'downloading', progress: 0 });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          onProgress({
            kind: 'downloading',
            progress: total > 0 ? Math.round((downloaded / total) * 100) : 0,
          });
          break;
        case 'Finished':
          onProgress({ kind: 'installing' });
          break;
      }
    });

    await relaunch();
  } catch (e) {
    onProgress({ kind: 'error', message: (e as Error).message ?? String(e) });
  }
}
