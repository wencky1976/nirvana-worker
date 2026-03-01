/**
 * Super Rocket Journey — Direct Google Maps GBP engagement
 * Load http:// maps URL with CID → interact with business profile
 */

const { setupBrowserSession, generatePersonality, logPersonality, rand, humanMouseMove, humanScroll, humanIdle, cleanup } = require("../lib/shared");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Referral sources — randomly selected per run
const REFERRAL_SOURCES = [
  "https://www.facebook.com/",
  "https://l.instagram.com/",
  "https://t.co/",
  "https://www.tiktok.com/",
  "https://www.youtube.com/",
  "https://www.linkedin.com/",
  "https://www.reddit.com/",
  "https://www.pinterest.com/",
];

async function run(job) {
  const startTime = Date.now();
  const steps = [];
  const log = (action, details) => {
    const timestamp = Date.now() - startTime;
    steps.push({ action, details, timestamp, time: timestamp });
    console.log(`  [${(timestamp / 1000).toFixed(0)}s] ${action}: ${details || ""}`);
  };

  const params = job.params || {};
  let browser, context, page, proxyConfig, personality, session;
  const isMobile = (params.device === "mobile");

  try {
    // Parse grid config
    const centerLat = parseFloat(params.latitude) || 0;
    const centerLng = parseFloat(params.longitude) || 0;
    const gridSize = parseInt(params.grid_size) || 7;
    const spacingMiles = parseFloat(params.spacing_miles) || 1;
    const cid = params.cid || "";
    const businessName = params.business_name || "";
    const website = params.website || "";

    if (!cid) throw new Error("CID is required for Super Rocket journey");
    if (!centerLat || !centerLng) throw new Error("Latitude and longitude are required");

    // Generate grid (same as squidoosh-local)
    const latMile = 0.01449;
    const lngMile = 0.01671;
    const halfGrid = Math.floor(gridSize / 2);
    const grid = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        grid.push({
          lat: centerLat + (row - halfGrid) * spacingMiles * latMile,
          lng: centerLng + (col - halfGrid) * spacingMiles * lngMile,
          row, col
        });
      }
    }
    log("grid_generated", `${grid.length} points (${gridSize}x${gridSize}, ${spacingMiles}mi)`);

    const gridPoint = grid[Math.floor(Math.random() * grid.length)];
    log("grid_point_selected", `(${gridPoint.lat}, ${gridPoint.lng}) row:${gridPoint.row} col:${gridPoint.col}`);

    // Build the http:// maps URL
    const mapsUrl = `http://maps.google.com/maps?ll=${gridPoint.lat},${gridPoint.lng}&z=16&t=m&hl=en&gl=US&mapclient=embed&cid=${cid}`;
    log("maps_url_generated", mapsUrl);

    // Setup browser
    params.skipGoogle = true;
    session = await setupBrowserSession(params, log);
    browser = session.browser;
    context = session.context;
    page = session.page;
    proxyConfig = session.proxyConfig;

    personality = generatePersonality(isMobile);
    logPersonality(personality, log);

    // Triple geolocation spoof
    log("geolocation_spoofing", `(${gridPoint.lat}, ${gridPoint.lng})`);
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Emulation.setGeolocationOverride", {
      latitude: gridPoint.lat,
      longitude: gridPoint.lng,
      accuracy: rand(10, 50),
    });
    await context.grantPermissions(["geolocation"]).catch(() => {});

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

    // Set referral source
    const referrer = REFERRAL_SOURCES[Math.floor(Math.random() * REFERRAL_SOURCES.length)];
    await page.setExtraHTTPHeaders({ "Referer": referrer });
    log("referral_set", referrer);

    // Navigate to maps URL
    log("navigating_maps", mapsUrl.slice(0, 100));
    await page.goto(mapsUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(rand(3000, 5000));
    
    const finalUrl = page.url();
    log("maps_loaded", finalUrl.slice(0, 120));

    // Dismiss "Open the Google Maps app?" popup on mobile
    try {
      const keepWebBtn = await page.$('button:has-text("Keep using web"), a:has-text("Keep using web")');
      if (keepWebBtn) {
        await keepWebBtn.click();
        log("maps_popup_dismissed", "Clicked 'Keep using web'");
        await sleep(rand(1500, 3000));
      }
    } catch {}

    // Verify geolocation
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

    // Wait for Maps to fully render
    await sleep(rand(3000, 6000));

    // INTERACT WITH BUSINESS PROFILE
    const interactions = [];

    // On mobile, the business panel is a bottom sheet — swipe up to expand
    if (isMobile) {
      log("swiping_up", "Expanding bottom sheet panel");
      try {
        const viewport = page.viewportSize() || { width: 390, height: 844 };
        const startX = Math.floor(viewport.width / 2);
        const startY = Math.floor(viewport.height * 0.8);
        const endY = Math.floor(viewport.height * 0.2);
        
        // CDP touch swipe up
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: startX, y: startY }],
        });
        // Gradual swipe
        for (let y = startY; y > endY; y -= 30) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: startX, y }],
          });
          await sleep(15);
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        log("swiped_up", "Bottom sheet expanded");
        await sleep(rand(1500, 3000));
      } catch (swipeErr) {
        log("swipe_error", (swipeErr.message || "").slice(0, 60));
      }
    }

    // 1. Look for the business name/title
    const titleEl = await page.$('.DUwDvf, .qBF1Pd, h1.fontHeadlineLarge, [role="main"] h1').catch(() => null);
    if (titleEl) {
      const titleText = await titleEl.textContent().catch(() => "");
      log("business_found", titleText.slice(0, 80));
      interactions.push("business_found");
    } else {
      log("business_panel_loading", "Waiting for business panel...");
      await sleep(rand(3000, 5000));
    }

    // 2. Scroll down through profile to reveal all sections
    log("profile_scroll", "Browsing business profile");
    for (let i = 0; i < rand(3, 5); i++) {
      await Promise.race([humanScroll(page, isMobile, personality), sleep(5000)]).catch(() => {});
      await sleep(rand(personality.wait[0], personality.wait[1]));
    }
    interactions.push("scrolled");

    // 3. Click on Photos
    try {
      const photosBtn = await page.$('button:has-text("Photos"), a:has-text("Photos"), [data-tab="photos"], [aria-label*="Photo"], img[src*="googleusercontent"]').catch(() => null);
      if (photosBtn) {
        await humanMouseMove(page, photosBtn, isMobile).catch(() => {});
        await photosBtn.click().catch(() => {});
        log("photos_clicked", "Viewing photos");
        interactions.push("photos");
        await sleep(rand(4000, 8000));
        // Scroll through photos
        await Promise.race([humanScroll(page, isMobile, personality), sleep(5000)]).catch(() => {});
        await sleep(rand(2000, 4000));
        // Go back to profile
        await page.goBack().catch(() => {});
        await sleep(rand(2000, 4000));
        log("photos_done", "Back to profile");
      }
    } catch {}

    // 4. Click on Reviews
    try {
      const reviewsBtn = await page.$('button:has-text("Reviews"), a:has-text("Reviews"), [data-tab="reviews"], [aria-label*="review"], .F7nice').catch(() => null);
      if (reviewsBtn) {
        await humanMouseMove(page, reviewsBtn, isMobile).catch(() => {});
        await reviewsBtn.click().catch(() => {});
        log("reviews_clicked", "Reading reviews");
        interactions.push("reviews");
        await sleep(rand(4000, 8000));
        for (let i = 0; i < rand(2, 4); i++) {
          await Promise.race([humanScroll(page, isMobile, personality), sleep(5000)]).catch(() => {});
          await sleep(rand(2000, 4000));
        }
        // Go back to profile
        await page.goBack().catch(() => {});
        await sleep(rand(2000, 4000));
        log("reviews_done", "Back to profile");
      }
    } catch {}

    // 5. Click on Directions / Address
    try {
      const directionsBtn = await page.$('button:has-text("Directions"), a:has-text("Directions"), [data-value="Directions"], [aria-label*="Direction"]').catch(() => null);
      if (directionsBtn) {
        await humanMouseMove(page, directionsBtn, isMobile).catch(() => {});
        await directionsBtn.click().catch(() => {});
        log("directions_clicked", "Viewing directions");
        interactions.push("directions");
        await sleep(rand(3000, 6000));
        // Go back
        await page.goBack().catch(() => {});
        await sleep(rand(2000, 3000));
      }
    } catch {}

    // 6. Scroll more through the profile
    for (let i = 0; i < rand(2, 4); i++) {
      await Promise.race([humanScroll(page, isMobile, personality), sleep(5000)]).catch(() => {});
      await sleep(rand(1000, 3000));
    }

    // 7. Click on phone number (just tap, don't actually call)
    try {
      const phoneBtn = await page.$('button[data-tooltip="Copy phone number"], a[href^="tel:"], [data-value*="phone"], [aria-label*="phone"]').catch(() => null);
      if (phoneBtn) {
        await humanMouseMove(page, phoneBtn, isMobile).catch(() => {});
        log("phone_viewed", "Viewed phone number");
        interactions.push("phone");
        await sleep(rand(1000, 2000));
      }
    } catch {}

    // 8. Click Website link — ALWAYS
    let websiteClicked = false;
    try {
      const websiteBtn = await page.$('a[data-value="Website"], a:has-text("Website"), a[aria-label*="website"], a[href*="' + (website || 'NOMATCH') + '"]').catch(() => null);
      if (websiteBtn) {
        const href = await websiteBtn.getAttribute("href").catch(() => "");
        log("website_clicking", href ? href.slice(0, 80) : "clicking website");
        await humanMouseMove(page, websiteBtn, isMobile).catch(() => {});
        
        const [newPage] = await Promise.all([
          context.waitForEvent("page", { timeout: 8000 }).catch(() => null),
          websiteBtn.click().catch(() => {}),
        ]);

        if (newPage) {
          await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          log("website_opened_newtab", newPage.url().slice(0, 100));
          const dwellTime = Math.max(30000, rand(personality.dwell[0], personality.dwell[1]));
          log("dwelling_website", Math.round(dwellTime / 1000) + "s");
          for (let i = 0; i < rand(3, 6); i++) {
            await Promise.race([humanScroll(newPage, isMobile, personality), sleep(5000)]).catch(() => {});
            await sleep(rand(2000, 4000));
          }
          await sleep(dwellTime);
          log("dwell_complete", Math.round(dwellTime / 1000) + "s on website");
          websiteClicked = true;
          interactions.push("website");
        } else {
          const currentUrl = page.url();
          if (!currentUrl.includes("google.com/maps")) {
            log("website_opened_samepage", currentUrl.slice(0, 100));
            const dwellTime = Math.max(30000, rand(personality.dwell[0], personality.dwell[1]));
            for (let i = 0; i < rand(3, 6); i++) {
              await Promise.race([humanScroll(page, isMobile, personality), sleep(5000)]).catch(() => {});
              await sleep(rand(2000, 4000));
            }
            await sleep(dwellTime);
            websiteClicked = true;
            interactions.push("website");
          }
        }
      } else {
        log("website_not_found", "No website button found");
      }
    } catch (webErr) {
      log("website_error", (webErr.message || "").slice(0, 60));
    }

        // 6. If no website click, dwell on maps profile
    if (!websiteClicked) {
      const dwellTime = Math.max(20000, rand(personality.dwell[0], personality.dwell[1]));
      log("dwelling_profile", Math.round(dwellTime / 1000) + "s — browsing maps profile");
      await sleep(dwellTime);
      log("dwell_complete", Math.round(dwellTime / 1000) + "s");
      interactions.push("profile_dwell");
    }

    const duration = Date.now() - startTime;
    log("complete", `${interactions.length} interactions in ${Math.round(duration / 1000)}s`);

    return {
      success: true,
      found: true,
      click: websiteClicked,
      on_target: true,
      engine: "google-maps-direct",
      keyword: businessName,
      device: isMobile ? "mobile" : "desktop",
      proxy: proxyConfig?.ip || "",
      grid_point: gridPoint,
      maps_url: mapsUrl,
      landed_url: page.url(),
      duration_ms: duration,
      user_agent: personality?.userAgent || "",
      personality,
      interactions,
      websiteClicked,
      journey_type: "super-rocket",
      steps,
    };
  } catch (err) {
    log("error", (err.message || "").slice(0, 200));
    return {
      success: false,
      found: false,
      click: false,
      on_target: false,
      engine: "google-maps-direct",
      keyword: params.business_name || "",
      device: isMobile ? "mobile" : "desktop",
      error: (err.message || "").slice(0, 200),
      duration_ms: Date.now() - startTime,
      journey_type: "super-rocket",
      steps,
    };
  } finally {
    if (session) {
      await cleanup(session.browser, session.glApi, session.profileId).catch(() => {});
    }
  }
}

module.exports = { run };
