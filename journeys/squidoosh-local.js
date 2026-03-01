/**
 * Squidoosh Local Journey — GBP Knowledge Panel Engagement
 * 
 * Flow:
 * 1. Pick random coordinate from 7×7 grid around business
 * 2. Spoof browser geolocation via CDP
 * 3. Load Google → click "Use precise location"
 * 4. Search branded keyword (triggers Knowledge Panel)
 * 5. Interact with KP (website, directions, reviews, photos)
 * 6. Click through to website → dwell
 */

const { rand, createLogger, setupBrowserSession, dwell, cleanup, humanScroll, humanMouseMove, humanIdle, generatePersonality, logPersonality, searchGoogle, handleCaptcha } = require("../lib/shared");

// ── Grid Generation ─────────────────────────────────────
function generateGrid(centerLat, centerLng, gridSize = 7, spacingMiles = 1) {
  const points = [];
  const half = Math.floor(gridSize / 2);
  const mileInLat = 1 / 69.0;
  const mileInLng = 1 / (69.0 * Math.cos(centerLat * Math.PI / 180));
  
  for (let row = -half; row <= half; row++) {
    for (let col = -half; col <= half; col++) {
      points.push({
        lat: Math.round((centerLat + row * spacingMiles * mileInLat) * 1000000) / 1000000,
        lng: Math.round((centerLng + col * spacingMiles * mileInLng) * 1000000) / 1000000,
        row: row + half,
        col: col + half,
      });
    }
  }
  return points;
}

// ── Knowledge Panel Interaction (FIXED) ─────────────────
async function interactWithKnowledgePanel(page, log, personality) {
  const interactions = [];
  
  const kpSelectors = [
    '[data-attrid="title"]', '.kp-wholepage', '.knowledge-panel',
    '[data-ly]', '.liYKde', '#rhs .kp-wholepage', '.xpdopen',
  ];
  
  let kpFound = false;
  for (const sel of kpSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        kpFound = true;
        log("kp_found", "Selector: " + sel);
        break;
      }
    } catch {}
  }
  
  if (!kpFound) {
    log("kp_not_found", "Scrolling to find KP...");
    await humanScroll(page, rand(300, 600));
    await page.waitForTimeout(rand(1000, 2000));
  }
  
  // Website link selectors — expanded for Google KP variations
  const websiteSelectors = [
    'a[data-dtype="d3ifr"]',
    'a[href*="url?q="]',                         // Google redirect link to website
    '[data-attrid="kc:/location/location:website"] a',
    '[data-attrid="visit_website"] a',
    'a.ab_button[data-pid="website"]',
    '.QqG1Sd a',
    'a:has-text("Website")',
    'a:has-text("website")',
    'a.n1obkb',                                   // KP action button
    '.IzNS7c a',                                  // KP website row
    '.fl a[href*="url?"]',                        // Fallback redirect link
  ];
  
  const possibleActions = [
    { name: "directions", selectors: ['a:has-text("Directions")', 'a:has-text("Get directions")'] },
    { name: "reviews", selectors: ['a:has-text("reviews")', 'a:has-text("Reviews")', '.hqzQac a'] },
    { name: "photos", selectors: ['a:has-text("Photos")', '.Xk2Sdb a'] },
    { name: "phone", selectors: ['a[data-dtype="d3ph"]', 'a[href^="tel:"]'] },
  ];
  
  // Extra interactions before website click (0-2 random)
  const numExtra = Math.random() < 0.6 ? 1 : Math.random() < 0.8 ? 0 : 2;
  const extras = possibleActions.sort(() => Math.random() - 0.5).slice(0, numExtra);
  
  for (const action of extras) {
    await page.waitForTimeout(rand(personality.wait[0], personality.wait[1]));
    
    for (const sel of action.selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          const box = await el.boundingBox();
          if (box) {
            await humanMouseMove(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
            await page.waitForTimeout(rand(300, 800));
            log("kp_" + action.name, "Interacting with " + action.name);
            if (action.name === "reviews") {
              await el.click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(rand(2000, 5000));
              await humanScroll(page, rand(200, 400));
              await page.goBack().catch(() => {});
              await page.waitForTimeout(rand(1000, 2000));
            } else {
              await page.waitForTimeout(rand(500, 1500));
            }
            interactions.push(action.name);
            break;
          }
        }
      } catch {}
    }
  }
  
  // Now try to click website — the main goal
  await page.waitForTimeout(rand(personality.wait[0], personality.wait[1]));
  
  for (const sel of websiteSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        const box = await el.boundingBox();
        if (box) {
          await humanMouseMove(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          await page.waitForTimeout(rand(300, 800));
          log("kp_website_click", "Clicking: " + sel);
          
          // Handle potential new tab or navigation
          const [newPage] = await Promise.all([
            page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null),
            el.click({ timeout: 5000 }),
          ]);
          
          if (newPage) {
            // Website opened in new tab — switch to it
            await newPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            log("kp_website_new_tab", newPage.url().slice(0, 100));
            interactions.push("website");
            return { interactions, websiteClicked: true, page: newPage };
          }
          
          // Check if current page navigated
          await page.waitForTimeout(rand(2000, 4000));
          const currentUrl = page.url();
          if (!currentUrl.includes("google.com")) {
            log("kp_website_navigated", currentUrl.slice(0, 100));
            interactions.push("website");
            return { interactions, websiteClicked: true, page: page };
          }
          
          // Page still on Google — click might have opened via JS redirect
          // Check for Google redirect URLs
          const href = await el.getAttribute("href").catch(() => "");
          if (href && href.includes("url?q=")) {
            const match = href.match(/[?&]q=([^&]+)/);
            if (match) {
              try {
                const targetUrl = decodeURIComponent(match[1]);
                if (targetUrl.startsWith("http")) {
                  log("kp_website_redirect", "Navigating to: " + targetUrl.slice(0, 80));
                  await page.goto(targetUrl, { timeout: 15000 }).catch(() => {});
              interactions.push("website");
                  return { interactions, websiteClicked: true, page: page };
                }
              } catch (urlErr) {
                log("kp_redirect_error", (urlErr.message || "").slice(0, 60));
              }
            }
          }
          
          log("kp_website_click_no_nav", "Clicked but page didn't navigate — trying next selector");
        }
      }
    } catch (e) {
      log("kp_website_error", sel + " — " + (e.message || "").slice(0, 80));
    }
  }
  
  // Last resort: find ANY link in the KP that goes to a non-Google domain
  try {
    const kpLinks = page.locator('.kp-wholepage a[href], [data-attrid] a[href], .liYKde a[href]');
    const count = await kpLinks.count();
    for (let i = 0; i < Math.min(count, 15); i++) {
      const link = kpLinks.nth(i);
      const href = await link.getAttribute("href").catch(() => "");
      if (href && !href.includes("google.com") && !href.includes("gstatic") && !href.startsWith("#") && !href.startsWith("/")) {
        const box = await link.boundingBox();
        if (box && await link.isVisible()) {
          await humanMouseMove(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          await page.waitForTimeout(rand(300, 600));
          log("kp_website_fallback", "Clicking external link: " + href.slice(0, 80));
          
          const [newPage] = await Promise.all([
            page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null),
            link.click({ timeout: 5000 }),
          ]);
          
          if (newPage) {
            await newPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            interactions.push("website");
            return { interactions, websiteClicked: true, page: newPage };
          }
          
          await page.waitForTimeout(rand(1500, 3000));
          if (!page.url().includes("google.com")) {
            interactions.push("website");
            return { interactions, websiteClicked: true, page: page };
          }
        }
      }
    }
  } catch {}
  
  return { interactions, websiteClicked: false };
}


// ── Precise Location Activation ─────────────────────────
async function activatePreciseLocation(page, log) {
  const selectors = [
    'a:has-text("Use precise location")',
    'a:has-text("Update location")',
    'button:has-text("Use precise location")',
    '#Mses6b',
  ];
  
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        log("location_prompt_found", sel);
        const box = await el.boundingBox();
        if (box) {
          await humanMouseMove(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          await page.waitForTimeout(rand(200, 500));
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(rand(2000, 4000));
          log("location_activated", "Precise location enabled");
          return true;
        }
      }
    } catch {}
  }
  
  log("location_prompt_not_found", "Geolocation override active via CDP");
  return false;
}

// ── Main Run ────────────────────────────────────────────
async function run(job) {
  const startTime = Date.now();
  const { steps, log } = createLogger(startTime);
  const params = job.params || {};
  
  const keyword = params.keyword || "";
  const businessName = params.business_name || "";
  const centerLat = parseFloat(params.latitude) || 0;
  const centerLng = parseFloat(params.longitude) || 0;
  const targetUrl = params.target_url || params.website || "";
  const wildcard = params.wildcard !== undefined ? params.wildcard : true;
  const gridSize = params.grid_size || 7;
  const spacingMiles = params.spacing_miles || 1;
  
  const searchTerm = keyword || businessName;
  if (!searchTerm) {
    return { success: false, found: false, steps, error: "No keyword or business name provided", journeyType: "squidoosh-local", duration_ms: Date.now() - startTime };
  }
  if (!centerLat || !centerLng) {
    return { success: false, found: false, steps, error: "No coordinates (latitude/longitude)", journeyType: "squidoosh-local", duration_ms: Date.now() - startTime };
  }
  
  // Generate grid and pick random point
  const grid = generateGrid(centerLat, centerLng, gridSize, spacingMiles);
  const gridPoint = grid[Math.floor(Math.random() * grid.length)];
  log("grid_generated", grid.length + " points (" + gridSize + "x" + gridSize + ", " + spacingMiles + "mi)");
  log("grid_point_selected", "(" + gridPoint.lat + ", " + gridPoint.lng + ") row:" + gridPoint.row + " col:" + gridPoint.col);
  
  let session;
  let personality;
  try {
    session = await setupBrowserSession(params, log);
    const { page, context, proxyConfig } = session;
    
    const isMobile = (params.device === "mobile");
    personality = generatePersonality(isMobile);
    logPersonality(personality, log);
    
    // STEP 1: Spoof geolocation via CDP
    log("geolocation_spoofing", "(" + gridPoint.lat + ", " + gridPoint.lng + ")");
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Emulation.setGeolocationOverride", {
      latitude: gridPoint.lat,
      longitude: gridPoint.lng,
      accuracy: rand(10, 50),
    });
    await context.grantPermissions(["geolocation"], { origin: "https://www.google.com" });
    
    // JS-level geolocation override — guarantees Google gets our coords
    await page.addInitScript((coords) => {
      const fakePos = {
        coords: {
          latitude: coords.lat, longitude: coords.lng, accuracy: 20,
          altitude: null, altitudeAccuracy: null, heading: null, speed: null
        },
        timestamp: Date.now()
      };
      navigator.geolocation.getCurrentPosition = (success) => success(fakePos);
      navigator.geolocation.watchPosition = (success) => { success(fakePos); return 0; };
    }, { lat: gridPoint.lat, lng: gridPoint.lng });
    
    log("geolocation_set", "CDP + JS override active");
    steps.push({ action: "geolocation_spoofed", lat: gridPoint.lat, lng: gridPoint.lng, time: Date.now() - startTime });

    // STEP 2: Search Google (shared human flow)
    log("searching", '"' + searchTerm + '"');
    await searchGoogle(page, context, searchTerm, proxyConfig, log);
    steps.push({ action: "searched", keyword: searchTerm, time: Date.now() - startTime });
    
    // Verify geolocation spoof on Google's page
    try {
      const geoResult = await page.evaluate(() => {
        return new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
            (err) => resolve({ error: err.message }),
            { timeout: 5000 }
          );
        });
      });
      if (geoResult.error) {
        log("geolocation_verify_FAIL", "Error: " + geoResult.error);
      } else {
        const latDiff = Math.abs(geoResult.lat - gridPoint.lat);
        const lngDiff = Math.abs(geoResult.lng - gridPoint.lng);
        const match = latDiff < 0.001 && lngDiff < 0.001;
        log("geolocation_verify", (match ? "✓ MATCH" : "✗ MISMATCH") + " — browser reports (" + geoResult.lat + ", " + geoResult.lng + ") accuracy:" + geoResult.accuracy + "m");
      }
    } catch (geoErr) {
      log("geolocation_verify_skip", (geoErr.message || "").slice(0, 60));
    }

    // STEP 3: Activate precise location
    await activatePreciseLocation(page, log);
    
    // STEP 4: Interact with Knowledge Panel
    log("scanning_kp", "Looking for Knowledge Panel...");
    await page.waitForTimeout(rand(2000, 4000));
    
    const kpResult = await interactWithKnowledgePanel(page, log, personality);
    const activePage = (kpResult && kpResult.page) || page;  // Use new tab if website opened there
    steps.push({ action: "kp_interaction", interactions: kpResult.interactions, time: Date.now() - startTime });
    
    if (kpResult.websiteClicked) {
      // STEP 5: Dwell on website
      await activePage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(rand(2000, 4000));
      
      const landedUrl = activePage.url();
      log("landed_on_website", landedUrl.slice(0, 100));
      steps.push({ action: "website_landed", url: landedUrl, time: Date.now() - startTime });
      
      let onTarget = true;
      if (targetUrl) {
        const norm = (u) => u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase();
        onTarget = wildcard
          ? norm(landedUrl).includes(norm(targetUrl).split("/")[0])
          : norm(landedUrl).startsWith(norm(targetUrl));
      }
      
      const dwellTime = rand(personality.dwell[0], personality.dwell[1]);
      await dwell(activePage, dwellTime, log, personality);
      
      return {
        success: true, found: true, click: true,
        kp_interactions: kpResult.interactions,
        grid_point: gridPoint,
        keyword: searchTerm,
        landed_url: landedUrl,
        on_target: onTarget,
        target_url: targetUrl,
        device: params.device || "desktop",
        journeyType: "squidoosh-local",
        engine: "google-kp",
        proxy: session.exitIp || "",
        user_agent: await activePage.evaluate(() => navigator.userAgent).catch(() => ""),
        fingerprint: session.fingerprint || null,
        personality: personality ? { traits: personality.traits, timeOfDay: personality.timeOfDay, device: personality.device } : null,
        steps, duration_ms: Date.now() - startTime,
      };
    } else {
      log("kp_no_website", "No website link — partial engagement (branded search + KP view)");
      return {
        success: true, found: true, click: false,
        kp_interactions: kpResult.interactions,
        grid_point: gridPoint,
        keyword: searchTerm,
        device: params.device || "desktop",
        journeyType: "squidoosh-local",
        engine: "google-kp",
        proxy: session.exitIp || "",
        user_agent: await page.evaluate(() => navigator.userAgent).catch(() => ""),
        fingerprint: session.fingerprint || null,
        steps, duration_ms: Date.now() - startTime,
      };
    }
    
  } catch (err) {
    const errDetail = (err.message || String(err)).slice(0, 300);
    log("error", errDetail);
    return {
      success: false, found: false, click: false,
      keyword: searchTerm,
      grid_point: gridPoint ? { lat: gridPoint.lat, lng: gridPoint.lng } : null,
      device: params.device || "desktop",
      journeyType: "squidoosh-local",
      engine: "google-kp",
      proxy: session?.exitIp || "",
      steps, error: errDetail, duration_ms: Date.now() - startTime,
    };
  } finally {
    if (session) {
      await cleanup(session.browser, session.glApi, session.profileId).catch(() => {});
    }
  }
}

module.exports = { run, generateGrid };
