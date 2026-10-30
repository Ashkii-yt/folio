import DHT from 'hyperdht';
import { serverKeyPair, serverIdentity, isServerId, publicKeyOf } from '../identity.js';
import { bootstrapOption } from './service.js';
import { rpcClient, SyncError } from './rpc.js';
import { connectSsh, isSsh } from './ssh.js';
import { PROTOCOL } from './tables.js';
import { resolveTarget } from './trust.js';

async function connectDht(serverId, timeoutMs = 45_000) {
  if (serverId === serverIdentity().serverId) throw new SyncError('That is this same server.');
  const dht = new DHT(bootstrapOption());
  const done = () => dht.destroy().catch(() => {});
  try {
    await dht.fullyBootstrapped();
    const sock = dht.connect(publicKeyOf(serverId), { keyPair: serverKeyPair() });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new SyncError(`Could not reach ${serverId}.`, 'Is that server running (npm start) and online? Some networks (mobile data, strict corporate firewalls) block direct connections; use ssh:// or a VPN such as Tailscale there.')), timeoutMs);
      sock.once('open', () => { clearTimeout(t); resolve(); });
      sock.once('error', (e) => { clearTimeout(t); reject(new SyncError(`Could not connect to ${serverId} (${e.message}).`, 'Is that server running and online?')); });
    });
    sock.setKeepAlive?.(5000);
    const client = rpcClient(sock, sock);
    const close = client.close;
    client.close = () => { close(); done(); };
    return client;
  } catch (e) {
    await done();
    throw e;
  }
}

/** Connect to a saved name, a server ID, or an ssh:// address, and say hello. */
export async function connectTo(key) {
  const entry = resolveTarget(key);
  const target = entry.target;
  let client;
  if (isSsh(target)) client = connectSsh(target);
  else if (isServerId(target)) client = await connectDht(target);
  else throw new SyncError(`"${key}" is not a server ID, a saved name, or an ssh:// address.`, 'Server IDs look like srv_ followed by 64 characters. See `npm run peers`.');
  try {
    const hello = await client.call('hello', { protocol: PROTOCOL });
    if (isServerId(target) && hello.serverId !== target) throw new SyncError('The server that answered has a different ID than the one asked for.');
    if (hello.serverId === serverIdentity().serverId) throw new SyncError('That is this same server.');
    return { client, hello, target, name: entry.name };
  } catch (e) {
    client.close();
    throw e;
  }
}
