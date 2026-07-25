/*
 * Paddington Sports Club — tennis session auto-registration bot
 *
 * Books the "Level 3 - Coaching Group" session (Wed or Fri 10:00-12:00)
 * the moment registration opens (midnight Europe/London, 7 days ahead).
 *
 * PATCHED 2026-07-25:
 *  - FIX: waiting-list join now confirms the dialog's Book button (was left open)
 *  - FIX: waiting-list join is VERIFIED on a fresh page load before reporting success
 *  - FIX: "You are signed up" no longer conflates class signup with waitlist signup
 *  - NEW: after a verified waitlist join, keep watching for freed spots (churn)
 *    until POLL_ABORT_MIN past midnight, and book instantly if one appears
 *  - Faster endgame: 1s polling in the last 30s before midnight, reduced settle
 *
 * Env vars:
 *   CLUB_USER      Member ID (required)
 *   CLUB_PASS      Password  (required)
 *   TARGET         "wed" | "fri" | "auto"  (default: auto — Tue run books Wed, Thu run books Fri)
 *   DRY_RUN        "1" = go all the way to checkout but DO NOT pay; empties basket instead
 *   WAITLIST_OK    "1" = if session is already full, join the waiting list instead
 *   POLL_ABORT_MIN minutes past midnight to give up (default 75)
 *
 * Exit codes: 0 = booked (or dry-run ok / already booked / verified waitlist), 1 = failed/gave up
 */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'https://paddington.clubsolution.co.uk/newlook/proc_liste.asp';
const KURV = 'https://paddington.clubsolution.co.uk/newlook/proc_kurv.asp';
const CLASS_NAME = 'Level 3 - Coaching Group';
const OUT_DIR = process.env.OUT_DIR || 'out';
const log = (...a) => console.log(new Date().toISOString(), ...a);
// ---------- London-time helpers ----------
function londonNow() {
  // Returns {y,m,d,hh,mm,ss,weekday} for current Europe/London wall time
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
/** Clear any leftover items in the basket (e.g. from a previous crashed run). */
async function emptyBasketIfNeeded(page) {
  await page.goto(KURV, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/Your Basket is empty/i.test(body)) { log('Basket check: empty'); return; }
  log('WARN: basket not empty — clearing leftover items');
  await shot(page, '00-basket-leftover');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, span, a')].find(e => /Empty Basket/i.test(e.textContent || '') && e.offsetParent);
    if (b) b.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll('button, a, span')].find(el => /^\s*OK\s*$/.test(el.textContent || '') && el.offsetParent);
    if (ok) ok.click();
  });
  await page.waitForTimeout(1500);
  await shot(page, '00-basket-cleared');
}
/** Find the target session row. Returns a Locator or null. */
function targetRow(page, dateStr) {
  return page.locator('tr.infinite-item')
    .filter({ hasText: CLASS_NAME })
    .filter({ hasText: dateStr })
    .first();
}
/**
 * Classify the row's state.
 *   signedup    = booked into the class (done!)
 *   book        = a Book button is present (spot available — grab it)
 *   on-waitlist = we are registered on the waiting list (keep watching)
 *   waitlist    = class full, waiting-list button offered (join it)
 *   notopen     = row exists but booking not open yet
 *   missing     = row not found
 * NOTE: order matters — "book" is checked before "on-waitlist" so that a freed
 * spot is grabbed even when we are already on the waiting list.
 */
async function rowState(page, dateStr) {
  const row = targetRow(page, dateStr);
  if (await row.count() === 0) return { state: 'missing', row };
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  if (/You are signed up for this class/i.test(text)) return { state: 'signedup', row, text };
  const hasBook = await row.locator('span.onenter', { hasText: /^\s*Book\s*$/ }).count() > 0;
  if (hasBook) return { state: 'book', row, text };
  if (/You are signed up for Waiting List/i.test(text)) return { state: 'on-waitlist', row, text };
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
/**
 * Join the waiting list PROPERLY:
 * clicking the row's "Waiting list" button only OPENS a dialog ("Waiting List
 * Booking") with activation-window choices and its own Book button. The old code
 * stopped there, so the registration was never submitted. This clicks through.
 * Returns a status string for the log; the caller verifies on a fresh load.
 */
async function joinWaitlist(page, row) {
  await jsClickInRow(row, 'span.onenter', /Waiting list/);
  await page.waitForTimeout(1500);
  const status = await page.evaluate(() => {
    // Find the dialog: the smallest visible container holding the dialog text
    const containers = [...document.querySelectorAll('div, section, form')]
      .filter(d => d.offsetParent &&
        /waiting list (booking|registration)/i.test(d.textContent || ''));
    if (!containers.length) return 'dialog-not-found';
    containers.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const dlg = containers[0];
    // Pick the widest activation window offered (prefer "3 hours")
    const opt = [...dlg.querySelectorAll('button, span, a, label')]
      .find(e => /^\s*3 hours\s*$/i.test((e.textContent || '').trim()) && e.offsetParent);
    if (opt) opt.click();
    // Confirm with the dialog's own Book button (not Cancel, not a row button)
    const book = [...dlg.querySelectorAll('.btn, button, span, a')]
      .find(e => {
        const t = (e.textContent || '').trim();
        return /Book/i.test(t) && t.length <= 10 && !/Cancel/i.test(t) && e.offsetParent;
      });
    if (!book) return 'book-button-not-found';
    book.click();
    return 'submitted';
  });
  await page.waitForTimeout(2500);
  return status;
}
async function checkout(page, dateStr, dryRun) {
  // We should now be on proc_kurv.asp (basket)
  await page.waitForURL(/proc_kurv\.asp/i, { timeout: 20000 });
  await page.waitForTimeout(300);
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  if (!body.includes(CLASS_NAME)) throw new Error('Basket does not contain the expected class');
  if (!new RegExp(dateStr.split(' ')[1]).test(body)) log('WARN: basket date check inconclusive');
  // Tick the T&C checkbox. NOTE: it's #acc_beting, a 0x0 opacity-0 input —
  // invisible to :visible filters, so it must be JS-clicked directly.
  const tickResult = await page.evaluate(() => {
    let cb = document.querySelector('#acc_beting');
    if (!cb) {
      cb = [...document.querySelectorAll('input[type="checkbox"]')].find(b =>
        /I have read and accept/i.test(((b.closest('label,div,td,p') || {}).textContent) || ''));
    }
    if (!cb) return 'not-found';
    if (!cb.checked) cb.click();
    return cb.checked ? 'checked' : 'failed-to-check';
  });
  log('T&C checkbox:', tickResult);
  if (tickResult !== 'checked') throw new Error('Could not tick T&C checkbox: ' + tickResult);
  await shot(page, '03-basket');
  await page.waitForTimeout(300);
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
  // COMPLETE the booking. The action button that appears depends on the account
  // balance and only renders AFTER an async balance check — so poll for it:
  //   - "Confirm Booking"   => the prepaid balance covers the fee (pay from balance)
  //   - "Use your card"     => pay with the saved card
  //   - "Proceed to Payment"=> generic checkout (card) fallback
  // Preference order per user: use balance if available, else card.
  const PAY_LABELS = ['Confirm Booking', 'Use your card', 'Proceed to Payment'];
  let clicked = null;
  for (let i = 0; i < 50 && !clicked; i++) {      // up to ~25s
    clicked = await page.evaluate((labels) => {
      for (const label of labels) {
        const el = [...document.querySelectorAll('.btn, button, span, a')]
          .find(e => new RegExp('^\\s*' + label + '\\s*$', 'i').test((e.textContent || '').trim()) && e.offsetParent);
        if (el) { el.click(); return label; }
      }
      return null;
    }, PAY_LABELS);
    if (!clicked) await page.waitForTimeout(500);
  }
  if (!clicked) { await shot(page, '04-no-pay-button'); throw new Error('No payment/confirm button appeared'); }
  log('Clicked payment action:', clicked);
  await page.waitForTimeout(2000);
  await shot(page, '04-after-payment');
  // Some flows pop an "OK"/confirm dialog after the action button — accept it.
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll('button, a, span')]
      .find(el => /^\s*(OK|Confirm|Yes)\s*$/i.test((el.textContent || '').trim()) && el.offsetParent);
    if (ok) ok.click();
  });
  await page.waitForTimeout(2000);
  // Success heuristics: booked / receipt / basket empty / now on waiting-or-signed list
  for (let i = 0; i < 10; i++) {
    const after = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (/receipt|thank you|confirmed|booking confirmed|Your Basket is empty|You are signed up/i.test(after)) {
      await shot(page, '05-confirmed');
      return 'paid';
    }
    await page.waitForTimeout(1500);
  }
  await shot(page, '05-payment-late');
  return 'paid-unverified';
}
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!process.env.CLUB_USER || !process.env.CLUB_PASS) throw new Error('CLUB_USER/CLUB_PASS not set');
  const dryRun = process.env.DRY_RUN === '1';
  const waitlistOk = process.env.WAITLIST_OK === '1';
  const abortMin = +(process.env.POLL_ABORT_MIN || 75);
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
    await emptyBasketIfNeeded(page);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    await shot(page, '02-list');
    // -------- poll loop --------
    let attempt = 0;
    let result = null;
    let waitlisted = false;   // VERIFIED waiting-list registration exists
    let wlJoinTries = 0;
    // Deadline: abortMin past the *relevant* midnight. If we start just after
    // midnight (late backup run), count from the midnight that already passed;
    // always allow at least 5 minutes of polling.
    const s0 = secsToMidnightLondon();
    const sinceMidnight = 86400 - s0;
    let deadlineMs = s0 > 43200
      ? (abortMin * 60 - sinceMidnight) * 1000   // past midnight already
      : (s0 + abortMin * 60) * 1000;             // midnight still ahead
    deadlineMs = Math.max(deadlineMs, 5 * 60 * 1000);
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      attempt++;
      const { state, row, text } = await rowState(page, dateStr);
      const toMid = secsToMidnightLondon();
      log(`#${attempt} state=${state} (${toMid}s to London midnight)`);
      if (state === 'signedup') { result = waitlisted ? 'promoted-from-waitlist' : 'already-booked'; break; }
      if (state === 'book') {
        log('BOOK button present — booking now');
        await jsClickInRow(row, 'span.onenter', /^\s*Book\s*$/);
        for (let tryNo = 1; tryNo <= 2 && !result; tryNo++) {
          try {
            result = await checkout(page, dateStr, dryRun);
          } catch (e) {
            log(`Checkout attempt ${tryNo} error:`, e.message);
            await shot(page, `err-checkout-${tryNo}`);
            if (tryNo === 1) {
              // item should still be in the basket — reload it and retry once
              try { await page.goto(KURV, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(1500); } catch {}
            } else {
              result = 'checkout-failed';
            }
          }
        }
        break;
      }
      if (state === 'on-waitlist' && !waitlisted) {
        log('Waiting-list registration confirmed — will keep watching for a freed spot');
        waitlisted = true;
        await shot(page, '04-waitlist-verified');
      }
      if (state === 'waitlist' && !waitlisted) {
        if (dryRun) { log('DRY RUN: session is full; would join waiting list. Stopping.'); result = 'dry-run-ok'; break; }
        if (!waitlistOk) { log('Session full and WAITLIST_OK not set — giving up'); result = 'full'; break; }
        if (wlJoinTries >= 2) { result = 'waitlist-join-FAILED'; break; }
        wlJoinTries++;
        log(`Session full — joining waiting list (attempt ${wlJoinTries})`);
        const st = await joinWaitlist(page, row);
        log('Waitlist dialog:', st);
        await shot(page, `03-waitlist-join-${wlJoinTries}`);
        // verification happens on the next iteration's fresh page load
      }
      if (state === 'missing') log('WARN: target row not found in list');
      if (dryRun && state === 'notopen') {
        log('DRY RUN: registration for the target session is not open yet — stopping here (login, basket check and session detection all verified).');
        result = 'dry-run-ok';
        break;
      }
      // Adaptive polling: tight just before midnight, churn-watch just after it
      let wait;
      if (toMid <= 30) wait = 1;                    // final seconds: hammer it
      else if (toMid <= 90) wait = 3;
      else if (toMid <= 600) wait = 15;
      else if (toMid > 43200) wait = 10;            // past midnight: watch for freed spots
      else wait = 60;                               // long pre-midnight wait
      await page.waitForTimeout(wait * 1000);
      try {
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(wait <= 3 ? 300 : 1200);
      } catch (e) { log('reload failed, retrying:', e.message); }
    }
    if (!result) result = waitlisted ? 'waitlist-joined' : 'gave-up';
    log('RESULT:', result);
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `${result}\n${CLASS_NAME} ${dateStr}\n`);
    const ok = ['paid', 'paid-unverified', 'dry-run-ok', 'already-booked', 'promoted-from-waitlist', 'waitlist-joined'].includes(result);
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
