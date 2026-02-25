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
  // Try to fetch a real device fingerprint, fallback to defaults
  let ua, platform;
  try {
    const os = mobile ? "android" : "win";
    const fpRes = await axios.get(`${GL_API}/browser/fingerprint?os=${os}`, { headers: GL_HEADERS });
    ua = fpRes.data?.navigator?.userAgent;
    platform = fpRes.data?.navigator?.platform;
    console.log(`  🎭 Got fingerprint from GoLogin API`);
  } catch (e) {
    console.log(`  🎭 Fingerprint fetch failed (${e.message}), using defaults`);
  }

  const profileData = {
    name: `nirvana-${Date.now()}`,
    os: mobile ? "android" : "win",
    browserType: "chrome",
    navigator: {
      userAgent: ua || (mobile
        ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
      platform: platform || (mobile ? "Linux armv81" : "Win32"),
      resolution: mobile ? "390x844" : "1920x1080",
      language: "en-US,en",
    },
    proxy: proxyConfig.username ? {
      mode: "http",
      host: String(proxyConfig.host || "gate.decodo.com"),
      port: Number(proxyConfig.port || 10001),
      username: String(proxyConfig.username),
      password: String(proxyConfig.password),
    } : { mode: "none" },
    webRTC: { mode: "alerted", enabled: true },
  };

  console.log(`  🎭 Creating GoLogin profile (proxy: ${proxyConfig.username ? 'yes' : 'none'})...`);
  try {
    const res = await axios.post(`${GL_API}/browser`, profileData, { headers: GL_HEADERS });
    console.log(`  🎭 Profile created: ${res.data.id}`);
    return res.data.id;
  } catch (e) {
    console.error(`  ❌ GoLogin profile create failed:`, JSON.stringify(e.response?.data || e.message).slice(0,500));
    throw e;
  }
}

async function launchGoLoginBrowser(profileId) {
  // Use GoLogin SDK to launch Orbita browser locally with full fingerprinting
  const { GologinApi } = await import('gologin');
  const GL = GologinApi({ token: GOLOGIN_TOKEN });
  
  console.log(`  🌐 Launching GoLogin Orbita browser locally...`);
  const browser = await GL.launch({ profileId });
  console.log(`  🌐 Browser launched!`);
  
  return { browser, GL };
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
  let glApi;
  try {
    // ── GoLogin: create profile with fingerprint + proxy ──
    profileId = await createGoLoginProfile(mobile, proxyConfig);
    log("gologin_profile_created", profileId);

    // ── GoLogin: launch Orbita browser locally ──
    const result = await launchGoLoginBrowser(profileId);
    browser = result.browser;
    glApi = result.GL;
    log("gologin_browser_launched");

    // ── Get page from GoLogin's browser (Puppeteer-style API) ──
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Helper: wait ms (Puppeteer-compatible)
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // Go to Google
    await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    log("google_loaded");
    await wait(rand(800, 1500));

    // Check for captcha
    if (page.url().includes("/sorry/") || page.url().includes("captcha")) {
      log("captcha_detected", "Solving with 2Captcha...");
      try {
        const captchaInfo = await page.evaluate(() => {
          const el = document.querySelector('[data-sitekey]') || document.querySelector('.g-recaptcha');
          if (!el) return null;
          return { siteKey: el.getAttribute('data-sitekey'), dataS: el.getAttribute('data-s') || '' };
        });
        if (!captchaInfo || !captchaInfo.siteKey) throw new Error("Could not find reCAPTCHA sitekey");

        const browserCookies = await page.cookies();
        const cookieStr = browserCookies.map(c => `${c.name}=${c.value}`).join("; ");
        const proxyInfo = { host: "gate.decodo.com", port: 10001, username: DECODO_USER, password: DECODO_PASS };
        const ua = await page.evaluate(() => navigator.userAgent);

        const token = await solveRecaptcha(page.url(), captchaInfo.siteKey, captchaInfo.dataS, proxyInfo, cookieStr, ua);
        log("captcha_solved");

        await page.evaluate((tok) => {
          const resp = document.getElementById('g-recaptcha-response');
          if (resp) resp.value = tok;
          const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
          if (ta) ta.value = tok;
          const form = document.getElementById('captcha-form') || document.querySelector('form');
          if (form) form.submit();
        }, token);

        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        if (page.url().includes("/sorry/")) {
          return { success: false, found: false, captcha: true, steps, error: "Captcha bypass failed", duration_ms: Date.now() - startTime };
        }
        log("captcha_bypassed");
      } catch (err) {
        log("captcha_error", err.message);
        return { success: false, found: false, captcha: true, steps, error: err.message, duration_ms: Date.now() - startTime };
      }
    }

    // Cookie consent
    try {
      const btn = await page.$('#L2AGLb, button[aria-label="Accept all"]');
      if (btn) { await btn.click(); log("cookie_accepted"); }
    } catch { /* ok */ }

    // Type keyword humanly
    const input = await page.$('textarea[name="q"], input[name="q"]');
    if (input) {
      await input.click();
      await wait(rand(300, 600));
      for (const c of keyword) {
        await page.keyboard.type(c, { delay: rand(50, 180) });
        if (Math.random() < 0.1) await wait(rand(200, 500));
      }
    }
    log("keyword_typed", keyword);

    // Search
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    log("search_submitted");

    // Wait for results
    try {
      await page.waitForSelector("#search, #rso, .g", { timeout: 15000 });
      log("results_rendered");
    } catch {
      if (page.url().includes("/sorry/")) {
        log("captcha_after_search");
        return { success: false, found: false, captcha: true, steps, error: "Captcha after search", duration_ms: Date.now() - startTime };
      }
    }
    await wait(rand(1500, 3000));

    // Light scroll
    await page.evaluate(() => window.scrollBy(0, Math.random() * 400 + 200));
    await wait(rand(800, 1500));
    log("scrolled_results");

    // ── Smart target matching (Puppeteer-style) ─────────
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

    // Find and click target using page.evaluate for all matching
    const matchResult = await page.evaluate((bizLow, bizWords, urlLow) => {
      const scoreMatch = (text, href) => {
        const t = text.toLowerCase();
        const h = href.toLowerCase();
        let score = 0;
        if (t.includes(bizLow)) score += 100;
        if (urlLow && h.includes(urlLow)) score += 90;
        if (urlLow && t.includes(urlLow)) score += 80;
        const wordsFound = bizWords.filter(w => t.includes(w)).length;
        const wordRatio = bizWords.length > 0 ? wordsFound / bizWords.length : 0;
        if (wordRatio >= 0.75) score += 70;
        else if (wordRatio >= 0.5) score += 40;
        return score;
      };

      // Maps/Local Pack
      const mapsEls = document.querySelectorAll('[data-local-attribute="d3bn"] a, .VkpGBb a, div.rllt__details a, a[data-cid]');
      for (let i = 0; i < mapsEls.length; i++) {
        const txt = mapsEls[i].textContent || "";
        const href = mapsEls[i].href || "";
        if (scoreMatch(txt, href) >= 50) {
          return { type: "maps", index: i, rank: i + 1, text: txt.slice(0, 100), selector: `[data-cid]:nth-of-type(${i+1}) a, .VkpGBb a` };
        }
      }

      // Organic H3 results
      const h3s = document.querySelectorAll("#search a h3, #rso a h3");
      for (let i = 0; i < h3s.length; i++) {
        const link = h3s[i].closest("a");
        if (!link) continue;
        const txt = h3s[i].textContent || "";
        const href = link.href || "";
        if (scoreMatch(txt, href) >= 50) {
          return { type: "organic", index: i, rank: i + 1, text: txt.slice(0, 100), href };
        }
      }

      // Broad scan
      const allLinks = document.querySelectorAll("#search a[href]");
      for (let i = 0; i < allLinks.length; i++) {
        const txt = allLinks[i].textContent || "";
        const href = allLinks[i].href || "";
        if (txt.trim().length < 3) continue;
        if (scoreMatch(txt, href) >= 50) {
          return { type: "broad", index: i, rank: i + 1, text: txt.slice(0, 100), href };
        }
      }

      return null;
    }, bizLow, bizWords, urlLow);

    let found = false;
    let clickedRank = 0;

    if (matchResult) {
      // Click the found target
      log(`${matchResult.type}_target_found`, `pos ${matchResult.rank}: ${matchResult.text}`);
      
      if (matchResult.type === "organic" || matchResult.type === "broad") {
        // Click by navigating to href directly after scrolling
        const h3s = await page.$$(`${matchResult.type === "organic" ? "#search a h3, #rso a h3" : "#search a[href]"}`);
        if (h3s[matchResult.index]) {
          const el = matchResult.type === "organic" ? (await h3s[matchResult.index].$x("ancestor::a"))[0] || h3s[matchResult.index] : h3s[matchResult.index];
          await el.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await wait(rand(500, 1200));
          await el.click();
          found = true;
          clickedRank = matchResult.rank;
          log("target_clicked", `${matchResult.type} pos ${matchResult.rank}`);
        }
      } else {
        // Maps click
        const mapsEls = await page.$$('[data-cid] a, .VkpGBb a, div.rllt__details a');
        if (mapsEls[matchResult.index]) {
          await mapsEls[matchResult.index].evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await wait(rand(500, 1200));
          await mapsEls[matchResult.index].click();
          found = true;
          clickedRank = matchResult.rank;
          log("maps_target_clicked", `pos ${matchResult.rank}`);
        }
      }
    }

    if (!found) {
      const pageTitle = await page.title().catch(() => "unknown");
      log("target_not_found", `"${targetBusiness}" not in results. Title: "${pageTitle}"`);
      return { success: true, found: false, clickedRank: 0, steps, duration_ms: Date.now() - startTime };
    }

    // Dwell on target page
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    log("dwelling", `${Math.round(dwellTimeMs / 1000)}s`);
    for (let i = 0; i < Math.floor(dwellTimeMs / 5000); i++) {
      await wait(rand(3000, 6000));
      await page.evaluate(() => window.scrollBy(0, Math.random() * 400 + 150));
    }
    await wait(rand(2000, 5000));
    log("dwell_complete");

    return { success: true, found: true, clickedRank, steps, duration_ms: Date.now() - startTime };
  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0,200) : err.message;
    log("error", errDetail);
    return { success: false, found: false, steps, error: errDetail, duration_ms: Date.now() - startTime };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (glApi) await glApi.stop().catch(() => {});
    // Cleanup GoLogin profile
    if (profileId) {
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
