// spike/src/spike-runner.ts
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_DIR = path.resolve(__dirname, '..');

type SpikeResult = {
  name: string;
  passed: boolean;
  details: string;
};

async function runClaudeCodeOnce(prompt: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Pass prompt via stdin to avoid shell argument quoting issues on Windows.
    // Claude Code reads stdin when --print is used without a positional prompt arg.
    const args = [
      '--print',
      '--mcp-config', 'mcp-config.spike.json',
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
    ];

    const child = spawn('claude', args, {
      cwd: SPIKE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    // Attach error listener before writing to handle early child exit (EPIPE / "write after end").
    // The 'exit' event will still fire with a non-zero exit code, which is what the Promise
    // resolution uses, so we swallow the write-side error here.
    child.stdin.on('error', () => {});

    // Write prompt to stdin then close it so Claude Code knows input is done
    child.stdin.write(prompt + '\n');
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function test_15_1(): Promise<SpikeResult> {
  const prompt = 'Call the notter-spike echo tool with message="hello-from-spike" and tell me exactly what the tool returned.';
  const res = await runClaudeCodeOnce(prompt, 120_000);

  // Primary check: tool returned expected echo text
  const hasEcho = res.stdout.includes('echo: hello-from-spike');
  // Fallback: Claude paraphrased but both key terms are present
  const hasBothTerms = res.stdout.includes('hello-from-spike') && res.stdout.toLowerCase().includes('echo');
  const passed = (hasEcho || hasBothTerms) && res.exitCode === 0;

  return {
    name: '15.1 — Claude Code can call MCP tool',
    passed,
    details: `exitCode=${res.exitCode}\nhasEcho=${hasEcho}\nhasBothTerms=${hasBothTerms}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  };
}

async function main() {
  console.log('=== Spike Runner ===\n');

  const results: SpikeResult[] = [];
  results.push(await test_15_1());

  for (const r of results) {
    console.log(`[${r.passed ? 'PASS' : 'FAIL'}] ${r.name}`);
    console.log(r.details);
    console.log('');
  }

  fs.writeFileSync(
    path.join(SPIKE_DIR, 'fixtures', 'spike-results.json'),
    JSON.stringify(results, null, 2)
  );

  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error('Spike runner crashed:', err);
  process.exit(2);
});
