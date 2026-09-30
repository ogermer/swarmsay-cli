// Takes the account-routes contract snapshot from a LOCAL swarmsay instance that has account login
// switched on and advertised: contract/openapi.accounts.json. The instance builds its own address
// into the document, so every occurrence of it is replaced with https://swarmsay.com, which makes the
// snapshot comparable with the production one (contract/openapi.json).
//
//   node scripts/snapshot-accounts.mjs http://host.docker.internal:3100 [public-origin-used-in-doc]
//
// The second argument is the address the instance names itself with, if it differs from the one
// used to reach it (e.g. http://localhost:3100 when reached as host.docker.internal).
import { writeFile } from 'node:fs/promises';

const reach = process.argv[2];
if (!reach) {
  console.error('usage: node scripts/snapshot-accounts.mjs <local origin> [origin named in the document]');
  process.exit(2);
}
const host = new URL(reach).hostname;
const local =
  ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) ||
  host.endsWith('.localhost') ||
  host.endsWith('.test');
if (!local) {
  console.error(`refusing ${reach}: the account snapshot is taken from a local instance only`);
  process.exit(2);
}
const res = await fetch(new URL('/openapi.json', reach), {
  headers: { 'User-Agent': 'swarmsay-cli-contract-snapshot (+https://github.com/ogermer/swarmsay-cli)' },
});
if (!res.ok) {
  console.error(`${reach}/openapi.json answered ${res.status}`);
  process.exit(2);
}
let text = await res.text();
const named = new Set([new URL(reach).origin, process.argv[3] ? new URL(process.argv[3]).origin : undefined]);
for (const o of named) if (o) text = text.split(o).join('https://swarmsay.com');
const doc = JSON.parse(text);
if (!doc.paths['/device/code'] || !doc.paths['/account']) {
  console.error('the document has no device/account routes: are account login AND advertising switched on?');
  process.exit(1);
}
await writeFile(
  new URL('../contract/openapi.accounts.json', import.meta.url),
  JSON.stringify(doc, null, 2) + '\n',
);
console.log('wrote contract/openapi.accounts.json');
