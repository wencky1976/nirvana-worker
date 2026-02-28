/**
 * NirvanaTraffic — Tiered Journey
 * Direct visit to Tier 1 URL → find outbound link to target → click → dwell
 * Purpose: Warm up backlink pages by sending traffic through them to your site.
 */

const { rand, createLogger, setupBrowserSession, dwell, cleanup, humanScroll, humanMouseMove, humanIdle, generatePersonality, logPersonality } = require("../lib/shared");

// ── Find and click a link to the target destination on the current page ──
async function findAndClickTarget(page, targetDomain, log, personality, wildcard = false) {
  // Normalize target
  const target = targetDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  
  log("scanning_for_target", `Looking for links to: ${target}`);
  
  // Scroll through the page naturally while looking for the link
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  let scrolled = 0;
  const maxScroll = 8000; // Don't scroll forever
  let attempts = 0;
  
  while (scrolled < maxScroll && attempts < 15) {
    attempts++;
    
    // Check for matching links in current viewport
    const links = await page.evaluate((targetStr) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .filter(a => {
          const href = a.href.toLowerCase();
          return href.includes(targetStr) && a.offsetParent !== null; // visible only
        })
        .map(a => {
          const rect = a.getBoundingClientRect();
          return {
            href: a.href,
            text: (a.textContent || '').trim().slice(0, 100),
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
            visible: rect.top >= 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0,
          };
        });
    }, { targetStr: target, isWildcard: wildcard });
    
    // Find first visible link
    const visibleLink = links.find(l => l.visible);
    
    if (visibleLink) {
      log("target_found", `"${visibleLink.text}" → ${visibleLink.href}`);
      
      // Brief hesitation before clicking (reading/deciding)
      const hesitation = personality ? rand(personality.clickDelay[0], personality.clickDelay[1]) : rand(500, 2000);
      await page.waitForTimeout(hesitation);
      
      // Move mouse to link naturally (Bézier path)
      await humanMouseMove(page, visibleLink.x, visibleLink.y);
      await page.waitForTimeout(rand(100, 400));
      
      // Click
      await page.mouse.click(visibleLink.x, visibleLink.y);
      log("target_clicked", visibleLink.href);
      
      // Wait for navigation
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(rand(1000, 2000));
      
      return { found: true, href: visibleLink.href, text: visibleLink.text };
    }
    
    // Not found yet — scroll down and look again
    const scrollAmount = rand(300, 600);
    await humanScroll(page, scrollAmount, log);
    scrolled += scrollAmount;
    
    // Reading pause between scrolls
    const readTime = personality ? rand(personality.wait[0], personality.wait[1]) : rand(1500, 3500);
    await page.waitForTimeout(readTime);
  }
  
  log("target_not_found", `No link to "${target}" found after ${scrolled}px of scrolling`);
  return { found: false };
}

// ── Main Journey ────────────────────────────────────────
async function run(job) {
  const params = job.params || job;
  const startTime = Date.now();
  const { steps, log } = createLogger(startTime);

  
  const tier1Url = params.tier1_url || params.tier1Url || params.target_url || "";
  const targetDestination = params.target_destination || params.targetDestination || "";
  
  if (!tier1Url) {
    log("error", "No Tier 1 URL provided");
    return { success: false, error: "No Tier 1 URL", journeyType: "tiered", duration_ms: 0 };
  }
  
  const fullTier1Url = tier1Url.startsWith("http") ? tier1Url : `https://${tier1Url}`;
  
  let session;
  let personality;
  try {
    // Setup browser
    session = await setupBrowserSession({ ...params, skipGoogle: true }, log);
    const { page } = session;
    
    // Generate personality
    const isMobile = (params.device === 'mobile');
    personality = generatePersonality(isMobile);
    logPersonality(personality, log);
    
    // Step 1: Navigate directly to Tier 1 URL
    log("navigating_tier1", fullTier1Url);
    steps.push({ action: "navigate_tier1", url: fullTier1Url, time: Date.now() - startTime });
    
    await page.goto(fullTier1Url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(rand(1500, 3000));
    
    log("tier1_loaded", `Page loaded: ${await page.title()}`);
    steps.push({ action: "tier1_loaded", time: Date.now() - startTime });
    
    // Step 2: Dwell on Tier 1 page (read, scroll — looks natural)
    const tier1DwellMs = personality ? rand(personality.dwell[0] * 0.6, personality.dwell[1] * 0.8) : rand(15000, 40000);
    log("tier1_dwell", `Dwelling ${Math.round(tier1DwellMs / 1000)}s on Tier 1`);
    await dwell(page, tier1DwellMs, log, personality);
    steps.push({ action: "tier1_dwell", duration_s: Math.round(tier1DwellMs / 1000), time: Date.now() - startTime });
    
    // Step 3: Find and click target destination link (if provided)
    let targetResult = { found: false };
    if (targetDestination) {
      targetResult = await findAndClickTarget(page, targetDestination, log, personality, params.wildcard || false);
      steps.push({ action: targetResult.found ? "target_clicked" : "target_not_found", target: targetDestination, time: Date.now() - startTime });
      
      // Step 4: Dwell on target site
      if (targetResult.found) {
        const targetDwellMs = personality ? rand(personality.dwell[0], personality.dwell[1]) : rand(20000, 60000);
        log("target_dwell", `Dwelling ${Math.round(targetDwellMs / 1000)}s on target`);
        await dwell(page, targetDwellMs, log, personality);
        steps.push({ action: "target_dwell", duration_s: Math.round(targetDwellMs / 1000), time: Date.now() - startTime });
      }
    } else {
      // No target destination — just dwell on Tier 1 (simple page visit)
      log("no_target", "No target destination — Tier 1 visit only");
    }
    
    const durationMs = Date.now() - startTime;
    
    return {
      success: true,
      found: targetResult.found,
      click: targetResult.found,
      tier1_url: fullTier1Url,
      target_destination: targetDestination,
      target_href: targetResult.href || null,
      time_on_site: Math.round(durationMs / 1000),
      proxy: session?.exitIp || "",
      user_agent: session ? await page.evaluate(() => navigator.userAgent).catch(() => "") : "",
      device: params.device || "desktop",
      engine: "direct",
      journeyType: "tiered",
      fingerprint: session?.fingerprint || null,
      personality: personality ? { traits: personality.traits, timeOfDay: personality.timeOfDay, device: personality.device } : null,
      steps,
      duration_ms: durationMs,
    };
    
  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    log("error", errDetail);
    return {
      success: false, found: false, click: false,
      tier1_url: fullTier1Url, target_destination: targetDestination,
      time_on_site: 0, proxy: "", user_agent: "",
      device: params.device || "desktop", engine: "direct",
      journeyType: "tiered", fingerprint: session?.fingerprint || null,
      personality: personality ? { traits: personality.traits, timeOfDay: personality.timeOfDay, device: personality.device } : null,
      steps, error: errDetail, duration_ms: Date.now() - startTime,
    };
  } finally {
    if (session) await cleanup(session.browser, session.glApi, session.profileId);
  }
}

module.exports = { run };
