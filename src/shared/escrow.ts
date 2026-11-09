/**
 * Everything the game server and the browser need to talk to the SprintEscrow contract
 * (contracts/contracts/SprintEscrow.sol): its ABI, the EIP-712 types the server signs, and the
 * stake tables. Kept in one place so both sides always agree.
 */

export const CHAIN_ID = 11155111; // Sepolia
/** The real $SQK token on Sepolia (docs.squeekchain.com/developers). */
export const SQK_SEPOLIA = '0xd78a3956cF63164d1Fa1C622ad3c66623162Fa1e' as const;
/** House fee on a win, fixed in the contract: 5% of the pot. */
export const FEE_BPS = 500;
/** Quick-match tables, in whole SQK per player. Private rooms can use any amount in range. */
export const TIERS = [10, 50, 250, 1000] as const;
export const MIN_STAKE = 1;
export const MAX_STAKE = 100_000;
/** How long both players have to put their stake in once a staked match is set up. */
export const JOIN_WINDOW_S = 120;

export const ONE_SQK = 10n ** 18n;

export const isStakeAmount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= MIN_STAKE && n <= MAX_STAKE;

/** What the winner receives from a pot of two stakes, after the 5% fee (rounded down like the contract). */
export function payout(stakeWei: bigint): bigint {
  const pot = stakeWei * 2n;
  return pot - (pot * BigInt(FEE_BPS)) / 10_000n;
}

export const eip712Domain = (verifyingContract: `0x${string}`) => ({
  name: 'SqueekSprintEscrow',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract,
});

export const TICKET_TYPES = {
  Ticket: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'playerA', type: 'address' },
    { name: 'playerB', type: 'address' },
    { name: 'stake', type: 'uint256' },
    { name: 'joinDeadline', type: 'uint64' },
  ],
} as const;

export const RESULT_TYPES = {
  Result: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'replayHash', type: 'bytes32' },
  ],
} as const;

/** A ticket as it travels in JSON (bigints as decimal strings). */
export interface TicketJson {
  matchId: `0x${string}`;
  playerA: `0x${string}`;
  playerB: `0x${string}`;
  stake: string;
  joinDeadline: number;
}

export interface ResultJson {
  matchId: `0x${string}`;
  /** 1 = player A wins, 2 = player B wins, 3 = draw. */
  outcome: 1 | 2 | 3;
  replayHash: `0x${string}`;
}

/** Status values of SprintEscrow.Status. */
export const STATUS = { None: 0, Open: 1, Active: 2, Settled: 3, Refunded: 4 } as const;

const ticketTuple = {
  type: 'tuple',
  components: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'playerA', type: 'address' },
    { name: 'playerB', type: 'address' },
    { name: 'stake', type: 'uint256' },
    { name: 'joinDeadline', type: 'uint64' },
  ],
} as const;

const resultTuple = {
  type: 'tuple',
  components: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'replayHash', type: 'bytes32' },
  ],
} as const;

export const ESCROW_ABI = [
  {
    type: 'function',
    name: 'getMatch',
    stateMutability: 'view',
    inputs: [{ name: 'matchId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'playerA', type: 'address' },
          { name: 'playerB', type: 'address' },
          { name: 'stake', type: 'uint96' },
          { name: 'joinDeadline', type: 'uint64' },
          { name: 'settleDeadline', type: 'uint64' },
          { name: 'paidA', type: 'bool' },
          { name: 'paidB', type: 'bool' },
          { name: 'status', type: 'uint8' },
        ],
      },
    ],
  },
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'referee', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 't', ...ticketTuple }, { name: 'refereeSig', type: 'bytes' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'depositWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 't', ...ticketTuple },
      { name: 'refereeSig', type: 'bytes' },
      { name: 'permitDeadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'res', ...resultTuple }, { name: 'refereeSig', type: 'bytes' }],
    outputs: [],
  },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [{ name: 'matchId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'refund', stateMutability: 'nonpayable', inputs: [{ name: 'matchId', type: 'bytes32' }], outputs: [] },
] as const;

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;
