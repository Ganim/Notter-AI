import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { X, Play } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  writeln: (text: string) => void;
}

interface TerminalViewProps {
  id: string;
  name: string;
  onClose: (id: string) => void;
}

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(({ id, name, onClose }, ref) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [cmdInput, setCmdInput] = useState("");

  useImperativeHandle(ref, () => ({
    writeln: (text: string) => {
      xtermRef.current?.writeln(text);
    }
  }));

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;
    const term = new Terminal({ theme: { background: "#09090b", foreground: "#fafafa" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();
    term.writeln(`\x1b[36m${name} Ready\x1b[0m. Agentic Console Emulating standard CMD output.`);
    xtermRef.current = term;
    fitAddonRef.current = fit;

    const resizeObserver = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    resizeObserver.observe(terminalRef.current);
    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
    };
  }, [name]);

  const handleRunCommand = async () => {
    if (!cmdInput.trim() || !xtermRef.current) return;
    const term = xtermRef.current;
    term.writeln(`\r\n\x1b[32m$ ${cmdInput}\x1b[0m`);
    const cmd = cmdInput;
    setCmdInput("");
    try {
      const result: string = await invoke("execute_command", { cmd });
      const lines = result.split("\n");
      for (const line of lines) term.writeln(line.replace(/\r/g, ""));
    } catch (err) {
      const lines = String(err).split("\n");
      for (const line of lines) term.writeln(`\x1b[31m${line.replace(/\r/g, "")}\x1b[0m`);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-background relative border border-border rounded-md shadow-sm overflow-hidden">
      <div className="h-8 bg-muted flex items-center justify-between px-3 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-muted-foreground flex items-center space-x-2">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span>{name}</span>
        </span>
        <button onClick={() => onClose(id)} className="text-muted-foreground hover:text-destructive transition-colors">
          <X size={14} />
        </button>
      </div>
      <div ref={terminalRef} className="flex-1 w-full bg-[#09090b] p-2 overflow-hidden" />
      <div className="flex gap-2 p-2 bg-muted border-t border-border shrink-0">
        <input 
          type="text" 
          value={cmdInput} 
          onChange={e => setCmdInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleRunCommand()}
          placeholder="Execute CMD Commands natively (e.g. dir, ping google.com)..."
          className="flex-1 bg-background text-foreground text-xs border-none p-1.5 px-2 rounded-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <button 
          onClick={handleRunCommand}
          className="bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1.5 rounded-sm flex items-center justify-center transition-colors"
          title="Executar"
        >
          <Play size={14} />
        </button>
      </div>
    </div>
  );
});

TerminalView.displayName = "TerminalView";
