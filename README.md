# browserCoin p2p test

A one-page proof of concept for the next browserCoin release: two browsers
connect directly with no browserCoin server in between. It is meant to be
posted in the browserCoin Discord so the community can try it on real home,
office and mobile networks before the release ships.

## What the page does

- **With a friend (no relay at all).** One person makes an invite code, the
  other pastes it and sends back a reply code. That is the whole handshake.
- **With everyone (Nostr test room).** Browsers find each other through public
  Nostr relays and form a small mesh. A chat floods across the mesh so people
  who are not directly linked still see each message.
- **Shows its own network activity.** Every outside host the page contacts is
  listed live, along with a counter of browserCoin servers contacted (it stays
  at 0).
- **Collects results.** A "copy report for Discord" button gives a short
  summary with no IP addresses, codes or names in it.

It runs on its own Nostr topic (`browsercoin-p2p-demo-v1`), so test traffic
never mixes with the real browserCoin network.

## Same code as the release

`src/signal/` is copied from browserCoin's `src/net/signal/` on the
`serverless-signaling` branch. The only changes are the imports, which point
at `src/signal/deps.ts` instead of the rest of the browserCoin tree, the
network name in that file, and punctuation in comments. If the release code
changes, copy it over again.

## Run it

```sh
npm install
npm run dev      # local dev server
npm run build    # writes dist/index.html, a single self-contained file
```

`dist/index.html` works from any static host and also straight from disk
(`file://`), which is part of what the demo shows.

## Deploy

Pushing to `main` builds and publishes to GitHub Pages through
`.github/workflows/pages.yml`. Enable Pages for the repo first
(Settings, Pages, Source: GitHub Actions).

Made by swompy.
