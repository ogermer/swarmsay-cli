// Contract-drift check: compares the live public openapi.json with the committed snapshot in
// contract/openapi.json. A difference means swarmsay's public API changed; review it, refresh the
// snapshot (`--update`), regenerate the types (`pnpm gen:types`) and adapt the CLI.
import { readFile, writeFile } from 'node:fs/promises';

const url = process.env.SWARMSAY_CONTRACT_URL ?? 'https://swarmsay.com/openapi.json';
const snapshotPath = new URL('../contract/openapi.json', import.meta.url);

const res = await fetch(url, {
  headers: { 'User-Agent': 'swarmsay-cli-contract-check (+https://github.com/ogermer/swarmsay-cli)' },
});
if (!res.ok) {
  console.error(`contract check: ${url} answered ${res.status}`);
  process.exit(2);
}
const live = await res.json();

if (process.argv.includes('--update')) {
  await writeFile(snapshotPath, JSON.stringify(live, null, 2) + '\n');
  console.log(`contract check: snapshot updated from ${url}`);
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
const canon = (v) => JSON.stringify(sortKeys(v), null, 1);
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

const a = canon(snapshot).split('\n');
const b = canon(live).split('\n');
if (a.join('\n') === b.join('\n')) {
  console.log(`contract check: ${url} matches contract/openapi.json`);
  process.exit(0);
}

// A small line diff: enough to see where the drift is.
console.error(`contract check: DRIFT between ${url} and contract/openapi.json`);
let shown = 0;
const max = Math.max(a.length, b.length);
for (let i = 0, j = 0; (i < a.length || j < b.length) && shown < 60;) {
  if (a[i] === b[j]) {
    i++;
    j++;
    continue;
  }
  const nextInB = b.indexOf(a[i], j);
  const nextInA = a.indexOf(b[j], i);
  if (nextInB !== -1 && (nextInA === -1 || nextInB - j <= nextInA - i)) {
    while (j < nextInB && shown < 60) {
      console.error(`+ ${b[j++]}`);
      shown++;
    }
  } else if (nextInA !== -1) {
    while (i < nextInA && shown < 60) {
      console.error(`- ${a[i++]}`);
      shown++;
    }
  } else {
    if (i < a.length) {
      console.error(`- ${a[i++]}`);
      shown++;
    }
    if (j < b.length) {
      console.error(`+ ${b[j++]}`);
      shown++;
    }
  }
}
if (shown >= 60) console.error(`… (${max} lines compared; diff truncated)`);
process.exit(1);
