# OpenScreen docs site

Docusaurus 3 site. Lives in `website/` inside the monorepo. Deployed to Cloudflare (a Worker serving static assets, `wrangler.jsonc`) via `.github/workflows/docs.yml`. `www-redirect/` is a separate Worker that sends www.getopenscreen.com to the apex; it is deployed by hand.

## Develop

```sh
cd website
npm install
npm run dev      # http://localhost:3000/
```

## Build

```sh
npm run build    # outputs to website/build/
npm run serve    # serves the built site locally
```

## Type-check

```sh
npm run typecheck
```

## Notes

- Site URL: <https://getopenscreen.com/>, served from the domain root (`baseUrl: "/"`).
