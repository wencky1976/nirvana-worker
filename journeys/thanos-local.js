/**
 * NirvanaTraffic — Thanos Local Journey
 * Bitly → Google Lens results → AI Mode → find target → click → dwell
 * Purpose: Create image+keyword signals via Google Lens AI Overview
 */

const { rand, createLogger, setupBrowserSession, dwell, cleanup, humanScroll, humanMouseMove, humanIdle, generatePersonality, logPersonality } = require("../lib/shared");

// ── Find and click AI Mode tab on Google Lens results ──
async function clickAIMode(page, log) {
  log("looking_for_ai_mode", "Scanning for AI Mode tab...");
  
  // Wait for page to settle after redirect
  await page.waitForTimeout(rand(2000, 4000));
  
  // Try multiple selectors for AI Mode tab
  const aiModeSelectors = [
    'div[role="tab"]:has-text("AI Mode")',
    'a:has-text("AI Mode")',
    'div:has-text("AI Mode"):not(:has(div:has-text("AI Mode")))',
    '[data-tab="AI Mode"]',
    'button:has-text("AI Mode")',
  ];
  
  for (const selector of aiModeSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 })) {
        const box = await el.boundingBox();
        if (box) {
          await humanMouseMove(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          await page.waitForTimeout(rand(300, 800));
          await el.click({ timeout: 5000 });
          log("ai_mode_clicked", `via ${selector}`);
          
          // Wait for AI Overview to generate (can take 10-15s)
          await page.waitForTimeout(rand(10000, 16000));
          return true;
        }
      }
    } catch {}
  }
  
  // Fallback: try JS click on anything containing "AI Mode"
  try {
    const clicked = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      for (const el of elements) {
        if (el.textContent?.trim() === 'AI Mode' && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      log("ai_mode_clicked", "via JS fallback");
      await page.waitForTimeout(rand(10000, 16000));
      return true;
    }
  } catch {}
  
  log("ai_mode_not_found", "Could not find AI Mode tab — continuing without it");
  return false;
}

// ── Find and click target in AI Overview / results ──
async function findTargetInAI(page, targetDomain, log, personality, wildcard) {
  const normalize = (url) => url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const target = normalize(targetDomain);
  
  log("scanning_for_target", `Looking for links to: ${target}`);
  
  let scrolled = 0;
  const maxScroll = 5000;
  let attempts = 0;
  
  while (scrolled < maxScroll && attempts < 12) {
    attempts++;
    
    const links = await page.evaluate(({ targetStr, isWildcard }) => {
      const normalize = (url) => url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      const targetNorm = normalize(targetStr);
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .filter(a => {
          const hrefNorm = normalize(a.href);
          if (isWildcard) {
            return (hrefNorm.startsWith(targetNorm) || hrefNorm.startsWith(targetNorm + '/')) && a.offsetParent !== null;
          } else {
            return (hrefNorm === targetNorm || hrefNorm.startsWith(targetNorm + '/') || hrefNorm.includes(targetNorm)) && a.offsetParent !== null;
          }
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
    
    const visibleLink = links.find(l => l.visible);
    
    if (visibleLink) {
      log("target_found", `"${visibleLink.text}" → ${visibleLink.href}`);
      
      const hesitation = personality ? rand(personality.clickDelay[0], personality.clickDelay[1]) : rand(500, 2000);
      await page.waitForTimeout(hesitation);
      
      await humanMouseMove(page, visibleLink.x, visibleLink.y);
      await page.waitForTimeout(rand(100, 400));
      await page.mouse.click(visibleLink.x, visibleLink.y);
      log("target_clicked", visibleLink.href);
      
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(rand(1000, 2000));
      
      return { found: true, href: visibleLink.href, text: visibleLink.text };
    }
    
    const scrollAmount = rand(300, 500);
    await humanScroll(page, scrollAmount, log);
    scrolled += scrollAmount;
    
    const readTime = personality ? rand(personality.wait[0], personality.wait[1]) : rand(1500, 3500);
    await page.waitForTimeout(readTime);
  }
  
  log("target_not_found", `No link to "${target}" found in AI results`);
  return { found: false };
}

// ── Main Journey ────────────────────────────────────────
async function run(job) {
  const params = job.params || job;
  const startTime = Date.now();
  const { steps, log } = createLogger(startTime);
  
  const bitlyUrl = params.tier1_url || params.tier1Url || params.target_url || "";
  const targetDestination = params.target_destination || params.targetDestination || "";
  const wildcard = params.wildcard !== undefined ? params.wildcard : true; // Default wildcard ON for Thanos
  
  if (!bitlyUrl) {
    log("error", "No Bitly URL provided");
    return { success: false, error: "No Bitly URL", journeyType: "thanos-local", duration_ms: 0 };
  }
  
  const fullUrl = bitlyUrl.startsWith("http") ? bitlyUrl : `https://${bitlyUrl}`;
  
  let session;
  let personality;
  try {
    session = await setupBrowserSession({ ...params, skipGoogle: true }, log);
    const { page } = session;
    
    const isMobile = (params.device === 'mobile');
    personality = generatePersonality(isMobile);
    logPersonality(personality, log);
    
    // Step 1: Navigate to Bitly link (redirects to Google Lens)
    log("navigating_bitly", fullUrl);
    steps.push({ action: "navigate_bitly", url: fullUrl, time: Date.now() - startTime });
    
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(rand(2000, 3000));
    
    // Handle Bitly interstitial page (sometimes shows instead of auto-redirecting)
    const urlAfterNav = page.url();
    if (urlAfterNav.includes('bit.ly') || urlAfterNav.includes('bitly.com')) {
      log("bitly_interstitial", "Bitly landing page detected — clicking through...");
      
      // Try clicking common Bitly redirect elements
      const bitlySelectors = [
        'a[href*="google.com/search"]',
        'a[href*="lens.google"]', 
        'a.jsx-link',
        'a[data-testid="destination-link"]',
        'a.action-button',
        'a[href]:not([href*="bitly"])',
        'button:has-text("Continue")',
        'a:has-text("Continue")',
      ];
      
      let clicked = false;
      for (const sel of bitlySelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click({ timeout: 5000 });
            log("bitly_clicked_through", `via ${sel}`);
            clicked = true;
            break;
          }
        } catch {}
      }
      
      // Fallback: look for any external link on the page
      if (!clicked) {
        try {
          const extLink = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            const ext = links.find(a => !a.href.includes('bitly') && !a.href.includes('bit.ly') && a.href.startsWith('http'));
            if (ext) { ext.click(); return ext.href; }
            return null;
          });
          if (extLink) {
            log("bitly_clicked_through", `JS fallback → ${extLink.slice(0, 80)}`);
            clicked = true;
          }
        } catch {}
      }
      
      if (!clicked) {
        log("bitly_no_redirect", "Could not find redirect link — trying direct meta refresh...");
        // Some Bitly pages use meta refresh or JS redirect — just wait longer
      }
      
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(rand(3000, 5000));
    }
    
    // Wait for Lens page to fully render
    await page.waitForTimeout(rand(3000, 5000));
    
    const currentUrl = page.url();
    const pageTitle = await page.title();
    log("lens_loaded", `Redirected to: ${currentUrl.slice(0, 100)} | Title: ${pageTitle.slice(0, 60)}`);
    steps.push({ action: "lens_loaded", url: currentUrl.slice(0, 100), time: Date.now() - startTime });
    
    // Step 2: Dwell on Google Lens results (read, scroll)
    const lensDwellMs = rand(8000, 15000);
    log("lens_dwell", `Dwelling ${Math.round(lensDwellMs / 1000)}s on Lens results`);
    await humanScroll(page, rand(200, 400), log);
    await page.waitForTimeout(lensDwellMs);
    steps.push({ action: "lens_dwell", duration_s: Math.round(lensDwellMs / 1000), time: Date.now() - startTime });
    
    // Step 3: Click AI Mode tab
    const aiClicked = await clickAIMode(page, log);
    steps.push({ action: aiClicked ? "ai_mode_clicked" : "ai_mode_skipped", time: Date.now() - startTime });
    
    // Step 4: Dwell on AI Overview
    if (aiClicked) {
      const aiDwellMs = personality ? rand(personality.dwell[0] * 0.5, personality.dwell[1] * 0.7) : rand(8000, 20000);
      log("ai_dwell", `Dwelling ${Math.round(aiDwellMs / 1000)}s on AI Overview`);
      await dwell(page, aiDwellMs, log, personality);
      steps.push({ action: "ai_dwell", duration_s: Math.round(aiDwellMs / 1000), time: Date.now() - startTime });
    }
    
    // Step 5: Find and click target destination
    let targetResult = { found: false };
    if (targetDestination) {
      targetResult = await findTargetInAI(page, targetDestination, log, personality, wildcard);
      steps.push({ action: targetResult.found ? "target_clicked" : "target_not_found", target: targetDestination, time: Date.now() - startTime });
      
      // Step 6: Dwell on target site
      if (targetResult.found) {
        const targetDwellMs = personality ? rand(personality.dwell[0], personality.dwell[1]) : rand(20000, 60000);
        log("target_dwell", `Dwelling ${Math.round(targetDwellMs / 1000)}s on target`);
        await dwell(page, targetDwellMs, log, personality);
        steps.push({ action: "target_dwell", duration_s: Math.round(targetDwellMs / 1000), time: Date.now() - startTime });
      }
    }
    
    const durationMs = Date.now() - startTime;
    
    return {
      success: true,
      found: targetResult.found,
      click: targetResult.found,
      tier1_url: fullUrl,
      target_destination: targetDestination,
      target_href: targetResult.href || null,
      ai_mode: aiClicked,
      time_on_site: Math.round(durationMs / 1000),
      proxy: session?.exitIp || "",
      user_agent: session ? await page.evaluate(() => navigator.userAgent).catch(() => "") : "",
      device: params.device || "desktop",
      engine: "google-lens",
      journeyType: "thanos-local",
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
      tier1_url: fullUrl, target_destination: targetDestination,
      ai_mode: false, time_on_site: 0, proxy: "", user_agent: "",
      device: params.device || "desktop", engine: "google-lens",
      journeyType: "thanos-local", fingerprint: session?.fingerprint || null,
      personality: personality ? { traits: personality.traits, timeOfDay: personality.timeOfDay, device: personality.device } : null,
      steps, error: errDetail, duration_ms: Date.now() - startTime,
    };
  } finally {
    if (session) await cleanup(session.browser, session.glApi, session.profileId);
  }
}

module.exports = { run };
