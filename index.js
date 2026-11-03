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
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField } = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState,
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
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // privileged - enable in Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,    // privileged - enable in Developer Portal
  ],
  partials: [Partials.Channel, Partials.Message],
});
const app = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true, botReady: client.isReady() }));

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[${req.method} ${req.path}]`, e.message);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const ensureReady = () => { if (!client.isReady()) throw httpErr(503, 'Bot is still connecting to Discord. Try again in a few seconds.'); };
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

/* --------------------------------- Guilds -------------------------------- */
app.get('/api/guilds', requireAuth, wrap(async (_req, res) => {
  ensureReady();
  const fetched = await client.guilds.fetch(); // fresh from the API, not the cache
  res.json([...fetched.values()].map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) })));
}));
app.get('/api/guilds/:gid/channels', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const all = [...(await guild.channels.fetch()).values()].filter(Boolean);
  const pick = (types) => all.filter((c) => types.includes(c.type))
    .sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name }));
  res.json({
    text: pick([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    voice: pick([ChannelType.GuildVoice, ChannelType.GuildStageVoice]),
  });
}));

/* -------------------------------- Messages ------------------------------- */
const serializeMsg = (m) => ({
  id: m.id, channelId: m.channelId, content: m.content, createdAt: m.createdTimestamp,
  author: {
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
app.post('/api/guilds/:gid/voice/join', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, String(req.body.channelId || ''));
  if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) throw httpErr(400, 'That is not a voice channel');
  getVoiceConnection(guild.id)?.destroy();
  const conn = joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); }
  catch { conn.destroy(); throw httpErr(504, 'Could not connect. Check the bot’s Connect permission for that channel.'); }
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
    } catch { if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy(); pushVoice(guild); }
  });
  pushVoice(guild);
  res.json(voiceInfo(guild));
}));
app.post('/api/guilds/:gid/voice/leave', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const conn = getVoiceConnection(guild.id);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  pushVoice(guild);
  res.json({ connected: false, channelId: null, channelName: null, members: [] });
}));

/* ------------------------------ Discord events --------------------------- */
client.on('messageCreate', (m) => { if (m.guildId) broadcast('message', { guildId: m.guildId, ...serializeMsg(m) }); });
client.on('voiceStateUpdate', (o, n) => { const g = n.guild || o.guild; if (g) pushVoice(g); });
client.on('guildCreate', () => broadcast('guilds', {}));
client.on('guildDelete', () => broadcast('guilds', {}));
client.on('error', (e) => console.error('Discord client error:', e.message));
let booted = false;
const onReady = () => {
  if (booted) return; booted = true;
  console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
};
client.once('clientReady', onReady);
client.once('ready', onReady);

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
const shutdown = () => { client.destroy(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
if (!process.env.DISCORD_TOKEN) console.error('DISCORD_TOKEN is missing. Set it in your environment or .env file.');
else client.login(process.env.DISCORD_TOKEN).catch((e) => console.error('Discord login failed:', e.message));
