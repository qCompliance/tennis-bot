/**
 * Paddington Sports Club — tennis session auto-registration bot
 *
 * Books the "Level 3 - Coaching Group" session (Wed or Fri 10:00-12:00)
 * the moment registration opens (midnight Europe/London, 7 days ahead).
 *
 * Env vars:
 *   CLUB_USER      Member ID (required)
 *   CLUB_PASS      Password  (required)
 *   TARGET         "wed" | "fri" | "auto"  (default: auto — Tue run books Wed, Thu run books Fri)
 *   DRY_RUN        "1" = go all the way to checkout but DO NOT pay; empties basket instead
 *   WAITLIST_OK    "1" = if session is already full, join the waiting list instead
 *   POLL_ABORT_MIN minutes past midnight to give up (default 45)
 *
 * Exit codes: 0 = booked (or dry-run ok / already booked), 1 = failed/gave up
 */

const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'https://paddington.clubsolution.co.uk/newlook/proc_liste.asp';
const CLASS_NAME = 'Level 3 - Coaching Group';
const OUT_DIR = process.env.OUT_DIR || 'out';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- London-time helpers ----------
function londonNow() {
  // Returns {y,m,d,hh,mm,ss,weekday, dateObj} for current Europe/London wall time
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    hh: +parts.hour % 24, mm: +parts.minute, ss: +parts.second,
    weekday: parts.weekday, // "Mon".."Sun"
  };
}

function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
           weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()] };
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Decide which session date we are booking. */
function computeTarget() {
  const envTarget = (process.env.TARGET || 'auto').toLowerCase();
  const now = londonNow();
  let wantedDay; // "Wed" or "Fri"
  if (envTarget === 'wed') wantedDay = 'Wed';
  else if (envTarget === 'fri') wantedDay = 'Fri';
  else {
    // auto: Tue (or early-hours Wed) run -> Wed session; Thu (or early-hours Fri) run -> Fri
    if (now.weekday === 'Tue' || (now.weekday === 'Wed' && now.hh < 6)) wantedDay = 'Wed';
    else if (now.weekday === 'Thu' || (now.weekday === 'Fri' && now.hh < 6)) wantedDay = 'Fri';
    else throw new Error(`TARGET=auto but today (${now.weekday} London) is not a scheduled run day`);
  }
  // The newly-openable session is the wantedDay that lies 7 or 8 days ahead
  for (const n of [7, 8]) {
    const cand = addDays(now.y, now.m, now.d, n);
    if (cand.weekday === wantedDay) return cand;
  }
  // Fallback (dry-run testing on off-schedule days): nearest upcoming wantedDay
  if (process.env.DRY_RUN === '1') {
    for (let n = 1; n <= 6; n++) {
      const cand = addDays(now.y, now.m, now.d, n);
      if (cand.weekday === wantedDay) { log('DRY RUN fallback target (already-open session)'); return cand; }
    }
  }
  throw new Error('Could not compute target date');
}

/** Row-matching string like "Wed 22. Jul 2026" (as shown in the class list). */
const rowDateString = t => `${t.weekday} ${t.d}. ${MONTHS[t.m - 1]} ${t.y}`;

/** Seconds until next midnight in Europe/London (approx, wall-clock based). */
function secsToMidnightLondon() {
  const n = londonNow();
  return ((23 - n.hh) * 3600) + ((59 - n.mm) * 60) + (60 - n.ss);
}

// ---------- page helpers ----------
async function shot(page, name) {
  try { await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: true }); }
  catch (e) { log('screenshot failed', name, e.message); }
}

/** True once the user menu / basket appears in the navbar. */
async function isLoggedIn(page) {
  const t = (await page.locator('body').innerText().catch(() => '')) || '';
  return /BASKET/i.test(t) && !/^\s*$/.test(t);
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  if (await isLoggedIn(page)) { log('Already logged in'); return; }

  // Open the login modal (JS click — this site ignores synthetic mouse clicks)
  const loginLink = page.locator('a:has-text("LOGIN"), button:has-text("LOGIN")').first();
  await loginLink.waitFor({ state: 'attached', timeout: 15000 });
  await loginLink.evaluate(n => n.click());

  const user = page.getByPlaceholder('Member ID');
  await user.waitFor({ state: 'visible', timeout: 20000 });
  await user.click();
  await user.fill(process.env.CLUB_USER);
  const pw = page.locator('input[type="password"]:visible').first();
  await pw.click();
  await pw.fill(process.env.CLUB_PASS);
  await shot(page, '01-login-filled');

  // Submit via JS click on the modal's Login button (class "onenter"), fallback: Enter key
  const submit = page.locator('span.btn:has-text("Login"), button.btn:has-text("Login")').first();
  if (await submit.count() > 0) await submit.evaluate(n => n.click());
  else await pw.press('Enter');

  // Poll up to 15s for the navbar to switch to logged-in state
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    if (await isLoggedIn(page)) { log('Logged in OK'); return; }
  }
  // One retry: press Enter in the password field if the modal is still there
  if (await pw.isVisible().catch(() => false)) {
    await pw.press('Enter');
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      if (await isLoggedIn(page)) { log('Logged in OK (retry)'); return; }
    }
  }
  await shot(page, '01-login-failed');
  throw new Error('Login appears to have failed');
}

/** Find the target session row. Returns a Locator or null. */
function targetRow(page, dateStr) {
  return page.locator('tr.infinite-item')
    .filter({ hasText: CLASS_NAME })
    .filter({ hasText: dateStr })
    .first();
}

/** Classify the row's state: book | waitlist | signedup | notopen | missing */
async function rowState(page, dateStr) {
  const row = targetRow(page, dateStr);
  if (await row.count() === 0) return { state: 'missing', row };
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  if (/You are signed up/i.test(text)) return { state: 'signedup', row, text };
  const hasBook = await row.locator('span.onenter', { hasText: /^\s*Book\s*$/ }).count() > 0;
  if (hasBook) return { state: 'book', row, text };
  const hasWl = await row.locator('span.onenter', { hasText: /Waiting list/ }).count() > 0;
  if (hasWl) return { state: 'waitlist', row, text };
  return { state: 'notopen', row, text };
}

/** JS-click an element inside the row (native clicks are flaky on this site). */
async function jsClickInRow(row, selector, hasText) {
  const el = row.locator(selector, { hasText }).first();
  await el.waitFor({ state: 'attached', timeout: 5000 });
  await el.evaluate(node => node.click());
}

async function checkout(page, dateStr, dryRun) {
  // We should now be on proc_kurv.asp (basket)
  await page.waitForURL(/proc_kurv\.asp/i, { timeout: 20000 });
  await page.waitForTimeout(1000);
  await shot(page, '03-basket');
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  if (!body.includes(CLASS_NAME)) throw new Error('Basket does not contain the expected class');
  if (!new RegExp(dateStr.split(' ')[1]).test(body)) log('WARN: basket date check inconclusive');

  // Tick the T&C checkbox
  const tc = page.locator('input[type="checkbox"]').filter({ has: page.locator(':scope') });
  // find checkbox nearest the "I have read and accept" label
  const label = page.locator('text=/I have read and accept/i').first();
  await label.waitFor({ timeout: 10000 });
  const cb = page.locator('input[type="checkbox"]:visible').last();
  if (!(await cb.isChecked())) await cb.evaluate(n => { n.click(); });
  await page.waitForTimeout(500);

  if (dryRun) {
    log('DRY RUN: stopping before payment; emptying basket');
    await shot(page, '04-before-payment-DRY');
    // Remove item: red X in the row, then OK in the confirm dialog
    await page.locator('span.btn-danger, button.btn-danger').first().evaluate(n => n.click());
    await page.waitForTimeout(1000);
    const ok = page.locator('button:visible, a:visible, span:visible', { hasText: /^\s*OK\s*$/ }).first();
    if (await ok.count() > 0) await ok.evaluate(n => n.click());
    await page.waitForTimeout(1500);
    await shot(page, '05-basket-emptied-DRY');
    return 'dry-run-ok';
  }

  // PAY with card on file
  const payBtn = page.locator('.btn:visible', { hasText: /Use your card/i }).first();
  await payBtn.waitFor({ timeout: 10000 });
  await payBtn.evaluate(n => n.click());
  log('Clicked "Use your card"');
  await page.waitForTimeout(6000);
  await shot(page, '04-after-payment');

  // Success heuristics: basket empty / receipt / no longer on kurv with item
  const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  if (/receipt|thank you|confirmed|Your Basket is empty/i.test(after)) return 'paid';
  // Possibly a payment-gateway page appeared; give it time and screenshot
  await page.waitForTimeout(10000);
  await shot(page, '05-payment-late');
  return 'paid-unverified';
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!process.env.CLUB_USER || !process.env.CLUB_PASS) throw new Error('CLUB_USER/CLUB_PASS not set');
  const dryRun = process.env.DRY_RUN === '1';
  const waitlistOk = process.env.WAITLIST_OK === '1';
  const abortMin = +(process.env.POLL_ABORT_MIN || 45);

  const target = computeTarget();
  const dateStr = rowDateString(target);
  log(`Target session: "${CLASS_NAME}" on ${dateStr} 10:00 | dryRun=${dryRun} waitlistOk=${waitlistOk}`);

  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    timezoneId: 'Europe/London',
  });
  const page = await ctx.newPage();

  try {
    await login(page);
    await shot(page, '02-list');

    // -------- poll loop --------
    let attempt = 0;
    let result = null;
    const deadline = Date.now() + (secsToMidnightLondon() + abortMin * 60) * 1000;
    while (Date.now() < deadline) {
      attempt++;
      const { state, row, text } = await rowState(page, dateStr);
      const toMid = secsToMidnightLondon();
      log(`#${attempt} state=${state} (${toMid}s to London midnight)`);

      if (state === 'signedup') { result = 'already-booked'; break; }

      if (state === 'book') {
        log('BOOK button present — booking now');
        await jsClickInRow(row, 'span.onenter', /^\s*Book\s*$/);
        try {
          result = await checkout(page, dateStr, dryRun);
        } catch (e) {
          log('Checkout error:', e.message); await shot(page, 'err-checkout');
          result = 'checkout-failed';
        }
        break;
      }

      if (state === 'waitlist') {
        if (dryRun) { log('DRY RUN: session is full; would join waiting list. Stopping.'); result = 'dry-run-ok'; break; }
        // Only join waiting list once booking has actually opened (i.e. it's full), not before
        if (waitlistOk) {
          log('Session full — joining waiting list');
          await jsClickInRow(row, 'span.onenter', /Waiting list/);
          await page.waitForTimeout(3000);
          await shot(page, '03-waitlist');
          result = 'waitlist-joined';
          break;
        } else {
          log('Session full and WAITLIST_OK not set — giving up');
          result = 'full';
          break;
        }
      }

      if (state === 'missing') log('WARN: target row not found in list');

      // adaptive polling: tight around midnight, relaxed before
      const wait = toMid > 600 ? 60 : toMid > 90 ? 15 : toMid > 8 ? 5 : 2;
      await page.waitForTimeout(wait * 1000);
      try {
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1200);
      } catch (e) { log('reload failed, retrying:', e.message); }
    }

    if (!result) result = 'gave-up';
    log('RESULT:', result);
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `${result}\n${CLASS_NAME} ${dateStr}\n`);
    const ok = ['paid', 'paid-unverified', 'dry-run-ok', 'already-booked', 'waitlist-joined'].includes(result);
    await browser.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    log('FATAL:', e.message);
    await shot(page, 'err-fatal');
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `fatal: ${e.message}\n`);
    await browser.close();
    process.exit(1);
  }
})();
