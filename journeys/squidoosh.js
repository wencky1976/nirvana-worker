/**
 * Squidoosh Journey — Search + Maps Pack + Organic
 * 
 * Google search → scan Maps pack → scan organic → click target → dwell
 * This is the default "Search Push" journey.
 */

const { rand, scoreMatch, createLogger, setupBrowserSession, searchGoogle, dwell, cleanup } = require("../lib/shared");

async function run(job) {
  const startTime = Date.now();
  const { steps, log } = createLogger(startTime);
  const params = job.params || {};
  const keyword = params.keyword || "";
  const targetBusiness = params.targetBusiness || params.target_business || "";
  const targetUrl = params.targetUrl || params.target_url || "";
  const dwellTimeMs = params.dwellTimeMs || params.dwell_time_ms || rand(15000, 45000);

  let session;
  try {
    // Setup browser + navigate to Google + search
    session = await setupBrowserSession(params, log);
    const { page, context, proxyConfig } = session;
    await searchGoogle(page, context, keyword, proxyConfig, log);

    let found = false;
    let clickedRank = 0;

    // Strategy 1: Maps/Local Pack
    const mapsPack = page.locator('[data-local-attribute="d3bn"] a, .VkpGBb a, div.rllt__details a, a[data-cid]');
    const mapsCount = await mapsPack.count();
    if (mapsCount > 0) {
      log("maps_pack_found", `${mapsCount} local results`);
      for (let i = 0; i < mapsCount; i++) {
        const el = mapsPack.nth(i);
        const txt = (await el.textContent()) || "";
        const href = (await el.getAttribute("href")) || "";
        if (scoreMatch(txt, href, targetBusiness, targetUrl) >= 50) {
          await el.scrollIntoViewIfNeeded();
          await page.waitForTimeout(rand(500, 1200));
          await el.click();
          found = true;
          clickedRank = i + 1;
          log("maps_target_clicked", `pos ${i + 1}: ${txt.slice(0, 100)}`);
          break;
        }
      }
    }

    // Strategy 2: Organic results
    if (!found) {
      const h3s = page.locator("#search a h3, #rso a h3");
      const orgCount = await h3s.count();
      log("organic_results", `${orgCount} results`);
      for (let i = 0; i < orgCount; i++) {
        const h3 = h3s.nth(i);
        const link = h3.locator("xpath=ancestor::a");
        const txt = (await h3.textContent()) || "";
        const href = (await link.getAttribute("href").catch(() => "")) || "";
        if (scoreMatch(txt, href, targetBusiness, targetUrl) >= 50) {
          await link.scrollIntoViewIfNeeded();
          await page.waitForTimeout(rand(500, 1200));
          await link.click();
          found = true;
          clickedRank = i + 1;
          log("organic_target_clicked", `pos ${i + 1}: ${txt.slice(0, 100)}`);
          break;
        }
      }
    }

    // Strategy 3: Broad scan
    if (!found) {
      const allLinks = page.locator("#search a[href]");
      const linkCount = await allLinks.count();
      for (let i = 0; i < linkCount; i++) {
        const el = allLinks.nth(i);
        const txt = (await el.textContent()) || "";
        const href = (await el.getAttribute("href")) || "";
        if (txt.trim().length < 3) continue;
        if (scoreMatch(txt, href, targetBusiness, targetUrl) >= 50) {
          await el.scrollIntoViewIfNeeded();
          await page.waitForTimeout(rand(500, 1200));
          await el.click();
          found = true;
          clickedRank = i + 1;
          log("broad_target_clicked", `pos ${i + 1}: ${txt.slice(0, 100)}`);
          break;
        }
      }
    }

    if (!found) {
      const pageTitle = await page.title();
      log("target_not_found", `"${targetBusiness}" not in results. Title: "${pageTitle}"`);
      return { success: true, found: false, clickedRank: 0, steps, duration_ms: Date.now() - startTime };
    }

    // Dwell on target
    await dwell(page, dwellTimeMs, log);
    return { success: true, found: true, clickedRank, steps, duration_ms: Date.now() - startTime };

  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    log("error", errDetail);
    return { success: false, found: false, steps, error: errDetail, duration_ms: Date.now() - startTime };
  } finally {
    if (session) await cleanup(session.browser, session.glApi, session.profileId);
  }
}

module.exports = { run };
