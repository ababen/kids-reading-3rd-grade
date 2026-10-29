# Story Spark

A small reading practice app for elementary readers. Six original passages pair fantasy, mysteries, and nature nonfiction with four comprehension questions each. Designed as an initial prototype, not a validated reading assessment.

## Run

Serve this folder with any static server, for example `python3 -m http.server 8000`, then open http://localhost:8000. This runs the local-only experience. For the API and cloud saving, use Node.js 24 and `npm run dev` (http://localhost:8000). No npm dependencies are required. Copy `.env.example` to `.env.local` and add your Upstash credentials to enable the local API.

## Experience

Two independent reader profiles can be named in Grown-up corner. Children choose a story, read it, answer four questions, and choose a creative ending or drawing prompt. Incorrect answers and optional hints highlight the supporting paragraph. The text stays available throughout the questions. Completion awards one unique badge per story, without timers or sibling rankings.

The parent view separates first-try answers without hints from assisted answers, groups results by comprehension skill, shows recent completions, and exports JSON. Repeat story attempts are included and clearly disclosed. Names and progress are saved locally first. Families can enable cloud saving in Grown-up corner to back up existing progress and sync across devices. No child accounts, analytics, or generated chat are used. When cloud saving is enabled, profile names and completed reading results are sent to the app’s API and stored in a private Upstash Redis database. Google Fonts is optional and falls back to system fonts.

## Content and limitations

Edit `stories.js` to add passages and questions. Question tuples contain skill, prompt, three choices, correct choice index, supporting paragraph index, and explanation. Reading levels are not calibrated. There is no automatic difficulty adaptation, speech scoring, or learning diagnosis. The parent view is navigation, not password-protected access. Closing or leaving an unfinished adventure discards its answers; completed adventures persist.

## Validation

`npm test` checks syntax, story content, API authorization and validation, database failures, and sync retries. `npm run build` produces the static assets in `public/`. The API is deployed separately by Vercel from `api/progress.js`. `python test/browser.py` runs browser QA against a simulated API (requires Python Playwright and Chromium at `/usr/bin/chromium`); it covers completion, second-device restore, offline retry, and reset. A live Upstash smoke test is still required after provisioning.


## Deploy on Vercel

1. Import this GitHub repository into Vercel. Use Framework Preset **Other**, Node.js **24.x**, and the repository root. `vercel.json` sets the build command and output folder.
2. In the Vercel project’s Storage/Marketplace section, add **Upstash Redis** and connect it to the project. Pick a nearby database region. Use a durable Redis database, not a cache configured to evict data.
3. Verify server-side environment variables `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are present. If the integration uses other variable names, map them to these names. Never put database credentials in frontend files or commit `.env.local`. Use separate databases for Preview and Production so test deployments cannot alter production results.
4. Deploy or redeploy after connecting storage. In Grown-up corner, choose **Enable cloud saving**. The status must say **Saved to cloud** before relying on the backup.
5. Use **Show family key** and store the key privately. On another device, open the same deployment, choose **Connect this device to an existing family**, and enter the key. Connecting replaces that device’s local profiles; it does not merge two different families.

This implementation targets **Vercel**. Cloudflare Pages can host the static files, but its backend needs a Pages Function/Worker adapter; the Node.js Vercel handler is not a Cloudflare deployment.

## Backend behavior

- `GET /api/progress` loads both family profiles and their completed attempts.
- `POST /api/progress` accepts up to 50 `name`, `result`, or `reset` operations. Results include the reader slot, story ID, attempt UUID, completion time, and four answers (skill, first unassisted success, attempts, help).
- Both routes require `Authorization: Bearer <64-character family key>`. The server hashes the key for the database namespace. Each generated key has 256 bits of randomness. The database token stays server-side; family keys never appear in URLs or application logs. Responses are not cached.
- Results are stored per attempt, not as an overwrite of the whole family. Atomic Redis updates deduplicate retries and preserve results uploaded by other devices. Reset removes the displayed attempt IDs and leaves deletion markers, so an offline device cannot re-upload those deleted attempts. Concurrent new attempts that were not displayed during reset are retained.
- New results and changes are queued in localStorage until acknowledged. Sync runs after changes, when the connection returns, on focus, every 30 seconds while the page is open, and via **Sync now**. Browser closing before an acknowledgment is safe if localStorage works; reopen the page to retry. It is not an offline-installable PWA, and an unfinished adventure is still not saved.
- Existing browser-only results receive stable attempt IDs before import. Cloud saving is opt-in. Do not clear browser data while uploads are pending. If storage is blocked, the app warns that progress cannot be saved locally.
- Use one active tab per browser for editing this prototype; cross-device uploads are safe, but simultaneous tabs share a browser outbox. Reader name edits use the last server-processed change.
- A family key grants access to both readers and allows changes and resets. This is lightweight family access, not separate adult/child authorization. There is no email recovery or key rotation UI. Keep a copy of the key and use the progress download for your own exports.
- Requests have a 64 KiB application limit, content validation, an 8-second database timeout, and a 120-request/minute limit per family. This is a small private-family prototype; configure Vercel Firewall limits before a broad public launch. Scores are submitted practice data, not tamper-proof assessments.

No live database is created by this repository. Redis persistence/backup policies and billing are managed in the selected Upstash plan. Reset removes reading records but retains their random deletion markers; full family deletion can be done by deleting that family’s hashed Redis key as a database administrator.
