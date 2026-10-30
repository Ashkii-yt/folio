import createTestnet from 'hyperdht/testnet.js';
const tn = await createTestnet(4);
console.log(tn.bootstrap.map((b) => `${b.host}:${b.port}`).join(','));
setInterval(() => {}, 1e6);
