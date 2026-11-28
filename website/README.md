# R-Shell website

The English and Simplified Chinese site is built with Astro, Starlight and Pagefind. Product screenshots come from the repository's `screenshots/` directory. Update both translations under `src/content/docs/` when changing the handbook.

Use Node 24 and pnpm 9.15.4. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

Local and pull request builds use a test release catalog. Production reads the verified catalog named by `RSHELL_SITE_CATALOG`. `origin.txt` identifies the Pages website. `mirror-origin.txt` sets the origin for installer links, mirrored updater manifests, and desktop update fallback. The production mirror uses the Pages custom domain `r-shell.hzbwx.cn`. An AliDNS CNAME points it to `r-shell.pages.dev`, where the release and update routes read the `r-shell-releases` R2 bucket. Both files contain an origin without a trailing slash.

## Deployment

The **Website and release mirror** workflow deploys from `main` to the directly uploaded Pages project configured in `wrangler.json`. Its `cloudflare-production` GitHub Environment accepts deployments from `main` only. Configure the account ID as the environment variable `CLOUDFLARE_ACCOUNT_ID`, and set these environment secrets:

| Secret | Access |
| --- | --- |
| `CLOUDFLARE_PAGES_TOKEN` | Pages Write for the Cloudflare account |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S3 Object Read & Write for the `r-shell-releases` bucket only |

The site uses static assets for pages and search. Download links point directly to the mirror origin. Existing Pages URLs under `/releases/*` and `/updates/*` continue to serve bucket objects. Protected credentials are never used by the PR verification job.

After a successful desktop release the workflow verifies GitHub asset digests and detached signatures, reads uploaded objects back, and publishes the channel manifest last. To retry without rebuilding the desktop app, run the workflow manually from `main`, optionally specifying a retained tag. The latest and previous release of each channel stay in R2. The cleanup step runs after smoke tests of the production hostname and only deletes objects listed in this publisher's receipts. Older releases remain on GitHub.
