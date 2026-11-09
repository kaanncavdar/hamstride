import { encodeAbiParameters, getAddress, decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import artifact from '../contracts/artifacts/contracts/SprintEscrow.sol/SprintEscrow.json';
import testArtifact from '../contracts/artifacts/contracts/test/TestSQK.sol/TestSQK.json';
import cfg from './referee.json';
import { ensureSepolia, listWallets, type Eip1193, type WalletInfo } from '../src/client/wallet';
import { SQK_SEPOLIA, ERC20_ABI } from '../src/shared/escrow';

// Dev-only page (not part of the site build): deploys SprintEscrow from the owner's own wallet.
const $ = (id: string) => document.getElementById(id)!;
const log = (html: string, cls = '') => {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.innerHTML = html;
  $('log').append(p);
};
type Hex = `0x${string}`;
let provider: Eip1193 | null = null;
let owner: Hex | null = null;
$('token').textContent = SQK_SEPOLIA;
$('referee').textContent = cfg.referee;

/** Wallet errors are plain objects ({ code, message }), not Error instances. */
function errText(e: unknown): string {
  const x = e as { message?: string; code?: number; data?: { message?: string } };
  if (x?.code === 4001) return 'You cancelled it in the wallet.';
  const msg = x?.data?.message ?? x?.message;
  if (msg) return x?.code !== undefined ? `${msg} (code ${x.code})` : msg;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function call<T>(to: Hex, abi: Abi, functionName: string, args: unknown[] = []) {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const out = (await provider!.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as Hex;
  return decodeFunctionResult({ abi, functionName, data: out } as never) as T;
}

async function connect(w: WalletInfo) {
  try {
    provider = w.provider;
    log(`Using <b>${w.name}</b>. Approve the connection in it…`);
    const accs = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    owner = getAddress(accs[0]) as Hex;
    log('Switching to Sepolia (approve it in the wallet if asked)…');
    await ensureSepolia(provider);
    $('owner').textContent = owner;
    const name = await call<string>(SQK_SEPOLIA, ERC20_ABI as Abi, 'name');
    log(`Token check: <b>${name}</b> at ${SQK_SEPOLIA}`, name === 'Squeek' ? 'ok' : 'bad');
    const eth = BigInt((await provider.request({ method: 'eth_getBalance', params: [owner, 'latest'] })) as string);
    log(`Your Sepolia ETH: ${(Number(eth) / 1e18).toFixed(4)}`, eth > 0n ? 'ok' : 'bad');
    ($('deploy') as HTMLButtonElement).disabled = false;
    ($('test-deploy') as HTMLButtonElement).disabled = false;
    ($('drip') as HTMLButtonElement).disabled = false;
  } catch (e) {
    log(errText(e), 'bad');
  }
}

// Several wallet extensions can be installed: let the owner pick the one to deploy from.
$('connect').addEventListener('click', async () => {
  const wallets = await listWallets();
  if (!wallets.length) return log('No browser wallet found.', 'bad');
  if (wallets.length === 1) return connect(wallets[0]);
  const box = document.createElement('p');
  box.append('Pick the wallet to deploy from: ');
  for (const w of wallets) {
    const b = document.createElement('button');
    b.textContent = w.name;
    b.style.marginRight = '6px';
    b.addEventListener('click', () => {
      box.remove();
      connect(w);
    });
    box.append(b);
  }
  $('log').append(box);
});

$('deploy').addEventListener('click', async () => {
  if (!provider || !owner) return;
  ($('deploy') as HTMLButtonElement).disabled = true;
  try {
    const args = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      [SQK_SEPOLIA, getAddress(cfg.referee), owner],
    );
    const data = (artifact.bytecode + args.slice(2)) as Hex;
    log('Confirm the transaction in your wallet…');
    const hash = (await provider.request({ method: 'eth_sendTransaction', params: [{ from: owner, data }] })) as Hex;
    log(`Sent: <a href="https://sepolia.etherscan.io/tx/${hash}" target="_blank" rel="noopener">${hash}</a>. Waiting for it to be mined…`);
    let receipt = null as { status: Hex; contractAddress: Hex | null } | null;
    for (let i = 0; i < 150 && !receipt; i++) {
      receipt = (await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as typeof receipt;
      if (!receipt) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!receipt || receipt.status !== '0x1' || !receipt.contractAddress) throw new Error('The deployment did not go through.');
    const at = getAddress(receipt.contractAddress) as Hex;
    const abi = artifact.abi as Abi;
    const [tok, ref, own, fee] = await Promise.all([
      call<Hex>(at, abi, 'token'),
      call<Hex>(at, abi, 'referee'),
      call<Hex>(at, abi, 'owner'),
      call<bigint>(at, abi, 'FEE_BPS'),
    ]);
    const good = tok === SQK_SEPOLIA && ref === getAddress(cfg.referee) && own === owner && fee === 500n;
    log(`Contract: <b><code>${at}</code></b> (<a href="https://sepolia.etherscan.io/address/${at}" target="_blank" rel="noopener">Etherscan</a>)`, 'ok');
    log(good ? 'Checked on-chain: token, server address, owner and 5% fee are all correct. Send this address to Claude.' : 'Something does not match. Do not use this contract.', good ? 'ok' : 'bad');
  } catch (e) {
    log(errText(e), 'bad');
    ($('deploy') as HTMLButtonElement).disabled = false;
  }
});

// ---------- test mode ----------
const tlog = (html: string, cls = '') => {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.innerHTML = html;
  $('test-log').append(p);
};
const testInput = $('test-token') as HTMLInputElement;
const fromUrl = new URLSearchParams(location.search).get('token');
try {
  testInput.value = fromUrl ?? localStorage.getItem('hamstride.testToken') ?? '';
} catch {
  /* no storage */
}

/** Sends a transaction from the connected wallet and waits for it; returns the receipt. */
async function sendAndWait(tx: { to?: Hex; data: Hex }, what: string) {
  tlog(`${what}: confirm it in your wallet…`);
  const hash = (await provider!.request({ method: 'eth_sendTransaction', params: [{ from: owner, ...tx }] })) as Hex;
  tlog(`Sent: <a href="https://sepolia.etherscan.io/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 18)}…</a> Waiting…`);
  let receipt = null as { status: Hex; contractAddress: Hex | null } | null;
  for (let i = 0; i < 150 && !receipt; i++) {
    receipt = (await provider!.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as typeof receipt;
    if (!receipt) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!receipt || receipt.status !== '0x1') throw new Error(`${what} did not go through.`);
  return receipt;
}

$('test-deploy').addEventListener('click', async () => {
  if (!provider || !owner) return;
  const btn = $('test-deploy') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const t = await sendAndWait({ data: testArtifact.bytecode as Hex }, '1/2 Create the test token');
    const token = getAddress(t.contractAddress!) as Hex;
    const args = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [token, getAddress(cfg.referee), owner]);
    const e = await sendAndWait({ data: (artifact.bytecode + args.slice(2)) as Hex }, '2/2 Create the test escrow');
    const escrow = getAddress(e.contractAddress!) as Hex;
    const tok = await call<Hex>(escrow, artifact.abi as Abi, 'token');
    if (tok !== token) throw new Error('The test escrow does not point at the test token. Do not use it.');
    testInput.value = token;
    try {
      localStorage.setItem('hamstride.testToken', token);
    } catch {
      /* no storage */
    }
    tlog(`Test token: <code>${token}</code>`, 'ok');
    tlog(`Test escrow: <code>${escrow}</code>`, 'ok');
    tlog('Send both addresses to Claude. Then press B in each wallet you will race with.', 'ok');
    tlog(`For the other Chrome profile, open: <code>${location.origin}${location.pathname}?token=${token}</code>`);
  } catch (err) {
    tlog(errText(err), 'bad');
    btn.disabled = false;
  }
});

$('drip').addEventListener('click', async () => {
  if (!provider || !owner) return;
  const token = testInput.value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return tlog('Put the test token address in the box first.', 'bad');
  const btn = $('drip') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const name = await call<string>(getAddress(token) as Hex, ERC20_ABI as Abi, 'name').catch(() => '');
    if (name !== 'Hamstride Test SQK') throw new Error('That address is not the Hamstride test token.');
    await sendAndWait({ to: getAddress(token) as Hex, data: encodeFunctionData({ abi: testArtifact.abi as Abi, functionName: 'drip' }) }, 'Get 1000 test SQK');
    const bal = await call<bigint>(getAddress(token) as Hex, ERC20_ABI as Abi, 'balanceOf', [owner]);
    tlog(`This wallet now has <b>${Number(bal / 10n ** 18n)} test SQK</b>.`, 'ok');
  } catch (err) {
    tlog(errText(err), 'bad');
  } finally {
    btn.disabled = false;
  }
});
