// src/components/WindowControls.tsx
//
// Custom Min / Max-toggle / Close buttons that replace the native Windows
// titlebar (disabled via tauri.conf.json windows[0].decorations: false).
// Sized to Windows 11 system buttons (44x32). Close turns red on hover.
// The Maximize icon flips to a "restore" glyph when the window is already
// maximized, kept in sync via `onResized` to catch OS-side state changes
// (Win+Up, snap, double-click on the drag region, etc.).
import { useEffect, useState } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let mounted = true;
    win.isMaximized().then((v) => { if (mounted) setMaximized(v); });
    const unlistenPromise = win.onResized(async () => {
      const v = await win.isMaximized();
      if (mounted) setMaximized(v);
    });
    return () => {
      mounted = false;
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="flex items-center" data-tauri-drag-region="false">
      <button
        onClick={() => win.minimize()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        title="Minimize"
        type="button"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        title={maximized ? 'Restore' : 'Maximize'}
        type="button"
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        onClick={() => win.close()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white transition-colors"
        title="Close"
        type="button"
      >
        <X size={14} />
      </button>
    </div>
  );
}
