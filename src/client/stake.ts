import { decodeFunctionResult, encodeFunctionData, getAddress, parseSignature, type Abi } from 'viem';
import { CHAIN_ID, ERC20_ABI, ESCROW_ABI, type ResultJson, type TicketJson } from '../shared/escrow';
import { ensureSepolia, type Eip1193 } from './wallet';

/**
 * Races for SQK, from the player's wallet. Everything that moves tokens is a transaction the
 * player confirms in their own wallet:
 *  - deposit: put your stake into the escrow (one permit signature + one transaction, or an
 *    approve for exactly the stake + a deposit if the wallet can't sign permits),
 *  - claim: submit the server's signed result; the contract pays the winner (or both, on a draw),
 *  - take back: if the rival never paid, or no result ever came, get your own stake back.
 * The page never asks for unlimited approvals and never sees a private key.
 */

type Hex = `0x${string}`;

async function call<T>(p: Eip1193, to: Hex, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const out = (await p.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as Hex;
  return decodeFunctionResult({ abi, functionName, data: out } as never) as T;
}

async function waitReceipt(p: Eip1193, hash: Hex) {
  for (let i = 0; i < 120; i++) {
    const r = (await p.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status: Hex } | null;
    if (r) {
      if (r.status !== '0x1') throw new Error('The transaction failed on-chain.');
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('The transaction is taking too long. Check it in your wallet.');
}

async function send(p: Eip1193, from: Hex, to: Hex, abi: Abi, functionName: string, args: unknown[]): Promise<Hex> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const hash = (await p.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] })) as Hex;
  await waitReceipt(p, hash);
  return hash;
}

function friendly(e: unknown): Error {
  const x = e as { code?: number; message?: string };
  if (x?.code === 4001) return new Error('You cancelled it in your wallet.');
  const m = String(x?.message ?? e);
  if (/insufficient funds/i.test(m)) return new Error('You need a little Sepolia ETH for the network fee.');
  return new Error(m.length > 160 ? `${m.slice(0, 160)}…` : m);
}

async function account(p: Eip1193): Promise<Hex> {
  const accs = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accs?.length) throw new Error('The wallet did not share an account.');
  return getAddress(accs[0]) as Hex;
}

export interface Balances {
  sqk: bigint;
  eth: bigint;
}

export async function balances(p: Eip1193, token: Hex): Promise<Balances> {
  const me = await account(p);
  const sqk = await call<bigint>(p, token, ERC20_ABI as Abi, 'balanceOf', [me]);
  const eth = BigInt((await p.request({ method: 'eth_getBalance', params: [me, 'latest'] })) as string);
  return { sqk, eth };
}

const ticketArg = (t: TicketJson) => ({ ...t, stake: BigInt(t.stake), joinDeadline: BigInt(t.joinDeadline) });

/** Put your stake in. Calls `step` with a short status line as it goes. */
export async function depositStake(
  p: Eip1193,
  m: { ticket: TicketJson; sig: Hex; escrow: Hex; token: Hex },
  step: (s: string) => void,
): Promise<Hex> {
  try {
    await ensureSepolia(p);
    const me = await account(p);
    if (me.toLowerCase() !== m.ticket.playerA.toLowerCase() && me.toLowerCase() !== m.ticket.playerB.toLowerCase()) {
      throw new Error('Switch your wallet to the account you signed in with.');
    }
    const stake = BigInt(m.ticket.stake);
    const { sqk, eth } = await balances(p, m.token);
    if (sqk < stake) throw new Error(`You need ${Number(stake / 10n ** 18n)} SQK in this wallet.`);
    if (eth === 0n) throw new Error('You need a little Sepolia ETH for the network fee.');

    const allowance = await call<bigint>(p, m.token, ERC20_ABI as Abi, 'allowance', [me, m.escrow]);
    if (allowance >= stake) {
      step('Confirm the deposit in your wallet…');
      return await send(p, me, m.escrow, ESCROW_ABI as Abi, 'deposit', [ticketArg(m.ticket), m.sig]);
    }

    // One signature lets the contract take exactly the stake, then one transaction.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    let permit: { v: number; r: Hex; s: Hex } | null = null;
    try {
      step('Sign the permit in your wallet (no fee)…');
      const nonce = await call<bigint>(p, m.token, ERC20_ABI as Abi, 'nonces', [me]);
      const name = await call<string>(p, m.token, ERC20_ABI as Abi, 'name');
      const typed = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        domain: { name, version: '1', chainId: CHAIN_ID, verifyingContract: m.token },
        message: { owner: me, spender: m.escrow, value: stake.toString(), nonce: nonce.toString(), deadline: deadline.toString() },
      };
      const raw = (await p.request({ method: 'eth_signTypedData_v4', params: [me, JSON.stringify(typed)] })) as Hex;
      const sig = parseSignature(raw);
      permit = { v: Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))), r: sig.r, s: sig.s };
    } catch (e) {
      if ((e as { code?: number })?.code === 4001) throw e;
      permit = null; // wallet can't sign permits: fall back to approve
    }
    if (permit) {
      step('Confirm the deposit in your wallet…');
      return await send(p, me, m.escrow, ESCROW_ABI as Abi, 'depositWithPermit', [ticketArg(m.ticket), m.sig, deadline, permit.v, permit.r, permit.s]);
    }
    step('Approve exactly the stake in your wallet…');
    await send(p, me, m.token, ERC20_ABI as Abi, 'approve', [m.escrow, stake]);
    step('Confirm the deposit in your wallet…');
    return await send(p, me, m.escrow, ESCROW_ABI as Abi, 'deposit', [ticketArg(m.ticket), m.sig]);
  } catch (e) {
    throw friendly(e);
  }
}

/** Submit the signed result: the contract pays the winner, or both players on a draw. */
export async function claim(p: Eip1193, escrow: Hex, result: ResultJson, sig: Hex): Promise<Hex> {
  try {
    await ensureSepolia(p);
    const me = await account(p);
    return await send(p, me, escrow, ESCROW_ABI as Abi, 'settle', [result, sig]);
  } catch (e) {
    throw friendly(e);
  }
}

/** The rival never paid: after the join deadline, take your stake back. */
export async function takeBack(p: Eip1193, escrow: Hex, matchId: Hex): Promise<Hex> {
  try {
    await ensureSepolia(p);
    const me = await account(p);
    return await send(p, me, escrow, ESCROW_ABI as Abi, 'cancel', [matchId]);
  } catch (e) {
    throw friendly(e);
  }
}

/** No result within the contract's window: refund both stakes. */
export async function refundBoth(p: Eip1193, escrow: Hex, matchId: Hex): Promise<Hex> {
  try {
    await ensureSepolia(p);
    const me = await account(p);
    return await send(p, me, escrow, ESCROW_ABI as Abi, 'refund', [matchId]);
  } catch (e) {
    throw friendly(e);
  }
}

export interface ChainMatch {
  paidA: boolean;
  paidB: boolean;
  status: number;
  joinDeadline: bigint;
  settleDeadline: bigint;
}

export async function readMatch(p: Eip1193, escrow: Hex, matchId: Hex): Promise<ChainMatch> {
  return call<ChainMatch>(p, escrow, ESCROW_ABI as Abi, 'getMatch', [matchId]);
}

export const txLink = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
