// Customer Reactivation System — backend (Node 18+, sin dependencias). Ejecuta: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }); } catch (e) {}
const E = process.env, PORT = E.PORT || 3000, DB = path.join(__dirname, 'data.json'), GRAPH = 'https://graph.facebook.com/v21.0';
const REAL = !!(E.WA_TOKEN && E.WA_PHONE_ID);           // sin credenciales => modo demo
const RK = { Contactado: 1, Respondió: 2, 'No interesado': 2, Interesado: 3, 'Cita agendada': 4, Reactivado: 5 };
let S = {}; try { S = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const persist = () => { S.v = (S.v || 0) + 1; fs.writeFileSync(DB, JSON.stringify(S)); };   // Para escalar: cambia por SQLite/Postgres
const digits = p => String(p || '').replace(/\D/g, '');

// ---------- WhatsApp Cloud API ----------
// OJO: Meta solo permite texto libre dentro de las 24 h posteriores al último mensaje del cliente.
// El PRIMER mensaje de una campaña debe ser una plantilla aprobada (type:'template'). Adáptalo aquí.
async function waSend(to, text) {
  if (!REAL) return { id: 'demo-' + Date.now(), demo: true };
  const r = await fetch(`${GRAPH}/${E.WA_PHONE_ID}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + E.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j));
  return { id: j.messages[0].id };
}

// ---------- IA (Claude API; si no hay clave, usa reglas) ----------
async function claude(system, user, max = 300) {
  if (!E.ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: E.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: max, system, messages: [{ role: 'user', content: user }] }) });
    const j = await r.json(); return j.content?.[0]?.text?.trim() || null;
  } catch (e) { return null; }
}
const TIME = /mañana|hoy|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|\d{1,2}(:\d\d)?\s*(am|pm|hrs|h)\b/;
const YES = ['sí', 'si', 'claro', 'quiero', 'interesa', 'cuánto', 'cuanto', 'precio', 'info', 'promo', 'ok', 'dale', 'cuéntame', 'cuentame'];
function decide(c, t) {   // calificación determinista: la IA solo redacta, no decide estados
  const l = t.toLowerCase(), w = l.replace(/[¡!¿?.,]/g, ' ').split(/\s+/), f = c.name.split(' ')[0];
  const promo = (S.camp || []).find(k => k.sent.includes(c.id))?.promo || 'una oferta especial';
  if (w.includes('baja') || w.includes('stop') || /no me interesa|no gracias|no quiero/.test(l)) { c.status = 'No interesado'; c.result = 'No interesado'; c.consent = false; return ['Entendido, no volverás a recibir mensajes comerciales. ¡Gracias!', null]; }
  if (c.status === 'Interesado' && TIME.test(l)) { c.status = 'Cita agendada'; c.appt = t; c.result = 'Cita: ' + t; return [`¡Listo ${f}! Agendé tu cita: "${t}". Te esperamos 🙌`, 'Cita agendada → ' + t]; }
  if (w.some(x => YES.includes(x))) { c.status = 'Interesado'; c.result = 'Interesado'; return [`¡Excelente ${f}! La promoción sigue vigente: ${promo}. ¿Qué día y hora te acomodan?`, 'Lead interesado, pendiente de agendar']; }
  return [`Gracias por responder, ${f}. ¿Te cuento la promoción para antiguos clientes? Responde SÍ, o BAJA para no recibir más mensajes.`, null];
}
async function handleIncoming(c, text) {
  let [reply, notice] = decide(c, text);
  const hist = S.m.filter(m => m.c === c.id).slice(-8).map(m => (m.d === 'o' ? 'Negocio: ' : 'Cliente: ') + m.t).join('\n');
  reply = (await claude(`Eres asistente de ventas de ${S.cfg?.biz || 'un negocio'} por WhatsApp. Reescribe el mensaje base en español, breve, cálido y natural (máx. 2 frases). No inventes precios ni promociones. Conserva su intención y cualquier instrucción como "responde BAJA".`, `Historial:\n${hist}\n\nMensaje base: ${reply}`)) || reply;
  const r = await waSend(c.phone, reply).catch(e => (console.error(e.message), null));
  if (r) S.m.push({ c: c.id, d: 'o', t: reply, ts: Date.now(), s: 'enviado', wamid: r.id });
  if (notice) S.n.unshift({ ts: Date.now(), t: c.name + ': ' + notice });   // aquí puedes añadir email/Slack al vendedor
  persist();
}
function inbound(body) {
  for (const en of body.entry || []) for (const ch of en.changes || []) {
    const v = ch.value || {};
    for (const s of v.statuses || []) { const m = (S.m || []).find(x => x.wamid === s.id); if (m) m.s = s.status === 'read' ? 'leído' : s.status === 'delivered' ? 'entregado' : m.s; }
    for (const msg of v.messages || []) {
      const c = (S.c || []).find(x => digits(x.phone).slice(-10) === digits(msg.from).slice(-10)); if (!c) continue;
      const text = msg.text?.body || '[mensaje no textual]';
      S.m.push({ c: c.id, d: 'i', t: text, ts: Date.now() });
      if ((RK[c.status] || 0) < 2) c.status = 'Respondió';
      persist(); if (S.cfg?.auto !== false) handleIncoming(c, text);
    }
  }
  persist();
}

// ---------- HTTP ----------
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), send = (code, o, t = 'application/json') => { res.writeHead(code, { 'Content-Type': t }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (u.pathname === '/api/state') {
      if (req.method === 'GET') return send(200, S);
      if (req.method === 'PUT') { const b = JSON.parse(await readBody(req)); if ((S.v || 0) !== (b.v || 0) && S.c) return send(409, S); S = b; persist(); return send(200, { v: S.v }); }
    }
    if (u.pathname === '/api/wa/send' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req)), c = (S.c || []).find(x => digits(x.phone) === digits(b.to));
      if (c && !c.consent && !b.force) return send(403, { error: 'Cliente sin consentimiento de WhatsApp' });
      return send(200, await waSend(b.to, b.text));
    }
    if (u.pathname === '/api/ai/message' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const text = await claude('Redactas mensajes de WhatsApp para reactivar clientes inactivos. Español, 2-3 frases, tono cercano, 1 emoji máximo. Usa exactamente estos marcadores: {nombre} {servicio} {tiempo} {negocio} {promo}. No inventes datos. Devuelve solo el mensaje.', `Negocio: ${b.biz}. Servicio: ${b.service || 'cualquiera'}. Promoción: ${b.promo}.`);
      return send(200, { text });
    }
    if (u.pathname === '/webhook') {
      if (req.method === 'GET') return u.searchParams.get('hub.verify_token') === E.WA_VERIFY_TOKEN && E.WA_VERIFY_TOKEN ? send(200, u.searchParams.get('hub.challenge'), 'text/plain') : send(403, 'forbidden', 'text/plain');
      if (req.method === 'POST') {
        const raw = await readBody(req);
        if (E.WA_APP_SECRET) { const sig = 'sha256=' + crypto.createHmac('sha256', E.WA_APP_SECRET).update(raw).digest('hex'); if (sig !== req.headers['x-hub-signature-256']) return send(401, 'bad signature', 'text/plain'); }
        send(200, 'ok', 'text/plain'); try { inbound(JSON.parse(raw)); } catch (e) { console.error(e); } return;
      }
    }
    send(404, { error: 'not found' });
  } catch (e) { console.error(e); send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`CRS en http://localhost:${PORT} · WhatsApp: ${REAL ? 'REAL' : 'demo'} · IA: ${E.ANTHROPIC_API_KEY ? 'Claude' : 'reglas'}`));
