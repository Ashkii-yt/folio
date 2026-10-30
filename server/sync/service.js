import DHT from 'hyperdht';
import { serverKeyPair, serverIdentity, idOfKey } from '../identity.js';
import { isTrusted } from './trust.js';
import { makeHandler } from './handler.js';
import { rpcServe } from './rpc.js';

/** Bootstrap override, mainly for tests: FOLIO_DHT_BOOTSTRAP="host:port,host:port". */
export const bootstrapOption = () => {
  const b = process.env.FOLIO_DHT_BOOTSTRAP;
  return b ? { bootstrap: b.split(',').map((x) => x.trim()).filter(Boolean) } : {};
};

/**
 * Makes this server reachable by its ID alone. It joins the public HyperDHT network, announces itself under its
 * public key, and lets other servers connect through NAT by hole punching: no port forwarding, no domain, no https.
 * Only paired servers get past hello; everything is end-to-end encrypted and authenticated by the key.
 */
export async function startSyncService({ log = () => {} } = {}) {
  const dht = new DHT(bootstrapOption());
  const server = dht.createServer();
  server.on('connection', (sock) => {
    const peerId = idOfKey(sock.remotePublicKey);
    const conn = { peerId, trusted: false };
    const check = () => { conn.trusted = isTrusted(peerId); };
    check();
    sock.setKeepAlive?.(5000);
    sock.on('error', () => {});
    const h = makeHandler(conn);
    rpcServe(sock, sock, async (m, p) => { if (!conn.trusted) check(); return h(m, p); });
  });
  await server.listen(serverKeyPair());
  log(`Reachable for server-to-server sync as ${serverIdentity().serverId}`);
  return { dht, async stop() { try { await server.close(); await dht.destroy(); } catch { /* ignore */ } } };
}
