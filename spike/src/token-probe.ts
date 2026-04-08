// spike/src/token-probe.ts
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_DIR = path.resolve(__dirname, '..');
const FIXTURES = path.join(SPIKE_DIR, 'fixtures');

const TINY_PROMPT = 'Say the single word "pong" and nothing else.';

type ProbeResult = {
  cli: string;
  available: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

function runCLI(command: string, args: string[], stdin?: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        cli: command,
        available: false,
        stdout,
        stderr: `Spawn error: binary not found`,
        exitCode: -1,
        durationMs: Date.now() - start,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        cli: command,
        available: true,
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
      });
    });

    if (stdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function probeGemini(): Promise<ProbeResult> {
  // Gemini CLI: prompt via -p flag (short) — check gemini --help if this fails
  return runCLI('gemini', ['-p', TINY_PROMPT]);
}

async function probeCodex(): Promise<ProbeResult> {
  // Codex CLI: exec subcommand with prompt
  return runCLI('codex', ['exec', TINY_PROMPT]);
}

async function probeClaudeCode(): Promise<ProbeResult> {
  // Claude Code: --print JSON mode, prompt via stdin
  return runCLI('claude', ['--print', '--output-format', 'json', '--dangerously-skip-permissions'], TINY_PROMPT + '\n');
}

async function main() {
  console.log('=== Token Probe ===\n');

  const probes = [
    { name: 'gemini', fn: probeGemini, file: 'gemini-output.txt' },
    { name: 'codex', fn: probeCodex, file: 'codex-output.txt' },
    { name: 'claude-code', fn: probeClaudeCode, file: 'claude-code-output.txt' },
  ];

  for (const p of probes) {
    console.log(`>> Probing ${p.name}...`);
    const res = await p.fn();

    const blob = `=== ${p.name} ===
available: ${res.available}
exitCode: ${res.exitCode}
durationMs: ${res.durationMs}

--- stdout ---
${res.stdout}

--- stderr ---
${res.stderr}
`;

    fs.writeFileSync(path.join(FIXTURES, p.file), blob);
    console.log(`   saved to fixtures/${p.file}\n`);
  }
}

main().catch((err) => {
  console.error('Token probe crashed:', err);
  process.exit(1);
});
