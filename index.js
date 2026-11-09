'use strict';
/** TANIM ER WIFE - Discord Bot + Admin Dashboard | TYRONEX PRODUCTION */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const https = require('https');
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const { WebSocketServer, WebSocket } = require('ws');
const prism = require('prism-media');
const { PassThrough } = require('stream');
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField, Routes } = require('discord.js');
const PF = PermissionsBitField.Flags;
const {
  joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState,
  createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, EndBehaviorType,
  AudioPlayerStatus, VoiceConnectionDisconnectReason,
} = require('@discordjs/voice');

const PORT = process.env.PORT || 3000;
const HEAD_EMAIL = (process.env.HEAD_EMAIL || 'tyronex.tanim@tyronex.com').toLowerCase();
let HEAD_PASSWORD = process.env.HEAD_PASSWORD;
if (!HEAD_PASSWORD) {
  HEAD_PASSWORD = crypto.randomBytes(12).toString('base64url');
  console.warn('==========================================================');
  console.warn('[security] HEAD_PASSWORD is not set, so a random one was generated for this run.');
  console.warn(`[security] Head admin password: ${HEAD_PASSWORD}`);
  console.warn('[security] Set HEAD_PASSWORD in your environment to keep it stable across restarts.');
  console.warn('==========================================================');
}
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'admins.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------ Co-admin storage ------------------------- */
// Navigation tabs that can be given to a co-admin. The Voice AI settings tab and the Admins tab are head-only and are never assignable.
const NAV_TABS = [
  { id: 'chat', label: 'Live chat' }, { id: 'roles', label: 'Roles' }, { id: 'voice', label: 'Voice' },
  { id: 'sched', label: 'Schedule' }, { id: 'ai', label: 'AI' }, { id: 'logs', label: 'Logging' },
  { id: 'inbox', label: 'Inbox' }, { id: 'botprofile', label: 'Bot Profile' },
];
const NAV_IDS = NAV_TABS.map((t) => t.id);
let admins = [];
try { if (fs.existsSync(DATA_FILE)) admins = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
catch (e) { console.error('Could not read admins file:', e.message); }
if (!Array.isArray(admins)) admins = [];
/** Stage 2 sub-admins only had an email and a password. They are upgraded with NO server and NO tab access until the head admin edits them. */
admins = admins.filter((a) => a && typeof a.email === 'string' && a.salt && a.hash).map((a) => ({
  id: a.id || crypto.randomUUID(),
  name: String(a.name || a.email), phone: String(a.phone || ''), photoUrl: String(a.photoUrl || ''),
  email: a.email.trim().toLowerCase(),
  servers: Array.isArray(a.servers) ? a.servers.map(String) : [],
  tabs: Array.isArray(a.tabs) ? a.tabs.filter((t) => NAV_IDS.includes(t)) : [],
  salt: a.salt, hash: a.hash, createdAt: a.createdAt || Date.now(),
}));
function writeAdminsFile(list) { // atomic: a crash in the middle cannot leave a half-written file
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
try { if (fs.existsSync(DATA_FILE)) writeAdminsFile(admins); } catch (e) { console.error('Could not save admins file:', e.message); }
/** Save first, then switch the in-memory list: if the disk write fails nothing changes and the caller gets an error. */
function persistAdmins(next) {
  try { writeAdminsFile(next); }
  catch (e) { console.error('Could not save admins file:', e.message); throw httpErr(500, 'Could not save to storage. Nothing was changed.'); }
  admins = next;
}
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const DUMMY_SALT = crypto.randomBytes(16).toString('hex'); // login does the same hashing work for unknown emails
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* --------------------------------- Sessions ------------------------------ */
const sessions = new Map(); // token -> { id, email, role, exp }   (id = co-admin account id, 'head' for the head admin)
const SESSION_MS = 12 * 60 * 60 * 1000;
const subOf = (s) => (s && s.role === 'sub' ? admins.find((a) => a.id === s.id) || null : null); // the CURRENT co-admin record
const sessionFor = (t) => {
  const s = sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now() || (s.role === 'sub' && !subOf(s))) { sessions.delete(t); return null; } // expired, or the account no longer exists
  return s;
};
cron.schedule('*/10 * * * *', () => { for (const t of sessions.keys()) sessionFor(t); }); // purge expired
const loginTries = new Map();
const blocked = (ip) => {
  const list = (loginTries.get(ip) || []).filter((t) => Date.now() - t < 600000);
  loginTries.set(ip, list);
  return list.length >= 10;
};
const requireAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessionFor(token);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  req.admin = s; req.token = token; next();
};
const requireHead = (req, res, next) =>
  req.admin.role === 'head' ? next() : res.status(403).json({ error: 'Head admin only' });

/* ----------------------------- Access control ---------------------------- */
// The head admin may do everything. A co-admin is checked against the CURRENT account record on every request, every socket
// message and every broadcast. Nothing the browser sends (hidden tabs, ids, flags) is trusted.
const canGuild = (s, gid) => {
  if (!s) return false;
  if (s.role === 'head') return true;
  const a = subOf(s);
  return !!a && typeof gid !== 'object' && a.servers.includes(String(gid));
};
const canTab = (s, ...tabs) => {
  if (!s) return false;
  if (s.role === 'head') return true;
  const a = subOf(s);
  return !!a && tabs.some((t) => NAV_IDS.includes(t) && a.tabs.includes(t));
};
const deny = (res, msg) => res.status(403).json({ error: msg });
const requireTab = (...tabs) => (req, res, next) => (canTab(req.admin, ...tabs) ? next() : deny(res, 'You do not have access to this section.'));
const requireGuild = (req, res, next) => (canGuild(req.admin, req.params.gid) ? next() : deny(res, 'You do not have access to this server.'));
/** G = signed in + this server + one of these tabs (the server is checked before anything is looked up). T = signed in + one of these tabs. */
const G = (...tabs) => [requireAuth, requireGuild, requireTab(...tabs)];
const T = (...tabs) => [requireAuth, requireTab(...tabs)];

/* ------------------------------ App + Discord ---------------------------- */
let client = null; // created in startBot()
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy: use the real client IP
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  const f = [path.join(PUBLIC_DIR, 'index.html'), path.join(__dirname, 'index.html')].find((x) => fs.existsSync(x));
  return f ? res.sendFile(f) : res.status(404).send('index.html not found');
});
app.get('/health', (_req, res) => res.json({ ok: true, botReady: !!client?.isReady() }));

const httpErr = (status, message) => Object.assign(new Error(message), { status });
/** Turn well-known Discord API error codes into short, clear messages for the dashboard. */
const DISCORD_ERRORS = {
  10008: [404, 'That message no longer exists (it may have been deleted).'],
  10003: [404, 'That channel no longer exists.'],
  10014: [400, 'Discord does not know that emoji.'],
  50001: [403, 'The bot cannot access that channel (missing access).'],
  50013: [403, 'The bot is missing the permission needed for that action.'],
  50021: [400, 'Discord does not allow that action on a system message.'],
  90001: [403, 'Discord blocked that reaction (the author has blocked the bot).'],
  30010: [400, 'This message already has the maximum of 20 different reactions.'],
  // Stage 5B: direct messages
  50007: [403, 'Discord does not allow the bot to message this user. They may have blocked the bot, turned off DMs from server members, or share no server with the bot.'],
  10013: [404, 'Discord does not know this user any more (the account may have been deleted).'],
  40003: [429, 'Discord says DMs are being opened too quickly. Wait a little and try again.'],
  50278: [403, 'Discord does not allow the bot to message this user right now.'],
};
const mapDiscordErr = (e) => {
  const hit = e && typeof e.code === 'number' && DISCORD_ERRORS[e.code];
  return hit ? httpErr(hit[0], hit[1]) : e;
};
const wrap = (fn) => (req, res) => new Promise((resolve) => resolve(fn(req, res))).catch((raw) => { // also catches errors thrown synchronously, so the message always reaches the dashboard
  const e = mapDiscordErr(raw);
  console.error(`[${req.method} ${req.path}]`, raw && raw.message); // message only: never the error object (a Discord error can carry the request body = image data)
  const body = { error: e.message || 'Server error' };
  if (e.retryAfter) { body.retryAfter = e.retryAfter; res.set('Retry-After', String(e.retryAfter)); }
  res.status(e.status || 500).json(body);
});
const ensureReady = () => { if (!client?.isReady()) throw httpErr(503, bot.error || 'Bot is still connecting to Discord. Try again in a few seconds.'); };
async function getGuild(id) {
  ensureReady();
  try { return await client.guilds.fetch(id); } catch { throw httpErr(404, 'Server not found'); }
}
const getMe = async (guild) => guild.members.me || guild.members.fetchMe();
/** What the bot may do in one channel. Used for the channel list and re-checked on every action. */
function chanPerms(ch, me) {
  const p = ch.permissionsFor(me);
  const has = (f) => !!p && p.has(f);
  const canView = has(PF.ViewChannel);
  const canReadHistory = canView && has(PF.ReadMessageHistory);
  const canSend = canView && has(PF.SendMessages);
  return {
    canView, canReadHistory, canSend,
    canManageMessages: canView && has(PF.ManageMessages),
    canReact: canReadHistory && has(PF.AddReactions),
    canAttach: canSend && has(PF.AttachFiles),
    sendReason: !canView ? 'The bot cannot see this channel (missing View Channel).' : !canSend ? 'The bot cannot send messages here (missing Send Messages).' : null,
    readReason: !canView ? 'The bot cannot see this channel (missing View Channel).' : !canReadHistory ? 'The bot cannot read the history of this channel (missing Read Message History).' : null,
  };
}
async function getChannel(guild, id) {
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw httpErr(404, 'Channel not found');
  return ch;
}

/* ------------------------------ WebSocket (ws) --------------------------- */
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const sess = url.pathname === '/ws' ? sessionFor(token) : null;
  if (!sess) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.admin = sess; ws.token = token; wss.emit('connection', ws); });
});
/** A socket is trusted only while its own session still exists and, for a co-admin, the account still exists. */
const wsLive = (ws) => { const s = ws.admin; return !!s && sessions.get(ws.token) === s && s.exp > Date.now() && (s.role === 'head' || !!subOf(s)); };
function closeWs(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
  setTimeout(() => { try { ws.terminate(); } catch {} }, 1500).unref();
}
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
});
setInterval(() => wss.clients.forEach((ws) => {
  if (!wsLive(ws)) return closeWs(ws, 4401, 'Session ended');
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false; ws.ping();
}), 30000);

/** Which tab(s) an event belongs to. An event type that is not listed here goes to the head admin only (fail closed). */
const EVENT_TABS = {
  message: ['chat'], messageDelete: ['chat'], reactions: ['chat'], perms: ['chat', 'voice', 'sched'],
  voice: ['voice'], 'voice:error': ['voice'], voiceFiles: ['voice'],
  'log:voice': ['logs'], 'log:messages': ['logs'],
  'inbox:autoreply': ['inbox'], // Stage 5B: auto-reply settings / status, same rule as the DM content itself
  'botprofile:changed': ['botprofile'], // Stage 6A: carries only the server id + field name, never image data
  'inbox:message': ['inbox'], 'inbox:read': ['inbox'], // Stage 5A: DM content goes only to accounts that still have the Inbox tab (not tied to a server)
};
const GUILD_EVENTS = new Set(['message', 'messageDelete', 'reactions', 'perms', 'voice', 'voice:error', 'log:voice', 'log:messages', 'botprofile:changed']); // these must carry an allowed guildId
const LOG_EVENTS = new Set(['log:voice', 'log:messages']);
const PUBLIC_EVENTS = new Set(['guilds']); // carries no data; browsers just re-read their own (filtered) server list
function wsMayReceive(ws, type, data) {
  if (ws.readyState !== 1 || !wsLive(ws)) return false;
  if (LOG_EVENTS.has(type)) return !!ws.logGuild && ws.logGuild === String(data?.guildId) && canTab(ws.admin, 'logs') && canGuild(ws.admin, data?.guildId); // logging data: only to a socket that subscribed to this server AND still has access (head included)
  if (ws.admin.role === 'head' || PUBLIC_EVENTS.has(type)) return true;
  const tabs = EVENT_TABS[type];
  if (!tabs || !canTab(ws.admin, ...tabs)) return false;
  if (GUILD_EVENTS.has(type) && !canGuild(ws.admin, data?.guildId)) return false;
  return true;
}
const broadcast = (type, data) => {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((ws) => { if (wsMayReceive(ws, type, data)) ws.send(msg); });
};

const broadcastHead = (type, data) => {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((ws) => { if (ws.readyState === 1 && ws.admin?.role === 'head' && wsLive(ws)) ws.send(msg); });
};
const wsSendJson = (ws, type, data) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
/** End every session of a co-admin and close all of its sockets at once (account deleted or password reset). */
function kickAccount(id, reason) {
  for (const [t, s] of sessions) if (s.role === 'sub' && s.id === id) sessions.delete(t);
  wss.clients.forEach((ws) => { if (ws.admin?.role === 'sub' && ws.admin.id === id) closeWs(ws, 4401, reason); });
}
/** Access was edited: drop what the account may no longer use and tell its browsers to reload their view. */
function refreshWsAccess(id) {
  wss.clients.forEach((ws) => {
    if (ws.admin?.role !== 'sub' || ws.admin.id !== id) return;
    const voiceOk = (g) => canGuild(ws.admin, g) && canTab(ws.admin, 'voice');
    if (ws.listenGuild && !voiceOk(ws.listenGuild)) ws.listenGuild = null;
    if (ws.micGuild && !voiceOk(ws.micGuild)) ws.micGuild = null;
    if (ws.logGuild && !(canGuild(ws.admin, ws.logGuild) && canTab(ws.admin, 'logs'))) ws.logGuild = null;
    wsSendJson(ws, 'access:changed', {});
  });
}

/* --------------------------------- Auth API ------------------------------ */
app.post('/api/login', wrap((req, res) => {
  if (blocked(req.ip)) throw httpErr(429, 'Too many attempts. Try again in 10 minutes.');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  let role = null, acct = null;
  if (password.length <= 200 && safeEq(email, HEAD_EMAIL) && safeEq(password, HEAD_PASSWORD)) role = 'head';
  else if (password.length <= 200) {
    const a = admins.find((x) => x.email === email);
    const h = hashPw(password, a ? a.salt : DUMMY_SALT).hash; // same work for unknown emails, so timing does not reveal which emails exist
    if (a && safeEq(h, a.hash)) { role = 'sub'; acct = a; }
  }
  if (!role) { loginTries.get(req.ip).push(Date.now()); throw httpErr(401, 'Wrong email or password'); }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { id: acct ? acct.id : 'head', email, role, exp: Date.now() + SESSION_MS });
  res.json({ token, email, role });
}));
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});
/** Own profile. A co-admin's phone number is never included: only the head admin ever sees it. */
function meOf(s) {
  if (s.role === 'head') return { email: s.email, role: 'head', name: 'Head admin', photoUrl: null, tabs: [...NAV_IDS, 'vai', 'admins'] };
  const a = subOf(s);
  return { email: a.email, role: 'sub', name: a.name, photoUrl: a.photoUrl || null, tabs: a.tabs.slice() };
}
app.get('/api/me', requireAuth, (req, res) => res.json(meOf(req.admin)));

/* ------------------------------ Co-admins API (head only) ---------------- */
const bad = (m) => httpErr(400, m);
const vName = (v) => {
  const n = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (n.length < 2 || n.length > 80) throw bad('Real name is required (2 to 80 characters).');
  return n;
};
const vPhone = (v) => {
  const p = typeof v === 'string' ? v.trim() : '';
  const digits = p.replace(/\D/g, '');
  if (!p) throw bad('Phone number is required.');
  if (!/^\+?[0-9][0-9 ()\-]{4,24}$/.test(p) || digits.length < 7 || digits.length > 15) throw bad('Enter a valid phone number (7 to 15 digits, for example +8801XXXXXXXXX).');
  return p;
};
const PHOTO_RE = /^https:\/\/i\.postimg\.cc\/[A-Za-z0-9._~%()\-]+(?:\/[A-Za-z0-9._~%()\-]+)*$/;
const vPhoto = (v) => {
  const u = typeof v === 'string' ? v.trim() : '';
  if (!u) throw bad('Photo URL is required.');
  if (u.length > 300 || !PHOTO_RE.test(u) || u.split('/').slice(3).some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) throw bad('Photo URL must be an HTTPS link that starts with https://i.postimg.cc/');
  return u;
};
const vEmail = (v) => {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!e) throw bad('Email is required.');
  if (e.length > 254 || !/^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]{2,}$/.test(e)) throw bad('Enter a valid email address.');
  return e;
};
const vPassword = (v) => {
  if (typeof v !== 'string' || v.length < 8) throw bad('Password must be at least 8 characters.');
  if (v.length > 200) throw bad('Password is too long (200 characters at most).');
  return v;
};
/** Only servers where the bot is a member can be assigned. Servers already assigned are kept even if the bot has left them since. */
const vServers = (v, existing = []) => {
  if (!Array.isArray(v) || !v.length) throw bad('Choose at least one server.');
  const ids = [...new Set(v.map(String))];
  if (ids.length > 200 || ids.some((id) => !/^\d{5,25}$/.test(id))) throw bad('Bad server selection.');
  const fresh = ids.filter((id) => !existing.includes(id));
  if (fresh.length) {
    if (!client?.isReady()) throw httpErr(503, 'The bot is still connecting to Discord, so servers cannot be checked yet. Try again in a few seconds.');
    if (fresh.some((id) => !client.guilds.cache.has(id))) throw bad('The bot is not a member of one of the selected servers.');
  }
  return ids;
};
const vTabs = (v) => {
  if (!Array.isArray(v) || !v.length) throw bad('Choose at least one navigation tab.');
  const ids = [...new Set(v.map(String))];
  if (ids.some((t) => !NAV_IDS.includes(t))) throw bad('Unknown navigation tab.');
  return NAV_IDS.filter((t) => ids.includes(t));
};
const guildBrief = (id) => { const g = client?.isReady() ? client.guilds.cache.get(id) : null; return { id, name: g ? g.name : null, icon: g ? g.iconURL({ size: 64 }) : null }; };
const adminView = (a) => ({ id: a.id, name: a.name, phone: a.phone, email: a.email, photoUrl: a.photoUrl || null,
  servers: a.servers.map(guildBrief), tabs: a.tabs.slice(), createdAt: a.createdAt });
const adminById = (id) => {
  const a = typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? admins.find((x) => x.id === id) : null;
  if (a) return a;
  if (String(id).toLowerCase() === HEAD_EMAIL || id === 'head') throw httpErr(403, 'The head admin cannot be changed or deleted here.');
  throw httpErr(404, 'Co-admin not found.');
};
app.get('/api/admins', requireAuth, requireHead, (_req, res) => res.json({
  admins: admins.map(adminView), tabs: NAV_TABS, botReady: !!client?.isReady(),
  servers: client?.isReady() ? [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) })) : [],
}));
app.post('/api/admins', requireAuth, requireHead, wrap((req, res) => {
  const b = req.body || {};
  const rec = { name: vName(b.name), phone: vPhone(b.phone), servers: vServers(b.servers), tabs: vTabs(b.tabs), photoUrl: vPhoto(b.photoUrl), email: vEmail(b.email) };
  const password = vPassword(b.password);
  if (rec.email === HEAD_EMAIL || admins.some((a) => a.email === rec.email)) throw httpErr(409, 'That email is already used by another account.');
  const a = { id: crypto.randomUUID(), ...rec, ...hashPw(password), createdAt: Date.now() };
  persistAdmins([...admins, a]);
  console.log(`[co-admin] ${req.admin.email} created ${a.email}`);
  res.json(adminView(a));
}));
app.put('/api/admins/:id', requireAuth, requireHead, wrap((req, res) => {
  const a = adminById(req.params.id), b = req.body || {};
  const next = { ...a };
  if ('name' in b) next.name = vName(b.name);
  if ('phone' in b) next.phone = vPhone(b.phone);
  if ('photoUrl' in b) next.photoUrl = vPhoto(b.photoUrl);
  if ('servers' in b) next.servers = vServers(b.servers, a.servers);
  if ('tabs' in b) next.tabs = vTabs(b.tabs);
  persistAdmins(admins.map((x) => (x === a ? next : x)));
  refreshWsAccess(a.id); // the new rules already apply to the next request; open sockets are cleaned up and told to reload
  console.log(`[co-admin] ${req.admin.email} edited ${a.email}`);
  res.json(adminView(next));
}));
app.post('/api/admins/:id/password', requireAuth, requireHead, wrap((req, res) => {
  const a = adminById(req.params.id);
  const password = vPassword((req.body || {}).password);
  persistAdmins(admins.map((x) => (x === a ? { ...a, ...hashPw(password) } : x)));
  kickAccount(a.id, 'Password was reset'); // everything that was signed in with the old password is ended
  console.log(`[co-admin] ${req.admin.email} reset the password of ${a.email}`);
  res.json({ ok: true });
}));
app.delete('/api/admins/:id', requireAuth, requireHead, wrap((req, res) => {
  const a = adminById(req.params.id); // the head admin is not in this list and can never be deleted
  if (a.email === HEAD_EMAIL) throw httpErr(403, 'The head admin cannot be deleted.');
  persistAdmins(admins.filter((x) => x !== a)); // 1. removed from persistent storage (nothing changes if this fails)
  kickAccount(a.id, 'Account deleted'); //          2. sessions invalidated, 3. every open socket closed
  delete store.favorites[a.email]; delete store.rolePins[a.email]; saveStore(); // 4. favorites and role pins removed
  console.log(`[co-admin] ${req.admin.email} deleted ${a.email}`);
  res.json({ ok: true });
}));

/* --------------------------------- Status -------------------------------- */
app.get('/api/status', requireAuth, (req, res) => res.json({
  status: client?.isReady() ? 'online' : bot.status === 'online' ? 'starting' : bot.status,
  error: bot.error, degraded: bot.degraded, servers: client?.isReady() ? [...client.guilds.cache.keys()].filter((id) => canGuild(req.admin, id)).length : 0, // only the servers this account may see
}));

/* --------------------------------- Guilds -------------------------------- */
app.get('/api/guilds', requireAuth, wrap(async (req, res) => {
  ensureReady();
  const fetched = await client.guilds.fetch(); // fresh from the API, not the cache
  res.json([...fetched.values()].filter((g) => canGuild(req.admin, g.id)) // a co-admin never sees a server that was not assigned
    .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) })));
}));
app.get('/api/guilds/:gid/channels', ...G('chat', 'voice', 'sched'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const all = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const kind = (c) => ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type) ? 'text'
    : [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type) ? 'voice' : null);
  const order = (a, b) => (kind(a) === 'voice') - (kind(b) === 'voice') || a.rawPosition - b.rawPosition;
  const cats = all.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition);
  const chans = all.filter(kind);
  const me = await getMe(guild);
  const mk = (c) => ({ id: c.id, name: c.name, kind: kind(c), ...chanPerms(c, me) });
  const groups = cats.map((k) => ({ id: k.id, name: k.name, channels: chans.filter((c) => c.parentId === k.id).sort(order).map(mk) })).filter((g) => g.channels.length);
  const loose = chans.filter((c) => !cats.some((k) => k.id === c.parentId)).sort(order).map(mk);
  if (loose.length) groups.unshift({ id: 'none', name: 'No category', channels: loose });
  res.json({ groups, botId: client.user.id });
}));

/* -------------------------------- Messages ------------------------------- */
function mentionRefs(m) { // resolve <@id>, <@&id>, <#id> to readable names for the dashboard
  const refs = { users: {}, roles: {}, channels: {} };
  const c = m.content || '';
  for (const [, id] of c.matchAll(/<@!?(\d+)>/g)) {
    const u = m.mentions?.users?.get(id);
    refs.users[id] = m.mentions?.members?.get(id)?.displayName || m.guild?.members.cache.get(id)?.displayName || u?.globalName || u?.username || 'unknown-user';
  }
  for (const [, id] of c.matchAll(/<@&(\d+)>/g)) {
    const r = m.guild?.roles.cache.get(id);
    refs.roles[id] = { name: r?.name || 'deleted-role', color: r && r.hexColor !== '#000000' ? r.hexColor : null };
  }
  for (const [, id] of c.matchAll(/<#(\d+)>/g)) refs.channels[id] = m.guild?.channels.cache.get(id)?.name || 'unknown-channel';
  return refs;
}
const clipSnippet = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 150).replace(/<[@#][^>]*$/, '').trim();
const serializeReactions = (m) => [...(m.reactions?.cache?.values() || [])]
  .filter((r) => r.emoji?.name && (r.count ?? 0) > 0)
  .map((r) => ({ key: r.emoji.id || r.emoji.name, name: r.emoji.name, id: r.emoji.id || null, animated: !!r.emoji.animated, count: r.count, me: !!r.me }));
const authorOf = (m) => ({
  id: m.author?.id, username: m.author?.username,
  name: m.member?.displayName || m.author?.username || 'Unknown',
  avatar: m.member?.displayAvatarURL({ size: 64 }) || m.author?.displayAvatarURL({ size: 64 }),
  color: m.member?.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : null,
  bot: !!m.author?.bot,
});
/** The message this one replies to. A deleted or unreachable original gives { unavailable: true }. */
async function resolveReply(m, memo) {
  const id = m.reference?.messageId;
  if (!id || (m.reference.channelId && m.reference.channelId !== m.channelId)) return null;
  if (!memo.has(id)) {
    memo.set(id, (async () => {
      const cached = m.channel?.messages?.cache.get(id);
      if (cached && !cached.partial) return cached;
      try { return await m.channel.messages.fetch(id); } catch { return null; }
    })());
  }
  const ref = await memo.get(id);
  if (!ref) return { id, unavailable: true };
  const a = authorOf(ref);
  return { id, unavailable: false, author: { name: a.name, avatar: a.avatar, color: a.color, bot: a.bot },
    content: clipSnippet(ref.content), hasAttachments: ref.attachments.size > 0, refs: mentionRefs(ref) };
}
async function serializeMsg(m, memo = new Map()) {
  return {
    id: m.id, channelId: m.channelId, content: m.content, createdAt: m.createdTimestamp,
    author: authorOf(m),
    attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, type: a.contentType || '' })),
    refs: mentionRefs(m),
    reply: await resolveReply(m, memo),
    reactions: serializeReactions(m),
  };
}
async function requireChan(req, need) { // need: 'read' | 'send'
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, req.params.cid);
  if (!ch.isTextBased()) throw httpErr(400, 'That is not a text channel');
  const me = await getMe(guild);
  const perms = chanPerms(ch, me);
  if (need === 'read' && perms.readReason) throw httpErr(403, perms.readReason);
  if (need === 'send' && perms.sendReason) throw httpErr(403, perms.sendReason);
  return { guild, ch, me, perms };
}
app.get('/api/guilds/:gid/channels/:cid/messages', ...G('chat'), wrap(async (req, res) => {
  const { ch } = await requireChan(req, 'read');
  const msgs = await ch.messages.fetch({ limit: 50 });
  const memo = new Map();
  res.json(await Promise.all([...msgs.values()].reverse().map((m) => serializeMsg(m, memo))));
}));
app.post('/api/guilds/:gid/channels/:cid/messages', ...G('chat'), upload.array('files', 10), wrap(async (req, res) => {
  const { ch, perms } = await requireChan(req, 'send'); // permissions are enforced here, not only in the UI
  const content = String(req.body.content || '').slice(0, 2000);
  const files = (req.files || []).map((f) => ({ attachment: f.buffer, name: f.originalname }));
  if (!content.trim() && !files.length) throw httpErr(400, 'Write a message or attach a file');
  if (files.length && !perms.canAttach) throw httpErr(403, 'The bot cannot upload files here (missing Attach Files).');
  const payload = { content: content || undefined, files };
  let replyNote = null;
  const replyTo = String(req.body.replyTo || '').trim();
  if (replyTo) {
    if (!/^\d{5,25}$/.test(replyTo)) throw httpErr(400, 'Bad reply target');
    if (!perms.canReadHistory) throw httpErr(403, 'The bot needs Read Message History to reply to a message.');
    const target = await ch.messages.fetch(replyTo).catch(() => null);
    if (target) { // a real Discord reply (message reference); no extra ping for the replied-to author
      payload.reply = { messageReference: replyTo, failIfNotExists: false };
      payload.allowedMentions = { parse: ['users', 'roles', 'everyone'], repliedUser: false };
    } else replyNote = 'The message you replied to was deleted, so this was sent as a normal message.';
  }
  const sent = await ch.send(payload);
  res.json({ ...(await serializeMsg(sent)), replyNote });
}));

/** Delete: any message with Manage Messages, otherwise only the bot's own messages. */
app.delete('/api/guilds/:gid/channels/:cid/messages/:mid', ...G('chat'), wrap(async (req, res) => {
  const { ch, perms } = await requireChan(req, 'read');
  const msg = await ch.messages.fetch({ message: req.params.mid, force: true }).catch(() => null);
  if (!msg) throw httpErr(404, 'That message no longer exists (it may already be deleted).');
  const own = msg.author?.id === client.user.id;
  if (!own && !perms.canManageMessages) throw httpErr(403, 'The bot can only delete its own messages here. Give it the Manage Messages permission to delete other messages.');
  await msg.delete();
  broadcast('messageDelete', { guildId: ch.guildId, channelId: ch.id, id: msg.id });
  console.log(`[delete] ${req.admin.email} deleted message ${msg.id} in #${ch.name}`);
  res.json({ ok: true });
}));

/* ---------------------------------- Roles -------------------------------- */
app.get('/api/guilds/:gid/roles', ...G('chat', 'roles'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const roles = await guild.roles.fetch();
  const me = guild.members.me || await guild.members.fetchMe();
  res.json([...roles.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id, name: r.name, color: r.hexColor,
      assignable: !r.managed && r.position < me.roles.highest.position,
    })));
}));
app.get('/api/guilds/:gid/members', ...G('chat', 'roles'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const q = String(req.query.q || '').trim();
  const list = q ? await guild.members.search({ query: q, limit: 50 }) : await guild.members.fetch({ limit: 100 });
  res.json([...list.values()].map((m) => ({
    id: m.id, name: m.displayName, username: m.user.username, bot: m.user.bot,
    avatar: m.user.displayAvatarURL({ size: 64 }),
    roles: [...m.roles.cache.keys()].filter((r) => r !== guild.id),
  })));
}));
async function changeRole(req, res, add) {
  const guild = await getGuild(req.params.gid);
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) throw httpErr(403, 'The bot needs the Manage Roles permission');
  const member = await guild.members.fetch(req.params.uid);
  const reason = `Dashboard: ${req.admin.email}`;
  try {
    if (add) await member.roles.add(req.params.rid, reason); else await member.roles.remove(req.params.rid, reason);
  } catch (e) { throw httpErr(403, 'Cannot change that role. Move the bot’s role above it.'); }
  res.json({ ok: true, message: `${add ? 'Added role to' : 'Removed role from'} ${member.displayName}` });
}
app.post('/api/guilds/:gid/members/:uid/roles/:rid', ...G('roles'), wrap((req, res) => changeRole(req, res, true)));
app.delete('/api/guilds/:gid/members/:uid/roles/:rid', ...G('roles'), wrap((req, res) => changeRole(req, res, false)));

/* ---------------------------------- Voice -------------------------------- */
function voiceInfo(guild) {
  const conn = getVoiceConnection(guild.id);
  const chId = conn?.joinConfig?.channelId || null;
  const ch = chId ? guild.channels.cache.get(chId) : null;
  return {
    connected: !!(conn && ch), reconnecting: !!(vstate.get(guild.id)?.wantRejoin && !(conn && ch)),
    channelId: ch?.id || null, channelName: ch?.name || null,
    file: (() => { const f = vstate.get(guild.id)?.file; return f ? { id: f.id, name: f.name, loop: f.loop, volume: f.volume } : null; })(),
    members: ch ? [...ch.members.values()].map((m) => ({
      id: m.id, name: m.displayName, bot: m.user.bot, avatar: m.user.displayAvatarURL({ size: 64 }),
      muted: !!(m.voice.mute || m.voice.selfMute), deafened: !!(m.voice.deaf || m.voice.selfDeaf),
    })) : [],
  };
}
const pushVoice = (guild) => broadcast('voice', { guildId: guild.id, ...voiceInfo(guild) });
app.get('/api/guilds/:gid/voice', ...G('voice'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  await guild.channels.fetch();
  res.json(voiceInfo(guild));
}));
/* ----------------------- Voice join / live audio -------------------------- */
const vstate = new Map(); // guildId -> { player, pcm, ids, active, channelId, wantRejoin, ... }
const FRAME_BATCH = 3840 * 3; // 3 x 20 ms Opus frames = about 60 ms of 48 kHz stereo PCM

/** Lazily (re)arm the player: if it went idle or the stream died, start a fresh resource. */
function sinkOf(st) {
  if (!st.pcm || st.pcm.destroyed || st.pcm.writableEnded || st.player.state.status === AudioPlayerStatus.Idle) {
    try { st.pcm?.destroy(); } catch {}
    st.pcm = new PassThrough();
    st.pcm.on('error', () => {});
    st.player.play(createAudioResource(st.pcm, { inputType: StreamType.Raw }));
  }
  return st.pcm;
}
const MIC_MAX_QUEUE = 192000 * 0.6; // browser mic: never queue more than ~0.6 s, or a burst becomes permanent delay
function writeVoicePcm(st, buf, maxQueue = 2e6) { if (st.file) return; const s = sinkOf(st); if (s.writableLength < maxQueue) s.write(buf); } // Voice AI audio arrives faster than real time, so it keeps the big cap
function flushVoicePcm(st) { if (st.file) return; try { st.pcm?.destroy(); } catch {} st.pcm = null; try { st.player.stop(true); } catch {} }
function dropVoice(gid) {
  const st = vstate.get(gid);
  if (!st) return;
  st.wantRejoin = false;
  stopFile(st); vaiDspCancel(gid);
  try { st.player.stop(true); st.pcm?.destroy(); } catch {}
  vstate.delete(gid);
}
const sendListen = (gid, frame) => wss.clients.forEach((w) => { // re-checked for every frame: a revoked co-admin stops hearing at once
  if (w.readyState === 1 && w.listenGuild === gid && w.bufferedAmount < 1e6 && wsLive(w) && canGuild(w.admin, gid) && canTab(w.admin, 'voice')) w.send(frame, { binary: true });
});

function onSpeak(guild, st, conn, uid) {
  if (uid === client.user.id) return;
  const since = st.active.get(uid);
  if (since && Date.now() - since < 60000) return;
  if (![...wss.clients].some((w) => w.listenGuild === guild.id)) return;
  st.active.set(uid, Date.now());
  if (!st.ids.has(uid)) st.ids.set(uid, st.ids.size + 1);
  const hdr = Buffer.alloc(4); hdr.writeUInt32LE(st.ids.get(uid));
  const opus = conn.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 400 } });
  const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  let acc = [], len = 0, tailTimer = null;
  const flush = () => { clearTimeout(tailTimer); if (len) { sendListen(guild.id, Buffer.concat([hdr, ...acc])); acc = []; len = 0; } };
  const done = () => { flush(); st.active.delete(uid); try { opus.destroy(); } catch {} try { dec.destroy(); } catch {} };
  opus.on('error', done); dec.on('error', done); dec.on('end', done);
  opus.pipe(dec);
  dec.on('data', (chunk) => {
    acc.push(chunk); len += chunk.length;
    if (len >= FRAME_BATCH) flush(); // ~60 ms batches
    else { clearTimeout(tailTimer); tailTimer = setTimeout(flush, 40); } // a short tail is sent after 40 ms, not after the 400 ms silence timeout
  });
}
/** (Re)attach the player and the receiver to a connection. Safe to call after every reconnect. */
function wireVoice(guild, st, conn) {
  try { conn.subscribe(st.player); } catch (e) { console.warn('[voice] subscribe failed:', e.message); }
  if (st.rxConn === conn) return;
  st.rxConn = conn; st.active.clear(); vaiDspCancel(guild.id);
  conn.receiver.speaking.on('start', (uid) => onSpeak(guild, st, conn, uid));
  conn.receiver.speaking.on('start', (uid) => { try { onSpeakAI(guild, st, conn, uid); } catch (e) { console.warn('[voice-ai] discord listen:', e.message); } });
}
async function onDisconnected(guild, conn, newState) {
  const st = vstate.get(guild.id);
  if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
    // 4014 = moved to another channel (the library reconnects) or kicked/channel deleted (it does not).
    try { await entersState(conn, VoiceConnectionStatus.Connecting, 5000); return; } catch { /* kicked */ }
    console.warn(`[voice] ${guild.name}: disconnected with close code 4014. Not rejoining.`);
    if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    dropVoice(guild.id); pushVoice(guild);
    return;
  }
  try { // transient problem: give the library a few seconds to reconnect on its own
    await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
  } catch {
    if (st?.wantRejoin && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy(); // the watchdog rejoins
  }
}
async function connectVoice(guild, channelId) {
  getVoiceConnection(guild.id)?.destroy();
  const conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
  conn.on('error', (e) => console.warn('[voice] connection error:', e.message));
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); }
  catch { try { conn.destroy(); } catch {} throw new Error('Could not connect. Check the bot’s Connect permission for that channel.'); }
  conn.on(VoiceConnectionStatus.Disconnected, (_old, next) => onDisconnected(guild, conn, next).catch(() => {}));
  conn.on(VoiceConnectionStatus.Ready, () => { // rewire after any internal reconnect
    const st = vstate.get(guild.id);
    if (st && st.wantRejoin) { wireVoice(guild, st, conn); st.badSince = 0; pushVoice(guild); }
  });
  return conn;
}
async function rejoinVoice(guild, st) {
  st.rejoining = true;
  try {
    if (!guild.channels.cache.has(st.channelId)) { console.warn('[voice] channel no longer exists. Not rejoining.'); dropVoice(guild.id); pushVoice(guild); return; }
    console.warn(`[voice] ${guild.name}: rejoining`);
    const conn = await connectVoice(guild, st.channelId);
    wireVoice(guild, st, conn); st.badSince = 0; st.fails = 0; pushVoice(guild);
  } catch (e) {
    st.fails = (st.fails || 0) + 1;
    console.warn(`[voice] rejoin failed (${st.fails}):`, e.message);
    if (st.fails >= 20) { console.warn('[voice] giving up after 20 failed rejoins'); dropVoice(guild.id); pushVoice(guild); }
  } finally { st.rejoining = false; }
}
async function watchdogTick(gid, st) { // runs every 15 s
  if (!st.wantRejoin || st.rejoining || !client?.isReady()) return;
  const guild = client.guilds.cache.get(gid);
  if (!guild) return;
  const conn = getVoiceConnection(gid);
  if (conn && conn.state.status === VoiceConnectionStatus.Ready) {
    st.badSince = 0;
    const cur = guild.members.me?.voice?.channelId;
    if (cur && cur !== st.channelId) st.channelId = cur; // an admin moved the bot
    if (conn.state.subscription?.player !== st.player) conn.subscribe(st.player); // rewire if the subscription got lost
    return;
  }
  st.badSince ||= Date.now();
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed && Date.now() - st.badSince < 20000) return; // still recovering
  await rejoinVoice(guild, st);
}
setInterval(() => { for (const [gid, st] of vstate) watchdogTick(gid, st).catch((e) => console.warn('[voice] watchdog:', e.message)); }, 15000);

const isHead = (ws) => ws.admin?.role === 'head';
wss.on('connection', (ws) => {
  ws.on('close', () => { if (typeof vaiEndTurn === 'function') vaiEndTurn(ws); });
  ws.on('message', (data, isBinary) => {
    if (!wsLive(ws)) return closeWs(ws, 4401, 'Session ended'); // the session or the account is gone
    if (isBinary) {
      if (ws.vaiSpeaking) { vaiSendAudio(data); return; } // Voice AI: Int16 mono 16 kHz
      if (!ws.micGuild || !canTab(ws.admin, 'voice') || !canGuild(ws.admin, ws.micGuild)) { ws.micGuild = null; return; } // access may have been revoked after the mic was switched on
      const st = vstate.get(ws.micGuild); // browser mic: Int16 mono 48 kHz -> stereo into the voice player
      if (!st || data.length < 2) return;
      if (st.file) { const t = Date.now(); if (t - (ws.micBusyAt || 0) > 5000) { ws.micBusyAt = t; wsSendJson(ws, 'mic:busy', { msg: 'An audio file is playing in Discord, so your microphone is not being sent.' }); } return; }
      const nowMs = Date.now(); // two browsers mixing raw PCM into one stream would garble both: one talker at a time
      if (st.micOwner && st.micOwner !== ws && st.micOwner.readyState === 1 && nowMs - st.micAt < 600) {
        if (nowMs - (ws.micBusyAt || 0) > 5000) { ws.micBusyAt = nowMs; wsSendJson(ws, 'mic:busy', { msg: 'Another admin is talking into the voice channel. Your mic is not being sent.' }); }
        return;
      }
      st.micOwner = ws; st.micAt = nowMs;
      const mono = Buffer.from(data), n = mono.length >> 1, out = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        const lo = mono[i * 2], hi = mono[i * 2 + 1];
        out[i * 4] = lo; out[i * 4 + 1] = hi; out[i * 4 + 2] = lo; out[i * 4 + 3] = hi;
      }
      writeVoicePcm(st, out, MIC_MAX_QUEUE);
      return;
    }
    try {
      const m = JSON.parse(data.toString());
      const refuse = (msg) => wsSendJson(ws, 'ws:denied', { t: m.t, msg });
      if (m.t === 'listen' || m.t === 'mic') {
        const key = m.t === 'listen' ? 'listenGuild' : 'micGuild';
        if (!m.on) ws[key] = null;
        else if (!canTab(ws.admin, 'voice')) refuse('You do not have access to the Voice section.');
        else if (!canGuild(ws.admin, m.g)) refuse('You do not have access to that server.');
        else ws[key] = String(m.g);
      } else if (m.t === 'logs') { // subscribe to / leave live logging events of ONE server
        if (!m.on) ws.logGuild = null;
        else if (!canTab(ws.admin, 'logs')) refuse('You do not have access to the Logging section.');
        else if (typeof m.g !== 'string' || !canGuild(ws.admin, m.g)) refuse('You do not have access to that server.');
        else ws.logGuild = m.g;
      } else if (m.t === 'inbox') { // Stage 5A: every Inbox action re-checks the account's CURRENT access
        if (!canTab(ws.admin, 'inbox')) refuse('You do not have access to the Inbox section.');
        else if (m.a === 'read' && SNOWFLAKE.test(String(m.u))) { if (!inboxMarkRead(String(m.u))) refuse('Conversation not found.'); }
        else if (m.a === 'summary') wsSendJson(ws, 'inbox:summary', inboxSummary());
        else if (m.a === 'autoreply') wsSendJson(ws, 'inbox:autoreply', arView()); // Stage 5B: read-only; changing settings and sending go through the HTTP routes
        else refuse('Unknown Inbox action.');
      } else if (m.t === 'botprofile') { // Stage 6A: read-only over the socket; every change goes through the HTTP routes. Access is re-checked here and again after the Discord call
        if (!canTab(ws.admin, 'botprofile')) refuse('You do not have access to the Bot Profile section.');
        else if (typeof m.g !== 'string' || !SNOWFLAKE.test(m.g) || !canGuild(ws.admin, m.g)) refuse('You do not have access to that server.');
        else if (m.a === 'get') bpSendTo(ws, m.g, refuse);
        else refuse('Unknown Bot Profile action.');
      } else if (m.t === 'vai') { if (isHead(ws)) vaiControl(ws, m); else refuse('Only the head admin can use Voice AI.'); }
    } catch {}
  });
});
/** Join (or move to) a voice channel with a fresh player. Shared by the Join button and file playback. */
async function joinGuildVoice(guild, ch) {
  dropVoice(guild.id);
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  player.on('error', (e) => { // the next write re-arms the player
    console.warn('[voice] player error:', e.message);
    const s2 = vstate.get(guild.id);
    if (s2 && s2.player === player && s2.file && (!e.resource || e.resource === s2.file.resource)) failFile(guild, s2, s2.file, 'Playback error: ' + e.message);
  });
  player.on(AudioPlayerStatus.Idle, () => onPlayerIdle(guild, player));
  const st = { player, pcm: null, ids: new Map(), active: new Map(), channelId: ch.id, wantRejoin: true, rejoining: false, badSince: 0, fails: 0, rxConn: null, file: null };
  vstate.set(guild.id, st);
  try { wireVoice(guild, st, await connectVoice(guild, ch.id)); }
  catch (e) { vstate.delete(guild.id); throw httpErr(504, e.message); }
  pushVoice(guild);
  return st;
}
const isVoiceCh = (ch) => [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type);
app.post('/api/guilds/:gid/voice/join', ...G('voice'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, String(req.body.channelId || ''));
  if (!isVoiceCh(ch)) throw httpErr(400, 'That is not a voice channel');
  await joinGuildVoice(guild, ch);
  res.json(voiceInfo(guild));
}));
app.post('/api/guilds/:gid/voice/leave', ...G('voice'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  dropVoice(guild.id); // also stops any automatic rejoin
  const conn = getVoiceConnection(guild.id);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  pushVoice(guild);
  res.json({ connected: false, reconnecting: false, channelId: null, channelName: null, members: [] });
}));

/* ------------------------------ Extra messaging --------------------------- */
app.get('/api/guilds/:gid/members/:uid', ...G('chat', 'roles'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const m = await guild.members.fetch(req.params.uid).catch(() => null);
  if (!m) throw httpErr(404, 'Member not found (they may have left the server)');
  res.json({ id: m.id, name: m.displayName, roles: [...m.roles.cache.keys()].filter((r) => r !== guild.id) });
}));
app.get('/api/guilds/:gid/emojis', ...G('chat'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const list = await guild.emojis.fetch().catch(() => guild.emojis.cache);
  res.json([...list.values()].filter((e) => e.available !== false && e.name)
    .map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48` })));
}));
/** "name:id" is a custom emoji of this server; anything else must be a unicode emoji. */
async function parseEmoji(guild, raw) {
  const text = String(raw || '').trim().replace(/^<a?:(\w+:\d+)>$/, '$1');
  if (!text || text.length > 40) throw httpErr(400, 'Emoji required');
  const custom = /^(\w{2,32}):(\d{15,25})$/.exec(text);
  if (custom) {
    const e = guild.emojis.cache.get(custom[2]) || await guild.emojis.fetch(custom[2]).catch(() => null);
    if (!e || e.available === false) throw httpErr(400, 'That custom emoji does not belong to this server or is unavailable.');
    return { key: e.id, ident: `${e.name}:${e.id}` };
  }
  if (/^[\w\s:]+$/.test(text) || text.length > 20) throw httpErr(400, 'That is not a valid emoji.');
  return { key: text, ident: text };
}
const findReaction = (msg, key) => msg.reactions.cache.find((r) => (r.emoji.id || r.emoji.name) === key);
async function reactionCtx(req) {
  const { guild, ch, perms } = await requireChan(req, 'read');
  const msg = await ch.messages.fetch({ message: req.params.mid, force: true }).catch(() => null);
  if (!msg) throw httpErr(404, 'That message no longer exists (it may have been deleted).');
  return { guild, ch, perms, msg };
}
const pushReactions = (ch, msg) => {
  const reactions = serializeReactions(msg);
  broadcast('reactions', { guildId: ch.guildId, channelId: ch.id, messageId: msg.id, reactions });
  return reactions;
};
app.post('/api/guilds/:gid/channels/:cid/messages/:mid/react', ...G('chat'), wrap(async (req, res) => {
  const { guild, ch, perms, msg } = await reactionCtx(req);
  const { key, ident } = await parseEmoji(guild, req.body.emoji);
  const existing = findReaction(msg, key);
  if (existing?.me) return res.json({ ok: true, already: true, reactions: serializeReactions(msg) }); // no duplicates
  if (!existing && !perms.canReact) throw httpErr(403, 'The bot cannot add new reactions here (missing Add Reactions).');
  await msg.react(ident);
  const fresh = await ch.messages.fetch({ message: msg.id, force: true });
  res.json({ ok: true, already: false, reactions: pushReactions(ch, fresh) });
}));
app.delete('/api/guilds/:gid/channels/:cid/messages/:mid/react', ...G('chat'), wrap(async (req, res) => {
  const { guild, ch, msg } = await reactionCtx(req);
  const { key } = await parseEmoji(guild, req.query.emoji);
  const existing = findReaction(msg, key);
  if (!existing || !existing.me) return res.json({ ok: true, already: true, reactions: serializeReactions(msg) });
  await existing.users.remove(client.user.id); // removes only the bot's own reaction
  const fresh = await ch.messages.fetch({ message: msg.id, force: true });
  res.json({ ok: true, already: false, reactions: pushReactions(ch, fresh) });
}));

/* ------------------------- Store: favorites/schedules/AI ------------------ */
const DATA_ROOT = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_ROOT, 'store.json');
const FILES_DIR = path.join(DATA_ROOT, 'sched-files');
let store = { favorites: {}, rolePins: {}, schedules: [], ai: { enabled: false, provider: 'gemini', model: '', apiKey: '', name: 'TANIM ER WIFE', summary: '' },
  voiceAI: { enabled: false, model: '', apiKey: '', name: 'TANIM ER WIFE', persona: '', voice: 'Puck' } };
try { if (fs.existsSync(STORE_FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) }; } catch (e) { console.error('Could not read store.json:', e.message); }
try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch {}
const saveStore = () => { try { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); } catch (e) { console.error('Could not save store.json:', e.message); } };

app.get('/api/favorites', ...T('chat', 'voice', 'sched'), (req, res) => {
  if (!canGuild(req.admin, req.query.guildId)) return deny(res, 'You do not have access to this server.');
  res.json(store.favorites[req.admin.email]?.[req.query.guildId] || []);
});
app.post('/api/favorites/toggle', ...T('chat', 'voice', 'sched'), (req, res) => {
  const { guildId, channelId } = req.body || {};
  if (typeof guildId !== 'string' || typeof channelId !== 'string' || !guildId || !channelId) return res.status(400).json({ error: 'Bad request' });
  if (!canGuild(req.admin, guildId)) return deny(res, 'You do not have access to this server.');
  const f = (store.favorites[req.admin.email] ||= {});
  const l = (f[guildId] ||= []);
  const i = l.indexOf(channelId);
  if (i >= 0) l.splice(i, 1); else l.push(channelId);
  saveStore();
  res.json(l);
});

/* Role pins: separate for every admin account, saved on the server */
app.get('/api/role-pins', ...T('roles'), (req, res) => {
  if (!canGuild(req.admin, req.query.guildId)) return deny(res, 'You do not have access to this server.');
  res.json(store.rolePins[req.admin.email]?.[req.query.guildId] || []);
});
app.post('/api/role-pins/toggle', ...T('roles'), (req, res) => {
  const { guildId, roleId } = req.body || {};
  if (typeof guildId !== 'string' || typeof roleId !== 'string' || !guildId || !roleId) return res.status(400).json({ error: 'Bad request' });
  if (!canGuild(req.admin, guildId)) return deny(res, 'You do not have access to this server.');
  const f = (store.rolePins[req.admin.email] ||= {});
  const l = (f[guildId] ||= []);
  const i = l.indexOf(roleId);
  if (i >= 0) l.splice(i, 1); else l.push(roleId);
  saveStore();
  res.json(l);
});

/* Scheduled messages (checked every minute by node-cron) */
const dropFiles = (s) => { (s.files || []).forEach((f) => fs.rm(f.path, () => {})); s.files = []; };
/** A co-admin's scheduled message only goes out while that account still exists and still has Schedule + this server. */
function creatorMayStillSend(s) {
  if (s.byRole === 'head' || (!s.byRole && s.by === HEAD_EMAIL)) return true; // (schedules saved by Stage 2 have no byRole)
  const a = admins.find((x) => x.email === s.by);
  return !!a && a.servers.includes(String(s.guildId)) && a.tabs.includes('sched');
}
let dispatching = false;
async function dispatchDue() {
  if (dispatching || !client?.isReady()) return;
  dispatching = true;
  try {
    for (const s of store.schedules) {
      if (s.status !== 'pending' || s.at > Date.now()) continue;
      if (Date.now() - s.at > 24 * 3600 * 1000) { s.status = 'missed'; dropFiles(s); continue; }
      if (!creatorMayStillSend(s)) { s.status = 'failed'; s.error = 'The admin who created this message no longer has access to this server.'; s.sentAt = Date.now(); dropFiles(s); continue; }
      try {
        const guild = await client.guilds.fetch(s.guildId);
        const ch = await guild.channels.fetch(s.channelId);
        await ch.send({ content: s.content || undefined, files: (s.files || []).map((f) => ({ attachment: f.path, name: f.name })) });
        s.status = 'sent';
      } catch (e) { s.status = 'failed'; s.error = e.message; console.error('[schedule]', e.message); }
      s.sentAt = Date.now(); dropFiles(s);
    }
  } finally { dispatching = false; saveStore(); }
}
cron.schedule('* * * * *', () => dispatchDue().catch(() => {}));
app.get('/api/schedules', ...T('sched'), (req, res) => {
  if (!canGuild(req.admin, req.query.guildId)) return deny(res, 'You do not have access to this server.');
  res.json(store.schedules.filter((s) => s.guildId === req.query.guildId)
    .sort((a, b) => a.at - b.at).map(({ files, ...s }) => ({ ...s, fileNames: (files || []).map((f) => f.name) })));
});
app.post('/api/schedules', ...T('sched'), upload.array('files', 10), wrap(async (req, res) => {
  ensureReady();
  const { guildId, channelId } = req.body;
  if (!guildId || !channelId) throw httpErr(400, 'Choose a channel');
  if (!canGuild(req.admin, guildId)) throw httpErr(403, 'You do not have access to this server.'); // checked on the server, whatever the form showed
  const content = String(req.body.content || '').slice(0, 2000);
  const at = new Date(req.body.at).getTime();
  if (!content.trim() && !(req.files || []).length) throw httpErr(400, 'Write a message or add a file');
  if (!Number.isFinite(at) || at < Date.now() + 30000) throw httpErr(400, 'Pick a time at least 1 minute from now');
  await getChannel(await getGuild(String(guildId)), String(channelId)); // the channel must really belong to that server
  const id = crypto.randomUUID(), files = [];
  for (const f of req.files || []) { const p = path.join(FILES_DIR, `${id}-${files.length}`); fs.writeFileSync(p, f.buffer); files.push({ path: p, name: f.originalname }); }
  store.schedules.push({ id, guildId, channelId, content, at, files, status: 'pending', by: req.admin.email, byRole: req.admin.role, createdAt: Date.now() });
  saveStore();
  res.json({ ok: true });
}));
app.delete('/api/schedules/:id', ...T('sched'), (req, res) => {
  const s = store.schedules.find((x) => x.id === req.params.id);
  if (s && !canGuild(req.admin, s.guildId)) return deny(res, 'You do not have access to this server.');
  if (s) { dropFiles(s); store.schedules = store.schedules.filter((x) => x !== s); saveStore(); }
  res.json({ ok: true });
});

/* AI assistant (Gemini / OpenAI / Claude) */
const AI_MODELS = { gemini: 'gemini-3.8-flash', openai: 'gpt-4o-mini', claude: 'claude-haiku-5-5' };
app.get('/api/ai', ...T('ai'), (req, res) => {
  const a = store.ai;
  res.json({ enabled: a.enabled, provider: a.provider, model: a.model, name: a.name, summary: a.summary,
    hasKey: !!a.apiKey, keyHint: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', canEdit: req.admin.role === 'head', defaults: AI_MODELS });
});
app.post('/api/ai', requireAuth, requireHead, wrap((req, res) => {
  const b = req.body || {}, a = store.ai;
  if (typeof b.enabled === 'boolean') a.enabled = b.enabled;
  if (AI_MODELS[b.provider]) a.provider = b.provider;
  if (typeof b.model === 'string') a.model = b.model.trim().slice(0, 80);
  if (typeof b.name === 'string') a.name = b.name.trim().slice(0, 60);
  if (typeof b.summary === 'string') a.summary = b.summary.slice(0, 6000);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) a.apiKey = b.apiKey.trim();
  if (b.clearKey) a.apiKey = '';
  saveStore();
  res.json({ ok: true });
}));
async function askAI(a, q, who, timeoutMs = 60000) { // Stage 5B: optional timeout (DM auto-reply uses a shorter one); other callers are unchanged
  const model = a.model || AI_MODELS[a.provider];
  const sys = `You are "${a.name || 'TANIM ER WIFE'}", an assistant inside a Discord server. ${a.summary || ''}\nReply in the same language the user writes in. Keep replies under 1500 characters. You are talking to ${who}.`;
  const post = async (url, headers, body) => {
    let r;
    try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error(e.name === 'TimeoutError' ? `The AI took longer than ${Math.round(timeoutMs / 1000)} seconds to answer.` : e.message); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${r.status}`), { status: r.status });
    return j;
  };
  let text = '';
  if (a.provider === 'openai') {
    const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${a.apiKey}` },
      { model, messages: [{ role: 'system', content: sys }, { role: 'user', content: q }] });
    text = j.choices?.[0]?.message?.content;
  } else if (a.provider === 'claude') {
    const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 800, system: sys, messages: [{ role: 'user', content: q }] });
    text = (j.content || []).map((c) => c.text || '').join('');
  } else {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: q }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } };
    let j;
    try { j = await post(url, { 'x-goog-api-key': a.apiKey }, body); }
    catch (e) { // some models reject thinkingLevel: retry once without it
      if (e.status !== 400) throw e;
      delete body.generationConfig;
      j = await post(url, { 'x-goog-api-key': a.apiKey }, body);
    }
    text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  if (!text) throw new Error('Empty answer from AI');
  return text;
}
const aiLast = new Map(); // userId -> last time the AI answered them
const AI_COOLDOWN_MS = 10000;
async function handleAI(m) {
  const a = store.ai;
  if (!a.enabled || !a.apiKey || m.author.bot || !m.guildId || !client?.user) return;
  let asked = m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
  let ctx = '';
  if (m.reference?.messageId) {
    const ref = await m.channel.messages.fetch(m.reference.messageId).catch(() => null);
    if (ref) { if (ref.author.id === client.user.id) asked = true; ctx = `(The user is replying to this earlier message: "${ref.content.slice(0, 500)}")\n`; }
  }
  if (!asked) return;
  const now = Date.now();
  if (now - (aiLast.get(m.author.id) || 0) < AI_COOLDOWN_MS) { m.react('⏳').catch(() => {}); return; } // cooldown
  aiLast.set(m.author.id, now);
  if (aiLast.size > 5000) for (const [k, t] of aiLast) if (now - t > AI_COOLDOWN_MS) aiLast.delete(k);
  const q = m.content.replace(/<@!?\d+>/g, '').trim();
  if (!q) return;
  m.channel.sendTyping().catch(() => {});
  try { await m.reply({ content: (await askAI(a, ctx + q, m.member?.displayName || m.author.username)).slice(0, 1900), allowedMentions: { repliedUser: false } }); }
  catch (e) { console.error('[ai]', e.message); m.reply({ content: 'এআই এখন উত্তর দিতে পারছে না: ' + e.message.slice(0, 150), allowedMentions: { repliedUser: false } }).catch(() => {}); }
}

/* ------------------------ Voice files (MP3 / WAV / OGG) -------------------- */
// Uploaded by signed-in admins, stored under DATA_ROOT/voice-files with random names (the uploaded name is never used as a path),
// decoded by ffmpeg to 48 kHz stereo PCM and played through the SAME audio player and connection as the mic and the Voice AI.
const VOICE_DIR = path.join(DATA_ROOT, 'voice-files');
const VOICE_TMP = path.join(VOICE_DIR, '.tmp');
const VOICE_EXT = ['mp3', 'wav', 'ogg'];
const VOICE_MAX_FILES = 50, VOICE_HARD_MAX_MB = 100;
try { fs.mkdirSync(VOICE_TMP, { recursive: true }); for (const f of fs.readdirSync(VOICE_TMP)) fs.rm(path.join(VOICE_TMP, f), () => {}); } catch (e) { console.error('Could not prepare voice-files folder:', e.message); }
store.voiceFiles = Array.isArray(store.voiceFiles) ? store.voiceFiles.filter((f) => f && f.file && fs.existsSync(path.join(VOICE_DIR, f.file))) : [];
store.voiceCfg = { maxMb: Number(process.env.VOICE_MAX_MB) || 20, ...(store.voiceCfg || {}) };
const voiceMaxMb = () => Math.min(VOICE_HARD_MAX_MB, Math.max(1, Number(store.voiceCfg.maxMb) || 20));
const voiceMaxBytes = () => Math.round(voiceMaxMb() * 1024 * 1024);
/** What the file really is, from its first bytes. The extension alone is never trusted. */
function sniffAudio(b) {
  if (!b || b.length < 12) return null;
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}
function cleanName(raw) {
  let n = String(raw || '');
  const u = Buffer.from(n, 'latin1').toString('utf8'); if (!u.includes('\ufffd')) n = u; // multer hands over utf-8 names as latin-1
  n = path.basename(n.replace(/\\/g, '/')).replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return n || 'audio';
}
const pubFile = (f) => ({ id: f.id, name: f.name, ext: f.ext, size: f.size, by: f.by, at: f.at });
const clampVol = (v) => { v = Number(v); return Number.isFinite(v) ? Math.min(1.5, Math.max(0, v)) : 1; };
const voiceDisk = multer.diskStorage({ destination: (_r, _f, cb) => cb(null, VOICE_TMP), filename: (_r, _f, cb) => cb(null, crypto.randomUUID() + '.part') });
const voiceUploadMw = (req, res, next) => multer({ storage: voiceDisk, limits: { fileSize: voiceMaxBytes(), files: 1, fields: 5 } }).single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `That file is bigger than the ${voiceMaxMb()} MB limit.` });
  res.status(400).json({ error: 'Upload failed: ' + err.message });
});
app.get('/api/voice-files', ...T('voice'), (req, res) => res.json({
  files: store.voiceFiles.slice().sort((a, b) => b.at - a.at).map(pubFile),
  maxMb: voiceMaxMb(), hardMaxMb: VOICE_HARD_MAX_MB, formats: VOICE_EXT, canConfig: req.admin.role === 'head',
}));
app.post('/api/voice-files', ...T('voice'), voiceUploadMw, wrap((req, res) => { // auth first, then the file is written to disk
  const f = req.file;
  if (!f) throw httpErr(400, 'Choose an MP3, WAV or OGG file.');
  try {
    const ext = path.extname(f.originalname || '').slice(1).toLowerCase();
    if (!VOICE_EXT.includes(ext)) throw httpErr(415, 'Only MP3, WAV and OGG files are allowed.');
    if (f.size < 64) throw httpErr(400, 'That file is empty.');
    if (store.voiceFiles.length >= VOICE_MAX_FILES) throw httpErr(409, `The library is full (${VOICE_MAX_FILES} files). Delete one first.`);
    const head = Buffer.alloc(12), fd = fs.openSync(f.path, 'r');
    try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    if (sniffAudio(head) !== ext) throw httpErr(415, `That is not a real ${ext.toUpperCase()} file (the content does not match the name).`);
    const id = crypto.randomUUID(), stored = `${id}.${ext}`;
    fs.renameSync(f.path, path.join(VOICE_DIR, stored));
    const meta = { id, file: stored, name: cleanName(f.originalname), ext, size: f.size, by: req.admin.email, at: Date.now() };
    store.voiceFiles.push(meta); saveStore(); broadcast('voiceFiles', {});
    console.log(`[voice-file] ${req.admin.email} uploaded "${meta.name}" (${meta.size} bytes)`);
    res.json(pubFile(meta));
  } catch (e) { fs.rm(f.path, () => {}); throw e; }
}));
app.post('/api/voice-files/config', requireAuth, requireHead, wrap((req, res) => {
  const mb = Number(req.body?.maxMb);
  if (!Number.isFinite(mb) || mb < 1 || mb > VOICE_HARD_MAX_MB) throw httpErr(400, `Enter a size between 1 and ${VOICE_HARD_MAX_MB} MB.`);
  store.voiceCfg.maxMb = Math.round(mb * 10) / 10; saveStore(); broadcast('voiceFiles', {});
  res.json({ ok: true, maxMb: voiceMaxMb() });
}));
app.delete('/api/voice-files/:id', ...T('voice'), wrap((req, res) => {
  const meta = store.voiceFiles.find((f) => f.id === req.params.id);
  if (!meta) return res.json({ ok: true });
  if (req.admin.role !== 'head' && meta.by !== req.admin.email) throw httpErr(403, 'Only the head admin or the person who uploaded a file can delete it.');
  for (const [gid, st] of vstate) if (st.file?.id === meta.id) { stopFile(st); const g = client?.guilds.cache.get(gid); if (g) pushVoice(g); }
  store.voiceFiles = store.voiceFiles.filter((f) => f !== meta); saveStore();
  fs.rm(path.join(VOICE_DIR, meta.file), () => {}); broadcast('voiceFiles', {});
  res.json({ ok: true });
}));

function stopFile(st) { // stop playback and free ffmpeg. Safe to call at any time.
  const f = st?.file;
  if (!f) return false;
  f.stopped = true; st.file = null;
  try { f.ff?.destroy(); } catch {}
  try { f.pcm.destroy(); } catch {}
  try { st.player.stop(true); } catch {}
  st.pcm = null; // the mic / Voice AI sink is re-created on the next write
  return true;
}
function failFile(guild, st, f, msg) {
  if (st.file !== f) return;
  f.failMsg = msg; stopFile(st);
  console.warn('[voice-file]', msg);
  broadcast('voice:error', { guildId: guild.id, msg });
  pushVoice(guild);
}
function fileResource(f) {
  const r = createAudioResource(f.pcm, { inputType: StreamType.Raw, inlineVolume: true });
  r.volume.setVolume(f.volume); f.resource = r; return r;
}
function onPlayerIdle(guild, player) {
  const st = vstate.get(guild.id), f = st && st.player === player && st.file;
  if (!f || f.stopped) return;
  if (f.pcm.readableEnded || f.pcm.destroyed || f.restarts >= 30) { stopFile(st); pushVoice(guild); return; } // finished
  f.restarts++; // the player starved for a moment (busy server): re-arm it on the same decoded stream
  try { player.play(fileResource(f)); } catch (e) { failFile(guild, st, f, 'Playback error: ' + e.message); }
}
async function startFile(guild, st, meta, { loop, volume }) {
  try { prism.FFmpeg.getInfo(); } catch { throw httpErr(503, 'ffmpeg is not available on the server. Run npm install (ffmpeg-static) and redeploy.'); }
  const filePath = path.join(VOICE_DIR, meta.file);
  if (!fs.existsSync(filePath)) throw httpErr(404, 'That audio file is missing on the server.');
  stopFile(st);
  const tok = st.fileTok = (st.fileTok || 0) + 1;
  const f = { id: meta.id, name: meta.name, loop: !!loop, volume, pcm: new PassThrough({ highWaterMark: 1 << 20 }), ff: null, stopped: false, ended: false, restarts: 0, resource: null, failMsg: '' };
  f.pcm.on('error', () => {});
  const run = () => { // one ffmpeg run = one pass over the file; with Loop on, the next pass starts while ~5 s are still buffered
    let got = 0;
    const ff = new prism.FFmpeg({ args: ['-analyzeduration', '0', '-loglevel', 'error', '-i', filePath, '-f', 's16le', '-ar', '48000', '-ac', '2'] });
    f.ff = ff;
    ff.on('data', (c) => { got += c.length; });
    ff.on('error', (e) => { if (!f.stopped) failFile(guild, st, f, 'Could not decode that file: ' + e.message); });
    ff.once('end', () => {
      if (f.stopped) return;
      if (!got) return failFile(guild, st, f, 'Could not decode that file (it may be corrupt).');
      if (f.loop) run(); else { f.ended = true; f.pcm.end(); }
    });
    ff.pipe(f.pcm, { end: false });
  };
  st.file = f; // from here the mic and the Voice AI stay out of the way
  run();
  const t0 = Date.now(); // wait for ~100 ms of audio, otherwise the player gives up on an empty stream
  while (!f.stopped && !f.ended && f.pcm.readableLength < 19200 && Date.now() - t0 < 4000) await sleep(20);
  if (f.stopped || st.fileTok !== tok) throw httpErr(f.failMsg ? 500 : 409, f.failMsg || 'Playback was replaced or cancelled.');
  if (!f.pcm.readableLength && !f.ended) { stopFile(st); throw httpErr(500, 'ffmpeg did not produce any audio.'); }
  const old = st.pcm; st.pcm = null;
  st.player.play(fileResource(f));
  try { old?.destroy(); } catch {}
}
app.post('/api/guilds/:gid/voice/play', ...G('voice'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const meta = store.voiceFiles.find((f) => f.id === String(req.body.fileId || ''));
  if (!meta) throw httpErr(404, 'That audio file no longer exists.');
  const chId = String(req.body.channelId || '');
  let st = vstate.get(guild.id);
  const conn = getVoiceConnection(guild.id);
  const here = st && conn && conn.state.status === VoiceConnectionStatus.Ready && (!chId || st.channelId === chId);
  if (!here) { // not in the selected channel yet: join it with the normal voice join
    if (!chId) throw httpErr(409, 'Choose a voice channel first.');
    const ch = await getChannel(guild, chId);
    if (!isVoiceCh(ch)) throw httpErr(400, 'That is not a voice channel');
    st = await joinGuildVoice(guild, ch);
  }
  if (vai.dsp && vai.dsp.guildId === guild.id) throw httpErr(409, 'A member is talking to the Voice AI right now. Try again in a moment.');
  await startFile(guild, st, meta, { loop: !!req.body.loop, volume: clampVol(req.body.volume) });
  pushVoice(guild);
  console.log(`[voice-file] ${req.admin.email} plays "${meta.name}" in ${guild.name}`);
  res.json(voiceInfo(guild));
}));
app.post('/api/guilds/:gid/voice/stop', ...G('voice'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const st = vstate.get(guild.id);
  if (st) stopFile(st);
  pushVoice(guild);
  res.json(voiceInfo(guild));
}));
app.post('/api/guilds/:gid/voice/play-settings', ...G('voice'), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const f = vstate.get(guild.id)?.file;
  if (!f) throw httpErr(409, 'Nothing is playing.');
  if (req.body.volume !== undefined) { f.volume = clampVol(req.body.volume); try { f.resource?.volume?.setVolume(f.volume); } catch {} }
  if (typeof req.body.loop === 'boolean') f.loop = req.body.loop;
  pushVoice(guild);
  res.json(voiceInfo(guild));
}));

/* ------------------------- Voice AI (Gemini Live API) --------------------- */
const VAI_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const VAI_DEFAULT_MODEL = 'gemini-3.8-live';
const vai = { ws: null, ready: false, connecting: null, closing: false, status: 'idle', error: '', speaker: null, toGuild: null, idleTimer: null, prev: 0,
  mode: '', dsp: null, awaiting: false, awaitTimer: null, playUntil: 0, lastState: 'idle', stateTimer: null }; // dsp = the Discord member currently talking to the AI
function vaiSet(status, error = '') { vai.status = status; vai.error = error; broadcastHead('vai:status', { status, error }); }
function vaiKey() {
  const v = store.voiceAI;
  if (v.apiKey) return v.apiKey;
  if (store.ai.apiKey && store.ai.provider === 'gemini') return store.ai.apiKey; // fall back to the text AI key
  if (store.ai.apiKey) throw new Error('The text AI uses another provider, so its key cannot open Gemini Live. Add a Gemini key in the Voice AI settings.');
  throw new Error('No API key yet. Add a Gemini key in the Voice AI settings.');
}
function vaiInstruction(mode = 'web') {
  const v = store.voiceAI, name = v.name || 'TANIM ER WIFE';
  return `You are "${name}", a voice assistant in a Discord server.\n` + (v.persona.trim()
    ? `The text between the markers is the official information about who you are. It ALWAYS takes priority over your general knowledge or training data. When a question touches anything it covers (who you are, who made you, your team, your story), answer from it and never contradict it.\n--- WHO THIS AI IS ---\n${v.persona.trim()}\n--- END ---\n` : '')
    + 'Speak naturally and briefly, in the same language the person speaks.'
    + (mode !== 'discord' ? '' : v.discordTrigger === 'always'
      ? ' You are in a Discord voice channel with several people. Answer whoever is speaking to you.'
      : ` You are in a Discord voice channel with several people who also talk to each other. Reply ONLY when someone clearly speaks to you or says your name "${name}". If they are talking among themselves, say nothing and produce no audio.`);
}
function vaiTouch() { // close the Live API connection after a minute without activity
  clearTimeout(vai.idleTimer);
  vai.idleTimer = setTimeout(() => { if (vai.speaker || vai.dsp || aiBusy()) return vaiTouch(); vaiClose(); }, 60000);
}
function vaiClose() {
  clearTimeout(vai.idleTimer);
  vai.closing = true; vai.ready = false;
  try { vai.ws?.close(1000); } catch {}
  vai.ws = null;
  if (vai.speaker) { vai.speaker.vaiSpeaking = false; vai.speaker = null; }
  vaiDspReset(); vai.awaiting = false; vai.playUntil = 0;
  vaiSet('idle');
}
const vaiSendLive = (obj) => { if (vai.ws?.readyState === 1 && vai.ready) vai.ws.send(JSON.stringify(obj)); };
function vaiSendAudio(buf) {
  vaiSendLive({ realtimeInput: { audio: { data: Buffer.from(buf).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
  vaiTouch();
}
function up24to48Stereo(pcm) { // Int16 mono 24 kHz -> Int16 stereo 48 kHz (linear interpolation)
  const n = pcm.length >> 1, out = Buffer.alloc(n * 8);
  let prev = vai.prev;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2), mid = (prev + s) >> 1;
    out.writeInt16LE(mid, i * 8); out.writeInt16LE(mid, i * 8 + 2); out.writeInt16LE(s, i * 8 + 4); out.writeInt16LE(s, i * 8 + 6);
    prev = s;
  }
  vai.prev = prev;
  return out;
}
function vaiFlushAudio() { const st = vstate.get(vai.toGuild); if (st) flushVoicePcm(st); }
function onAiAudio(b64) {
  vaiTouch();
  const ms = Buffer.byteLength(b64, 'base64') / 48; // 24 kHz mono Int16 = 48 bytes per ms
  vai.playUntil = Math.max(Date.now(), vai.playUntil) + ms; // how long the answer is still playing in Discord
  if (vai.lastState !== 'speaking') dspState('speaking');
  clearTimeout(vai.stateTimer); vai.stateTimer = setTimeout(() => { if (!aiBusy()) dspState('idle'); }, Math.max(0, vai.playUntil - Date.now()) + 900);
  const msg = JSON.stringify({ type: 'vai:audio', data: { b64 } });
  wss.clients.forEach((w) => { if (w.readyState === 1 && w.vaiListen && isHead(w) && w.bufferedAmount < 1e6) w.send(msg); });
  const st = vai.toGuild && vstate.get(vai.toGuild);
  if (st) writeVoicePcm(st, up24to48Stereo(Buffer.from(b64, 'base64')));
}
function vaiConnect(mode = 'web') {
  if (vai.ready && vai.ws?.readyState === 1) return Promise.resolve();
  if (vai.connecting) return vai.connecting;
  vai.connecting = new Promise((resolve, reject) => {
    let key; try { key = vaiKey(); } catch (e) { return reject(e); }
    const cfg = store.voiceAI;
    vaiSet('connecting'); vai.closing = false; vai.ready = false;
    const w = new WebSocket(VAI_URL, { headers: { 'x-goog-api-key': key }, handshakeTimeout: 15000 });
    vai.ws = w;
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { w.terminate(); } catch {} if (vai.ws === w) vai.ws = null; vai.ready = false; reject(e); };
    const timer = setTimeout(() => fail(new Error('Gemini Live did not answer within 20 seconds.')), 20000);
    w.on('open', () => w.send(JSON.stringify({ setup: {
      model: 'models/' + (cfg.model || VAI_DEFAULT_MODEL).replace(/^models\//, ''),
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice || 'Puck' } } } },
      systemInstruction: { parts: [{ text: vaiInstruction(mode) }] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, // manual activityStart / activityEnd
    } })));
    w.on('message', (data) => {
      if (vai.ws !== w) return; // a socket that was replaced
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.setupComplete) { settled = true; clearTimeout(timer); vai.ready = true; vai.mode = mode; vaiSet('ready'); vaiTouch(); resolve(); return; }
      const sc = m.serverContent;
      if (sc) {
        if (sc.interrupted) { vaiFlushAudio(); vai.playUntil = 0; vai.awaiting = false; broadcastHead('vai:interrupted', {}); }
        for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) onAiAudio(p.inlineData.data);
        if (sc.turnComplete) { vai.awaiting = false; clearTimeout(vai.awaitTimer); if (!aiBusy()) dspState('idle'); } // the model finished (or chose to stay silent)
      }
    });
    w.on('unexpected-response', (_req, res) => fail(new Error(`Gemini Live refused the connection (HTTP ${res.statusCode}). Check the API key and the model name.`)));
    w.on('error', (e) => fail(new Error('Gemini Live connection error: ' + e.message)));
    w.on('close', (code, reason) => {
      clearTimeout(timer);
      const why = (reason?.toString() || '').slice(0, 200);
      if (!settled) return fail(new Error(`Gemini Live closed during setup (code ${code}). ${why}`.trim()));
      if (vai.ws !== w) return; // an old socket closing after it was replaced must not touch the new session
      vai.ready = false; vai.ws = null;
      if (vai.closing) return;
      vaiDspReset(); vai.awaiting = false; vai.playUntil = 0;
      if (vai.speaker) { vai.speaker.vaiSpeaking = false; wsSendJson(vai.speaker, 'vai:denied', { msg: 'The Gemini Live session ended.' }); vai.speaker = null; }
      vaiSet(code === 1000 ? 'idle' : 'error', code === 1000 ? '' : `Gemini Live closed (code ${code}). ${why}`.trim());
    });
  }).finally(() => { vai.connecting = null; });
  return vai.connecting;
}
function vaiAwait() { // an answer is coming: nobody else may start a turn until it is finished
  vai.awaiting = true; clearTimeout(vai.awaitTimer);
  vai.awaitTimer = setTimeout(() => { vai.awaiting = false; if (!aiBusy()) dspState('idle'); }, 15000);
}
/* Voice AI is reopened with the other instruction set when the kind of speaker changes (website mic <-> Discord members). */
function vaiEnsure(mode) {
  if (vai.ready && vai.ws && vai.mode !== mode) { vai.ready = false; try { vai.ws.close(1000); } catch {} vai.ws = null; }
  return vaiConnect(mode);
}
function vaiEndTurn(ws) {
  if (vai.speaker !== ws) return;
  if (ws.vaiSpeaking) { vaiSendLive({ realtimeInput: { activityEnd: {} } }); vaiAwait(); }
  ws.vaiSpeaking = false; vai.speaker = null; vaiTouch();
}
function vaiControl(ws, m) { // only one active speaker at a time
  if (m.a === 'listen') { ws.vaiListen = !!m.on; return; }
  if (m.a === 'end') return vaiEndTurn(ws);
  if (m.a !== 'start') return;
  const deny = (msg) => wsSendJson(ws, 'vai:denied', { msg });
  if (!store.voiceAI.enabled) return deny('Voice AI is turned off.');
  if (vai.speaker && vai.speaker !== ws && vai.speaker.readyState === 1) return deny('Another speaker is active. Wait until they finish.');
  if (vai.dsp) return deny('A Discord member is talking to the AI right now. Wait until they finish.');
  if (m.toDiscord && m.g && vstate.get(String(m.g))?.file) return deny('An audio file is playing in Discord. Stop it first, or untick "Speak into the Discord voice channel".');
  vai.speaker = ws;
  vai.toGuild = m.toDiscord && m.g ? String(m.g) : null;
  vai.awaiting = false; vai.playUntil = 0; // speaking over the AI interrupts it
  vaiFlushAudio();
  vaiEnsure('web').then(() => {
    if (vai.speaker !== ws) return;
    vaiSendLive({ realtimeInput: { activityStart: {} } });
    ws.vaiSpeaking = true; vaiTouch();
    wsSendJson(ws, 'vai:go', {});
  }).catch((e) => { if (vai.speaker === ws) vai.speaker = null; vaiSet('error', e.message); deny(e.message); });
}
/* ---- Discord members talk to the Voice AI (one speaker at a time, manual activityStart / activityEnd) ---- */
const DSP_MAX_MS = 30000, DSP_MIN_BYTES = 16000 * 2 * 0.3; // a turn is cut at 30 s; anything under 300 ms of speech is ignored
const aiBusy = () => vai.awaiting || Date.now() < vai.playUntil + 700; // waiting for / playing an answer (+ echo tail)
function dspState(state, who) { vai.lastState = state; broadcastHead('vai:activity', { state, who: who || '' }); }
function stereo48ToMono16(buf, carry) { // Int16 stereo 48 kHz -> Int16 mono 16 kHz (average of 3 frames x 2 channels)
  const b = carry.length ? Buffer.concat([carry, buf]) : buf, n = Math.floor(b.length / 12), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) { const o = (i * 3 + k) * 4; sum += b.readInt16LE(o) + b.readInt16LE(o + 2); }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
  }
  return { out, rest: b.subarray(n * 12) };
}
function vaiDspReset() {
  const d = vai.dsp;
  if (!d) return;
  vai.dsp = null; clearTimeout(d.maxTimer);
  try { d.opus?.unpipe(d.dec); d.dec?.destroy(); } catch {} // the receiver stream is shared with the website listener: only detach from it
  dspState('idle');
}
function vaiDspCancel(gid) { // voice disconnected / bot moved: drop the turn
  const d = vai.dsp;
  if (!d || (gid && d.guildId !== gid)) return;
  if (d.started) vaiClose(); else vaiDspReset(); // a half-sent turn cannot be taken back: reset the Live session
}
function vaiDspEnd(d) { // the member stopped talking: ask for the answer
  vaiSendLive({ realtimeInput: { activityEnd: {} } });
  vai.dsp = null; clearTimeout(d.maxTimer); vaiAwait(); dspState('thinking', d.name); vaiTouch();
}
function vaiDspFinish(d) {
  if (vai.dsp !== d || d.ending) return;
  d.ending = true; clearTimeout(d.maxTimer);
  try { d.opus?.unpipe(d.dec); } catch {}
  if (d.bytes < DSP_MIN_BYTES) return vaiDspReset(); // a cough or a click
  if (d.started) vaiDspEnd(d); // otherwise dspTryStart sends start + audio + end as soon as Gemini is connected
}
function dspTryStart(d) {
  if (vai.dsp !== d || d.started || !d.ready || d.bytes < DSP_MIN_BYTES) return;
  d.started = true;
  vaiSendLive({ realtimeInput: { activityStart: {} } });
  for (const b of d.q) vaiSendAudio(b);
  d.q = []; dspState('listening', d.name);
  if (d.ending) vaiDspEnd(d);
}
function onSpeakAI(guild, st, conn, uid) {
  const v = store.voiceAI;
  if (!v.enabled || !v.discordListen || !client?.user || uid === client.user.id) return; // never listen to the bot itself: no feedback loop
  const member = guild.members.cache.get(uid);
  if (member?.user?.bot) return;
  // one speaker at a time, never while an answer is pending or playing (that would also feed the AI its own echo), never over a file
  if (vai.dsp || vai.speaker || vai.connecting || aiBusy() || st.file) return;
  try { vaiKey(); } catch (e) { if (vai.status !== 'error') vaiSet('error', e.message); return; }
  const d = { uid, guildId: guild.id, name: member?.displayName || 'a member', q: [], bytes: 0, started: false, ready: false, ending: false, carry: Buffer.alloc(0), opus: null, dec: null, maxTimer: null };
  vai.dsp = d; vai.toGuild = guild.id;
  dspState('listening', d.name);
  d.opus = conn.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
  d.dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const end = () => vaiDspFinish(d);
  d.opus.on('error', end); d.dec.on('error', end); d.dec.on('end', end);
  d.opus.pipe(d.dec);
  d.dec.on('data', (chunk) => {
    if (vai.dsp !== d || d.ending) return;
    const r = stereo48ToMono16(chunk, d.carry); d.carry = r.rest;
    if (!r.out.length) return;
    d.bytes += r.out.length;
    if (d.started) vaiSendAudio(r.out); else if (d.q.length < 700) d.q.push(r.out); // buffered (max ~14 s) while Gemini connects
    dspTryStart(d);
  });
  d.maxTimer = setTimeout(end, DSP_MAX_MS);
  vaiEnsure('discord').then(() => { d.ready = true; dspTryStart(d); })
    .catch((e) => { if (vai.dsp === d) vaiDspReset(); vaiSet('error', e.message); });
}
function vaiMemberMoved(o, n) {
  const d = vai.dsp;
  if (d && n.id === d.uid && o.channelId && o.channelId !== n.channelId) vaiDspFinish(d); // the speaker left: finish with what was heard
  if (client?.user && n.id === client.user.id && !n.channelId) vaiDspCancel(n.guild?.id); // the bot was disconnected
}
app.get('/api/voice-ai', requireAuth, requireHead, (_req, res) => {
  const v = store.voiceAI;
  res.json({ enabled: v.enabled, model: v.model, name: v.name, persona: v.persona, voice: v.voice, hasKey: !!v.apiKey,
    discordListen: !!v.discordListen, discordTrigger: v.discordTrigger === 'always' ? 'always' : 'name',
    keyHint: v.apiKey ? '••••' + v.apiKey.slice(-4) : '', fallbackAvailable: !!store.ai.apiKey && store.ai.provider === 'gemini',
    defaultModel: VAI_DEFAULT_MODEL, status: vai.status, error: vai.error });
});
app.post('/api/voice-ai', requireAuth, requireHead, wrap((req, res) => {
  const b = req.body || {}, v = store.voiceAI;
  if (typeof b.enabled === 'boolean') v.enabled = b.enabled;
  if (typeof b.discordListen === 'boolean') v.discordListen = b.discordListen;
  if (b.discordTrigger === 'name' || b.discordTrigger === 'always') v.discordTrigger = b.discordTrigger;
  if (typeof b.model === 'string') v.model = b.model.trim().slice(0, 80);
  if (typeof b.name === 'string') v.name = b.name.trim().slice(0, 60);
  if (typeof b.voice === 'string') v.voice = b.voice.trim().slice(0, 40) || 'Puck';
  if (typeof b.persona === 'string') v.persona = b.persona.slice(0, 6000);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) v.apiKey = b.apiKey.trim();
  if (b.clearKey) v.apiKey = '';
  saveStore();
  vaiClose(); // new settings apply the next time someone starts talking
  res.json({ ok: true });
}));

/* ------------------------------ Logging (Stage 4A) ----------------------- */
// Per-server voice and message-activity logs. PRIVACY: message CONTENT is never read. The message handler below only touches
// id, author id/username, channel id/name and timestamp; attachments, embeds, images and text are never accessed or stored.
// Config lives in store.json (store.logCfg). Log data is append-only JSON lines in DATA_DIR/logs/<guildId>.{voice,msg}.jsonl
// (same persistent-disk rules as the rest of the data). Writes are batched and asynchronous so Discord events are never blocked.
const LOG_DIR = path.join(DATA_ROOT, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { console.error('[logging] Could not create logs folder:', e.message); }
if (!store.logCfg || typeof store.logCfg !== 'object' || Array.isArray(store.logCfg)) store.logCfg = {};
const LOG_LIM = { retMin: 1, retMax: 365, retDef: 30, entMin: 1000, entMax: 50000, entDef: 20000, chanMax: 100 };
const LOG_QUEUE_MAX = 5000;          // pending entries held in memory before the oldest are dropped (only if the disk keeps failing)
const LOG_FLUSH_MS = 5000;           // batch window for disk writes and live message summaries
const LOG_READ_MAX = 24 * 1024 * 1024; // never load more than this from one file
const LOG_COMPACT_BYTES = 4 * 1024 * 1024; // a file bigger than this is compacted/pruned soon after a write
const MSG_BUCKET_MS = 60 * 60 * 1000; // message counts are summed per author + channel + hour
const SNOWFLAKE = /^\d{5,25}$/;
const logHealth = { dropped: 0, writeFailures: 0, lastErrorAt: 0 };

const logCfgOf = (gid) => {
  const c = store.logCfg[gid] || {};
  const ids = (x) => (Array.isArray(x?.channelIds) ? x.channelIds.filter((i) => SNOWFLAKE.test(String(i))).map(String) : []);
  return {
    voice: { enabled: c.voice?.enabled === true, channelIds: ids(c.voice) },
    messages: { enabled: c.messages?.enabled === true, channelIds: ids(c.messages) },
    retentionDays: Math.min(LOG_LIM.retMax, Math.max(LOG_LIM.retMin, Math.round(Number(c.retentionDays)) || LOG_LIM.retDef)),
    maxEntries: Math.min(LOG_LIM.entMax, Math.max(LOG_LIM.entMin, Math.round(Number(c.maxEntries)) || LOG_LIM.entDef)),
  };
};
const logFile = (gid, kind) => path.join(LOG_DIR, `${gid}.${kind}.jsonl`); // gid is always a validated snowflake before it gets here

/* per-file async lock: appends, prunes and reads of one file never interleave */
const fileLocks = new Map();
function withFile(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  fileLocks.set(file, next);
  next.catch(() => {}).finally(() => { if (fileLocks.get(file) === next) fileLocks.delete(file); });
  return next;
}
async function readLogLines(file) { // newest part of the file only, parsed line by line; bad lines are skipped
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - LOG_READ_MAX), len = size - start;
    if (!len) return [];
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // first line may be cut in half
    const out = [];
    for (const l of lines) { if (!l) continue; try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch {} }
    return out;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

/* ---- pending (in-memory) data ---- */
let voiceQ = [];            // voice entries waiting for the next disk write
const msgPending = new Map(); // key -> message-count delta waiting for the next disk write
const seenMsg = new Map();    // recent message ids (ids only, never content) so one message is never counted twice
const SEEN_MAX = 5000;
const recentVoice = new Map(); // short-lived key -> time, so an identical voice event within 1.5 s is ignored
const queueVoice = (e) => { voiceQ.push(e); if (voiceQ.length > LOG_QUEUE_MAX) { logHealth.dropped += voiceQ.length - LOG_QUEUE_MAX; voiceQ = voiceQ.slice(-LOG_QUEUE_MAX); } };
function addMsgDelta(d) {
  const k = `${d.guildId}|${d.channelId}|${d.userId}|${d.bucket}`;
  const cur = msgPending.get(k);
  if (cur) { cur.count += d.count; cur.ts = Math.max(cur.ts, d.ts); cur.username = d.username; cur.channelName = d.channelName; return; }
  if (msgPending.size >= LOG_QUEUE_MAX) { logHealth.dropped += d.count; return; }
  msgPending.set(k, { ...d });
}

/* ---- event handlers (called from the Discord client; they never throw and never await) ---- */
function logVoiceEvent(o, n) {
  const g = n.guild || o.guild; if (!g || !SNOWFLAKE.test(g.id)) return;
  const oldId = o.channelId || null, newId = n.channelId || null;
  if (oldId === newId) return;                    // mute / deafen / stream changes are not join, leave or move
  const user = (n.member || o.member)?.user || client?.users?.cache.get(n.id || o.id);
  if (user?.bot) return;                          // only people are logged, not bots
  const cfg = logCfgOf(g.id).voice; if (!cfg.enabled) return;
  const type = !oldId ? 'JOIN' : !newId ? 'LEAVE' : 'MOVE';
  const pick = type === 'LEAVE' ? o.channel : n.channel;
  const watch = (id) => !cfg.channelIds.length || cfg.channelIds.includes(id);
  if (!(type === 'MOVE' ? watch(newId) || watch(oldId) : watch(pick?.id))) return;
  const uid = String(n.id || o.id), key = `${g.id}|${uid}|${type}|${oldId}|${newId}`, now = Date.now();
  if (now - (recentVoice.get(key) || 0) < 1500) return; // duplicate dispatch
  recentVoice.set(key, now);
  if (recentVoice.size > 500) for (const [k, t] of recentVoice) if (now - t > 1500) recentVoice.delete(k);
  const e = { k: 'v', ts: now, type, userId: uid, username: String(user?.username || 'unknown'), guildId: g.id,
    channelId: pick?.id || (type === 'LEAVE' ? oldId : newId), channelName: String(pick?.name || 'unknown') };
  if (type === 'MOVE') { e.fromChannelId = oldId; e.fromChannelName = String(o.channel?.name || 'unknown'); }
  queueVoice(e);
  broadcast('log:voice', { ...e, time: new Date(e.ts).toISOString() }); // delivery is limited to subscribed sockets with Logging access (wsMayReceive)
}
function logMessageEvent(m) {
  try {
    if (!m.guildId || !SNOWFLAKE.test(m.guildId) || m.webhookId || m.system) return;
    const a = m.author; if (!a || a.bot) return;
    const cfg = logCfgOf(m.guildId).messages; if (!cfg.enabled) return;
    const ch = m.channel; const cid = String(m.channelId);
    if (cfg.channelIds.length && !cfg.channelIds.includes(cid) && !(ch?.parentId && cfg.channelIds.includes(ch.parentId))) return;
    if (seenMsg.has(m.id)) return;                // the same message is never counted twice
    seenMsg.set(m.id, 1);
    if (seenMsg.size > SEEN_MAX) seenMsg.delete(seenMsg.keys().next().value);
    const ts = Number(m.createdTimestamp) || Date.now();
    addMsgDelta({ guildId: m.guildId, channelId: cid, channelName: String(ch?.name || 'unknown'), userId: String(a.id), username: String(a.username || 'unknown'),
      bucket: Math.floor(ts / MSG_BUCKET_MS) * MSG_BUCKET_MS, ts, count: 1 });
  } catch (e) { console.warn('[logging] message event skipped:', e.message); }
}

/* ---- disk writes ---- */
let flushing = false;
const noteLogFail = (e) => {
  logHealth.writeFailures++;
  if (Date.now() - logHealth.lastErrorAt > 60000) console.error('[logging] Could not write logs, will retry:', e.message);
  logHealth.lastErrorAt = Date.now();
};
function takePending() {
  const v = voiceQ; voiceQ = [];
  const m = [...msgPending.values()]; msgPending.clear();
  const per = new Map(); const slot = (g) => per.get(g) || per.set(g, { v: [], m: [] }).get(g);
  v.forEach((e) => slot(e.guildId).v.push(e)); m.forEach((d) => slot(d.guildId).m.push(d));
  return per;
}
const voiceLine = ({ guildId, ...e }) => JSON.stringify({ ...e, guildId });
const msgLine = (d) => JSON.stringify({ k: 'm', bucket: d.bucket, ts: d.ts, userId: d.userId, username: d.username, guildId: d.guildId, channelId: d.channelId, channelName: d.channelName, count: d.count });
async function flushLogs() {
  if (flushing) return; flushing = true;
  try {
    const per = takePending();
    for (const [gid, g] of per) {
      if (!SNOWFLAKE.test(gid)) continue;
      if (g.m.length) broadcast('log:messages', { guildId: gid, items: g.m.map((d) => ({ channelId: d.channelId, channelName: d.channelName, userId: d.userId, username: d.username, ts: d.ts, count: d.count })) });
      for (const [kind, rows, line] of [['voice', g.v, voiceLine], ['msg', g.m, msgLine]]) {
        if (!rows.length) continue;
        const file = logFile(gid, kind);
        try {
          await withFile(file, () => fs.promises.appendFile(file, rows.map(line).join('\n') + '\n', { mode: 0o600 }));
          fs.promises.stat(file).then((s) => { if (s.size > LOG_COMPACT_BYTES) schedulePrune(gid); }).catch(() => {});
        } catch (e) { // keep the rows for the next try; nothing is lost unless the disk keeps failing past the memory cap
          noteLogFail(e);
          if (kind === 'voice') { voiceQ = rows.concat(voiceQ); if (voiceQ.length > LOG_QUEUE_MAX) { logHealth.dropped += voiceQ.length - LOG_QUEUE_MAX; voiceQ = voiceQ.slice(-LOG_QUEUE_MAX); } }
          else rows.forEach(addMsgDelta);
        }
      }
    }
  } catch (e) { noteLogFail(e); } finally { flushing = false; }
}
function flushLogsSync() { // shutdown only: write whatever is pending, ignore failures
  for (const [gid, g] of takePending()) {
    if (!SNOWFLAKE.test(gid)) continue;
    try { if (g.v.length) fs.appendFileSync(logFile(gid, 'voice'), g.v.map(voiceLine).join('\n') + '\n', { mode: 0o600 }); } catch {}
    try { if (g.m.length) fs.appendFileSync(logFile(gid, 'msg'), g.m.map(msgLine).join('\n') + '\n', { mode: 0o600 }); } catch {}
  }
}
setInterval(() => { flushLogs().catch(() => {}); }, LOG_FLUSH_MS).unref();

/* ---- retention: drop old rows, merge message deltas into one row per bucket, cap the row count ---- */
const mergeMsgRows = (rows) => {
  const by = new Map();
  for (const r of rows) {
    if (r.k !== 'm' || !r.userId || !r.channelId) continue;
    const k = `${r.channelId}|${r.userId}|${r.bucket}`, c = by.get(k);
    if (c) { c.count += Number(r.count) || 0; if (r.ts >= c.ts) { c.ts = r.ts; c.username = r.username; c.channelName = r.channelName; } }
    else by.set(k, { ...r, count: Number(r.count) || 0 });
  }
  return [...by.values()];
};
async function pruneGuild(gid) {
  if (!SNOWFLAKE.test(gid)) return;
  const cfg = logCfgOf(gid), cutoff = Date.now() - cfg.retentionDays * 86400000;
  for (const kind of ['voice', 'msg']) {
    const file = logFile(gid, kind);
    await withFile(file, async () => {
      let rows = await readLogLines(file);
      if (!rows.length) { await fs.promises.rm(file, { force: true }); return; }
      if (kind === 'msg') rows = mergeMsgRows(rows).sort((a, b) => a.bucket - b.bucket || a.ts - b.ts);
      rows = rows.filter((r) => (kind === 'msg' ? r.bucket : r.ts) >= cutoff - (kind === 'msg' ? MSG_BUCKET_MS : 0));
      if (rows.length > cfg.maxEntries) rows = rows.slice(-cfg.maxEntries);
      if (!rows.length) { await fs.promises.rm(file, { force: true }); return; }
      const tmp = file + '.tmp'; // atomic rewrite: a crash cannot leave a half-written log
      await fs.promises.writeFile(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    });
  }
}
const prunePending = new Set();
function schedulePrune(gid) {
  if (prunePending.has(gid)) return; prunePending.add(gid);
  setTimeout(() => { prunePending.delete(gid); pruneGuild(gid).catch((e) => console.error('[logging] prune failed:', e.message)); }, 2000).unref();
}
async function pruneAll() {
  let names = []; try { names = await fs.promises.readdir(LOG_DIR); } catch { return; }
  const ids = new Set(names.map((n) => (n.match(/^(\d{5,25})\.(voice|msg)\.jsonl$/) || [])[1]).filter(Boolean));
  for (const gid of ids) { try { await pruneGuild(gid); } catch (e) { console.error('[logging] prune failed:', e.message); } }
}
cron.schedule('17 */6 * * *', () => { pruneAll().catch(() => {}); });
setTimeout(() => { pruneAll().catch(() => {}); }, 60000).unref();

/* ---- HTTP API: every route needs a signed-in admin, this server (403 otherwise) AND the Logging tab ---- */
const LG = (...extra) => [requireAuth, requireGuild, requireTab('logs'), ...extra];
const LH = [requireAuth, requireHead, requireGuild]; // head-only + server check
const validGid = (req) => { if (!SNOWFLAKE.test(String(req.params.gid))) throw httpErr(400, 'Bad server id'); };
const intIn = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}.`); return n; };
function guildChannelLists(guild) {
  const text = [], voice = [];
  guild.channels.cache.forEach((c) => {
    if ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type)) text.push({ id: c.id, name: c.name, pos: c.rawPosition });
    else if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type)) voice.push({ id: c.id, name: c.name, pos: c.rawPosition });
  });
  const strip = (l) => l.sort((a, b) => a.pos - b.pos).map(({ id, name }) => ({ id, name }));
  return { text: strip(text), voice: strip(voice) };
}
const logHealthView = () => ({ pendingVoice: voiceQ.length, pendingMessages: msgPending.size, dropped: logHealth.dropped, writeFailures: logHealth.writeFailures,
  lastWriteError: logHealth.lastErrorAt ? new Date(logHealth.lastErrorAt).toISOString() : null }); // no paths or system messages are exposed
app.get('/api/guilds/:gid/logging/config', ...LG(), wrap(async (req, res) => {
  validGid(req);
  const guild = await getGuild(req.params.gid);
  res.json({ config: logCfgOf(guild.id), limits: LOG_LIM, channels: guildChannelLists(guild), health: logHealthView() });
}));
app.put('/api/guilds/:gid/logging/config', ...LG(), wrap(async (req, res) => {
  validGid(req);
  const guild = await getGuild(req.params.gid);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const lists = guildChannelLists(guild), cur = logCfgOf(guild.id), next = JSON.parse(JSON.stringify(cur));
  for (const [key, pool, label] of [['voice', lists.voice, 'voice'], ['messages', lists.text, 'text']]) {
    if (b[key] === undefined) continue;
    const s = b[key]; if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad(`Invalid ${key} settings.`);
    if (s.enabled !== undefined) { if (typeof s.enabled !== 'boolean') throw bad(`${key}.enabled must be true or false.`); next[key].enabled = s.enabled; }
    if (s.channelIds !== undefined) {
      if (!Array.isArray(s.channelIds) || s.channelIds.length > LOG_LIM.chanMax) throw bad(`Choose at most ${LOG_LIM.chanMax} ${label} channels.`);
      const ids = [...new Set(s.channelIds.map(String))];
      if (ids.some((i) => !pool.some((c) => c.id === i))) throw bad(`Every selected channel must be a ${label} channel of this server.`);
      next[key].channelIds = ids;
    }
  }
  if (b.retentionDays !== undefined) next.retentionDays = intIn(b.retentionDays, LOG_LIM.retMin, LOG_LIM.retMax, 'Retention (days)');
  if (b.maxEntries !== undefined) next.maxEntries = intIn(b.maxEntries, LOG_LIM.entMin, LOG_LIM.entMax, 'Maximum entries');
  const before = store.logCfg[guild.id];
  store.logCfg[guild.id] = next;
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); } // not saveStore(): a failed save must be reported and rolled back
  catch (e) { if (before) store.logCfg[guild.id] = before; else delete store.logCfg[guild.id]; console.error('[logging] Could not save settings:', e.message); throw httpErr(500, 'Could not save to storage. Nothing was changed.'); }
  if (next.retentionDays < cur.retentionDays || next.maxEntries < cur.maxEntries) schedulePrune(guild.id);
  res.json({ ok: true, config: next });
}));
const qNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const qId = (v) => { if (v === undefined || v === '') return null; if (!SNOWFLAKE.test(String(v))) throw bad('Bad id filter.'); return String(v); };
const qText = (v) => { const t = String(v ?? '').trim().toLowerCase().slice(0, 64); return t || null; };
const qOff = (v) => Math.min(1e6, Math.max(0, Math.round(Number(v)) || 0));
const userHit = (r, q) => !q || r.userId === q || String(r.username || '').toLowerCase().includes(q); // user filter: exact id or part of the username
app.get('/api/guilds/:gid/logging/voice', ...LG(), wrap(async (req, res) => {
  validGid(req); await getGuild(req.params.gid);
  const limit = Math.min(500, Math.max(1, Math.round(Number(req.query.limit)) || 100)), offset = qOff(req.query.offset);
  const uid = qId(req.query.userId), q = qText(req.query.q), cid = qId(req.query.channelId), before = qNum(req.query.before), since = qNum(req.query.since), until = qNum(req.query.until);
  const type = req.query.type ? String(req.query.type).toUpperCase() : null;
  if (type && !['JOIN', 'LEAVE', 'MOVE'].includes(type)) throw bad('type must be JOIN, LEAVE or MOVE.');
  await flushLogs();
  const file = logFile(req.params.gid, 'voice');
  const rows = (await withFile(file, () => readLogLines(file))).filter((r) => r.k === 'v' && (!uid || r.userId === uid) && userHit(r, q) && (!cid || r.channelId === cid || r.fromChannelId === cid)
    && (!type || r.type === type) && (!before || r.ts < before) && (!since || r.ts >= since) && (!until || r.ts <= until));
  rows.forEach((r, i) => { r._i = i; }); // same-millisecond events keep their written order (newest = written last)
  rows.sort((a, b) => b.ts - a.ts || b._i - a._i);
  const counts = { JOIN: 0, LEAVE: 0, MOVE: 0 }; rows.forEach((r) => { if (counts[r.type] !== undefined) counts[r.type]++; });
  const page = rows.slice(offset, offset + limit).map(({ _i, ...r }) => ({ ...r, time: new Date(r.ts).toISOString() }));
  res.json({ entries: page, total: rows.length, counts, offset, limit, nextBefore: rows.length > offset + limit ? page[page.length - 1].ts : null });
}));
app.get('/api/guilds/:gid/logging/messages', ...LG(), wrap(async (req, res) => {
  validGid(req); await getGuild(req.params.gid);
  const limit = Math.min(500, Math.max(1, Math.round(Number(req.query.limit)) || 100)), offset = qOff(req.query.offset);
  const uid = qId(req.query.userId), q = qText(req.query.q), cid = qId(req.query.channelId), since = qNum(req.query.since), until = qNum(req.query.until);
  const tz = Math.min(840, Math.max(-840, Math.round(Number(req.query.tzOffset)) || 0)); // minutes, as in Date.getTimezoneOffset(): used to cut days in the viewer's time
  await flushLogs();
  const file = logFile(req.params.gid, 'msg');
  const rows = mergeMsgRows(await withFile(file, () => readLogLines(file))).filter((r) => (!uid || r.userId === uid) && userHit(r, q) && (!cid || r.channelId === cid)
    && (!since || r.ts >= since) && (!until || r.ts <= until));
  const sum = (keyOf, extra) => { const m = new Map(); rows.forEach((r) => { const c = m.get(keyOf(r)) || m.set(keyOf(r), { ...extra(r), count: 0 }).get(keyOf(r)); c.count += r.count; }); return [...m.values()].sort((a, b) => b.count - a.count); };
  // activity over time: per hour when the data spans 3 days or less, otherwise per day (day edges follow the viewer's time zone)
  let series = [], unit = 'hour';
  if (rows.length) {
    let lo = Infinity, hi = -Infinity; for (const r of rows) { if (r.bucket < lo) lo = r.bucket; if (r.bucket > hi) hi = r.bucket; }
    unit = hi - lo <= 72 * 3600000 ? 'hour' : 'day';
    const size = unit === 'hour' ? 3600000 : 86400000, off = unit === 'day' ? tz * 60000 : 0, m = new Map();
    rows.forEach((r) => { const k = Math.floor((r.bucket - off) / size); m.set(k, (m.get(k) || 0) + r.count); });
    const k0 = Math.floor((lo - off) / size), k1 = Math.floor((hi - off) / size);
    for (let k = k0; k <= k1 && series.length < 400; k++) series.push({ t: k * size + off, count: m.get(k) || 0 }); // empty slots are filled so the chart has no gaps
  }
  rows.sort((a, b) => b.bucket - a.bucket || b.ts - a.ts);
  res.json({
    buckets: rows.slice(offset, offset + limit).map((r) => ({ bucket: r.bucket, ts: r.ts, time: new Date(r.ts).toISOString(), guildId: r.guildId, userId: r.userId, username: r.username, channelId: r.channelId, channelName: r.channelName, count: r.count })),
    totalBuckets: rows.length, offset, limit,
    totalMessages: rows.reduce((n, r) => n + r.count, 0),
    byUser: sum((r) => r.userId, (r) => ({ userId: r.userId, username: r.username })).slice(0, 100),
    byChannel: sum((r) => r.channelId, (r) => ({ channelId: r.channelId, channelName: r.channelName })).slice(0, 100),
    series, unit,
  });
}));
app.post('/api/guilds/:gid/logging/clear', ...LH, wrap(async (req, res) => { // head admin only: deletes stored logs of this server
  validGid(req);
  const kind = String(req.body?.kind || 'all');
  if (!['voice', 'messages', 'all'].includes(kind)) throw bad('kind must be voice, messages or all.');
  await flushLogs();
  for (const [k, f] of [['voice', 'voice'], ['messages', 'msg']]) if (kind === 'all' || kind === k) { const file = logFile(req.params.gid, f); await withFile(file, () => fs.promises.rm(file, { force: true })); }
  res.json({ ok: true });
}));


/* ------------------------- Inbox (Stage 5A): bot DMs ----------------------- */
// Unlike Logging, Inbox DOES store message text, because its whole purpose is to show conversations. Only DMs are collected (never servers).
// Storage (same DATA_DIR rules as everything else): DATA_DIR/inbox/index.json = one small record per conversation (profile, last message,
// unread counter), DATA_DIR/inbox/msgs/<userId>.jsonl = append-only message history of ONE user (never loaded whole into memory).
const INBOX_DIR = path.join(DATA_ROOT, 'inbox');
const INBOX_MSG_DIR = path.join(INBOX_DIR, 'msgs');
const INBOX_INDEX = path.join(INBOX_DIR, 'index.json');
const INBOX_LIM = { maxConvs: 2000, maxMsgs: 2000, pageDef: 50, pageMax: 100, contentMax: 4000, previewMax: 120, attMax: 10, compactBytes: 1.5 * 1024 * 1024,
  readMax: 8 * 1024 * 1024, queueMax: 5000, seenMax: 5000, textMax: 64 * 1024, textDeclaredMax: 512 * 1024 };
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const OUT_SOURCES = new Set(['web', 'auto-fixed', 'auto-ai']); // Stage 5B: where a bot message in a DM came from
try { fs.mkdirSync(INBOX_MSG_DIR, { recursive: true }); } catch (e) { console.error('[inbox] Could not create inbox folder:', e.message); }
const inbox = new Map(); // userId -> conversation record (metadata only)
const inboxHealth = { dropped: 0, writeFailures: 0 };
const toBig = (id) => { try { return BigInt(id); } catch { return 0n; } };
const idCmp = (a, b) => { const x = toBig(a), y = toBig(b); return x < y ? -1 : x > y ? 1 : 0; };
const cdnUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && !x.username && !x.password && CDN_HOSTS.has(x.hostname) ? x.href : ''; } catch { return ''; } };
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
const cleanConv = (c) => (c && typeof c === 'object' && SNOWFLAKE.test(String(c.userId)) ? {
  userId: String(c.userId), channelId: SNOWFLAKE.test(String(c.channelId)) ? String(c.channelId) : '',
  username: cleanText(c.username, 80) || 'Unknown user', displayName: cleanText(c.displayName, 80), avatar: cdnUrl(c.avatar),
  firstTs: Number(c.firstTs) || 0, lastTs: Number(c.lastTs) || 0, lastId: SNOWFLAKE.test(String(c.lastId)) ? String(c.lastId) : '',
  lastPreview: cleanText(c.lastPreview, INBOX_LIM.previewMax), lastDir: c.lastDir === 'out' ? 'out' : 'in',
  unread: Math.max(0, Math.floor(Number(c.unread)) || 0), count: Math.max(0, Math.floor(Number(c.count)) || 0),
  ids: Array.isArray(c.ids) ? c.ids.filter((i) => SNOWFLAKE.test(String(i))).map(String).slice(-30) : [],
} : null);
try {
  if (fs.existsSync(INBOX_INDEX)) for (const c of JSON.parse(fs.readFileSync(INBOX_INDEX, 'utf8')).convs || []) { const k = cleanConv(c); if (k) inbox.set(k.userId, k); }
} catch (e) { console.error('[inbox] Could not read index.json:', e.message); }

const inboxMsgFile = (uid) => path.join(INBOX_MSG_DIR, `${uid}.jsonl`); // uid is always a validated snowflake before it gets here
const inboxUnreadTotal = () => { let n = 0; for (const c of inbox.values()) n += c.unread; return n; };
const convView = (c) => ({ userId: c.userId, channelId: c.channelId, username: c.username, displayName: c.displayName, avatar: c.avatar, lastTs: c.lastTs,
  lastPreview: c.lastPreview, lastDir: c.lastDir, unread: c.unread, count: c.count });
const msgView = (r) => ({ id: r.id, userId: r.uid, channelId: r.cid, dir: r.d, ts: r.ts, username: r.un, content: r.c, source: r.s || '', by: r.b || '', // Stage 5B: who sent a bot message ('web' = an admin, 'auto-fixed' / 'auto-ai' = auto-reply)
  attachments: (r.a || []).map((a) => ({ id: a.id, name: a.name, size: a.size, type: a.type, url: a.url, width: a.w, height: a.h,
    kind: /^image\/(png|jpe?g|gif|webp)$/i.test(a.type) && a.url ? 'image' : (isTextAtt(a) ? 'text' : 'file') })) });
const isTextAtt = (a) => !!a.url && a.size <= INBOX_LIM.textDeclaredMax && (/^text\/plain\b/i.test(a.type) || /\.txt$/i.test(a.name));

/* ---- writes: Discord events only touch memory; a timer writes to disk ---- */
let inboxQ = [];            // { uid, line } waiting for the next disk write
let inboxIdxDirty = false, inboxTimer = null;
const inboxSeen = new Set(); // recent message ids: one message is never stored or counted twice
function inboxSchedule() { if (!inboxTimer) { inboxTimer = setTimeout(() => { inboxTimer = null; flushInbox().catch((e) => console.warn('[inbox] flush:', e.message)); }, 1000); inboxTimer.unref?.(); } }
function writeInboxIndexSync() {
  const tmp = INBOX_INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, convs: [...inbox.values()] }), { mode: 0o600 });
  fs.renameSync(tmp, INBOX_INDEX);
}
let inboxFlushing = null;
function flushInbox() { // serialised: messages first, then the index (so the index never points at messages that were not written)
  if (inboxFlushing) return inboxFlushing.then(() => flushInbox());
  inboxFlushing = (async () => {
    const batch = inboxQ; inboxQ = [];
    const by = new Map();
    for (const q of batch) (by.get(q.uid) || by.set(q.uid, []).get(q.uid)).push(q.line);
    for (const [uid, lines] of by) {
      const file = inboxMsgFile(uid);
      try {
        await withFile(file, async () => {
          await fs.promises.appendFile(file, lines.join('\n') + '\n', { mode: 0o600 });
          if ((await fs.promises.stat(file)).size > INBOX_LIM.compactBytes) await compactInbox(uid);
        });
      } catch (e) {
        inboxHealth.writeFailures++; console.warn('[inbox] write failed:', e.message);
        inboxQ = lines.map((line) => ({ uid, line })).concat(inboxQ); // try again on the next round
      }
    }
    if (inboxQ.length > INBOX_LIM.queueMax) { inboxHealth.dropped += inboxQ.length - INBOX_LIM.queueMax; inboxQ = inboxQ.slice(-INBOX_LIM.queueMax); }
    if (inboxIdxDirty) {
      inboxIdxDirty = false;
      try { await fs.promises.mkdir(INBOX_DIR, { recursive: true }); writeInboxIndexSync(); } catch (e) { inboxIdxDirty = true; inboxHealth.writeFailures++; console.warn('[inbox] index write failed:', e.message); }
    }
    if (inboxQ.length || inboxIdxDirty) inboxSchedule();
  })().finally(() => { inboxFlushing = null; });
  return inboxFlushing;
}
function flushInboxSync() { // shutdown only
  try {
    const by = new Map();
    for (const q of inboxQ) (by.get(q.uid) || by.set(q.uid, []).get(q.uid)).push(q.line);
    for (const [uid, lines] of by) fs.appendFileSync(inboxMsgFile(uid), lines.join('\n') + '\n', { mode: 0o600 });
    inboxQ = [];
    if (inboxIdxDirty) { writeInboxIndexSync(); inboxIdxDirty = false; }
  } catch (e) { console.error('[inbox] shutdown save failed:', e.message); }
}
async function compactInbox(uid) { // inside withFile(): keep only the newest messages, atomically
  const file = inboxMsgFile(uid);
  const rows = inboxClean(await readLogLines(file));
  const keep = rows.slice(-INBOX_LIM.maxMsgs);
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  const c = inbox.get(uid); if (c) { c.count = keep.length; inboxIdxDirty = true; }
}
function inboxClean(rows) { // valid rows only, no duplicates, oldest first
  const m = new Map();
  for (const r of rows) {
    if (!r || !SNOWFLAKE.test(String(r.id)) || !SNOWFLAKE.test(String(r.uid)) || (r.d !== 'in' && r.d !== 'out')) continue;
    m.set(String(r.id), { id: String(r.id), cid: String(r.cid || ''), uid: String(r.uid), d: r.d, ts: Number(r.ts) || 0, un: cleanText(r.un, 80), c: cleanText(r.c, INBOX_LIM.contentMax),
      s: r.d === 'out' && OUT_SOURCES.has(r.s) ? r.s : '', b: r.d === 'out' ? cleanText(r.b, 60) : '',
      a: Array.isArray(r.a) ? r.a.slice(0, INBOX_LIM.attMax).map((a) => ({ id: String(a?.id || ''), name: cleanText(a?.name, 120), size: Number(a?.size) || 0, type: cleanText(a?.type, 100), url: cdnUrl(a?.url), w: Number(a?.w) || 0, h: Number(a?.h) || 0 })) : [] });
  }
  return [...m.values()].sort((a, b) => idCmp(a.id, b.id));
}
function pruneInbox() { // memory and disk stay bounded: the conversations with the oldest activity go first
  if (inbox.size <= INBOX_LIM.maxConvs) return;
  const old = [...inbox.values()].sort((a, b) => a.lastTs - b.lastTs).slice(0, inbox.size - INBOX_LIM.maxConvs);
  for (const c of old) { inbox.delete(c.userId); inboxQ = inboxQ.filter((q) => q.uid !== c.userId); /* queued lines must not re-create the file */ const f = inboxMsgFile(c.userId); withFile(f, () => fs.promises.rm(f, { force: true })).catch(() => {}); }
}

/** Discord DM event (messageCreate). Servers are never collected. Safe with partial users / channels.
 *  Stage 5B: the bot's own sends call it again with forceUid (+ outTag); the message-id check below makes sure a message that also arrives
 *  from the gateway is stored, counted and shown exactly once, whichever of the two comes first. Returns the stored record or null. */
const outTags = new Map(); // nonce -> { s, b, t }: lets the gateway copy of the bot's own message pick up the same tag
function inboxHandle(m, forceUid, outTag) {
  if (!m || m.guildId || m.system || !client?.user || !SNOWFLAKE.test(String(m.id))) return null;
  const ch = m.channel;
  if (!forceUid && (!ch || ch.type !== ChannelType.DM)) return null;
  const mine = m.author?.id === client.user.id;
  if (forceUid && !mine) return null; // forceUid is only for messages the bot itself sent
  if (!mine && (!m.author || m.author.bot)) return null;
  const uid = String(forceUid || (mine ? (ch.recipientId || ch.recipient?.id || '') : m.author.id));
  if (!SNOWFLAKE.test(uid)) return null; // the other person is unknown: it cannot be filed under anyone
  if (inboxSeen.has(m.id)) return null;
  let c = inbox.get(uid);
  if (c?.ids.includes(m.id)) return null;
  inboxSeen.add(m.id); if (inboxSeen.size > INBOX_LIM.seenMax) inboxSeen.delete(inboxSeen.values().next().value);
  const ts = Number(m.createdTimestamp) || Date.now();
  const user = mine ? (ch?.recipient || null) : m.author;
  const chId = String(ch?.id || m.channelId || '');
  if (!c) {
    c = cleanConv({ userId: uid, channelId: chId, username: user?.username || 'Unknown user', firstTs: ts });
    inbox.set(uid, c);
  }
  if (user?.username) c.username = cleanText(user.username, 80) || c.username;
  if (user) { c.displayName = cleanText(user.globalName, 80); try { const av = cdnUrl(user.displayAvatarURL?.({ extension: 'png', size: 128 })); if (av) c.avatar = av; } catch {} }
  c.channelId = SNOWFLAKE.test(chId) ? chId : c.channelId;
  const atts = [...(m.attachments?.values?.() || [])].slice(0, INBOX_LIM.attMax).map((a) => ({
    id: String(a.id), name: cleanText(a.name, 120) || 'file', size: Number(a.size) || 0, type: cleanText(a.contentType, 100), url: cdnUrl(a.url), w: Number(a.width) || 0, h: Number(a.height) || 0 }));
  const content = cleanText(m.content, INBOX_LIM.contentMax);
  const rec = { id: String(m.id), cid: c.channelId, uid, d: mine ? 'out' : 'in', ts, un: mine ? cleanText(client.user.username, 80) : c.username, c: content, a: atts };
  if (mine) { // Stage 5B: attribution of the bot's own messages (web admin / auto-reply)
    const tag = outTag || (m.nonce != null ? outTags.get(String(m.nonce)) : null);
    if (tag && OUT_SOURCES.has(tag.s)) { rec.s = tag.s; rec.b = cleanText(tag.b, 60); }
  }
  c.count++; c.ids.push(rec.id); if (c.ids.length > 30) c.ids.shift();
  if (idCmp(rec.id, c.lastId) > 0) { // an older message arriving late must not replace the latest preview
    c.lastId = rec.id; c.lastTs = ts; c.lastDir = rec.d;
    c.lastPreview = (content.replace(/\s+/g, ' ').trim() || (atts.length ? '[Attachment] ' + atts[0].name : '[No text]')).slice(0, INBOX_LIM.previewMax);
  }
  if (!mine) c.unread++; // counted once: duplicates were refused above
  inboxQ.push({ uid, line: JSON.stringify(rec) }); inboxIdxDirty = true; inboxSchedule();
  pruneInbox();
  broadcast('inbox:message', { userId: uid, message: msgView(rec), conversation: convView(c), unreadTotal: inboxUnreadTotal() });
  return rec;
}
function inboxMarkRead(uid) {
  const c = inbox.get(uid);
  if (!c) return null;
  if (c.unread) { c.unread = 0; inboxIdxDirty = true; inboxSchedule(); broadcast('inbox:read', { userId: uid, unreadTotal: inboxUnreadTotal() }); }
  return c;
}
const inboxSummary = () => ({ unreadTotal: inboxUnreadTotal(), conversationCount: inbox.size });

/* ---- reads ---- */
async function inboxRows(uid) { await flushInbox().catch(() => {}); const f = inboxMsgFile(uid); return inboxClean(await withFile(f, () => readLogLines(f))); }
const inboxUid = (req) => { const u = String(req.params.uid); if (!SNOWFLAKE.test(u)) throw httpErr(400, 'Bad user id'); return u; };
const IN = T('inbox'); // signed in + Inbox tab: checked on the server for every request (401 / 403 before anything is read)
app.get('/api/inbox/summary', ...IN, wrap(async (_req, res) => { res.json(inboxSummary()); }));
app.get('/api/inbox/conversations', ...IN, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 100));
  let list = [...inbox.values()];
  if (q) list = list.filter((c) => c.username.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q) || c.userId === q);
  list.sort((a, b) => b.lastTs - a.lastTs);
  res.json({ conversations: list.slice(0, limit).map(convView), total: list.length, ...inboxSummary(), health: { dropped: inboxHealth.dropped, writeFailures: inboxHealth.writeFailures } });
}));
app.get('/api/inbox/conversations/:uid/messages', ...IN, wrap(async (req, res) => {
  const uid = inboxUid(req), c = inbox.get(uid);
  if (!c) throw httpErr(404, 'Conversation not found');
  const limit = Math.min(INBOX_LIM.pageMax, Math.max(1, Math.floor(Number(req.query.limit)) || INBOX_LIM.pageDef));
  const before = req.query.before === undefined || req.query.before === '' ? null : String(req.query.before);
  if (before !== null && !SNOWFLAKE.test(before)) throw httpErr(400, 'Bad cursor');
  let rows = await inboxRows(uid);
  if (before) rows = rows.filter((r) => idCmp(r.id, before) < 0);
  const hasMore = rows.length > limit;
  res.json({ conversation: convView(c), messages: rows.slice(-limit).map(msgView), hasMore, limit }); // oldest first, ordered by message id (= creation time)
}));
app.post('/api/inbox/conversations/:uid/read', ...IN, wrap(async (req, res) => {
  const uid = inboxUid(req);
  if (!inboxMarkRead(uid)) throw httpErr(404, 'Conversation not found');
  res.json({ ok: true, ...inboxSummary() });
}));
/** Safe preview of a plain-text attachment: stored link only, Discord CDN hosts only, no redirects, hard size cap, shown as text (never as HTML). */
app.get('/api/inbox/conversations/:uid/messages/:mid/attachments/:aid/text', ...IN, wrap(async (req, res) => {
  const uid = inboxUid(req), mid = String(req.params.mid), aid = String(req.params.aid);
  if (!SNOWFLAKE.test(mid) || !SNOWFLAKE.test(aid)) throw httpErr(400, 'Bad id');
  if (!inbox.has(uid)) throw httpErr(404, 'Conversation not found');
  const msg = (await inboxRows(uid)).find((r) => r.id === mid);
  const att = msg?.a.find((a) => a.id === aid);
  if (!att) throw httpErr(404, 'Attachment not found');
  if (!isTextAtt(att)) throw httpErr(415, 'Only small plain-text files can be previewed.');
  let r;
  try { r = await fetch(att.url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'text/plain' } }); }
  catch { throw httpErr(502, 'Could not load the file. Discord attachment links expire after a while.'); }
  if (!r.ok || !r.body) throw httpErr(502, 'The attachment link is no longer available (Discord links expire).');
  const chunks = []; let got = 0, truncated = false;
  for await (const part of r.body) {
    got += part.length;
    if (got > INBOX_LIM.textMax) { chunks.push(part.subarray(0, part.length - (got - INBOX_LIM.textMax))); truncated = true; break; }
    chunks.push(part);
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.json({ text: cleanText(Buffer.concat(chunks).toString('utf8'), INBOX_LIM.textMax).replace(/\uFFFD/g, '?'), truncated });
}));

/* ------------------- Inbox (Stage 5B): website replies + auto-reply ------------------- */
// Everything here sits on top of Stage 5A and is reached only through the Inbox routes (T('inbox') = signed in + Inbox tab, 401 / 403 before anything runs).
// Settings: DATA_DIR/inbox/autoreply.json. Per-user cooldown stamps: DATA_DIR/inbox/cooldowns.json (both atomic writes, mode 0600).
// The AI answer uses the EXISTING AI integration (provider, model and key from the AI tab, via askAI); no other service is called.
const AR_FILE = path.join(INBOX_DIR, 'autoreply.json');
const AR_CD_FILE = path.join(INBOX_DIR, 'cooldowns.json');
const AR_LIM = { textMax: 2000, promptMax: 1500, ctxMax: 10, ctxDef: 4, cdMin: 10, cdMax: 7 * 86400, cdDef: 300, aiMs: 30000, staleMs: 120000, aiRetryMs: 60000,
  globalMax: 120, globalWinMs: 3600000, cdKeep: 20000, sendWinMs: 30000, sendMax: 15, idemMs: 120000 };
const AR_DEF = { enabled: false, mode: 'fixed', text: '', aiPrompt: '', aiContext: AR_LIM.ctxDef, cooldownSec: AR_LIM.cdDef, updatedAt: 0, updatedBy: '' };
const arInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function arClean(raw) { // tolerant: used for the file on disk, so a damaged file can never switch auto-reply on with strange values
  const r = raw && typeof raw === 'object' ? raw : {};
  return { enabled: r.enabled === true, mode: r.mode === 'ai' ? 'ai' : 'fixed', text: cleanText(r.text, AR_LIM.textMax).trim(), aiPrompt: cleanText(r.aiPrompt, AR_LIM.promptMax).trim(),
    aiContext: arInt(r.aiContext, 0, AR_LIM.ctxMax, AR_LIM.ctxDef), cooldownSec: arInt(r.cooldownSec, AR_LIM.cdMin, AR_LIM.cdMax, AR_LIM.cdDef),
    updatedAt: Number(r.updatedAt) || 0, updatedBy: cleanText(r.updatedBy, 60) };
}
let arCfg = { ...AR_DEF };
try { if (fs.existsSync(AR_FILE)) arCfg = arClean(JSON.parse(fs.readFileSync(AR_FILE, 'utf8'))); }
catch (e) { console.error('[auto-reply] Could not read autoreply.json, auto-reply stays OFF:', e.message); arCfg = { ...AR_DEF }; }
function arWriteCfg(cfg) { const tmp = AR_FILE + '.tmp'; fs.mkdirSync(INBOX_DIR, { recursive: true }); fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...cfg }), { mode: 0o600 }); fs.renameSync(tmp, AR_FILE); }

/* ---- per-user cooldown (persistent) ---- */
const arCd = new Map(); // userId -> time of the last auto-reply attempt for that user
try { if (fs.existsSync(AR_CD_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(AR_CD_FILE, 'utf8')).t || {})) if (SNOWFLAKE.test(k) && Number.isFinite(Number(v))) arCd.set(k, Number(v)); }
catch (e) { console.error('[auto-reply] Could not read cooldowns.json (cooldowns start empty):', e.message); }
let arCdDirty = false, arCdTimer = null;
function arCdFlush() { // sync and tiny; also called on shutdown
  if (!arCdDirty) return;
  const now = Date.now();
  for (const [k, t] of arCd) if (now - t > AR_LIM.cdMax * 1000) arCd.delete(k); // older than the longest possible cooldown: no longer matters
  if (arCd.size > AR_LIM.cdKeep) for (const [k] of [...arCd].sort((a, b) => a[1] - b[1]).slice(0, arCd.size - AR_LIM.cdKeep)) arCd.delete(k);
  const tmp = AR_CD_FILE + '.tmp';
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, t: Object.fromEntries(arCd) }), { mode: 0o600 });
  fs.renameSync(tmp, AR_CD_FILE);
  arCdDirty = false;
}
function arCdSchedule() {
  arCdDirty = true;
  if (arCdTimer) return;
  arCdTimer = setTimeout(() => { arCdTimer = null; try { arCdFlush(); } catch (e) { console.warn('[auto-reply] cooldown save failed:', e.message); arCdTimer = setTimeout(() => { arCdTimer = null; try { arCdFlush(); } catch {} }, 10000); arCdTimer.unref?.(); } }, 2000);
  arCdTimer.unref?.();
}
const arRemainingMs = (uid, cfg = arCfg) => { const cd = cfg.cooldownSec * 1000, t = arCd.get(uid) || 0; return Math.max(0, Math.min(cd, t + cd - Date.now())); }; // a stamp from the future (clock change) can never block longer than one cooldown
const arStamp = (uid, t = Date.now()) => { arCd.set(uid, t); arCdSchedule(); };
const arUnstamp = (uid, prev) => { if (prev) arCd.set(uid, prev); else arCd.delete(uid); arCdSchedule(); };

/* ---- view + live sync ---- */
const arStats = { sent: 0, failed: 0, cooldownSkips: 0, lastSentAt: 0, lastError: '', lastErrorAt: 0 }; // this run only
const arView = () => ({ settings: { ...arCfg }, stats: { ...arStats }, aiReady: !!store.ai.apiKey, aiProvider: store.ai.provider, aiModel: store.ai.model || AI_MODELS[store.ai.provider] || '',
  limits: { textMax: AR_LIM.textMax, promptMax: AR_LIM.promptMax, ctxMax: AR_LIM.ctxMax, cdMin: AR_LIM.cdMin, cdMax: AR_LIM.cdMax } });
const arPush = () => { try { broadcast('inbox:autoreply', arView()); } catch {} };
const arFail = (msg) => { arStats.failed++; arStats.lastError = cleanText(msg, 220); arStats.lastErrorAt = Date.now(); console.warn('[auto-reply]', arStats.lastError); };

/* ---- settings routes ---- */
const arByName = (s) => (s.role === 'head' ? 'Head admin' : (subOf(s)?.name || 'Co-admin'));
app.get('/api/inbox/autoreply', ...IN, wrap(async (_req, res) => { res.json(arView()); }));
app.post('/api/inbox/autoreply', ...IN, wrap(async (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw httpErr(400, 'Bad request.');
  const num = (v, lo, hi, label) => { const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v) : NaN); if (!Number.isInteger(n) || n < lo || n > hi) throw httpErr(400, `${label} must be a whole number from ${lo} to ${hi}.`); return n; };
  const str = (v, max, label) => { if (typeof v !== 'string') throw httpErr(400, `${label} must be text.`); if (v.length > max) throw httpErr(400, `${label} is too long (${v.length} characters, the limit is ${max}).`); return cleanText(v, max).trim(); };
  const next = { ...arCfg };
  if ('enabled' in b) { if (typeof b.enabled !== 'boolean') throw httpErr(400, 'Auto-reply on/off must be true or false.'); next.enabled = b.enabled; }
  if ('mode' in b) { if (b.mode !== 'fixed' && b.mode !== 'ai') throw httpErr(400, 'Reply mode must be Fixed Text or AI Answer.'); next.mode = b.mode; }
  if ('text' in b) next.text = str(b.text, AR_LIM.textMax, 'The fixed reply text');
  if ('aiPrompt' in b) next.aiPrompt = str(b.aiPrompt, AR_LIM.promptMax, 'The AI instructions');
  if ('aiContext' in b) next.aiContext = num(b.aiContext, 0, AR_LIM.ctxMax, 'Context messages');
  if ('cooldownSec' in b) next.cooldownSec = num(b.cooldownSec, AR_LIM.cdMin, AR_LIM.cdMax, 'The cooldown (seconds)');
  if (next.enabled && next.mode === 'fixed' && !next.text) throw httpErr(400, 'Write the fixed reply text before turning auto-reply on.');
  if (next.enabled && next.mode === 'ai' && !store.ai.apiKey) throw httpErr(400, 'AI mode needs an AI key. The head admin can add one in the AI tab.');
  next.updatedAt = Date.now(); next.updatedBy = arByName(req.admin);
  try { arWriteCfg(next); } catch (e) { console.error('[auto-reply] could not save settings:', e.message); throw httpErr(500, 'Could not save to storage. Nothing was changed.'); } // saved first, then switched
  arCfg = next;
  const v = arView(); arPush();
  res.json(v);
}));

/* ---- sending a DM through the bot (website reply + auto-reply share this) ---- */
function inboxTagQueued(uid, id, tag) { // the gateway copy of our own message won the race and is still waiting for the disk: add the tag to it
  const needle = `"id":"${id}"`;
  for (const q of inboxQ) if (q.uid === uid && q.line.includes(needle)) { try { const r = JSON.parse(q.line); if (r.d === 'out' && !r.s) { r.s = tag.s; r.b = cleanText(tag.b, 60); q.line = JSON.stringify(r); } } catch {} }
}
async function dmSend(uid, content, tag) {
  ensureReady();
  const nonce = crypto.randomBytes(9).toString('base64url'); // Discord echoes it back (message.nonce) and refuses a repeat of the same nonce
  outTags.set(nonce, tag);
  const drop = setTimeout(() => outTags.delete(nonce), 60000); drop.unref?.();
  const toHttp = (e) => { const m = mapDiscordErr(e); return m !== e ? m : httpErr(502, 'Discord could not deliver the message: ' + cleanText(e?.message || 'unknown error', 160)); }; // never a raw 401 / 403 from Discord: the dashboard would think the session ended
  let user, sent;
  try { user = await client.users.fetch(uid); } catch (e) { throw toHttp(e); }
  try { sent = await user.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } }); } catch (e) { throw toHttp(e); }
  let rec = inboxHandle(sent, uid, tag); // stored + broadcast now (the gateway copy is ignored by the message-id check)
  if (!rec) { // the gateway copy arrived first and was stored already
    inboxTagQueued(uid, String(sent.id), tag);
    rec = { id: String(sent.id), cid: String(sent.channelId || ''), uid, d: 'out', ts: Number(sent.createdTimestamp) || Date.now(), un: cleanText(client.user.username, 80), c: cleanText(sent.content, INBOX_LIM.contentMax), a: [], s: tag.s, b: cleanText(tag.b, 60) };
  }
  return { rec, conv: inbox.get(uid) || null };
}

const sendLog = new Map(); // admin id -> times of recent website sends (burst limit)
const sendIdem = new Map(); // adminId|userId|clientId -> { state: 'pending' | 'done', at, body }: one click / one retry is delivered once
app.post('/api/inbox/conversations/:uid/send', ...IN, wrap(async (req, res) => {
  const uid = inboxUid(req);
  if (!inbox.has(uid)) throw httpErr(404, 'Conversation not found'); // replies go only to people who already have a conversation: never to an arbitrary id
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof b.content !== 'string') throw httpErr(400, 'Write a message first.');
  const content = cleanText(b.content, 100000).trim();
  if (!content) throw httpErr(400, 'Write a message first.');
  if (content.length > AR_LIM.textMax) throw httpErr(400, `The message is too long (${content.length} characters). Discord allows ${AR_LIM.textMax}.`);
  let key = null;
  if (b.clientId !== undefined && b.clientId !== null) {
    if (typeof b.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.clientId)) throw httpErr(400, 'Bad request id.');
    key = `${req.admin.id}|${uid}|${b.clientId}`;
    const now0 = Date.now();
    for (const [k, v] of sendIdem) if (now0 - v.at > AR_LIM.idemMs) sendIdem.delete(k);
    const hit = sendIdem.get(key);
    if (hit) { if (hit.state === 'pending') throw httpErr(409, 'This message is already being sent.'); return res.json({ ...hit.body, duplicate: true }); } // same click / retry: answer again, send nothing
  }
  const now = Date.now(), times = (sendLog.get(req.admin.id) || []).filter((t) => now - t < AR_LIM.sendWinMs);
  if (times.length >= AR_LIM.sendMax) { sendLog.set(req.admin.id, times); throw httpErr(429, 'You are sending too fast. Wait a few seconds.'); }
  times.push(now); sendLog.set(req.admin.id, times);
  if (key) sendIdem.set(key, { state: 'pending', at: now });
  try {
    const { rec, conv } = await dmSend(uid, content, { s: 'web', b: arByName(req.admin) });
    if (arCfg.enabled) arStamp(uid); // a person has just answered: the bot stays quiet for this user for one cooldown
    const body = { ok: true, message: msgView(rec), conversation: conv ? convView(conv) : null };
    if (key) sendIdem.set(key, { state: 'done', at: Date.now(), body });
    res.json(body);
  } catch (e) { if (key) sendIdem.delete(key); throw e; } // a failed send can be tried again
}));

/* ---- auto-reply on incoming DMs ---- */
const arSeen = new Set(); // message ids already looked at: the same DM event is never answered twice
const arBusy = new Set(); // users with a reply in progress (an AI answer can take a while): no overlapping replies
let arWindow = [];        // times of recent auto-replies: a global safety limit
async function arAiReply(uid, m, text, cfg) {
  try {
    const a = store.ai;
    if (!a.apiKey) throw new Error('AI mode is on, but no AI key is saved. The head admin must add one in the AI tab.');
    const c = inbox.get(uid);
    let ctx = '';
    if (cfg.aiContext > 0) {
      const rows = (await inboxRows(uid)).filter((r) => idCmp(r.id, String(m.id)) < 0).slice(-cfg.aiContext);
      ctx = rows.map((r) => `${r.d === 'out' ? 'You' : 'User'}: ${(r.c || '[attachment]').slice(0, 600)}`).join('\n');
    }
    const q = (ctx ? `Earlier messages in this private conversation:\n${ctx}\n\n` : '') + `The user's new message:\n${text}`;
    const ai = { ...a, summary: [a.summary, 'This is a private Discord direct message (DM) to the bot, not a server channel. Answer helpfully and briefly.', cfg.aiPrompt].filter(Boolean).join('\n') };
    const out = String(await askAI(ai, q, c?.displayName || c?.username || 'a Discord user', AR_LIM.aiMs)).trim();
    if (!out) throw new Error('Empty answer from AI');
    return out.slice(0, 1900);
  } catch (e) { e.aiStage = true; throw e; }
}
async function autoReplyHandle(m) {
  const cfg = arCfg;
  if (!cfg.enabled || !m || m.guildId || m.system || !client?.user) return;
  const au = m.author;
  if (!au || au.bot || au.system || m.webhookId || String(au.id) === String(client.user.id)) return; // never answer bots, webhooks or itself: no reply loops
  if (!m.channel || m.channel.type !== ChannelType.DM) return;
  const uid = String(au.id), mid = String(m.id);
  if (!SNOWFLAKE.test(uid) || !SNOWFLAKE.test(mid)) return;
  if (arSeen.has(mid)) return;
  arSeen.add(mid); if (arSeen.size > 2000) arSeen.delete(arSeen.values().next().value);
  if (Date.now() - (Number(m.createdTimestamp) || Date.now()) > AR_LIM.staleMs) return; // an old message replayed after a reconnect
  const text = cleanText(m.content, INBOX_LIM.contentMax).trim();
  if (cfg.mode === 'ai' && !text) return; // attachment / sticker only: nothing to answer
  if (arBusy.has(uid)) return;
  if (arRemainingMs(uid, cfg) > 0) { arStats.cooldownSkips++; return; }
  const now = Date.now();
  arWindow = arWindow.filter((t) => now - t < AR_LIM.globalWinMs);
  if (arWindow.length >= AR_LIM.globalMax) { arStats.lastError = `Safety limit: ${AR_LIM.globalMax} auto-replies in one hour were sent. New ones wait until the hour has passed.`; arStats.lastErrorAt = now; return; }
  arWindow.push(now);
  const prev = arCd.get(uid);
  arBusy.add(uid); arStamp(uid, now); // claimed BEFORE anything slow happens, so a second message cannot slip through
  try {
    let reply, s;
    if (cfg.mode === 'ai') { m.channel.sendTyping?.().catch(() => {}); reply = await arAiReply(uid, m, text, cfg); s = 'auto-ai'; }
    else { if (!cfg.text) throw new Error('Fixed-text auto-reply is on, but the reply text is empty.'); reply = cfg.text; s = 'auto-fixed'; }
    if (!arCfg.enabled || arCfg.mode !== cfg.mode) { arUnstamp(uid, prev); arWindow.pop(); return; } // switched off or changed while the AI was thinking: send nothing
    await dmSend(uid, reply, { s, b: '' });
    arStats.sent++; arStats.lastSentAt = Date.now();
  } catch (e) {
    arFail(e.message || 'Auto-reply failed');
    if (e.aiStage) { const cd = cfg.cooldownSec * 1000; arStamp(uid, Date.now() - cd + Math.min(cd, AR_LIM.aiRetryMs)); } // AI problem: allow another try after about a minute, not a whole cooldown
  } finally { arBusy.delete(uid); arPush(); }
}

/* ------------------------------ Discord bot ------------------------------ */
const { GatewayIntentBits: GI } = require('discord.js');
const BASE_INTENTS = [GI.Guilds, GI.GuildMessages, GI.GuildVoiceStates, GI.GuildMessageReactions, GI.DirectMessages]; // reactions and DMs are not privileged (Stage 5A: DirectMessages for the Inbox)
const FULL_INTENTS = [...BASE_INTENTS, GI.GuildMembers, GI.MessageContent]; // privileged
const bot = { status: 'starting', error: '', degraded: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rxPending = new Set();
/* ------------------- Bot Profile (Stage 6A): per-server nickname, avatar, banner ------------------- */
// Only the bot's profile INSIDE one server is touched (PATCH /guilds/{id}/members/@me). The global Discord profile is never changed.
// Each route sends only the one field it is about, so every other part of the profile stays exactly as it was.
const BP_NICK_MAX = 32;
const BP_BIO_MAX = 190; // Discord's limit for the "About me" text of a profile (user and server bio). Discord's own answer stays the final word: if it refuses, its text is shown.
const BP_MAX_MB = Math.min(10, Math.max(0.1, Number(process.env.PROFILE_IMAGE_MAX_MB) || 8)); // configurable upload limit (env PROFILE_IMAGE_MAX_MB, 0.1 to 10 MB, default 8)
const BP_MAX_BYTES = Math.round(BP_MAX_MB * 1024 * 1024);
const BP_MIME = ['image/png', 'image/jpeg', 'image/gif'];
const BP = [requireAuth, requireGuild, requireTab('botprofile')]; // 401 / 403 happen before anything about the server is looked up
const bpBusy = new Set(); // "gid:field" while a change is running: a double click cannot send two changes
const BP_COOL = { max: Math.max(1, Math.min(10, Number(process.env.PROFILE_CHANGES_PER_MIN) || 4)), windowMs: 60000 }; // Stage 6B: at most 4 profile changes per minute per server (env PROFILE_CHANGES_PER_MIN, 1-10)
const bpTries = new Map(); // guild id -> times of recent change attempts. In memory on the server, so it holds across every request, account and browser tab.
/** Cooldown for profile changes. Per SERVER, because the bot's profile in one server is one shared thing (and Discord limits it per bot), not per admin.
 *  Only the profile-change routes use it: reading a profile, the chat, the voice tab, the inbox etc. are never blocked by it. */
function bpCooldown(guildId) {
  const k = String(guildId), now = Date.now(), list = (bpTries.get(k) || []).filter((t) => now - t < BP_COOL.windowMs);
  if (list.length >= BP_COOL.max) {
    const wait = Math.max(1, Math.ceil((list[0] + BP_COOL.windowMs - now) / 1000));
    bpTries.set(k, list);
    throw Object.assign(httpErr(429, `Cooldown: this server's bot profile was changed ${BP_COOL.max} times in the last minute. Wait ${wait} second${wait === 1 ? '' : 's'} and try again.`), { retryAfter: wait });
  }
  list.push(now); bpTries.set(k, list);
}
setInterval(() => { const now = Date.now(); for (const [k, l] of bpTries) if (!l.some((t) => now - t < BP_COOL.windowMs)) bpTries.delete(k); }, 60000).unref();
const bpBioSeen = new Map(); // guild id -> { text, at }: the bio last saved from THIS dashboard (memory only). Used only when Discord does not return the bio on read.
const bpBody = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const bpWho = (req) => (req.admin.role === 'head' ? 'Head admin' : subOf(req.admin)?.name || 'A co-admin');

/** Discord errors of the profile calls -> clear messages. A raw upstream 401 is never passed on (it would sign the admin out). */
function bpFirstMsg(o) {
  if (!o || typeof o !== 'object') return '';
  if (Array.isArray(o._errors) && o._errors[0]?.message) return String(o._errors[0].message);
  for (const v of Object.values(o)) { const m = bpFirstMsg(v); if (m) return m; }
  return '';
}
function bpErr(e, what) {
  if (e && typeof e === 'object' && 'requestBody' in e) { try { e.requestBody = undefined; } catch {} } // never keep (or log) the uploaded image data
  if (e && e.status && !(e.name && /^(DiscordAPIError|HTTPError|RateLimitError)/.test(e.name))) return e; // already one of ours
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return httpErr(504, `Discord did not answer in time. Changing the ${what} is rate limited by Discord, so wait a few minutes and try again.`);
  if (!e || !/^(DiscordAPIError|HTTPError|RateLimitError)/.test(e.name || '')) return e;
  const code = e.code, st = e.status, detail = bpFirstMsg(e.rawError?.errors) || '';
  if (code === 50013 || (st === 403 && code !== 50035)) return httpErr(403, `Discord refused the change: the bot is missing a permission it needs in this server.${detail ? ' (' + detail + ')' : ''}`);
  if (code === 50035) return httpErr(400, `Discord rejected the ${what}${detail ? ': ' + detail : '. Check the image or the text and try again.'}`);
  if (code === 50045) return httpErr(413, `Discord says the ${what} file is too large.`);
  if (code === 10004 || code === 10007) return httpErr(404, 'Discord does not know this server or the bot is no longer a member of it.');
  if (st === 429 || e.name === 'RateLimitError') return httpErr(429, `Discord rate limit: the ${what} was changed too often. Wait a few minutes and try again.`);
  return httpErr(502, `Discord could not change the ${what}${e.message ? ': ' + String(e.message).slice(0, 200) : '.'}`);
}
const bpHash = (h) => (typeof h === 'string' && /^(?:a_)?[0-9a-f]{32}$/.test(h) ? h : null);
function bpViewOf(guild, me, raw) {
  const uid = client.user.id, cdn = (kind, h, size) => (bpHash(h) ? `https://cdn.discordapp.com/guilds/${guild.id}/users/${uid}/${kind}/${h}.${h.startsWith('a_') ? 'gif' : 'png'}?size=${size}` : null);
  return {
    guildId: guild.id, guildName: guild.name,
    nickname: typeof raw?.nick === 'string' && raw.nick ? raw.nick : null,
    defaultName: client.user.displayName || client.user.username,
    avatarUrl: cdn('avatars', raw?.avatar, 256), bannerUrl: cdn('banners', raw?.banner, 600),
    bio: typeof raw?.bio === 'string' && raw.bio ? raw.bio : null,
    bioReadable: !!raw && typeof raw === 'object' && 'bio' in raw, // false = Discord did not include a bio in the member data it returned
    bioLastSaved: bpBioSeen.get(String(guild.id)) || null,
    defaultAvatarUrl: client.user.displayAvatarURL({ size: 256 }),
    canChangeNickname: me.permissions.has(PF.ChangeNickname),
    limits: { nickMax: BP_NICK_MAX, bioMax: BP_BIO_MAX, changesPerMin: BP_COOL.max, imageMaxBytes: BP_MAX_BYTES, imageMaxMb: BP_MAX_MB, types: BP_MIME },
  };
}
async function bpLoad(guildId) {
  const guild = await getGuild(guildId), me = await getMe(guild);
  let raw;
  try { raw = await client.rest.get(Routes.guildMember(guild.id, client.user.id), { signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw bpErr(e, 'profile'); }
  return bpViewOf(guild, me, raw);
}
async function bpSendTo(ws, gid, refuse) {
  try {
    const v = await bpLoad(gid);
    if (wsLive(ws) && canTab(ws.admin, 'botprofile') && canGuild(ws.admin, gid)) wsSendJson(ws, 'botprofile:data', v); // access may have been removed while Discord was answering
  } catch (e) { refuse(bpErr(e, 'profile')?.message || 'Could not load the bot profile.'); }
}
app.get('/api/guilds/:gid/bot-profile', ...BP, wrap(async (req, res) => { validGid(req); res.json(await bpLoad(req.params.gid)); }));

app.put('/api/guilds/:gid/bot-profile/nickname', ...BP, wrap(async (req, res) => {
  validGid(req);
  const b = bpBody(req); let nick;
  if (b.reset === true || b.nickname === null) nick = null; // null is the API value that removes the server nickname
  else {
    if (typeof b.nickname !== 'string') throw bad('Enter a nickname.');
    const t = b.nickname.trim();
    if (/[\u0000-\u001f\u007f]/.test(t)) throw bad('The nickname contains characters that are not allowed.');
    if (!t) throw bad('The nickname cannot be empty. Use "Reset to Default" to remove it.');
    const len = [...t].length;
    if (len > BP_NICK_MAX) throw bad(`The nickname has ${len} characters. The limit is ${BP_NICK_MAX}.`);
    nick = t;
  }
  const guild = await getGuild(req.params.gid), me = await getMe(guild);
  if (!me.permissions.has(PF.ChangeNickname)) throw httpErr(403, 'The bot is missing the "Change Nickname" permission in this server. Give the bot a role with Change Nickname (or Administrator), then try again.');
  const key = guild.id + ':nick';
  if (bpBusy.has(key)) throw httpErr(409, 'A nickname change is already running for this server.');
  bpCooldown(guild.id); bpBusy.add(key);
  try {
    let raw;
    try { raw = await client.rest.patch(Routes.guildMember(guild.id, '@me'), { body: { nick }, reason: `Dashboard: ${req.admin.email}`, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw bpErr(e, 'nickname'); }
    console.log(`[bot-profile] ${req.admin.email} ${nick === null ? 'reset the nickname' : 'set the nickname'} in ${guild.id}`);
    broadcast('botprofile:changed', { guildId: guild.id, field: 'nickname', by: bpWho(req) });
    res.json({ ...bpViewOf(guild, me, raw), message: nick === null ? 'Nickname reset to the default name.' : 'Nickname saved.' });
  } finally { bpBusy.delete(key); }
}));

/* ---- bio (Stage 6B) ---- */
// PATCH /guilds/{id}/members/@me accepts `bio` next to nick / avatar / banner. This was NOT verified against live Discord here, so the answer is checked:
// if Discord rejects the field its own text is shown, and if it says OK but does not report the bio back, the admin is told it could not be confirmed.
app.put('/api/guilds/:gid/bot-profile/bio', ...BP, wrap(async (req, res) => {
  validGid(req);
  const b = bpBody(req); let bio;
  if (b.reset === true || b.bio === null) bio = null; // null removes the server bio
  else {
    if (typeof b.bio !== 'string') throw bad('Enter a bio.');
    const t = b.bio.replace(/\r\n?/g, '\n').trim();
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(t)) throw bad('The bio contains characters that are not allowed.');
    if (!t) throw bad('The bio cannot be empty. Use "Remove / Reset" to delete it.');
    const len = [...t].length;
    if (len > BP_BIO_MAX) throw bad(`The bio has ${len} characters. The limit is ${BP_BIO_MAX}.`);
    bio = t;
  }
  const guild = await getGuild(req.params.gid), me = await getMe(guild);
  const key = guild.id + ':bio';
  if (bpBusy.has(key)) throw httpErr(409, 'A bio change is already running for this server.');
  bpCooldown(guild.id); bpBusy.add(key);
  try {
    let raw;
    try { raw = await client.rest.patch(Routes.guildMember(guild.id, '@me'), { body: { bio }, reason: `Dashboard: ${req.admin.email}`, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw bpErr(e, 'bio'); }
    console.log(`[bot-profile] ${req.admin.email} ${bio === null ? 'removed the bio' : 'set the bio'} in ${guild.id}`); // the text itself is not logged
    const echoed = raw && typeof raw === 'object' && 'bio' in raw ? (typeof raw.bio === 'string' && raw.bio ? raw.bio : null) : undefined; // undefined = Discord did not report a bio
    let message, warning = false;
    if (echoed === undefined) { message = bio === null ? 'Discord accepted the request to remove the bio, but its answer does not include a bio field, so this could not be confirmed. Check the bot\u2019s profile in Discord.' : 'Discord accepted the request, but its answer does not include a bio field, so it could not be confirmed that the bio was applied. Check the bot\u2019s profile in Discord.'; warning = true; }
    else if (echoed !== bio) { message = bio === null ? 'Discord answered OK, but still reports a bio for the bot. The bio was not removed.' : 'Discord answered OK, but did not apply the bio (it reports a different value). Discord may not support a server bio for this bot.'; warning = true; }
    else message = bio === null ? 'Server bio removed.' : 'Server bio saved.';
    if (echoed === undefined) { if (bio === null) bpBioSeen.delete(String(guild.id)); else bpBioSeen.set(String(guild.id), { text: bio, at: Date.now() }); }
    broadcast('botprofile:changed', { guildId: guild.id, field: 'bio', by: bpWho(req) });
    res.json({ ...bpViewOf(guild, me, raw), message, warning });
  } finally { bpBusy.delete(key); }
}));

/* ---- images ---- */
function bpSniff(b) { // the real type comes from the file content, not from the name or the type the browser claims
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}
function bpPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase(), m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return bpPrivateIp(m[1]);
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b:') || l.startsWith('2002:') || l.startsWith('::ffff:');
  }
  return true;
}
/** Download an image from a link the admin pasted. https only, no private / internal addresses (the address is checked and then pinned), size and time limits, at most 3 redirects. */
async function bpFetchUrl(raw, hop = 0) {
  let u;
  try { u = new URL(raw); } catch { throw bad('That is not a valid link. Paste the full image address, starting with https://'); }
  if (u.protocol !== 'https:') throw bad('The image link must start with https://');
  if (u.username || u.password) throw bad('The image link must not contain a user name or password.');
  if (u.port && u.port !== '443') throw bad('The image link must use the normal HTTPS port.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.promises.lookup(host, { all: true }); }
  catch { throw bad('The server could not find that website. Check the link.'); }
  if (!addrs.length || addrs.some((a) => bpPrivateIp(a.address))) throw bad('That link points to a private or internal address, which is not allowed.');
  const pin = addrs[0];
  return new Promise((resolve, reject) => {
    let done = false, size = 0; const chunks = [];
    const fail = (e) => { if (!done) { done = true; clearTimeout(timer); try { req.destroy(); } catch {} reject(e); } };
    const ok = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = https.request({
      protocol: 'https:', hostname: host, servername: net.isIP(host) ? undefined : host, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'DashboardBot/1.0', Accept: 'image/png,image/jpeg,image/gif' },
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)),
    }, (r) => {
      const st = r.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(st) && r.headers.location) {
        r.resume();
        if (hop >= 3) return fail(bad('The image link redirects too many times.'));
        let next; try { next = new URL(r.headers.location, u).toString(); } catch { return fail(bad('The image link redirects to a bad address.')); }
        return bpFetchUrl(next, hop + 1).then(ok, fail);
      }
      if (st !== 200) { r.resume(); return fail(bad(`The image link answered with HTTP ${st}. Check that the link is public and still works.`)); }
      const ct = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct && !ct.startsWith('image/') && ct !== 'application/octet-stream') { r.resume(); return fail(httpErr(415, 'That link is not an image (it is a web page or another file type). Use a direct link to a PNG, JPG or GIF.')); }
      if (Number(r.headers['content-length']) > BP_MAX_BYTES) { r.resume(); return fail(httpErr(413, `That image is bigger than the ${BP_MAX_MB} MB limit.`)); }
      r.on('data', (c) => { size += c.length; if (size > BP_MAX_BYTES) return fail(httpErr(413, `That image is bigger than the ${BP_MAX_MB} MB limit.`)); chunks.push(c); });
      r.on('end', () => ok(Buffer.concat(chunks)));
      r.on('error', () => fail(bad('The download of the image stopped unexpectedly.')));
    });
    const timer = setTimeout(() => fail(httpErr(504, 'The image link took too long to answer (15 seconds).')), 15000);
    req.on('error', () => fail(bad('The server could not download that link. Check that it is public.')));
    req.end();
  });
}
const bpMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: BP_MAX_BYTES, files: 1, fields: 5, parts: 8 } }).single('file');
const bpUploadMw = (req, res, next) => bpMulter(req, res, (err) => { // runs only after the 401 / 403 checks
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `That file is bigger than the ${BP_MAX_MB} MB limit.` });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Unexpected upload field. Send the image as "file".' });
  res.status(400).json({ error: 'Upload failed: ' + err.message });
});
const bpImage = (field, label) => wrap(async (req, res) => {
  validGid(req);
  const b = bpBody(req), file = req.file;
  const remove = b.remove === true || b.remove === 'true', url = typeof b.url === 'string' ? b.url.trim() : '';
  const n = [remove, !!url, !!file].filter(Boolean).length;
  if (n === 0) throw bad(`Nothing to change. Choose a file, enter an image link, or press Remove. The current ${label} was kept.`);
  if (n > 1) throw bad('Send only one of: a file, a link, or remove.');
  if (url.length > 2000) throw bad('The image link is too long.');
  let value = null; // null is the API value that removes the server-specific image
  if (!remove) {
    let buf;
    if (file) {
      if (file.mimetype && !BP_MIME.includes(String(file.mimetype).toLowerCase())) throw httpErr(415, 'Only PNG, JPG and GIF images are allowed.');
      buf = file.buffer;
    } else buf = await bpFetchUrl(url);
    if (!buf || buf.length < 64) throw bad('That image is empty or damaged.');
    if (buf.length > BP_MAX_BYTES) throw httpErr(413, `That image is bigger than the ${BP_MAX_MB} MB limit.`);
    const mime = bpSniff(buf);
    if (!mime) throw httpErr(415, 'That is not a real PNG, JPG or GIF image (the content does not match). Other formats such as WebP are not accepted.');
    value = `data:${mime};base64,${buf.toString('base64')}`;
  }
  const guild = await getGuild(req.params.gid), me = await getMe(guild);
  const key = guild.id + ':' + field;
  if (bpBusy.has(key)) throw httpErr(409, `A ${label} change is already running for this server.`);
  bpCooldown(guild.id); bpBusy.add(key);
  try {
    let raw;
    try { raw = await client.rest.patch(Routes.guildMember(guild.id, '@me'), { body: { [field]: value }, reason: `Dashboard: ${req.admin.email}`, signal: AbortSignal.timeout(25000) }); }
    catch (e) { throw bpErr(e, label); }
    console.log(`[bot-profile] ${req.admin.email} ${remove ? 'removed' : 'set'} the ${label} in ${guild.id}`);
    broadcast('botprofile:changed', { guildId: guild.id, field, by: bpWho(req) });
    res.json({ ...bpViewOf(guild, me, raw), message: remove ? `Server ${label} removed. The bot uses its default ${label} again.` : `Server ${label} saved.` });
  } finally { bpBusy.delete(key); }
});
app.put('/api/guilds/:gid/bot-profile/avatar', ...BP, bpUploadMw, bpImage('avatar', 'avatar'));
app.put('/api/guilds/:gid/bot-profile/banner', ...BP, bpUploadMw, bpImage('banner', 'banner'));

function scheduleReactionSync(guildId, channelId, messageId) {
  const k = `${channelId}:${messageId}`;
  if (rxPending.has(k)) return; // several quick events become one read
  rxPending.add(k);
  setTimeout(async () => {
    rxPending.delete(k);
    try {
      const ch = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
      if (!ch) return;
      const msg = await ch.messages.fetch({ message: messageId, force: true });
      broadcast('reactions', { guildId, channelId, messageId, reactions: serializeReactions(msg) });
    } catch { /* the message was deleted meanwhile */ }
  }, 150);
}

function buildClient(full) {
  const c = new Client({ intents: full ? FULL_INTENTS : BASE_INTENTS, partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User] });
  c.on('messageCreate', (m) => { try { logMessageEvent(m); } catch (e) { console.warn('[logging]', e.message); } }); // Stage 4A: counts only, never content
  c.on('messageCreate', (m) => { try { inboxHandle(m); } catch (e) { console.warn('[inbox]', e.message); } }); // Stage 5A: DMs only (servers are ignored inside)
  c.on('messageCreate', (m) => { autoReplyHandle(m).catch((e) => console.warn('[auto-reply]', e.message)); }); // Stage 5B: DMs only, after the Inbox listener has stored the message
  c.on('voiceStateUpdate', (o, n) => { try { logVoiceEvent(o, n); } catch (e) { console.warn('[logging]', e.message); } }); // separate listener, registered first, so other handlers cannot stop it
  c.on('messageCreate', (m) => {
    if (m.guildId) serializeMsg(m).then((d) => broadcast('message', { guildId: m.guildId, ...d })).catch((e) => console.error('[message]', e.message));
    handleAI(m).catch((e) => console.error('[ai]', e.message));
  });
  c.on('messageDelete', (m) => { if (m.guildId) broadcast('messageDelete', { guildId: m.guildId, channelId: m.channelId, id: m.id }); });
  c.on('messageDeleteBulk', (msgs, ch) => { if (ch?.guildId) for (const id of msgs.keys()) broadcast('messageDelete', { guildId: ch.guildId, channelId: ch.id, id }); });
  // Reactions: on every add/remove, re-read the message from Discord and push the exact state to every browser.
  const rxSync = (mOrR) => {
    const m = mOrR.message || mOrR;
    if (m.guildId && m.channelId && m.id) scheduleReactionSync(m.guildId, m.channelId, m.id);
  };
  c.on('messageReactionAdd', rxSync);
  c.on('messageReactionRemove', rxSync);
  c.on('messageReactionRemoveAll', rxSync);
  c.on('messageReactionRemoveEmoji', rxSync);
  // Permission changes: tell the browsers to refresh their channel list (green check / red cross).
  const permsChanged = (gid) => { if (gid) broadcast('perms', { guildId: gid }); };
  c.on('channelUpdate', (_o, n) => permsChanged(n.guildId));
  c.on('channelCreate', (ch) => permsChanged(ch.guildId));
  c.on('channelDelete', (ch) => permsChanged(ch.guildId));
  c.on('roleUpdate', (_o, n) => permsChanged(n.guild?.id));
  c.on('guildMemberUpdate', (_o, n) => { if (n.id === c.user?.id) permsChanged(n.guild.id); });
  c.on('voiceStateUpdate', (o, n) => { const g = n.guild || o.guild; if (g) pushVoice(g); try { vaiMemberMoved(o, n); } catch (e) { console.warn('[voice-ai]', e.message); } });
  c.on('guildCreate', () => broadcast('guilds', {}));
  c.on('guildDelete', () => broadcast('guilds', {}));
  c.on('error', (e) => console.error('[discord] client error:', e.message));
  c.on('warn', (w) => console.warn('[discord] warn:', w));
  c.on('shardError', (e) => console.error('[discord] shard error:', e.message));
  c.on('shardDisconnect', (ev, id) => console.warn(`[discord] shard ${id} disconnected, code ${ev?.code}`));
  c.on('shardReconnecting', (id) => console.log(`[discord] shard ${id} reconnecting`));
  c.on('debug', (m) => { if (!/heartbeat/i.test(m)) console.log('[discord:debug]', String(m).replace(/Bot\s+\S+/g, 'Bot ***').slice(0, 300)); });
  c.rest.on('rateLimited', (i) => console.warn('[discord] rate limited:', i.route, 'retry after', i.timeToReset, 'ms'));
  return c;
}

/** Check the token over plain HTTPS first, so a bad token or a network block is reported clearly. */
async function checkToken(token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token}` }, signal: ctrl.signal });
    const body = await r.text();
    if (r.status === 200) { const u = JSON.parse(body); console.log(`[check] Token OK. Bot user: ${u.username} (${u.id})`); return { ok: true }; }
    if (r.status === 401) return { ok: false, fatal: true, msg: 'টোকেন ভুল বা বাতিল (401 Unauthorized)। Developer Portal → Bot → Reset Token করে নতুন টোকেন দিন।' };
    if (r.status === 429) return { ok: false, msg: 'Discord সাময়িকভাবে এই সার্ভারের IP-তে rate limit দিয়েছে (429)। কিছুক্ষণ পর নিজে থেকে আবার চেষ্টা হবে।' };
    if (r.status === 403 || /cloudflare|error code: 1015/i.test(body)) return { ok: false, msg: `Discord/Cloudflare এই সার্ভারের IP ব্লক করেছে (HTTP ${r.status})। Render-এ Manual Deploy করলে নতুন IP পেতে পারেন।` };
    return { ok: false, msg: `Discord API অপ্রত্যাশিত উত্তর দিয়েছে: HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, msg: 'Discord API-তে পৌঁছানো যাচ্ছে না: ' + (e.name === 'AbortError' ? '15 সেকেন্ডে সাড়া নেই (timeout)' : e.message) };
  } finally { clearTimeout(t); }
}

function waitReady(c, ms) {
  return new Promise((resolve, reject) => {
    if (c.isReady()) return resolve();
    const timer = setTimeout(() => reject(new Error(`Gateway ${ms / 1000} সেকেন্ডে ready হয়নি (timeout)`)), ms);
    const done = () => { clearTimeout(timer); resolve(); };
    c.once('clientReady', done);
    c.once('ready', done);
  });
}

async function startBot() {
  const token = (process.env.DISCORD_TOKEN || '').replace(/[\s"']/g, '').replace(/^Bot/i, '');
  if (!token) {
    bot.status = 'error';
    bot.error = 'DISCORD_TOKEN সেট করা নেই। Render → Environment-এ DISCORD_TOKEN নামে বটের টোকেন দিন, তারপর Save করুন।';
    console.error(bot.error);
    return;
  }
  console.log(`[boot] Node ${process.version}, token length ${token.length}`);
  let full = true;
  for (;;) {
    bot.status = 'starting'; bot.degraded = !full;
    const chk = await checkToken(token);
    if (!chk.ok) {
      bot.status = 'error'; bot.error = chk.msg;
      console.error('[check] ' + chk.msg);
      if (chk.fatal) return;
      await sleep(20000); continue;
    }
    if (client) { try { client.destroy(); } catch {} }
    client = buildClient(full);
    try {
      console.log(`[boot] Connecting to Discord gateway (${full ? 'full' : 'limited'} intents)...`);
      const ready = waitReady(client, 45000);
      ready.catch(() => {});
      await client.login(token);
      await ready;
      bot.status = 'online'; bot.error = '';
      console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)${full ? '' : ' (limited mode: privileged intents are off)'}`);
      broadcast('guilds', {});
      dispatchDue().catch(() => {});
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      try { client.destroy(); } catch {}
      if (full && /disallowed intents|intents/i.test(msg)) {
        console.warn('[boot] Privileged intents are off. Starting in limited mode.');
        full = false; continue;
      }
      bot.status = 'error'; bot.error = 'Discord gateway সমস্যা: ' + msg + ' — নিজে থেকে আবার চেষ্টা হচ্ছে।';
      console.error('[boot] ' + msg);
      await sleep(10000);
    }
  }
}

const logSafe = (e) => (e && typeof e === 'object' && ('requestBody' in e || 'rawError' in e) ? `${e.name || 'Error'}: ${e.message}${e.code ? ' (code ' + e.code + ')' : ''}` : e); // Stage 6B: a Discord error object can hold the request body, i.e. base64 image data
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', logSafe(e)));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', logSafe(e)));
const shutdown = () => { try { flushLogsSync(); } catch {} try { flushInboxSync(); } catch {} try { arCdFlush(); } catch {} client?.destroy(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBot();
  const self = process.env.RENDER_EXTERNAL_URL; // keep-alive: ping /health every 10 minutes
  if (self) {
    const url = self.replace(/\/$/, '') + '/health';
    setInterval(() => fetch(url, { signal: AbortSignal.timeout(15000) }).catch((e) => console.warn('[keepalive]', e.message)), 10 * 60 * 1000);
    console.log(`[keepalive] pinging ${url} every 10 minutes`);
  } else console.log('[keepalive] RENDER_EXTERNAL_URL is not set, so no self-ping');
});
