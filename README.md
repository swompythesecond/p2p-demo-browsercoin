# browserCoin p2p test

A one-page proof of concept for the next browserCoin release: two browsers
connect directly with no browserCoin server in between. It is meant to be
posted in the browserCoin Discord so the community can try it on real home,
office and mobile networks before the release ships.

## What the page does

- **Your code is ready on load**, as a QR code and a link. The invite QR is a
  link, so a friend who scans it with a phone camera lands on this page with
  the code filled in and gets their reply straight away.
- **Add your friend's code** by pasting the code or link, uploading a
  screenshot of their QR, dropping an image, or pasting one with Ctrl+V.
- **Connected**, the two browsers chat directly. Chat hops across links, so
  friends of friends see it too.
- **Shows its own network activity** (folded away at the bottom), plus a
  "servers used" counter that stays at 0.
- **Test report for Discord** with no IP addresses, codes or names in it.

## Same code as the release

The files in `src/signal/` are copied from browserCoin's `src/net/signal/` on
the `serverless-signaling` branch, minus the Nostr transport this demo does
not use. The only changes are the imports, which point at
`src/signal/deps.ts` instead of the rest of the browserCoin tree, and
punctuation in comments. If the release code changes, copy it over again.

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
