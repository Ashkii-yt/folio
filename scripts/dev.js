// Runs the API server (auto-restarting on change) and the Vite dev server together.
import { spawn } from 'node:child_process';

const env = { ...process.env, FOLIO_DEV: '1' };
const procs = [
  spawn('node', ['--no-warnings', '--watch-path=server', 'server/index.js'], { stdio: 'inherit', env }),
  spawn('npx', ['vite'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { stop(); process.exit(code ?? 0); }));
