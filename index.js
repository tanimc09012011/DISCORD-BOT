'use strict';
/** TANIM ER WIFE - Discord Bot + Admin Dashboard | TYRONEX PRODUCTION */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const { WebSocketServer } = require('ws');
const prism = require('prism-media');
const { PassThrough } = require('stream');
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField } = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState,
  createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, EndBehaviorType,
} = require('@discordjs/voice');

const PORT = process.env.PORT || 3000;
const HEAD_EMAIL = (process.env.HEAD_EMAIL || 'tyronex.tanim@tyronex.com').toLowerCase();
const HEAD_PASSWORD = process.env.HEAD_PASSWORD || '2011.01.09';
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'admins.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------ Sub-admin storage ------------------------ */
let admins = [];
try { if (fs.existsSync(DATA_FILE)) admins = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
catch (e) { console.error('Could not read admins file:', e.message); }
const saveAdmins = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(admins, null, 2)); }
  catch (e) { console.error('Could not save admins file:', e.message); }
};
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* --------------------------------- Sessions ------------------------------ */
const sessions = new Map(); // token -> { email, role, exp }
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessionFor = (t) => {
  const s = sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
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
  const s = sessionFor((req.headers.authorization || '').replace('Bearer ', ''));
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  req.admin = s; next();
};
const requireHead = (req, res, next) =>
  req.admin.role === 'head' ? next() : res.status(403).json({ error: 'Head admin only' });

/* ------------------------------ App + Discord ---------------------------- */
let client = null; // created in startBot()
const app = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true, botReady: !!client?.isReady() }));

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[${req.method} ${req.path}]`, e.message);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const ensureReady = () => { if (!client?.isReady()) throw httpErr(503, bot.error || 'Bot is still connecting to Discord. Try again in a few seconds.'); };
async function getGuild(id) {
  ensureReady();
  try { return await client.guilds.fetch(id); } catch { throw httpErr(404, 'Server not found'); }
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
  if (url.pathname !== '/ws' || !sessionFor(url.searchParams.get('token'))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
});
setInterval(() => wss.clients.forEach((ws) => {
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false; ws.ping();
}), 30000);
const broadcast = (type, data) => {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((ws) => { if (ws.readyState === 1) ws.send(msg); });
};

/* --------------------------------- Auth API ------------------------------ */
app.post('/api/login', wrap((req, res) => {
  if (blocked(req.ip)) throw httpErr(429, 'Too many attempts. Try again in 10 minutes.');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  let role = null;
  if (safeEq(email, HEAD_EMAIL) && safeEq(password, HEAD_PASSWORD)) role = 'head';
  else {
    const a = admins.find((x) => x.email === email);
    if (a && safeEq(hashPw(password, a.salt).hash, a.hash)) role = 'sub';
  }
  if (!role) { loginTries.get(req.ip).push(Date.now()); throw httpErr(401, 'Wrong email or password'); }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email, role, exp: Date.now() + SESSION_MS });
  res.json({ token, email, role });
}));
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ email: req.admin.email, role: req.admin.role }));

/* --------------------------------- Admins API ---------------------------- */
app.get('/api/admins', requireAuth, requireHead, (_req, res) =>
  res.json(admins.map((a) => ({ email: a.email, createdAt: a.createdAt }))));
app.post('/api/admins', requireAuth, requireHead, wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpErr(400, 'Enter a valid email address');
  if (password.length < 6) throw httpErr(400, 'Password must be at least 6 characters');
  if (email === HEAD_EMAIL || admins.some((a) => a.email === email)) throw httpErr(409, 'That admin already exists');
  admins.push({ email, ...hashPw(password), createdAt: Date.now() });
  saveAdmins();
  res.json({ ok: true });
}));
app.delete('/api/admins/:email', requireAuth, requireHead, (req, res) => {
  const email = req.params.email.toLowerCase();
  admins = admins.filter((a) => a.email !== email);
  for (const [t, s] of sessions) if (s.email === email) sessions.delete(t);
  saveAdmins();
  res.json({ ok: true });
});

/* --------------------------------- Status -------------------------------- */
app.get('/api/status', requireAuth, (_req, res) => res.json({
  status: client?.isReady() ? 'online' : bot.status === 'online' ? 'starting' : bot.status,
  error: bot.error, degraded: bot.degraded, servers: client?.guilds.cache.size || 0,
}));

/* --------------------------------- Guilds -------------------------------- */
app.get('/api/guilds', requireAuth, wrap(async (_req, res) => {
  ensureReady();
  const fetched = await client.guilds.fetch(); // fresh from the API, not the cache
  res.json([...fetched.values()].map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) })));
}));
app.get('/api/guilds/:gid/channels', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const all = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const kind = (c) => ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type) ? 'text'
    : [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type) ? 'voice' : null);
  const order = (a, b) => (kind(a) === 'voice') - (kind(b) === 'voice') || a.rawPosition - b.rawPosition;
  const cats = all.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition);
  const chans = all.filter(kind);
  const mk = (c) => ({ id: c.id, name: c.name, kind: kind(c) });
  const groups = cats.map((k) => ({ id: k.id, name: k.name, channels: chans.filter((c) => c.parentId === k.id).sort(order).map(mk) })).filter((g) => g.channels.length);
  const loose = chans.filter((c) => !cats.some((k) => k.id === c.parentId)).sort(order).map(mk);
  if (loose.length) groups.unshift({ id: 'none', name: 'No category', channels: loose });
  res.json({ groups });
}));

/* -------------------------------- Messages ------------------------------- */
const serializeMsg = (m) => ({
  id: m.id, channelId: m.channelId, content: m.content, createdAt: m.createdTimestamp,
  author: {
    id: m.author?.id, username: m.author?.username,
    name: m.member?.displayName || m.author?.username || 'Unknown',
    avatar: m.member?.displayAvatarURL({ size: 64 }) || m.author?.displayAvatarURL({ size: 64 }),
    color: m.member?.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : null,
    bot: !!m.author?.bot,
  },
  attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, type: a.contentType || '' })),
});
app.get('/api/guilds/:gid/channels/:cid/messages', requireAuth, wrap(async (req, res) => {
  const ch = await getChannel(await getGuild(req.params.gid), req.params.cid);
  if (!ch.isTextBased()) throw httpErr(400, 'That is not a text channel');
  const msgs = await ch.messages.fetch({ limit: 50 });
  res.json([...msgs.values()].reverse().map(serializeMsg));
}));
app.post('/api/guilds/:gid/channels/:cid/messages', requireAuth, upload.array('files', 10), wrap(async (req, res) => {
  const ch = await getChannel(await getGuild(req.params.gid), req.params.cid);
  const content = String(req.body.content || '').slice(0, 2000);
  const files = (req.files || []).map((f) => ({ attachment: f.buffer, name: f.originalname }));
  if (!content.trim() && !files.length) throw httpErr(400, 'Write a message or attach a file');
  const sent = await ch.send({ content: content || undefined, files });
  res.json(serializeMsg(sent));
}));

/* ---------------------------------- Roles -------------------------------- */
app.get('/api/guilds/:gid/roles', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const roles = await guild.roles.fetch();
  const me = guild.members.me || await guild.members.fetchMe();
  res.json([...roles.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id, name: r.name, color: r.hexColor,
      assignable: !r.managed && r.position < me.roles.highest.position,
    })));
}));
app.get('/api/guilds/:gid/members', requireAuth, wrap(async (req, res) => {
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
app.post('/api/guilds/:gid/members/:uid/roles/:rid', requireAuth, wrap((req, res) => changeRole(req, res, true)));
app.delete('/api/guilds/:gid/members/:uid/roles/:rid', requireAuth, wrap((req, res) => changeRole(req, res, false)));

/* ---------------------------------- Voice -------------------------------- */
function voiceInfo(guild) {
  const conn = getVoiceConnection(guild.id);
  const chId = conn?.joinConfig?.channelId || null;
  const ch = chId ? guild.channels.cache.get(chId) : null;
  return {
    connected: !!(conn && ch), channelId: ch?.id || null, channelName: ch?.name || null,
    members: ch ? [...ch.members.values()].map((m) => ({
      id: m.id, name: m.displayName, bot: m.user.bot, avatar: m.user.displayAvatarURL({ size: 64 }),
      muted: !!(m.voice.mute || m.voice.selfMute), deafened: !!(m.voice.deaf || m.voice.selfDeaf),
    })) : [],
  };
}
const pushVoice = (guild) => broadcast('voice', { guildId: guild.id, ...voiceInfo(guild) });
app.get('/api/guilds/:gid/voice', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  await guild.channels.fetch();
  res.json(voiceInfo(guild));
}));
/* ----------------------- Voice join / live audio -------------------------- */
const vstate = new Map(); // guildId -> { pcm, player, ids, active }
function dropVoice(gid) {
  const st = vstate.get(gid);
  if (st) { try { st.player.stop(true); st.pcm.end(); } catch {} vstate.delete(gid); }
}
function attachAudio(guild, conn) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const pcm = new PassThrough();
  player.play(createAudioResource(pcm, { inputType: StreamType.Raw }));
  conn.subscribe(player);
  const st = { pcm, player, ids: new Map(), active: new Set() };
  vstate.set(guild.id, st);
  conn.receiver.speaking.on('start', (uid) => {
    if (uid === client.user.id || st.active.has(uid)) return;
    if (![...wss.clients].some((w) => w.listenGuild === guild.id)) return;
    st.active.add(uid);
    if (!st.ids.has(uid)) st.ids.set(uid, st.ids.size + 1);
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(st.ids.get(uid));
    const opus = conn.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 400 } });
    const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const done = () => st.active.delete(uid);
    opus.on('error', done); dec.on('error', done); dec.on('end', done);
    opus.pipe(dec);
    dec.on('data', (chunk) => {
      const frame = Buffer.concat([hdr, chunk]);
      wss.clients.forEach((w) => { if (w.readyState === 1 && w.listenGuild === guild.id && w.bufferedAmount < 1e6) w.send(frame, { binary: true }); });
    });
  });
}
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) { // browser mic: Int16 mono 48 kHz -> stereo into the voice player
      const st = vstate.get(ws.micGuild);
      if (!st || data.length < 2) return;
      const mono = Buffer.from(data), n = mono.length >> 1, out = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        const lo = mono[i * 2], hi = mono[i * 2 + 1];
        out[i * 4] = lo; out[i * 4 + 1] = hi; out[i * 4 + 2] = lo; out[i * 4 + 3] = hi;
      }
      if (st.pcm.writableLength < 2e6) st.pcm.write(out);
      return;
    }
    try {
      const m = JSON.parse(data.toString());
      if (m.t === 'listen') ws.listenGuild = m.on ? String(m.g) : null;
      if (m.t === 'mic') ws.micGuild = m.on ? String(m.g) : null;
    } catch {}
  });
});
app.post('/api/guilds/:gid/voice/join', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, String(req.body.channelId || ''));
  if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) throw httpErr(400, 'That is not a voice channel');
  dropVoice(guild.id);
  getVoiceConnection(guild.id)?.destroy();
  const conn = joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); }
  catch { conn.destroy(); throw httpErr(504, 'Could not connect. Check the bot’s Connect permission for that channel.'); }
  attachAudio(guild, conn);
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
    } catch { if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy(); dropVoice(guild.id); pushVoice(guild); }
  });
  pushVoice(guild);
  res.json(voiceInfo(guild));
}));
app.post('/api/guilds/:gid/voice/leave', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  dropVoice(guild.id);
  const conn = getVoiceConnection(guild.id);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  pushVoice(guild);
  res.json({ connected: false, channelId: null, channelName: null, members: [] });
}));

/* ------------------------------ Extra messaging --------------------------- */
app.get('/api/guilds/:gid/members/:uid', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const m = await guild.members.fetch(req.params.uid).catch(() => null);
  if (!m) throw httpErr(404, 'Member not found (they may have left the server)');
  res.json({ id: m.id, name: m.displayName, roles: [...m.roles.cache.keys()].filter((r) => r !== guild.id) });
}));
app.post('/api/guilds/:gid/channels/:cid/messages/:mid/react', requireAuth, wrap(async (req, res) => {
  const ch = await getChannel(await getGuild(req.params.gid), req.params.cid);
  const emoji = String(req.body.emoji || '').slice(0, 20);
  if (!emoji) throw httpErr(400, 'Emoji required');
  await (await ch.messages.fetch(req.params.mid)).react(emoji);
  res.json({ ok: true });
}));

/* ------------------------- Store: favorites/schedules/AI ------------------ */
const DATA_ROOT = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_ROOT, 'store.json');
const FILES_DIR = path.join(DATA_ROOT, 'sched-files');
let store = { favorites: {}, schedules: [], ai: { enabled: false, provider: 'gemini', model: '', apiKey: '', name: 'TANIM ER WIFE', summary: '' } };
try { if (fs.existsSync(STORE_FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) }; } catch (e) { console.error('Could not read store.json:', e.message); }
try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch {}
const saveStore = () => { try { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); } catch (e) { console.error('Could not save store.json:', e.message); } };

app.get('/api/favorites', requireAuth, (req, res) => res.json(store.favorites[req.admin.email]?.[req.query.guildId] || []));
app.post('/api/favorites/toggle', requireAuth, (req, res) => {
  const { guildId, channelId } = req.body || {};
  if (!guildId || !channelId) return res.status(400).json({ error: 'Bad request' });
  const f = (store.favorites[req.admin.email] ||= {});
  const l = (f[guildId] ||= []);
  const i = l.indexOf(channelId);
  if (i >= 0) l.splice(i, 1); else l.push(channelId);
  saveStore();
  res.json(l);
});

/* Scheduled messages (checked every minute by node-cron) */
const dropFiles = (s) => { (s.files || []).forEach((f) => fs.rm(f.path, () => {})); s.files = []; };
let dispatching = false;
async function dispatchDue() {
  if (dispatching || !client?.isReady()) return;
  dispatching = true;
  try {
    for (const s of store.schedules) {
      if (s.status !== 'pending' || s.at > Date.now()) continue;
      if (Date.now() - s.at > 24 * 3600 * 1000) { s.status = 'missed'; dropFiles(s); continue; }
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
app.get('/api/schedules', requireAuth, (req, res) => res.json(store.schedules.filter((s) => s.guildId === req.query.guildId)
  .sort((a, b) => a.at - b.at).map(({ files, ...s }) => ({ ...s, fileNames: (files || []).map((f) => f.name) }))));
app.post('/api/schedules', requireAuth, upload.array('files', 10), wrap((req, res) => {
  ensureReady();
  const { guildId, channelId } = req.body;
  const content = String(req.body.content || '').slice(0, 2000);
  const at = new Date(req.body.at).getTime();
  if (!guildId || !channelId) throw httpErr(400, 'Choose a channel');
  if (!content.trim() && !(req.files || []).length) throw httpErr(400, 'Write a message or add a file');
  if (!Number.isFinite(at) || at < Date.now() + 30000) throw httpErr(400, 'Pick a time at least 1 minute from now');
  const id = crypto.randomUUID(), files = [];
  for (const f of req.files || []) { const p = path.join(FILES_DIR, `${id}-${files.length}`); fs.writeFileSync(p, f.buffer); files.push({ path: p, name: f.originalname }); }
  store.schedules.push({ id, guildId, channelId, content, at, files, status: 'pending', by: req.admin.email, createdAt: Date.now() });
  saveStore();
  res.json({ ok: true });
}));
app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const s = store.schedules.find((x) => x.id === req.params.id);
  if (s) { dropFiles(s); store.schedules = store.schedules.filter((x) => x !== s); saveStore(); }
  res.json({ ok: true });
});

/* AI assistant (Gemini / OpenAI / Claude) */
const AI_MODELS = { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini', claude: 'claude-haiku-5-5' };
app.get('/api/ai', requireAuth, (req, res) => {
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
async function askAI(a, q, who) {
  const model = a.model || AI_MODELS[a.provider];
  const sys = `You are "${a.name || 'TANIM ER WIFE'}", an assistant inside a Discord server. ${a.summary || ''}\nReply in the same language the user writes in. Keep replies under 1500 characters. You are talking to ${who}.`;
  const post = async (url, headers, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
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
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': a.apiKey },
      { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: q }] }] });
    text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  if (!text) throw new Error('Empty answer from AI');
  return text;
}
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
  const q = m.content.replace(/<@!?\d+>/g, '').trim();
  if (!q) return;
  m.channel.sendTyping().catch(() => {});
  try { await m.reply({ content: (await askAI(a, ctx + q, m.member?.displayName || m.author.username)).slice(0, 1900), allowedMentions: { repliedUser: false } }); }
  catch (e) { console.error('[ai]', e.message); m.reply({ content: 'এআই এখন উত্তর দিতে পারছে না: ' + e.message.slice(0, 150), allowedMentions: { repliedUser: false } }).catch(() => {}); }
}

/* ------------------------------ Discord bot ------------------------------ */
const { GatewayIntentBits: GI } = require('discord.js');
const BASE_INTENTS = [GI.Guilds, GI.GuildMessages, GI.GuildVoiceStates];
const FULL_INTENTS = [...BASE_INTENTS, GI.GuildMembers, GI.MessageContent]; // privileged
const bot = { status: 'starting', error: '', degraded: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildClient(full) {
  const c = new Client({ intents: full ? FULL_INTENTS : BASE_INTENTS, partials: [Partials.Channel, Partials.Message] });
  c.on('messageCreate', (m) => {
    if (m.guildId) broadcast('message', { guildId: m.guildId, ...serializeMsg(m) });
    handleAI(m).catch((e) => console.error('[ai]', e.message));
  });
  c.on('voiceStateUpdate', (o, n) => { const g = n.guild || o.guild; if (g) pushVoice(g); });
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

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
const shutdown = () => { client?.destroy(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => { console.log(`Dashboard running on port ${PORT}`); startBot(); });
