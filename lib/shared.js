/**
 * NirvanaTraffic — Shared Library
 * All reusable functions: proxy, captcha, typing, browser, helpers
 */

const axios = require("axios");

// ── Config (loaded from env) ────────────────────────────
const CONFIG = {
  DECODO_USER: process.env.DECODO_USER,
  DECODO_PASS: process.env.DECODO_PASS,
  DECODO_MOBILE_USER: process.env.DECODO_MOBILE_USER,
  DECODO_MOBILE_PASS: process.env.DECODO_MOBILE_PASS,
  TWOCAPTCHA_KEY: process.env.TWOCAPTCHA_API_KEY,
  GOLOGIN_TOKEN: process.env.GOLOGIN_TOKEN,
};

const GL_API = "https://api.gologin.com";
const GL_HEADERS = () => ({
  Authorization: `Bearer ${CONFIG.GOLOGIN_TOKEN}`,
  "Content-Type": "application/json",
});

// ── Helpers ─────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

const UULE_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function generateUule(canonicalName) {
  const b64 = Buffer.from(canonicalName).toString("base64").replace(/=/g, "");
  return "w+CAIQICI" + UULE_KEY[canonicalName.length] + b64;
}

function scoreMatch(text, href, targetBusiness, targetUrl) {
  const bizLow = targetBusiness.toLowerCase();
  const bizWords = bizLow.split(/\s+/).filter((w) => w.length > 1);
  const urlLow = (targetUrl || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
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
}

function createLogger(startTime) {
  const steps = [];
  const log = (action, details) => {
    const ts = Date.now() - startTime;
    steps.push({ action, timestamp: ts, details });
    console.log(`  [${(ts / 1000).toFixed(1)}s] ${action}${details ? ": " + details : ""}`);
  };
  return { steps, log };
}

// ── Proxy ───────────────────────────────────────────────
function buildProxyUrl(mobile = false) {
  const user = mobile && CONFIG.DECODO_MOBILE_USER ? CONFIG.DECODO_MOBILE_USER : CONFIG.DECODO_USER;
  const pass = mobile && CONFIG.DECODO_MOBILE_PASS ? CONFIG.DECODO_MOBILE_PASS : CONFIG.DECODO_PASS;
  const proxyType = mobile && CONFIG.DECODO_MOBILE_USER ? "mobile" : "residential";
  // Rotate port 10001-10010 for different IP sessions
  const port = 10001 + Math.floor(Math.random() * 10);
  return { username: user, password: pass, type: proxyType, port };
}

function getProxyInfo(proxyConfig) {
  return { host: "us.decodo.com", port: proxyConfig.port || 10001, username: proxyConfig.username, password: proxyConfig.password };
}

// ── 2Captcha ────────────────────────────────────────────
async function solveRecaptcha(pageUrl, siteKey, dataS, proxyInfo, cookies, userAgent) {
  const task = {
    type: proxyInfo ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };
  if (dataS) task.recaptchaDataSValue = dataS;
  if (userAgent) task.userAgent = userAgent;
  if (cookies) task.cookies = cookies;

  if (proxyInfo) {
    task.proxyType = "http";
    task.proxyAddress = proxyInfo.host;
    task.proxyPort = proxyInfo.port;
    if (proxyInfo.username) task.proxyLogin = proxyInfo.username;
    if (proxyInfo.password) task.proxyPassword = proxyInfo.password;
  }

  console.log(`  🔐 2Captcha: submitting ${task.type} (data-s: ${dataS ? "yes" : "no"}, proxy: ${proxyInfo ? "yes" : "no"})`);

  const createRes = await axios.post("https://api.2captcha.com/createTask", {
    clientKey: CONFIG.TWOCAPTCHA_KEY,
    task,
  });
  if (createRes.data.errorId !== 0) throw new Error("2Captcha createTask failed: " + (createRes.data.errorDescription || createRes.data.errorCode));
  const taskId = createRes.data.taskId;
  console.log(`  🔐 2Captcha: task ${taskId} created, waiting...`);

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await axios.post("https://api.2captcha.com/getTaskResult", {
      clientKey: CONFIG.TWOCAPTCHA_KEY,
      taskId,
    });
    if (res.data.status === "ready") {
      console.log(`  🔐 2Captcha: solved in ${(i + 1) * 5}s`);
      return res.data.solution.gRecaptchaResponse;
    }
    if (res.data.errorId !== 0) throw new Error("2Captcha error: " + (res.data.errorDescription || res.data.errorCode));
  }
  throw new Error("2Captcha timeout — no solution in 120s");
}

// ── GoLogin Browser ─────────────────────────────────────
async function createGoLoginProfile(mobile, proxyConfig) {
  let ua, platform;
  try {
    const os = mobile ? "android" : "win";
    const fpRes = await axios.get(`${GL_API}/browser/fingerprint?os=${os}`, { headers: GL_HEADERS() });
    ua = fpRes.data?.navigator?.userAgent;
    platform = fpRes.data?.navigator?.platform;
    console.log(`  🎭 Got fingerprint from GoLogin API`);
  } catch (e) {
    console.log(`  🎭 Fingerprint fetch failed (${e.message}), using defaults`);
  }

  const profileData = {
    name: `nirvana-${Date.now()}`,
    os: mobile ? "android" : "win",
    browserType: "chrome",
    navigator: {
      userAgent: ua || (mobile
        ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
      platform: platform || (mobile ? "Linux armv81" : "Win32"),
      resolution: mobile ? "390x844" : "1920x1080",
      language: "en-US,en",
    },
    proxy: proxyConfig.username ? {
      mode: "http",
      host: String(proxyConfig.host || "us.decodo.com"),
      port: Number(proxyConfig.port || 10001),  // Rotated port for IP diversity
      username: String(proxyConfig.username),
      password: String(proxyConfig.password),
    } : { mode: "none" },
    webRTC: { mode: "alerted", enabled: true },
  };

  console.log(`  🎭 Creating GoLogin profile (proxy: ${proxyConfig.username ? "yes" : "none"})...`);
  const res = await axios.post(`${GL_API}/browser`, profileData, { headers: GL_HEADERS() });
  console.log(`  🎭 Profile created: ${res.data.id}`);
  return res.data.id;
}

async function launchGoLoginBrowser(profileId) {
  const gologin = await import("gologin");
  const { chromium } = require("playwright");
  const GoLogin = gologin.default || gologin.GoLogin || gologin;
  const GL = new GoLogin({ token: CONFIG.GOLOGIN_TOKEN, profile_id: profileId });

  console.log(`  🌐 Starting GoLogin profile...`);
  const { status, wsUrl } = await GL.start();
  console.log(`  🌐 Orbita running! Status: ${status}`);

  console.log(`  🎭 Connecting Playwright via CDP...`);
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 30000 });
  console.log(`  🎭 Playwright connected!`);

  return { browser, GL };
}

async function deleteGoLoginProfile(profileId) {
  try {
    await axios.delete(`${GL_API}/browser/${profileId}`, { headers: GL_HEADERS() });
  } catch { /* ok */ }
}

// ── Cookie Injection ────────────────────────────────────
async function injectCookies(context, log) {
  try {
    const cookieData = require("../cookies.json");
    if (cookieData?.cookies?.length) {
      const playwrightCookies = cookieData.cookies
        .filter((c) => c.domain && c.name && c.value !== undefined)
        .map((c) => ({
          name: c.name,
          value: c.value || "",
          domain: c.domain,
          path: c.path || "/",
          expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : undefined,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite === "None" ? "None" : c.sameSite === "Lax" ? "Lax" : c.sameSite === "Strict" ? "Strict" : "Lax",
        }));
      await context.addCookies(playwrightCookies);
      log("cookies_injected", `${playwrightCookies.length} cookies`);
    }
  } catch (e) {
    log("cookies_inject_warning", e.message);
  }
}

// ── Human Behavior Patterns ─────────────────────────────

// Bezier-inspired random: clusters around the middle, not uniform
function humanRand(min, max) {
  const t = Math.random() * Math.random(); // clusters toward lower end
  return Math.floor(min + t * (max - min));
}

// Natural mouse movement — not straight lines
async function humanMouseMove(page, targetX, targetY) {
  const box = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight }));
  // Start from a plausible position
  const startX = rand(100, box.w - 100);
  const startY = rand(100, box.h - 100);
  
  // Move in 3-5 steps with slight curves (not a straight line)
  const steps = rand(3, 6);
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    // Add wobble — humans don't move in straight lines
    const wobbleX = (Math.random() - 0.5) * 40;
    const wobbleY = (Math.random() - 0.5) * 30;
    const x = Math.round(startX + (targetX - startX) * progress + wobbleX * (1 - progress));
    const y = Math.round(startY + (targetY - startY) * progress + wobbleY * (1 - progress));
    await page.mouse.move(x, y);
    await page.waitForTimeout(rand(15, 60));
  }
  // Final position
  await page.mouse.move(targetX, targetY);
}

// Natural scroll — variable speed, sometimes pause to "read"
async function humanScroll(page, totalDistance, log) {
  // Detect if mobile viewport
  const viewport = page.viewportSize();
  const isMobile = viewport && viewport.width < 500;

  if (isMobile) {
    // Mobile: simulate finger swipe using touch events
    await mobileSwipeScroll(page, totalDistance);
  } else {
    // Desktop: mouse wheel scroll
    let scrolled = 0;
    while (scrolled < totalDistance) {
      const chunk = rand(80, 250);
      const speed = rand(30, 120);
      await page.mouse.wheel(0, chunk);
      scrolled += chunk;
      await page.waitForTimeout(speed);
      if (Math.random() < 0.2) {
        await page.waitForTimeout(rand(800, 2500));
      }
    }
  }
}

// Mobile finger swipe — touchstart → touchmove (multiple steps) → touchend
async function mobileSwipeScroll(page, totalDistance) {
  let scrolled = 0;
  while (scrolled < totalDistance) {
    // Each swipe: finger touches screen, drags up, releases
    const swipeDistance = rand(100, 350); // How far one finger swipe goes
    const startX = rand(120, 280); // Random horizontal position
    const startY = rand(500, 700); // Start from lower part of screen
    const endY = Math.max(100, startY - swipeDistance); // Swipe upward
    const steps = rand(8, 20); // More steps = smoother swipe
    const stepDelay = rand(8, 25); // ms between touchmove events

    await page.evaluate(async ({ startX, startY, endY, steps, stepDelay }) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      
      // touchstart
      const startTouch = new Touch({ identifier: 0, target: document.elementFromPoint(startX, startY) || document.body, clientX: startX, clientY: startY });
      document.dispatchEvent(new TouchEvent('touchstart', { touches: [startTouch], changedTouches: [startTouch], bubbles: true }));
      
      // touchmove — multiple intermediate points (like a real finger drag)
      for (let i = 1; i <= steps; i++) {
        await sleep(stepDelay);
        const progress = i / steps;
        // Ease-out curve — fast at start, slows at end (like a real swipe)
        const eased = 1 - Math.pow(1 - progress, 2);
        const currentY = startY + (endY - startY) * eased;
        // Slight horizontal wobble (finger isn't perfectly straight)
        const wobbleX = startX + (Math.random() - 0.5) * 4;
        const moveTouch = new Touch({ identifier: 0, target: document.elementFromPoint(wobbleX, currentY) || document.body, clientX: wobbleX, clientY: currentY });
        document.dispatchEvent(new TouchEvent('touchmove', { touches: [moveTouch], changedTouches: [moveTouch], bubbles: true, cancelable: true }));
      }
      
      // touchend
      const endTouch = new Touch({ identifier: 0, target: document.elementFromPoint(startX, endY) || document.body, clientX: startX, clientY: endY });
      document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [endTouch], bubbles: true }));
    }, { startX, startY, endY, steps, stepDelay });

    scrolled += swipeDistance;

    // Pause between swipes — variable like a real person
    const pauseType = Math.random();
    if (pauseType < 0.15) {
      // Long pause — "reading" something
      await page.waitForTimeout(rand(1500, 4000));
    } else if (pauseType < 0.4) {
      // Medium pause — glancing
      await page.waitForTimeout(rand(500, 1200));
    } else {
      // Quick flick — scanning
      await page.waitForTimeout(rand(150, 400));
    }
  }
}

// Idle behavior — what humans do while "thinking"
async function humanIdle(page, minMs, maxMs) {
  const duration = rand(minMs, maxMs);
  const endTime = Date.now() + duration;
  
  while (Date.now() < endTime) {
    const action = Math.random();
    if (action < 0.3) {
      // Small mouse wiggle (hand resting on mouse)
      const box = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await page.mouse.move(rand(100, box.w - 100), rand(100, box.h - 100));
      await page.waitForTimeout(rand(200, 800));
    } else if (action < 0.5) {
      // Tiny scroll (reading)
      const vp = page.viewportSize();
      if (vp && vp.width < 500) {
        await mobileSwipeScroll(page, rand(30, 100));
      } else {
        await page.mouse.wheel(0, rand(20, 80));
      }
      await page.waitForTimeout(rand(400, 1200));
    } else {
      // Just wait (thinking, reading)
      await page.waitForTimeout(rand(500, 2000));
    }
  }
}

async function focusSearchInput(page, log) {
  // Move mouse toward search area first (humans don't teleport)
  await humanMouseMove(page, rand(300, 600), rand(200, 350));
  await page.waitForTimeout(rand(200, 500));
  
  const input = page.locator('textarea[name="q"], input[name="q"]').first();
  try {
    await input.click({ timeout: 5000 });
    log("input_clicked");
  } catch {
    log("input_click_failed", "Trying JS focus + tap fallback...");
    await page.evaluate(() => {
      const el = document.querySelector('textarea[name="q"]') || document.querySelector('input[name="q"]');
      if (el) { el.focus(); el.click(); }
    });
    await page.waitForTimeout(500);
    const overlayInput = page.locator('input[aria-label="Search"], textarea[aria-label="Search"], input.gLFyf, textarea.gLFyf').first();
    try {
      if (await overlayInput.isVisible({ timeout: 2000 })) {
        await overlayInput.click({ timeout: 3000 });
        log("overlay_input_clicked");
      }
    } catch { /* proceed */ }
  }
}

async function humanType(page, text, log) {
  // Initial hesitation — thinking about what to type
  await page.waitForTimeout(rand(800, 2500));
  
  // Typing speed varies per "burst" (humans type in bursts, not constant speed)
  let burstSpeed = rand(100, 200); // ms per char in current burst
  let charsInBurst = 0;
  
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    
    // New burst every 3-8 characters (speed changes)
    if (charsInBurst >= rand(3, 8)) {
      burstSpeed = rand(80, 280);
      charsInBurst = 0;
      // Inter-burst pause (looking at keyboard or thinking)
      if (Math.random() < 0.3) {
        await page.waitForTimeout(rand(300, 900));
      }
    }
    
    // 4% typo chance — more realistic typos (adjacent keys)
    if (Math.random() < 0.04 && i > 2 && c.match(/[a-z]/i)) {
      const adjacent = {
        q: "wa", w: "qeas", e: "wrds", r: "etfs", t: "rygs",
        y: "tuhs", u: "yijs", i: "uoks", o: "ipls", p: "ol",
        a: "qwsz", s: "wedax", d: "erfsc", f: "rtgdv", g: "tyhfb",
        h: "uyjgn", j: "iukhm", k: "iojl", l: "opk",
        z: "asx", x: "sdc", c: "dfxv", v: "fgcb", b: "ghvn",
        n: "hjbm", m: "jkn",
      };
      const neighbors = adjacent[c.toLowerCase()] || "";
      if (neighbors.length > 0) {
        const wrongKey = neighbors[Math.floor(Math.random() * neighbors.length)];
        await page.keyboard.type(wrongKey, { delay: rand(40, 100) });
        await page.waitForTimeout(rand(150, 500)); // Notice the mistake
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(rand(80, 300)); // Brief pause after correction
      }
    }
    
    // Type the character with variable speed
    const charDelay = burstSpeed + rand(-40, 40); // Slight variation within burst
    await page.keyboard.type(c, { delay: Math.max(30, charDelay) });
    charsInBurst++;
    
    // Space = longer pause (between words, natural)
    if (c === " ") await page.waitForTimeout(rand(200, 600));
  }
  
  log("keyword_typed", text);
}

// ── Google Page Helpers ─────────────────────────────────
async function handleCaptcha(page, context, proxyConfig, log, maxAttempts = 3) {
  if (!page.url().includes("/sorry/") && !page.url().includes("captcha")) return true;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log("captcha_detected", `Solving with 2Captcha (attempt ${attempt}/${maxAttempts})...`);
    try {
      // On retry: reload page to get FRESH data-s token, then extract + submit IMMEDIATELY
      // Google's data-s expires in ~15-30s, so speed is critical
      if (attempt > 1) {
        log("captcha_refresh", "Reloading for fresh data-s token...");
        try {
          // Use F5 key — more reliable in GoLogin than page.reload() or page.goto()
          await page.keyboard.press("F5");
          await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
          // Also try waiting for the captcha widget to appear
          await page.waitForSelector('[data-sitekey], .g-recaptcha', { timeout: 10000 }).catch(() => {});
        } catch {
          log("captcha_refresh_warn", "Reload had issues — proceeding with current page");
        }
        await page.waitForTimeout(rand(500, 1000)); // Minimal wait — data-s is ticking!
        if (!page.url().includes("/sorry/") && !page.url().includes("captcha")) {
          log("captcha_gone_after_reload", "No captcha on reload — continuing");
          return true;
        }
      }

      const captchaInfo = await page.evaluate(() => {
        const el = document.querySelector("[data-sitekey]") || document.querySelector(".g-recaptcha");
        if (!el) return null;
        return { siteKey: el.getAttribute("data-sitekey"), dataS: el.getAttribute("data-s") || "" };
      });
      if (!captchaInfo || !captchaInfo.siteKey) {
        // Plain IP block — no reCAPTCHA widget. This IP is burned.
        log("ip_blocked", "No reCAPTCHA on sorry page — IP is fully blocked, need fresh IP");
        return false;
      }

      const browserCookies = await context.cookies();
      const cookieStr = browserCookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const proxyInfo = getProxyInfo(proxyConfig);
      const ua = await page.evaluate(() => navigator.userAgent);

      log("captcha_solving", `data-s: ${captchaInfo.dataS ? "yes" : "no"}`);
      const token = await solveRecaptcha(page.url(), captchaInfo.siteKey, captchaInfo.dataS, proxyInfo, cookieStr, ua);
      log("captcha_solved", `attempt ${attempt}`);

      await page.evaluate((tok) => {
        const resp = document.getElementById("g-recaptcha-response");
        if (resp) resp.value = tok;
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (ta) ta.value = tok;
        const form = document.getElementById("captcha-form") || document.querySelector("form");
        if (form) form.submit();
      }, token);

      // Wait longer for Google to process — it can take a few seconds
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(rand(2000, 4000)); // Extra wait for redirect
      
      // Check URL after a moment — Google sometimes does a delayed redirect
      if (!page.url().includes("/sorry/")) {
        log("captcha_bypassed", `solved on attempt ${attempt}`);
        return true;
      }
      
      // One more check — wait and see if it redirects
      await page.waitForTimeout(3000);
      if (!page.url().includes("/sorry/")) {
        log("captcha_bypassed_delayed", `solved on attempt ${attempt} (delayed redirect)`);
        return true;
      }

      log("captcha_stale", `attempt ${attempt} — data-s likely expired, retrying with fresh token...`);
    } catch (err) {
      log("captcha_error", `attempt ${attempt}: ${err.message}`);
    }
  }

  log("captcha_failed", `All ${maxAttempts} attempts exhausted`);
  return false;
}

async function dismissPopups(page, log) {
  try {
    const notInterested = page.locator('button:has-text("Not interested"), button:has-text("No thanks"), button:has-text("Dismiss")');
    if (await notInterested.first().isVisible({ timeout: 2000 })) {
      await notInterested.first().click();
      log("popup_dismissed");
      await page.waitForTimeout(rand(500, 1000));
    }
  } catch { /* ok */ }

  try {
    const btn = page.locator('#L2AGLb, button:has-text("Accept all"), button:has-text("Accept")');
    if (await btn.first().isVisible({ timeout: 2000 })) {
      await btn.first().click();
      log("cookie_accepted");
    }
  } catch { /* ok */ }
}

async function dwell(page, dwellTimeMs, log) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  log("dwelling", `${Math.round(dwellTimeMs / 1000)}s — simulating real reading`);
  
  const startTime = Date.now();
  const endTime = startTime + dwellTimeMs;
  
  // Phase 1: Initial page scan (2-4 seconds, quick scroll to see layout)
  await page.waitForTimeout(rand(1500, 3000));
  await humanScroll(page, rand(200, 400), log);
  
  // Phase 2: Reading content (main dwell time)
  while (Date.now() < endTime - 5000) {
    const behavior = Math.random();
    
    if (behavior < 0.35) {
      // Read a section (pause + small scroll)
      await page.waitForTimeout(rand(2000, 5000)); // Reading
      await humanScroll(page, rand(100, 300), log);
    } else if (behavior < 0.55) {
      // Scroll back up a bit (re-read something)
      await page.mouse.wheel(0, -rand(50, 200));
      await page.waitForTimeout(rand(1000, 3000));
    } else if (behavior < 0.7) {
      // Move mouse to a link or heading (hover, considering clicking)
      const box = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await humanMouseMove(page, rand(100, box.w - 100), rand(100, box.h - 200));
      await page.waitForTimeout(rand(500, 2000));
    } else if (behavior < 0.85) {
      // Idle (thinking, looking at phone, etc.)
      await humanIdle(page, 2000, 5000);
    } else {
      // Faster scroll through less interesting content
      await humanScroll(page, rand(300, 600), log);
      await page.waitForTimeout(rand(800, 2000));
    }
  }
  
  // Phase 3: Scroll to bottom and back (wrapping up)
  await humanScroll(page, rand(200, 500), log);
  await page.waitForTimeout(rand(1000, 3000));
  
  log("dwell_complete", `${Math.round((Date.now() - startTime) / 1000)}s actual`);
}

// ── Browser Session Setup (shared by all journeys) ──────
async function setupBrowserSession(params, log) {
  const mobile = params.mobile || false;
  const geo = (params.proxyCity || params.proxy_city)
    ? {
        city: params.proxyCity || params.proxy_city,
        state: params.proxyState || params.proxy_state,
        country: params.proxyCountry || params.proxy_country || "United States",
      }
    : null;

  const proxyConfig = buildProxyUrl(mobile);
  log("proxy_configured", `${proxyConfig.type} — ${proxyConfig.username} → us.decodo.com:${proxyConfig.port}`);

  // Build Google URL
  let googleUrl = "https://www.google.com/?gl=us&hl=en";
  if (geo?.city && geo?.state) {
    const canonicalName = `${geo.city},${geo.state},${geo.country || "United States"}`;
    const uule = generateUule(canonicalName);
    googleUrl += `&uule=${uule}`;
    log("uule_generated", canonicalName);
  }

  // Launch browser
  const profileId = await createGoLoginProfile(mobile, proxyConfig);
  log("gologin_profile_created", profileId);

  const result = await launchGoLoginBrowser(profileId);
  log("gologin_browser_launched");

  const context = result.browser.contexts()[0] || await result.browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  // Inject cookies
  await injectCookies(context, log);

  // Navigate to Google
  await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  log("google_loaded");
  
  // Human landing behavior: look around the page first
  await page.waitForTimeout(rand(1500, 3500));
  await humanMouseMove(page, rand(300, 700), rand(200, 400));
  await page.waitForTimeout(rand(500, 1500));

  // Dismiss popups
  await dismissPopups(page, log);

  // Brief idle before interacting (like a real user orienting)
  await humanIdle(page, 500, 2000);

  // Check for captcha on landing
  const captchaOk = await handleCaptcha(page, context, proxyConfig, log);
  if (!captchaOk) {
    throw new Error("CAPTCHA on Google landing page — blocked");
  }

  // Dismiss cookie consent after captcha
  await dismissPopups(page, log);

  return { page, context, browser: result.browser, glApi: result.GL, profileId, proxyConfig };
}

// ── Search Google (type + enter + wait for results) ─────
async function searchGoogle(page, context, keyword, proxyConfig, log) {
  await focusSearchInput(page, log);
  await humanType(page, keyword, log);

  await page.waitForTimeout(rand(800, 2000));
  await page.keyboard.press("Enter");
  await page.waitForLoadState("domcontentloaded");
  log("search_submitted");

  // Wait for results (with captcha handling)
  try {
    await page.waitForSelector("#search, #rso, .g", { timeout: 15000 });
    log("results_rendered");
  } catch {
    const captchaOk = await handleCaptcha(page, context, proxyConfig, log);
    if (!captchaOk) throw new Error("CAPTCHA after search — blocked");
    await page.waitForSelector("#search, #rso, .g", { timeout: 15000 });
    log("results_rendered");
  }

  // Human behavior: scan results page — read snippets, move mouse around
  await page.waitForTimeout(rand(2000, 4000)); // Initial scan
  await humanMouseMove(page, rand(200, 600), rand(300, 500)); // Eyes moving down
  await page.waitForTimeout(rand(500, 1500));
  await humanScroll(page, rand(150, 350), log); // Scroll to see more results
  await page.waitForTimeout(rand(1000, 2500)); // Reading snippets
  log("scrolled_results");
}

// ── Cleanup ─────────────────────────────────────────────
async function cleanup(browser, glApi, profileId) {
  if (browser) await browser.close().catch(() => {});
  if (glApi) await glApi.stop().catch(() => {});
  if (profileId) {
    await deleteGoLoginProfile(profileId);
    console.log(`  🧹 GoLogin profile ${profileId} cleaned up`);
  }
}

module.exports = {
  CONFIG,
  GL_API,
  GL_HEADERS,
  rand,
  humanRand,
  generateUule,
  scoreMatch,
  createLogger,
  buildProxyUrl,
  getProxyInfo,
  solveRecaptcha,
  createGoLoginProfile,
  launchGoLoginBrowser,
  deleteGoLoginProfile,
  injectCookies,
  focusSearchInput,
  humanType,
  humanMouseMove,
  humanScroll,
  humanIdle,
  handleCaptcha,
  dismissPopups,
  dwell,
  setupBrowserSession,
  searchGoogle,
  cleanup,
};
