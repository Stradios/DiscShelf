# DiscShelf

A tiny, server-less web app for tracking the DVDs, Blu-rays and other discs you own. Scan the barcode in a shop and it tells you whether you already have it.

- No accounts. Your library is stored on your own device (browser storage). An optional community database (a small Cloudflare Worker, see `worker/SETUP.md`) can fill in titles for barcodes other people have already added.
- Export your library as a `.json` file to back it up, move it to another phone, or share it. Import merges it in.
- Works offline after the first visit (checking your own library needs no connection).
- Installable to the home screen.

## Put it on GitHub Pages

1. Create a new GitHub repository (public).
2. Upload all files from this folder to the root of the repo: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `icon.svg`.
3. In the repo go to **Settings → Pages**. Under "Build and deployment" choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

Open that address on your phone. Camera access requires HTTPS, which GitHub Pages provides.

## First-time setup in the app

1. Open **Settings** and paste a free TMDB API key (themoviedb.org → Settings → API → "API Key (v3 auth)"). This enables title search, posters and years.
2. Optional: use your browser's "Add to Home Screen" so it opens like an app.

## How it works

- **Scan / Add** reads the barcode from the camera (the built-in `BarcodeDetector` where available, otherwise the ZXing library loaded from a CDN).
- If the barcode is already saved in your library: "You own this".
- If not, it tries a free UPC lookup (UPCitemdb) to get a title, then compares the title to your library. A match gives a warning such as "you own this title, maybe a different format or edition".
- If the barcode is unknown, search the title on TMDB and add it. The barcode is saved with the entry, so the next scan is recognised instantly.

## Community database (optional)

The `worker/` folder holds a tiny API (Cloudflare Worker + D1 database) that lets people pool barcode information. Follow `worker/SETUP.md`, then put the Worker's address into `COMMUNITY_API` at the top of `app.js`.

- On scan, the app asks the community database first, then the free UPC lookup, then you search by hand.
- Sharing is opt-in (Settings → Community database). Only barcode, title, format, year and TMDB id are sent. Never your library, notes or the edition field.
- Repeating an existing answer adds a vote and never overwrites it. If people disagree about a barcode, the answer with the most votes is the one shown.

## Things to know

- Different editions and regions of the same film have different barcodes, so matching by title is a hint, not proof. The app words these cases as warnings.
- The free UPC lookup is rate-limited and doesn't know every disc. Manual title entry is always available.
- Your TMDB key is stored only in your own browser, never in the repo.
- Clearing site data in the browser deletes your library. Export a backup now and then.
- The first scan on a device needs a connection if it uses the ZXing fallback; the UPC and TMDB lookups also need one.
