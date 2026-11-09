# Squeek Sprint

A 1v1 hamster runner in the browser, built for [Squeekchain](https://squeekchain.com), the blockchain powered by a real hamster. It is an independent community project, not made by the Squeekchain team.

Each hamster runs inside a giant hamster wheel (modelled on Squeektoshi's WHEELY9000), seen at about 45°; both wheels carry the same 3-lane track. Use **← →** to change lanes, **↑** to jump cork logs and **↓** to slide under wooden bridges; on a phone, swipe. Hideouts and rolling chew balls are too tall: go round them. You have three ⚡ energy bolts and every bump costs one; with none left the hamster sits down to rest. A **mini wheel** makes you faster and takes one bump for you; a **hamster ball** rolls over logs and under bridges and takes one bump. Snacks (seeds, broccoli, courgette, mealworms) slowly win a bolt back. Speed grows from 8 m/s towards an 18 m/s ceiling. Every 420 m the picture switches between day and an infrared night camera. The last hamster still running wins; if both last 3 minutes, more energy left wins, then distance.

### Second version (being tested)

`npm run dev:wide` (port 5174) runs another take on the same game: one six-lane wheel split down the middle, seen from behind, three lanes per player. Its speed never levels off and after 90 seconds the hamsters start tiring on their own, so somebody always runs out of energy. It is practice-only for now; online races use the version above.

## Stack

- **Client:** Vite + TypeScript + Three.js. Each half renders into its own multisampled target and goes through a post pass (tone mapping, or the infrared camera look with grain and scanlines). The hamster has shell-layer fur; all textures are painted on canvases at start-up, and the site's card icons are rendered from the same 3D models.
- **Server:** one Cloudflare Worker with three SQLite-backed Durable Objects (`Room`, `Lobby`, `Board`). It runs on the Workers free plan.
- **Shared engine:** `src/shared/` is a deterministic simulation that runs in both the browser and the Worker.

## How cheating is handled

The client code is public, so the design never relies on hiding it.

| Threat | Defence |
|---|---|
| Modified client fakes speed or a finish | The server replays every player's race from their raw key presses with the same engine (`worker/room.ts`). |
| Server or player picks a favourable course | Commit-reveal: the server publishes `sha256(serverSeed)` first, both players add a random seed, and the course is built from all three. After the race the client checks everything (`showOnlineResult`). |
| Reading the course ahead | Obstacles are sent only when they are 70 m ahead of the leader. |
| Scripted players | The server times each reaction, from an obstacle coming into view in your lane to your dodge (`src/shared/stats.ts`). Runs whose reactions are faster than a human's (under 140 ms on average) or too consistent are not ranked. |
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
npm run dev:wide                 # optional: the six-lane version on port 5174
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
