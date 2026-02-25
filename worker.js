/**
 * NirvanaTraffic VPS Worker v2.0 — GoLogin Edition
 * 
 * Polls Supabase job queue → launches GoLogin fingerprinted browser → 
 * connects Playwright via CDP → runs search journeys → reports results.
 * 
 * Changes from v1.0:
 *   - Replaced raw chromium.launch with GoLogin API (real device fingerprints)
 *   - Removed proxy-chain (GoLogin handles proxy auth natively)
 *   - Removed Bablosoft FingerprintSwitcher dependency
 *   - Browser profiles created/managed via GoLogin REST API
 * 
 * Usage:
 *   npm install
 *   node worker.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { chromium } = require("playwright");
const axios = require("axios");

// ── Config ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DECODO_USER = process.env.DECODO_USER;
const DECODO_PASS = process.env.DECODO_PASS;
const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY;
const GOLOGIN_TOKEN = process.env.GOLOGIN_TOKEN;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "1", 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const GL_API = "https://api.gologin.com";
const GL_HEADERS = { Authorization: `Bearer ${GOLOGIN_TOKEN}`, "Content-Type": "application/json" };

let activeJobs = 0;

// ── GoLogin Profile Management ──────────────────────────
async function createGoLoginProfile(mobile, proxyConfig) {
  // Fetch a real device fingerprint from GoLogin
  const os = mobile ? "android" : "win";
  const fpRes = await axios.get(`${GL_API}/browser/fingerprint?os=${os}`, { headers: GL_HEADERS });
  const fp = fpRes.data;

  const profileData = {
    name: `nirvana-${Date.now()}`,
    os,
    browserType: "chrome",
    navigator: {
      userAgent: fp.navigator?.userAgent || (mobile
        ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"),
      platform: fp.navigator?.platform || (mobile ? "Linux armv81" : "Win32"),
      resolution: mobile ? "390x844" : "1920x1080",
      language: "en-US,en",
    },
    proxy: proxyConfig.username ? {
      mode: "http",
      host: "gate.decodo.com",
      port: 10001,
      username: proxyConfig.username,
      password: proxyConfig.password,
    } : { mode: "none" },
    webRTC: {
      mode: "altered",
      enabled: true,
    },
  };

  const res = await axios.post(`${GL_API}/browser`, profileData, { headers: GL_HEADERS });
  return res.data.id;
}

async function startGoLoginProfile(profileId) {
  // Start cloud browser — returns status + remoteOrbitaUrl
  await axios.post(
    `${GL_API}/browser/${profileId}/web`,
    { isNewRecovery: true },
    { headers: GL_HEADERS }
  );
  // Connect via the documented websocket URL format
  return `wss://cloudbrowser.gologin.com/connect?token=${GOLOGIN_TOKEN}&profile=${profileId}`;
}

async function stopGoLoginProfile(profileId) {
  try {
    await axios.delete(`${GL_API}/browser/${profileId}/web`, { headers: GL_HEADERS });
  } catch { /* ok — profile may already be stopped */ }
}

async function deleteGoLoginProfile(profileId) {
  try {
    await axios.delete(`${GL_API}/browser/${profileId}`, { headers: GL_HEADERS });
  } catch { /* ok */ }
}

// ── 2Captcha reCAPTCHA solver (API v2 — createTask/getTaskResult) ────
async function solveRecaptcha(pageUrl, siteKey, dataS, proxyInfo, cookies, userAgent) {
  const task = {
    type: proxyInfo ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };
  if (dataS) task.recaptchaDataSValue = dataS;
  if (userAgent) task.userAgent = userAgent;
  if (cookies) task.cookies = cookies;
  
  if (proxyInfo) {
    task.proxyType = "http";
    task.proxyAddress = proxyInfo.host;
    task.proxyPort = proxyInfo.port;
    if (proxyInfo.username) task.proxyLogin = proxyInfo.username;
    if (proxyInfo.password) task.proxyPassword = proxyInfo.password;
  }

  console.log(`  🔐 2Captcha: submitting ${task.type} (data-s: ${dataS ? 'yes' : 'no'}, proxy: ${proxyInfo ? 'yes' : 'no'})`);

  const createRes = await axios.post("https://api.2captcha.com/createTask", {
    clientKey: TWOCAPTCHA_KEY,
    task,
  });
  if (createRes.data.errorId !== 0) throw new Error("2Captcha createTask failed: " + (createRes.data.errorDescription || createRes.data.errorCode));
  const taskId = createRes.data.taskId;
  console.log(`  🔐 2Captcha: task ${taskId} created, waiting for solution...`);

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await axios.post("https://api.2captcha.com/getTaskResult", {
      clientKey: TWOCAPTCHA_KEY,
      taskId,
    });
    if (res.data.status === "ready") {
      console.log(`  🔐 2Captcha: solved in ${(i + 1) * 5}s`);
      return res.data.solution.gRecaptchaResponse;
    }
    if (res.data.errorId !== 0) throw new Error("2Captcha error: " + (res.data.errorDescription || res.data.errorCode));
  }
  throw new Error("2Captcha timeout — no solution in 120s");
}

// ── UULE Generator ─────────────────────────────────────
const UULE_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function generateUule(canonicalName) {
  const b64 = Buffer.from(canonicalName).toString("base64").replace(/=/g, "");
  return "w+CAIQICI" + UULE_KEY[canonicalName.length] + b64;
}

// ── Random helper ───────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

// ── The Journey ─────────────────────────────────────────
async function runJourney(job) {
  const startTime = Date.now();
  const steps = [];
  const log = (action, details) => {
    const ts = Date.now() - startTime;
    steps.push({ action, timestamp: ts, details });
    console.log(`  [${(ts / 1000).toFixed(1)}s] ${action}${details ? ": " + details : ""}`);
  };

  // Parse job params
  const params = job.params || {};
  const keyword = params.keyword || "";
  const targetBusiness = params.targetBusiness || params.target_business || "";
  const targetUrl = params.targetUrl || params.target_url || "";
  const dwellTimeMs = params.dwellTimeMs || params.dwell_time_ms || rand(15000, 45000);
  const mobile = params.mobile || false;
  const geo = (params.proxyCity || params.proxy_city)
    ? {
        city: params.proxyCity || params.proxy_city,
        state: params.proxyState || params.proxy_state,
        country: params.proxyCountry || params.proxy_country || "United States",
      }
    : null;

  const proxyConfig = { username: DECODO_USER, password: DECODO_PASS };

  // Build Google URL with UULE
  let googleUrl = "https://www.google.com/?gl=us&hl=en";
  if (geo?.city && geo?.state) {
    const canonicalName = `${geo.city},${geo.state},${geo.country || "United States"}`;
    const uule = generateUule(canonicalName);
    googleUrl += `&uule=${uule}`;
    log("uule_generated", canonicalName);
  }

  let profileId;
  let browser;
  try {
    // ── GoLogin: create profile with fingerprint + proxy ──
    profileId = await createGoLoginProfile(mobile, proxyConfig);
    log("gologin_profile_created", profileId);

    // ── GoLogin: start cloud browser and get websocket URL ──
    const wsUrl = await startGoLoginProfile(profileId);
    log("gologin_browser_started", `ws: ${wsUrl.slice(0, 60)}...`);

    // ── Playwright: connect via CDP ──
    browser = await chromium.connectOverCDP(wsUrl);
    log("playwright_connected");

    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    // Go to Google
    await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    log("google_loaded");
    await page.waitForTimeout(rand(800, 1500));

    // Check for captcha — solve with 2Captcha
    if (page.url().includes("/sorry/") || page.url().includes("captcha")) {
      log("captcha_detected", "Solving with 2Captcha...");
      try {
        const captchaInfo = await page.evaluate(() => {
          const el = document.querySelector('[data-sitekey]') || document.querySelector('.g-recaptcha');
          if (!el) return null;
          return {
            siteKey: el.getAttribute('data-sitekey'),
            dataS: el.getAttribute('data-s') || '',
          };
        });
        if (!captchaInfo || !captchaInfo.siteKey) throw new Error("Could not find reCAPTCHA sitekey on page");
        
        const browserCookies = await context.cookies();
        const cookieStr = browserCookies.map(c => `${c.name}=${c.value}`).join("; ");
        
        log("captcha_sitekey", `key=${captchaInfo.siteKey.slice(0,20)}... data-s=${captchaInfo.dataS ? 'yes' : 'no'} cookies=${browserCookies.length}`);

        const proxyInfo = { host: "gate.decodo.com", port: 10001, username: DECODO_USER, password: DECODO_PASS };
        const ua = await page.evaluate(() => navigator.userAgent);

        const token = await solveRecaptcha(page.url(), captchaInfo.siteKey, captchaInfo.dataS, proxyInfo, cookieStr, ua);
        log("captcha_solved", `token=${token.slice(0,30)}...`);

        await page.evaluate((tok) => {
          const resp = document.getElementById('g-recaptcha-response');
          if (resp) resp.value = tok;
          const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
          if (ta) ta.value = tok;
          const form = document.getElementById('captcha-form') || document.querySelector('form');
          if (form) form.submit();
        }, token);

        await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
        log("captcha_submitted", `now at: ${page.url()}`);

        if (page.url().includes("/sorry/")) {
          log("captcha_failed", "Still on sorry page after solve");
          return { success: false, found: false, captcha: true, steps, error: "Captcha solved but still blocked", duration_ms: Date.now() - startTime };
        }
        log("captcha_bypassed", "Successfully passed captcha!");
      } catch (err) {
        log("captcha_solve_error", err.message);
        return { success: false, found: false, captcha: true, steps, error: "Captcha solve failed: " + err.message, duration_ms: Date.now() - startTime };
      }
    }

    // Cookie consent
    try {
      const btn = page.locator('button:has-text("Accept all"), button:has-text("Accept"), #L2AGLb');
      if (await btn.first().isVisible({ timeout: 2000 })) {
        await btn.first().click();
        log("cookie_accepted");
      }
    } catch { /* ok */ }

    // Type keyword humanly
    const input = page.locator('textarea[name="q"], input[name="q"]').first();
    await input.click();
    await page.waitForTimeout(rand(300, 600));
    for (const c of keyword) {
      await page.keyboard.type(c, { delay: rand(50, 180) });
      if (Math.random() < 0.1) await page.waitForTimeout(rand(200, 500));
    }
    log("keyword_typed", keyword);

    // Search
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded");
    log("search_submitted");

    // Wait for results
    try {
      await page.waitForSelector("#search, #rso, .g", { timeout: 15000 });
      log("results_rendered");
    } catch {
      if (page.url().includes("/sorry/")) {
        log("captcha_after_search", "Solving with 2Captcha...");
        try {
          const captchaInfo = await page.evaluate(() => {
            const el = document.querySelector('[data-sitekey]') || document.querySelector('.g-recaptcha');
            if (!el) return null;
            return { siteKey: el.getAttribute('data-sitekey'), dataS: el.getAttribute('data-s') || '' };
          });
          if (!captchaInfo || !captchaInfo.siteKey) throw new Error("No reCAPTCHA sitekey found");

          const browserCookies = await context.cookies();
          const cookieStr = browserCookies.map(c => `${c.name}=${c.value}`).join("; ");
          const proxyInfo = { host: "gate.decodo.com", port: 10001, username: DECODO_USER, password: DECODO_PASS };
          const ua = await page.evaluate(() => navigator.userAgent);

          const token = await solveRecaptcha(page.url(), captchaInfo.siteKey, captchaInfo.dataS, proxyInfo, cookieStr, ua);
          log("captcha_solved_post_search", `token=${token.slice(0,30)}...`);

          await page.evaluate((tok) => {
            const resp = document.getElementById('g-recaptcha-response');
            if (resp) resp.value = tok;
            const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
            if (ta) ta.value = tok;
            const form = document.getElementById('captcha-form') || document.querySelector('form');
            if (form) form.submit();
          }, token);

          await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
          await page.waitForSelector("#search, #rso, .g", { timeout: 15000 });
          log("captcha_bypassed", "Search results loaded after captcha solve");
        } catch (err) {
          log("captcha_solve_error_post", err.message);
          return { success: false, found: false, captcha: true, steps, error: "Post-search captcha failed: " + err.message, duration_ms: Date.now() - startTime };
        }
      }
    }
    await page.waitForTimeout(rand(1500, 3000));

    // Light scroll
    await page.mouse.wheel(0, rand(200, 400));
    await page.waitForTimeout(rand(800, 1500));
    log("scrolled_results");

    // ── Smart target matching ───────────────────────────
    const bizLow = targetBusiness.toLowerCase();
    const bizWords = bizLow.split(/\s+/).filter((w) => w.length > 1);
    const urlLow = (targetUrl || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

    const scoreMatch = (text, href) => {
      const t = text.toLowerCase();
      const h = href.toLowerCase();
      let score = 0;
      if (t.includes(bizLow)) score += 100;
      if (urlLow && h.includes(urlLow)) score += 90;
      if (urlLow && t.includes(urlLow)) score += 80;
      const wordsFound = bizWords.filter((w) => t.includes(w)).length;
      const wordRatio = bizWords.length > 0 ? wordsFound / bizWords.length : 0;
      if (wordRatio >= 0.75) score += 70;
      else if (wordRatio >= 0.5) score += 40;
      return score;
    };

    let found = false;
    let clickedRank = 0;

    // Strategy 1: Maps/Local Pack
    const mapsPack = page.locator(
      '[data-local-attribute="d3bn"], .VkpGBb, [jscontroller="AtSb"] a, div.rllt__details a, a[data-cid]'
    );
    const mapsCount = await mapsPack.count();
    if (mapsCount > 0) {
      log("maps_pack_found", `${mapsCount} local results`);
      for (let i = 0; i < mapsCount; i++) {
        const el = mapsPack.nth(i);
        const txt = (await el.textContent()) || "";
        const href = (await el.getAttribute("href")) || "";
        const score = scoreMatch(txt, href);
        if (score >= 50) {
          await el.scrollIntoViewIfNeeded();
          await page.waitForTimeout(rand(500, 1200));
          await el.click();
          found = true;
          clickedRank = i + 1;
          log("maps_target_clicked", `Maps pos ${i + 1} (score:${score}): ${txt.slice(0, 100)}`);
          break;
        }
      }
    }

    // Strategy 2: Organic results
    if (!found) {
      const organicResults = page.locator("#search a h3, #rso a h3");
      const orgCount = await organicResults.count();
      log("organic_results", `${orgCount} organic results`);
      for (let i = 0; i < orgCount; i++) {
        const h3 = organicResults.nth(i);
        const parentLink = h3.locator("xpath=ancestor::a");
        const txt = (await h3.textContent()) || "";
        const href = (await parentLink.getAttribute("href").catch(() => "")) || "";
        const score = scoreMatch(txt, href);
        if (score >= 50) {
          await parentLink.scrollIntoViewIfNeeded();
          await page.waitForTimeout(rand(500, 1200));
          await parentLink.click();
          found = true;
          clickedRank = i + 1;
          log("organic_target_clicked", `Organic pos ${i + 1} (score:${score}): ${txt.slice(0, 100)}`);
          break;
        }
      }
    }

    // Strategy 3: Broad scan
    if (!found) {
      const allLinks = await page.locator("#search a[href]").all();
      for (let i = 0; i < allLinks.length; i++) {
        const txt = (await allLinks[i].textContent()) || "";
        const href = (await allLinks[i].getAttribute("href")) || "";
        if (txt.trim().length < 3) continue;
        const score = scoreMatch(txt, href);
        if (score >= 50) {
          await allLinks[i].scrollIntoViewIfNeeded();
          await page.waitForTimeout(rand(500, 1200));
          await allLinks[i].click();
          found = true;
          clickedRank = i + 1;
          log("broad_target_clicked", `Broad pos ${i + 1} (score:${score}): ${txt.slice(0, 100)}`);
          break;
        }
      }
    }

    if (!found) {
      const pageTitle = await page.title().catch(() => "unknown");
      const snippet = await page.locator("#search, #rso, body").first().textContent().catch(() => "");
      log("target_not_found", `"${targetBusiness}" not found. Title: "${pageTitle}" Snippet: ${(snippet || "").slice(0, 300)}`);
      return { success: true, found: false, clickedRank: 0, steps, duration_ms: Date.now() - startTime };
    }

    // Dwell on target page
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    log("dwelling", `${Math.round(dwellTimeMs / 1000)}s`);
    for (let i = 0; i < Math.floor(dwellTimeMs / 5000); i++) {
      await page.waitForTimeout(rand(3000, 6000));
      await page.mouse.wheel(0, rand(150, 400));
    }
    await page.waitForTimeout(rand(2000, 5000));
    log("dwell_complete");

    return { success: true, found: true, clickedRank, steps, duration_ms: Date.now() - startTime };
  } catch (err) {
    log("error", err.message);
    return { success: false, found: false, steps, error: err.message, duration_ms: Date.now() - startTime };
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Cleanup GoLogin profile
    if (profileId) {
      await stopGoLoginProfile(profileId);
      await deleteGoLoginProfile(profileId);
      console.log(`  🧹 GoLogin profile ${profileId} cleaned up`);
    }
  }
}

// ── Job Processor ───────────────────────────────────────
async function processJob(job) {
  const jobId = job.id;
  console.log(`\n🦑 Processing job ${jobId} — ${job.params?.keyword || "no keyword"}`);

  await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);

  // Retry up to 5 times with fresh profiles on CAPTCHA
  let result;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) console.log(`  🔄 Retry #${attempt} with fresh GoLogin profile + IP...`);
    result = await runJourney(job);
    if (!result.captcha) break;
    await new Promise(r => setTimeout(r, rand(2000, 5000)));
  }

  await supabase
    .from("jobs")
    .update({
      status: result.success ? "completed" : "failed",
      completed_at: new Date().toISOString(),
      result,
      error: result.error || null,
    })
    .eq("id", jobId);

  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i];
    await supabase.from("execution_logs").insert({
      job_id: jobId,
      step_number: i,
      action: step.action,
      details: { timestamp_ms: step.timestamp, info: step.details },
      duration_ms: step.timestamp,
    });
  }

  console.log(
    `  ✅ Job ${jobId} ${result.success ? "completed" : "failed"} — ${result.found ? "FOUND" : "not found"} (${(result.duration_ms / 1000).toFixed(1)}s)`
  );
}

// ── Poll Loop ───────────────────────────────────────────
async function poll() {
  if (activeJobs >= MAX_CONCURRENT) return;

  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(MAX_CONCURRENT - activeJobs);

  if (error) {
    console.error("❌ Supabase poll error:", error.message);
    return;
  }

  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    activeJobs++;
    processJob(job)
      .catch((err) => console.error(`❌ Job ${job.id} crashed:`, err.message))
      .finally(() => activeJobs--);
  }
}

// ── Main ────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   🦑 NirvanaTraffic Worker v2.0      ║");
  console.log("║   🎭 GoLogin Fingerprinting           ║");
  console.log("║   🌐 Decodo Residential Proxies       ║");
  console.log("║   Polling every " + (POLL_INTERVAL / 1000) + "s                 ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Validate GoLogin token
  if (!GOLOGIN_TOKEN) {
    console.error("❌ GOLOGIN_TOKEN not set in .env");
    process.exit(1);
  }
  try {
    const glUser = await axios.get(`${GL_API}/user`, { headers: GL_HEADERS });
    console.log(`✅ GoLogin: ${glUser.data.email} (${glUser.data.plan?.name || 'unknown'} plan)`);
  } catch (err) {
    console.error("❌ GoLogin token invalid:", err.message);
    process.exit(1);
  }

  // Test Supabase connection
  const { count, error } = await supabase.from("jobs").select("*", { count: "exact", head: true });
  if (error) {
    console.error("❌ Cannot connect to Supabase:", error.message);
    process.exit(1);
  }
  console.log(`✅ Connected to Supabase — ${count} total jobs in queue`);
  console.log("👀 Watching for queued jobs...\n");

  setInterval(poll, POLL_INTERVAL);
  poll();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
