/*
 * Paddington Sports Club — tennis session auto-registration bot
 *
 * Books the "Level 3 - Coaching Group" sessions (Wed and/or Fri 10:00-12:00).
 *
 * REDESIGNED 2026-09-16:
 *  - Booking opens exactly 7 days before each session (same weekday), around
 *    midday, and the popular Level 3 sessions sell out fast. So on a session's
 *    OPEN DAY we poll hard and grab it the instant it opens; other days we just
 *    do a light scan (to catch any freed spots / already-open sessions).
 *  - "Nothing to book" (all already booked, or none open yet) is SUCCESS, not a
 *    failure. Only genuine errors (login/checkout/fatal) fail the run.
 *
 * Env vars:
 *   CLUB_USER          Member ID (required)
 *   CLUB_PASS          Password  (required)
 *   TARGET             "wed" | "fri" | "both"  (default: both)
 *   HORIZON_DAYS       how many days ahead to consider (default 15)
 *   WATCH              "1" = poll mode: keep checking every WATCH_INTERVAL_SEC
 *                      seconds until the day's opening session is grabbed/sold,
 *                      logging each check (this pins the exact open time).
 *   WATCH_MINUTES      max minutes to poll in WATCH mode (default 300)
 *   WATCH_INTERVAL_SEC seconds between polls in WATCH mode (default 15)
 *   DRY_RUN            "1" = reach checkout but DO NOT pay; empties basket
 *   WAITLIST_OK        "1" = if a target session is already full, join the
 *                      waiting list (a refundable fee applies). Default OFF.
 *
 * Exit codes: 0 = ran cleanly (booked something OR nothing to do), 1 = real error.
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
  const fmt = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    hh: +parts.hour % 24, mm: +parts.minute, ss: +parts.second,
    weekday: parts.weekday,
  };
}
function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
           weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()] };
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Row-matching string like "Wed 23. Sep 2026". */
const rowDateString = t => `${t.weekday} ${t.d}. ${MONTHS[t.m - 1]} ${t.y}`;

/** All target session date strings within the horizon (chronological). */
function targetDateStrings() {
  const envTarget = (process.env.TARGET || 'both').toLowerCase();
  const wantWed = envTarget === 'both' || envTarget === 'wed';
  const wantFri = envTarget === 'both' || envTarget === 'fri';
  const horizon = +(process.env.HORIZON_DAYS || 15);
  const now = londonNow();
  const out = [];
  for (let n = 1; n <= horizon; n++) {
    const c = addDays(now.y, now.m, now.d, n);
    if ((wantWed && c.weekday === 'Wed') || (wantFri && c.weekday === 'Fri')) {
      out.push(rowDateString(c));
    }
  }
  return out;
}

/** True if `dateStr` is a session whose booking opens TODAY (7 days before). */
function opensToday(dateStr) {
  const now = londonNow();
  return rowDateString(addDays(now.y, now.m, now.d, 7)) === dateStr;
}

// ---------- page helpers ----------
async function shot(page, name) {
  try { await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: true }); }
  catch (e) { log('screenshot failed', name, e.message); }
}

async function isLoggedIn(page) {
  const t = (await page.locator('body').innerText().catch(() => '')) || '';
  return /BASKET/i.test(t) && !/^\s*$/.test(t);
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  if (await isLoggedIn(page)) { log('Already logged in'); return; }
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
  const submit = page.locator('span.btn:has-text("Login"), button.btn:has-text("Login")').first();
  if (await submit.count() > 0) await submit.evaluate(n => n.click());
  else await pw.press('Enter');
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    if (await isLoggedIn(page)) { log('Logged in OK'); return; }
  }
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

/** Load the class list and scroll to lazy-load rows until every wanted date
 *  string is present, or row count stops growing. */
async function loadListCovering(page, wantedDateStrs) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  let lastCount = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (wantedDateStrs.length && wantedDateStrs.every(ds => body.includes(ds))) break;
    const count = await page.locator('tr.infinite-item').count();
    if (count === lastCount) { if (++stable >= 3) break; }
    else { stable = 0; lastCount = count; }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
  }
}

function targetRow(page, dateStr) {
  return page.locator('tr.infinite-item')
    .filter({ hasText: CLASS_NAME })
    .filter({ hasText: dateStr })
    .first();
}

/**
 * Classify the row's state:
 *   signedup / book / on-waitlist / waitlist / full / notopen / missing
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
  if (/Fully booked/i.test(text)) return { state: 'full', row, text };
  return { state: 'notopen', row, text };
}

async function jsClickInRow(row, selector, hasText) {
  const el = row.locator(selector, { hasText }).first();
  await el.waitFor({ state: 'attached', timeout: 5000 });
  await el.evaluate(node => node.click());
}

async function joinWaitlist(page, row, dateStr) {
  await jsClickInRow(row, 'span.onenter', /Waiting list/);
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => {
    const vis = el => el && el.offsetParent;
    const cancel = [...document.querySelectorAll('.btn, button, span, a')]
      .find(e => /^\s*Cancel\s*$/i.test((e.textContent || '').trim()) && vis(e));
    let dlg = null;
    for (let n = cancel; n && !dlg; n = n.parentElement) {
      if (/Waiting List Booking|before the class begins/i.test(n.textContent || '')) dlg = n;
    }
    const scope = dlg || document;
    const opt = [...scope.querySelectorAll('button, span, a, label')]
      .find(e => /^\s*3 hours\s*$/i.test((e.textContent || '').trim()) && vis(e));
    if (opt) opt.click();
    const book = [...scope.querySelectorAll('.btn, button, span, a')]
      .find(e => /^\s*Book\s*$/i.test((e.textContent || '').trim()) && vis(e) && !e.closest('tr.infinite-item'));
    if (!book) return 'book-button-not-found';
    book.click();
    return 'submitted';
  });
  if (st !== 'submitted') return st;
  try {
    return await checkout(page, dateStr, false);
  } catch (e) {
    log('Waitlist checkout error:', e.message);
    await shot(page, 'err-waitlist-checkout');
    return 'waitlist-checkout-failed';
  }
}

async function checkout(page, dateStr, dryRun) {
  await page.waitForURL(/proc_kurv\.asp/i, { timeout: 20000 });
  await page.waitForTimeout(300);
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  if (!body.includes(CLASS_NAME)) throw new Error('Basket does not contain the expected class');
  if (!new RegExp(dateStr.split(' ')[1]).test(body)) log('WARN: basket date check inconclusive');
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
    await page.locator('span.btn-danger, button.btn-danger').first().evaluate(n => n.click());
    await page.waitForTimeout(1000);
    const ok = page.locator('button:visible, a:visible, span:visible', { hasText: /^\s*OK\s*$/ }).first();
    if (await ok.count() > 0) await ok.evaluate(n => n.click());
    await page.waitForTimeout(1500);
    await shot(page, '05-basket-emptied-DRY');
    return 'dry-run-ok';
  }
  const PAY_LABELS = ['Confirm Booking', 'Use your card', 'Proceed to Payment'];
  let clicked = null;
  for (let i = 0; i < 50 && !clicked; i++) {
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
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll('button, a, span')]
      .find(el => /^\s*(OK|Confirm|Yes)\s*$/i.test((el.textContent || '').trim()) && el.offsetParent);
    if (ok) ok.click();
  });
  await page.waitForTimeout(2000);
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

/**
 * Resolve one target: check its state and act.
 * Returns { done, bucket, note } where bucket is one of
 * booked|waitlisted|already|unavailable|errors, and done=true means we should
 * stop tracking it (a notopen session that opens today stays done=false so the
 * WATCH loop keeps polling it).
 */
async function processTarget(page, dateStr, { dryRun, waitlistOk }) {
  await loadListCovering(page, [dateStr]);
  const { state, row } = await rowState(page, dateStr);
  log(`  ${dateStr}: state=${state}`);

  if (state === 'signedup')    return { done: true, bucket: 'already', note: `${dateStr} (booked)` };
  if (state === 'on-waitlist') return { done: true, bucket: 'already', note: `${dateStr} (waitlist)` };

  if (state === 'book') {
    log(`  BOOK available — booking ${dateStr}`);
    await jsClickInRow(row, 'span.onenter', /^\s*Book\s*$/);
    let outcome = null;
    for (let tryNo = 1; tryNo <= 2 && !outcome; tryNo++) {
      try {
        outcome = await checkout(page, dateStr, dryRun);
      } catch (e) {
        log(`  Checkout attempt ${tryNo} error:`, e.message);
        await shot(page, `err-checkout-${dateStr.replace(/\W+/g, '_')}-${tryNo}`);
        if (tryNo === 1) {
          try { await page.goto(KURV, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(1500); } catch {}
        } else {
          outcome = 'checkout-failed';
        }
      }
    }
    if (outcome === 'paid' || outcome === 'paid-unverified') return { done: true, bucket: 'booked', note: dateStr };
    if (outcome === 'dry-run-ok') return { done: true, bucket: 'booked', note: `${dateStr} (dry-run)` };
    return { done: true, bucket: 'errors', note: `${dateStr}: ${outcome}` };
  }

  if (state === 'waitlist') {
    if (waitlistOk && !dryRun) {
      log(`  Session full — joining waiting list for ${dateStr}`);
      const st = await joinWaitlist(page, row, dateStr);
      log('  Waitlist result:', st);
      if (st === 'paid' || st === 'paid-unverified') return { done: true, bucket: 'waitlisted', note: dateStr };
      return { done: true, bucket: 'errors', note: `${dateStr}: waitlist ${st}` };
    }
    return { done: true, bucket: 'unavailable', note: `${dateStr} (full — waitlist available)` };
  }

  if (state === 'full') return { done: true, bucket: 'unavailable', note: `${dateStr} (full)` };

  // notopen / missing: only keep polling (done=false) if it opens today.
  const keep = opensToday(dateStr);
  return { done: !keep, bucket: 'unavailable', note: `${dateStr} (not open yet)` };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!process.env.CLUB_USER || !process.env.CLUB_PASS) throw new Error('CLUB_USER/CLUB_PASS not set');
  const dryRun = process.env.DRY_RUN === '1';
  const waitlistOk = process.env.WAITLIST_OK === '1';
  const watch = process.env.WATCH === '1';
  const watchMs = +(process.env.WATCH_MINUTES || 300) * 60 * 1000;
  const intervalMs = +(process.env.WATCH_INTERVAL_SEC || 15) * 1000;
  const wanted = targetDateStrings();
  const openingToday = wanted.filter(opensToday);
  log(`Scan: "${CLASS_NAME}" | targets: ${wanted.join(' | ') || '(none)'}`);
  log(`Mode: ${watch ? 'WATCH' : 'scan'} | opening today: ${openingToday.join(', ') || 'none'} | dryRun=${dryRun} waitlistOk=${waitlistOk}`);

  const buckets = { booked: [], waitlisted: [], already: [], unavailable: [], errors: [] };
  const record = r => { buckets[r.bucket].push(r.note); };

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

    if (watch) {
      const deadline = Date.now() + watchMs;
      const pending = new Set(wanted);
      let pass = 0;
      while (pending.size && Date.now() < deadline) {
        pass++;
        const stillOpeningToday = [...pending].some(opensToday);
        for (const dateStr of [...pending]) {
          const r = await processTarget(page, dateStr, { dryRun, waitlistOk });
          if (r.done) { record(r); pending.delete(dateStr); }
        }
        if (![...pending].some(opensToday)) break;
        if (!stillOpeningToday) break;
        await page.waitForTimeout(intervalMs);
      }
      for (const dateStr of pending) buckets.unavailable.push(`${dateStr} (not open yet)`);
    } else {
      for (const dateStr of wanted) {
        const r = await processTarget(page, dateStr, { dryRun, waitlistOk });
        record(r);
      }
    }

    const lines = [];
    lines.push(`booked: ${buckets.booked.length ? buckets.booked.join(', ') : 'none'}`);
    if (buckets.waitlisted.length) lines.push(`waitlisted: ${buckets.waitlisted.join(', ')}`);
    if (buckets.already.length)    lines.push(`already had: ${buckets.already.join(', ')}`);
    if (buckets.unavailable.length) lines.push(`not bookable: ${[...new Set(buckets.unavailable)].join(', ')}`);
    if (buckets.errors.length)     lines.push(`errors: ${buckets.errors.join(', ')}`);
    const summary = lines.join('\n');
    log('SUMMARY:\n' + summary);

    const noteworthy = buckets.booked.length > 0 || buckets.waitlisted.length > 0 || buckets.errors.length > 0;
    const status = noteworthy
      ? `NOTIFY ${buckets.errors.length ? 'ERROR' : 'BOOKED'}`
      : 'QUIET';
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `${status}\n${summary}\n`);

    await browser.close();
    process.exit(buckets.errors.length ? 1 : 0);
  } catch (e) {
    log('FATAL:', e.message);
    await shot(page, 'err-fatal');
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `NOTIFY ERROR\nfatal: ${e.message}\n`);
    await browser.close();
    process.exit(1);
  }
})();
