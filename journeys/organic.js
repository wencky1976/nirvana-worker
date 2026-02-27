/**
 * Organic Journey — Pure Organic Click, Pages 1-5
 * 
 * Google search → SKIP Maps pack → SKIP ads → scan organic only
 * → if not found, paginate through pages 1-5 → click target → dwell
 * 
 * This journey simulates a user who scrolls past ads and Maps
 * and only clicks organic blue links, even going to page 2, 3, 4, 5.
 */

const { rand, scoreMatch, createLogger, setupBrowserSession, searchGoogle, dwell, cleanup, handleCaptcha, humanScroll, humanMouseMove, humanIdle } = require("../lib/shared");

const MAX_PAGES = 5;

/**
 * Check if a link is an ad/sponsored result
 */
function isAdSelector() {
  // Google ads have these markers
  return [
    '[data-text-ad]',
    '[data-rw]',
    '.commercial-unit-desktop-top',
    '.commercial-unit-desktop-bottom',
    '.ads-ad',
    '#tads',           // top ads container
    '#bottomads',      // bottom ads container
  ].join(', ');
}

/**
 * Scan organic-only results on current page, skipping ads and Maps
 */
async function scanOrganicResults(page, targetBusiness, targetUrl, log, currentPage) {
  // === STRATEGY 1: Desktop h3-based selectors ===
  let results = [];
  const h3s = page.locator("#search a h3, #rso a h3, a h3");
  const h3Count = await h3s.count();
  
  if (h3Count > 0) {
    log("desktop_results", `${h3Count} h3-based results found`);
    for (let i = 0; i < h3Count; i++) {
      const h3 = h3s.nth(i);
      const link = h3.locator("xpath=ancestor::a");
      const href = (await link.getAttribute("href").catch(() => "")) || "";
      const txt = (await h3.textContent().catch(() => "")) || "";
      if (href && !href.startsWith("/search") && !href.includes("google.com/search") && txt.trim().length > 2) {
        results.push({ link, href, txt });
      }
    }
  }

  // === STRATEGY 2: JavaScript DOM scan — bypass Playwright selector issues ===
  // Use page.evaluate to get ALL anchor hrefs directly from the DOM
  if (results.length === 0) {
    log("trying_js_scan", "No h3 results — JS DOM scan for all links");
    
    // Get all link data from the page via JavaScript
    const linkData = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a');
      const data = [];
      for (const a of anchors) {
        let href = a.href || a.getAttribute('href') || '';
        // Handle /url?q= redirects
        if (href.includes('/url?')) {
          try {
            const u = new URL(href);
            const q = u.searchParams.get('q') || u.searchParams.get('url');
            if (q && q.startsWith('http')) href = q;
          } catch {}
        }
        const txt = (a.textContent || '').trim();
        const rect = a.getBoundingClientRect();
        if (href && txt.length > 2 && rect.height > 0) {
          data.push({ href, txt: txt.slice(0, 200), index: data.length, y: rect.y });
        }
      }
      return data;
    });
    
    // Filter to external links only
    const externalLinks = linkData.filter(d => {
      const h = d.href.toLowerCase();
      return h.startsWith('http') && 
        !h.includes('google.com') && !h.includes('gstatic') && 
        !h.includes('googleapis') && !h.includes('googleadservices') &&
        !h.includes('accounts.google') && !h.includes('webcache');
    });
    
    log("js_scan_results", `${externalLinks.length} external links found (from ${linkData.length} total)`);
    
    // Log ALL external links so we can debug
    for (let i = 0; i < Math.min(externalLinks.length, 20); i++) {
      const d = externalLinks[i];
      const domain = d.href.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      log("link_dump", `[${i}] ${domain} → "${d.txt.slice(0, 50)}" (y=${Math.round(d.y)})`);
    }
    
    // Now match each with a Playwright locator for clicking
    for (const d of externalLinks) {
      // Find the clickable element using the href
      const escapedHref = d.href.replace(/"/g, '\\"');
      let link;
      try {
        // Try exact href match first
        link = page.locator(`a[href="${escapedHref}"]`).first();
        if (await link.count() === 0) {
          // Try partial href match (Google might modify the URL)
          const domain = d.href.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
          link = page.locator(`a[href*="${domain}"]`).first();
        }
      } catch {
        continue;
      }
      results.push({ link, href: d.href, txt: d.txt });
    }
    
    if (results.length > 0) {
      log("mobile_results_detected", `${results.length} clickable external links mapped`);
    }
  }

  const count = results.length;
  log("organic_scan", `page ${currentPage}: ${count} results found`);

  for (let i = 0; i < count; i++) {
    const { link, href, txt } = results[i];
    // (href already extracted above)

    // Skip if it's an ad
    try {
      const isAd = await link.evaluate((el) => {
        // Walk up the DOM to check if this link is inside an ad container
        let node = el;
        for (let depth = 0; depth < 10 && node; depth++) {
          if (node.id === "tads" || node.id === "bottomads") return true;
          if (node.getAttribute && node.getAttribute("data-text-ad") !== null) return true;
          if (node.getAttribute && node.getAttribute("data-rw") !== null) return true;
          if (node.classList && (node.classList.contains("ads-ad") || node.classList.contains("commercial-unit-desktop-top"))) return true;
          node = node.parentElement;
        }
        return false;
      });
      if (isAd) {
        log("ad_skipped", `pos ${i + 1}: ad result`);
        continue;
      }
    } catch { /* proceed */ }

    // Skip Maps/Local Pack links
    try {
      const isMaps = await link.evaluate((el) => {
        let node = el;
        for (let depth = 0; depth < 10 && node; depth++) {
          if (node.getAttribute && node.getAttribute("data-local-attribute")) return true;
          if (node.classList && (node.classList.contains("VkpGBb") || node.classList.contains("rllt__details"))) return true;
          if (node.getAttribute && node.getAttribute("data-cid") !== null) return true;
          node = node.parentElement;
        }
        return false;
      });
      if (isMaps) {
        log("maps_skipped", `pos ${i + 1}: local pack result`);
        continue;
      }
    } catch { /* proceed */ }

    // Skip Google internal links (images, videos, news carousels)
    if (href.startsWith("/search") || href.startsWith("https://www.google.com/search") || href.includes("google.com/maps")) {
      continue;
    }

    const score = scoreMatch(txt, href, targetBusiness, targetUrl);
    
    // Direct domain match — if the target URL/domain appears in href, that's our target
    const targetDomain = (targetUrl || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const hrefDomain = href.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const domainMatch = targetDomain && (hrefDomain === targetDomain || hrefDomain.endsWith("." + targetDomain) || href.toLowerCase().includes(targetDomain));
    
    // Debug: log first 10 results so we can see what's being scanned
    if (i < 10) {
      log("result_debug", `[${i}] score=${score} domain=${domainMatch} href="${href.slice(0, 80)}" txt="${txt.slice(0, 60)}"`);
    }

    if (score >= 50 || domainMatch) {
      // Scroll to it naturally
      await link.scrollIntoViewIfNeeded();
      await page.waitForTimeout(rand(800, 2000));
      
      // Human behavior: move mouse toward the result, hover, read snippet
      const box = await link.boundingBox().catch(() => null);
      if (box) {
        await humanMouseMove(page, box.x + rand(10, Math.min(200, box.width)), box.y + rand(2, 15));
        await page.waitForTimeout(rand(600, 1800)); // Reading the snippet
      }
      
      // Sometimes hover over the URL first (humans check the domain)
      if (Math.random() < 0.4) {
        await page.waitForTimeout(rand(400, 1000));
      }
      
      await link.click();
      log("organic_target_clicked", `page ${currentPage}, pos ${i + 1} (score:${score}): ${txt.slice(0, 100)}`);
      return { found: true, rank: i + 1, page: currentPage, globalRank: (currentPage - 1) * 10 + i + 1 };
    }
  }

  return { found: false };
}

/**
 * Navigate to next Google results page
 */
async function goToNextPage(page, currentPage, log) {
  // Scroll ALL the way down to reveal pagination / "More results" button
  // Use humanScroll which auto-detects mobile vs desktop
  await humanScroll(page, rand(3000, 5000));
  await page.waitForTimeout(rand(1000, 2000));

  // === MOBILE FIRST: "More results" / "More search results" button ===
  // Mobile Google loads results inline via a button instead of page links
  const mobileSelectors = [
    'a:has-text("More results")',                      // Most common mobile button
    'a:has-text("More search results")',               // Alternative text
    'div[role="button"]:has-text("More results")',     // Button variant
    'span:has-text("More results")',                   // Span variant
    'a[aria-label="More results"]',                    // Aria label
    'a[aria-label="More search results"]',             // Aria alt
    'div.YMIyqf a',                                    // Mobile "More results" container
    '#ofr a',                                          // Omitted results footer
  ];

  for (const selector of mobileSelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        const btnText = (await btn.textContent().catch(() => "")) || "";
        log("mobile_pagination_found", `"${btnText.trim().slice(0, 50)}" via ${selector}`);
        
        // Count existing links BEFORE clicking so we can detect new ones
        const linkCountBefore = await page.evaluate(() => document.querySelectorAll('a').length);
        const scrollBefore = await page.evaluate(() => document.body.scrollHeight);
        
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(rand(500, 1500));
        
        // Try multiple click methods — mobile Google buttons are finicky
        let clicked = false;
        
        // Method 1: Touch tap (most realistic for mobile)
        try {
          const box = await btn.boundingBox();
          if (box) {
            const tapX = box.x + box.width / 2;
            const tapY = box.y + box.height / 2;
            await page.touchscreen.tap(tapX, tapY);
            log("pagination_tap", `touch tap at (${Math.round(tapX)}, ${Math.round(tapY)})`);
            clicked = true;
          }
        } catch (tapErr) {
          log("pagination_tap_failed", tapErr.message.slice(0, 80));
        }
        
        // Method 2: JavaScript click (if touch tap didn't work)
        if (!clicked) {
          try {
            await btn.evaluate(el => el.click());
            log("pagination_js_click", "used JavaScript click");
            clicked = true;
          } catch {
            // Method 3: Regular Playwright click
            await btn.click();
            log("pagination_pw_click", "used Playwright click");
          }
        }
        
        // Wait for new content to load — check both link count AND scroll height
        let waited = 0;
        const maxWait = 15000;
        while (waited < maxWait) {
          await page.waitForTimeout(1000);
          waited += 1000;
          const linkCountAfter = await page.evaluate(() => document.querySelectorAll('a').length);
          const scrollAfter = await page.evaluate(() => document.body.scrollHeight);
          if (linkCountAfter > linkCountBefore || scrollAfter > scrollBefore + 200) {
            log("page_navigated", `page ${currentPage + 1} loaded (links: ${linkCountBefore}→${linkCountAfter}, height: ${scrollBefore}→${scrollAfter})`);
            break;
          }
        }
        if (waited >= maxWait) {
          log("pagination_load_slow", `clicked but no new content after ${maxWait/1000}s`);
          // Don't return false — still try scanning what we have
        }
        await page.waitForTimeout(rand(2000, 4000));
        return true;
      }
    } catch { /* try next selector */ }
  }

  // === DESKTOP: Traditional pagination links ===
  const desktopSelectors = [
    `a[aria-label="Page ${currentPage + 1}"]`,         // Specific page number
    '#pnnext',                                          // "Next" link
    'a[id="pnnext"]',                                   // "Next" alt
    'a:has-text("Next")',                               // Text-based
    'a:has-text("Næste")',                              // Danish
    'td.navend a',                                      // Classic Google nav
    'a.fl[href*="start="]',                             // Fallback pagination links
  ];

  for (const selector of desktopSelectors) {
    try {
      const nextBtn = page.locator(selector).first();
      if (await nextBtn.isVisible({ timeout: 2000 })) {
        await nextBtn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(rand(500, 1500));
        await nextBtn.click();
        await page.waitForLoadState("domcontentloaded");
        await page.waitForSelector("#search, #rso, .g", { timeout: 15000 });
        log("page_navigated", `now on page ${currentPage + 1}`);
        await page.waitForTimeout(rand(1500, 3000));
        return true;
      }
    } catch { /* try next selector */ }
  }

  log("pagination_failed", `could not find page ${currentPage + 1} link (tried mobile + desktop selectors)`);
  return false;
}

async function run(job) {
  const startTime = Date.now();
  const { steps, log } = createLogger(startTime);
  const params = job.params || {};
  const keyword = params.keyword || "";
  const targetBusiness = params.targetBusiness || params.target_business || "";
  const targetUrl = params.targetUrl || params.target_url || "";
  const dwellTimeMs = params.dwellTimeMs || params.dwell_time_ms || rand(15000, 45000);
  const maxPages = params.maxPages || MAX_PAGES;

  let session;
  try {
    // Setup browser + navigate to Google + search
    session = await setupBrowserSession(params, log);
    const { page, context, proxyConfig } = session;
    await searchGoogle(page, context, keyword, proxyConfig, log);

    // Scan pages 1 through maxPages
    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      // Scroll through results naturally
      if (currentPage > 1) {
        // Light scroll on new page
        await page.mouse.wheel(0, rand(200, 400));
        await page.waitForTimeout(rand(800, 1500));
      }

      const result = await scanOrganicResults(page, targetBusiness, targetUrl, log, currentPage);

      if (result.found) {
        // Target found and clicked — dwell
        await dwell(page, dwellTimeMs, log);
        const durationMs = Date.now() - startTime;
        return {
          success: true,
          found: true,
          click: true,
          clickedRank: result.globalRank,
          clickedPage: result.page,
          clickedPosition: result.rank,
          position: result.globalRank,
          pagesScanned: currentPage,
          pages_visited: currentPage,
          time_on_site: Math.round(durationMs / 1000),
          proxy: session.exitIp || "",
          user_agent: await page.evaluate(() => navigator.userAgent).catch(() => ""),
          engine: "google.com",
          journeyType: "organic",
          steps,
          duration_ms: durationMs,
        };
      }

      // Not found on this page — try next
      if (currentPage < maxPages) {
        log("target_not_on_page", `page ${currentPage} — scrolling to next`);

        // Human behavior: scroll through rest of results, maybe read a snippet, then go to next page
        await humanScroll(page, rand(400, 800));
        await page.waitForTimeout(rand(1500, 3500)); // Looking at bottom of page
        
        // Sometimes move mouse around before clicking next (considering options)
        if (Math.random() < 0.5) {
          await humanIdle(page, 1000, 3000);
        }

        // Check for captcha before paginating
        const captchaOk = await handleCaptcha(page, context, proxyConfig, log);
        if (!captchaOk) {
          return { success: false, found: false, captcha: true, steps, error: "CAPTCHA during pagination", duration_ms: Date.now() - startTime };
        }

        const navigated = await goToNextPage(page, currentPage, log);
        if (!navigated) {
          log("pagination_stopped", `could not go past page ${currentPage}`);
          break;
        }
      }
    }

    // Target not found after all pages
    const pageTitle = await page.title();
    log("target_not_found", `"${targetBusiness}" not found in ${maxPages} pages of organic results. Title: "${pageTitle}"`);
    const durationMs = Date.now() - startTime;
    return {
      success: true,
      found: false,
      click: false,
      clickedRank: 0,
      position: 0,
      pagesScanned: maxPages,
      pages_visited: maxPages,
      time_on_site: Math.round(durationMs / 1000),
      proxy: session?.exitIp || "",
      user_agent: session ? await session.page.evaluate(() => navigator.userAgent).catch(() => "") : "",
      engine: "google.com",
      journeyType: "organic",
      steps,
      duration_ms: durationMs,
    };

  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    log("error", errDetail);
    return { success: false, found: false, click: false, position: 0, pages_visited: 0, time_on_site: 0, proxy: "", user_agent: "", engine: "google.com", steps, error: errDetail, journeyType: "organic", duration_ms: Date.now() - startTime };
  } finally {
    if (session) await cleanup(session.browser, session.glApi, session.profileId);
  }
}

module.exports = { run };
