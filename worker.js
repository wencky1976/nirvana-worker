/**
 * NirvanaTraffic VPS Worker
 * 
 * Polls Supabase job queue → runs Playwright journeys with Decodo proxies → reports results.
 * Designed to run as a persistent process on a Windows VPS.
 * 
 * Usage:
 *   npm install
 *   npx playwright install chromium
 *   node worker.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { chromium } = require("playwright");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const proxyChain = require("proxy-chain");

// ── Config ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DECODO_USER = process.env.DECODO_USER;
const DECODO_PASS = process.env.DECODO_PASS;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "1", 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let activeJobs = 0;

// ── UULE Generator ─────────────────────────────────────
const UULE_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function generateUule(canonicalName) {
  const b64 = Buffer.from(canonicalName).toString("base64").replace(/=/g, "");
  return "w+CAIQICI" + UULE_KEY[canonicalName.length] + b64;
}

// ── Decodo Proxy URL ────────────────────────────────────
function buildProxyUrl() {
  // Decodo residential proxy — US country targeting via username
  const user = `${DECODO_USER}-country-us`;
  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(DECODO_PASS);
  return {
    // Full URL with auth for proxy-chain and HttpsProxyAgent
    url: `http://${encodedUser}:${encodedPass}@gate.decodo.com:10001`,
    username: user,
    password: DECODO_PASS,
  };
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

  // Build proxy
  const proxy = buildProxyUrl();
  log("proxy_configured", `${proxy.username} → gate.decodo.com:10001`);

  // Test proxy connection using Decodo's exact method
  try {
    const proxyAgent = new HttpsProxyAgent(proxy.url);
    const ipCheck = await axios.get("https://ip.decodo.com/json", {
      httpsAgent: proxyAgent,
      timeout: 15000,
    });
    const d = ipCheck.data;
    log("proxy_verified", `IP: ${d.ip || d.query} — ${d.city || "?"}, ${d.country || d.country_code || "?"}`);
  } catch (err) {
    log("proxy_test_failed", err.message);
    return { success: false, found: false, steps, error: "Proxy connection failed: " + err.message, duration_ms: Date.now() - startTime };
  }

  // Build Google URL with UULE
  let googleUrl = "https://www.google.com/?gl=us&hl=en";
  if (geo?.city && geo?.state) {
    const canonicalName = `${geo.city},${geo.state},${geo.country || "United States"}`;
    const uule = generateUule(canonicalName);
    googleUrl += `&uule=${uule}`;
    log("uule_generated", canonicalName);
  }

  let browser;
  let localProxy;
  try {
    // Use proxy-chain to create a local anonymous proxy
    // This handles auth so Playwright doesn't have to
    const localProxy = await proxyChain.anonymizeProxy(proxy.url);
    log("local_proxy_created", localProxy);

    browser = await chromium.launch({
      headless: false,
      proxy: {
        server: localProxy,
      },
    });
    log("browser_launched");

    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      userAgent: mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/Chicago",
    });
    const page = await context.newPage();

    // Go to Google
    await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    log("google_loaded");
    await page.waitForTimeout(rand(800, 1500));

    // Check for captcha
    if (page.url().includes("/sorry/") || page.url().includes("captcha")) {
      log("captcha_detected", "Google CAPTCHA — aborting this attempt");
      return { success: false, found: false, steps, error: "Google CAPTCHA", duration_ms: Date.now() - startTime };
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
      // Check for captcha again after search
      if (page.url().includes("/sorry/")) {
        log("captcha_after_search", "CAPTCHA on results page");
        return { success: false, found: false, steps, error: "Google CAPTCHA after search", duration_ms: Date.now() - startTime };
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
    // Clean up proxy-chain
    try { await proxyChain.closeAnonymizedProxy(localProxy, true); } catch {}
  }
}

// ── Job Processor ───────────────────────────────────────
async function processJob(job) {
  const jobId = job.id;
  console.log(`\n🦑 Processing job ${jobId} — ${job.params?.keyword || "no keyword"}`);

  // Mark as running
  await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);

  const result = await runJourney(job);

  // Save result
  await supabase
    .from("jobs")
    .update({
      status: result.success ? "completed" : "failed",
      completed_at: new Date().toISOString(),
      result,
      error: result.error || null,
    })
    .eq("id", jobId);

  // Save execution logs
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
  console.log("║   🦑 NirvanaTraffic Worker v1.0      ║");
  console.log("║   VPS: Mediumbox-VM                  ║");
  console.log("║   Proxy: Decodo Residential           ║");
  console.log("║   Polling every " + (POLL_INTERVAL / 1000) + "s                 ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Test Supabase connection
  const { count, error } = await supabase.from("jobs").select("*", { count: "exact", head: true });
  if (error) {
    console.error("❌ Cannot connect to Supabase:", error.message);
    process.exit(1);
  }
  console.log(`✅ Connected to Supabase — ${count} total jobs in queue`);
  console.log("👀 Watching for queued jobs...\n");

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll(); // Run immediately on start
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
