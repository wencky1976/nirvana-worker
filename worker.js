/**
 * NirvanaTraffic VPS Worker v3.1 — Modular Edition
 * 
 * Polls Supabase job queue → routes to journey module → reports results.
 * 
 * Journey types:
 *   - squidoosh (default): Search + Maps Pack + Organic → click → dwell
 *   - organic: Pure organic, pages 1-5, skip ads/Maps → click → dwell
 *   - maps_direct: (coming soon) Google Maps direct journey
 *   - thanos: (coming soon) Full Thanos journey
 * 
 * Usage:
 *   npm install
 *   node worker.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { CONFIG, GL_API, GL_HEADERS, rand } = require("./lib/shared");

// ── Journey Modules ─────────────────────────────────────
const JOURNEYS = {
  squidoosh: require("./journeys/squidoosh"),
  organic: require("./journeys/organic"),
  // maps_direct: require("./journeys/maps-direct"),  // coming soon
  // thanos: require("./journeys/thanos"),              // coming soon
};

// ── Config ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "1", 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let activeJobs = 0;

// ── Job Router ──────────────────────────────────────────
function getJourney(job) {
  const type = job.params?.journeyType || job.params?.journey_type || "squidoosh";
  const journey = JOURNEYS[type];
  if (!journey) {
    console.warn(`  ⚠️ Unknown journey type "${type}", falling back to squidoosh`);
    return { journey: JOURNEYS.squidoosh, type: "squidoosh" };
  }
  return { journey, type };
}

// ── Timeout Helper ──────────────────────────────────────
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "300000", 10); // 5 min default

function withTimeout(promise, ms, jobId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`JOB_TIMEOUT: Job ${jobId} exceeded ${ms / 1000}s timeout — force killed`));
    }, ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// ── Queue Item → Job Params Mapper ──────────────────────
function mapQueueItemToParams(item) {
  // queue_items store config in `result` field (set at creation time)
  // Worker journeys expect `params` with keyword, targetUrl, etc.
  const r = item.result || {};
  return {
    keyword: r.keyword || "",
    targetUrl: r.target_url || "",
    targetBusiness: r.target_url ? new URL(r.target_url.startsWith("http") ? r.target_url : `https://${r.target_url}`).hostname.replace("www.", "") : "",
    target_url: r.target_url || "",
    target_business: r.target_url ? new URL(r.target_url.startsWith("http") ? r.target_url : `https://${r.target_url}`).hostname.replace("www.", "") : "",
    wildcard: r.wildcard || false,
    searchEngine: r.search_engine || "google.com",
    device: r.device || "desktop",
    location: r.location || {},
    journeyType: "organic",
    journey_type: "organic",
  };
}

// ── Job Processor ───────────────────────────────────────
async function processJob(job) {
  const jobId = job.id;
  // Map queue_item fields to params format that journeys expect
  if (!job.params) {
    job.params = mapQueueItemToParams(job);
  }
  const { journey, type } = getJourney(job);
  const timeoutMs = job.params?.timeoutMs || JOB_TIMEOUT_MS;
  console.log(`\n🦑 Processing job ${jobId} — [${type}] ${job.params?.keyword || "no keyword"} (timeout: ${timeoutMs / 1000}s)`);

  await supabase
    .from("queue_items")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);

  let result;
  try {
    // Wrap the entire journey execution in a timeout
    result = await withTimeout(async function runWithRetries() {
      // Retry up to 5 times with fresh profiles on CAPTCHA
      let res;
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (attempt > 1) console.log(`  🔄 Retry #${attempt} with fresh GoLogin profile + IP...`);
        res = await journey.run(job);
        if (!res.captcha) break;
        await new Promise((r) => setTimeout(r, rand(2000, 5000)));
      }
      return res;
    }(), timeoutMs, jobId);
  } catch (err) {
    // Timeout or unexpected crash — mark as failed
    console.error(`  ⏰ Job ${jobId} timed out or crashed: ${err.message}`);
    result = {
      success: false,
      found: false,
      error: err.message,
      journeyType: type,
      steps: [],
      duration_ms: timeoutMs,
    };
  }

  // Save result — ALWAYS runs, even after timeout
  try {
    await supabase
      .from("queue_items")
      .update({
        status: result.success ? "completed" : "failed",
        completed_at: new Date().toISOString(),
        result,
        error: result.error || null,
      })
      .eq("id", jobId);

    // Save execution logs
    if (result.steps && result.steps.length > 0) {
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
    }
  } catch (dbErr) {
    console.error(`  ❌ Failed to save result for job ${jobId}:`, dbErr.message);
  }

  console.log(
    `  ${result.success ? "✅" : "❌"} Job ${jobId} [${type}] ${result.success ? "completed" : "failed"} — ${result.found ? `FOUND (rank #${result.clickedRank})` : "not found"} (${(result.duration_ms / 1000).toFixed(1)}s)`
  );
}

// ── Poll Loop ───────────────────────────────────────────
async function poll() {
  if (activeJobs >= MAX_CONCURRENT) return;

  const { data: jobs, error } = await supabase
    .from("queue_items")
    .select("*")
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("scheduled_for", { ascending: true })
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
  const journeyList = Object.keys(JOURNEYS).join(", ");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   🦑 NirvanaTraffic Worker v3.1          ║");
  console.log("║   🎭 GoLogin Fingerprinting               ║");
  console.log("║   🌐 Decodo Residential + Mobile Proxies  ║");
  console.log("║   📦 Journeys: " + journeyList.padEnd(25) + " ║");
  console.log("║   Polling every " + (POLL_INTERVAL / 1000) + "s                   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Validate GoLogin token
  if (!CONFIG.GOLOGIN_TOKEN) {
    console.error("❌ GOLOGIN_TOKEN not set in .env");
    process.exit(1);
  }
  try {
    const glUser = await axios.get(`${GL_API}/user`, { headers: GL_HEADERS() });
    console.log(`✅ GoLogin: ${glUser.data.email} (${glUser.data.plan?.name || "unknown"} plan)`);
  } catch (err) {
    console.error("❌ GoLogin token invalid:", err.message);
    process.exit(1);
  }

  // Test Supabase connection
  const { count, error } = await supabase.from("queue_items").select("*", { count: "exact", head: true });
  if (error) {
    console.error("❌ Cannot connect to Supabase:", error.message);
    process.exit(1);
  }
  console.log(`✅ Connected to Supabase — ${count} total jobs in queue`);
  console.log(`✅ Loaded ${Object.keys(JOURNEYS).length} journey types: ${journeyList}`);
  console.log("👀 Watching for queued jobs...\n");

  setInterval(poll, POLL_INTERVAL);
  poll();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
