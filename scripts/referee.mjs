// Makes the game server's signing key for races for SQK, if there isn't one yet, and prints only
// its public address. The key goes into .dev.vars (git-ignored) and is never printed.
// Production: npx wrangler secret put REFEREE_KEY  (paste the value from .dev.vars, or a new one).
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const file = new URL('../.dev.vars', import.meta.url);
const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
let key = /^REFEREE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(text)?.[1];
if (!key) {
  key = generatePrivateKey();
  appendFileSync(file, `${text.endsWith('\n') || !text ? '' : '\n'}REFEREE_KEY=${key}\n`);
}
const address = privateKeyToAccount(key).address;
writeFileSync(new URL('../tools/referee.json', import.meta.url), JSON.stringify({ referee: address }, null, 2) + '\n');
console.log(`Referee address: ${address}`);
