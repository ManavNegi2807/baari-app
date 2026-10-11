// Baari company site: for Baari's own team only. Separate login, separate cookie, never shown to clinics or patients.
const fs = require('fs');
const os = require('os');

module.exports = function mountCompany(ctx) {
  const { app, db, path, DB_FILE, askClaude, cleanStaffPw, cleanUser: cleanLogin, crypto, privateDir, companyOnly, REMOTE_COMPANY, sha, hashPw, cookieOf, throttle, bad, wrap, localToday, aiOn, waConnected, secureFlag } = ctx;
  const COOKIE = 'baari_company', HOURS = 8;

  /* ---------- tables ---------- */
  db.exec(`CREATE TABLE IF NOT EXISTS company_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
    salt TEXT NOT NULL, hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE TABLE IF NOT EXISTS company_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const audit = (who, action, detail) => { try { db.prepare('INSERT INTO audit_log (who, action, detail) VALUES (?, ?, ?)').run(who, action, detail ? String(detail).slice(0, 300) : null); } catch {} };

  /* ---------- first admin ---------- */
  const setPassword = (id, pw) => { const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE company_users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(pw, salt), id); };
  (function seed() {
    const envPw = process.env.COMPANY_PASSWORD;
    const admin = db.prepare("SELECT id FROM company_users WHERE username = 'admin'").get();
    if (!admin) {
      const pw = envPw || crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare("INSERT INTO company_users (username, name, role, salt, hash) VALUES ('admin', 'Baari admin', 'admin', ?, ?)").run(salt, hashPw(pw, salt));
      if (!envPw) console.log(`\n  COMPANY SITE first login:  username  admin   password  ${pw}\n  (shown once. Change it on the Team tab, or set COMPANY_PASSWORD in the .env file)\n`);
      audit('system', 'Admin account created');
    } else if (envPw) { setPassword(admin.id, envPw); }
  })();

  /* ---------- guard and login ---------- */
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  app.use(['/company', '/api/company'], companyOnly, noStore);

  const cleanUser = (u) => { const v = String(u || '').trim().toLowerCase(); if (!/^[a-z0-9._-]{3,30}$/.test(v)) throw bad('Username: 3 to 30 letters, numbers, dot, dash or underscore.'); return v; };
  const cleanPw = (p, username) => {
    const v = String(p || '');
    if (v.length < 10 || v.length > 100) throw bad('Use a password of at least 10 characters.');
    if (['baari123', 'password123', '1234567890'].includes(v.toLowerCase()) || v.toLowerCase() === String(username || '').toLowerCase()) throw bad('Choose a password that is harder to guess.');
    return v;
  };
  const DUMMY = crypto.randomBytes(16).toString('hex');

  app.post('/api/company/login', wrap((req, res) => {
    const b = req.body || {}, username = String(b.username || '').trim().toLowerCase().slice(0, 40);
    throttle('coip:' + req.ip, 30); throttle('co:' + username + ':' + req.ip, 6);
    db.prepare('DELETE FROM company_sessions WHERE expires_at < ?').run(Date.now());
    const row = db.prepare('SELECT * FROM company_users WHERE username = ?').get(username);
    const given = hashPw(String(b.password || '').slice(0, 200), row ? row.salt : DUMMY);
    const ok = row && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(row.hash, 'hex'));
    if (!ok) { audit(username || '?', 'Failed login'); throw bad('That username and password do not match.', 401); }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO company_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), row.id, Date.now() + HOURS * 3600 * 1000);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${HOURS * 3600}${secureFlag(req)}`);
    audit(row.username, 'Logged in');
    res.json({ username: row.username, name: row.name, role: row.role });
  }));
  app.post('/api/company/logout', wrap((req, res) => {
    const t = cookieOf(req, COOKIE); if (t) db.prepare('DELETE FROM company_sessions WHERE token_hash = ?').run(sha(t));
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ message: 'Logged out' });
  }));

  const auth = (req, res, next) => {
    const t = cookieOf(req, COOKIE);
    const row = t && db.prepare('SELECT u.id, u.username, u.name, u.role FROM company_sessions s JOIN company_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha(t), Date.now());
    if (!row) return res.status(401).json({ error: 'Log in to continue.' });
    req.co = row; next();
  };
  const adminOnly = (req, res, next) => (req.co.role === 'admin' ? next() : res.status(403).json({ error: 'Only a Baari admin can do this.' }));
  app.use('/api/company', auth);

  /* ---------- pages ---------- */
  app.get(['/company', '/company/login'], (req, res) => res.sendFile(path.join(privateDir, 'company.html')));

  /* ---------- helpers ---------- */
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const p10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const maskPhone = (p) => { const d = p10(p); return d.length === 10 ? `${d.slice(0, 2)}••••••${d.slice(-2)}` : '••••'; };
  const shortName = (n) => { const w = String(n || '').trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : w[0] || ''; };
  const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const PLANS = ['basic', 'pro', 'enterprise'];
  const prices = () => { try { const j = JSON.parse((one("SELECT value FROM settings WHERE key = 'plan_prices'") || {}).value || '{}'); return PLANS.reduce((o, k) => (typeof j[k] === 'number' ? { ...o, [k]: j[k] } : o), {}); } catch { return {}; } };

  const clinicStats = () => {
    const t = localToday(), d30 = dayOffset(-30), d14 = dayOffset(-14);
    return all(`SELECT c.id, c.name, c.doctor_name, c.phone, c.location, c.plan, COALESCE(c.status, 'active') AS status, c.company_note, c.services, c.offer, c.reminder_lang, c.created_at,
        COUNT(a.id) AS appts,
        COALESCE(SUM(CASE WHEN a.appointment_date >= ? THEN 1 ELSE 0 END), 0) AS appts_30d,
        COALESCE(SUM(CASE WHEN a.appointment_date >= ? THEN 1 ELSE 0 END), 0) AS appts_14d,
        COALESCE(SUM(CASE WHEN a.source = 'patient' THEN 1 ELSE 0 END), 0) AS portal,
        COALESCE(SUM(CASE WHEN a.appointment_date < ? AND a.status NOT IN ('cancelled') THEN 1 ELSE 0 END), 0) AS past,
        COALESCE(SUM(CASE WHEN a.no_show = 1 THEN 1 ELSE 0 END), 0) AS no_shows,
        COALESCE(SUM(CASE WHEN a.whatsapp_sent = 1 THEN 1 ELSE 0 END), 0) AS reminded,
        MAX(a.created_at) AS last_booking
      FROM clinics c LEFT JOIN appointments a ON a.clinic_id = c.id GROUP BY c.id ORDER BY c.id`, d30, d14, t)
      .map((c) => {
        const rate = pct(c.no_shows, c.past);
        let health = 'ok', why = 'Healthy';
        if (c.status !== 'active') { health = 'off'; why = 'Suspended'; }
        else if (!c.appts) { health = 'quiet'; why = 'No bookings yet'; }
        else if (!c.appts_14d) { health = 'quiet'; why = 'No visits in 14 days'; }
        else if (c.past >= 8 && rate >= 25) { health = 'warn'; why = `High no-shows (${rate}%)`; }
        return { ...c, no_show_rate: rate, health, why, listed: Boolean(c.location && c.services) };
      });
  };

  /* ---------- overview ---------- */
  app.get('/api/company/overview', wrap((req, res) => {
    const t = localToday(), d7 = dayOffset(-7), d30 = dayOffset(-30);
    const clinics = clinicStats();
    const active = clinics.filter((c) => c.status === 'active');
    const a = one(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN appointment_date = ? THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN appointment_date >= ? AND appointment_date <= ? THEN 1 ELSE 0 END) AS week,
        SUM(CASE WHEN appointment_date > ? AND appointment_date <= ? THEN 1 ELSE 0 END) AS next7,
        SUM(CASE WHEN source = 'patient' THEN 1 ELSE 0 END) AS portal,
        SUM(CASE WHEN appointment_date < ? AND status <> 'cancelled' THEN 1 ELSE 0 END) AS past,
        SUM(CASE WHEN no_show = 1 THEN 1 ELSE 0 END) AS no_shows,
        SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN whatsapp_sent = 1 THEN 1 ELSE 0 END) AS reminded
      FROM appointments`, t, d7, t, t, dayOffset(7), t);
    const pat = one(`SELECT COUNT(*) AS total, SUM(CASE WHEN date(created_at, 'localtime') >= ? THEN 1 ELSE 0 END) AS d7, SUM(CASE WHEN date(created_at, 'localtime') >= ? THEN 1 ELSE 0 END) AS d30 FROM patients`, d7, d30);
    const unique = one(`SELECT COUNT(DISTINCT substr(replace(replace(patient_phone,' ',''),'+',''), -10)) AS n FROM appointments`).n;
    const days = []; for (let i = 29; i >= 0; i--) days.push(dayOffset(-i));
    const byDay = new Map(all(`SELECT date(created_at, 'localtime') AS d, COUNT(*) AS n, SUM(CASE WHEN source = 'patient' THEN 1 ELSE 0 END) AS portal FROM appointments WHERE date(created_at, 'localtime') >= ? GROUP BY d`, days[0]).map((r) => [r.d, r]));
    const weeks = []; for (let i = 7; i >= 0; i--) { const end = dayOffset(-i * 7), start = dayOffset(-i * 7 - 6); weeks.push({ start, end, n: one("SELECT COUNT(*) AS n FROM patients WHERE date(created_at, 'localtime') BETWEEN ? AND ?", start, end).n }); }
    const pr = prices();
    const priced = active.filter((c) => typeof pr[c.plan] === 'number');
    const mrr = Object.keys(pr).length ? priced.reduce((s, c) => s + pr[c.plan], 0) : null;
    const planCount = PLANS.map((p) => ({ plan: p, n: active.filter((c) => c.plan === p).length }));
    res.json({
      kpi: { clinics: clinics.length, active: active.length, suspended: clinics.length - active.length, bookings: a.total || 0, today: a.today || 0, week: a.week || 0, next7: a.next7 || 0,
        portal_share: pct(a.portal || 0, a.total || 0), patients: unique, accounts: pat.total || 0, accounts_7d: pat.d7 || 0, accounts_30d: pat.d30 || 0,
        no_show_rate: pct(a.no_shows || 0, a.past || 0), confirm_rate: pct(a.confirmed || 0, a.total || 0), reminded: a.reminded || 0, mrr, priced: priced.length, plan_count: planCount },
      bookings_per_day: days.map((d) => ({ day: d, n: (byDay.get(d) || {}).n || 0, portal: (byDay.get(d) || {}).portal || 0 })),
      signups_per_week: weeks,
      attention: clinics.filter((c) => c.health === 'warn' || c.health === 'quiet').map((c) => ({ id: c.id, name: c.name, why: c.why, health: c.health })).slice(0, 8),
    });
  }));

  /* ---------- clinics ---------- */
  app.get('/api/company/clinics', wrap((req, res) => {
    res.json(clinicStats().map(({ phone, ...c }) => ({ ...c, phone })));
  }));
  app.get('/api/company/clinics/:id', wrap((req, res) => {
    const c = clinicStats().find((x) => x.id === Number(req.params.id));
    if (!c) throw bad('Clinic not found', 404);
    const t = localToday();
    const recent = all(`SELECT appointment_date, appointment_time, visit_type, status, source, no_show, confirmed FROM appointments WHERE clinic_id = ? ORDER BY id DESC LIMIT 12`, c.id);
    const types = all(`SELECT visit_type AS k, COUNT(*) AS n FROM appointments WHERE clinic_id = ? GROUP BY visit_type ORDER BY n DESC`, c.id);
    const wa = all(`SELECT wl.status AS k, COUNT(*) AS n FROM whatsapp_logs wl JOIN appointments a ON a.id = wl.appointment_id WHERE a.clinic_id = ? GROUP BY wl.status`, c.id);
    res.json({ ...c, recent, types, whatsapp: wa, upcoming: one(`SELECT COUNT(*) AS n FROM appointments WHERE clinic_id = ? AND appointment_date >= ? AND status NOT IN ('cancelled','no-show')`, c.id, t).n });
  }));
  app.put('/api/company/clinics/:id', adminOnly, wrap((req, res) => {
    const c = one('SELECT * FROM clinics WHERE id = ?', req.params.id);
    if (!c) throw bad('Clinic not found', 404);
    const b = req.body || {}, changes = [];
    let plan = c.plan, status = c.status || 'active', note = c.company_note || '';
    if (b.plan !== undefined) { if (!PLANS.includes(b.plan)) throw bad('Choose a valid plan.'); if (b.plan !== plan) changes.push(`plan ${plan} to ${b.plan}`); plan = b.plan; }
    if (b.status !== undefined) { if (!['active', 'suspended'].includes(b.status)) throw bad('Choose a valid status.'); if (b.status !== status) changes.push(b.status === 'suspended' ? 'suspended' : 'reactivated'); status = b.status; }
    if (b.company_note !== undefined) { const n = String(b.company_note).trim().slice(0, 500); if (n !== note) changes.push('note edited'); note = n; }
    db.prepare('UPDATE clinics SET plan = ?, status = ?, company_note = ? WHERE id = ?').run(plan, status, note, c.id);
    if (changes.length) audit(req.co.username, `Clinic updated: ${c.name}`, changes.join(', '));
    res.json({ message: 'Saved' });
  }));

  /* ---------- add a clinic and its logins (each login only sees its own clinic) ---------- */
  const newLogin = (clinicId, b, role) => {
    const username = cleanLogin(b.username), name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw bad('Enter the person\'s name.');
    if (one('SELECT 1 FROM staff_users WHERE username = ?', username)) throw bad('That username is taken.', 409);
    const pw = cleanStaffPw(b.password, username), salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO staff_users (username, name, salt, hash, role, clinic_id) VALUES (?, ?, ?, ?, ?, ?)').run(username, name, salt, hashPw(pw, salt), role, clinicId);
    return username;
  };
  app.post('/api/company/clinics', adminOnly, wrap((req, res) => {
    const b = req.body || {}, name = String(b.name || '').trim(), doctor = String(b.doctor_name || '').trim(), phone = String(b.phone || '').trim();
    if (!name || !doctor || !phone) throw bad('Enter the clinic name, doctor and phone.');
    if (name.length > 100 || doctor.length > 80 || phone.length > 30) throw bad('One of those is too long.');
    const plan = PLANS.includes(b.plan) ? b.plan : 'basic', o = b.owner || {};
    // check the owner login first so nothing is half-created
    cleanLogin(o.username); cleanStaffPw(o.password, o.username);
    if (one('SELECT 1 FROM staff_users WHERE username = ?', String(o.username).trim().toLowerCase())) throw bad('That owner username is taken.', 409);
    const r = db.prepare('INSERT INTO clinics (name, phone, doctor_name, plan, location, services, offer, reminder_lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, phone, doctor, plan, String(b.location || '').trim().slice(0, 200), String(b.services || '').trim().slice(0, 120), String(b.offer || '').trim().slice(0, 80), ['en', 'hi', 'hinglish'].includes(b.reminder_lang) ? b.reminder_lang : 'en');
    const id = Number(r.lastInsertRowid);
    const username = newLogin(id, { username: o.username, name: o.name || doctor, password: o.password }, 'owner');
    audit(req.co.username, `Clinic added: ${name}`, `owner login ${username}, ${plan}`);
    res.json({ id, message: 'Clinic added' });
  }));
  app.get('/api/company/clinics/:id/logins', wrap((req, res) => res.json(all('SELECT id, username, name, role, created_at FROM staff_users WHERE clinic_id = ? ORDER BY id', Number(req.params.id)))));
  app.post('/api/company/clinics/:id/logins', adminOnly, wrap((req, res) => {
    const c = one('SELECT id, name FROM clinics WHERE id = ?', req.params.id);
    if (!c) throw bad('Clinic not found', 404);
    const b = req.body || {}, username = newLogin(c.id, b, b.role === 'owner' ? 'owner' : 'staff');
    audit(req.co.username, `Clinic login added: ${c.name}`, `${username} (${b.role === 'owner' ? 'owner' : 'staff'})`);
    res.json({ message: 'Added' });
  }));
  const clinicLogin = (id) => { const r = one('SELECT id, username, clinic_id, salt FROM staff_users WHERE id = ?', Number(id)); if (!r || !r.clinic_id) throw bad('Login not found', 404); return r; };
  app.put('/api/company/logins/:uid/password', adminOnly, wrap((req, res) => {
    const row = clinicLogin(req.params.uid), pw = cleanStaffPw((req.body || {}).password, row.username), salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE staff_users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(pw, salt), row.id);
    db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(row.id);
    audit(req.co.username, 'Clinic login password reset', row.username);
    res.json({ message: 'Password reset' });
  }));
  app.delete('/api/company/logins/:uid', adminOnly, wrap((req, res) => {
    const row = clinicLogin(req.params.uid);
    db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(row.id);
    db.prepare('DELETE FROM staff_users WHERE id = ?').run(row.id);
    audit(req.co.username, 'Clinic login removed', row.username);
    res.json({ message: 'Removed' });
  }));

  /* ---------- insights: what needs attention. Built from totals only; no patient names or phone numbers are used or sent anywhere ---------- */
  function facts() {
    const t = localToday(), d7 = dayOffset(-7), d14 = dayOffset(-14), d30 = dayOffset(-30);
    const clinics = clinicStats(), act = clinics.filter((c) => c.status === 'active');
    const n = (sql, ...a) => one(sql, ...a).n;
    const cur7 = n("SELECT COUNT(*) AS n FROM appointments WHERE date(created_at,'localtime') >= ?", d7);
    const prev7 = n("SELECT COUNT(*) AS n FROM appointments WHERE date(created_at,'localtime') >= ? AND date(created_at,'localtime') < ?", d14, d7);
    const r = one(`SELECT COALESCE(SUM(CASE WHEN whatsapp_sent=1 THEN 1 ELSE 0 END),0) AS rn, COALESCE(SUM(CASE WHEN whatsapp_sent=1 AND no_show=1 THEN 1 ELSE 0 END),0) AS rns,
        COALESCE(SUM(CASE WHEN whatsapp_sent=0 THEN 1 ELSE 0 END),0) AS nn, COALESCE(SUM(CASE WHEN whatsapp_sent=0 AND no_show=1 THEN 1 ELSE 0 END),0) AS nns FROM appointments WHERE appointment_date < ? AND status <> 'cancelled'`, t);
    const all = one("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN source='patient' THEN 1 ELSE 0 END),0) AS p, COALESCE(SUM(CASE WHEN whatsapp_sent=1 THEN 1 ELSE 0 END),0) AS r, COALESCE(SUM(CASE WHEN no_show=1 THEN 1 ELSE 0 END),0) AS ns FROM appointments");
    const pastAll = n("SELECT COUNT(*) AS n FROM appointments WHERE appointment_date < ? AND status <> 'cancelled'", t);
    const ev = (type, since) => n("SELECT COUNT(*) AS n FROM events WHERE type = ? AND date(created_at,'localtime') >= ?", type, since);
    const old = Date.now() - 7 * 86400000;
    const quiet = act.filter((c) => c.appts > 0 && c.appts_14d === 0);
    const never = act.filter((c) => c.appts === 0 && new Date(String(c.created_at).replace(' ', 'T') + 'Z').getTime() < old);
    const pr = prices(), mrr = Object.keys(pr).length ? act.reduce((s2, c) => s2 + (typeof pr[c.plan] === 'number' ? pr[c.plan] : 0), 0) : null;
    const riskMrr = Object.keys(pr).length ? [...quiet, ...never].reduce((s2, c) => s2 + (typeof pr[c.plan] === 'number' ? pr[c.plan] : 0), 0) : null;
    return { date: t, clinics: { total: clinics.length, active: act.length, suspended: clinics.length - act.length },
      bookings: { total: all.n, made_this_week: cur7, made_last_week: prev7, portal_share_percent: pct(all.p, all.n), reminded_percent: pct(all.r, all.n) },
      no_show: { overall_percent: pct(all.ns, pastAll), reminded_percent: pct(r.rns, r.rn), not_reminded_percent: pct(r.nns, r.nn), reminded_n: r.rn, not_reminded_n: r.nn },
      plans: PLANS.reduce((o, p2) => ({ ...o, [p2]: act.filter((c) => c.plan === p2).length }), {}), monthly_revenue: mrr, revenue_at_risk: riskMrr,
      top_clinics: [...clinics].sort((a, b) => b.appts_30d - a.appts_30d).slice(0, 5).map((c) => ({ name: c.name, bookings_30d: c.appts_30d, no_show_percent: c.no_show_rate })),
      quiet: quiet.map((c) => ({ id: c.id, name: c.name })), never_started: never.map((c) => ({ id: c.id, name: c.name })),
      high_no_show: act.filter((c) => c.health === 'warn').map((c) => ({ id: c.id, name: c.name, percent: c.no_show_rate })),
      incomplete_listings: act.filter((c) => !c.location || !c.services).length,
      waiting_over_a_day: n("SELECT COUNT(*) AS n FROM appointments WHERE source='patient' AND status='pending' AND appointment_date >= ? AND created_at < datetime('now','-1 day')", t),
      failed_reminders_7d: n("SELECT COUNT(*) AS n FROM whatsapp_logs WHERE status LIKE 'failed%' AND date(sent_at,'localtime') >= ?", d7),
      assistant_questions_30d: ev('assist', d30) + ev('emergency', d30), chat_messages_30d: ev('chat', d30), emergency_alerts_30d: ev('emergency', d30),
      accounts_30d: n("SELECT COUNT(*) AS n FROM patients WHERE date(created_at,'localtime') >= ?", d30) };
  }
  const nm = (list) => list.slice(0, 4).map((c) => c.name).join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');
  function findings(f) {
    const F = [], add = (level, title, detail, list) => F.push({ level, title, detail, clinic_ids: (list || []).map((c) => c.id).filter(Boolean), clinics: (list || []).filter((c) => c.id).map((c) => ({ id: c.id, name: c.name })) });
    const b = f.bookings, ch = b.made_last_week ? Math.round(((b.made_this_week - b.made_last_week) / b.made_last_week) * 100) : null;
    if (b.made_last_week >= 5 && ch <= -20) add('act', `Bookings fell ${-ch}% this week`, `${b.made_this_week} bookings made this week against ${b.made_last_week} last week.`);
    else if (b.made_last_week >= 5 && ch >= 15) add('good', `Bookings grew ${ch}% this week`, `${b.made_this_week} bookings made this week against ${b.made_last_week} last week.`);
    else if (b.made_this_week + b.made_last_week === 0 && f.clinics.active > 0) add('act', 'No bookings in the last two weeks', 'Check that clinics are using the desk and sharing their booking link.');
    else add('good', `${b.made_this_week} bookings made this week`, b.made_last_week ? `Last week: ${b.made_last_week}.` : 'Growth compares from next week.');
    if (f.quiet.length) add('act', `${f.quiet.length} clinic${f.quiet.length > 1 ? 's' : ''} stopped booking`, `No visits in 14 days: ${nm(f.quiet)}. A call from your team now is cheaper than losing them.`, f.quiet);
    if (f.never_started.length) add('act', `${f.never_started.length} clinic${f.never_started.length > 1 ? 's have' : ' has'} not taken a booking yet`, `Joined over a week ago: ${nm(f.never_started)}. They may need help with setup or sharing the booking link.`, f.never_started);
    if (f.high_no_show.length) add('watch', 'High no-show clinics', f.high_no_show.slice(0, 4).map((c) => `${c.name} (${c.percent}%)`).join(', ') + '. Check that reminders are on for them.', f.high_no_show);
    const ns = f.no_show;
    if (ns.reminded_n >= 10 && ns.not_reminded_n >= 10) add(ns.reminded_percent < ns.not_reminded_percent ? 'good' : 'watch', ns.reminded_percent < ns.not_reminded_percent ? 'Reminders are working' : 'Reminders are not clearly helping', `${ns.reminded_percent}% no-shows with a reminder against ${ns.not_reminded_percent}% without.`);
    if (b.total >= 20 && b.reminded_percent < 50) add('watch', `Only ${b.reminded_percent}% of bookings got a reminder`, 'Connect WhatsApp so reminders go out automatically for every booking.');
    if (b.total >= 10 && b.portal_share_percent < 20) add('watch', `Only ${b.portal_share_percent}% of bookings come from the patient portal`, 'Help clinics share the booking link on WhatsApp status, Google Maps and at the desk.');
    if (f.incomplete_listings) add('watch', `${f.incomplete_listings} clinic listing${f.incomplete_listings > 1 ? 's are' : ' is'} incomplete`, 'A location and services make a clinic easier to find on the patient portal. See the Patient portal tab.');
    if (f.waiting_over_a_day) add('watch', `${f.waiting_over_a_day} portal booking${f.waiting_over_a_day > 1 ? 's are' : ' is'} waiting over a day`, 'Clinics have not confirmed them. Patients may be left unsure.');
    if (f.failed_reminders_7d) add('watch', `${f.failed_reminders_7d} reminder${f.failed_reminders_7d > 1 ? 's' : ''} failed this week`, 'Check the WhatsApp connection on the System tab.');
    if (f.revenue_at_risk) add('watch', `${'₹'}${f.revenue_at_risk.toLocaleString('en-IN')} a month is at risk`, 'This is the monthly price of clinics that have stopped or never started booking.');
    if (f.emergency_alerts_30d) add('watch', `${f.emergency_alerts_30d} emergency alert${f.emergency_alerts_30d > 1 ? 's' : ''} shown to patients in 30 days`, 'The helper told these patients to call 112. Nothing was stored.');
    if (f.clinics.suspended) add('watch', `${f.clinics.suspended} clinic${f.clinics.suspended > 1 ? 's are' : ' is'} suspended`, 'They are hidden from the patient portal.');
    if (!F.some((x) => x.level !== 'good')) add('good', 'Everything looks healthy', 'No clinic needs attention right now.');
    const order = { act: 0, watch: 1, good: 2 };
    return F.sort((x, y) => order[x.level] - order[y.level]);
  }
  app.get('/api/company/insights', wrap((req, res) => { const f = facts(); res.json({ findings: findings(f), ai_on: aiOn(), updated: new Date().toISOString() }); }));
  app.post('/api/company/insights/summary', wrap(async (req, res) => {
    throttle('cosum:' + req.co.id, 10);
    const f = facts(), fs = findings(f), top = fs.filter((x) => x.level !== 'good').slice(0, 3);
    const rule = { summary: `${f.clinics.active} active clinic${f.clinics.active === 1 ? '' : 's'}. ${f.bookings.made_this_week} booking${f.bookings.made_this_week === 1 ? '' : 's'} made this week${f.bookings.made_last_week ? ` (last week ${f.bookings.made_last_week})` : ''}. ${f.bookings.portal_share_percent}% came from the patient portal and overall ${f.no_show.overall_percent}% of past visits were missed. ` + (top.length ? `${top.length} thing${top.length > 1 ? 's' : ''} need attention.` : 'Nothing needs attention right now.'), priorities: top.length ? top.map((x) => `${x.title}. ${x.detail}`) : ['Keep adding clinics and helping them share their booking link.'], ai: false };
    if (!aiOn()) return res.json(rule);
    const out = await askClaude('You are an analyst for the small team that runs Baari, a clinic appointment platform in India. Use only the data given and never invent numbers. Write a short summary of this week (4 or 5 sentences) and the 3 most important priorities for the team. Be specific and plain. Reply with JSON only: {"summary":"...","priorities":["...","...","..."]}.',
      JSON.stringify({ facts: f, findings: fs.map((x) => ({ level: x.level, title: x.title, detail: x.detail })) }), 600);
    let j = null; try { j = JSON.parse((out || '').match(/\{[\s\S]*\}/)[0]); } catch {}
    if (!j || typeof j.summary !== 'string' || !Array.isArray(j.priorities) || !j.priorities.length) return res.json(rule);
    res.json({ summary: j.summary.trim().slice(0, 1000), priorities: j.priorities.filter((x) => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 240)), ai: true });
  }));
  app.post('/api/company/ask', wrap(async (req, res) => {
    throttle('coask:' + req.co.id, 30);
    const text = String((req.body || {}).question || '').trim().slice(0, 300);
    if (text.length < 3) throw bad('Type a question first.');
    const f = facts(), q = text.toLowerCase();
    if (aiOn()) {
      const out = await askClaude('You answer questions for the team that runs Baari, a clinic appointment platform in India. Answer ONLY from the data given. If it is not in the data, say you do not have it. Plain words, at most 90 words, no markdown.', `Data: ${JSON.stringify(f)}\n\nQuestion: ${text}`, 300);
      if (out) return res.json({ answer: out.slice(0, 800), ai: true });
    }
    let a = null;
    if (/(top|most|best|busiest)/.test(q)) a = 'Busiest clinics in the last 30 days: ' + (f.top_clinics.filter((c) => c.bookings_30d).map((c) => `${c.name} (${c.bookings_30d})`).join(', ') || 'none yet') + '.';
    else if (/(no.?show|miss)/.test(q)) a = `${f.no_show.overall_percent}% of past visits were missed. With a reminder: ${f.no_show.reminded_percent}%. Without: ${f.no_show.not_reminded_percent}%.`;
    else if (/(revenue|mrr|money|income)/.test(q)) a = f.monthly_revenue === null ? 'Plan prices are not set. Add them in Settings and team.' : `Monthly revenue is ₹${f.monthly_revenue.toLocaleString('en-IN')}, with ₹${(f.revenue_at_risk || 0).toLocaleString('en-IN')} at risk.`;
    else if (/(quiet|inactive|churn|stopped|risk)/.test(q)) a = f.quiet.length || f.never_started.length ? `Stopped booking: ${f.quiet.map((c) => c.name).join(', ') || 'none'}. Not started: ${f.never_started.map((c) => c.name).join(', ') || 'none'}.` : 'No clinic has stopped booking.';
    res.json({ answer: a || 'I can answer a few questions without an AI key: busiest clinics, no-shows, revenue and clinics at risk. Add ANTHROPIC_API_KEY to ask anything.', ai: false });
  }));

  /* ---------- patients (phone numbers are masked; no medical text is stored anywhere) ---------- */
  app.get('/api/company/patients', wrap((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
    const rows = all(`SELECT substr(replace(replace(patient_phone,' ',''),'+',''), -10) AS ph, MAX(patient_name) AS name, COUNT(*) AS visits,
        SUM(CASE WHEN no_show = 1 THEN 1 ELSE 0 END) AS no_shows, COUNT(DISTINCT clinic_id) AS clinics, MAX(appointment_date) AS last_visit,
        SUM(CASE WHEN source = 'patient' THEN 1 ELSE 0 END) AS portal
      FROM appointments GROUP BY ph ORDER BY last_visit DESC`);
    const acc = new Set(all('SELECT phone FROM patients').map((r) => p10(r.phone)));
    let list = rows.map((r) => ({ id: sha(r.ph).slice(0, 10), name: r.name, phone: maskPhone(r.ph), visits: r.visits, no_shows: r.no_shows, clinics: r.clinics, last_visit: r.last_visit, portal: r.portal, account: acc.has(r.ph), _ph: r.ph }));
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q) || (/^\d+$/.test(q) && r._ph.includes(q)));
    const total = list.length;
    res.json({ total, repeat: list.filter((r) => r.visits > 1).length, with_account: list.filter((r) => r.account).length, patients: list.slice(0, 200).map(({ _ph, ...r }) => r) });
  }));

  /* ---------- patient portal ---------- */
  app.get('/api/company/portal', wrap((req, res) => {
    const d7 = dayOffset(-7), d30 = dayOffset(-30);
    const clinics = clinicStats(), act = clinics.filter((c) => c.status === 'active');
    const ev = (type, since) => one("SELECT COUNT(*) AS n FROM events WHERE type = ? AND date(created_at, 'localtime') >= ?", type, since).n;
    const a = one(`SELECT COUNT(*) AS total, SUM(CASE WHEN source = 'patient' THEN 1 ELSE 0 END) AS portal, SUM(CASE WHEN source = 'patient' AND status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN source = 'patient' AND status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN source = 'patient' AND date(created_at,'localtime') >= ? THEN 1 ELSE 0 END) AS d7 FROM appointments`, d7);
    const recent = all(`SELECT a.patient_name, a.appointment_date, a.appointment_time, a.visit_type, a.status, a.created_at, c.name AS clinic FROM appointments a JOIN clinics c ON c.id = a.clinic_id WHERE a.source = 'patient' ORDER BY a.id DESC LIMIT 10`)
      .map((r) => ({ who: shortName(r.patient_name), clinic: r.clinic, date: r.appointment_date, time: r.appointment_time, type: r.visit_type, status: r.status, booked: r.created_at }));
    res.json({
      listed: act.length, listing: { location: act.filter((c) => c.location).length, services: act.filter((c) => c.services).length, offer: act.filter((c) => c.offer).length },
      portal_bookings: a.portal || 0, portal_7d: a.d7 || 0, portal_share: pct(a.portal || 0, a.total || 0), pending: a.pending || 0, cancelled: a.cancelled || 0,
      accounts: one('SELECT COUNT(*) AS n FROM patients').n, accounts_30d: one("SELECT COUNT(*) AS n FROM patients WHERE date(created_at,'localtime') >= ?", d30).n,
      assistant: { week: ev('assist', d7) + ev('emergency', d7), month: ev('assist', d30) + ev('emergency', d30), emergencies_month: ev('emergency', d30), ai_on: aiOn() },
      top: clinics.filter((c) => c.portal).sort((x, y) => y.portal - x.portal).slice(0, 6).map((c) => ({ id: c.id, name: c.name, n: c.portal })),
      gaps: act.filter((c) => !c.location || !c.services).map((c) => ({ id: c.id, name: c.name, missing: [!c.location && 'location', !c.services && 'services'].filter(Boolean).join(' and ') })),
      recent,
    });
  }));

  /* ---------- system ---------- */
  app.get('/api/company/system', wrap((req, res) => {
    let dbSize = 0; try { dbSize = fs.statSync(DB_FILE).size; } catch {}
    const n = (t) => one(`SELECT COUNT(*) AS n FROM ${t}`).n;
    const now = Date.now();
    const logs = all("SELECT status AS k, COUNT(*) AS n FROM whatsapp_logs GROUP BY status");
    const last = one('SELECT MAX(sent_at) AS t FROM whatsapp_logs').t;
    res.json({
      server: { node: process.version, platform: `${os.platform()} ${os.arch()}`, uptime_s: Math.round(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1048576), db_mb: Math.round((dbSize / 1048576) * 100) / 100 },
      services: { whatsapp: waConnected(), ai: aiOn() },
      access: { company_remote: REMOTE_COMPANY, clinic_remote: String(process.env.STAFF_REMOTE || '').toLowerCase() === 'true' },
      counts: { clinics: n('clinics'), appointments: n('appointments'), patient_accounts: n('patients'), clinic_logins: n('staff_users'), company_logins: n('company_users'), reminders_logged: n('whatsapp_logs') },
      sessions: { patients: one('SELECT COUNT(*) AS n FROM patient_sessions WHERE expires_at > ?', now).n, clinic_staff: one('SELECT COUNT(*) AS n FROM staff_sessions WHERE expires_at > ?', now).n, company: one('SELECT COUNT(*) AS n FROM company_sessions WHERE expires_at > ?', now).n },
      whatsapp_log: logs, last_reminder: last,
      clinic_logins: all('SELECT u.username, u.name, u.role, u.created_at, c.name AS clinic FROM staff_users u LEFT JOIN clinics c ON c.id = u.clinic_id ORDER BY u.id'),
    });
  }));

  /* ---------- plan prices ---------- */
  app.get('/api/company/settings', wrap((req, res) => res.json({ prices: prices(), plans: PLANS })));
  app.put('/api/company/settings', adminOnly, wrap((req, res) => {
    const src = (req.body || {}).prices || {}, out = {};
    for (const p of PLANS) {
      if (src[p] === '' || src[p] === null || src[p] === undefined) continue;
      const v = Number(src[p]); if (!Number.isFinite(v) || v < 0 || v > 1000000) throw bad(`Enter a price for ${p} between 0 and 10,00,000.`);
      out[p] = Math.round(v);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('plan_prices', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(out));
    audit(req.co.username, 'Plan prices updated', Object.entries(out).map(([k, v]) => `${k} ${v}`).join(', ') || 'cleared');
    res.json({ prices: out });
  }));

  /* ---------- company team ---------- */
  app.get('/api/company/me', wrap((req, res) => res.json(req.co)));
  app.put('/api/company/password', wrap((req, res) => {
    throttle('copw:' + req.co.id, 6);
    const b = req.body || {}, row = one('SELECT * FROM company_users WHERE id = ?', req.co.id);
    if (!crypto.timingSafeEqual(Buffer.from(hashPw(String(b.current || ''), row.salt), 'hex'), Buffer.from(row.hash, 'hex'))) throw bad('Your current password is not right.', 401);
    setPassword(row.id, cleanPw(b.next, row.username));
    db.prepare('DELETE FROM company_sessions WHERE user_id = ? AND token_hash <> ?').run(row.id, sha(cookieOf(req, COOKIE)));
    audit(row.username, 'Changed own password');
    res.json({ message: 'Password changed' });
  }));
  app.get('/api/company/team', wrap((req, res) => res.json(all('SELECT id, username, name, role, created_at FROM company_users ORDER BY id'))));
  app.post('/api/company/team', adminOnly, wrap((req, res) => {
    const b = req.body || {}, username = cleanUser(b.username), name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw bad('Enter their name.');
    if (one('SELECT 1 FROM company_users WHERE username = ?', username)) throw bad('That username is taken.', 409);
    const role = b.role === 'admin' ? 'admin' : 'viewer', salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO company_users (username, name, role, salt, hash) VALUES (?, ?, ?, ?, ?)').run(username, name, role, salt, hashPw(cleanPw(b.password, username), salt));
    audit(req.co.username, 'Added team member', `${username} (${role})`);
    res.json({ message: 'Added' });
  }));
  app.put('/api/company/team/:id/password', adminOnly, wrap((req, res) => {
    const row = one('SELECT * FROM company_users WHERE id = ?', req.params.id);
    if (!row) throw bad('Team member not found', 404);
    setPassword(row.id, cleanPw((req.body || {}).password, row.username));
    db.prepare('DELETE FROM company_sessions WHERE user_id = ?').run(row.id);
    audit(req.co.username, 'Reset password', row.username);
    res.json({ message: 'Password reset' });
  }));
  app.delete('/api/company/team/:id', adminOnly, wrap((req, res) => {
    const row = one('SELECT * FROM company_users WHERE id = ?', req.params.id);
    if (!row) throw bad('Team member not found', 404);
    if (row.id === req.co.id) throw bad('You cannot remove your own login.');
    if (row.role === 'admin' && one("SELECT COUNT(*) AS n FROM company_users WHERE role = 'admin'").n < 2) throw bad('Keep at least one admin.');
    db.prepare('DELETE FROM company_sessions WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM company_users WHERE id = ?').run(row.id);
    audit(req.co.username, 'Removed team member', row.username);
    res.json({ message: 'Removed' });
  }));

  /* ---------- activity and export ---------- */
  app.get('/api/company/activity', wrap((req, res) => res.json(all('SELECT who, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 100'))));
  const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  app.get('/api/company/clinics.csv', wrap((req, res) => {
    const head = ['Clinic', 'Doctor', 'Location', 'Plan', 'Status', 'Joined', 'Bookings', 'Last 30 days', 'Portal bookings', 'No-show %'];
    const rows = clinicStats().map((c) => [c.name, c.doctor_name, c.location, c.plan, c.status, String(c.created_at || '').slice(0, 10), c.appts, c.appts_30d, c.portal, c.no_show_rate]);
    audit(req.co.username, 'Exported clinics CSV');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="baari-clinics.csv"' });
    res.send('﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n'));
  }));
};
