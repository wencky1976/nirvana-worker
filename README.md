# 🦑 NirvanaTraffic Worker

VPS worker that polls the NirvanaTraffic job queue and executes Squidoosh journeys using Playwright + Decodo residential proxies.

## Setup (Windows VPS)

### 1. Install Node.js
Download and install from: https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi

### 2. Copy this folder
Copy the entire `nirvana-worker` folder to the VPS (e.g., `C:\nirvana-worker`)

### 3. Run the installer
Double-click `INSTALL.bat` — this installs dependencies and the Chromium browser.

### 4. Start the worker
Double-click `START.bat` or run `node worker.js` from the command prompt.

## How it works

1. Worker polls Supabase every 60 seconds for `status: "queued"` jobs
2. Picks up the oldest queued job
3. Launches headless Chromium with Decodo residential proxy
4. Goes to Google with UULE parameter for location targeting
5. Types keyword humanly, searches, finds target business, clicks, dwells
6. Reports result back to Supabase
7. Repeats

## Files

| File | Purpose |
|------|---------|
| `worker.js` | Main worker script |
| `.env` | Credentials (Supabase + Decodo) |
| `INSTALL.bat` | One-click setup |
| `START.bat` | One-click start |
| `package.json` | Node.js dependencies |

## Queue a test job

From the NirvanaTraffic dashboard or Supabase SQL editor:

```sql
INSERT INTO jobs (campaign_id, template_id, status, params) VALUES (
  null, null, 'queued',
  '{"keyword": "pest control houston tx", "targetBusiness": "X Out Pest Services", "targetUrl": "xoutpestservices.com", "proxyCity": "Houston", "proxyState": "Texas", "proxyCountry": "United States"}'
);
```

## Proxy bandwidth

Each journey uses ~2-5 MB of proxy bandwidth. At 1 journey/min = ~3-7 GB/day.
Decodo Pay-As-You-Go: ~$8.50/GB.
