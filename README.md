# Wheel Duel

A 1v1 hamster wheel race in the browser, built for [Squeekchain](https://squeekchain.com), the blockchain powered by a real hamster.

You alternate two keys to keep your hamster's wheel turning. You jump pencils, switch lanes around toilet rolls, grab golden seeds and dodge chilis. When the cat opens its eyes, you freeze. If you mash the keys, the wheel overheats. When Squeektoshi, the real hamster, is running, races become Night Races, and every block he completes mid-race drops onto both roads.

## Stack

- **Client:** Vite + TypeScript + Three.js. The 3D scene is rendered at low resolution and scaled up with nearest-neighbour filtering, which gives it a pixel look.
- **Server:** one Cloudflare Worker with three SQLite-backed Durable Objects (`Room`, `Lobby`, `Board`). It runs on the Workers free plan.
- **Shared engine:** `src/shared/` is a deterministic simulation that runs in both the browser and the Worker.

## How cheating is handled

The client code is public, so the design never relies on hiding it.

| Threat | Defence |
|---|---|
| Modified client fakes speed or a finish | The server replays every player's race from their raw key presses with the same engine (`worker/room.ts`). |
| Server or player picks a favourable course | Commit-reveal: the server publishes `sha256(serverSeed)` first, both players add a random seed, and the course is built from all three. After the race the client checks everything (`showOnlineResult`). |
| Reading the course ahead | Obstacles are sent only when they are 40 m ahead of the leader. |
| Autoclickers and scripts | Pressing faster than about 10 per second overheats the wheel, and pressing the same foot twice trips the hamster. The cat punishes pressing at the wrong time. Each player's press rhythm gets a signature (`src/shared/stats.ts`); runs that are too steady are not ranked. |
| Synthetic events in the page | Inputs with `isTrusted === false` and auto-repeat keydowns are ignored. A `navigator.webdriver` session is not ranked. |
| Mass scripted joins | Each socket needs an HMAC-signed join ticket plus a 14-bit proof of work (`worker/ticket.ts`). Each player can send at most 40 inputs per second. |
| AI crawlers | `robots.txt` disallows them, the Worker returns 403 to known AI and scripting user agents, and pages send `X-Robots-Tag: noai`. |

None of this makes cheating impossible. A determined bot that reads the screen can still play. The point is that it can't fake results, and it gets flagged when it plays too perfectly.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # then put a long random TICKET_SECRET in it
npm run build                    # the Worker serves ./dist
npx wrangler dev --port 8787     # game server + built site
npx vite --port 5173             # optional: hot reload, proxies /api and /ws to 8787
npm test
```

## Deploy (free plan)

```bash
npx wrangler login
npx wrangler secret put TICKET_SECRET
npm run deploy
```

After deploying:

1. Add your domain in Cloudflare and attach it to the Worker.
2. Set `ALLOWED_ORIGINS` (for example `https://yourdomain.com`) with `wrangler secret put ALLOWED_ORIGINS`.
3. Optionally turn on Cloudflare's *Block AI bots* setting.
4. To get the project onto the Squeekchain Genesis board, add the DNS record, the page tag (`index.html` marks where it goes) and the README line they give you, then press Verify.

## Roadmap

- **Phase 2:** an SQK stake escrow contract on Sepolia. Both players deposit, the server signs the result together with the input hash, the winner claims the pot, and there is a refund timeout.
- Wallet sign-in, and Squeek NFT skins read from `tokenURI`.
