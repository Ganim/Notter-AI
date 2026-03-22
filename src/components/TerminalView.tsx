import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { X, RotateCw } from "lucide-react";
import { useAppStore, TERMINAL_THEMES } from "@/stores/app-store";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  writeln: (text: string) => void;
  writeInput: (data: string) => Promise<void>;
}

type ShellType = 'powershell' | 'bash' | 'cmd';

interface TerminalViewProps {
  id: string;
  name: string;
  cwd?: string;
  shell?: ShellType;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

interface PtyOutputPayload {
  id: string;
  data: string;
}

interface PtyExitPayload {
  id: string;
  code: number;
}

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  ({ id, name, cwd, shell: initialShell, onClose, onRename }, ref) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [alive, setAlive] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentShell, setCurrentShell] = useState<ShellType>(initialShell || 'powershell');
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(name);
    const { terminalSettings } = useAppStore();

    const shellLabels: Record<ShellType, string> = {
      powershell: 'PS',
      bash: 'Bash',
      cmd: 'CMD',
    };

    const getTheme = () => {
      const t = TERMINAL_THEMES.find((th) => th.name === terminalSettings.themeName) || TERMINAL_THEMES[0];
      return { background: t.background, foreground: t.foreground, cursor: t.cursor, selectionBackground: t.selectionBackground };
    };

    useImperativeHandle(ref, () => ({
      writeln: (text: string) => {
        xtermRef.current?.writeln(text);
      },
      writeInput: async (data: string) => {
        await invoke("write_pty", { id, data });
      },
    }));

    const startPty = async (term: Terminal) => {
      setError(null);
      setAlive(true);
      try {
        const { cols, rows } = term;
        await invoke("create_pty", { id, cols, rows, cwd: cwd || null, shell: currentShell });
      } catch (e) {
        setError(String(e));
        setAlive(false);
      }
    };

    useEffect(() => {
      if (!terminalRef.current || xtermRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        theme: getTheme(),
        fontFamily: terminalSettings.fontFamily,
        fontSize: terminalSettings.fontSize,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(terminalRef.current);
      fit.fit();

      xtermRef.current = term;
      fitAddonRef.current = fit;

      // Send keystrokes to PTY
      term.onData((data) => {
        invoke("write_pty", { id, data }).catch(() => {});
      });

      // Handle resize
      term.onResize(({ cols, rows }) => {
        invoke("resize_pty", { id, cols, rows }).catch(() => {});
      });

      // Fit on container resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddonRef.current?.fit();
      });
      resizeObserver.observe(terminalRef.current);

      // Listen for PTY events BEFORE starting PTY (avoid race condition)
      let unlistenOutput: UnlistenFn | null = null;
      let unlistenExit: UnlistenFn | null = null;
      let cancelled = false;

      (async () => {
        const [unOut, unEx] = await Promise.all([
          listen<PtyOutputPayload>("pty-output", (event) => {
            if (event.payload.id === id) {
              term.write(event.payload.data);
            }
          }),
          listen<PtyExitPayload>("pty-exit", (event) => {
            if (event.payload.id === id) {
              setAlive(false);
              term.writeln(`\r\n\x1b[90m[Process exited with code ${event.payload.code}]\x1b[0m`);
            }
          }),
        ]);

        if (cancelled) {
          unOut();
          unEx();
          return;
        }

        unlistenOutput = unOut;
        unlistenExit = unEx;

        // Now safe to start PTY — listeners are registered
        await startPty(term);
      })();

      return () => {
        cancelled = true;
        resizeObserver.disconnect();
        unlistenOutput?.();
        unlistenExit?.();
        invoke("close_pty", { id }).catch(() => {});
        term.dispose();
        xtermRef.current = null;
      };
    }, [id]);

    // Update terminal appearance when settings change
    useEffect(() => {
      const term = xtermRef.current;
      if (!term) return;
      term.options.theme = getTheme();
      term.options.fontFamily = terminalSettings.fontFamily;
      term.options.fontSize = terminalSettings.fontSize;
      fitAddonRef.current?.fit();
    }, [terminalSettings]);

    const handleRenameSubmit = () => {
      if (renameValue.trim() && renameValue !== name) {
        onRename(id, renameValue.trim());
      }
      setIsRenaming(false);
    };

    const handleRestart = async () => {
      const term = xtermRef.current;
      if (!term) return;
      term.clear();
      await invoke("close_pty", { id }).catch(() => {});
      await startPty(term);
    };

    const handleSwitchShell = async (newShell: ShellType) => {
      setCurrentShell(newShell);
      const term = xtermRef.current;
      if (!term) return;
      term.clear();
      await invoke("close_pty", { id }).catch(() => {});
      setError(null);
      setAlive(true);
      try {
        const { cols, rows } = term;
        await invoke("create_pty", { id, cols, rows, cwd: cwd || null, shell: newShell });
      } catch (e) {
        setError(String(e));
        setAlive(false);
      }
    };

    return (
      <div className="flex flex-col h-full min-h-0 bg-background relative border border-border rounded-md shadow-sm overflow-hidden">
        <div className="h-8 bg-muted flex items-center justify-between px-3 border-b border-border shrink-0">
          <div className="text-xs font-semibold text-muted-foreground flex items-center space-x-2 min-w-0">
            <div className={`w-2 h-2 rounded-full shrink-0 ${alive ? "bg-green-500" : "bg-red-500"}`} />
            {isRenaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setIsRenaming(false); }}
                onBlur={handleRenameSubmit}
                className="bg-background text-foreground text-xs px-1 py-0.5 rounded-sm border border-border outline-none focus:ring-1 focus:ring-ring w-28"
              />
            ) : (
              <span
                onDoubleClick={() => { setRenameValue(name); setIsRenaming(true); }}
                className="truncate cursor-default" title="Double-click to rename"
              >
                {name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Shell selector */}
            <div className="flex bg-background rounded-sm border border-border overflow-hidden">
              {(["powershell", "bash", "cmd"] as ShellType[]).map((sh) => (
                <button
                  key={sh}
                  onClick={() => sh !== currentShell && handleSwitchShell(sh)}
                  className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${currentShell === sh ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {shellLabels[sh]}
                </button>
              ))}
            </div>
            {!alive && (
              <button
                onClick={handleRestart}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Restart"
              >
                <RotateCw size={14} />
              </button>
            )}
            <button
              onClick={() => onClose(id)}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {error ? (
          <div className="flex-1 flex items-center justify-center p-4">
            <div className="text-center space-y-2">
              <p className="text-sm text-destructive font-medium">Failed to start terminal</p>
              <p className="text-xs text-muted-foreground max-w-sm">{error}</p>
              <button
                onClick={handleRestart}
                className="text-xs text-primary hover:underline"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div ref={terminalRef} className="flex-1 w-full overflow-hidden" style={{ backgroundColor: getTheme().background }} />
        )}
      </div>
    );
  }
);

TerminalView.displayName = "TerminalView";
