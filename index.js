// STAIN SPAMMING BOT - share links to WhatsApp group statuses, fully controlled from Telegram.
// Multisession pattern + pinned Baileys (7.0.0-rc11) taken from Stain x Habibi.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');
const Pino = require('pino');

// ---------------------------------------------------------------- config
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!TOKEN) { console.error('[FATAL] TELEGRAM_BOT_TOKEN is missing.'); process.exit(1); }
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '');
const ADMIN_IDS = new Set([OWNER_ID, ...(process.env.TELEGRAM_ADMIN_IDS || '').split(',')]
  .map(s => s.trim()).filter(Boolean));
const BOT_NAME = process.env.BOT_NAME || 'Stain Spamming Bot';
const OWNER_NAME = process.env.OWNER_NAME || '⎯꯭𝐒꯭𝛕꯭֟፝ؖ۬͡𝛂꯭𝛊꯭𝚗̵꯭теры꯭᳚༎꯭꯭͜➛';
const OWNER_LINK = process.env.OWNER_LINK || 'https://t.me/heisevanss';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 30);
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER || 2);
const POST_DELAY_MIN = Number(process.env.POST_DELAY_MIN || 3000);
const POST_DELAY_MAX = Number(process.env.POST_DELAY_MAX || 6000);

const DATA = process.env.DATA_DIR || __dirname;
const SESSIONS_DIR = path.join(DATA, 'sessions');
const DB_DIR = path.join(DATA, 'database');
for (const d of [SESSIONS_DIR, DB_DIR]) fs.mkdirSync(d, { recursive: true });
const DB = {
  paired: path.join(DB_DIR, 'paired.json'),
  notified: path.join(DB_DIR, 'notified.json'),
  users: path.join(DB_DIR, 'users.json'),
  blocked: path.join(DB_DIR, 'blocked.json')
};

global.botStartTime = Date.now();
const bot = new TelegramBot(TOKEN, { polling: true });
const activeSessions = new Map();   // sessionName -> { conn, ownerNumber, telegramChatId, retries, online }
const removing = new Set();         // sessions being removed on purpose
const awaiting = new Map();         // tgId -> { type }
const flows = new Map();            // tgId -> /ggstatus flow state

// ---------------------------------------------------------------- utils
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&', '<': '<', '>': '>' }[c]));
const cleanNumber = n => String(n || '').replace(/\D/g, '');
const isAdmin = id => ADMIN_IDS.has(String(id));
function read(p, f) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : f; } catch { return f; } }
function write(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function fmtUp(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
    m = Math.floor(s % 3600 / 60), x = s % 60;
  return `${d ? d + 'd ' : ''}${h}h ${m}m ${x}s`;
}
const mb = b => (b / 1024 / 1024).toFixed(0) + ' MB';

function send(chatId, text, kb) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(kb ? { reply_markup: { inline_keyboard: kb } } : {})
  }).catch(e => console.error('[send]', e.message));
}
function edit(chatId, messageId, text, kb) {
  return bot.editMessageText(text, {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(kb ? { reply_markup: { inline_keyboard: kb } } : {})
  }).catch(() => {});
}

// ---------------------------------------------------------------- storage (same shapes as Stain x Habibi)
const paired = () => read(DB.paired, {});
const savePaired = v => write(DB.paired, v);
const notified = () => new Set(read(DB.notified, []));
const markNotified = s => { const x = notified(); x.add(s); write(DB.notified, [...x]); };
const totalSessions = () => Object.values(paired()).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
const getUserSessions = id => paired()[String(id)] || [];
function registerPaired(id, wa, sessionName) {
  const db = paired(); db[String(id)] = getUserSessions(id);
  db[String(id)].push({ waNumber: wa, sessionName, pairedAt: new Date().toISOString() });
  savePaired(db);
}
function unregisterPaired(id, sessionName) {
  const db = paired();
  db[String(id)] = (db[String(id)] || []).filter(x => x.sessionName !== sessionName);
  if (!db[String(id)].length) delete db[String(id)];
  savePaired(db);
}
const getSessionDir = n => path.join(SESSIONS_DIR, n);
function deleteSession(n) { const d = getSessionDir(n); if (!fs.existsSync(d)) return false; fs.rmSync(d, { recursive: true, force: true }); return true; }
function isRegistered(n) { return !!read(path.join(getSessionDir(n), 'creds.json'), {}).registered; }

const users = () => read(DB.users, {});
const getBrand = id => users()[String(id)]?.brand || '';
function setBrand(id, brand) { const u = users(); u[String(id)] = { ...(u[String(id)] || {}), brand }; write(DB.users, u); }
const blockedList = () => read(DB.blocked, []);
const isBlocked = id => !isAdmin(id) && blockedList().includes(String(id));

// ---------------------------------------------------------------- WhatsApp session (exact pattern)
async function startWASession(sessionName, telegramChatId, ownerNumber) {
  if (activeSessions.has(sessionName)) return activeSessions.get(sessionName).conn;
  const sessionDir = getSessionDir(sessionName); fs.mkdirSync(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  let version; try { version = (await fetchLatestBaileysVersion()).version; } catch {}
  const conn = makeWASocket({
    ...(version ? { version } : {}),
    keepAliveIntervalMs: 10000,
    printQRInTerminal: false,
    logger: Pino({ level: 'silent' }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: 'silent' })) },
    browser: ['Ubuntu', 'Opera', '100.0.4815.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false, // keeps phone notifications working while the bot is linked
    autoFollow: false,
    getMessage: async () => ({ conversation: '' })
  });
  activeSessions.set(sessionName, { conn, ownerNumber, telegramChatId, retries: 0, online: false });
  conn.ev.on('creds.update', saveCreds);

  if (!state.creds.registered && telegramChatId) {
    setTimeout(async () => {
      try {
        let code = await conn.requestPairingCode(ownerNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        await send(telegramChatId,
          `<b>PAIRING CODE</b>\n\nNumber: <code>+${H(ownerNumber)}</code>\n\n` +
          `Tap the code below to copy it, then open WhatsApp > Linked devices > Link a device > ` +
          `Link with phone number instead, and paste it.`,
          [[{ text: code, copy_text: { text: code } }],
           [{ text: 'Cancel pairing', callback_data: `d:${sessionName}` }]]);
      } catch (e) {
        await send(telegramChatId, `<b>PAIRING FAILED</b>\n\n${H(e.message)}`);
      }
    }, 3000);
  }

  conn.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (removing.has(sessionName)) return;
    const code = lastDisconnect?.error?.output?.statusCode;
    const s = activeSessions.get(sessionName);
    if (connection === 'open') {
      if (s) { s.retries = 0; s.online = true; }
      const num = cleanNumber(conn.user?.id?.split(':')[0] || ownerNumber);
      console.log(`[${sessionName}] connected as +${num}`);
      if (telegramChatId && !notified().has(sessionName)) {
        markNotified(sessionName);
        await send(telegramChatId,
          `<b>CONNECTED</b>\n\nName: ${H(conn.user?.name || 'WhatsApp')}\nNumber: <code>+${H(num)}</code>\n\nYour session is online.`,
          [[{ text: 'Share link status', callback_data: 'm:gg' }]]);
      }
    }
    if (connection === 'close') {
      if (s) s.online = false;
      if (code === DisconnectReason.loggedOut || code === 401) {
        activeSessions.delete(sessionName);
        try { deleteSession(sessionName); } catch {}
        unregisterPaired(telegramChatId, sessionName);
        await send(telegramChatId, `<b>SESSION LOGGED OUT</b>\n\n+${H(ownerNumber)} was logged out and the session was removed.`);
        return;
      }
      if (!s) return;
      s.retries = (s.retries || 0) + 1;
      if (s.retries > 6) {
        activeSessions.delete(sessionName);
        await send(telegramChatId, `<b>SESSION OFFLINE</b>\n\n+${H(ownerNumber)} could not reconnect. It will retry on the next bot restart.`);
        return;
      }
      const delay = Math.min(5000 * s.retries, 30000);
      activeSessions.delete(sessionName);
      setTimeout(() => startWASession(sessionName, telegramChatId, ownerNumber), delay);
    }
  });
  return conn;
}

async function reloadSessions() {
  const db = paired();
  for (const [tgId, list] of Object.entries(db)) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!fs.existsSync(getSessionDir(item.sessionName))) { unregisterPaired(tgId, item.sessionName); continue; }
      if (!isRegistered(item.sessionName)) { // half-finished pairing: drop instead of re-sending codes
        deleteSession(item.sessionName); unregisterPaired(tgId, item.sessionName); continue;
      }
      await startWASession(item.sessionName, tgId, item.waNumber);
      await sleep(1000);
    }
  }
}

async function removeSession(sessionName, tgId, { logout = true } = {}) {
  removing.add(sessionName);
  const s = activeSessions.get(sessionName);
  activeSessions.delete(sessionName);
  if (s) {
    try {
      if (logout && isRegistered(sessionName)) await Promise.race([s.conn.logout(), sleep(5000)]);
      else s.conn.end(undefined);
    } catch {}
  }
  deleteSession(sessionName);
  unregisterPaired(tgId, sessionName);
  setTimeout(() => removing.delete(sessionName), 15000);
}

// ---------------------------------------------------------------- link preview + status payload
const decode = s => (s || '').replace(/&/g, '&').replace(/"/g, '"').replace(/&#0?39;|'/g, "'" )
  .replace(/</g, '<').replace(/>/g, '>').trim();

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
}

async function buildPreview(url) {
  const out = { title: '', description: '', thumb: null };
  try {
    const res = await fetchWithTimeout(url, 7000, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', accept: 'text/html' } });
    const html = (await res.text()).slice(0, 400000);
    const meta = key => {
      const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'))?.[0];
      return decode(tag?.match(/content=["']([^"']*)["']/i)?.[1]);
    };
    out.title = meta('og:title') || meta('twitter:title') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    out.description = meta('og:description') || meta('description') || meta('twitter:description');
    const img = meta('og:image') || meta('twitter:image');
    if (img) {
      try {
        const imgRes = await fetchWithTimeout(new URL(img, url).href, 7000);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const { Jimp } = require('jimp');
        const j = await Jimp.read(buf);
        j.scaleToFit({ w: 300, h: 300 });
        out.thumb = await j.getBuffer('image/jpeg', { quality: 70 });
      } catch {}
    }
  } catch {}
  return out;
}

const BG = [0xff1a2a3a, 0xff2c3e50, 0xff8e44ad, 0xff2980b9, 0xff27ae60];

async function postGroupStatus(conn, groupJid, ext) {
  const content = { groupStatusMessageV2: { message: { extendedTextMessage: ext } } };
  const msg = generateWAMessageFromContent(groupJid, content, { userJid: conn.user.id });
  await conn.relayMessage(groupJid, msg.message, { messageId: msg.key.id });
}

// ---------------------------------------------------------------- panels
function homeKb(id) {
  const kb = [
    [{ text: 'Share link status', callback_data: 'm:gg' }],
    [{ text: 'Pair', callback_data: 'm:pair' }, { text: 'Delete pair', callback_data: 'm:del' }],
    [{ text: 'Brand tag', callback_data: 'm:brand' }],
    [{ text: 'Ping', callback_data: 'm:ping' }, { text: 'Uptime', callback_data: 'm:up' }]
  ];
  if (isAdmin(id)) kb.push([{ text: 'Admin', callback_data: 'm:admin' }]);
  kb.push([{ text: `Owner ${OWNER_NAME}`, url: OWNER_LINK }]);
  return kb;
}
function showHome(chatId, id) {
  const mine = getUserSessions(id);
  const online = mine.filter(x => activeSessions.get(x.sessionName)?.online).length;
  const brand = getBrand(id);
  return send(chatId,
    `<b>${H(BOT_NAME)}</b>\n\nShare links to your WhatsApp group statuses straight from Telegram.\n\n` +
    `Owner: <a href="${OWNER_LINK}">${H(OWNER_NAME)}</a>\n\n` +
    `Sessions: ${online}/${mine.length} online\nBrand tag: ${brand ? H(brand) : 'none'}`, homeKb(id));
}
const backKb = [[{ text: 'Menu', callback_data: 'm:home' }]];

async function doPing(chatId) {
  const t0 = Date.now();
  const m = await bot.sendMessage(chatId, 'Pinging...').catch(() => null);
  if (!m) return;
  await edit(chatId, m.message_id, `<b>PONG</b>\n\nLatency: <code>${Date.now() - t0} ms</code>`, backKb);
}

async function doUptime(chatId) {
  const t0 = Date.now();
  const tgOk = await bot.getMe().then(() => true).catch(() => false);
  const tgMs = Date.now() - t0;
  const all = [...activeSessions.values()];
  const online = all.filter(s => s.online).length;
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const rw = process.env.RAILWAY_ENVIRONMENT_NAME
    ? `\nRailway: ${H(process.env.RAILWAY_SERVICE_NAME || '-')} / ${H(process.env.RAILWAY_ENVIRONMENT_NAME)} / ${H(process.env.RAILWAY_REPLICA_REGION || '-')}`
    : '';
  const health = !tgOk ? 'Unhealthy (Telegram unreachable)'
    : (all.length && online < all.length ? 'Degraded (some sessions offline)' : 'Healthy');
  return send(chatId,
    `<b>UPTIME</b>\n\n` +
    `Bot: <code>${fmtUp(Date.now() - global.botStartTime)}</code>\n` +
    `Host up: <code>${fmtUp(os.uptime() * 1000)}</code>\n` +
    `Health: <b>${health}</b>\n` +
    `Telegram: ${tgOk ? 'ok' : 'down'} (${tgMs} ms)\n` +
    `Sessions: ${online}/${all.length} online (cap ${MAX_SESSIONS})\n\n` +
    `<b>HOST</b>\n` +
    `Name: ${H(os.hostname())}\nOS: ${H(os.platform())} ${H(os.arch())} ${H(os.release())}\n` +
    `Node: ${H(process.version)}\n` +
    `CPU: ${H(cpus[0]?.model || '-')} x${cpus.length}\nLoad: ${os.loadavg().map(x => x.toFixed(2)).join(' ')}\n` +
    `RAM: ${mb(os.totalmem() - os.freemem())} / ${mb(os.totalmem())}\n` +
    `Bot RSS: ${mb(mem.rss)} | Heap: ${mb(mem.heapUsed)}${rw}`, backKb);
}

// ---------------------------------------------------------------- pairing
async function doPair(chatId, tgId, numberRaw) {
  const id = String(tgId), n = cleanNumber(numberRaw);
  if (!n) {
    awaiting.set(id, { type: 'pair' });
    return send(chatId, '<b>PAIR</b>\n\nSend your WhatsApp number now, with country code and no +.\nExample: <code>2348123456789</code>',
      [[{ text: 'Cancel', callback_data: 'x' }]]);
  }
  if (n.length < 8 || n.length > 15) return send(chatId, 'That number does not look valid. Use country code, digits only.');
  const existing = getUserSessions(id);
  if (existing.length >= MAX_SESSIONS_PER_USER) return send(chatId, `You already have ${MAX_SESSIONS_PER_USER} sessions. Remove one with /delpair first.`);
  if (totalSessions() >= MAX_SESSIONS) return send(chatId, `The global session limit (${MAX_SESSIONS}) has been reached.`);
  if (Object.values(paired()).flat().some(x => cleanNumber(x.waNumber) === n)) return send(chatId, 'That WhatsApp number is already paired.');
  awaiting.delete(id);
  const sessionName = `session_${id}_${Date.now()}`;
  registerPaired(id, n, sessionName);
  await send(chatId, `Generating a pairing code for <code>+${H(n)}</code>...`);
  try {
    await startWASession(sessionName, chatId, n);
    setTimeout(async () => { // drop pairings nobody completed
      if (activeSessions.has(sessionName) && !isRegistered(sessionName)) {
        await removeSession(sessionName, id, { logout: false });
        send(chatId, `Pairing for <code>+${H(n)}</code> timed out and was cancelled.`);
      }
    }, 4 * 60 * 1000);
  } catch (e) {
    unregisterPaired(id, sessionName); deleteSession(sessionName);
    send(chatId, `Pairing failed: ${H(e.message)}`);
  }
}

async function doDelPanel(chatId, tgId, numberRaw) {
  const id = String(tgId), list = getUserSessions(id), n = cleanNumber(numberRaw);
  if (!list.length) return send(chatId, 'You have no paired sessions.', backKb);
  if (n) {
    const t = list.find(x => cleanNumber(x.waNumber) === n);
    if (!t) return send(chatId, 'Session not found.');
    await removeSession(t.sessionName, id);
    return send(chatId, `Removed <code>+${H(t.waNumber)}</code>.`, backKb);
  }
  const kb = list.map(x => [{ text: `Remove +${x.waNumber}`, callback_data: `d:${x.sessionName}` }]);
  kb.push([{ text: 'Cancel', callback_data: 'x' }]);
  return send(chatId, '<b>DELETE PAIR</b>\n\nWhich session should be removed?', kb);
}

// ---------------------------------------------------------------- /ggstatus flow
function parseLink(text) {
  const link = (text || '').match(/https?:\/\/[^\s]+/)?.[0];
  return link ? { link, caption: text.replace(link, '').trim() } : null;
}

async function startGG(chatId, tgId, argText) {
  const id = String(tgId);
  const list = getUserSessions(id).filter(x => activeSessions.get(x.sessionName)?.online);
  if (!list.length) {
    return send(chatId, getUserSessions(id).length
      ? 'Your sessions are offline right now. Check /uptime or try again shortly.'
      : 'You have no paired session yet.', [[{ text: 'Pair a number', callback_data: 'm:pair' }]]);
  }
  const parsed = parseLink(argText);
  if (!parsed) {
    awaiting.set(id, { type: 'gglink' });
    return send(chatId, '<b>SHARE LINK STATUS</b>\n\nSend the link now. Add a caption after it if you want one.\nExample: <code>https://example.com Check this out</code>',
      [[{ text: 'Cancel', callback_data: 'x' }]]);
  }
  awaiting.delete(id);
  flows.set(id, { ...parsed, sessionName: null, groups: [], selected: new Set(), page: 0 });
  if (list.length === 1) return loadGroups(chatId, id, list[0].sessionName);
  return send(chatId, 'Which WhatsApp account should post?',
    [...list.map(x => [{ text: `+${x.waNumber}`, callback_data: `g:s:${x.sessionName}` }]), [{ text: 'Cancel', callback_data: 'g:x' }]]);
}

async function loadGroups(chatId, id, sessionName) {
  const f = flows.get(id); const s = activeSessions.get(sessionName);
  if (!f || !s?.online) return send(chatId, 'That session is not online.');
  const m = await bot.sendMessage(chatId, 'Loading your groups...').catch(() => null);
  try {
    const all = await s.conn.groupFetchAllParticipating();
    f.groups = Object.values(all).map(g => ({ id: g.id, subject: g.subject || g.id, size: g.participants?.length || 0 }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    f.sessionName = sessionName; f.page = 0; f.selected = new Set();
    if (!f.groups.length) return edit(chatId, m.message_id, 'This account is not in any groups.', backKb);
    f.msgId = m.message_id;
    return renderGroups(chatId, id);
  } catch (e) {
    return edit(chatId, m.message_id, `Could not load groups: ${H(e.message)}`, backKb);
  }
}

const PAGE = 8;
function renderGroups(chatId, id) {
  const f = flows.get(id); if (!f) return;
  const pages = Math.ceil(f.groups.length / PAGE);
  f.page = Math.max(0, Math.min(f.page, pages - 1));
  const slice = f.groups.slice(f.page * PAGE, f.page * PAGE + PAGE);
  const kb = slice.map((g, i) => {
    const idx = f.page * PAGE + i;
    return [{ text: `${f.selected.has(idx) ? '✅' : '⬜'} ${g.subject.slice(0, 30)}`, callback_data: `g:t:${idx}` }];
  });
  kb.push([
    { text: '◀', callback_data: `g:p:${f.page - 1}` },
    { text: `${f.page + 1}/${pages}`, callback_data: 'g:n' },
    { text: '▶', callback_data: `g:p:${f.page + 1}` }
  ]);
  kb.push([{ text: 'Select all', callback_data: 'g:a' }, { text: 'Clear', callback_data: 'g:c' }]);
  kb.push([{ text: `Post to ${f.selected.size} group${f.selected.size === 1 ? '' : 's'}`, callback_data: 'g:go' }, { text: 'Cancel', callback_data: 'g:x' }]);
  const brand = getBrand(id);
  return edit(chatId, f.msgId,
    `<b>CHOOSE GROUPS</b>\n\nLink: ${H(f.link)}\n${f.caption ? `Caption: ${H(f.caption)}\n` : ''}${brand ? `Brand: ${H(brand)}\n` : ''}\n${f.groups.length} groups found. Tap to select.`, kb);
}

async function runPost(chatId, id) {
  const f = flows.get(id); const s = activeSessions.get(f?.sessionName);
  if (!f || !f.selected.size) return send(chatId, 'Select at least one group first.');
  if (!s?.online) return send(chatId, 'That session went offline. Try again.');
  flows.delete(id);
  const targets = [...f.selected].sort((a, b) => a - b).map(i => f.groups[i]);
  const brand = getBrand(id);
  await edit(chatId, f.msgId, `<b>POSTING</b>\n\nPreparing link preview...`);
  const pv = await buildPreview(f.link);
  const text = [f.caption, f.link, brand].filter(Boolean).join('\n\n');
  const ext = {
    text, font: 0, matchedText: f.link, canonicalUrl: f.link,
    ...(pv.title ? { title: pv.title } : {}),
    ...(pv.description ? { description: pv.description } : {}),
    ...(pv.thumb ? { jpegThumbnail: pv.thumb } : {})
  };
  const ok = [], fail = [];
  for (let i = 0; i < targets.length; i++) {
    const g = targets[i];
    await edit(chatId, f.msgId, `<b>POSTING</b>\n\n${i + 1}/${targets.length}: ${H(g.subject)}\n\nDone ${ok.length} | Failed ${fail.length}`);
    try { await postGroupStatus(s.conn, g.id, { ...ext, backgroundArgb: BG[Math.floor(Math.random() * BG.length)] }); ok.push(g); }
    catch (e) { fail.push(`${g.subject} (${e.message})`); }
    if (i < targets.length - 1) await sleep(POST_DELAY_MIN + Math.random() * Math.max(0, POST_DELAY_MAX - POST_DELAY_MIN));
  }
  return edit(chatId, f.msgId,
    `<b>DONE</b>\n\nPosted: ${ok.length}\nFailed: ${fail.length}` +
    (fail.length ? `\n\n${fail.slice(0, 8).map(x => '• ' + H(x)).join('\n')}` : ''),
    [[{ text: 'Share another', callback_data: 'm:gg' }, { text: 'Menu', callback_data: 'm:home' }]]);
}

// ---------------------------------------------------------------- admin
function adminKb() {
  return [
    [{ text: 'All sessions', callback_data: 'a:list' }, { text: 'Stats', callback_data: 'a:stats' }],
    [{ text: 'Block user', callback_data: 'a:block' }, { text: 'Unblock user', callback_data: 'a:unblock' }],
    [{ text: 'Blocked list', callback_data: 'a:blocked' }],
    [{ text: 'Wipe ALL sessions', callback_data: 'a:wipe' }],
    [{ text: 'Menu', callback_data: 'm:home' }]
  ];
}

async function adminBlock(chatId, idRaw, block) {
  const id = cleanNumber(idRaw);
  if (!id) return send(chatId, 'Send a numeric Telegram user id.');
  if (isAdmin(id)) return send(chatId, 'Admins cannot be blocked.');
  const list = new Set(blockedList());
  if (block) list.add(id); else list.delete(id);
  write(DB.blocked, [...list]);
  if (block) {
    send(id, 'You have been blocked from using this bot.');
    return send(chatId, `Blocked <code>${id}</code>.`,
      [[{ text: 'Also remove their sessions', callback_data: `a:kick:${id}` }, { text: 'Unblock', callback_data: `a:ub:${id}` }]]);
  }
  send(id, 'You can use this bot again.');
  return send(chatId, `Unblocked <code>${id}</code>.`, [[{ text: 'Admin', callback_data: 'm:admin' }]]);
}

async function kickUser(id) {
  const list = getUserSessions(id); for (const x of list) await removeSession(x.sessionName, id);
  return list.length;
}

async function wipeAll() {
  const db = paired(); let n = 0;
  for (const [tgId, list] of Object.entries(db)) {
    for (const x of list) { await removeSession(x.sessionName, tgId); n++; }
    send(tgId, 'An admin removed all sessions. Use /pair to link your number again.');
  }
  return n;
}

// ---------------------------------------------------------------- telegram wiring
async function gate(msg) {
  if (msg.chat.type !== 'private') return false;
  if (isBlocked(msg.from.id)) { send(msg.chat.id, 'You are blocked from using this bot.'); return false; }
  return true;
}
const cmd = (re, fn) => bot.onText(re, async (msg, m) => {
  try { if (!(await gate(msg))) return; awaiting.delete(String(msg.from.id)); await fn(msg, m); }
  catch (e) { console.error('[cmd]', e); }
});
const arg = m => (m[1] || '').trim();

cmd(/^\/start(?:@\w+)?(?:\s|$)/, msg => showHome(msg.chat.id, msg.from.id));
cmd(/^\/ping(?:@\w+)?(?:\s|$)/, msg => doPing(msg.chat.id));
cmd(/^\/uptime(?:@\w+)?(?:\s|$)/, msg => doUptime(msg.chat.id));
cmd(/^\/pair(?:@\w+)?(?:\s+([\s\S]+))?$/, (msg, m) => doPair(msg.chat.id, msg.from.id, arg(m)));
cmd(/^\/delpair(?:@\w+)?(?:\s+([\s\S]+))?$/, (msg, m) => doDelPanel(msg.chat.id, msg.from.id, arg(m)));
cmd(/^\/ggstatus(?:@\w+)?(?:\s+([\s\S]+))?$/, (msg, m) => startGG(msg.chat.id, msg.from.id, arg(m)));
cmd(/^\/block(?:@\w+)?(?:\s+(\d+))?$/, (msg, m) => isAdmin(msg.from.id) && adminBlock(msg.chat.id, arg(m), true));
cmd(/^\/unblock(?:@\w+)?(?:\s+(\d+))?$/, (msg, m) => isAdmin(msg.from.id) && adminBlock(msg.chat.id, arg(m), false));

// plain-text replies for flows that asked a question
bot.on('message', async msg => {
  try {
    if (!msg.text || msg.text.startsWith('/') || msg.chat.type !== 'private') return;
    if (!(await gate(msg))) return;
    const id = String(msg.from.id), st = awaiting.get(id);
    if (!st) return;
    awaiting.delete(id);
    if (st.type === 'pair') return doPair(msg.chat.id, id, msg.text);
    if (st.type === 'gglink') {
      if (!parseLink(msg.text)) { awaiting.set(id, st); return send(msg.chat.id, 'I could not find a link (it must start with http:// or https://). Send it again.'); }
      return startGG(msg.chat.id, id, msg.text);
    }
    if (st.type === 'brand') {
      const v = msg.text.trim();
      if (/^(off|none|clear)$/i.test(v)) { setBrand(id, ''); return send(msg.chat.id, 'Brand tag cleared.', backKb); }
      setBrand(id, v.slice(0, 80));
      return send(msg.chat.id, `Brand tag saved: ${H(v.slice(0, 80))}\nIt is added to the end of every status you share.`, backKb);
    }
    if (isAdmin(id) && st.type === 'block') return adminBlock(msg.chat.id, msg.text, true);
    if (isAdmin(id) && st.type === 'unblock') return adminBlock(msg.chat.id, msg.text, false);
  } catch (e) { console.error('[message]', e); }
});

bot.on('callback_query', async q => {
  const chatId = q.message?.chat.id, id = String(q.from.id), d = q.data || '';
  bot.answerCallbackQuery(q.id).catch(() => {});
  try {
    if (!chatId) return;
    if (isBlocked(id)) return send(chatId, 'You are blocked from using this bot.');
    if (d === 'x') { awaiting.delete(id); return edit(chatId, q.message.message_id, 'Cancelled.', backKb); }

    if (d.startsWith('m:')) {
      awaiting.delete(id);
      const k = d.slice(2);
      if (k === 'home') return showHome(chatId, id);
      if (k === 'gg') return startGG(chatId, id, '');
      if (k === 'pair') return doPair(chatId, id, '');
      if (k === 'del') return doDelPanel(chatId, id, '');
      if (k === 'ping') return doPing(chatId);
      if (k === 'up') return doUptime(chatId);
      if (k === 'brand') {
        awaiting.set(id, { type: 'brand' });
        const b = getBrand(id);
        return send(chatId, `<b>BRAND TAG</b>\n\nCurrent: ${b ? H(b) : 'none'}\n\nSend the text to add at the end of every status, or send <code>off</code> to remove it.`,
          [[{ text: 'Cancel', callback_data: 'x' }]]);
      }
      if (k === 'admin' && isAdmin(id)) return send(chatId, '<b>ADMIN</b>', adminKb());
      return;
    }

    if (d.startsWith('d:')) { // delete one of my sessions
      const name = d.slice(2);
      const mine = getUserSessions(id).find(x => x.sessionName === name);
      if (!mine) return send(chatId, 'Session not found.');
      await removeSession(name, id);
      return send(chatId, `Removed <code>+${H(mine.waNumber)}</code>.`, backKb);
    }

    if (d.startsWith('g:')) {
      const [, op, val] = d.split(':');
      if (op === 'x') { flows.delete(id); return edit(chatId, q.message.message_id, 'Cancelled.', backKb); }
      if (op === 's') {
        if (!getUserSessions(id).some(x => x.sessionName === d.slice(4))) return;
        return loadGroups(chatId, id, d.slice(4));
      }
      const f = flows.get(id);
      if (!f || !f.groups.length) return send(chatId, 'That selection expired. Start again with /ggstatus.');
      if (op === 'n') return;
      if (op === 't') { const i = Number(val); f.selected.has(i) ? f.selected.delete(i) : f.selected.add(i); return renderGroups(chatId, id); }
      if (op === 'p') { f.page = Number(val); return renderGroups(chatId, id); }
      if (op === 'a') { f.groups.forEach((_, i) => f.selected.add(i)); return renderGroups(chatId, id); }
      if (op === 'c') { f.selected.clear(); return renderGroups(chatId, id); }
      if (op === 'go') return runPost(chatId, id);
      return;
    }

    if (d.startsWith('a:') && isAdmin(id)) {
      const parts = d.split(':'), op = parts[1];
      if (op === 'stats') {
        const all = [...activeSessions.values()];
        return send(chatId, `<b>STATS</b>\n\nUsers with sessions: ${Object.keys(paired()).length}\nSessions: ${totalSessions()}/${MAX_SESSIONS}\nOnline: ${all.filter(s => s.online).length}\nBlocked users: ${blockedList().length}`, adminKb());
      }
      if (op === 'list') {
        const rows = Object.entries(paired()).flatMap(([tg, l]) => l.map(x =>
          `<code>${tg}</code> +${H(x.waNumber)} ${activeSessions.get(x.sessionName)?.online ? 'online' : 'offline'}`));
        return send(chatId, `<b>ALL SESSIONS</b>\n\n${rows.join('\n') || 'None.'}`, adminKb());
      }
      if (op === 'block') { awaiting.set(id, { type: 'block' }); return send(chatId, 'Send the Telegram user id to block.', [[{ text: 'Cancel', callback_data: 'x' }]]); }
      if (op === 'unblock') { awaiting.set(id, { type: 'unblock' }); return send(chatId, 'Send the Telegram user id to unblock.', [[{ text: 'Cancel', callback_data: 'x' }]]); }
      if (op === 'blocked') return send(chatId, `<b>BLOCKED</b>\n\n${blockedList().map(x => `<code>${x}</code>`).join('\n') || 'None.'}`, adminKb());
      if (op === 'ub') return adminBlock(chatId, parts[2], false);
      if (op === 'kick') { const n = await kickUser(parts[2]); return send(chatId, `Removed ${n} session(s) for <code>${H(parts[2])}</code>.`, adminKb()); }
      if (op === 'wipe') return send(chatId, `<b>WIPE ALL SESSIONS?</b>\n\nThis logs out and deletes all ${totalSessions()} sessions for every user. It cannot be undone.`,
        [[{ text: 'Yes, wipe everything', callback_data: 'a:wipeyes' }, { text: 'No', callback_data: 'm:admin' }]]);
      if (op === 'wipeyes') { const n = await wipeAll(); return send(chatId, `Wiped ${n} session(s).`, adminKb()); }
    }
  } catch (e) { console.error('[callback]', e); }
});

bot.on('polling_error', e => console.error('[polling]', e.code || '', e.message));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e?.message || e));

(async () => {
  console.log(`\n${BOT_NAME} online | admins: ${[...ADMIN_IDS].join(', ') || 'none set'}`);
  await reloadSessions();
})();
