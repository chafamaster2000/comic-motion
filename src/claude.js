// Invocación headless de `claude -p`, compartida por la cola de variantes y el modo guiado.
// El prompt va por stdin (evita problemas de comillas y saltos de línea con cmd.exe en Windows).
// Solo puede escribir dentro de outDir; lee libremente el proyecto y la skill.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SKILL_DIR } from './project.js';

// Devuelve { child, done: Promise<exitCode> }. El log (stdout+stderr) queda en logFile.
export function runClaude({ cwd, prompt, model = 'sonnet', outDir, logFile, timeoutMs = 15 * 60 * 1000 }) {
  const relOut = path.relative(cwd, outDir).split(path.sep).join('/');
  const args = [
    '-p',
    '--model',
    model,
    '--allowedTools',
    'Read',
    'Glob',
    'Grep',
    `Write(${relOut}/**)`,
    '--disallowedTools',
    'Bash',
    'Edit',
    'WebFetch',
    'WebSearch',
    '--add-dir',
    SKILL_DIR,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
  ];
  const log = fs.openSync(logFile, 'w');
  const win = process.platform === 'win32';
  const child = spawn('claude', win ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args, {
    cwd,
    stdio: ['pipe', log, log],
    shell: win,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'comic-motion' },
  });
  child.stdin.on('error', () => {}); // si claude muere antes de leer el prompt
  child.stdin.end(prompt);
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      try {
        fs.closeSync(log);
      } catch {}
      reject(e);
    });
    child.on('exit', (c) => {
      clearTimeout(timer);
      try {
        fs.closeSync(log);
      } catch {}
      resolve(c);
    });
  });
  return { child, done };
}
