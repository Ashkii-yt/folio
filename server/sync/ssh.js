import { spawn } from 'node:child_process';
import { rpcClient, SyncError } from './rpc.js';

/** ssh://user@host[:port]/path/to/folio  — runs `node server/cli.js stdio` over the system ssh client. */
export const isSsh = (t) => /^ssh:\/\//i.test(String(t || ''));

export function parseSsh(t) {
  let u;
  try { u = new URL(t); } catch { throw new SyncError(`"${t}" is not a valid ssh address.`, 'Example: ssh://pi@192.168.1.20/home/pi/folio'); }
  if (!u.hostname) throw new SyncError('The ssh address needs a host.');
  const dir = decodeURIComponent(u.pathname || '').replace(/^\/~\//, '~/') || '';
  return { host: `${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.hostname}`, port: u.port, dir };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function connectSsh(target) {
  const { host, port, dir } = parseSsh(target);
  const bin = process.env.FOLIO_SSH_BIN || 'ssh';
  const remoteCmd = `${dir ? `cd ${dir.startsWith('~/') ? `~/${quote(dir.slice(2))}` : quote(dir)} && ` : ''}node --no-warnings server/cli.js stdio`;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(port ? ['-p', port] : []), host, remoteCmd];
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-600); });
  child.stdin.on('error', () => {});
  const client = rpcClient(child.stdout, child.stdin);
  child.on('error', (e) => client.close() || void e);
  const origCall = client.call;
  client.call = (m, p) => origCall(m, p).catch((e) => {
    if (/closed|lost/.test(e.message) && err.trim()) throw new SyncError(`ssh failed: ${err.trim().split('\n').pop()}`, 'Check that you can `ssh` there without a password prompt (use an ssh key), and that the folder holds Folio with its dependencies installed.');
    throw e;
  });
  const close = client.close;
  client.close = () => { close(); try { child.kill(); } catch { /* ignore */ } };
  return client;
}
