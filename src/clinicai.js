// Clinic side smart features: the automatic monthly report and the "ask your clinic" helper.
// Both work from built-in rules. If an AI key is set, the AI only receives totals (no patient names or numbers) and writes the wording.
module.exports = function mountClinicAI(ctx) {
  const { app, db, wrap, bad, ownerOnly, needClinic, localToday, askClaude, aiOn, riskContext, riskFor, ALIVE, p10 } = ctx;

  db.exec(`CREATE TABLE IF NOT EXISTS monthly_reports (clinic_id INTEGER NOT NULL, month TEXT NOT NULL, json TEXT NOT NULL, ai INTEGER DEFAULT 0, seen INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (clinic_id, month))`);

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const monthOk = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const label = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };
  const isoPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const clock = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
  const first = (name) => String(name || '').trim().split(/\s+/)[0];

  /* ---------- the numbers ---------- */
  function monthStats(clinicId, month) {
    const today = localToday();
    const all = db.prepare('SELECT * FROM appointments WHERE clinic_id = ?').all(clinicId);
    const firstSeen = new Map();
    for (const a of all) { const k = p10(a.patient_phone); if (!firstSeen.has(k) || a.appointment_date < firstSeen.get(k)) firstSeen.set(k, a.appointment_date); }
    const rows = all.filter((a) => a.appointment_date.slice(0, 7) === month);
    const noShow = (a) => a.no_show || a.status === 'no-show', cancelled = (a) => a.status === 'cancelled';
    const live = rows.filter((a) => !cancelled(a)), past = live.filter((a) => a.appointment_date < today);
    const s = { month, total: rows.length, cancelled: rows.filter(cancelled).length, confirmed: rows.filter((a) => a.confirmed).length, reminded: rows.filter((a) => a.whatsapp_sent).length,
      portal: rows.filter((a) => a.source === 'patient').length, expected: past.length, no_shows: past.filter(noShow).length };
    s.held = s.expected - s.no_shows; s.no_show_rate = pct(s.no_shows, s.expected);
    const phones = new Set(rows.map((a) => p10(a.patient_phone)));
    s.patients = phones.size; s.new_patients = [...phones].filter((k) => (firstSeen.get(k) || '').slice(0, 7) === month).length; s.returning_patients = s.patients - s.new_patients;
    s.by_type = {}; live.forEach((a) => { s.by_type[a.visit_type] = (s.by_type[a.visit_type] || 0) + 1; });
    s.by_weekday = [0, 0, 0, 0, 0, 0, 0]; const hours = {};
    live.forEach((a) => { const [y, m, d] = a.appointment_date.split('-').map(Number); s.by_weekday[new Date(y, m - 1, d).getDay()]++; const h = a.appointment_time.slice(0, 2); hours[h] = (hours[h] || 0) + 1; });
    const bh = Object.entries(hours).sort((x, y) => y[1] - x[1])[0]; s.busiest_hour = bh ? Number(bh[0]) : null;
    const rem = past.filter((a) => a.whatsapp_sent), no = past.filter((a) => !a.whatsapp_sent);
    s.reminder_effect = rem.length >= 5 && no.length >= 5 ? { reminded_rate: pct(rem.filter(noShow).length, rem.length), not_reminded_rate: pct(no.filter(noShow).length, no.length) } : null;
    return s;
  }
  const hourWord = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;

  function insightsFor(s, p) {
    const out = [];
    if (p.total > 0 && s.total > 0) { const ch = Math.round(((s.total - p.total) / p.total) * 100); out.push(`${s.total} bookings, ${ch === 0 ? 'the same as' : ch > 0 ? `${ch}% more than` : `${-ch}% fewer than`} last month (${p.total}).`); }
    else out.push(`${s.total} booking${s.total === 1 ? '' : 's'} this month.`);
    if (s.expected >= 5) {
      if (p.expected >= 5) { const d = Math.round((s.no_show_rate - p.no_show_rate) * 10) / 10; out.push(`${s.no_show_rate}% of patients did not come${d === 0 ? ', the same as last month' : d < 0 ? `, down from ${p.no_show_rate}% last month. Good progress` : `, up from ${p.no_show_rate}% last month`}.`); }
      else out.push(`${s.no_show_rate}% of patients did not come (${s.no_shows} of ${s.expected}).`);
    }
    if (s.reminder_effect) { const r = s.reminder_effect; out.push(r.reminded_rate < r.not_reminded_rate ? `Patients who got a reminder missed visits less often (${r.reminded_rate}% against ${r.not_reminded_rate}% without one).` : `Reminders did not clearly reduce missed visits this month (${r.reminded_rate}% with, ${r.not_reminded_rate}% without).`); }
    const top = s.by_weekday.reduce((m, n, i) => (n > s.by_weekday[m] ? i : m), 0);
    if (s.total >= 5 && s.by_weekday[top]) out.push(`${DAYS[top]} was your busiest day (${s.by_weekday[top]} visits)${s.busiest_hour !== null ? ` and ${hourWord(s.busiest_hour)} was the busiest hour` : ''}.`);
    if (s.total) out.push(`${s.portal} of ${s.total} bookings (${pct(s.portal, s.total)}%) came from your online booking link.`);
    if (s.patients >= 3) out.push(`${s.new_patients} new and ${s.returning_patients} returning patient${s.returning_patients === 1 ? '' : 's'}.`);
    return out.slice(0, 6);
  }
  function tipsFor(s) {
    const t = [];
    if (s.expected >= 5 && s.no_show_rate >= 15) t.push('Ask patients to confirm the day before, and call the ones who do not reply.');
    if (s.total >= 5 && pct(s.reminded, s.total) < 60) t.push(`Only ${pct(s.reminded, s.total)}% of bookings got a reminder. Turn on WhatsApp reminders so every booking gets one.`);
    if (s.total >= 5 && pct(s.portal, s.total) < 20) t.push('Put your booking link on WhatsApp status, Google Maps and the front desk so patients can book by themselves.');
    const live = s.by_weekday.map((n, i) => [n, i]).filter((x) => x[0] > 0).sort((a, b) => a[0] - b[0]);
    if (s.total >= 10 && live.length >= 3) t.push(`${DAYS[live[0][1]]} is your quietest day. Offer it to patients first, or run an offer for that day.`);
    if (s.patients >= 5 && pct(s.new_patients, s.patients) < 20) t.push('Few new patients came. Add an offer such as "First consultation free" to your clinic listing so you stand out on the booking page.');
    if (!t.length) t.push('Keep going. Review this report next month to see what changed.');
    return t.slice(0, 4);
  }
  const summaryRule = (clinic, s, ins) => `${clinic.name} had ${s.total} booking${s.total === 1 ? '' : 's'} in ${label(s.month)}. ` + ins.slice(1, 4).join(' ');

  async function build(clinic, month, { ai, partial }) {
    const s = monthStats(clinic.id, month), p = monthStats(clinic.id, prevMonth(month));
    const insights = insightsFor(s, p);
    let tips = tipsFor(s), summary = summaryRule(clinic, s, insights), usedAi = false;
    if (ai && aiOn() && s.total > 0) {
      const slim = (x) => ({ bookings: x.total, held_visits: x.held, no_show_rate_percent: x.no_show_rate, cancelled: x.cancelled, reminders_sent: x.reminded, from_booking_link: x.portal, new_patients: x.new_patients, returning_patients: x.returning_patients, busiest_weekday: DAYS[x.by_weekday.reduce((m, n, i) => (n > x.by_weekday[m] ? i : m), 0)], reminder_effect: x.reminder_effect });
      const out = await askClaude('You write a short monthly summary for the owner of a small clinic in India. Use only the numbers you are given and never invent numbers. No medical advice. Plain, warm words. Reply with JSON only: {"summary":"4 or 5 sentences","tips":["3 short practical suggestions for next month"]}.',
        JSON.stringify({ clinic: clinic.name, month: label(month), this_month: slim(s), last_month: slim(p) }), 500);
      let j = null; try { j = JSON.parse((out || '').match(/\{[\s\S]*\}/)[0]); } catch {}
      if (j && typeof j.summary === 'string' && j.summary.trim() && Array.isArray(j.tips) && j.tips.filter((x) => typeof x === 'string').length) {
        summary = j.summary.trim().slice(0, 900); tips = j.tips.filter((x) => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 200)); usedAi = true;
      }
    }
    return { month, month_label: label(month), clinic: { id: clinic.id, name: clinic.name }, stats: s, previous: { total: p.total, no_show_rate: p.no_show_rate, portal: p.portal, new_patients: p.new_patients, expected: p.expected }, insights, tips, summary, ai: usedAi, partial: Boolean(partial), generated_at: new Date().toISOString() };
  }
  const store = (r) => db.prepare('INSERT INTO monthly_reports (clinic_id, month, json, ai, seen) VALUES (?, ?, ?, ?, 0) ON CONFLICT(clinic_id, month) DO UPDATE SET json = excluded.json, ai = excluded.ai, seen = 0, created_at = CURRENT_TIMESTAMP').run(r.clinic.id, r.month, JSON.stringify(r), r.ai ? 1 : 0);

  app.get('/api/clinics/:id/monthly-report', ownerOnly, wrap(async (req, res) => {
    needClinic(req, req.params.id);
    const clinic = db.prepare('SELECT id, name FROM clinics WHERE id = ?').get(req.params.id);
    if (!clinic) throw bad('Clinic not found', 404);
    const cur = localToday().slice(0, 7), month = monthOk(req.query.month) ? req.query.month : cur;
    if (month > cur) throw bad('That month has not started yet.');
    if (month === cur) return res.json(await build(clinic, month, { ai: false, partial: true }));
    let row = db.prepare('SELECT json FROM monthly_reports WHERE clinic_id = ? AND month = ?').get(clinic.id, month), report;
    if (!row || req.query.refresh === '1') { report = await build(clinic, month, { ai: true }); store(report); } else report = JSON.parse(row.json);
    db.prepare('UPDATE monthly_reports SET seen = 1 WHERE clinic_id = ? AND month = ?').run(clinic.id, month);
    res.json(report);
  }));
  app.get('/api/clinics/:id/monthly-reports', ownerOnly, wrap((req, res) => {
    needClinic(req, req.params.id);
    const rows = db.prepare('SELECT month, seen, ai, created_at FROM monthly_reports WHERE clinic_id = ? ORDER BY month DESC LIMIT 24').all(req.params.id);
    res.json({ reports: rows.map((r) => ({ month: r.month, label: label(r.month), seen: Boolean(r.seen), ai: Boolean(r.ai), created_at: r.created_at })), unseen: rows.filter((r) => !r.seen).map((r) => ({ month: r.month, label: label(r.month) }))[0] || null });
  }));

  /* a new report is written for every clinic on the first run after the month ends */
  async function writeDue() {
    const prev = prevMonth(localToday().slice(0, 7));
    for (const c of db.prepare('SELECT id, name FROM clinics').all()) {
      try {
        if (db.prepare('SELECT 1 FROM monthly_reports WHERE clinic_id = ? AND month = ?').get(c.id, prev)) continue;
        if (!db.prepare('SELECT 1 FROM appointments WHERE clinic_id = ? AND appointment_date LIKE ?').get(c.id, prev + '-%')) continue;
        store(await build(c, prev, { ai: true })); console.log(`Monthly report written for ${c.name} (${prev})`);
      } catch (e) { console.warn('Monthly report failed for', c.name + ':', e.message); }
    }
  }
  setTimeout(() => writeDue().catch(() => {}), 10000);
  setInterval(() => writeDue().catch(() => {}), 6 * 3600 * 1000);

  /* ---------- ask your clinic ---------- */
  const rowsFor = (cid, date) => db.prepare(`SELECT * FROM appointments WHERE clinic_id = ? AND appointment_date = ? AND ${ALIVE} ORDER BY appointment_time`).all(cid, date);
  const HELP = 'You can ask things like: "Who might miss today?", "Tomorrow\'s bookings", "Who has not confirmed?", "Free slots today", "No-shows this month" or "Which day is busiest?".';

  app.post('/api/clinics/:id/ask', wrap(async (req, res) => {
    needClinic(req, req.params.id);
    const clinic = db.prepare('SELECT id, name FROM clinics WHERE id = ?').get(req.params.id);
    if (!clinic) throw bad('Clinic not found', 404);
    ctx.throttle('ask:' + req.staff.id, 40);
    const text = String((req.body || {}).question || '').trim().slice(0, 300);
    if (text.length < 3) throw bad('Type a question first.');
    const q = text.toLowerCase(), cid = clinic.id, today = localToday(), tomorrow = isoPlus(1);
    const wantsTomorrow = /tomorrow|\bkal\b/.test(q), day = wantsTomorrow ? tomorrow : today, dayName = wantsTomorrow ? 'tomorrow' : 'today';
    const hist = riskContext(cid);
    const list = (rs) => rs.slice(0, 10).map((a) => `${clock(a.appointment_time)} ${a.patient_name}`).join(', ');
    let answer = null;
    if (/(miss|risk|no.?show|skip|likely|not come|won'?t come)/.test(q) && !/month/.test(q)) {
      const risky = rowsFor(cid, day).map((a) => ({ a, r: riskFor(a, hist) })).filter((x) => x.r.level !== 'low').sort((x, y) => y.r.score - x.r.score);
      answer = risky.length ? `${risky.length} booking${risky.length === 1 ? '' : 's'} ${dayName} may be missed: ` + risky.slice(0, 6).map((x) => `${x.a.patient_name} at ${clock(x.a.appointment_time)} (${x.r.level === 'high' ? 'likely to miss' : 'might miss'}: ${x.r.reasons.join(', ') || 'visit history'})`).join('; ') + '. Sending a reminder now helps.' : `No booking ${dayName} looks likely to be missed.`;
    } else if (/(unconfirm|not confirm|yet to confirm|haven'?t confirm|confirm)/.test(q)) {
      const d = /today|\baaj\b/.test(q) ? today : tomorrow, nm = d === today ? 'today' : 'tomorrow', un = rowsFor(cid, d).filter((a) => !a.confirmed);
      answer = un.length ? `${un.length} booking${un.length === 1 ? '' : 's'} ${nm} not confirmed yet: ${list(un)}. Use "Send reminder" in the WhatsApp tab.` : `Every booking ${nm} is confirmed.`;
    } else if (/(free|gap|open slot|available|empty|vacant)/.test(q)) {
      const taken = new Set(rowsFor(cid, day).map((a) => a.appointment_time)), free = [];
      const nowD = new Date(), nowMin = nowD.getHours() * 60 + nowD.getMinutes();
      for (let h = 9; h < 17; h++) for (const m of [0, 30]) { const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; if (!taken.has(t) && !(day === today && h * 60 + m < nowMin)) free.push(clock(t)); }
      answer = free.length ? `${free.length} free slot${free.length === 1 ? '' : 's'} ${dayName}: ${free.slice(0, 12).join(', ')}${free.length > 12 ? ' and more' : ''}.` : `${dayName[0].toUpperCase() + dayName.slice(1)} is fully booked.`;
    } else if (/month/.test(q)) {
      const s = monthStats(cid, today.slice(0, 7));
      answer = `${label(s.month)} so far: ${s.total} bookings, ${s.cancelled} cancelled, ${s.no_shows} patient${s.no_shows === 1 ? '' : 's'} did not come${s.expected ? ` (${s.no_show_rate}% of ${s.expected} past visits)` : ''}, ${s.reminded} reminders sent, ${s.portal} from your booking link.`;
    } else if (/(busiest|busy|peak|quiet|slow)/.test(q)) {
      const s = monthStats(cid, today.slice(0, 7)), p = monthStats(cid, prevMonth(today.slice(0, 7)));
      const w = s.by_weekday.map((n, i) => n + p.by_weekday[i]), tot = w.reduce((a, b) => a + b, 0);
      answer = tot >= 5 ? `Over this and last month, ${DAYS[w.indexOf(Math.max(...w))]} is your busiest day and ${DAYS[w.indexOf(Math.min(...w))]} the quietest.` : 'Not enough bookings yet to tell which day is busiest.';
    } else if (/(how many|count|appointment|booking|patient|schedule|list|who|today|tomorrow|\baaj\b|\bkal\b)/.test(q)) {
      const rs = rowsFor(cid, day);
      answer = rs.length ? `${rs.length} booking${rs.length === 1 ? '' : 's'} ${dayName}, ${rs.filter((a) => a.confirmed).length} confirmed: ${list(rs)}${rs.length > 10 ? ' and more' : ''}.` : `No bookings ${dayName}.`;
    }
    if (answer) return res.json({ answer, ai: false });
    if (!aiOn()) return res.json({ answer: HELP, ai: false });
    const ctxOf = (d) => { const rs = rowsFor(cid, d); return { bookings: rs.length, confirmed: rs.filter((a) => a.confirmed).length, likely_to_miss: rs.filter((a) => riskFor(a, hist).level === 'high').length }; };
    const s = monthStats(cid, today.slice(0, 7));
    const out = await askClaude('You help the manager of a small clinic in India understand the clinic\'s numbers. Answer ONLY from the data given. If the data does not contain the answer, say so briefly and suggest what you can answer. No medical advice. Plain words, at most 70 words, no markdown.',
      `Data: ${JSON.stringify({ today: ctxOf(today), tomorrow: ctxOf(tomorrow), this_month: { bookings: s.total, cancelled: s.cancelled, no_shows: s.no_shows, no_show_rate_percent: s.no_show_rate, reminders_sent: s.reminded, from_booking_link: s.portal, new_patients: s.new_patients } })}\n\nQuestion: ${text}`, 250);
    res.json({ answer: out ? out.slice(0, 600) : HELP, ai: Boolean(out) });
  }));
};
