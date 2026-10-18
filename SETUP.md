# Setting up the community database (Cloudflare)

You need a free Cloudflare account. There are two ways to deploy; pick one. The Cloudflare dashboard changes its layout from time to time, so menu names may differ slightly.

## Option A: in the dashboard (no tools to install)

1. **Create the database.** Go to *Storage & databases* → *D1 SQL database* → *Create database*. Name it `discshelf`.
2. **Create the table.** Open the new database, go to its *Console* tab, paste the whole contents of `schema.sql`, and run it.
3. **Create the Worker.** Go to *Compute* → *Workers & Pages* → *Create* → start from the "Hello World" template. Name it `discshelf-api` and deploy it. Then press *Edit code*, replace everything with the contents of `worker.js`, and deploy again.
4. **Connect the database to the Worker.** Open the Worker → *Settings* → *Bindings* → *Add* → *D1 database*. Set the variable name to exactly `DB`, choose `discshelf`, and save/deploy.
5. **Copy the Worker's address.** It looks like `https://discshelf-api.<your-subdomain>.workers.dev`. Opening it in a browser should show the text "DiscShelf community API".
6. **Point the app at it.** In `app.js`, set `COMMUNITY_API` near the top to that address (no trailing slash), commit, and push to GitHub. Pages redeploys in a minute or two.

## Option B: with the command line

```
cd worker
npx wrangler login
npx wrangler d1 create discshelf        # prints a database_id
# paste that id into wrangler.toml
npx wrangler d1 execute discshelf --remote --file=schema.sql
npx wrangler deploy                      # prints the Worker address
```
Then do step 6 above.

## Recommended: add a rate limit

Anyone can call a public API, so add one rule to slow down abuse. In the dashboard open *Security* → *WAF* → *Rate limiting rules* and create a rule that matches requests to your Worker's hostname with URI path `/submit` and limits, say, 30 requests per minute per IP address (the free plan allows at least one rule). The Worker already rejects oversized or malformed submissions.

## Cleaning up bad entries

Open the database in the dashboard, go to *Console*, and run for example:

```sql
-- look at what is stored for a barcode
SELECT * FROM releases WHERE barcode = '5039036012345';

-- remove a bad answer
DELETE FROM releases WHERE barcode = '5039036012345' AND title_key = 'wrong title';
```

## If you move the website

The Worker only accepts browser requests from the origins listed in `ALLOWED_ORIGINS` at the top of `worker.js` (currently `https://stradios.github.io`). Add your new address there and redeploy.

## What is stored

Only barcode, title, format, year, TMDB id and TMDB poster URL, plus a vote count and timestamps. The Worker never stores IP addresses, accounts, or the notes/edition text people type in their own libraries.
