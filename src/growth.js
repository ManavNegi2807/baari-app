// Growth features: booking guard, waitlist, live queue, clinic profile + QR poster, follow-ups and reviews.
// None of these send WhatsApp or SMS messages. Patients see updates on their own status page; clinics see what to do on the desk.
const crypto = require('crypto');

const SLOT_TIMES = [];
for (let h = 9; h < 17; h++) for (const m of [0, 30]) SLOT_TIMES.push(`${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`);
const HOLD_MS = 30 * 60 * 1000;
const VISIT_TYPES = ['consultation', 'follow-up', 'check-up', 'procedure'];
const ph = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const SQL_PHONE = "substr(replace(replace(replace(replace(replace(patient_phone, ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), -10)";
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newToken = () => crypto.randomBytes(12).toString('hex');
const TOKEN_RE = /^[a-f0-9]{24}$/;
const PRIORITY_MIN = 30; // a member may be called up to this many minutes ahead of their booked time
const minsOf = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const activeMemberPhones = (db, clinicId, today) => new Set(db.prepare("SELECT phone FROM memberships WHERE clinic_id = ? AND status = 'active' AND starts_on <= ? AND expires_on >= ? AND EXISTS (SELECT 1 FROM clinics WHERE id = ? AND plan_on = 1)").all(Number(clinicId), today, today, Number(clinicId)).map((r) => r.phone));
// queue order for the day: members move up by PRIORITY_MIN minutes, everyone else by booked time
const queueKey = (r, members) => minsOf(r.appointment_time) - (members.has(ph(r.patient_phone)) ? PRIORITY_MIN : 0);
const addDaysIso = (iso, n, isoDay) => { const [y, m, d] = iso.split('-').map(Number); return isoDay(new Date(y, m - 1, d + n)); };
// one place that creates a membership, used by the desk (cash/UPI) and by online payment
function grantMembership(db, isoDay, today, clinic, name, phone, amount, source, paymentId) {
  const last = db.prepare("SELECT MAX(expires_on) AS e FROM memberships WHERE clinic_id = ? AND phone = ? AND status = 'active'").get(clinic.id, phone).e;
  const start = last && last >= today ? addDaysIso(last, 1, isoDay) : today, end = addDaysIso(start, (clinic.plan_days || 30) - 1, isoDay);
  const r = db.prepare('INSERT INTO memberships (clinic_id, phone, patient_name, plan_name, amount, starts_on, expires_on, created_at, source, payment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clinic.id, phone, name, clinic.plan_name || 'Priority plan', amount, start, end, Date.now(), source, paymentId || null);
  return { id: Number(r.lastInsertRowid), starts_on: start, expires_on: end, renewed: start !== today };
}
// Razorpay (optional). Keys come from .env; nothing is sent anywhere unless both are set.
const rzpOn = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
// Demo payments: a pretend checkout that charges nothing. On by default only on a local set-up with no Razorpay keys and no PATIENT_HOST;
// DEMO_PAYMENTS=true forces it on, DEMO_PAYMENTS=false turns it off. It never works once real keys are set.
const demoOn = () => !rzpOn() && String(process.env.DEMO_PAYMENTS || '').toLowerCase() !== 'false' && (String(process.env.DEMO_PAYMENTS || '').toLowerCase() === 'true' || !process.env.PATIENT_HOST);
const rzpBase = () => (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/$/, '');
const hmacHex = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
const sameHex = (a, b) => { const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const byQueue = (members) => (a, b) => (queueKey(a, members) - queueKey(b, members)) || (a.id - b.id);

function migrate(db) {
  const addCols = (table, cols) => {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [n, d] of Object.entries(cols)) if (!have.has(n)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${n} ${d}`);
  };
  addCols('appointments', { visit_token: 'TEXT', visit_state: 'TEXT', state_at: 'INTEGER', follow_up_date: 'TEXT', follow_up_note: 'TEXT', follow_up_done: 'INTEGER DEFAULT 0' });
  addCols('clinics', { fees: 'TEXT', languages: 'TEXT', about: 'TEXT', maps_url: 'TEXT', avg_minutes: 'INTEGER DEFAULT 15',
    plan_on: 'INTEGER DEFAULT 0', plan_name: 'TEXT', plan_price: 'INTEGER DEFAULT 0', plan_days: 'INTEGER DEFAULT 30', plan_reserved: 'INTEGER DEFAULT 2', plan_cutoff_hours: 'INTEGER DEFAULT 3', plan_extra_days: 'INTEGER DEFAULT 7' });
  db.exec("UPDATE appointments SET visit_token = lower(hex(randomblob(12))) WHERE visit_token IS NULL");
  db.exec("CREATE TRIGGER IF NOT EXISTS appt_visit_token AFTER INSERT ON appointments WHEN NEW.visit_token IS NULL BEGIN UPDATE appointments SET visit_token = lower(hex(randomblob(12))) WHERE id = NEW.id; END");
  db.exec('CREATE INDEX IF NOT EXISTS idx_appt_token ON appointments(visit_token)');
  db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id INTEGER NOT NULL, wait_date TEXT NOT NULL, patient_name TEXT NOT NULL, patient_phone TEXT NOT NULL,
    visit_type TEXT NOT NULL, token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'waiting', offer_time TEXT, offered_at INTEGER,
    appointment_id INTEGER, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id INTEGER NOT NULL, phone TEXT NOT NULL, patient_name TEXT NOT NULL, plan_name TEXT, amount INTEGER DEFAULT 0,
    starts_on TEXT NOT NULL, expires_on TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL)`);
  addCols('memberships', { source: "TEXT DEFAULT 'desk'", payment_id: 'TEXT' });
  db.exec(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id INTEGER NOT NULL, phone TEXT NOT NULL, patient_name TEXT NOT NULL, amount INTEGER NOT NULL,
    order_id TEXT NOT NULL UNIQUE, payment_id TEXT, status TEXT NOT NULL DEFAULT 'created', membership_id INTEGER, created_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mem_lookup ON memberships(clinic_id, phone)');
  db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL UNIQUE, rating INTEGER NOT NULL,
    comment TEXT, hidden INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`);
}

function mountPublic(ctx) {
  const { app, db, wrap, bad, throttle, localToday, pad, isoDay, ALIVE, insertAppointment, publicDir, path } = ctx;
  migrate(db);

  /* ----- priority plan (set by each clinic; paid at the desk) ----- */
  const planOf = (clinicId) => { const c = db.prepare('SELECT id, plan_on, plan_name, plan_price, plan_days, plan_reserved, plan_cutoff_hours, plan_extra_days FROM clinics WHERE id = ?').get(Number(clinicId)); return c && c.plan_on ? c : null; };
  const isMember = (clinicId, phone) => {
    const p = ph(phone); if (p.length !== 10) return false;
    const t = localToday();
    return Boolean(db.prepare("SELECT 1 FROM memberships WHERE clinic_id = ? AND phone = ? AND status = 'active' AND starts_on <= ? AND expires_on >= ? AND EXISTS (SELECT 1 FROM clinics WHERE id = ? AND plan_on = 1)").get(Number(clinicId), p, t, t, Number(clinicId)));
  };
  const memberPhones = (clinicId) => activeMemberPhones(db, clinicId, localToday());
  // slots kept for members: the first N times of the day, until `cutoff` hours before the slot, then open to everyone
  function reservedTimes(clinicId, date) {
    const pl = planOf(clinicId), out = new Set();
    if (!pl || !(pl.plan_reserved > 0)) return out;
    const [y, mo, d] = String(date).split('-').map(Number), now = Date.now();
    for (const t of SLOT_TIMES.slice(0, Math.min(8, pl.plan_reserved))) {
      const [h, m] = t.split(':').map(Number);
      if (new Date(y, mo - 1, d, h, m).getTime() - now >= (pl.plan_cutoff_hours || 0) * 3600000) out.add(t);
    }
    return out;
  }
  const planPublic = (pl) => pl ? { online: (rzpOn() || demoOn()) && (pl.plan_price || 0) >= 1, demo: demoOn(), name: pl.plan_name || 'Priority plan', price: pl.plan_price || 0, days: pl.plan_days || 30, reserved: pl.plan_reserved || 0, cutoff_hours: pl.plan_cutoff_hours || 0, extra_days: pl.plan_extra_days || 0, skip_minutes: PRIORITY_MIN } : null;

  /* ----- slots, holds, waitlist ----- */
  function heldTimes(clinicId, date) {
    return new Set(db.prepare("SELECT offer_time FROM waitlist WHERE status = 'offered' AND clinic_id = ? AND wait_date = ? AND offered_at > ?").all(clinicId, date, Date.now() - HOLD_MS).map((r) => r.offer_time));
  }
  const held = (clinicId, date, time) => heldTimes(clinicId, date).has(time);
  function freeSlots(clinicId, date, member = true) {
    const today = localToday();
    if (date < today) return [];
    const resv = member ? new Set() : reservedTimes(clinicId, date);
    const taken = new Set(db.prepare(`SELECT appointment_time FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE}`).all(clinicId, date).map((r) => r.appointment_time));
    const hold = heldTimes(clinicId, date), now = new Date(), cutoff = now.getHours() * 60 + now.getMinutes() + 15;
    return SLOT_TIMES.filter((t) => {
      if (taken.has(t) || hold.has(t) || resv.has(t)) return false;
      if (date === today) { const [h, m] = t.split(':').map(Number); if (h * 60 + m < cutoff) return false; }
      return true;
    });
  }
  function advance() {
    const now = Date.now();
    db.prepare("UPDATE waitlist SET status = 'expired' WHERE status = 'offered' AND offered_at < ?").run(now - HOLD_MS);
    db.prepare("UPDATE waitlist SET status = 'expired' WHERE status IN ('waiting', 'offered') AND wait_date < ?").run(localToday());
    const groups = db.prepare("SELECT DISTINCT w.clinic_id, w.wait_date FROM waitlist w JOIN clinics c ON c.id = w.clinic_id WHERE w.status = 'waiting' AND COALESCE(c.status, 'active') = 'active'").all();
    for (const g of groups) {
      const free = freeSlots(g.clinic_id, g.wait_date);
      if (!free.length) continue;
      const mem = memberPhones(g.clinic_id), resv = reservedTimes(g.clinic_id, g.wait_date);
      const line = db.prepare("SELECT id, patient_phone FROM waitlist WHERE status = 'waiting' AND clinic_id = ? AND wait_date = ? ORDER BY id").all(g.clinic_id, g.wait_date)
        .map((w) => ({ id: w.id, m: mem.has(ph(w.patient_phone)) })).sort((a, b) => (Number(b.m) - Number(a.m)) || (a.id - b.id));
      for (const t of free) {
        const i = line.findIndex((w) => w.m || !resv.has(t)); // kept slots go to members only
        if (i < 0) continue;
        const w = line.splice(i, 1)[0];
        db.prepare("UPDATE waitlist SET status = 'offered', offer_time = ?, offered_at = ? WHERE id = ?").run(t, now, w.id);
      }
    }
  }
  setInterval(() => { try { advance(); } catch (e) { console.warn('Waitlist error:', e.message); } }, 30000).unref();

  /* ----- booking guard (replaces OTP: no message is sent to the patient) ----- */
  function guardBooking(req, b) {
    const cl = db.prepare("SELECT COALESCE(status, 'active') AS s FROM clinics WHERE id = ?").get(Number(b.clinic_id));
    if (cl && cl.s !== 'active') throw bad('This clinic is not taking online bookings right now.', 403);
    if (b.website) throw bad('Could not complete the booking.');
    if (!(Number(b.open_ms) >= 2000)) throw bad('Please check your details and try again.');
    const phone = ph(b.patient_phone);
    if (phone.length === 10) {
      throttle('bookp:' + phone, 6);
      const open = db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE ${SQL_PHONE} = ? AND ${ALIVE} AND appointment_date >= ?`).get(phone, localToday()).n;
      if (open >= 3) throw bad('This number already has 3 upcoming visits. Cancel one or call the clinic.', 429);
      const dup = db.prepare(`SELECT 1 FROM appointments WHERE ${SQL_PHONE} = ? AND ${ALIVE} AND clinic_id = ? AND appointment_date = ?`).get(phone, Number(b.clinic_id), b.appointment_date);
      if (dup) throw bad('You already have a visit at this clinic that day.', 409);
    }
    const pl = planOf(b.clinic_id);
    if (pl && !isMember(b.clinic_id, phone)) {
      const t = new Date(), far = isoDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 7));
      if (reservedTimes(Number(b.clinic_id), b.appointment_date).has(b.appointment_time)) throw bad(`That time is kept for priority members until ${pl.plan_cutoff_hours} hours before. Pick another time.`, 403);
      if (b.appointment_date > far) throw bad('Only priority members can book more than a week ahead. Pick an earlier day.', 403);
    }
  }

  /* ----- ratings ----- */
  const rating = (clinicId) => {
    const r = db.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE clinic_id = ? AND hidden = 0').get(clinicId);
    return { rating_count: r.n, rating_avg: r.n ? Math.round(r.avg * 10) / 10 : null };
  };

  const activeClinic = (id) => db.prepare("SELECT * FROM clinics WHERE id = ? AND COALESCE(status, 'active') = 'active'").get(Number(id));
  const mapsLink = (c) => {
    if (c.maps_url && /^https:\/\/[^\s]{1,280}$/.test(c.maps_url)) return c.maps_url;
    if (c.latitude != null && c.longitude != null) return `https://www.google.com/maps?q=${c.latitude},${c.longitude}`;
    return null;
  };

  /* ----- waitlist (patient side) ----- */
  app.post('/api/patient/waitlist', wrap((req, res) => {
    throttle('wl:' + req.ip, 15);
    const b = req.body || {};
    if (b.website || !(Number(b.open_ms) >= 2000)) throw bad('Please check your details and try again.');
    const clinic = activeClinic(b.clinic_id);
    if (!clinic) throw bad('Clinic not found.', 404);
    const date = String(b.date || '');
    const last = isoDay(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 7));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < localToday() || date > last) throw bad('Choose a day in the next 7 days.');
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw bad('Enter your name.');
    const phone = ph(b.phone);
    if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number.');
    if (!VISIT_TYPES.includes(b.visit_type)) throw bad('Choose a reason for the visit.');
    throttle('wlp:' + phone, 6);
    advance();
    if (freeSlots(clinic.id, date, isMember(clinic.id, phone)).length) throw bad('There are still free times that day. Pick one and book it.', 409);
    const same = db.prepare(`SELECT token FROM waitlist WHERE status IN ('waiting', 'offered') AND clinic_id = ? AND wait_date = ? AND ${SQL_PHONE} = ?`).get(clinic.id, date, phone);
    if (same) return res.json({ token: same.token });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE status IN ('waiting', 'offered') AND ${SQL_PHONE} = ?`).get(phone).n;
    if (n >= 3) throw bad('This number is already on 3 waitlists. Cancel one first.', 429);
    const token = newToken();
    db.prepare('INSERT INTO waitlist (clinic_id, wait_date, patient_name, patient_phone, visit_type, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(clinic.id, date, name, '+91 ' + phone.slice(0, 5) + ' ' + phone.slice(5), b.visit_type, token, Date.now());
    res.json({ token });
  }));
  const waitRow = (t) => { if (!TOKEN_RE.test(String(t))) throw bad('Not found', 404); const w = db.prepare('SELECT w.*, c.name AS clinic_name, c.doctor_name, c.location FROM waitlist w JOIN clinics c ON c.id = w.clinic_id WHERE w.token = ?').get(t); if (!w) throw bad('Not found', 404); return w; };
  app.get('/api/patient/waitlist/:token', wrap((req, res) => {
    throttle('wls:' + req.ip, 300);
    advance();
    const w = waitRow(req.params.token);
    let ahead = 0;
    if (w.status === 'waiting') {
      const mem = memberPhones(w.clinic_id), mine = mem.has(ph(w.patient_phone));
      ahead = db.prepare("SELECT id, patient_phone FROM waitlist WHERE status = 'waiting' AND clinic_id = ? AND wait_date = ? AND id != ?").all(w.clinic_id, w.wait_date, w.id)
        .filter((o) => { const om = mem.has(ph(o.patient_phone)); return om === mine ? o.id < w.id : om; }).length;
    }
    const left = w.status === 'offered' ? Math.max(0, Math.ceil((w.offered_at + HOLD_MS - Date.now()) / 60000)) : 0;
    let visit_token = null;
    if (w.status === 'booked' && w.appointment_id) visit_token = (db.prepare('SELECT visit_token FROM appointments WHERE id = ?').get(w.appointment_id) || {}).visit_token || null;
    res.json({ status: w.status, clinic_id: w.clinic_id, clinic_name: w.clinic_name, doctor_name: w.doctor_name, location: w.location, date: w.wait_date, name: w.patient_name.split(' ')[0],
      offer_time: w.status === 'offered' ? w.offer_time : null, minutes_left: left, position: ahead + 1, priority: isMember(w.clinic_id, w.patient_phone), visit_token });
  }));
  app.post('/api/patient/waitlist/:token/claim', wrap((req, res) => {
    throttle('wlc:' + req.ip, 20);
    advance();
    const w = waitRow(req.params.token);
    if (w.status !== 'offered') throw bad('This offer is no longer available.', 409);
    const id = insertAppointment({ clinic_id: w.clinic_id, patient_name: w.patient_name, patient_phone: w.patient_phone, appointment_date: w.wait_date, appointment_time: w.offer_time, visit_type: w.visit_type }, 'pending', { skipHold: true });
    db.prepare("UPDATE waitlist SET status = 'booked', appointment_id = ? WHERE id = ?").run(id, w.id);
    res.json({ appointment_id: id, visit_token: db.prepare('SELECT visit_token FROM appointments WHERE id = ?').get(id).visit_token });
  }));
  app.post('/api/patient/waitlist/:token/cancel', wrap((req, res) => {
    throttle('wlx:' + req.ip, 30);
    const w = waitRow(req.params.token);
    if (['waiting', 'offered'].includes(w.status)) db.prepare("UPDATE waitlist SET status = 'cancelled' WHERE id = ?").run(w.id);
    advance();
    res.json({ message: 'Removed from the waitlist' });
  }));

  /* ----- visit status page (live queue, follow-up, review) ----- */
  const visitRow = (t) => {
    if (!TOKEN_RE.test(String(t))) throw bad('Not found', 404);
    const a = db.prepare('SELECT a.*, c.name AS clinic_name, c.doctor_name, c.location, c.phone AS clinic_phone, c.avg_minutes FROM appointments a JOIN clinics c ON c.id = a.clinic_id WHERE a.visit_token = ?').get(t);
    if (!a) throw bad('Not found', 404);
    return a;
  };
  function reviewAllowed(a) {
    if (['cancelled', 'no-show'].includes(a.status)) return false;
    return a.visit_state === 'done' || (a.appointment_date < localToday() && a.confirmed === 1);
  }
  app.get('/api/patient/visit/:token', wrap((req, res) => {
    throttle('visit:' + req.ip, 300);
    const a = visitRow(req.params.token), today = localToday();
    let state = 'upcoming', ahead = 0;
    if (a.status === 'cancelled') state = 'cancelled';
    else if (a.status === 'no-show') state = 'closed';
    else if (a.visit_state === 'done') state = 'done';
    else if (a.appointment_date < today) state = 'past';
    else if (a.appointment_date === today) {
      if (a.visit_state === 'in') state = 'your-turn';
      else {
        state = 'today';
        const mem = memberPhones(a.clinic_id), cmp = byQueue(mem);
        ahead = db.prepare(`SELECT id, appointment_time, patient_phone FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE} AND COALESCE(visit_state, '') != 'done' AND id != ?`)
          .all(a.clinic_id, today, a.id).filter((o) => cmp(o, a) < 0).length;
      }
    }
    const rv = db.prepare('SELECT rating FROM reviews WHERE appointment_id = ?').get(a.id);
    res.json({ state, first_name: a.patient_name.split(' ')[0], clinic_id: a.clinic_id, clinic_name: a.clinic_name, doctor_name: a.doctor_name, location: a.location, clinic_phone: a.clinic_phone,
      date: a.appointment_date, time: a.appointment_time, ahead, eta_minutes: ahead * (a.avg_minutes || 15), priority: isMember(a.clinic_id, a.patient_phone), skip_minutes: PRIORITY_MIN,
      follow_up: a.follow_up_date ? { date: a.follow_up_date, note: a.follow_up_note || '' } : null,
      can_review: reviewAllowed(a) && !rv, reviewed: rv ? rv.rating : null });
  }));
  app.post('/api/patient/visit/:token/review', wrap((req, res) => {
    throttle('rev:' + req.ip, 20);
    const a = visitRow(req.params.token), b = req.body || {};
    if (!reviewAllowed(a)) throw bad('You can rate a visit after it has happened.', 403);
    const stars = Number(b.rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw bad('Choose 1 to 5 stars.');
    const comment = String(b.comment || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (db.prepare('SELECT 1 FROM reviews WHERE appointment_id = ?').get(a.id)) throw bad('You already rated this visit.', 409);
    db.prepare('INSERT INTO reviews (clinic_id, appointment_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)').run(a.clinic_id, a.id, stars, comment, Date.now());
    res.json({ message: 'Thank you for your feedback' });
  }));

  /* ----- public clinic profile ----- */
  app.get('/api/patient/clinics/:id/profile', wrap((req, res) => {
    const c = activeClinic(req.params.id);
    if (!c) throw bad('Clinic not found', 404);
    const reviews = db.prepare('SELECT rating, comment, created_at FROM reviews WHERE clinic_id = ? AND hidden = 0 ORDER BY id DESC LIMIT 6').all(c.id)
      .map((r) => ({ rating: r.rating, comment: r.comment || '', date: new Date(r.created_at).toISOString().slice(0, 10) }));
    res.json({ id: c.id, name: c.name, doctor_name: c.doctor_name, phone: c.phone, location: c.location || '', services: c.services || '', offer: c.offer || '', fees: c.fees || '', languages: c.languages || '', about: c.about || '',
      map_url: mapsLink(c), plan: planPublic(planOf(c.id)), ...rating(c.id), reviews });
  }));

  /* ----- online payment for the plan (Razorpay) ----- */
  const payNow = (row, paymentId) => {
    // only one caller can flip created -> paid, so a verify and a webhook arriving together grant once
    const flip = db.prepare("UPDATE payments SET status = 'paid', payment_id = ? WHERE id = ? AND status = 'created'").run(paymentId || null, row.id);
    if (flip.changes !== 1) return null;
    const clinic = db.prepare('SELECT id, plan_name, plan_days FROM clinics WHERE id = ?').get(row.clinic_id);
    const g = grantMembership(db, isoDay, localToday(), clinic, row.patient_name, row.phone, row.amount, 'online', paymentId);
    db.prepare('UPDATE payments SET membership_id = ? WHERE id = ?').run(g.id, row.id);
    return g;
  };
  app.post('/api/patient/plan/order', wrap(async (req, res) => {
    throttle('pay:' + req.ip, 15);
    if (!rzpOn() && !demoOn()) throw bad('Online payment is not set up yet. Please pay at the clinic desk.', 503);
    const b = req.body || {};
    if (b.website || !(Number(b.open_ms) >= 2000)) throw bad('Please check your details and try again.');
    const clinic = activeClinic(b.clinic_id), pl = clinic && planOf(clinic.id);
    if (!pl) throw bad('This clinic does not have a priority plan.', 404);
    const price = Math.round(pl.plan_price || 0);
    if (price < 1) throw bad('This plan is free. Ask at the clinic desk.', 409);
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw bad('Enter your name.');
    const phone = ph(b.phone);
    if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number.');
    throttle('payp:' + phone, 5);
    if (demoOn()) {
      const oid = 'demo_' + crypto.randomBytes(8).toString('hex');
      db.prepare('INSERT INTO payments (clinic_id, phone, patient_name, amount, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(clinic.id, phone, name, price, oid, Date.now());
      return res.json({ demo: true, order_id: oid, amount: price * 100, currency: 'INR', clinic_name: clinic.name, plan_name: pl.plan_name || 'Priority plan', name, phone });
    }
    const receipt = 'bp' + crypto.randomBytes(6).toString('hex');
    let order;
    try {
      const r = await fetch(rzpBase() + '/v1/orders', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64') },
        body: JSON.stringify({ amount: price * 100, currency: 'INR', receipt, notes: { clinic_id: String(clinic.id), phone, purpose: 'priority plan' } }) });
      order = await r.json().catch(() => ({}));
      if (!r.ok || !order.id) { console.warn('Razorpay order failed:', r.status, JSON.stringify(order).slice(0, 200)); throw new Error('x'); }
    } catch { throw bad('Could not start the payment. Try again in a moment, or pay at the clinic desk.', 502); }
    db.prepare('INSERT INTO payments (clinic_id, phone, patient_name, amount, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(clinic.id, phone, name, price, order.id, Date.now());
    res.json({ order_id: order.id, key_id: process.env.RAZORPAY_KEY_ID, amount: price * 100, currency: 'INR', clinic_name: clinic.name, plan_name: pl.plan_name || 'Priority plan', name, phone });
  }));
  app.post('/api/patient/plan/verify', wrap((req, res) => {
    throttle('payv:' + req.ip, 30);
    if (!rzpOn() && !demoOn()) throw bad('Online payment is not set up.', 503);
    const b = req.body || {}, orderId = String(b.order_id || ''), payId = String(b.payment_id || ''), sig = String(b.signature || '');
    const row = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
    if (demoOn() && row && orderId.startsWith('demo_') && b.demo === true) {
      let g = payNow(row, 'demo');
      if (!g) { const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(row.membership_id); if (!m) throw bad('This payment is already being processed. Check again in a moment.', 409); g = { expires_on: m.expires_on }; }
      db.prepare("UPDATE memberships SET source = 'demo' WHERE id = (SELECT membership_id FROM payments WHERE id = ?)").run(row.id);
      return res.json({ message: 'Demo payment done. You are now a priority member', expires_on: g.expires_on, demo: true });
    }
    if (!rzpOn()) throw bad('Online payment is not set up.', 503);
    if (!row || !payId || !sameHex(hmacHex(process.env.RAZORPAY_KEY_SECRET, orderId + '|' + payId), sig)) throw bad('We could not confirm this payment. If money was taken, show the receipt at the clinic desk.', 400);
    let g = payNow(row, payId);
    if (!g) { const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(row.membership_id); if (!m) throw bad('This payment is already being processed. Check again in a moment.', 409); g = { expires_on: m.expires_on, starts_on: m.starts_on }; }
    res.json({ message: 'You are now a priority member', expires_on: g.expires_on });
  }));
  // Razorpay calls this when a payment is captured, so a patient who closes the page after paying still becomes a member.
  app.post('/api/patient/pay/webhook', wrap((req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !rzpOn()) return res.status(503).json({ error: 'Not set up' });
    if (!sameHex(hmacHex(secret, req.rawBody || ''), req.get('X-Razorpay-Signature'))) return res.status(400).json({ error: 'Bad signature' });
    const ev = req.body || {};
    const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
    if (['payment.captured', 'order.paid'].includes(ev.event) && pay && pay.order_id) {
      const row = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(String(pay.order_id));
      if (row && row.status === 'created' && Number(pay.amount) === row.amount * 100) payNow(row, String(pay.id || ''));
    }
    res.json({ ok: true });
  }));

  /* plan details and (optionally) whether this number is a member. Returns only yes/no, never a name or date. */
  app.get('/api/patient/clinics/:id/plan', wrap((req, res) => {
    throttle('plan:' + req.ip, 120);
    const c = activeClinic(req.params.id);
    if (!c) throw bad('Clinic not found', 404);
    const pl = planOf(c.id), phone = ph(req.query.phone);
    res.json({ plan: planPublic(pl), member: Boolean(pl && phone.length === 10 && isMember(c.id, phone)) });
  }));

  const visitPage = (req, res) => res.sendFile(path.join(publicDir, 'visit.html'));
  app.get(['/patient/visit', '/patient/clinic/:id'], visitPage);

  return { held, heldTimes, rating, guardBooking, advance, freeSlots, isMember, planOf, reservedTimes, memberPhones, payOn: rzpOn, demoOn };
}

function mountStaff(ctx) {
  const { app, db, wrap, bad, ownerOnly, needClinic, myClinic, localToday, isoDay, ALIVE, insertAppointment, patientHost } = ctx;
  const qrcode = require('./vendor/qrcode');
  const apptOf = (req, id) => { const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(id)); if (!a) throw bad('Appointment not found', 404); needClinic(req, a.clinic_id); return a; };
  const waitOf = (req, id) => { const w = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(id)); if (!w) throw bad('Not found', 404); needClinic(req, w.clinic_id); return w; };
  const todayRows = (cid) => { const mem = activeMemberPhones(db, cid, localToday()); return db.prepare(`SELECT id, patient_name, patient_phone, appointment_time, visit_state FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE}`).all(cid, localToday()).sort(byQueue(mem)); };

  /* everything the desk shows above the appointment list, in one call */
  app.get('/api/clinics/:id/extras', wrap((req, res) => {
    needClinic(req, req.params.id);
    const cid = Number(req.params.id), today = localToday();
    ctx.advance();
    const mem = activeMemberPhones(db, cid, today);
    const soon = isoDay(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 3));
    const waitlist = db.prepare("SELECT id, patient_name, patient_phone, wait_date, status, offer_time, offered_at, visit_type FROM waitlist WHERE clinic_id = ? AND status IN ('waiting', 'offered') ORDER BY wait_date, id LIMIT 40").all(cid)
      .map((w) => ({ ...w, member: mem.has(String(w.patient_phone).replace(/\D/g, '').slice(-10)), minutes_left: w.status === 'offered' ? Math.max(0, Math.ceil((w.offered_at + 30 * 60000 - Date.now()) / 60000)) : 0 }))
      .sort((a, b) => (a.wait_date < b.wait_date ? -1 : a.wait_date > b.wait_date ? 1 : (Number(b.member) - Number(a.member)) || (a.id - b.id)));
    const followups = db.prepare(`SELECT id, patient_name, patient_phone, appointment_date, follow_up_date, follow_up_note FROM appointments WHERE clinic_id = ? AND follow_up_date IS NOT NULL AND follow_up_done = 0 AND follow_up_date <= ? AND ${ALIVE} ORDER BY follow_up_date LIMIT 40`).all(cid, soon);
    const rows = todayRows(cid);
    const inRoom = rows.find((r) => r.visit_state === 'in'), waiting = rows.filter((r) => r.visit_state !== 'done' && r.visit_state !== 'in').length;
    const avg = (db.prepare('SELECT avg_minutes FROM clinics WHERE id = ?').get(cid) || {}).avg_minutes || 15;
    const pl = db.prepare('SELECT plan_on FROM clinics WHERE id = ?').get(cid);
    res.json({ plan_on: Boolean(pl && pl.plan_on), member_phones: [...mem], waitlist, followups, queue: { now: inRoom ? { id: inRoom.id, name: inRoom.patient_name, time: inRoom.appointment_time } : null, waiting, done: rows.filter((r) => r.visit_state === 'done').length, avg_minutes: avg }, today });
  }));

  /* live queue */
  app.post('/api/clinics/:id/queue/next', wrap((req, res) => {
    needClinic(req, req.params.id);
    const cid = Number(req.params.id), rows = todayRows(cid), now = Date.now();
    const cur = rows.find((r) => r.visit_state === 'in');
    if (cur) db.prepare("UPDATE appointments SET visit_state = 'done', state_at = ? WHERE id = ?").run(now, cur.id);
    const next = rows.find((r) => r.id !== (cur && cur.id) && r.visit_state !== 'done');
    if (next) db.prepare("UPDATE appointments SET visit_state = 'in', state_at = ? WHERE id = ?").run(now, next.id);
    res.json({ now: next ? { id: next.id, name: next.patient_name } : null, finished: cur ? cur.patient_name : null });
  }));
  app.put('/api/appointments/:id/visit-state', wrap((req, res) => {
    const a = apptOf(req, req.params.id), s = (req.body || {}).state;
    if (!['waiting', 'in', 'done'].includes(s)) throw bad('Unknown state.');
    db.prepare('UPDATE appointments SET visit_state = ?, state_at = ? WHERE id = ?').run(s === 'waiting' ? null : s, Date.now(), a.id);
    res.json({ message: 'Updated' });
  }));

  /* follow-ups */
  app.put('/api/appointments/:id/follow-up', wrap((req, res) => {
    const a = apptOf(req, req.params.id), b = req.body || {};
    if (!b.date) { db.prepare('UPDATE appointments SET follow_up_date = NULL, follow_up_note = NULL, follow_up_done = 0 WHERE id = ?').run(a.id); return res.json({ message: 'Follow-up removed' }); }
    const date = String(b.date), far = isoDay(new Date(new Date().getFullYear() + 1, new Date().getMonth(), new Date().getDate()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < localToday() || date > far) throw bad('Choose a follow-up date within the next year.');
    const note = String(b.note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
    db.prepare('UPDATE appointments SET follow_up_date = ?, follow_up_note = ?, follow_up_done = 0 WHERE id = ?').run(date, note, a.id);
    res.json({ message: 'Follow-up saved' });
  }));
  app.put('/api/appointments/:id/follow-up-done', wrap((req, res) => {
    const a = apptOf(req, req.params.id);
    db.prepare('UPDATE appointments SET follow_up_done = 1 WHERE id = ?').run(a.id);
    res.json({ message: 'Marked done' });
  }));

  /* waitlist: the clinic books the patient after a phone call, or removes the entry */
  app.post('/api/waitlist/:id/book', wrap((req, res) => {
    const w = waitOf(req, req.params.id);
    if (!['waiting', 'offered'].includes(w.status)) throw bad('This entry is closed.', 409);
    const time = w.status === 'offered' ? w.offer_time : String((req.body || {}).time || '');
    if (!time) throw bad('No free time is available for this patient yet.', 409);
    const id = insertAppointment({ clinic_id: w.clinic_id, patient_name: w.patient_name, patient_phone: w.patient_phone, appointment_date: w.wait_date, appointment_time: time, visit_type: w.visit_type }, 'scheduled', { skipHold: true });
    db.prepare("UPDATE waitlist SET status = 'booked', appointment_id = ? WHERE id = ?").run(id, w.id);
    res.json({ id, message: 'Booked' });
  }));
  app.post('/api/waitlist/:id/remove', wrap((req, res) => {
    const w = waitOf(req, req.params.id);
    db.prepare("UPDATE waitlist SET status = 'cancelled' WHERE id = ?").run(w.id);
    ctx.advance();
    res.json({ message: 'Removed' });
  }));

  /* priority plan: the owner sets it up, any staff member marks a patient as paid */
  const planRow = (cid) => db.prepare('SELECT plan_on, plan_name, plan_price, plan_days, plan_reserved, plan_cutoff_hours, plan_extra_days FROM clinics WHERE id = ?').get(cid);
  const planJson = (c) => ({ on: Boolean(c.plan_on), name: c.plan_name || 'Priority plan', price: c.plan_price || 0, days: c.plan_days || 30, reserved: c.plan_reserved ?? 2, cutoff_hours: c.plan_cutoff_hours ?? 3, extra_days: c.plan_extra_days ?? 7 });
  const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return isoDay(new Date(y, m - 1, d + n)); };
  app.get('/api/clinics/:id/plan', wrap((req, res) => {
    needClinic(req, req.params.id);
    const cid = Number(req.params.id), c = planRow(cid), today = localToday();
    if (!c) throw bad('Clinic not found', 404);
    const members = db.prepare('SELECT id, patient_name, phone, amount, starts_on, expires_on, status, source FROM memberships WHERE clinic_id = ? ORDER BY id DESC LIMIT 80').all(cid)
      .map((m) => ({ ...m, active: m.status === 'active' && m.starts_on <= today && m.expires_on >= today }));
    const [ty, tm] = today.split('-').map(Number);
    const rev = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM memberships WHERE clinic_id = ? AND status = 'active' AND COALESCE(source, 'desk') != 'demo' AND created_at >= ?").get(cid, new Date(ty, tm - 1, 1).getTime()).s;
    res.json({ online: rzpOn() || demoOn(), demo: demoOn(), plan: planJson(c), members, active: activeMemberPhones(db, cid, today).size, month_revenue: rev });
  }));
  app.put('/api/clinics/:id/plan', ownerOnly, wrap((req, res) => {
    needClinic(req, req.params.id);
    const cid = Number(req.params.id), b = req.body || {}, num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    if (!planRow(cid)) throw bad('Clinic not found', 404);
    const name = String(b.name || 'Priority plan').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'Priority plan';
    db.prepare('UPDATE clinics SET plan_on = ?, plan_name = ?, plan_price = ?, plan_days = ?, plan_reserved = ?, plan_cutoff_hours = ?, plan_extra_days = ? WHERE id = ?')
      .run(b.on ? 1 : 0, name, num(b.price, 0, 100000, 0), num(b.days, 1, 365, 30), num(b.reserved, 0, 8, 2), num(b.cutoff_hours, 0, 24, 3), num(b.extra_days, 0, 30, 7), cid);
    res.json({ message: 'Plan saved' });
  }));
  app.post('/api/clinics/:id/members', wrap((req, res) => {
    needClinic(req, req.params.id);
    const cid = Number(req.params.id), c = planRow(cid), b = req.body || {}, today = localToday();
    if (!c) throw bad('Clinic not found', 404);
    if (!c.plan_on) throw bad('Turn the priority plan on first (Clinics tab).', 409);
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw bad('Enter the patient name.');
    const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number.');
    const amount = b.amount === undefined || b.amount === '' ? (c.plan_price || 0) : Math.min(100000, Math.max(0, Math.round(Number(b.amount) || 0)));
    const g = grantMembership(db, isoDay, today, { id: cid, plan_name: c.plan_name, plan_days: c.plan_days }, name, phone, amount, 'desk', null);
    res.json({ message: g.renewed ? 'Renewed' : 'Member added', starts_on: g.starts_on, expires_on: g.expires_on });
  }));
  app.post('/api/members/:id/cancel', wrap((req, res) => {
    const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(Number(req.params.id));
    if (!m) throw bad('Not found', 404);
    needClinic(req, m.clinic_id);
    db.prepare("UPDATE memberships SET status = 'cancelled' WHERE id = ?").run(m.id);
    res.json({ message: 'Membership cancelled' });
  }));

  /* reviews */
  app.get('/api/clinics/:id/reviews', wrap((req, res) => {
    needClinic(req, req.params.id);
    res.json(db.prepare('SELECT id, rating, comment, hidden, created_at FROM reviews WHERE clinic_id = ? ORDER BY id DESC LIMIT 30').all(Number(req.params.id)));
  }));
  app.put('/api/reviews/:id/hide', ownerOnly, wrap((req, res) => {
    const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(req.params.id));
    if (!r) throw bad('Not found', 404);
    needClinic(req, r.clinic_id);
    db.prepare('UPDATE reviews SET hidden = ? WHERE id = ?').run((req.body || {}).hidden ? 1 : 0, r.id);
    res.json({ message: 'Updated' });
  }));

  /* clinic profile fields */
  app.put('/api/clinics/:id/profile', ownerOnly, wrap((req, res) => {
    needClinic(req, req.params.id);
    const b = req.body || {}, cut = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
    let maps = cut(b.maps_url, 300);
    if (maps && !/^https:\/\/[^\s]+$/.test(maps)) throw bad('The map link must start with https://');
    const mins = Math.min(60, Math.max(5, Math.round(Number(b.avg_minutes) || 15)));
    if (!db.prepare('SELECT 1 FROM clinics WHERE id = ?').get(Number(req.params.id))) throw bad('Clinic not found', 404);
    db.prepare('UPDATE clinics SET fees = ?, languages = ?, about = ?, maps_url = ?, avg_minutes = ? WHERE id = ?').run(cut(b.fees, 120), cut(b.languages, 80), cut(b.about, 400), maps || null, mins, Number(req.params.id));
    res.json({ message: 'Profile saved' });
  }));

  /* printable QR poster */
  app.get('/api/clinics/:id/poster', wrap((req, res) => {
    needClinic(req, req.params.id);
    const c = db.prepare('SELECT id, name, doctor_name, location FROM clinics WHERE id = ?').get(Number(req.params.id));
    if (!c) throw bad('Clinic not found', 404);
    const host = patientHost();
    const base = (process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/$/, '') : host ? 'https://' + host : req.protocol + '://' + req.get('host'));
    const url = `${base}/patient?clinic=${c.id}`;
    const local = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(base);
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    const dr = /^dr\.?\s/i.test(c.doctor_name) ? c.doctor_name : 'Dr. ' + c.doctor_name;
    res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booking poster - ${esc(c.name)}</title>
<style>
@page { size: A4; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: "Figtree", "Segoe UI", system-ui, sans-serif; background: #e9f3ee; color: #11291F; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.bar { max-width: 794px; margin: 14px auto; display: flex; gap: 12px; align-items: center; padding: 0 14px; font-size: 16px }
.bar button { background: #12805A; color: #fff; border: 0; border-radius: 12px; padding: 12px 20px; font-weight: 700; font-size: 17px; font-family: inherit; cursor: pointer }
.bar .warn { color: #8a5a00; font-weight: 600 }
.sheet { width: 794px; height: 1123px; margin: 0 auto 30px; background: #fff; padding: 64px 56px; display: flex; flex-direction: column; align-items: center; text-align: center }
.mark { width: 84px; height: 84px; border-radius: 24px; background: #0B4A35; display: grid; place-items: center }
.mark svg { width: 56px; height: 56px }
h1 { font-size: 54px; line-height: 1.1; margin-top: 34px; letter-spacing: -0.02em }
.dr { font-size: 28px; color: #3F5A4C; margin-top: 12px; font-weight: 600 }
.loc { font-size: 22px; color: #3F5A4C; margin-top: 4px }
.cta { font-size: 38px; font-weight: 800; margin-top: 46px; color: #0B4A35 }
.qr { width: 430px; height: 430px; margin-top: 26px; padding: 12px; border: 6px solid #12805A; border-radius: 28px }
.qr svg { width: 100%; height: 100% }
.how { font-size: 24px; margin-top: 28px; color: #3F5A4C }
.url { font-size: 18px; margin-top: 10px; color: #3F5A4C; word-break: break-all }
.foot { margin-top: auto; font-size: 20px; color: #3F5A4C; font-weight: 600 }
@media print { body { background: #fff } .bar { display: none } .sheet { margin: 0; box-shadow: none } }
</style></head><body>
<div class="bar"><button onclick="window.print()">Print poster</button><span>Print on A4 and put it at your reception.</span>${local ? '<span class="warn">This QR points to a link that only works on this network. Print the final poster after you publish the site.</span>' : ''}</div>
<div class="sheet">
<div class="mark"><svg viewBox="0 0 48 48"><path transform="translate(-1.5 .2)" d="M11 4.5v39M11 4.5h15a8.2 8.2 0 0 1 0 16.4H11m0 0h17a11.3 11.3 0 0 1 0 22.6H11" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>${esc(c.name)}</h1>
<div class="dr">${esc(dr)}</div>
${c.location ? `<div class="loc">${esc(c.location)}</div>` : ''}
<div class="cta">Book your visit on your phone</div>
<div class="qr">${svg}</div>
<div class="how">Open your phone camera and point it at the code.<br>Pick a day and a time. No app and no sign-up.</div>
<div class="url">${esc(url)}</div>
<div class="foot">Booking by Baari</div>
</div></body></html>`);
  }));
}

module.exports = { mountPublic, mountStaff };
