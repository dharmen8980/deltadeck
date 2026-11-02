# DeltaDeck site

The showcase and install guide for DeltaDeck. A small Next.js app, exported as
static files. It is separate from the app in `web/`, with its own packages.

## Run

```sh
cd site
npm install
npm run dev        # http://127.0.0.1:3001/
```

## Build

```sh
npm run build      # static files in site/out
npx tsc --noEmit
npm run lint
```

`site/out` works on any static host.

## Deploy on Vercel

1. Import the repository in Vercel.
2. Set **Root Directory** to `site`.
3. Framework preset: **Next.js**. Keep the default build command.
4. No environment variables are needed.

Live at https://deltadeck.dev, which is also the base for the Open Graph links.
On another host, set `NEXT_PUBLIC_SITE_URL` at build time.

## Layout

- `src/app/page.tsx`: the page, section by section.
- `src/components/mock-app.tsx`: the hand-made picture of the app.
- `src/components/install-tabs.tsx`: the install guide.
- `src/components/ui/`: button, badge and tabs, copied from `web/`.
- `src/app/globals.css`: the theme tokens and change colors from `web/`. Dark
  mode follows the system setting.
- `public/og.png`: the Open Graph image.
