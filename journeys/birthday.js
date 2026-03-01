/**
 * NirvanaTraffic — Birthday Journey
 * Google Images search → find target image by perceptual hash → click → click through to site → dwell
 */

const { rand, createLogger, setupBrowserSession, dwell, cleanup, humanScroll, humanMouseMove, humanIdle, generatePersonality, logPersonality, searchGoogle, handleCaptcha } = require("../lib/shared");

// ── Compute perceptual hash of an image in-browser via Canvas ──
// Returns a 64-bit binary string (8x8 average hash)
async function computeImageHash(page, imageDataUrl) {
  return page.evaluate((dataUrl) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const ctx = canvas.getContext("2d");
        // Draw image scaled to 8x8
        ctx.drawImage(img, 0, 0, 8, 8);
        const pixels = ctx.getImageData(0, 0, 8, 8).data;
        
        // Convert to grayscale values
        const grays = [];
        for (let i = 0; i < pixels.length; i += 4) {
          grays.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
        }
        
        // Compute mean
        const mean = grays.reduce((a, b) => a + b, 0) / grays.length;
        
        // Build hash: 1 if pixel > mean, 0 otherwise
        const hash = grays.map(g => g >= mean ? "1" : "0").join("");
        resolve(hash);
      };
      img.onerror = () => reject(new Error("Failed to load image for hashing"));
      img.src = dataUrl;
    });
  }, imageDataUrl);
}

// ── Hamming distance between two binary hash strings ──
function hammingDistance(h1, h2) {
  if (h1.length !== h2.length) return 64; // max distance
  let dist = 0;
  for (let i = 0; i < h1.length; i++) {
    if (h1[i] !== h2[i]) dist++;
  }
  return dist;
}

// ── Find target image in Google Images results ──
async function findImageInResults(page, targetHash, log, personality) {
  let scrolled = 0;
  const maxScroll = 8000;
  let attempts = 0;
  let bestMatch = null;
  let bestDistance = 64;

  while (scrolled < maxScroll && attempts < 15) {
    attempts++;

    // Extract all visible image thumbnails
    const thumbnails = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[data-src], img[src^="data:image"], img[src^="https://encrypted-tbn"]'));
      return imgs
        .filter(img => img.offsetParent !== null && img.naturalWidth > 30)
        .map((img, idx) => {
          const rect = img.getBoundingClientRect();
          return {
            idx,
            src: img.src,
            dataSrc: img.getAttribute("data-src") || "",
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
            width: rect.width,
            height: rect.height,
            visible: rect.top >= 0 && rect.top < window.innerHeight && rect.width > 20 && rect.height > 20,
          };
        });
    });

    log("scanning_images", `Found ${thumbnails.length} thumbnails (attempt ${attempts})`);

    // Hash each visible thumbnail and compare
    for (const thumb of thumbnails.filter(t => t.visible)) {
      try {
        let srcToHash = thumb.src;
        
        // If src is a URL (not data URI), convert to data URI via canvas in browser
        if (!srcToHash.startsWith("data:")) {
          srcToHash = await page.evaluate((imgSrc) => {
            return new Promise((resolve) => {
              const img = new Image();
              img.crossOrigin = "anonymous";
              img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext("2d").drawImage(img, 0, 0);
                try {
                  resolve(canvas.toDataURL("image/jpeg", 0.8));
                } catch {
                  resolve(null);
                }
              };
              img.onerror = () => resolve(null);
              img.src = imgSrc;
            });
          }, srcToHash);
          if (!srcToHash) continue;
        }

        const thumbHash = await computeImageHash(page, srcToHash);
        const dist = hammingDistance(targetHash, thumbHash);

        if (dist < bestDistance) {
          bestDistance = dist;
          bestMatch = { ...thumb, hash: thumbHash, distance: dist };
        }

        // Perfect or near-perfect match (within 10 bits of 64)
        if (dist <= 10) {
          log("image_match_found", `Distance: ${dist}/64 at thumbnail #${thumb.idx}`);
          return bestMatch;
        }
      } catch {}
    }

    // Scroll down to see more images
    const scrollAmount = rand(400, 700);
    await humanScroll(page, scrollAmount, log);
    scrolled += scrollAmount;
    await page.waitForTimeout(rand(1500, 3000));
  }

  if (bestMatch && bestDistance <= 15) {
    log("image_best_match", `Best match distance: ${bestDistance}/64`);
    return bestMatch;
  }

  log("image_not_found", `No match found (best distance: ${bestDistance}/64)`);
  return null;
}

// ── Main Journey ────────────────────────────────────────
async function run(job) {
  const params = job.params || job;
  const startTime = Date.now();
  const { steps, log } = createLogger(startTime);

  const keyword = params.keyword || params.keywords || "";
  const imageBase64 = params.image_base64 || params.imageBase64 || "";
  const targetDestination = params.target_destination || params.targetDestination || "";
  const wildcard = params.wildcard !== undefined ? params.wildcard : true;

  if (!keyword) {
    log("error", "No keyword provided");
    return { success: false, error: "No keyword", journeyType: "birthday", duration_ms: 0 };
  }

  if (!imageBase64) {
    log("error", "No image base64 provided");
    return { success: false, error: "No image base64", journeyType: "birthday", duration_ms: 0 };
  }

  let session;
  let personality;
  try {
    session = await setupBrowserSession({ ...params, skipGoogle: false }, log);
    const { page, context, proxyConfig } = session;

    const isMobile = (params.device === "mobile");
    personality = generatePersonality(isMobile);
    logPersonality(personality, log);

    // Step 1: Search on Google (uses shared humanType + CAPTCHA handling)
    log("searching", `Keyword: "${keyword}"`);
    await searchGoogle(page, session.context, keyword, session.proxyConfig, log);
    steps.push({ action: "searched", keyword, time: Date.now() - startTime });

    // Step 2: Click "Images" tab
    log("switching_to_images", "Looking for Images tab...");
    
    // Try multiple selectors for Images tab
    const imagesSelectors = [
      'a:has-text("Images")',
      'a[href*="tbm=isch"]',
      'div[role="listitem"] a:has-text("Images")',
    ];
    
    let imagesClicked = false;
    for (const sel of imagesSelectors) {
      try {
        const tab = page.locator(sel).first();
        if (await tab.isVisible({ timeout: 3000 })) {
          const box = await tab.boundingBox();
          if (box) {
            await humanMouseMove(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
            await page.waitForTimeout(rand(200, 600));
            await tab.click({ timeout: 5000 });
            imagesClicked = true;
            break;
          }
        }
      } catch {}
    }
    
    if (!imagesClicked) {
      // Fallback: navigate directly to Google Images with the keyword
      const imagesUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&tbm=isch`;
      await page.goto(imagesUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    await page.waitForTimeout(rand(3000, 5000));
    
    // Check for CAPTCHA on images page
    await handleCaptcha(page, session.context, session.proxyConfig, log);
    
    log("images_loaded", page.url().slice(0, 80));
    steps.push({ action: "images_tab", time: Date.now() - startTime });

    // Step 3: Compute hash of target image
    log("hashing_target", "Computing perceptual hash of target image...");
    const targetHash = await computeImageHash(page, imageBase64);
    log("target_hash", targetHash);
    steps.push({ action: "target_hashed", time: Date.now() - startTime });

    // Step 4: Find matching image
    const match = await findImageInResults(page, targetHash, log, personality);
    steps.push({ action: match ? "image_found" : "image_not_found", distance: match?.distance, time: Date.now() - startTime });

    if (match) {
      // Step 5: Click the matching image
      const hesitation = rand(500, 2000);
      await page.waitForTimeout(hesitation);
      await humanMouseMove(page, match.x, match.y);
      await page.waitForTimeout(rand(200, 500));
      await page.mouse.click(match.x, match.y);
      log("image_clicked", `Clicked thumbnail at (${match.x}, ${match.y})`);
      await page.waitForTimeout(rand(2000, 4000));
      steps.push({ action: "image_clicked", time: Date.now() - startTime });

      // Step 6: Click through to website (if target destination provided)
      if (targetDestination) {
        const normalize = (url) => url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
        const target = normalize(targetDestination);

        // Look for "Visit" button or website link in the image preview panel
        const visitLink = await page.evaluate(({ targetStr, isWildcard }) => {
          const normalize = (url) => url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
          const targetNorm = normalize(targetStr);
          const links = Array.from(document.querySelectorAll('a[href]'));
          const match = links.find(a => {
            const hrefNorm = normalize(a.href);
            if (isWildcard) {
              return hrefNorm.startsWith(targetNorm) || hrefNorm.startsWith(targetNorm + "/");
            }
            return hrefNorm === targetNorm || hrefNorm.includes(targetNorm);
          });
          if (match && match.offsetParent !== null) {
            const rect = match.getBoundingClientRect();
            return { href: match.href, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), text: (match.textContent || "").trim().slice(0, 60) };
          }
          return null;
        }, { targetStr: target, isWildcard: wildcard });

        if (visitLink) {
          await humanMouseMove(page, visitLink.x, visitLink.y);
          await page.waitForTimeout(rand(300, 800));
          await page.mouse.click(visitLink.x, visitLink.y);
          log("visit_clicked", `→ ${visitLink.href.slice(0, 80)}`);
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(rand(1000, 2000));
          steps.push({ action: "visit_clicked", href: visitLink.href, time: Date.now() - startTime });

          // Step 7: Dwell on target site
          const targetDwellMs = personality ? rand(personality.dwell[0], personality.dwell[1]) : rand(20000, 60000);
          log("target_dwell", `Dwelling ${Math.round(targetDwellMs / 1000)}s on target`);
          await dwell(page, targetDwellMs, log, personality);
          steps.push({ action: "target_dwell", duration_s: Math.round(targetDwellMs / 1000), time: Date.now() - startTime });
        } else {
          log("visit_not_found", `No link to "${target}" found in image preview`);
          steps.push({ action: "visit_not_found", time: Date.now() - startTime });
        }
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      success: true,
      found: !!match,
      click: !!match,
      image_distance: match?.distance ?? null,
      keyword,
      target_destination: targetDestination,
      time_on_site: Math.round(durationMs / 1000),
      proxy: session?.exitIp || "",
      user_agent: session ? await page.evaluate(() => navigator.userAgent).catch(() => "") : "",
      device: params.device || "desktop",
      engine: "google-images",
      journeyType: "birthday",
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
      keyword, target_destination: targetDestination,
      time_on_site: 0, proxy: "", user_agent: "",
      device: params.device || "desktop", engine: "google-images",
      journeyType: "birthday", fingerprint: session?.fingerprint || null,
      personality: personality ? { traits: personality.traits, timeOfDay: personality.timeOfDay, device: personality.device } : null,
      steps, error: errDetail, duration_ms: Date.now() - startTime,
    };
  } finally {
    if (session) await cleanup(session.browser, session.glApi, session.profileId);
  }
}

module.exports = { run };
