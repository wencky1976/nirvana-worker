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
  // Get all h3 links in search results (desktop + mobile selectors)
  // Mobile Google uses different containers — not always #search or #rso
  let h3s = page.locator("#search a h3, #rso a h3");
  let count = await h3s.count();
  
  // If no results with standard selectors, try broader mobile selectors
  if (count === 0) {
    // Mobile: h3 inside any link on the results page
    h3s = page.locator('a h3, [data-sokoban-container] a h3, .mnr-c a h3, .kCrYT a h3, div[data-async-context] a h3');
    count = await h3s.count();
    if (count > 0) {
      log("mobile_results_detected", `found ${count} results via mobile selectors`);
    }
  }
  
  // Last resort: find all links with visible text that look like search results
  if (count === 0) {
    h3s = page.locator('a[href]:not([href^="/search"]):not([href*="google.com"]) h3, a[data-ved] h3, div.g a h3, a[ping] h3');
    count = await h3s.count();
    if (count > 0) {
      log("fallback_results_detected", `found ${count} results via fallback selectors`);
    }
  }

  log("organic_scan", `page ${currentPage}: ${count} results found`);

  for (let i = 0; i < count; i++) {
    const h3 = h3s.nth(i);
    const link = h3.locator("xpath=ancestor::a");
    const href = (await link.getAttribute("href").catch(() => "")) || "";

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

    const txt = (await h3.textContent()) || "";
    const score = scoreMatch(txt, href, targetBusiness, targetUrl);

    if (score >= 50) {
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
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, rand(1500, 3000));
    await page.waitForTimeout(rand(500, 1000));
  }
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
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(rand(500, 1500));
        await btn.click();
        // Mobile loads inline — wait for new results to appear
        await page.waitForTimeout(rand(2000, 4000));
        try {
          await page.waitForSelector("#search a h3, #rso a h3", { timeout: 10000 });
        } catch { /* results may already be there */ }
        log("page_navigated", `now on page ${currentPage + 1} (mobile inline)`);
        await page.waitForTimeout(rand(1500, 3000));
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
        return {
          success: true,
          found: true,
          clickedRank: result.globalRank,
          clickedPage: result.page,
          clickedPosition: result.rank,
          pagesScanned: currentPage,
          journeyType: "organic",
          steps,
          duration_ms: Date.now() - startTime,
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
    return {
      success: true,
      found: false,
      clickedRank: 0,
      pagesScanned: maxPages,
      journeyType: "organic",
      steps,
      duration_ms: Date.now() - startTime,
    };

  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    log("error", errDetail);
    return { success: false, found: false, steps, error: errDetail, journeyType: "organic", duration_ms: Date.now() - startTime };
  } finally {
    if (session) await cleanup(session.browser, session.glApi, session.profileId);
  }
}

module.exports = { run };
