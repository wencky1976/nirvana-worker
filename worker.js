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
const { CONFIG, GL_API, GL_HEADERS, rand, cleanupOrphanProfiles } = require("./lib/shared");

// ── Journey Modules ─────────────────────────────────────
const JOURNEYS = {
  squidoosh: require("./journeys/squidoosh"),
  organic: require("./journeys/organic"),
  tiered: require("./journeys/tiered"),
  "thanos-local": require("./journeys/thanos-local"),
  "thanos-ecom": require("./journeys/thanos-ecom"),
  birthday: require("./journeys/birthday"),
  "squidoosh-local": require("./journeys/squidoosh-local"),
  "super-rocket": require("./journeys/super-rocket"),
  "pgs": require("./journeys/pgs"),
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
let jobsCompleted = 0;
let jobsFailed = 0;
let currentJobId = null;
const workerStartTime = Date.now();
const WORKER_ID = process.env.WORKER_ID || `worker-${require("os").hostname()}`;
const WORKER_VERSION = "3.5";
const HEARTBEAT_INTERVAL = 60000; // 60s

// ── Worker Heartbeat ────────────────────────────────────
async function sendHeartbeat() {
  try {
    const os = require("os");
    await supabase.from("worker_heartbeats").upsert({
      id: WORKER_ID,
      last_heartbeat: new Date().toISOString(),
      status: currentJobId ? "busy" : "idle",
      uptime_seconds: Math.floor((Date.now() - workerStartTime) / 1000),
      jobs_completed: jobsCompleted,
      jobs_failed: jobsFailed,
      current_job: currentJobId || null,
      version: WORKER_VERSION,
      system_info: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpus: os.cpus().length,
        memory_gb: Math.round(os.totalmem() / 1073741824 * 10) / 10,
        memory_free_gb: Math.round(os.freemem() / 1073741824 * 10) / 10,
        node: process.version,
      },
    }, { onConflict: "id" });
  } catch (e) {
    // Silent — don't crash worker if heartbeat fails
    console.log(`  ⚠️ Heartbeat failed: ${e.message}`);
  }
}

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
  const jType = r.journey_type || "organic";
  
  const base = {
    device: r.device || "desktop",
    mobile: r.device === "mobile",
    location: r.location || {},
    journeyType: jType,
    journey_type: jType,
  };
  
  if (jType === "birthday") {
    return {
      keyword: r.keyword || r.keywords || "",
      image_base64: r.image_base64 || "",
      target_destination: r.target_destination || "",
      wildcard: r.wildcard !== undefined ? r.wildcard : true,
      device: r.device || "desktop",
      country: r.country || "US",
      state: r.state || "",
      city: r.city || "",
      journey_type: "birthday",
    };
  }
  if (jType === "pgs") {
    return {
      ...base,
      keyword: r.keyword || r.business_name || "",
      business_name: r.business_name || "",
      address: r.address || r.business_address || "",
      latitude: r.latitude || 0,
      longitude: r.longitude || 0,
      target_url: r.target_url || r.website || "",
      website: r.website || r.target_url || "",
      wildcard: r.wildcard !== undefined ? r.wildcard : true,
      grid_size: r.grid_size || 7,
      spacing_miles: r.spacing_miles || 1,
      cid: r.cid || "",
    };
  }
  if (jType === "super-rocket") {
    return {
      ...base,
      keyword: r.keyword || r.business_name || "",
      business_name: r.business_name || "",
      latitude: r.latitude || 0,
      longitude: r.longitude || 0,
      target_url: r.target_url || r.website || "",
      website: r.website || r.target_url || "",
      wildcard: r.wildcard !== undefined ? r.wildcard : true,
      grid_size: r.grid_size || 7,
      spacing_miles: r.spacing_miles || 1,
      cid: r.cid || "",
    };
  }
  if (jType === "squidoosh-local") {
    return {
      ...base,
      keyword: r.keyword || r.business_name || "",
      business_name: r.business_name || "",
      latitude: r.latitude || 0,
      longitude: r.longitude || 0,
      target_url: r.target_url || r.website || "",
      website: r.website || r.target_url || "",
      wildcard: r.wildcard !== undefined ? r.wildcard : true,
      grid_size: r.grid_size || 7,
      spacing_miles: r.spacing_miles || 1,
      cid: r.cid || "",
    };
  }
  if (jType === "tiered" || jType === "thanos-local" || jType === "thanos-ecom") {
    return {
      ...base,
      tier1_url: r.tier1_url || r.target_url || "",
      tier1Url: r.tier1_url || r.target_url || "",
      target_destination: r.target_destination || "",
      targetDestination: r.target_destination || "",
    };
  }
  
  return {
    ...base,
    keyword: r.keyword || "",
    targetUrl: r.target_url || "",
    targetBusiness: (() => { try { return r.target_url ? new URL(r.target_url.startsWith("http") ? r.target_url : `https://${r.target_url}`).hostname.replace("www.", "") : ""; } catch { return ""; } })(),
    target_url: r.target_url || "",
    target_business: (() => { try { return r.target_url ? new URL(r.target_url.startsWith("http") ? r.target_url : `https://${r.target_url}`).hostname.replace("www.", "") : ""; } catch { return ""; } })(),
    wildcard: r.wildcard || false,
    searchEngine: r.search_engine || "google.com",
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
  currentJobId = jobId;
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
  // Merge original config (keyword, target_url, etc.) into result so it's preserved
  const originalConfig = job.result || {};
  const mergedResult = {
    ...result,
    // Preserve original config so Restart works
    keyword: originalConfig.keyword || job.params?.keyword || result.keyword,
    target_url: originalConfig.target_url || job.params?.target_url || result.target_url,
    wildcard: originalConfig.wildcard,
    search_engine: originalConfig.search_engine || job.params?.searchEngine,
    device: originalConfig.device || job.params?.device,
    location: originalConfig.location || job.params?.location,
    // Tiered fields
    tier1_url: originalConfig.tier1_url || job.params?.tier1_url || result.tier1_url,
    target_destination: originalConfig.target_destination || job.params?.target_destination || result.target_destination,
    journey_type: originalConfig.journey_type || result.journeyType || type,
    // Squidoosh / Super Rocket fields
    cid: originalConfig.cid || job.params?.cid || result.cid,
    business_name: originalConfig.business_name || job.params?.business_name || result.business_name,
    latitude: originalConfig.latitude || job.params?.latitude || result.latitude,
    longitude: originalConfig.longitude || job.params?.longitude || result.longitude,
    website: originalConfig.website || job.params?.website || result.website,
    grid_size: originalConfig.grid_size || job.params?.grid_size || result.grid_size,
    spacing_miles: originalConfig.spacing_miles || job.params?.spacing_miles || result.spacing_miles,
    address: originalConfig.address || job.params?.address || result.address,
  };
  try {
    await supabase
      .from("queue_items")
      .update({
        status: result.success ? "completed" : "failed",
        completed_at: new Date().toISOString(),
        result: mergedResult,
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

  if (result.success) jobsCompleted++; else jobsFailed++;
  currentJobId = null;

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
    .lte("scheduled_for", new Date().toISOString())
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
  console.log("║   🦑 NirvanaTraffic Worker v3.3          ║");
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

  // Clean up any orphan GoLogin profiles from previous crashed runs
  await cleanupOrphanProfiles();

  // Reset stuck jobs — anything "running" for >10 min is dead
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stuckJobs } = await supabase
    .from("queue_items")
    .update({ status: "failed", completed_at: new Date().toISOString(), result: { error: "Stuck job — running >10 min, reset by worker" } })
    .eq("status", "running")
    .lt("started_at", tenMinAgo)
    .select("id");
  if (stuckJobs?.length) console.log(`🧹 Reset ${stuckJobs.length} stuck jobs (running >10 min)`);

  // Start heartbeat
  await sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  console.log(`💓 Heartbeat active (every ${HEARTBEAT_INTERVAL / 1000}s as "${WORKER_ID}")`);

  console.log("👀 Watching for queued jobs...\n");

  setInterval(poll, POLL_INTERVAL);
  poll();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
