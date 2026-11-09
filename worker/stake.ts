import { createPublicClient, getAddress, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { Env } from './env';
import {
  eip712Domain, ESCROW_ABI, JOIN_WINDOW_S, ONE_SQK, RESULT_TYPES, TICKET_TYPES,
  type ResultJson, type TicketJson,
} from '../src/shared/escrow';

/**
 * The game server's side of staked races: it signs tickets and results with the referee key
 * (a Worker secret, never in the repo) and reads the escrow contract to see who has paid.
 * The key can only say who won; the contract never lets it move money anywhere else.
 */

export interface StakeConfig {
  escrow: `0x${string}`;
  token: `0x${string}`;
}

/** Staked races are on only when both the escrow address and the referee key are configured. */
export function stakeConfig(env: Env): StakeConfig | null {
  if (!env.ESCROW_ADDRESS || !isAddress(env.ESCROW_ADDRESS) || !env.REFEREE_KEY) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.REFEREE_KEY)) return null;
  return { escrow: getAddress(env.ESCROW_ADDRESS), token: getAddress(env.SQK_ADDRESS || '0xd78a3956cF63164d1Fa1C622ad3c66623162Fa1e') };
}

const referee = (env: Env) => privateKeyToAccount(env.REFEREE_KEY as `0x${string}`);

function client(env: Env) {
  return createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com') });
}

function randomBytes32(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** A fresh ticket for two signed-in wallets, signed by the referee. */
export async function makeTicket(env: Env, cfg: StakeConfig, a: string, b: string, stakeSqk: number) {
  const ticket: TicketJson = {
    matchId: randomBytes32(),
    playerA: getAddress(a),
    playerB: getAddress(b),
    stake: (BigInt(stakeSqk) * ONE_SQK).toString(),
    joinDeadline: Math.floor(Date.now() / 1000) + JOIN_WINDOW_S,
  };
  const sig = await referee(env).signTypedData({
    domain: eip712Domain(cfg.escrow),
    types: TICKET_TYPES,
    primaryType: 'Ticket',
    message: { ...ticket, stake: BigInt(ticket.stake), joinDeadline: BigInt(ticket.joinDeadline) },
  });
  return { ticket, sig };
}

/** The signed race result the winner (or either player, for a draw) submits to the contract. */
export async function signResult(env: Env, cfg: StakeConfig, res: ResultJson) {
  return referee(env).signTypedData({
    domain: eip712Domain(cfg.escrow),
    types: RESULT_TYPES,
    primaryType: 'Result',
    message: res,
  });
}

export interface OnChainMatch {
  paidA: boolean;
  paidB: boolean;
  status: number;
}

export async function readMatch(env: Env, cfg: StakeConfig, matchId: `0x${string}`): Promise<OnChainMatch> {
  const m = await client(env).readContract({ address: cfg.escrow, abi: ESCROW_ABI, functionName: 'getMatch', args: [matchId] });
  return { paidA: m.paidA, paidB: m.paidB, status: m.status };
}
