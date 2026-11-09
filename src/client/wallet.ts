import { createSiweMessage } from 'viem/siwe';
import { getAddress, toHex } from 'viem';

/**
 * Browser wallets (MetaMask, Rabby, Coinbase Wallet, OKX, Brave…) via EIP-6963 discovery.
 * We only ever ask the wallet for: your address, switching/adding Sepolia, and signing a plain
 * sign-in message. Nothing here can move funds.
 */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...a: unknown[]) => void): void;
  removeListener?(event: string, cb: (...a: unknown[]) => void): void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193;
}

export const SEPOLIA = {
  chainId: '0xaa36a7',
  chainName: 'Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
};

const found = new Map<string, WalletInfo>();
window.addEventListener('eip6963:announceProvider', (e: Event) => {
  const d = (e as CustomEvent).detail as { info: Omit<WalletInfo, 'provider'>; provider: Eip1193 };
  if (!d?.info?.uuid || !d.provider) return;
  // Only image data URIs for icons, so a wallet can't make the page load something remote.
  const icon = /^data:image\/(svg\+xml|png|webp|jpeg|gif);/i.test(d.info.icon) ? d.info.icon : '';
  found.set(d.info.uuid, { ...d.info, icon, provider: d.provider });
});

export async function listWallets(): Promise<WalletInfo[]> {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 250));
  const list = [...found.values()];
  const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!list.length && legacy) list.push({ uuid: 'legacy', name: 'Browser wallet', icon: '', rdns: 'legacy', provider: legacy });
  return list;
}

function errCode(e: unknown): number | undefined {
  const x = e as { code?: number; data?: { originalError?: { code?: number } } };
  return x?.code ?? x?.data?.originalError?.code;
}

/** Puts the wallet on Sepolia, adding the network first if the wallet doesn't know it. */
export async function ensureSepolia(p: Eip1193) {
  const id = String(await p.request({ method: 'eth_chainId' })).toLowerCase();
  if (id === SEPOLIA.chainId) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA.chainId }] });
  } catch (e) {
    if (errCode(e) !== 4902) throw e;
    await p.request({ method: 'wallet_addEthereumChain', params: [SEPOLIA] });
  }
  const after = String(await p.request({ method: 'eth_chainId' })).toLowerCase();
  if (after !== SEPOLIA.chainId) throw new Error('Please switch your wallet to the Sepolia test network.');
}

export interface Me {
  address: string | null;
  guests: boolean;
}

export async function me(): Promise<Me> {
  const r = await fetch('/api/auth/me', { cache: 'no-store' });
  if (!r.ok) return { address: null, guests: false };
  return r.json();
}

export async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' });
}

/** Connect → Sepolia → sign a plain-text sign-in message → server checks it and sets a session. */
export async function signIn(w: WalletInfo): Promise<string> {
  const p = w.provider;
  const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('The wallet did not share an account.');
  const address = getAddress(accounts[0]);
  await ensureSepolia(p);
  const nr = await fetch('/api/auth/nonce', { cache: 'no-store' });
  if (!nr.ok) throw new Error('Could not start sign-in.');
  const { nonce, chainId } = (await nr.json()) as { nonce: string; chainId: number };
  const now = new Date();
  const message = createSiweMessage({
    domain: location.host,
    address,
    statement: 'Sign in to Squeek Sprint. This only proves you own this wallet: no transaction, no gas, no approvals.',
    uri: location.origin,
    version: '1',
    chainId,
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
  });
  const signature = (await p.request({ method: 'personal_sign', params: [toHex(message), address] })) as string;
  const vr = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  if (!vr.ok) {
    const { error } = (await vr.json().catch(() => ({}))) as { error?: string };
    throw new Error(error === 'bad_signature' ? 'The signature did not check out.' : `Sign-in failed (${error ?? vr.status}).`);
  }
  return ((await vr.json()) as { address: string }).address;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
