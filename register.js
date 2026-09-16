/*
 * Paddington Sports Club — tennis session auto-registration bot
 *
 * Books the "Level 3 - Coaching Group" sessions (Wed and/or Fri 10:00-12:00).
 *
 * REDESIGNED 2026-09-16:
 *  - Sessions here become bookable ~2 weeks ahead (NOT in a seconds-long window
 *    at midnight/10:00). The old "poll for an opening instant then give up" model
 *    chased a moment that never comes and produced constant false-failure emails.
 *  - New model: every run, scan the class list for the target weekday Level 3
 *    sessions within the horizon and BOOK any that are currently bookable and not
 *    already booked. Run this several times a day so new sessions get grabbed soon
 *    after they open.
 *  - "Nothing to book" (all already booked, or none open yet) is SUCCESS, not a
 *    failure. Only genuine errors (login/checkout/fatal) fail the run.
 *
 * Env vars:
 *   CLUB_USER      Member ID (required)
 *   CLUB_PASS      Password  (required)
 *   TARGET         "wed" | "fri" | "both"  (default: both)
 *   HORIZON_DAYS   how many days ahead to book (default 15 — covers ~2 weeks)
 *   DRY_RUN        "1" = go all the way to checkout but DO NOT pay; empties basket
 *   WAITLIST_OK    "1" = if a target session is already full, join the waiting list
 *                  (a refundable fee applies). Default OFF.
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
  // Returns {y,m,d,hh,mm,ss,weekday} for current Europe/London wall time
  const fmt = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
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

/** Load the class list and scroll to lazy-load rows until every wanted date
 *  string is present, or row count stops growing. */
async function loadListCovering(page, wantedDateStrs) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  let lastCount = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (wantedDateStrs.length && wantedDateStrs.every(ds => body.includes(ds))) break;
    const count = await page.locator('tr.infinite-item').count();
    if (count === lastCount) { if (++stable >= 3) break; }
    else { stable = 0; lastCount = count; }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
}

/** Find the target session row. Returns a Locator. */
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
 *   on-waitlist = we are registered on the waiting list
 *   waitlist    = class full, waiting-list button offered (join it)
 *   full        = fully booked, waiting list also full (nothing to do)
 *   notopen     = row exists but no actionable control yet
 *   missing     = row not found
 * NOTE: "book" is checked before "on-waitlist" so a freed spot is grabbed even
 * when we are already on the waiting list.
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

/** JS-click an element inside the row (native clicks are flaky on this site). */
async function jsClickInRow(row, selector, hasText) {
  const el = row.locator(selector, { hasText }).first();
  await el.waitFor({ state: 'attached', timeout: 5000 });
  await el.evaluate(node => node.click());
}

/**
 * Join the waiting list PROPERLY: clicking the row's "Waiting list" button only
 * OPENS a dialog with activation-window choices and its own Book button; this
 * clicks through and then completes the (refundable) checkout.
 */
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
  //   - "Confirm Booking"    => the prepaid balance covers the fee (pay from balance)
  //   - "Use your card"      => pay with the saved card
  //   - "Proceed to Payment" => generic checkout (card) fallback
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
  const wanted = targetDateStrings();
  log(`Scan: "${CLASS_NAME}" | targets: ${wanted.join(' | ') || '(none)'} | dryRun=${dryRun} waitlistOk=${waitlistOk}`);

  const booked = [];        // newly booked this run
  const waitlisted = [];    // newly joined waiting list this run
  const already = [];       // already booked / already on waitlist
  const unavailable = [];   // full / not open / not listed yet
  const errors = [];        // real failures

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

    for (const dateStr of wanted) {
      // Fresh list load before each target (a prior booking navigated away).
      await loadListCovering(page, [dateStr]);
      const { state, row } = await rowState(page, dateStr);
      log(`Target ${dateStr}: state=${state}`);

      if (state === 'signedup')      { already.push(`${dateStr} (booked)`);   continue; }
      if (state === 'on-waitlist')   { already.push(`${dateStr} (waitlist)`); continue; }
      if (state === 'missing' || state === 'notopen') { unavailable.push(`${dateStr} (not open yet)`); continue; }

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
        if (outcome === 'paid' || outcome === 'paid-unverified') booked.push(dateStr);
        else if (outcome === 'dry-run-ok') booked.push(`${dateStr} (dry-run)`);
        else errors.push(`${dateStr}: ${outcome}`);
        continue;
      }

      if (state === 'full' || state === 'waitlist') {
        if (state === 'waitlist' && waitlistOk && !dryRun) {
          log(`  Session full — joining waiting list for ${dateStr}`);
          const st = await joinWaitlist(page, row, dateStr);
          log('  Waitlist result:', st);
          if (st === 'paid' || st === 'paid-unverified') waitlisted.push(dateStr);
          else errors.push(`${dateStr}: waitlist ${st}`);
        } else {
          unavailable.push(`${dateStr} (full)`);
        }
        continue;
      }
    }

    // ---- summarise ----
    const lines = [];
    lines.push(`booked: ${booked.length ? booked.join(', ') : 'none'}`);
    if (waitlisted.length) lines.push(`waitlisted: ${waitlisted.join(', ')}`);
    if (already.length)    lines.push(`already had: ${already.join(', ')}`);
    if (unavailable.length) lines.push(`not bookable: ${unavailable.join(', ')}`);
    if (errors.length)     lines.push(`errors: ${errors.join(', ')}`);
    const summary = lines.join('\n');
    log('SUMMARY:\n' + summary);

    // First line is a machine-readable status for the notify step:
    //   NOTIFY  -> something worth an email happened (a booking, or an error)
    //   QUIET   -> nothing new; no email
    const noteworthy = booked.length > 0 || waitlisted.length > 0 || errors.length > 0;
    const status = noteworthy
      ? `NOTIFY ${errors.length ? 'ERROR' : 'BOOKED'}`
      : 'QUIET';
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `${status}\n${summary}\n`);

    await browser.close();
    // Only fail the run on a REAL error, so "nothing to book" never emails a failure.
    process.exit(errors.length ? 1 : 0);
  } catch (e) {
    log('FATAL:', e.message);
    await shot(page, 'err-fatal');
    fs.writeFileSync(`${OUT_DIR}/result.txt`, `NOTIFY ERROR\nfatal: ${e.message}\n`);
    await browser.close();
    process.exit(1);
  }
})();
