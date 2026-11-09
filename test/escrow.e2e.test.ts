/**
 * End-to-end check of races for SQK against a real EVM (a local Hardhat node with Sepolia's chain
 * id): the Worker's own ticket/result signing (worker/stake.ts) and the browser's own deposit and
 * claim code (src/client/stake.ts, driven through a stand-in wallet) against the compiled
 * SprintEscrow contract. Run with:
 *   (cd contracts && npx hardhat node --chain-id 11155111 --port 8546)
 *   E2E_RPC=http://127.0.0.1:8546 npx vitest run test/escrow.e2e.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, getAddress, http, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import escrowArt from '../contracts/artifacts/contracts/SprintEscrow.sol/SprintEscrow.json';
import tokenArt from '../contracts/artifacts/contracts/test/Mocks.sol/MockSQK.json';
import { ONE_SQK, payout, STATUS } from '../src/shared/escrow';

const RPC = process.env.E2E_RPC;
const run = RPC ? describe : describe.skip;

run('races for SQK, end to end', () => {
  const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => pub.request({ method, params } as never) as Promise<unknown>;

  async function funded(): Promise<PrivateKeyAccount> {
    const a = privateKeyToAccount(generatePrivateKey());
    await rpc('hardhat_setBalance', [a.address, '0x56BC75E2D63100000']);
    return a;
  }

  async function deploy(from: PrivateKeyAccount, art: { abi: unknown; bytecode: string }, args: unknown[]) {
    const w = createWalletClient({ account: from, chain: sepolia, transport: http(RPC) });
    const hash = await w.deployContract({ abi: art.abi as Abi, bytecode: art.bytecode as Hex, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    return getAddress(r.contractAddress!);
  }

  /** A minimal browser wallet (EIP-1193) backed by a local key, so the real client code can run. */
  function wallet(a: PrivateKeyAccount) {
    const w = createWalletClient({ account: a, chain: sepolia, transport: http(RPC) });
    return {
      async request({ method, params }: { method: string; params?: unknown }) {
        const ps = (params ?? []) as unknown[];
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [a.address];
          case 'eth_chainId':
            return '0xaa36a7';
          case 'eth_signTypedData_v4': {
            const td = JSON.parse(ps[1] as string);
            delete td.types.EIP712Domain;
            return a.signTypedData(td);
          }
          case 'eth_sendTransaction': {
            const tx = ps[0] as { to: Hex; data: Hex };
            return w.sendTransaction({ to: tx.to, data: tx.data });
          }
          default:
            return rpc(method, ps);
        }
      },
    };
  }

  it('signs, deposits, races and pays out exactly as the contract expects', async () => {
    // The client module expects a browser window for wallet discovery.
    (globalThis as unknown as { window: EventTarget }).window ??= new EventTarget();
    const client = await import('../src/client/stake');
    const { makeTicket, readMatch, signResult, stakeConfig } = await import('../worker/stake');

    const owner = await funded();
    const alice = await funded();
    const bob = await funded();
    const refKey = generatePrivateKey();
    const sqk = await deploy(owner, tokenArt, []);
    const escrow = await deploy(owner, escrowArt, [sqk, privateKeyToAccount(refKey).address, owner.address]);
    const ow = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) });
    for (const p of [alice, bob]) {
      const h = await ow.writeContract({ address: sqk, abi: tokenArt.abi as Abi, functionName: 'mint', args: [p.address, 1000n * ONE_SQK] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const bal = (a: Hex) => pub.readContract({ address: sqk, abi: tokenArt.abi as Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

    const env = { ESCROW_ADDRESS: escrow, REFEREE_KEY: refKey, SQK_ADDRESS: sqk, SEPOLIA_RPC: RPC } as never;
    const cfg = stakeConfig(env)!;
    expect(cfg).not.toBeNull();

    // 1) A full race: Alice deposits with a permit, Bob with approve + deposit; Alice wins and claims.
    const { ticket, sig } = await makeTicket(env, cfg, alice.address, bob.address, 50);
    const msg = { ticket, sig, escrow: cfg.escrow, token: cfg.token };
    const steps: string[] = [];
    await client.depositStake(wallet(alice) as never, msg, (s) => steps.push(s));
    expect(steps.some((s) => /permit/i.test(s))).toBe(true);
    expect((await readMatch(env, cfg, ticket.matchId)).status).toBe(STATUS.Open);
    // Bob already approved exactly the stake, so his path is a plain deposit.
    const bw = createWalletClient({ account: bob, chain: sepolia, transport: http(RPC) });
    await pub.waitForTransactionReceipt({ hash: await bw.writeContract({ address: sqk, abi: tokenArt.abi as Abi, functionName: 'approve', args: [escrow, 50n * ONE_SQK] }) });
    await client.depositStake(wallet(bob) as never, msg, () => {});
    const m = await readMatch(env, cfg, ticket.matchId);
    expect(m.status).toBe(STATUS.Active);
    expect(m.paidA && m.paidB).toBe(true);

    const result = { matchId: ticket.matchId, outcome: 1 as const, replayHash: `0x${'ab'.repeat(32)}` as Hex };
    const rsig = await signResult(env, cfg, result);
    // A forged "Bob wins" with the real signature is refused by the contract.
    await expect(client.claim(wallet(bob) as never, escrow, { ...result, outcome: 2 }, rsig)).rejects.toThrow();
    await client.claim(wallet(bob) as never, escrow, result, rsig); // anyone may submit; Alice gets paid
    expect(await bal(alice.address)).toBe(1000n * ONE_SQK - 50n * ONE_SQK + payout(50n * ONE_SQK));
    expect(await bal(bob.address)).toBe(950n * ONE_SQK);
    expect(await bal(escrow)).toBe(5n * ONE_SQK); // the 5% fee
    expect((await readMatch(env, cfg, ticket.matchId)).status).toBe(STATUS.Settled);

    // 2) A draw gives both stakes back with no fee.
    const t3 = await makeTicket(env, cfg, alice.address, bob.address, 20);
    await pub.waitForTransactionReceipt({ hash: await bw.writeContract({ address: sqk, abi: tokenArt.abi as Abi, functionName: 'approve', args: [escrow, 20n * ONE_SQK] }) });
    await client.depositStake(wallet(alice) as never, { ...t3, escrow: cfg.escrow, token: cfg.token }, () => {});
    await client.depositStake(wallet(bob) as never, { ...t3, escrow: cfg.escrow, token: cfg.token }, () => {});
    const a0 = await bal(alice.address);
    const b0 = await bal(bob.address);
    const draw = { matchId: t3.ticket.matchId, outcome: 3 as const, replayHash: `0x${'cd'.repeat(32)}` as Hex };
    await client.claim(wallet(alice) as never, escrow, draw, await signResult(env, cfg, draw));
    expect(await bal(alice.address)).toBe(a0 + 20n * ONE_SQK);
    expect(await bal(bob.address)).toBe(b0 + 20n * ONE_SQK);
    // 3) The rival never pays: after the join window (last, because it moves the chain's clock), Alice takes her stake back.
    const t2 = await makeTicket(env, cfg, alice.address, bob.address, 10);
    await client.depositStake(wallet(alice) as never, { ...t2, escrow: cfg.escrow, token: cfg.token }, () => {});
    const before = await bal(alice.address);
    await rpc('evm_increaseTime', [200]);
    await rpc('evm_mine');
    await client.takeBack(wallet(alice) as never, escrow, t2.ticket.matchId);
    expect(await bal(alice.address)).toBe(before + 10n * ONE_SQK);

  }, 120_000);
});
