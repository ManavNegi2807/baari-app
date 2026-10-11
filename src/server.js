// Baari - clinic appointments with WhatsApp reminders
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

/* ---------- settings from the .env file in the app folder ---------- */
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { console.warn('Could not read .env:', e.message); }

const PORT = Number(process.env.PORT) || 5000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'baari123';
const publicDir = path.join(__dirname, '..', 'public');

const waConfig = () => ({
  token: process.env.WHATSAPP_TOKEN,
  phoneId: process.env.WHATSAPP_PHONE_ID,
  template: process.env.WHATSAPP_TEMPLATE,
  lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
  verify: process.env.WHATSAPP_VERIFY_TOKEN || 'baari-verify',
  secret: process.env.WHATSAPP_APP_SECRET,
  base: process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0',
});
const waConnected = () => { const c = waConfig(); return Boolean(c.token && c.phoneId); };

const app = express();
/* Behind a hosting service's proxy, trust it so each visitor is counted by their own address and https is detected. */
if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

/* ---------- security ---------- */
app.disable('x-powered-by');
const REMOTE_STAFF = String(process.env.STAFF_REMOTE || '').toLowerCase() === 'true';
const privateDir = path.join(__dirname, 'private');
app.use((req, res, next) => {
  // The Razorpay payment window is allowed on the public booking page only, and only when Razorpay keys are set.
  const rzp = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) && (req.path === '/patient' || req.path === '/patient.html');
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': rzp ? 'strict-origin-when-cross-origin' : 'no-referrer',
    'Permissions-Policy': rzp ? 'camera=(), microphone=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com")' : 'camera=(), microphone=(), payment=()',
    'Content-Security-Policy': rzp
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.razorpay.com https://checkout.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; frame-ancestors 'none'; form-action 'self' https://api.razorpay.com; base-uri 'none'; object-src 'none'"
      : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  });
  if (req.path.startsWith('/api') || req.path.startsWith('/staff') || req.path === '/') res.set('Cache-Control', 'no-store');
  next();
});
/* A page or API call from another website must not be able to act as a logged-in user. */
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) { let host = ''; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return res.status(403).json({ error: 'Blocked.' }); }
  }
  next();
});
/* Clinic pages and tools only open from the clinic's own computer or network.
   Anyone arriving through a public link (such as ngrok) gets "not found". Set STAFF_REMOTE=true to allow remote staff. */
const PRIVATE_NET = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|fe80:|f[cd][0-9a-f]{2}:)/i;
/* Optional: give each audience its own address. Set PATIENT_HOST, STAFF_HOST and COMPANY_HOST (for example book.example.com, app.example.com, admin.example.com).
   Each address then serves only its own pages. Clinic and company logins use separate cookies, so they never mix. */
const hostList = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const HOSTS = { patient: hostList(process.env.PATIENT_HOST), staff: hostList(process.env.STAFF_HOST), company: hostList(process.env.COMPANY_HOST) };
const reqHost = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();
const onHost = (req, kind) => HOSTS[kind].includes(reqHost(req));
if (HOSTS.patient.length || HOSTS.staff.length || HOSTS.company.length) {
  app.use((req, res, next) => {
    const p = req.path, kind = onHost(req, 'company') ? 'company' : onHost(req, 'staff') ? 'staff' : onHost(req, 'patient') ? 'patient' : null;
    if (!kind || p === '/health') return next();
    const co = p.startsWith('/company') || p.startsWith('/api/company'), pa = p.startsWith('/patient') || p.startsWith('/api/patient') || p === '/account.html' || p === '/webhook';
    const allowed = kind === 'company' ? co : kind === 'patient' ? pa : !co && !pa;
    if (allowed) return next();
    return req.path.startsWith('/api') ? res.status(404).json({ error: 'Not found' }) : res.status(404).type('text').send('Not found');
  });
}
function isLocalRequest(req) {
  const viaProxy = Boolean(req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded || req.headers['cf-connecting-ip']);
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const hostOk = host === 'localhost' || /^[\d.]+$/.test(host) && PRIVATE_NET.test(host) || host === '[::1]';
  const addr = String(req.socket.remoteAddress || '');
  return !viaProxy && hostOk && PRIVATE_NET.test(addr);
}
const notFound = (req, res) => (req.originalUrl.startsWith('/api') ? res.status(404).json({ error: 'Not found' }) : res.status(404).type('text').send('Not found'));
function clinicOnly(req, res, next) {
  if (REMOTE_STAFF || onHost(req, 'staff') || isLocalRequest(req)) return next();
  notFound(req, res);
}
/* The company site is separate from the clinic desk. It has its own switch, COMPANY_REMOTE. */
const REMOTE_COMPANY = String(process.env.COMPANY_REMOTE || '').toLowerCase() === 'true';
function companyOnly(req, res, next) {
  if (REMOTE_COMPANY || onHost(req, 'company') || isLocalRequest(req)) return next();
  notFound(req, res);
}


/* ---------- database ---------- */
const DB_FILE = process.env.DATABASE_PATH || path.join(__dirname, 'baari.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, doctor_name TEXT NOT NULL,
  plan TEXT DEFAULT 'basic', whatsapp_enabled INTEGER DEFAULT 0, whatsapp_api_key TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id INTEGER NOT NULL, patient_name TEXT NOT NULL, patient_phone TEXT NOT NULL,
  appointment_date TEXT NOT NULL, appointment_time TEXT NOT NULL, visit_type TEXT NOT NULL, status TEXT DEFAULT 'scheduled',
  confirmed INTEGER DEFAULT 0, no_show INTEGER DEFAULT 0, whatsapp_sent INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(clinic_id) REFERENCES clinics(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id INTEGER NOT NULL, reminder_type TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(appointment_id) REFERENCES appointments(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id INTEGER NOT NULL, patient_phone TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT DEFAULT 'pending', sent_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(appointment_id) REFERENCES appointments(id))`);
/* Older copies of the database may be missing columns added later. Add any that are missing. */
db.exec(`CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS patient_sessions (
  token_hash TEXT PRIMARY KEY, patient_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS staff_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
function addMissingColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of Object.entries(columns)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addMissingColumns('clinics', { reminder_lang: "TEXT DEFAULT 'en'" });
addMissingColumns('staff_users', { role: "TEXT DEFAULT 'owner'", clinic_id: 'INTEGER' });
addMissingColumns('clinics', { plan: "TEXT DEFAULT 'basic'", whatsapp_enabled: 'INTEGER DEFAULT 0', whatsapp_api_key: 'TEXT', location: 'TEXT', latitude: 'REAL', longitude: 'REAL', services: 'TEXT', offer: 'TEXT' });
addMissingColumns('appointments', { status: "TEXT DEFAULT 'scheduled'", confirmed: 'INTEGER DEFAULT 0', no_show: 'INTEGER DEFAULT 0', whatsapp_sent: 'INTEGER DEFAULT 0' });
addMissingColumns('clinics', { status: "TEXT DEFAULT 'active'", company_note: 'TEXT' });
addMissingColumns('appointments', { source: 'TEXT' });
/* counts only: which feature was used and for which clinic. No patient text is ever kept here. */
db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, clinic_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
const logEvent = (type, clinicId) => { try { db.prepare('INSERT INTO events (type, clinic_id) VALUES (?, ?)').run(type, clinicId || null); } catch {} };
console.log('Connected to SQLite database');

/* ---------- small helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localToday = () => isoDay(new Date());
const apptDate = (a) => { const [y, m, d] = a.appointment_date.split('-').map(Number); const [h, mi] = a.appointment_time.split(':').map(Number); return new Date(y, m - 1, d, h, mi); };
const niceDay = (a) => apptDate(a).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const niceTime = (a) => { const [h, m] = a.appointment_time.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`; };
const drName = (n) => (/^dr\.?\s/i.test(n) ? n : 'Dr. ' + n);
const waNumber = (p) => { let d = String(p || '').replace(/\D/g, '').replace(/^0+/, ''); if (d.length === 10) d = '91' + d; return d; };
const VISIT_TYPES = ['consultation', 'follow-up', 'check-up', 'procedure'];
const ALIVE = `status NOT IN ('cancelled','no-show')`;
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

let growthApi = null; /* set when src/growth.js is mounted below */
function slotTaken(clinicId, date, time, skipHold) {
  if (!skipHold && growthApi && growthApi.held(clinicId, date, time)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND appointment_time = ? AND ${ALIVE}`).get(clinicId, date, time));
}
function insertAppointment({ clinic_id, patient_name, patient_phone, appointment_date, appointment_time, visit_type }, status, opts = {}) {
  const clinic = db.prepare("SELECT id, COALESCE(status, 'active') AS status FROM clinics WHERE id = ?").get(clinic_id);
  if (!clinic) throw bad('That clinic does not exist.', 404);
  if (status === 'pending' && clinic.status !== 'active') throw bad('This clinic is not taking online bookings right now.', 403);
  const name = String(patient_name || '').trim(), phone = String(patient_phone || '').trim();
  if (name.length < 2 || name.length > 80) throw bad('Enter the patient name.');
  if (waNumber(phone).length < 10) throw bad('Enter a valid phone number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment_date || '') || !/^\d{2}:\d{2}$/.test(appointment_time || '')) throw bad('Choose a date and time.');
  if (!VISIT_TYPES.includes(visit_type)) throw bad('Choose a reason for the visit.');
  if (slotTaken(clinic_id, appointment_date, appointment_time, opts.skipHold)) throw bad('That time is already booked. Choose another time.', 409);
  const r = db.prepare('INSERT INTO appointments (clinic_id, patient_name, patient_phone, appointment_date, appointment_time, visit_type, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clinic_id, name, phone, appointment_date, appointment_time, visit_type, status, status === 'pending' ? 'patient' : 'staff');
  setTimeout(() => autoRemind().catch((e) => console.warn("Auto reminder error:", e.message)), 500);
  return Number(r.lastInsertRowid);
}

/* ---------- WhatsApp ---------- */
function logMessage(appointmentId, phone, message, status) {
  db.prepare('INSERT INTO whatsapp_logs (appointment_id, patient_phone, message, status) VALUES (?, ?, ?, ?)').run(appointmentId, phone, message, status);
}
const LANGS = ['en', 'hi', 'hinglish'];
function reminderText(a, clinic, lang) {
  lang = LANGS.includes(lang) ? lang : (LANGS.includes(clinic.reminder_lang) ? clinic.reminder_lang : 'en');
  const loc = clinic.location ? ' (' + clinic.location + ')' : '', dr = drName(clinic.doctor_name);
  if (lang === 'hi') {
    let day = niceDay(a); try { day = apptDate(a).toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long' }); } catch {}
    return `नमस्ते ${a.patient_name}, ${clinic.name}${loc} में ${dr} के साथ आपकी अपॉइंटमेंट ${day} को ${niceTime(a)} पर है। पक्का करने के लिए YES और रद्द करने के लिए NO लिखकर भेजें।`;
  }
  if (lang === 'hinglish') return `Namaste ${a.patient_name}, aapki appointment ${dr} ke saath ${clinic.name}${loc} mein ${niceDay(a)} ko ${niceTime(a)} par hai. Confirm karne ke liye YES aur cancel karne ke liye NO reply karein.`;
  return `Hi ${a.patient_name}, this is a reminder of your appointment with ${dr} at ${clinic.name}${loc} on ${niceDay(a)} at ${niceTime(a)}. Reply YES to confirm or NO to cancel.`;
}

async function graphSend(body) {
  const c = waConfig();
  const r = await fetch(`${c.base}/${c.phoneId}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(data.error?.message || 'WhatsApp did not accept the message.', 502);
  return data;
}

const sending = new Set();
async function sendReminder(a, clinic) {
  if (sending.has(a.id)) throw bad('A reminder for this patient is already being sent.', 409);
  sending.add(a.id);
  try { return await deliverReminder(a, clinic); } finally { sending.delete(a.id); }
}
async function deliverReminder(a, clinic) {
  const fresh = db.prepare('SELECT * FROM appointments WHERE id = ?').get(a.id);
  if (fresh) a = fresh;
  const text = reminderText(a, clinic), to = waNumber(a.patient_phone), c = waConfig();
  if (!waConnected()) {
    logMessage(a.id, a.patient_phone, text, 'manual');
    db.prepare('UPDATE appointments SET whatsapp_sent = 1 WHERE id = ?').run(a.id);
    return { mode: 'manual', app_link: `whatsapp://send?phone=${to}&text=${encodeURIComponent(text)}`, link: `https://wa.me/${to}?text=${encodeURIComponent(text)}`, text };
  }
  let body;
  if (!c.template) body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  else if (c.template === 'hello_world') body = { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };
  else body = { messaging_product: 'whatsapp', to, type: 'template', template: { name: c.template, language: { code: c.lang },
    components: [{ type: 'body', parameters: [a.patient_name, drName(clinic.doctor_name), niceDay(a), niceTime(a)].map((t) => ({ type: 'text', text: t })) }] } };
  try { await graphSend(body); }
  catch (err) { logMessage(a.id, a.patient_phone, text, 'failed: ' + err.message); throw err; }
  logMessage(a.id, a.patient_phone, text, 'sent');
  db.prepare('UPDATE appointments SET whatsapp_sent = 1 WHERE id = ?').run(a.id);
  return { mode: 'cloud', text };
}

const failedAuto = new Set();
let reminding = false;
async function autoRemind() {
  if (!waConnected() || reminding) return;
  reminding = true;
  try { await runAutoRemind(); } finally { reminding = false; }
}
async function runAutoRemind() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM appointments WHERE whatsapp_sent = 0 AND ${ALIVE} AND appointment_date >= ? ORDER BY appointment_date, appointment_time`).all(localToday());
  for (const a of rows) {
    const diff = apptDate(a).getTime() - now;
    if (diff <= 0 || diff > 24 * 3600 * 1000 || failedAuto.has(a.id)) continue;
    const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(a.clinic_id);
    try { await sendReminder(a, clinic); console.log('Reminder sent to', a.patient_name); }
    catch (err) { failedAuto.add(a.id); console.warn('Reminder failed for', a.patient_name + ':', err.message); }
  }
}
setInterval(() => autoRemind().catch((e) => console.warn("Auto reminder error:", e.message)), 5 * 60 * 1000);
setTimeout(() => autoRemind().catch((e) => console.warn("Auto reminder error:", e.message)), 5000);

/* WhatsApp calls these two routes: first to check the link, then for every reply from a patient */
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === waConfig().verify) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook', (req, res) => {
  const { secret } = waConfig();
  if (secret) {
    const sig = String(req.headers['x-hub-signature-256'] || '').replace('sha256=', '');
    const want = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.sendStatus(403);
  }
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) for (const ch of entry.changes || []) for (const msg of ch.value?.messages || []) handleReply(msg);
  } catch (err) { console.warn('Webhook error:', err.message); }
});

function handleReply(msg) {
  const text = (msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '').trim();
  const from = waNumber(msg.from);
  if (!text || !from) return;
  const upcoming = db.prepare(`SELECT * FROM appointments WHERE appointment_date >= ? AND ${ALIVE} ORDER BY appointment_date, appointment_time`).all(localToday());
  const a = upcoming.find((x) => waNumber(x.patient_phone).slice(-10) === from.slice(-10));
  if (!a) return;
  logMessage(a.id, from, text, 'received');
  let reply = '';
  const hi = /[\u0900-\u097F]/.test(text);
  if (/^(yes|y|yeah|yep|ok|okay|haan|haa|han|ha|ji|jee|confirm|confirmed|हाँ|हां|हा|जी|ठीक|कन्फर्म)(?=$|[\s!.,।])/i.test(text)) {
    db.prepare("UPDATE appointments SET confirmed = 1, status = 'confirmed' WHERE id = ?").run(a.id);
    reply = hi ? `धन्यवाद ${a.patient_name}। ${niceDay(a)} को ${niceTime(a)} की आपकी अपॉइंटमेंट पक्की हो गई है।` : `Thank you ${a.patient_name}. Your appointment on ${niceDay(a)} at ${niceTime(a)} is confirmed.`;
  } else if (/^(no|n|nahi|nahin|nhi|cancel|cancelled|नहीं|नही|रद्द|कैंसल)(?=$|[\s!.,।])/i.test(text)) {
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(a.id);
    reply = hi ? `${niceDay(a)} को ${niceTime(a)} की आपकी अपॉइंटमेंट रद्द कर दी गई है। दोबारा बुक करने के लिए कभी भी संदेश भेजें।` : `Your appointment on ${niceDay(a)} at ${niceTime(a)} has been cancelled. Message us any time to book again.`;
  }
  if (reply && waConnected()) {
    logMessage(a.id, a.patient_phone, reply, 'sent');
    graphSend({ messaging_product: 'whatsapp', to: from, type: 'text', text: { body: reply } }).catch((e) => console.warn('Could not send acknowledgement:', e.message));
  }
}

/* ---------- smart features: no-show risk, daily briefing, patient assistant ---------- */
/* Everything works with built-in rules. If GROQ_API_KEY or ANTHROPIC_API_KEY is set, AI writes the wording. */
const AI_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const GROQ_KEY = () => process.env.GROQ_API_KEY || '';
const aiOn = () => Boolean(AI_KEY() || GROQ_KEY());
async function askClaude(system, user, maxTokens = 400) {
  if (!aiOn()) return null;
  try {
    if (!AI_KEY()) {
      /* Groq (OpenAI-compatible) */
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: 'Bearer ' + GROQ_KEY(), 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!r.ok) { console.warn('AI request failed (Groq):', r.status); return null; }
      const data = await r.json();
      return ((data.choices || [])[0] || {}).message?.content?.trim() || null;
    }
    const base = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '');
    const r = await fetch(base + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) { console.warn('AI request failed:', r.status); return null; }
    const data = await r.json();
    return (data.content || []).map((c) => c.text || '').join('').trim() || null;
  } catch (e) { console.warn('AI request error:', e.message); return null; }
}
const p10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function riskContext(clinicId) {
  const today = localToday(), hist = new Map();
  /* a clinic login only counts that clinic's own history */
  for (const r of db.prepare('SELECT id, patient_phone, status, no_show, appointment_date FROM appointments WHERE (? IS NULL OR clinic_id = ?)').all(clinicId || null, clinicId || null)) {
    const k = p10(r.patient_phone), h = hist.get(k) || { noShows: 0, attended: 0 };
    if (r.no_show || r.status === 'no-show') h.noShows++;
    else if (r.appointment_date < today && r.status !== 'cancelled') h.attended++;
    hist.set(k, h);
  }
  return hist;
}
/* A simple, explainable estimate from visit history, reminders and booking lead time. It is a guide, not a promise. */
function riskFor(a, hist) {
  const h = hist.get(p10(a.patient_phone)) || { noShows: 0, attended: 0 };
  const own = a.no_show || a.status === 'no-show' ? 1 : 0;
  const past = { noShows: h.noShows - own, attended: h.attended };
  let score = 12; const why = [];
  if (past.noShows > 0) { score += Math.min(60, 30 * past.noShows); why.push(past.noShows === 1 ? 'missed a visit before' : `missed ${past.noShows} visits before`); }
  if (past.attended > 0) { score -= Math.min(16, 8 * past.attended); if (!past.noShows) why.push('has come to earlier visits'); }
  if (past.noShows === 0 && past.attended === 0) { score += 8; why.push('first booking with you'); }
  if (a.confirmed || a.status === 'confirmed') { score -= 30; why.push('confirmed on WhatsApp'); }
  else {
    const hoursLeft = (apptDate(a).getTime() - Date.now()) / 36e5;
    if (!a.whatsapp_sent && hoursLeft < 30) { score += 10; why.push('no reminder sent yet'); }
    else if (a.whatsapp_sent) why.push('reminder sent, no reply yet');
  }
  const created = a.created_at ? new Date(String(a.created_at).replace(' ', 'T') + 'Z') : null;
  if (created && !isNaN(created)) {
    const lead = (apptDate(a).getTime() - created.getTime()) / 864e5;
    if (lead > 14) { score += 12; why.push('booked more than two weeks ahead'); } else if (lead > 7) { score += 6; why.push('booked over a week ahead'); } else if (lead < 0.5) score -= 8;
  }
  const [hh, mm] = String(a.appointment_time).split(':').map(Number), mins = hh * 60 + mm;
  if (mins >= 16 * 60 || mins <= 9 * 60 + 30) score += 5;
  score = Math.max(3, Math.min(95, Math.round(score)));
  return { score, level: score >= 45 ? 'high' : score >= 25 ? 'medium' : 'low', reasons: why.slice(0, 3) };
}

app.get('/api/clinics/:id/briefing', clinicOnly, staffAuth, wrap(async (req, res) => {
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(req.params.id);
  if (!clinic) throw bad('Clinic not found', 404);
  needClinic(req, clinic.id);
  const today = localToday(), hist = riskContext(myClinic(req));
  const rows = db.prepare(`SELECT * FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE} ORDER BY appointment_time`).all(clinic.id, today);
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const mins = (a) => { const [h, m] = a.appointment_time.split(':').map(Number); return h * 60 + m; };
  const isConf = (a) => a.confirmed || a.status === 'confirmed';
  const facts = {
    patients_today: rows.length, confirmed: rows.filter(isConf).length,
    first: rows[0] ? niceTime(rows[0]) : null, last: rows.length ? niceTime(rows[rows.length - 1]) : null,
    next_up: (() => { const n = rows.find((a) => mins(a) >= nowMin); return n ? { name: n.patient_name, time: niceTime(n) } : null; })(),
    no_reminder_yet: rows.filter((a) => !a.whatsapp_sent && !isConf(a) && mins(a) > nowMin).map((a) => a.patient_name),
    at_risk: rows.filter((a) => mins(a) > nowMin && !isConf(a)).map((a) => ({ a, r: riskFor(a, hist) })).filter((x) => x.r.level === 'high').map((x) => ({ name: x.a.patient_name, time: niceTime(x.a), why: x.r.reasons.join(', ') })),
  };
  let text;
  if (!rows.length) text = 'No patients are booked for today yet. Share your patient link to fill the day.';
  else {
    const parts = [`${rows.length} ${rows.length === 1 ? 'patient is' : 'patients are'} booked today, from ${facts.first} to ${facts.last}.`];
    parts.push(facts.confirmed ? `${facts.confirmed} confirmed and ${rows.length - facts.confirmed} still waiting for a reply.` : 'Nobody has confirmed yet.');
    if (facts.at_risk.length) parts.push(`Most likely to miss: ${facts.at_risk.slice(0, 3).map((x) => `${x.name} (${x.time})`).join(', ')}. Send them a reminder first.`);
    else if (facts.no_reminder_yet.length) parts.push(`${facts.no_reminder_yet.length} ${facts.no_reminder_yet.length === 1 ? 'patient has' : 'patients have'} not had a reminder yet.`);
    if (facts.next_up) parts.push(`Next up: ${facts.next_up.name} at ${facts.next_up.time}.`);
    text = parts.join(' ');
  }
  let ai = false;
  if (rows.length && aiOn()) {
    const out = await askClaude('You write the morning briefing for a clinic receptionist in India. Use only the facts given. Write 2 or 3 short, plain sentences. No emojis, no markdown, no medical advice. Put the most useful action first.', JSON.stringify(facts), 200);
    if (out) { text = out; ai = true; }
  }
  res.json({ text, ai, patients: rows.length, confirmed: facts.confirmed, at_risk: facts.at_risk.length });
}));

/* patient assistant: suggests a visit type and urgency. It never diagnoses. Emergency words are always checked by fixed rules first. */
const EMERGENCY = [/chest (pain|tight|pressure)/i, /heart attack/i, /(can'?t|cannot|unable to|difficulty|trouble) breath/i, /short(ness)? of breath/i, /not breathing/i, /unconscious|passed out|not responding|fainted|collapsed/i,
  /seizure|convulsion|\bfits?\b/i, /stroke|face (is )?droop|slurred|one side.*(weak|numb)/i, /(severe|heavy|a lot of|non.?stop|won'?t stop).{0,15}bleed|bleeding (heavily|a lot|badly|won)/i, /vomit(ing)? blood|blood in (vomit|stool|urine)|coughing (up )?blood/i,
  /poison|overdose|swallowed/i, /snake ?bite|dog ?bite/i, /(road )?accident|head injury|hit (my|his|her) head|broken bone|fracture/i, /anaphyla|throat.{0,12}(swell|closing)|tongue.{0,10}swell/i, /severe (burn|allerg)/i,
  /seene? mein dard|saans (nahi|nhi|phool|lene)|behosh|khoon (bahut|nahi ruk)|zehar|jahar|daura/i, /सीने में|सांस|साँस|बेहोश|दौरा|ज़हर|जहर|खून (बहुत|नहीं)/i];
const SELF_HARM = /suicid|kill myself|end my life|want to die|hurt myself|self.?harm|मरना चाहता|मरना चाहती|jaan dena|marna chahta|marna chahti/i;
const SOON = /(high|very high|strong) fever|fever.{0,20}(3|three|4|four|5|five|many|several) days|pain (is )?(getting )?worse|worsening|severe pain|bahut (dard|bukhar)|infection|swelling|pus|vomit|diarrh|dehydrat|can'?t (eat|sleep)|since (\d+|many|last) (days|week)|तेज़? (दर्द|बुखार)|बहुत (दर्द|बुखार)/i;
function ruleAssist(text) {
  if (SELF_HARM.test(text)) return { urgency: 'emergency', visit_type: 'consultation', summary: 'You do not have to face this alone. Please talk to someone right now: call Tele-MANAS on 14416, or 112 if you are in danger. If a person is with you, tell them how you feel.', tips: [] };
  if (EMERGENCY.some((r) => r.test(text))) return { urgency: 'emergency', visit_type: 'consultation', summary: 'What you describe can be an emergency. Please do not wait for an appointment. Call 112 or go to the nearest hospital emergency room now.', tips: ['If someone is with you, ask them to take you or to call for help.'] };
  let visit_type = 'consultation';
  if (/follow.?up|review|again|previous|last (visit|time)|report (check|dikha)|dikhana/i.test(text)) visit_type = 'follow-up';
  else if (/check.?up|routine|annual|screening|health check|blood test|full body/i.test(text)) visit_type = 'check-up';
  else if (/stitch|suture|dressing|injection|vaccin|removal|procedure|drip|plaster|cast/i.test(text)) visit_type = 'procedure';
  const soon = SOON.test(text);
  const names = { consultation: 'a consultation', 'follow-up': 'a follow-up', 'check-up': 'a check-up', procedure: 'a procedure' };
  return { urgency: soon ? 'soon' : 'routine', visit_type,
    summary: soon ? `This sounds like it should be seen soon. Book the earliest time you can for ${names[visit_type]}. If it gets worse, go to a hospital.` : `${names[visit_type][0].toUpperCase() + names[visit_type].slice(1)} looks like the right booking. Pick a time that suits you.`,
    tips: ['Bring earlier reports and the medicines you take.', 'Note when it started and what makes it better or worse.'] };
}
app.get('/api/patient/features', wrap((req, res) => res.json({ ai: aiOn(), pay: growthApi ? growthApi.payOn() : false, pay_demo: growthApi ? growthApi.demoOn() : false })));
app.post('/api/patient/assist', wrap(async (req, res) => {
  throttle('assist:' + req.ip, 12);
  const text = String((req.body || {}).text || '').trim().slice(0, 600);
  if (text.length < 4) throw bad('Tell us a little about what you need, for example "fever for three days".');
  const base = ruleAssist(text);
  logEvent(base.urgency === 'emergency' ? 'emergency' : 'assist');
  if (base.urgency === 'emergency' || !aiOn()) return res.json({ ...base, ai: false });
  const out = await askClaude(
    'You help a patient in India choose what kind of clinic visit to book. You are NOT a doctor: never diagnose, never name medicines or doses. Reply with JSON only: {"urgency":"emergency|soon|routine","visit_type":"consultation|follow-up|check-up|procedure","summary":"1 or 2 plain sentences in the same language as the patient","tips":["up to 2 short practical tips"]}. Use "emergency" whenever there is any sign of a life-threatening problem, and say to call 112 or go to the nearest hospital. Use "soon" if it should be seen within a day or two.',
    text, 350);
  let j = null; try { j = JSON.parse((out || '').match(/\{[\s\S]*\}/)[0]); } catch {}
  if (!j || !['emergency', 'soon', 'routine'].includes(j.urgency) || !['consultation', 'follow-up', 'check-up', 'procedure'].includes(j.visit_type) || typeof j.summary !== 'string') return res.json({ ...base, ai: false });
  res.json({ urgency: j.urgency, visit_type: j.visit_type, summary: j.summary.slice(0, 400), tips: (Array.isArray(j.tips) ? j.tips : []).filter((t) => typeof t === 'string').slice(0, 2).map((t) => t.slice(0, 160)), ai: true });
}));

/* ---------- pages and login ---------- */
function staffAuth(req, res, next) {
  const t = cookieOf(req, 'baari_staff');
  const row = t && db.prepare('SELECT u.id, u.username, u.name, u.role, u.clinic_id FROM staff_sessions s JOIN staff_users u ON u.id = s.staff_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha(t), Date.now());
  if (row) { req.staff = row; return next(); }
  if (req.originalUrl.startsWith('/api')) return res.status(401).json({ error: 'Log in to continue.' });
  res.redirect('/staff/login');
}
app.get(['/', '/index.html'], clinicOnly, staffAuth, (req, res) => res.sendFile(path.join(privateDir, 'desk.html')));
app.get(['/staff/login', '/staff/profile'], clinicOnly, (req, res) => res.sendFile(path.join(privateDir, 'staff.html')));
app.get(['/patient/login', '/patient/profile'], (req, res) => res.sendFile(path.join(publicDir, 'account.html')));
app.get(['/patient', '/patient.html'], (req, res) => res.sendFile(path.join(publicDir, 'patient.html')));
app.get('/account.html', (req, res) => res.redirect('/patient/login'));

/* ---------- patient endpoints (no login) ---------- */
function nextFreeSlot(clinicId) {
  const now = new Date();
  const cutoff = now.getHours() * 60 + now.getMinutes() + 15;
  for (let i = 0; i < 7; i++) {
    const day = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
    const taken = new Set(db.prepare(`SELECT appointment_time FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE}`).all(clinicId, day).map((r) => r.appointment_time));
    if (growthApi) { for (const t of growthApi.heldTimes(clinicId, day)) taken.add(t); for (const t of growthApi.reservedTimes(clinicId, day)) taken.add(t); }
    for (let h = 9; h < 17; h++) for (const m of [0, 30]) {
      const time = `${pad(h)}:${pad(m)}`;
      if (taken.has(time) || (i === 0 && h * 60 + m < cutoff)) continue;
      return { date: day, time };
    }
  }
  return null;
}
app.get('/api/patient/clinics', wrap((req, res) => {
  const rows = db.prepare("SELECT id, name, doctor_name, phone, location, latitude, longitude, services, offer FROM clinics WHERE COALESCE(status, 'active') = 'active'").all();
  res.json(rows.map((c) => ({ ...c, next_slot: nextFreeSlot(c.id), ...(growthApi ? growthApi.rating(c.id) : {}), ...(growthApi ? (() => { const pl = growthApi.planOf(c.id); return pl ? { plan_name: pl.plan_name || 'Priority plan', plan_price: pl.plan_price || 0, plan_days: pl.plan_days || 30 } : {}; })() : {}) })));
}));
app.get('/api/patient/clinics/:id/slots', wrap((req, res) => {
  const clinic = db.prepare("SELECT * FROM clinics WHERE id = ? AND COALESCE(status, 'active') = 'active'").get(req.params.id);
  if (!clinic) throw bad('Clinic not found', 404);
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Choose a date.');
  const taken = new Set(db.prepare(`SELECT appointment_time FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE}`).all(clinic.id, date).map((r) => r.appointment_time));
  const holds = growthApi ? growthApi.heldTimes(clinic.id, date) : new Set();
  const member = growthApi ? growthApi.isMember(clinic.id, req.query.phone) : false;
  const resv = growthApi && !member ? growthApi.reservedTimes(clinic.id, date) : new Set();
  const slots = [];
  for (let h = 9; h < 17; h++) for (const m of [0, 30]) { const time = `${pad(h)}:${pad(m)}`; const mo = resv.has(time) && !taken.has(time) && !holds.has(time); slots.push({ time, available: !taken.has(time) && !holds.has(time) && !mo, members_only: mo }); }
  res.json({ clinic_id: clinic.id, clinic_name: clinic.name, doctor_name: clinic.doctor_name, date, member, slots });
}));
app.post('/api/patient/book', wrap((req, res) => {
  throttle('book:' + req.ip, 20);
  const b = req.body || {};
  if (!/^(09|1[0-6]):(00|30)$/.test(b.appointment_time || '')) throw bad('Choose one of the listed times.');
  if (b.appointment_date < localToday()) throw bad('Choose a day that has not passed.');
  if (growthApi) growthApi.guardBooking(req, b);
  const id = insertAppointment(b, 'pending');
  const vt = db.prepare('SELECT visit_token FROM appointments WHERE id = ?').get(id);
  res.json({ id, appointment_id: id, visit_token: vt ? vt.visit_token : null, message: 'Booked' });
}));


/* ---------- patient accounts (optional: patients can still book without one) ---------- */
const phone10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const validPhone10 = (p) => /^[6-9]\d{9}$/.test(p);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const COOKIE = 'baari_patient', MONTH_MS = 30 * 24 * 3600 * 1000;
function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function startSession(res, patientId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO patient_sessions (token_hash, patient_id, expires_at) VALUES (?, ?, ?)').run(sha(token), patientId, Date.now() + MONTH_MS);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MONTH_MS / 1000}`);
}
function patientOf(req) {
  const t = cookieOf(req, COOKIE); if (!t) return null;
  const row = db.prepare('SELECT p.id, p.name, p.phone FROM patient_sessions s JOIN patients p ON p.id = s.patient_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha(t), Date.now());
  return row || null;
}
const needPatient = (req) => { const p = patientOf(req); if (!p) throw bad('Log in to continue.', 401); return p; };
const attempts = new Map();
function throttle(key, max = 8) {
  const now = Date.now(), list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= max) throw bad('Too many attempts. Wait a few minutes and try again.', 429);
  list.push(now); attempts.set(key, list);
}
const cleanName = (n) => { const v = String(n || '').trim().replace(/\s+/g, ' '); if (v.length < 2 || v.length > 80) throw bad('Enter your name.'); return v; };
const cleanPw = (p) => { const v = String(p || ''); if (v.length < 6 || v.length > 100) throw bad('Use a password of at least 6 characters.'); return v; };
app.post('/api/patient/register', wrap((req, res) => {
  throttle('reg:' + req.ip);
  const b = req.body || {}, phone = phone10(b.phone);
  if (!validPhone10(phone)) throw bad('Enter a valid 10-digit WhatsApp number.');
  const name = cleanName(b.name), pw = cleanPw(b.password);
  if (db.prepare('SELECT id FROM patients WHERE phone = ?').get(phone)) throw bad('This number already has an account. Log in instead.', 409);
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO patients (name, phone, salt, hash) VALUES (?, ?, ?, ?)').run(name, phone, salt, hashPw(pw, salt));
  startSession(res, Number(r.lastInsertRowid));
  res.json({ name, phone });
}));
app.post('/api/patient/login', wrap((req, res) => {
  const b = req.body || {}, phone = phone10(b.phone);
  throttle('login:' + phone + ':' + req.ip);
  const row = db.prepare('SELECT * FROM patients WHERE phone = ?').get(phone);
  const ok = row && crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), row.salt), 'hex'), Buffer.from(row.hash, 'hex'));
  if (!ok) throw bad('That number and password do not match.', 401);
  startSession(res, row.id);
  res.json({ name: row.name, phone: row.phone });
}));
app.post('/api/patient/logout', wrap((req, res) => {
  const t = cookieOf(req, COOKIE); if (t) db.prepare('DELETE FROM patient_sessions WHERE token_hash = ?').run(sha(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ message: 'Logged out' });
}));
app.get('/api/patient/me', wrap((req, res) => { const p = patientOf(req); res.json(p ? { name: p.name, phone: p.phone } : null); }));
app.put('/api/patient/me', wrap((req, res) => {
  const p = needPatient(req), name = cleanName((req.body || {}).name);
  db.prepare('UPDATE patients SET name = ? WHERE id = ?').run(name, p.id);
  res.json({ name, phone: p.phone });
}));
app.put('/api/patient/password', wrap((req, res) => {
  const p = needPatient(req), b = req.body || {}, row = db.prepare('SELECT * FROM patients WHERE id = ?').get(p.id);
  throttle('pw:' + p.id);
  if (!crypto.timingSafeEqual(Buffer.from(hashPw(String(b.current || ''), row.salt), 'hex'), Buffer.from(row.hash, 'hex'))) throw bad('Your current password is not right.', 401);
  const next = cleanPw(b.next), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE patients SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(next, salt), p.id);
  res.json({ message: 'Password changed' });
}));
const MY_APPTS = `SELECT a.id, a.appointment_date, a.appointment_time, a.visit_type, a.status, a.confirmed, c.name AS clinic_name, c.doctor_name, c.location, c.phone AS clinic_phone
  FROM appointments a JOIN clinics c ON c.id = a.clinic_id
  WHERE substr(replace(replace(replace(replace(a.patient_phone, ' ', ''), '+', ''), '-', ''), '(', ''), -10) = ? ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 100`;
app.get('/api/patient/appointments', wrap((req, res) => res.json(db.prepare(MY_APPTS).all(needPatient(req).phone))));
app.put('/api/patient/appointments/:id/cancel', wrap((req, res) => {
  const p = needPatient(req), mine = db.prepare(MY_APPTS).all(p.phone).find((a) => a.id === Number(req.params.id));
  if (!mine) throw bad('Booking not found.', 404);
  if (['cancelled', 'no-show'].includes(mine.status)) throw bad('This booking is already closed.');
  if (mine.appointment_date < localToday()) throw bad('Past visits cannot be cancelled.');
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(mine.id);
  res.json({ message: 'Cancelled' });
}));


app.use('/api/staff', clinicOnly);
/* ---------- clinic staff login ---------- */
function ensureStaffSeed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM staff_users').get().n) return;
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO staff_users (username, name, salt, hash) VALUES (?, ?, ?, ?)').run('staff', 'Clinic staff', salt, hashPw(STAFF_PASSWORD, salt));
}
ensureStaffSeed();
const cleanStaffPw = (p, username) => { const v = String(p || ''); if (v.length < 8 || v.length > 100) throw bad('Use a password of at least 8 characters.'); if (['baari123', 'password', '12345678'].includes(v.toLowerCase()) || v.toLowerCase() === String(username || '').toLowerCase()) throw bad('Choose a password that is harder to guess.'); return v; };
const ownerOnly = (req, res, next) => (req.staff && req.staff.role === 'owner' ? next() : res.status(403).json({ error: 'Only the clinic owner can do this.' }));
/* A login tied to one clinic (clinic_id set) can only see and change that clinic. A login with no clinic (older logins) still sees every clinic. */
const needClinic = (req, id) => { const sc = req.staff && req.staff.clinic_id; if (sc && Number(id) !== Number(sc)) throw bad('Not found', 404); };
const myClinic = (req) => (req.staff && req.staff.clinic_id) || null;
const cleanUser = (u) => { const v = String(u || '').trim().toLowerCase(); if (!/^[a-z0-9._-]{3,30}$/.test(v)) throw bad('Username: 3 to 30 letters, numbers, dot, dash or underscore.'); return v; };
const STAFF_HOURS = 12;
const secureFlag = (req) => (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
function startStaffSession(req, res, staffId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO staff_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').run(sha(token), staffId, Date.now() + STAFF_HOURS * 3600 * 1000);
  res.setHeader('Set-Cookie', `baari_staff=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${STAFF_HOURS * 3600}${secureFlag(req)}`);
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
app.post('/api/staff/login', wrap((req, res) => {
  const b = req.body || {}, username = String(b.username || '').trim().toLowerCase().slice(0, 40);
  throttle('staffip:' + req.ip, 30);
  throttle('staff:' + username + ':' + req.ip);
  db.prepare('DELETE FROM staff_sessions WHERE expires_at < ?').run(Date.now());
  const row = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(username);
  const given = hashPw(String(b.password || '').slice(0, 200), row ? row.salt : DUMMY_SALT);
  const ok = row && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(row.hash, 'hex'));
  if (!ok) throw bad('That username and password do not match.', 401);
  startStaffSession(req, res, row.id);
  res.json({ username: row.username, name: row.name });
}));
app.post('/api/staff/logout', wrap((req, res) => {
  const t = cookieOf(req, 'baari_staff'); if (t) db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(sha(t));
  res.setHeader('Set-Cookie', 'baari_staff=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ message: 'Logged out' });
}));

/* ---------- company site (Baari's own people only; separate login, never reachable by clinics or patients) ---------- */
require('./company')({ app, db, path, DB_FILE, askClaude, cleanStaffPw, cleanUser, crypto, privateDir, companyOnly, REMOTE_COMPANY, sha, hashPw, cookieOf, throttle, bad, wrap, localToday, waNumber, aiOn, waConnected, ALIVE, secureFlag });

/* patient chatbot (public: only uses what is already on the booking page) */
require('./chat')({ app, db, wrap, bad, throttle, askClaude, aiOn, ruleAssist, nextFreeSlot, logEvent, localToday });

/* waitlist, live queue, clinic profile, reviews (patient side) */
growthApi = require('./growth').mountPublic({ app, db, wrap, bad, throttle, localToday, pad, isoDay, ALIVE, insertAppointment, publicDir, path });

/* ---------- everything below needs the staff login ---------- */
app.use('/api', clinicOnly, staffAuth);
require('./clinicai')({ app, db, wrap, bad, throttle, ownerOnly, needClinic, localToday, askClaude, aiOn, riskContext, riskFor, ALIVE, p10 });
require('./growth').mountStaff({ app, db, wrap, bad, ownerOnly, needClinic, myClinic, localToday, isoDay, ALIVE, insertAppointment, advance: growthApi.advance, patientHost: () => HOSTS.patient[0] || '' });

/* ---------- staff profile and team (login required) ---------- */
app.get('/api/staff/me', wrap((req, res) => {
  const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(req.staff.id);
  const weak = ['baari123', STAFF_PASSWORD].some((p) => hashPw(p, row.salt) === row.hash);
  res.json({ id: row.id, username: row.username, name: row.name, role: row.role || 'owner', clinic_id: row.clinic_id || null, created_at: row.created_at, default_password: weak, patient_url: HOSTS.patient[0] ? `https://${HOSTS.patient[0]}/patient` : null });
}));
app.put('/api/staff/me', wrap((req, res) => {
  const name = cleanName((req.body || {}).name);
  db.prepare('UPDATE staff_users SET name = ? WHERE id = ?').run(name, req.staff.id);
  res.json({ name });
}));
app.put('/api/staff/password', wrap((req, res) => {
  const b = req.body || {}, row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(req.staff.id);
  throttle('spw:' + req.staff.id);
  if (!crypto.timingSafeEqual(Buffer.from(hashPw(String(b.current || ''), row.salt), 'hex'), Buffer.from(row.hash, 'hex'))) throw bad('Your current password is not right.', 401);
  const next = cleanStaffPw(b.next, row.username), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE staff_users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(next, salt), req.staff.id);
  db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(req.staff.id);
  startStaffSession(req, res, req.staff.id);
  res.json({ message: 'Password changed' });
}));
app.get('/api/staff/team', ownerOnly, wrap((req, res) => res.json(db.prepare('SELECT id, username, name, role, created_at FROM staff_users WHERE clinic_id IS ? ORDER BY id').all(myClinic(req)))));
app.post('/api/staff/team', ownerOnly, wrap((req, res) => {
  const b = req.body || {}, name = cleanName(b.name), username = cleanUser(b.username), pw = cleanStaffPw(b.password, b.username);
  if (db.prepare('SELECT id FROM staff_users WHERE username = ?').get(username)) throw bad('That username is taken.', 409);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO staff_users (username, name, salt, hash, role, clinic_id) VALUES (?, ?, ?, ?, ?, ?)').run(username, name, salt, hashPw(pw, salt), b.role === 'owner' ? 'owner' : 'staff', myClinic(req));
  res.json({ message: 'Team member added' });
}));
app.put('/api/staff/team/:id/password', ownerOnly, wrap((req, res) => {
  const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(req.params.id));
  if (!row || (row.clinic_id || null) !== myClinic(req)) throw bad('Team member not found.', 404);
  const next = cleanStaffPw((req.body || {}).password, row.username), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE staff_users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(next, salt), row.id);
  if (row.id !== req.staff.id) db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(row.id);
  res.json({ message: 'Password reset' });
}));
app.delete('/api/staff/team/:id', ownerOnly, wrap((req, res) => {
  const id = Number(req.params.id);
  if (id === req.staff.id) throw bad('You cannot remove your own login.');
  const target = db.prepare('SELECT clinic_id FROM staff_users WHERE id = ?').get(id);
  if (!target || (target.clinic_id || null) !== myClinic(req)) throw bad('Team member not found.', 404);
  db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(id);
  db.prepare('DELETE FROM staff_users WHERE id = ?').run(id);
  res.json({ message: 'Removed' });
}));

app.get('/api/clinics', wrap((req, res) => res.json(db.prepare('SELECT id, name, phone, doctor_name, location, latitude, longitude, services, offer, reminder_lang, plan, fees, languages, about, maps_url, avg_minutes, created_at FROM clinics WHERE (? IS NULL OR id = ?)').all(myClinic(req), myClinic(req)))));
app.post('/api/clinics', ownerOnly, wrap((req, res) => {
  if (myClinic(req)) throw bad('New clinics are added by the Baari team.', 403);
  const { name, phone, doctor_name, plan, location } = req.body || {};
  const services = String(req.body.services || '').trim().slice(0, 120), offer = String(req.body.offer || '').trim().slice(0, 80);
  const lat = Number(req.body.latitude), lng = Number(req.body.longitude);
  const hasGeo = req.body.latitude !== '' && req.body.latitude != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!String(name || '').trim() || !String(doctor_name || '').trim() || !String(phone || '').trim()) throw bad('Enter the clinic name, doctor and phone.');
  const bb = req.body || {}, svc = String(bb.services || '').trim().slice(0, 120), off = String(bb.offer || '').trim().slice(0, 80);
  const r = db.prepare('INSERT INTO clinics (name, phone, doctor_name, plan, location, latitude, longitude, services, offer, reminder_lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(String(name).trim(), String(phone).trim(), String(doctor_name).trim(), plan || 'basic', String(location || '').trim().slice(0, 200), hasGeo ? lat : null, hasGeo ? lng : null, svc, off, LANGS.includes(bb.reminder_lang) ? bb.reminder_lang : 'en');
  res.json({ id: Number(r.lastInsertRowid), message: 'Clinic added' });
}));
app.put('/api/clinics/:id', ownerOnly, wrap((req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim() || !String(b.doctor_name || '').trim() || !String(b.phone || '').trim()) throw bad('Enter the clinic name, doctor and phone.');
  needClinic(req, req.params.id);
  const existing = db.prepare('SELECT id, plan FROM clinics WHERE id = ?').get(req.params.id);
  if (!existing) throw bad('Clinic not found', 404);
  const lat = Number(b.latitude), lng = Number(b.longitude);
  const hasGeo = b.latitude !== '' && b.latitude != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  db.prepare('UPDATE clinics SET name = ?, doctor_name = ?, phone = ?, location = ?, plan = ?, latitude = ?, longitude = ?, services = ?, offer = ?, reminder_lang = ? WHERE id = ?')
    .run(String(b.name).trim(), String(b.doctor_name).trim(), String(b.phone).trim(), String(b.location || '').trim().slice(0, 200), myClinic(req) ? existing.plan : (['basic', 'pro', 'enterprise'].includes(b.plan) ? b.plan : 'basic'), hasGeo ? lat : null, hasGeo ? lng : null, String(b.services || '').trim().slice(0, 120), String(b.offer || '').trim().slice(0, 80), LANGS.includes(b.reminder_lang) ? b.reminder_lang : 'en', req.params.id);
  res.json({ message: 'Clinic updated' });
}));
app.get('/api/clinics/:id', wrap((req, res) => (needClinic(req, req.params.id), res.json(db.prepare('SELECT id, name, phone, doctor_name, location, plan FROM clinics WHERE id = ?').get(req.params.id)))));

app.get('/api/clinics/:id/appointments', wrap((req, res) => {
  needClinic(req, req.params.id);
  const hist = riskContext(myClinic(req));
  const rows = db.prepare('SELECT * FROM appointments WHERE clinic_id = ? AND appointment_date >= ? ORDER BY appointment_date, appointment_time').all(req.params.id, localToday());
  res.json(rows.map((a) => (['cancelled', 'no-show'].includes(a.status) ? a : { ...a, risk: riskFor(a, hist) })));
}));
app.post('/api/appointments', wrap((req, res) => {
  const body = { ...(req.body || {}) };
  if (myClinic(req)) body.clinic_id = myClinic(req);
  const id = insertAppointment(body, 'scheduled');
  res.json({ id, message: 'Appointment added' });
}));
const setStatus = (sql) => wrap((req, res) => { const a = db.prepare('SELECT clinic_id FROM appointments WHERE id = ?').get(req.params.id); if (!a) throw bad('Appointment not found', 404); needClinic(req, a.clinic_id); db.prepare(sql).run(req.params.id); res.json({ message: 'Updated' }); });
app.put('/api/appointments/:id/confirm', setStatus("UPDATE appointments SET confirmed = 1, status = 'confirmed' WHERE id = ?"));
app.put('/api/appointments/:id/no-show', setStatus("UPDATE appointments SET no_show = 1, status = 'no-show' WHERE id = ?"));
app.put('/api/appointments/:id/cancel', setStatus("UPDATE appointments SET status = 'cancelled' WHERE id = ?"));

app.get('/api/whatsapp/status', wrap((req, res) => res.json({ mode: waConnected() ? 'cloud' : 'manual', automatic: waConnected() })));
app.post('/api/whatsapp/send', wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.body?.appointment_id);
  const clinic = a && db.prepare('SELECT * FROM clinics WHERE id = ?').get(a.clinic_id);
  if (!a || !clinic) throw bad('Appointment not found', 404);
  needClinic(req, a.clinic_id);
  res.json(await sendReminder(a, clinic));
}));
app.get('/api/whatsapp/logs/:clinic_id', wrap((req, res) => {
  needClinic(req, req.params.clinic_id);
  res.json(db.prepare(`SELECT wl.*, a.patient_name FROM whatsapp_logs wl JOIN appointments a ON wl.appointment_id = a.id
    WHERE a.clinic_id = ? ORDER BY wl.id DESC LIMIT 30`).all(req.params.clinic_id));
}));

app.get('/api/clinics/:id/report', ownerOnly, wrap((req, res) => {
  needClinic(req, req.params.id);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : localToday().slice(0, 7);
  const s = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed, SUM(CASE WHEN no_show = 1 THEN 1 ELSE 0 END) AS no_shows,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled, SUM(CASE WHEN whatsapp_sent = 1 THEN 1 ELSE 0 END) AS sent
    FROM appointments WHERE clinic_id = ? AND appointment_date BETWEEN ? AND ?`).get(req.params.id, `${month}-01`, `${month}-31`);
  const total = s.total || 0, noShows = s.no_shows || 0;
  res.json({ month, total_appointments: total, confirmed: s.confirmed || 0, no_shows: noShows, cancelled: s.cancelled || 0, whatsapp_sent: s.sent || 0,
    no_show_rate: `${total ? ((noShows / total) * 100).toFixed(1) : '0.0'}%` });
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Baari is running on http://localhost:${PORT}`);
  console.log(`Clinic desk:    http://localhost:${PORT}   (login: staff / your STAFF_PASSWORD)`);
  console.log(`Patient booking: http://localhost:${PORT}/patient`);
  console.log(AI_KEY() ? 'AI: Anthropic key found' : GROQ_KEY() ? 'AI: Groq key found' : 'AI: no key found (add GROQ_API_KEY=... to .env and restart)');
  console.log(growthApi && growthApi.demoOn() ? 'Payments: DEMO mode. The pay button works but charges no money. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env for real payments.' : process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? 'Razorpay: keys found, patients can buy a priority plan online' + (process.env.RAZORPAY_WEBHOOK_SECRET ? '' : ' (add RAZORPAY_WEBHOOK_SECRET to also catch payments when the patient closes the page)') : 'Razorpay: not set (patients pay at the desk). To enable, add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env');
  if (!waConnected()) console.log('WhatsApp needs BOTH WHATSAPP_TOKEN and WHATSAPP_PHONE_ID. Found: token ' + (process.env.WHATSAPP_TOKEN ? 'yes' : 'NO') + ', phone id ' + (process.env.WHATSAPP_PHONE_ID ? 'yes' : 'NO'));
  console.log(waConnected() ? 'WhatsApp: connected, reminders go out automatically 24 hours before each visit' : 'WhatsApp: not connected, Send reminder opens WhatsApp with the message ready');
  if (HOSTS.patient.length || HOSTS.staff.length || HOSTS.company.length) console.log(`Addresses: patients ${HOSTS.patient.join(',') || '-'} | clinics ${HOSTS.staff.join(',') || '-'} | company ${HOSTS.company.join(',') || '-'}`);
  console.log(`Company site:   http://localhost:${PORT}/company   (Baari team only${REMOTE_COMPANY ? '; remote access ON' : '; this computer or your own network'})`);
  console.log(REMOTE_STAFF ? 'Clinic pages: open to remote access (STAFF_REMOTE=true)' : 'Clinic pages: only open from this computer or your own network. Patients using a public link cannot reach them.');
  if (STAFF_PASSWORD === 'baari123') console.log('Note: change the staff password by adding STAFF_PASSWORD=... to the .env file');
});
