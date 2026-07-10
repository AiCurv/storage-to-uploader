# storage-to-uploader

Anonymous uploads to [storage.to](https://storage.to) from GitHub Actions.

## What this does

Triggers a GitHub Actions workflow that downloads a file (from a URL or a path in the repo) and pushes it to [storage.to](https://storage.to) via the public REST API (`/upload/init` → R2 presigned `PUT` → `/upload/confirm`). No account needed on storage.to.

The workflow prints the resulting `https://storage.to/...` URL as a step notice and exposes it as `steps.upload.outputs.url`.

## How to use it

1. (Recommended, one-time) Set a `STORAGE_TO_VISITOR_TOKEN` secret in the repo
   (**Settings → Secrets and variables → Actions → New repository secret**).
   Any random 32+ char string — reusing it across runs keeps "ownership" of your
   uploads in storage.to so you can later delete or modify them with the
   `/file/:id` endpoints. If you don't set it, a per-run random token is used
   and the URL will still work — you just can't manage the file later.

2. Open the **Actions** tab → select **Upload to storage.to** → **Run workflow**.

3. Fill in:
   - `source`: any `https://` URL (most common) or an in-repo file path.
   - `filename`: optional override.
   - `content_type`: optional override (defaults to `application/octet-stream`).

4. After the run, check the step notice `storage.to upload` for the public link,
   or read `steps.upload.outputs.url` / `steps.upload.outputs.raw_url` in the job
   summary.

## From the GitHub mobile app

The same flow works from the phone: **Actions → Upload to storage.to → Run workflow → paste URL → tap Run**. The link appears in the run summary.

## Speed notes

- Default runners cap network at ~1 Gbps. For larger files bump `runs-on` to
  `ubuntu-latest-8-cores` (or a third-party hosted runner like Blacksmith /
  Depot) — single-line change in `.github/workflows/upload.yml`.
- Files >50 MB auto-use storage.to's multipart upload (32 MB parts).
- Anonymous quota: 100 GB / 24 h per visitor token, 500 GB / 24 h per IP.

## Files

- `upload.mjs` — the uploader script (Node 18+, no deps).
- `.github/workflows/upload.yml` — the workflow.

## Test it

Run the workflow with `source` set to any small public file, e.g.
`https://raw.githubusercontent.com/github/explore/main/topics/python/python.png`.
You should get a `https://storage.to/<id>` link within seconds.
