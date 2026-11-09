export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  BOARD: DurableObjectNamespace;
  /** HMAC key for join tickets. Set with `wrangler secret put TICKET_SECRET` (dev: .dev.vars). */
  TICKET_SECRET?: string;
  /** Proof-of-work difficulty for a join ticket, in leading zero bits. */
  TICKET_BITS?: string;
  /** Comma-separated origins allowed to open game sockets. Empty = same origin only. */
  ALLOWED_ORIGINS?: string;
  /** Rhythm steadiness below which a run is treated as scripted (kept out of the repo on purpose). */
  BOT_CV_MIN?: string;
  /** Sepolia JSON-RPC used to verify smart-contract wallet signatures. */
  SEPOLIA_RPC?: string;
  /** Dev only: lets browsers without a wallet play online as guests. Never set in production. */
  ALLOW_GUESTS?: string;
}
