// Customer Reactivation System — backend multi-negocio (Node 18+, sin dependencias). Ejecuta: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }); } catch (e) {}
const E = process.env, PORT = E.PORT || 3000, DATA = path.join(__dirname, 'data'), GRAPH = 'https://graph.facebook.com/v21.0';
fs.mkdirSync(DATA, { recursive: true });
const RK = { Contactado: 1, Respondió: 2, 'No interesado': 2, Interesado: 3, 'Cita agendada': 4, Reactivado: 5 };
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } };
let U = rd('users.json', { users: {}, sess: {} }), T = {};            // T[tid] = { s: estado del negocio, wa: credenciales (nunca salen al navegador) }
fs.readdirSync(DATA).filter(f => /^[0-9a-f]{12}\.json$/.test(f)).forEach(f => T[f.slice(0, -5)] = rd(f, null));
const saveU = () => fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify(U));
const saveT = tid => fs.writeFileSync(path.join(DATA, tid + '.json'), JSON.stringify(T[tid]));   // Para escalar: Postgres con tenant_id
const persist = tid => { T[tid].s.v = (T[tid].s.v || 0) + 1; saveT(tid); };
const digits = p => String(p || '').replace(/\D/g, ''), hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

// ---------- WhatsApp Cloud API (credenciales por negocio; sin ellas, modo demo) ----------
// OJO: el primer mensaje de una campaña debe ser una plantilla aprobada por Meta (fuera de la ventana de 24 h).
async function waSend(t, to, text) {
  const tok = t.wa.token || E.WA_TOKEN, pid = t.wa.phoneId || E.WA_PHONE_ID;
  if (!tok || !pid) return { id: 'demo-' + Date.now(), demo: true };
  const r = await fetch(`${GRAPH}/${pid}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return { id: j.messages[0].id };
}
async function claude(system, user, max = 300) {
  if (!E.ANTHROPIC_API_KEY) return null;
  try { const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: E.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: max, system, messages: [{ role: 'user', content: user }] }) });
    const j = await r.json(); return j.content?.[0]?.text?.trim() || null; } catch (e) { return null; }
}
const TIME = /mañana|hoy|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|\d{1,2}(:\d\d)?\s*(am|pm|hrs|h)\b/;
const YES = ['sí', 'si', 'claro', 'quiero', 'interesa', 'cuánto', 'cuanto', 'precio', 'info', 'promo', 'ok', 'dale', 'cuéntame', 'cuentame'];
function decide(S, c, t) {   // el estado lo decide el código; la IA solo redacta
  const l = t.toLowerCase(), w = l.replace(/[¡!¿?.,]/g, ' ').split(/\s+/), f = c.name.split(' ')[0];
  const promo = (S.camp || []).find(k => k.sent.includes(c.id))?.promo || 'una oferta especial';
  if (w.includes('baja') || w.includes('stop') || /no me interesa|no gracias|no quiero/.test(l)) { c.status = 'No interesado'; c.result = 'No interesado'; c.consent = false; c.optout = true; return ['Entendido, no volverás a recibir mensajes comerciales. ¡Gracias!', null]; }
  if (c.status === 'Interesado' && TIME.test(l)) { c.status = 'Cita agendada'; c.appt = t; c.result = 'Cita: ' + t; return [`¡Listo ${f}! Agendé tu cita: "${t}". Te esperamos 🙌`, 'Cita agendada → ' + t]; }
  if (w.some(x => YES.includes(x))) { c.status = 'Interesado'; c.result = 'Interesado'; return [`¡Excelente ${f}! La promoción sigue vigente: ${promo}. ¿Qué día y hora te acomodan?`, 'Lead interesado, pendiente de agendar']; }
  return [`Gracias por responder, ${f}. ¿Te cuento la promoción para antiguos clientes? Responde SÍ, o BAJA para no recibir más mensajes.`, null];
}
async function handleIncoming(tid, c, text) {
  const t = T[tid], S = t.s; let [reply, notice] = decide(S, c, text);
  const hist = S.m.filter(m => m.c === c.id).slice(-8).map(m => (m.d === 'o' ? 'Negocio: ' : 'Cliente: ') + m.t).join('\n');
  reply = (await claude(`Eres asistente de ventas de ${S.cfg?.biz || 'un negocio'} por WhatsApp. Reescribe el mensaje base en español, breve, cálido y natural (máx. 2 frases). No inventes precios ni promociones. Conserva su intención y cualquier instrucción como "responde BAJA".`, `Historial:\n${hist}\n\nMensaje base: ${reply}`)) || reply;
  const r = await waSend(t, c.phone, reply).catch(e => (console.error(e.message), null));
  if (r) S.m.push({ c: c.id, d: 'o', t: reply, ts: Date.now(), s: 'enviado', wamid: r.id });
  if (notice) S.n.unshift({ ts: Date.now(), t: c.name + ': ' + notice });   // aquí: email/Slack al vendedor
  persist(tid);
}
function inbound(body) {
  const ids = Object.keys(T);
  for (const en of body.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {}, pid = v.metadata?.phone_number_id;
    const tid = ids.find(k => T[k].wa.phoneId === pid) || ((!pid || pid === E.WA_PHONE_ID) && ids.length === 1 ? ids[0] : null); if (!tid) continue;
    const S = T[tid].s;
    for (const s of v.statuses || []) { const m = S.m.find(x => x.wamid === s.id); if (m) m.s = s.status === 'read' ? 'leído' : s.status === 'delivered' ? 'entregado' : m.s; }
    for (const msg of v.messages || []) {
      const c = S.c.find(x => digits(x.phone).slice(-10) === digits(msg.from).slice(-10)); if (!c) continue;
      const text = msg.text?.body || '[mensaje no textual]'; S.m.push({ c: c.id, d: 'i', t: text, ts: Date.now() });
      if ((RK[c.status] || 0) < 2) c.status = 'Respondió';
      persist(tid); if (S.cfg?.auto !== false) handleIncoming(tid, c, text);
    }
    persist(tid);
  }
}

// ---------- HTTP ----------
const readBody = (req, max = 15e6) => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { no(new Error('Cuerpo demasiado grande')); req.destroy(); } }); req.on('end', () => ok(d)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), send = (code, o, t = 'application/json') => { res.writeHead(code, { 'Content-Type': t }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (u.pathname === '/webhook') {
      if (req.method === 'GET') return E.WA_VERIFY_TOKEN && u.searchParams.get('hub.verify_token') === E.WA_VERIFY_TOKEN ? send(200, u.searchParams.get('hub.challenge'), 'text/plain') : send(403, 'forbidden', 'text/plain');
      const raw = await readBody(req);
      if (E.WA_APP_SECRET && 'sha256=' + crypto.createHmac('sha256', E.WA_APP_SECRET).update(raw).digest('hex') !== req.headers['x-hub-signature-256']) return send(401, 'bad signature', 'text/plain');
      send(200, 'ok', 'text/plain'); try { inbound(JSON.parse(raw)); } catch (e) { console.error(e); } return;
    }
    if (u.pathname === '/api/auth/register' || u.pathname === '/api/auth/login') {
      const b = JSON.parse(await readBody(req)), em = String(b.email || '').trim().toLowerCase(), reg = u.pathname.endsWith('register');
      let tid;
      if (reg) {
        if (!/^\S+@\S+\.\S+$/.test(em) || String(b.password || '').length < 8) return send(400, { error: 'Email válido y contraseña de 8+ caracteres' });
        if (U.users[em]) return send(409, { error: 'Ese email ya tiene cuenta' });
        const salt = crypto.randomBytes(16).toString('hex'); tid = crypto.randomBytes(6).toString('hex');
        U.users[em] = { salt, hash: hash(b.password, salt), tid };
        T[tid] = { s: { cfg: { biz: b.biz || 'Mi negocio', days: 90, auto: true }, c: [], m: [], n: [], camp: [], v: 1 }, wa: {} }; saveT(tid);
      } else {
        const x = U.users[em]; if (!x || !crypto.timingSafeEqual(Buffer.from(hash(String(b.password || ''), x.salt)), Buffer.from(x.hash))) return send(401, { error: 'Email o contraseña incorrectos' });
      }
      const token = crypto.randomBytes(24).toString('hex'); U.sess[token] = { email: em, exp: Date.now() + 30 * 864e5 }; saveU(); return send(200, { token });
    }
    if (u.pathname.startsWith('/api/')) {
      const ss = U.sess[(req.headers.authorization || '').slice(7)], x = ss && ss.exp > Date.now() && U.users[ss.email];
      if (!x) return send(401, { error: 'Sesión requerida' });
      const tid = x.tid, t = T[tid];
      if (u.pathname === '/api/state') {
        if (req.method === 'GET') return send(200, t.s);
        const b = JSON.parse(await readBody(req)); if ((t.s.v || 0) !== (b.v || 0)) return send(409, t.s); t.s = b; persist(tid); return send(200, { v: t.s.v });
      }
      if (u.pathname === '/api/wa/config') {
        if (req.method === 'GET') return send(200, { phoneId: t.wa.phoneId || '', hasToken: !!t.wa.token });
        const b = JSON.parse(await readBody(req)); t.wa = { phoneId: String(b.phoneId || '').trim(), token: String(b.token || '').trim() || t.wa.token }; saveT(tid); return send(200, { ok: true });
      }
      if (u.pathname === '/api/wa/send' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req)), c = t.s.c.find(k => digits(k.phone) === digits(b.to));
        if (c && !c.consent && !b.force) return send(403, { error: 'Cliente sin consentimiento de WhatsApp' });
        return send(200, await waSend(t, b.to, b.text));
      }
      if (u.pathname === '/api/ai/message' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        return send(200, { text: await claude('Redactas mensajes de WhatsApp para reactivar clientes inactivos. Español, 2-3 frases, tono cercano, 1 emoji máximo. Usa exactamente estos marcadores: {nombre} {servicio} {tiempo} {negocio} {promo}. No inventes datos. Devuelve solo el mensaje.', `Negocio: ${b.biz}. Servicio: ${b.service || 'cualquiera'}. Promoción: ${b.promo}.`) });
      }
    }
    send(404, { error: 'not found' });
  } catch (e) { console.error(e); send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`CRS multi-negocio en http://localhost:${PORT} · IA: ${E.ANTHROPIC_API_KEY ? 'Claude' : 'reglas'}`));






























































































































































































































































































































































































"),
"path":"server.js","content":"// Customer Reactivation System — backend multi-negocio (Node 18+, sin dependencias). Ejecuta: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }); } catch (e) {}
const E = process.env, PORT = E.PORT || 3000, DATA = path.join(__dirname, 'data'), GRAPH = 'https://graph.facebook.com/v21.0';
fs.mkdirSync(DATA, { recursive: true });
const RK = { Contactado: 1, Respondió: 2, 'No interesado': 2, Interesado: 3, 'Cita agendada': 4, Reactivado: 5 };
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } };
let U = rd('users.json', { users: {}, sess: {} }), T = {};            // T[tid] = { s: estado del negocio, wa: credenciales (nunca salen al navegador) }
fs.readdirSync(DATA).filter(f => /^[0-9a-f]{12}\.json$/.test(f)).forEach(f => T[f.slice(0, -5)] = rd(f, null));
const saveU = () => fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify(U));
const saveT = tid => fs.writeFileSync(path.join(DATA, tid + '.json'), JSON.stringify(T[tid]));   // Para escalar: Postgres con tenant_id
const persist = tid => { T[tid].s.v = (T[tid].s.v || 0) + 1; saveT(tid); };
const digits = p => String(p || '').replace(/\D/g, ''), hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

// ---------- WhatsApp Cloud API (credenciales por negocio; sin ellas, modo demo) ----------
// OJO: el primer mensaje de una campaña debe ser una plantilla aprobada por Meta (fuera de la ventana de 24 h).
async function waSend(t, to, text) {
  const tok = t.wa.token || E.WA_TOKEN, pid = t.wa.phoneId || E.WA_PHONE_ID;
  if (!tok || !pid) return { id: 'demo-' + Date.now(), demo: true };
  const r = await fetch(`${GRAPH}/${pid}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return { id: j.messages[0].id };
}
async function claude(system, user, max = 300) {
  if (!E.ANTHROPIC_API_KEY) return null;
  try { const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: E.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: max, system, messages: [{ role: 'user', content: user }] }) });
    const j = await r.json(); return j.content?.[0]?.text?.trim() || null; } catch (e) { return null; }
}
const TIME = /mañana|hoy|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|\d{1,2}(:\d\d)?\s*(am|pm|hrs|h)\b/;
const YES = ['sí', 'si', 'claro', 'quiero', 'interesa', 'cuánto', 'cuanto', 'precio', 'info', 'promo', 'ok', 'dale', 'cuéntame', 'cuentame'];
function decide(S, c, t) {   // el estado lo decide el código; la IA solo redacta
  const l = t.toLowerCase(), w = l.replace(/[¡!¿?.,]/g, ' ').split(/\s+/), f = c.name.split(' ')[0];
  const promo = (S.camp || []).find(k => k.sent.includes(c.id))?.promo || 'una oferta especial';
  if (w.includes('baja') || w.includes('stop') || /no me interesa|no gracias|no quiero/.test(l)) { c.status = 'No interesado'; c.result = 'No interesado'; c.consent = false; c.optout = true; return ['Entendido, no volverás a recibir mensajes comerciales. ¡Gracias!', null]; }
  if (c.status === 'Interesado' && TIME.test(l)) { c.status = 'Cita agendada'; c.appt = t; c.result = 'Cita: ' + t; return [`¡Listo ${f}! Agendé tu cita: "${t}". Te esperamos 🙌`, 'Cita agendada → ' + t]; }
  if (w.some(x => YES.includes(x))) { c.status = 'Interesado'; c.result = 'Interesado'; return [`¡Excelente ${f}! La promoción sigue vigente: ${promo}. ¿Qué día y hora te acomodan?`, 'Lead interesado, pendiente de agendar']; }
  return [`Gracias por responder, ${f}. ¿Te cuento la promoción para antiguos clientes? Responde SÍ, o BAJA para no recibir más mensajes.`, null];
}
async function handleIncoming(tid, c, text) {
  const t = T[tid], S = t.s; let [reply, notice] = decide(S, c, text);
  const hist = S.m.filter(m => m.c === c.id).slice(-8).map(m => (m.d === 'o' ? 'Negocio: ' : 'Cliente: ') + m.t).join('\n');
  reply = (await claude(`Eres asistente de ventas de ${S.cfg?.biz || 'un negocio'} por WhatsApp. Reescribe el mensaje base en español, breve, cálido y natural (máx. 2 frases). No inventes precios ni promociones. Conserva su intención y cualquier instrucción como "responde BAJA".`, `Historial:\n${hist}\n\nMensaje base: ${reply}`)) || reply;
  const r = await waSend(t, c.phone, reply).catch(e => (console.error(e.message), null));
  if (r) S.m.push({ c: c.id, d: 'o', t: reply, ts: Date.now(), s: 'enviado', wamid: r.id });
  if (notice) S.n.unshift({ ts: Date.now(), t: c.name + ': ' + notice });   // aquí: email/Slack al vendedor
  persist(tid);
}
function inbound(body) {
  const ids = Object.keys(T);
  for (const en of body.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {}, pid = v.metadata?.phone_number_id;
    const tid = ids.find(k => T[k].wa.phoneId === pid) || ((!pid || pid === E.WA_PHONE_ID) && ids.length === 1 ? ids[0] : null); if (!tid) continue;
    const S = T[tid].s;
    for (const s of v.statuses || []) { const m = S.m.find(x => x.wamid === s.id); if (m) m.s = s.status === 'read' ? 'leído' : s.status === 'delivered' ? 'entregado' : m.s; }
    for (const msg of v.messages || []) {
      const c = S.c.find(x => digits(x.phone).slice(-10) === digits(msg.from).slice(-10)); if (!c) continue;
      const text = msg.text?.body || '[mensaje no textual]'; S.m.push({ c: c.id, d: 'i', t: text, ts: Date.now() });
      if ((RK[c.status] || 0) < 2) c.status = 'Respondió';
      persist(tid); if (S.cfg?.auto !== false) handleIncoming(tid, c, text);
    }
    persist(tid);
  }
}

// ---------- HTTP ----------
const readBody = (req, max = 15e6) => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { no(new Error('Cuerpo demasiado grande')); req.destroy(); } }); req.on('end', () => ok(d)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), send = (code, o, t = 'application/json') => { res.writeHead(code, { 'Content-Type': t }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (u.pathname === '/webhook') {
      if (req.method === 'GET') return E.WA_VERIFY_TOKEN && u.searchParams.get('hub.verify_token') === E.WA_VERIFY_TOKEN ? send(200, u.searchParams.get('hub.challenge'), 'text/plain') : send(403, 'forbidden', 'text/plain');
      const raw = await readBody(req);
      if (E.WA_APP_SECRET && 'sha256=' + crypto.createHmac('sha256', E.WA_APP_SECRET).update(raw).digest('hex') !== req.headers['x-hub-signature-256']) return send(401, 'bad signature', 'text/plain');
      send(200, 'ok', 'text/plain'); try { inbound(JSON.parse(raw)); } catch (e) { console.error(e); } return;
    }
    if (u.pathname === '/api/auth/register' || u.pathname === '/api/auth/login') {
      const b = JSON.parse(await readBody(req)), em = String(b.email || '').trim().toLowerCase(), reg = u.pathname.endsWith('register');
      let tid;
      if (reg) {
        if (!/^\S+@\S+\.\S+$/.test(em) || String(b.password || '').length < 8) return send(400, { error: 'Email válido y contraseña de 8+ caracteres' });
        if (U.users[em]) return send(409, { error: 'Ese email ya tiene cuenta' });
        const salt = crypto.randomBytes(16).toString('hex'); tid = crypto.randomBytes(6).toString('hex');
        U.users[em] = { salt, hash: hash(b.password, salt), tid };
        T[tid] = { s: { cfg: { biz: b.biz || 'Mi negocio', days: 90, auto: true }, c: [], m: [], n: [], camp: [], v: 1 }, wa: {} }; saveT(tid);
      } else {
        const x = U.users[em]; if (!x || !crypto.timingSafeEqual(Buffer.from(hash(String(b.password || ''), x.salt)), Buffer.from(x.hash))) return send(401, { error: 'Email o contraseña incorrectos' });
      }
      const token = crypto.randomBytes(24).toString('hex'); U.sess[token] = { email: em, exp: Date.now() + 30 * 864e5 }; saveU(); return send(200, { token });
    }
    if (u.pathname.startsWith('/api/')) {
      const ss = U.sess[(req.headers.authorization || '').slice(7)], x = ss && ss.exp > Date.now() && U.users[ss.email];
      if (!x) return send(401, { error: 'Sesión requerida' });
      const tid = x.tid, t = T[tid];
      if (u.pathname === '/api/state') {
        if (req.method === 'GET') return send(200, t.s);
        const b = JSON.parse(await readBody(req)); if ((t.s.v || 0) !== (b.v || 0)) return send(409, t.s); t.s = b; persist(tid); return send(200, { v: t.s.v });
      }
      if (u.pathname === '/api/wa/config') {
        if (req.method === 'GET') return send(200, { phoneId: t.wa.phoneId || '', hasToken: !!t.wa.token });
        const b = JSON.parse(await readBody(req)); t.wa = { phoneId: String(b.phoneId || '').trim(), token: String(b.token || '').trim() || t.wa.token }; saveT(tid); return send(200, { ok: true });
      }
      if (u.pathname === '/api/wa/send' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req)), c = t.s.c.find(k => digits(k.phone) === digits(b.to));
        if (c && !c.consent && !b.force) return send(403, { error: 'Cliente sin consentimiento de WhatsApp' });
        return send(200, await waSend(t, b.to, b.text));
      }
      if (u.pathname === '/api/ai/message' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        return send(200, { text: await claude('Redactas mensajes de WhatsApp para reactivar clientes inactivos. Español, 2-3 frases, tono cercano, 1 emoji máximo. Usa exactamente estos marcadores: {nombre} {servicio} {tiempo} {negocio} {promo}. No inventes datos. Devuelve solo el mensaje.', `Negocio: ${b.biz}. Servicio: ${b.service || 'cualquiera'}. Promoción: ${b.promo}.`) });
      }
    }
    send(404, { error: 'not found' });
  } catch (e) { console.error(e); send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`CRS multi-negocio en http://localhost:${PORT} · IA: ${E.ANTHROPIC_API_KEY ? 'Claude' : 'reglas'}`));
"}
,{"path":"index.html","content":"<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Customer Reactivation System</title>
<style>
:root{--bg:#f6f7f9;--c:#fff;--t:#111827;--m:#6b7280;--b:#e5e7eb;--p:#4f46e5}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--t);display:flex;min-height:100vh}
nav{width:210px;background:#111827;color:#cbd5e1;padding:18px 12px;flex-shrink:0}nav b{display:block;color:#fff;font-size:15px;margin:0 8px 18px}
nav a{display:block;padding:9px 12px;border-radius:8px;cursor:pointer;margin-bottom:2px}nav a.on,nav a:hover{background:#1f2937;color:#fff}
main{flex:1;padding:24px;min-width:0}h1{font-size:20px;margin:0 0 16px}h3{margin:0 0 10px;font-size:14px}
.g{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));margin-bottom:16px}.card{background:var(--c);border:1px solid var(--b);border-radius:12px;padding:16px;margin-bottom:12px}
.g .card{margin:0}.k{font-size:24px;font-weight:650}.m{color:var(--m);font-size:12px}
button,input,select,textarea{font:inherit;padding:7px 10px;border:1px solid var(--b);border-radius:8px;background:#fff;color:var(--t)}button{cursor:pointer}.p{background:var(--p);color:#fff;border-color:var(--p)}
table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:8px 10px;border-bottom:1px solid var(--b);text-align:left;white-space:nowrap;font-size:13px}th{color:var(--m);font-weight:500;background:#fafafa}
.w{overflow-x:auto;border:1px solid var(--b);border-radius:12px}.tag{padding:2px 8px;border-radius:99px;background:#eef2ff;color:#4338ca;font-size:12px}
.row{display:flex;align-items:center;gap:10px;margin:6px 0}.row span{width:130px;font-size:13px}.bar{height:22px;background:var(--p);border-radius:6px;color:#fff;padding:0 8px;font-size:12px;line-height:22px;min-width:26px}
.tb{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}.sp{flex:1}
.in{display:grid;grid-template-columns:300px 1fr;height:calc(100vh - 110px);padding:0;overflow:hidden}.l{overflow:auto;border-right:1px solid var(--b)}.l div{padding:10px 14px;border-bottom:1px solid var(--b);cursor:pointer}.l .on{background:#eef2ff}
.r{display:flex;flex-direction:column;min-height:0}.hd{padding:12px 14px;border-bottom:1px solid var(--b)}.th{overflow:auto;flex:1;padding:14px;display:flex;flex-direction:column;gap:6px;background:#f3f4f6}
.bb{max-width:70%;padding:8px 12px;border-radius:12px;background:#fff}.bb.o{align-self:flex-end;background:#dcfce7}.bb small{display:block;color:var(--m);font-size:11px}
.cm{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--b)}.cm input{flex:1}
dialog{border:0;border-radius:14px;padding:20px;width:min(480px,94vw)}dialog label{display:block;margin:8px 0 2px;font-size:12px;color:var(--m)}dialog input:not([type=checkbox]),dialog select,dialog textarea{width:100%}
#toast{position:fixed;bottom:18px;right:18px;background:#111827;color:#fff;padding:10px 14px;border-radius:10px;display:none;z-index:9}
@media(max-width:800px){body{flex-direction:column}nav{width:auto;display:flex;overflow:auto}nav b{display:none}.in{grid-template-columns:1fr;height:auto}}
</style></head><body>
<nav><b>⚡ Customer Reactivation</b><div id="nv"></div></nav>
<main id="main"></main><dialog id="dlg"></dialog><div id="toast"></div>
<input type="file" id="csv" accept=".csv,.xlsx,.xls,.txt" hidden>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<script>
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const DAY=864e5,iso=n=>new Date(Date.now()-n*DAY).toISOString().slice(0,10),today=()=>iso(0);
const fd=s=>s?new Date(s+'T00:00:00').toLocaleDateString('es-MX'):'—',ft=t=>new Date(t).toLocaleString('es-MX',{dateStyle:'short',timeStyle:'short'});
const RK={Contactado:1,Respondió:2,'No interesado':2,Interesado:3,'Cita agendada':4,Reactivado:5};
const ST=['Activo','Inactivo','Contactado','Respondió','Interesado','Cita agendada','Reactivado','No interesado'];
const first=c=>c.name.split(' ')[0],money=n=>'$'+(n||0).toLocaleString('es-MX');
function seed(){const R=[['Carlos Mendoza',146,150,'Membresía mensual',1],['Ana Torres',200,200,'Clase de spinning',1],['Luis Ramírez',45,45,'Entrenamiento personal',1],['María López',120,130,'Membresía mensual',1],['Jorge Salinas',95,95,'Yoga',1],['Sofía Herrera',300,310,'Nutrición',0],['Diego Castro',30,30,'Membresía mensual',1],['Paula Ríos',180,185,'Clase de spinning',1],['Raúl Vega',100,110,'Entrenamiento personal',0],['Elena Cruz',250,250,'Yoga',1],['Marco Ibarra',91,91,'Membresía mensual',1],['Valeria Soto',10,12,'Clase de spinning',1]];
return{cfg:{biz:'Club Deportivo',days:90,auto:true},n:[],m:[],
c:R.map((r,i)=>({id:i+1,name:r[0],phone:'+52 55 1000 '+String(i+1).padStart(4,'0'),email:r[0].split(' ')[0].toLowerCase()+'@mail.com',lastVisit:iso(r[1]),lastPurchase:iso(r[2]),service:r[3],consent:!!r[4],status:'Activo',lastContact:'',result:'',revenue:0,sales:0})),
camp:[{id:1,name:'Regreso Octubre',seg:'Clientes inactivos',days:90,service:'',promo:'30% de descuento durante el primer mes',start:today(),end:iso(-30),max:5,msg:TPL[0],sent:[],log:{}}]}}
const TPL=['Hola {nombre} 👋 Te extrañamos en {negocio}. Vimos que hace {tiempo} no nos visitas y tenemos una promoción especial para antiguos clientes: {promo}. ¿Quieres que te cuente?','¡Hola {nombre}! Soy del equipo de {negocio}. Han pasado {tiempo} desde tu último {servicio} y queremos verte de vuelta: {promo}. ¿Te interesa?','Hola {nombre}, ¿cómo estás? En {negocio} preparamos algo para ti por tu {servicio}: {promo}. ¿Te gustaría aprovecharlo esta semana? Responde SÍ y te ayudo a agendar 🙌'];
let S;try{S=JSON.parse(localStorage.getItem('crs1'))}catch(e){}if(!S)S=seed();
let API=false,busy=0,chain=Promise.resolve(),tok=localStorage.getItem('crs_tok')||'',W={};
const hd=()=>({'Content-Type':'application/json',Authorization:'Bearer '+tok}),digits=p=>String(p||'').replace(/\D/g,'');
function login(){if($('#dlg').open)return;dlg(`<form onsubmit="return auth(event)"><h3>Customer Reactivation System</h3><label>Email</label><input name="email" type="email" required><label>Contraseña (mín. 8)</label><input name="password" type="password" minlength="8" required><label>Nombre de tu negocio (solo al crear cuenta)</label><input name="biz"><div class="tb" style="margin-top:14px"><button class="p" value="login">Entrar</button><button value="register">Crear cuenta</button></div><div class="m" id="ae"></div></form>`);$('#dlg').oncancel=e=>e.preventDefault()}
async function auth(e){e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),r=await fetch('/api/auth/'+e.submitter.value,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f)}),j=await r.json();if(!r.ok){$('#ae').textContent=j.error;return false}localStorage.setItem('crs_tok',j.token);location.reload();return false}
function waCfg(){dlg(`<form onsubmit="return saveWa(event)"><h3>WhatsApp Business (Cloud API)</h3><label>Phone Number ID</label><input name="phoneId"><label>Token de acceso permanente</label><input name="token" type="password"><div class="m">Sin credenciales funciona en modo demo. Webhook: ${location.origin}/webhook</div><div class="tb" style="margin-top:14px"><button class="p">Guardar</button><button type="button" onclick="$('#dlg').close()">Cancelar</button></div></form>`)}
async function saveWa(e){e.preventDefault();await fetch('/api/wa/config',{method:'POST',headers:hd(),body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});$('#dlg').close();toast('Credenciales guardadas');return false}
const save=()=>{if(!API)try{localStorage.setItem('crs1',JSON.stringify(S))}catch(e){}
 if(API){busy++;chain=chain.then(()=>fetch('/api/state',{method:'PUT',headers:hd(),body:JSON.stringify(S)})).then(async r=>{const j=await r.json();if(r.status==409){S=j;render()}else S.v=j.v}).catch(()=>{}).finally(()=>busy--)};
};
async function pull(first){try{const r=await fetch('/api/state',{headers:hd()});if(r.status==401){API=true;return login()}if(!r.ok)return;const j=await r.json();API=true;if(!j.c){if(first)save();return}if(!busy&&(first||j.v!==S.v)){S=j;first?render():render(1)}}catch(e){}}
const days=c=>{const l=[c.lastVisit,c.lastPurchase].filter(Boolean).sort().pop();return l?Math.floor((Date.now()-new Date(l+'T00:00:00'))/DAY):0};
const stat=c=>RK[c.status]?c.status:(days(c)>=S.cfg.days?'Inactivo':'Activo');
const toast=t=>{const e=$('#toast');e.textContent=t;e.style.display='block';setTimeout(()=>e.style.display='none',3200)};
const notify=(c,t)=>{S.n.unshift({ts:Date.now(),t:c.name+': '+t});toast('🔔 Aviso al vendedor — '+c.name+': '+t)};
const promo=c=>(S.camp.find(k=>k.sent.includes(c.id))||{}).promo||'una oferta especial para ti';
function fill(t,c,k){const d=days(c);return t.replace(/{nombre}/g,first(c)).replace(/{servicio}/g,(c.service||'servicio').toLowerCase()).replace(/{tiempo}/g,d>=60?Math.round(d/30)+' meses':d+' días').replace(/{promo}/g,k?k.promo:'una promoción especial').replace(/{negocio}/g,S.cfg.biz)}

/* ===== WHATSAPP (modo demo). Para producción: reemplaza send/receive por llamadas a tu backend,
   que usa la WhatsApp Business Cloud API (POST graph.facebook.com/<VERSION>/<PHONE_ID>/messages)
   y expone un webhook que invoca receive(). Nunca uses scraping de WhatsApp Web. ===== */
const WA={mode:'demo',
send(c,text,force){if(!c.consent&&!force)return false;const m={c:c.id,d:'o',t:text,ts:Date.now(),s:'enviado'};S.m.push(m);c.lastContact=today();
 const tm=()=>{setTimeout(()=>{m.s='entregado';save();render(1)},1200);setTimeout(()=>{m.s='leído';save();render(1)},3500)};
 if(API)fetch('/api/wa/send',{method:'POST',headers:hd(),body:JSON.stringify({to:c.phone,text,force:!!force})}).then(r=>r.json()).then(j=>{m.wamid=j.id;if(j.demo)tm();save()}).catch(()=>{});else tm();
 save();return true},
receive(c,text){S.m.push({c:c.id,d:'i',t:text,ts:Date.now()});if((RK[stat(c)]||0)<2)c.status='Respondió';save();if(S.cfg.auto)setTimeout(()=>bot(c,text),900);render(1)}};

/* ===== IA conversacional (demo basada en reglas; sustituible por una llamada a un LLM) ===== */
function bot(c,t){const l=t.toLowerCase(),w=l.replace(/[¡!¿?.,]/g,' ').split(/\s+/);let r;
 const YES=['sí','si','claro','quiero','interesa','cuánto','cuanto','precio','info','promo','ok','dale','cuéntame','cuentame'];
 if(w.includes('baja')||w.includes('stop')||/no me interesa|no gracias|no quiero/.test(l)){c.status='No interesado';c.result='No interesado';c.consent=false;c.optout=true;r='Entendido, no volverás a recibir mensajes comerciales. ¡Gracias y que estés muy bien!'}
 else if(stat(c)==='Interesado'&&(/mañana|hoy|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado/.test(l)||/\d{1,2}(:\d\d)?\s*(am|pm|hrs|h)\b/.test(l))){c.status='Cita agendada';c.appt=t;c.result='Cita: '+t;r=`¡Listo ${first(c)}! Agendé tu cita: "${t}". Te esperamos en ${S.cfg.biz} 🙌`;notify(c,'Cita agendada → '+t)}
 else if(w.some(x=>YES.includes(x))){c.status='Interesado';c.result='Interesado';r=`¡Excelente ${first(c)}! La promoción sigue vigente: ${promo(c)}. ¿Qué día y hora te acomodan para tu visita?`;notify(c,'Lead interesado, pendiente de agendar')}
 else r=`Gracias por responder, ${first(c)}. ¿Te gustaría conocer la promoción para antiguos clientes de ${S.cfg.biz}? Responde SÍ, o BAJA para no recibir más mensajes.`;
 WA.send(c,r,true);save();render(1)}

/* ===== UI ===== */
let view='dash',cur=null,q='',fs='',so='d';const V={};
const NAV=[['dash','📊 Dashboard'],['cli','👥 Clientes'],['ina','⏳ Inactivos'],['cam','📣 Campañas'],['conv','💬 Conversaciones']];
function render(soft){if(soft&&!['conv','dash'].includes(view))return;const a=$('#mi')?.value,b=$('#si')?.value;
 $('#nv').innerHTML=NAV.map(n=>`<a class="${n[0]==view?'on':''}" onclick="go('${n[0]}')">${n[1]}</a>`).join('')+(API?`<a onclick="localStorage.removeItem('crs_tok');location.reload()">↩ Salir</a>`:'');
 $('#main').innerHTML=V[view]();if(view=='cli')tbl();if(view=='conv'){if(a&&$('#mi'))$('#mi').value=a;if(b&&$('#si'))$('#si').value=b;const t=$('.th');if(t)t.scrollTop=1e9}}
const go=v=>{view=v;render()};

V.dash=()=>{const C=S.c,r=c=>RK[c.status]||0,k=f=>C.filter(f).length;
 const F=[['Clientes inactivos',k(c=>stat(c)==='Inactivo'||r(c)>0)],['Contactados',k(c=>r(c)>=1)],['Respondieron',k(c=>r(c)>=2)],['Interesados',k(c=>r(c)>=3)],['Citas',k(c=>r(c)>=4)],['Ventas',k(c=>r(c)>=5)]];
 const rev=C.reduce((s,c)=>s+(c.revenue||0),0),sales=C.reduce((s,c)=>s+(c.sales||0),0);
 const K=[['Clientes totales',C.length],['Clientes inactivos',k(c=>stat(c)==='Inactivo')],['Contactados',F[1][1]],['Respondieron',F[2][1]],['Leads interesados',F[3][1]],['Citas agendadas',F[4][1]],['Reactivados',F[5][1]],['Ventas generadas',sales],['Ingresos generados',money(rev)]];
 const mx=Math.max(1,F[0][1]);
 return`<h1>Dashboard</h1>${S.c.length?'':'<div class="card">👋 Aún no hay clientes. <button class="p" onclick="go(\'cli\')">Importar tu base</button></div>'}<div class="g">${K.map(x=>`<div class="card"><div class="m">${x[0]}</div><div class="k">${x[1]}</div></div>`).join('')}</div>
 <div class="card"><h3>Funnel de reactivación</h3>${F.map(f=>`<div class="row"><span>${f[0]}</span><div class="bar" style="width:${Math.max(4,f[1]/mx*100)}%">${f[1]}</div></div>`).join('')}</div>
 <div class="card"><h3>Conversiones por campaña</h3>${S.camp.map(p=>{const s=S.c.filter(c=>p.sent.includes(c.id)),a=s.length,b=s.filter(c=>r(c)>=2).length,v=s.filter(c=>r(c)>=5).length;return`<div class="m" style="margin-top:8px"><b style="color:var(--t)">${esc(p.name)}</b> · conversión a venta ${a?Math.round(v/a*100):0}%</div>`+[['Contactados',a],['Respondieron',b],['Ventas',v]].map(x=>`<div class="row"><span>${x[0]}</span><div class="bar" style="width:${Math.max(4,x[1]/Math.max(1,a)*100)}%">${x[1]}</div></div>`).join('')}).join('')||'<span class="m">Sin campañas</span>'}</div>
 <div class="card"><h3>🔔 Avisos al vendedor</h3>${S.n.slice(0,8).map(n=>`<div class="m">${ft(n.ts)} — ${esc(n.t)}</div>`).join('')||'<span class="m">Sin avisos todavía</span>'}</div>
 <button onclick="if(confirm('¿Reiniciar datos demo?')){localStorage.removeItem('crs1');location.reload()}">Reiniciar datos demo</button>`};

V.cli=()=>`<h1>Clientes</h1><div class="tb"><input placeholder="Buscar…" value="${esc(q)}" oninput="q=this.value;tbl()">
<select onchange="fs=this.value;tbl()"><option value="">Todos los estados</option>${ST.map(s=>`<option ${fs==s?'selected':''}>${s}</option>`).join('')}</select>
<select onchange="so=this.value;tbl()"><option value="d" ${so=='d'?'selected':''}>Más inactivos primero</option><option value="a" ${so=='a'?'selected':''}>Más recientes primero</option><option value="n" ${so=='n'?'selected':''}>Nombre A-Z</option></select>
<span class="sp"></span><button onclick="$('#csv').click()">Importar base (CSV/Excel)</button><button onclick="expCsv()">Exportar CSV</button><button class="p" onclick="addCli()">+ Cliente</button></div><div class="w" id="tb"></div>`;
function tbl(){let L=S.c.filter(c=>(c.name+c.phone+c.email+c.service).toLowerCase().includes(q.toLowerCase())&&(!fs||stat(c)===fs));
 L.sort((a,b)=>so=='n'?a.name.localeCompare(b.name):so=='d'?days(b)-days(a):days(a)-days(b));
 $('#tb').innerHTML='<table><tr><th>Nombre<th>Teléfono<th>Email<th>Última visita<th>Última compra<th>Servicio anterior<th>Días inactivo<th>Estado<th>WhatsApp<th>Último contacto<th>Resultado</tr>'+L.map(c=>`<tr><td>${esc(c.name)}<td>${esc(c.phone)}<td>${esc(c.email)}<td>${fd(c.lastVisit)}<td>${fd(c.lastPurchase)}<td>${esc(c.service)}<td>${days(c)}<td><span class="tag">${stat(c)}</span><td>${c.consent?'✅ Sí':'⛔ No'}<td>${fd(c.lastContact)}<td>${esc(c.result)||'—'}`).join('')+'</table>'}
function dlg(h){$('#dlg').innerHTML=h;$('#dlg').showModal()}
function addCli(){dlg(`<form onsubmit="return saveCli(event)"><h3>Agregar cliente</h3><label>Nombre</label><input name="name" required><label>Teléfono (con código de país)</label><input name="phone" required><label>Email</label><input name="email" type="email"><label>Última visita</label><input name="lastVisit" type="date"><label>Última compra</label><input name="lastPurchase" type="date"><label>Servicio anterior</label><input name="service">
<label><input type="checkbox" name="consent"> Tiene consentimiento válido para comunicaciones comerciales por WhatsApp</label><div class="tb" style="margin-top:14px"><button class="p">Guardar</button><button type="button" onclick="$('#dlg').close()">Cancelar</button></div></form>`)}
function saveCli(e){e.preventDefault();const f=Object.fromEntries(new FormData(e.target));S.c.push({id:Date.now(),...f,consent:!!f.consent,status:'Activo',lastContact:'',result:'',revenue:0,sales:0});save();$('#dlg').close();render();return false}
function expCsv(){const H=['nombre','telefono','email','ultima_visita','ultima_compra','servicio','consentimiento','estado'];
 const L=[H.join(',')].concat(S.c.map(c=>[c.name,c.phone,c.email,c.lastVisit,c.lastPurchase,c.service,c.consent?'si':'no',stat(c)].map(v=>'"'+String(v||'').replace(/"/g,'""')+'"').join(',')));
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([L.join('\n')],{type:'text/csv'}));a.download='clientes.csv';a.click()}
const FL=[['name','Nombre *'],['phone','Teléfono *'],['email','Email'],['lastVisit','Última visita'],['lastPurchase','Última compra'],['service','Servicio anterior'],['consent','Consentimiento WhatsApp']];
const SY={name:/nombre|name|cliente|customer/i,phone:/tel|cel|m[oó]vil|phone|mobile|whats/i,email:/mail|correo/i,lastVisit:/visita|visit|asistencia|check.?in|[uú]ltimo acceso/i,lastPurchase:/compra|purchase|pago|payment|venta/i,service:/servicio|service|plan|membres|producto|tratamiento/i,consent:/consent|acept|opt.?in|autoriz|permiso/i};
function parseCSV(t){t=t.replace(/^\uFEFF/,'');const l1=t.split(/\r?\n/)[0],d=[',',';','\t'].map(x=>[x,l1.split(x).length]).sort((a,b)=>b[1]-a[1])[0][0],R=[];let r=[],c='',q=0;
 for(let i=0;i<t.length;i++){const ch=t[i];if(q){if(ch=='"'){if(t[i+1]=='"'){c+='"';i++}else q=0}else c+=ch}else if(ch=='"')q=1;else if(ch==d){r.push(c);c=''}else if(ch=='\n'||ch=='\r'){if(ch=='\r'&&t[i+1]=='\n')i++;r.push(c);c='';R.push(r);r=[]}else c+=ch}
 if(c||r.length){r.push(c);R.push(r)}return R}
$('#csv').onchange=e=>{const f=e.target.files[0];e.target.value='';if(!f)return;
 if(/\.xlsx?$/i.test(f.name)){if(!window.XLSX)return toast('Para .xlsx hace falta internet (SheetJS). Exporta a CSV o conéctate.');f.arrayBuffer().then(b=>{const wb=XLSX.read(b,{type:'array',cellDates:true});wizard(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''}))})}
 else f.text().then(t=>wizard(parseCSV(t)))};
function wizard(rows){const H=(rows[0]||[]).map(x=>String(x).trim()),R=rows.slice(1).filter(r=>r.some(x=>String(x).trim()));if(!H.length||!R.length)return toast('El archivo está vacío o no tiene encabezados');
 const used=new Set(),M={};['consent',...FL.map(f=>f[0])].forEach(k=>{if(M[k]!==undefined)return;const i=H.findIndex((h,j)=>!used.has(j)&&SY[k].test(h));if(i>=0){M[k]=i;used.add(i)}});W={H,R};
 dlg(`<form onsubmit="return doImport(event)"><h3>Importar base (${R.length} filas)</h3><div class="m">Confirma qué columna de tu archivo corresponde a cada campo.</div>`+FL.map(([k,l])=>`<label>${l}</label><select name="${k}"><option value="">— ignorar —</option>${H.map((h,j)=>`<option value="${j}" ${M[k]===j?'selected':''}>${esc(h)} (ej. ${esc(String(R[0][j]??'').slice(0,20))})</option>`).join('')}</select>`).join('')+
 `<label>Formato de fechas</label><select name="df"><option value="dmy">DD/MM/AAAA</option><option value="mdy">MM/DD/AAAA</option></select><label>Código de país por defecto</label><input name="cc" value="52">
 <label>Si no hay columna de consentimiento, tratar a todos como</label><select name="dc"><option value="0">Sin consentimiento (no se les enviará nada)</option><option value="1">Con consentimiento — declaro que tengo su autorización</option></select>
 <label>Qué hacer con la base actual</label><select name="mode"><option value="upd">Actualizar existentes y agregar nuevos</option><option value="add">Solo agregar nuevos</option><option value="rep">Reemplazar toda la base (borra clientes y conversaciones)</option></select>
 <div class="tb" style="margin-top:14px"><button class="p">Importar</button><button type="button" onclick="$('#dlg').close()">Cancelar</button></div></form>`)}
function doImport(e){e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),R=W.R,g=(r,k)=>f[k]===''?'':r[+f[k]],P=n=>String(n).padStart(2,'0');
 if(f.name===''||f.phone==='')return toast('Nombre y teléfono son obligatorios'),false;
 const dt=v=>{if(v instanceof Date)return isNaN(v)?'':new Date(v.getTime()+432e5).toISOString().slice(0,10);v=String(v??'').trim();let m=v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);if(m)return`${m[1]}-${P(m[2])}-${P(m[3])}`;m=v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);if(!m)return'';const y=m[3].length==2?'20'+m[3]:m[3],[d,mo]=f.df=='dmy'?[m[1],m[2]]:[m[2],m[1]];return+mo>12||+d>31?'':`${y}-${P(mo)}-${P(d)}`};
 const ph=v=>{let d=digits(v);if(d.length<10)return'';if(d.length==10)d=digits(f.cc)+d;return'+'+d};
 const cs=r=>f.consent===''?f.dc==='1':/^(si|sí|s|1|true|yes|y|x|ok|acepta|autorizo)$/i.test(String(g(r,'consent')).trim());
 if(f.mode==='rep'){if(!confirm('Esto borrará todos los clientes y conversaciones actuales. ¿Continuar?'))return false;S.c=[];S.m=[];S.camp.forEach(k=>k.sent=[])}
 const ix=new Map(S.c.map(c=>[digits(c.phone).slice(-10),c]));let a=0,u=0,sk=0,bd=0,n=0;
 R.forEach(r=>{const p=ph(g(r,'phone')),nm=String(g(r,'name')).trim();if(!p||!nm){sk++;return}
  const v={name:nm,phone:p,email:String(g(r,'email')).trim(),lastVisit:dt(g(r,'lastVisit')),lastPurchase:dt(g(r,'lastPurchase')),service:String(g(r,'service')).trim()};
  if((f.lastVisit!==''&&!v.lastVisit)||(f.lastPurchase!==''&&!v.lastPurchase))bd++;
  const k=p.slice(-10),o=ix.get(k);
  if(o){if(f.mode==='add')return;Object.entries(v).forEach(([x,y])=>{if(y)o[x]=y});if(f.consent!==''&&!o.optout)o.consent=cs(r);u++}
  else{const c={id:Date.now()+n++,...v,consent:cs(r),status:'Activo',lastContact:'',result:'',revenue:0,sales:0};S.c.push(c);ix.set(k,c);a++}});
 save();$('#dlg').close();view='ina';render();toast(`${a} nuevos, ${u} actualizados, ${sk} omitidos (sin nombre o teléfono válido), ${bd} fechas vacías o no reconocidas`);return false}

const elig=(days0,svc,seg)=>S.c.filter(c=>days(c)>=days0&&['Activo','Inactivo'].includes(stat(c))&&!S.camp.some(k=>k.sent.includes(c.id))&&(!svc||c.service===svc)&&(!(seg||'').includes('compra')||c.lastPurchase));
V.ina=()=>{const all=S.c.filter(c=>stat(c)==='Inactivo'),ok=elig(S.cfg.days).filter(c=>c.consent);
 return`<h1>Clientes inactivos</h1><div class="card tb"><label>Clientes inactivos después de <input type="number" min="1" value="${S.cfg.days}" style="width:80px" onchange="S.cfg.days=+this.value||90;save();render()"> días</label>
 <label>Negocio <input value="${esc(S.cfg.biz)}" onchange="S.cfg.biz=this.value;save()"></label><label><input type="checkbox" ${S.cfg.auto?'checked':''} onchange="S.cfg.auto=this.checked;save()"> IA responde automáticamente</label><span class="m">WhatsApp: modo ${WA.mode}</span>${API?'<button onclick="waCfg()">Configurar WhatsApp</button>':''}</div>
 <p class="m">${all.length} inactivos · ${ok.length} elegibles para reactivación (con consentimiento). Los clientes sin consentimiento nunca reciben mensajes automáticos.</p>
 <div class="w"><table><tr><th>Nombre<th>Última actividad<th>Días inactivo<th>Estado<th>Elegibilidad</tr>${all.map(c=>`<tr><td>${esc(c.name)}<td>${fd([c.lastVisit,c.lastPurchase].sort().pop())}<td>${days(c)}<td><span class="tag">INACTIVO</span><td>${c.consent?'✅ Elegible':'⛔ Sin consentimiento'}`).join('')}</table></div>`};

V.cam=()=>`<h1>Campañas</h1><div class="tb"><button class="p" onclick="newCam()">+ Nueva campaña</button></div>`+S.camp.map(p=>{const s=S.c.filter(c=>p.sent.includes(c.id)),n=elig(p.days,p.service,p.seg).filter(c=>c.consent).length;
 return`<div class="card"><div class="tb"><b>${esc(p.name)}</b><span class="m">${esc(p.seg)} · ${p.days}+ días · ${esc(p.service||'Todos los servicios')} · ${fd(p.start)} → ${fd(p.end)} · máx ${p.max}/día</span><span class="sp"></span><button class="p" onclick="launch(${p.id})">Enviar lote de hoy (${n} elegibles)</button></div>
 <div class="m">🎁 ${esc(p.promo)}</div><p>${esc(p.msg)}</p><div class="m">Contactados ${s.length} · Respondieron ${s.filter(c=>(RK[c.status]||0)>=2).length} · Citas ${s.filter(c=>(RK[c.status]||0)>=4).length} · Ventas ${s.reduce((a,c)=>a+(c.sales||0),0)}</div></div>`}).join('');
function newCam(){const sv=[...new Set(S.c.map(c=>c.service).filter(Boolean))];
 dlg(`<form onsubmit="return saveCam(event)"><h3>Nueva campaña</h3><label>Nombre</label><input name="name" required value="Regreso Octubre"><label>Segmento</label><select name="seg"><option>Clientes inactivos</option><option>Clientes inactivos con compra previa</option></select>
 <label>Días de inactividad</label><input name="days" type="number" value="${S.cfg.days}"><label>Servicio</label><select name="service"><option value="">Todos</option>${sv.map(s=>`<option>${esc(s)}</option>`).join('')}</select>
 <label>Promoción</label><input name="promo" value="30% de descuento durante el primer mes"><label>Fecha de inicio</label><input name="start" type="date" value="${today()}"><label>Fecha de finalización</label><input name="end" type="date" value="${iso(-30)}"><label>Máximo de mensajes diarios</label><input name="max" type="number" value="20">
 <label>Mensaje (usa {nombre} {servicio} {tiempo} {promo} {negocio})</label><textarea name="msg" id="gm" rows="5">${TPL[0]}</textarea><button type="button" onclick="genMsg()">✨ Generar mensaje con IA</button>
 <div class="tb" style="margin-top:14px"><button class="p">Crear campaña</button><button type="button" onclick="$('#dlg').close()">Cancelar</button></div></form>`)}
let gi=0;async function genMsg(){gi=(gi+1)%TPL.length;$('#gm').value=TPL[gi];if(!API)return;const f=Object.fromEntries(new FormData($('#dlg form')));
 try{const r=await fetch('/api/ai/message',{method:'POST',headers:hd(),body:JSON.stringify({biz:S.cfg.biz,promo:f.promo,service:f.service})});const j=await r.json();if(j.text)$('#gm').value=j.text}catch(e){}}
function saveCam(e){e.preventDefault();const f=Object.fromEntries(new FormData(e.target));S.camp.push({id:Date.now(),...f,days:+f.days,max:+f.max,sent:[],log:{}});save();$('#dlg').close();render();return false}
function launch(id){const p=S.camp.find(k=>k.id==id),t=today();if(t<p.start||t>p.end)return toast('La campaña está fuera de su rango de fechas');
 const left=p.max-(p.log[t]||0);if(left<=0)return toast('Límite diario alcanzado');
 const L=elig(p.days,p.service,p.seg).filter(c=>c.consent).slice(0,left);if(!L.length)return toast('No hay clientes elegibles con consentimiento');
 L.forEach(c=>{const txt=fill(p.msg,c,p)+'\n\nResponde BAJA para no recibir más mensajes.';if(WA.send(c,txt)){p.sent.push(c.id);c.status='Contactado'}});
 p.log[t]=(p.log[t]||0)+L.length;save();render();toast(L.length+' mensajes enviados (modo demo)')}

V.conv=()=>{const ids=[...new Set(S.m.map(m=>m.c))],last=id=>S.m.filter(m=>m.c===id).pop();ids.sort((a,b)=>last(b).ts-last(a).ts);if(!cur&&ids.length)cur=ids[0];
 const c=S.c.find(x=>x.id===cur),T={enviado:'✓',entregado:'✓✓','leído':'✓✓ leído'};
 const R=c?`<div class="hd"><b>${esc(c.name)}</b> <span class="tag">${stat(c)}</span> <span class="m">${esc(c.phone)} · ${esc(c.service)} · ${days(c)} días inactivo</span>
 <div class="tb" style="margin:8px 0 0"><button onclick="venta()">💰 Registrar venta</button><button onclick="notify(S.c.find(x=>x.id===cur),'Requiere atención humana');save();render()">🔔 Avisar al vendedor</button><button onclick="setSt('No interesado')">No interesado</button></div></div>
 <div class="th">${S.m.filter(m=>m.c===cur).map(m=>`<div class="bb ${m.d}">${esc(m.t).replace(/\n/g,'<br>')}<small>${ft(m.ts)} ${m.d=='o'?T[m.s]:''}</small></div>`).join('')}</div>
 <div class="cm"><input id="mi" placeholder="Responder como agente…" onkeydown="if(event.key=='Enter')agent()"><button class="p" onclick="agent()">Enviar</button></div>
 <div class="cm" style="background:#fffbeb"><input id="si" placeholder="DEMO: escribe como si fueras el cliente (ej. 'sí', 'mañana 10am', 'baja')" onkeydown="if(event.key=='Enter')sim()"><button onclick="sim()">Simular respuesta</button></div>`:'<div class="hd m">Lanza una campaña para iniciar conversaciones.</div>';
 return`<h1>Conversaciones <span class="m">WhatsApp · modo ${WA.mode}</span></h1><div class="card in"><div class="l">${ids.map(id=>{const x=S.c.find(k=>k.id===id),m=last(id);return`<div class="${id==cur?'on':''}" onclick="cur=${id};render()"><b>${esc(x.name)}</b> <span class="tag">${stat(x)}</span><div class="m" style="padding:0">${esc(m.t).slice(0,48)}…</div></div>`}).join('')||'<div class="m">Sin conversaciones</div>'}</div><div class="r">${R}</div></div>`};
function agent(){const v=$('#mi').value.trim(),c=S.c.find(x=>x.id===cur);if(!v)return;WA.send(c,v,true);render()}
function sim(){const v=$('#si').value.trim(),c=S.c.find(x=>x.id===cur);if(!v)return;$('#si').value='';WA.receive(c,v)}
function setSt(s){const c=S.c.find(x=>x.id===cur);c.status=s;c.result=s;save();render()}
function venta(){const c=S.c.find(x=>x.id===cur),n=parseFloat(prompt('Monto de la venta ($):'));if(!(n>0))return;c.revenue=(c.revenue||0)+n;c.sales=(c.sales||0)+1;c.status='Reactivado';c.result='Venta '+money(n);notify(c,'Cliente reactivado · venta '+money(n));save();render()}
render();pull(1);setInterval(()=>pull(),4000);
</script></body></html>
"}
]}