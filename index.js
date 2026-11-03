'use strict';
/**
 * TANIM ER WIFE - Discord Bot + Admin Dashboard
 * TYRONEX PRODUCTION
 * Env: DISCORD_TOKEN (required), PORT, HEAD_EMAIL, HEAD_PASSWORD, DATA_DIR
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const prism = require('prism-media');
const { Server } = require('socket.io');
const {
  Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField,
} = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource,
  StreamType, EndBehaviorType, VoiceConnectionStatus, entersState, NoSubscriberBehavior,
} = require('@discordjs/voice');

const PORT = process.env.PORT || 3000;
const HEAD_EMAIL = (process.env.HEAD_EMAIL || 'tyronex.tanim@tyronex.com').toLowerCase();
const HEAD_PASSWORD = process.env.HEAD_PASSWORD || '2011.01.09';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* ------------------------------ Persistence ------------------------------ */
let db = { admins: [], pinnedRoles: {}, schedules: [] };
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (e) { console.error('Could not read data.json:', e.message); }
const save = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('Could not save data.json:', e.message); }
};

/* ------------------------------ Auth helpers ----------------------------- */
const sessions = new Map(); // token -> { email, role, exp }
const SESSION_MS = 12 * 60 * 60 * 1000;
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function sessionFor(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
const requireAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessionFor(token);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  req.admin = s;
  next();
};
const requireHead = (req, res, next) =>
  req.admin.role === 'head' ? next() : res.status(403).json({ error: 'Head admin only' });

/* ------------------------------ Discord client --------------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,        // privileged: enable in Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,      // privileged: enable in Developer Portal
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 1e7 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, ready: client.isReady() }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[${req.method} ${req.path}]`, e.message);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const ready = () => { if (!client.isReady()) throw httpErr(503, 'Bot is not connected yet'); };
async function getGuild(id) {
  ready();
  try { return await client.guilds.fetch(id); } catch { throw httpErr(404, 'Server not found'); }
}
async function getChannel(guild, id) {
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw httpErr(404, 'Channel not found');
  return ch;
}
const serializeMsg = (m) => ({
  id: m.id, channelId: m.channelId, content: m.content,
  createdAt: m.createdTimestamp,
  author: { id: m.author?.id, name: m.member?.displayName || m.author?.username || 'Unknown',
    avatar: m.author?.displayAvatarURL({ size: 64 }), bot: !!m.author?.bot },
  attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, type: a.contentType || '' })),
  reply: m.reference?.messageId || null,
  reactions: [...m.reactions.cache.values()].map((r) => ({ emoji: r.emoji.toString(), count: r.count })),
});

/* --------------------------------- Auth API ------------------------------ */
app.post('/api/login', wrap((req, res) => {
  if (tooManyAttempts(req.ip)) throw httpErr(429, 'Too many attempts. Try again later.');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  let role = null;
  if (safeEq(email, HEAD_EMAIL) && safeEq(password, HEAD_PASSWORD)) role = 'head';
  else {
    const a = db.admins.find((x) => x.email === email);
    if (a && safeEq(hashPw(password, a.salt).hash, a.hash)) role = 'sub';
  }
  if (!role) { attempts.get(req.ip).push(Date.now()); throw httpErr(401, 'Invalid email or password'); }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email, role, exp: Date.now() + SESSION_MS });
  res.json({ token, email, role });
}));
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ email: req.admin.email, role: req.admin.role }));

app.get('/api/admins', requireAuth, requireHead, (_req, res) =>
  res.json(db.admins.map((a) => ({ email: a.email, createdAt: a.createdAt }))));
app.post('/api/admins', requireAuth, requireHead, wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpErr(400, 'Enter a valid email');
  if (password.length < 6) throw httpErr(400, 'Password must be at least 6 characters');
  if (email === HEAD_EMAIL || db.admins.some((a) => a.email === email)) throw httpErr(409, 'Admin already exists');
  db.admins.push({ email, ...hashPw(password), createdAt: Date.now() });
  save();
  res.json({ ok: true });
}));
app.delete('/api/admins/:email', requireAuth, requireHead, (req, res) => {
  db.admins = db.admins.filter((a) => a.email !== req.params.email.toLowerCase());
  for (const [t, s] of sessions) if (s.email === req.params.email.toLowerCase()) sessions.delete(t);
  save();
  res.json({ ok: true });
});

/* ------------------------------ Guild / channels ------------------------- */
app.get('/api/guilds', requireAuth, wrap(async (_req, res) => {
  ready();
  const guilds = await client.guilds.fetch(); // always fresh, no cache dependency
  res.json([...guilds.values()].map((g) => ({
    id: g.id, name: g.name, icon: g.iconURL({ size: 128 }),
  })));
}));

app.get('/api/guilds/:gid/channels', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const chans = await guild.channels.fetch();
  const text = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  const voice = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
  const pick = (types) => [...chans.values()].filter((c) => c && types.includes(c.type))
    .sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name }));
  res.json({ text: pick(text), voice: pick(voice) });
}));

/* --------------------------------- Messages ------------------------------ */
app.get('/api/guilds/:gid/channels/:cid/messages', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, req.params.cid);
  if (!ch.isTextBased()) throw httpErr(400, 'Not a text channel');
  const msgs = await ch.messages.fetch({ limit: 50 });
  res.json([...msgs.values()].reverse().map(serializeMsg));
}));

app.post('/api/guilds/:gid/channels/:cid/messages', requireAuth, upload.array('files', 10), wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, req.params.cid);
  const content = String(req.body.content || '').slice(0, 2000);
  const files = (req.files || []).map((f) => ({ attachment: f.buffer, name: f.originalname }));
  if (!content.trim() && !files.length) throw httpErr(400, 'Message is empty');
  const payload = { content: content || undefined, files };
  if (req.body.replyTo) payload.reply = { messageReference: req.body.replyTo, failIfNotExists: false };
  const sent = await ch.send(payload);
  res.json(serializeMsg(sent));
}));

app.post('/api/guilds/:gid/channels/:cid/messages/:mid/react', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, req.params.cid);
  const msg = await ch.messages.fetch(req.params.mid);
  const emoji = String(req.body.emoji || '').trim();
  if (!emoji) throw httpErr(400, 'Emoji required');
  await msg.react(emoji);
  res.json({ ok: true });
}));

/* ----------------------------------- Roles ------------------------------- */
app.get('/api/guilds/:gid/roles', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const roles = await guild.roles.fetch();
  const pinned = db.pinnedRoles[guild.id] || [];
  const me = guild.members.me || await guild.members.fetchMe();
  res.json([...roles.values()].filter((r) => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id, name: r.name, color: r.hexColor, members: r.members.size,
      pinned: pinned.includes(r.id), managed: r.managed,
      assignable: !r.managed && r.position < me.roles.highest.position,
    })));
}));

app.get('/api/guilds/:gid/members', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const q = String(req.query.q || '').trim();
  const list = q ? await guild.members.search({ query: q, limit: 50 })
    : await guild.members.fetch({ limit: 100 });
  res.json([...list.values()].map((m) => ({
    id: m.id, name: m.displayName, username: m.user.username, bot: m.user.bot,
    avatar: m.user.displayAvatarURL({ size: 64 }), roles: [...m.roles.cache.keys()].filter((r) => r !== guild.id),
  })));
}));

app.post('/api/guilds/:gid/roles/:rid/pin', requireAuth, wrap(async (req, res) => {
  const list = db.pinnedRoles[req.params.gid] || [];
  const i = list.indexOf(req.params.rid);
  if (i >= 0) list.splice(i, 1); else list.push(req.params.rid);
  db.pinnedRoles[req.params.gid] = list;
  save();
  res.json({ pinned: i < 0 });
}));

app.post('/api/guilds/:gid/members/:uid/roles/:rid', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) throw httpErr(403, 'Bot lacks Manage Roles permission');
  const member = await guild.members.fetch(req.params.uid);
  await member.roles.add(req.params.rid, `Dashboard: ${req.admin.email}`);
  res.json({ ok: true, message: `Role added to ${member.displayName}` });
}));
app.delete('/api/guilds/:gid/members/:uid/roles/:rid', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) throw httpErr(403, 'Bot lacks Manage Roles permission');
  const member = await guild.members.fetch(req.params.uid);
  await member.roles.remove(req.params.rid, `Dashboard: ${req.admin.email}`);
  res.json({ ok: true, message: `Role removed from ${member.displayName}` });
}));

/* -------------------------------- Scheduling ----------------------------- */
const jobs = new Map(); // id -> cron task
async function runSchedule(s) {
  try {
    const guild = await client.guilds.fetch(s.guildId);
    const ch = await guild.channels.fetch(s.channelId);
    await ch.send({ content: s.content });
    s.status = 'sent';
  } catch (e) { s.status = 'failed'; s.error = e.message; console.error('Schedule failed:', e.message); }
  s.sentAt = Date.now();
  jobs.get(s.id)?.stop(); jobs.delete(s.id);
  save();
  io.emit('schedules:update');
}
function armSchedule(s) {
  if (s.status !== 'pending') return;
  if (s.at <= Date.now()) { if (client.isReady()) runSchedule(s); return; }
  const d = new Date(s.at);
  const expr = `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
  const task = cron.schedule(expr, () => {
    if (Date.now() < s.at - 60000) return; // guard against same date in a different year
    runSchedule(s);
  }, { timezone: 'UTC' });
  jobs.set(s.id, task);
}
app.get('/api/schedules', requireAuth, (req, res) => {
  const gid = req.query.guildId;
  res.json(db.schedules.filter((s) => !gid || s.guildId === gid).sort((a, b) => a.at - b.at));
});
app.post('/api/schedules', requireAuth, wrap((req, res) => {
  ready();
  const { guildId, channelId, content, at } = req.body;
  const when = new Date(at).getTime();
  if (!guildId || !channelId || !String(content || '').trim()) throw httpErr(400, 'Server, channel and message are required');
  if (!Number.isFinite(when) || when < Date.now() + 30000) throw httpErr(400, 'Pick a time at least 1 minute in the future');
  const s = { id: crypto.randomUUID(), guildId, channelId, content: String(content).slice(0, 2000),
    at: when, status: 'pending', by: req.admin.email, createdAt: Date.now() };
  db.schedules.push(s); save(); armSchedule(s);
  res.json(s);
}));
app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  jobs.get(req.params.id)?.stop(); jobs.delete(req.params.id);
  db.schedules = db.schedules.filter((s) => s.id !== req.params.id);
  save();
  res.json({ ok: true });
});

/* ------------------------------ Voice control ---------------------------- */
const voiceState = new Map(); // guildId -> { player, pcm, selfMute, selfDeaf, channelId, listening:Set }
function participants(guild) {
  const st = voiceState.get(guild.id);
  const conn = getVoiceConnection(guild.id);
  const channelId = st?.channelId || guild.members.me?.voice?.channelId || null;
  const ch = channelId ? guild.channels.cache.get(channelId) : null;
  return {
    connected: !!conn && !!ch,
    channelId: ch?.id || null, channelName: ch?.name || null,
    selfMute: st?.selfMute || false, selfDeaf: st?.selfDeaf || false,
    members: ch ? [...ch.members.values()].map((m) => ({
      id: m.id, name: m.displayName, avatar: m.user.displayAvatarURL({ size: 64 }), bot: m.user.bot,
      muted: m.voice.mute || m.voice.selfMute, deafened: m.voice.deaf || m.voice.selfDeaf,
      streaming: m.voice.streaming,
    })) : [],
  };
}
const pushVoice = (guild) => io.to(`guild:${guild.id}`).emit('voice:update', participants(guild));

function startListening(guild, conn) {
  const st = voiceState.get(guild.id);
  conn.receiver.speaking.on('start', (userId) => {
    if (st.selfDeaf || userId === client.user.id || st.listening.has(userId)) return;
    st.listening.add(userId);
    const opus = conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 300 } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder);
    decoder.on('data', (chunk) => io.to(`audio:${guild.id}`).emit('audio:chunk', { userId, pcm: chunk }));
    const done = () => st.listening.delete(userId);
    decoder.on('end', done); decoder.on('error', done); opus.on('error', done);
    io.to(`guild:${guild.id}`).emit('voice:speaking', { userId, speaking: true });
    decoder.on('end', () => io.to(`guild:${guild.id}`).emit('voice:speaking', { userId, speaking: false }));
  });
}

async function joinVoice(guild, channelId, selfMute, selfDeaf) {
  getVoiceConnection(guild.id)?.destroy();
  const conn = joinVoiceChannel({
    channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
    selfMute, selfDeaf,
  });
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); }
  catch { conn.destroy(); throw httpErr(504, 'Could not connect to voice channel (check Connect permission)'); }
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const pcm = new PassThrough();
  player.play(createAudioResource(pcm, { inputType: StreamType.Raw }));
  conn.subscribe(player);
  const st = { player, pcm, selfMute, selfDeaf, channelId, listening: new Set() };
  voiceState.set(guild.id, st);
  startListening(guild, conn);
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
    } catch { leaveVoice(guild); }
  });
}
function leaveVoice(guild) {
  const st = voiceState.get(guild.id);
  if (st) { st.player.stop(true); st.pcm.end(); voiceState.delete(guild.id); }
  const conn = getVoiceConnection(guild.id);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  pushVoice(guild);
}

app.get('/api/guilds/:gid/voice', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  await guild.channels.fetch();
  res.json(participants(guild));
}));
app.post('/api/guilds/:gid/voice/join', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const ch = await getChannel(guild, req.body.channelId);
  if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) throw httpErr(400, 'Not a voice channel');
  await joinVoice(guild, ch.id, false, false);
  pushVoice(guild);
  res.json(participants(guild));
}));
app.post('/api/guilds/:gid/voice/leave', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  leaveVoice(guild);
  res.json(participants(guild));
}));
app.post('/api/guilds/:gid/voice/state', requireAuth, wrap(async (req, res) => {
  const guild = await getGuild(req.params.gid);
  const conn = getVoiceConnection(guild.id);
  const st = voiceState.get(guild.id);
  if (!conn || !st) throw httpErr(400, 'Bot is not in a voice channel');
  if (typeof req.body.selfMute === 'boolean') st.selfMute = req.body.selfMute;
  if (typeof req.body.selfDeaf === 'boolean') { st.selfDeaf = req.body.selfDeaf; if (st.selfDeaf) st.selfMute = st.selfMute; }
  conn.rejoin({ channelId: st.channelId, selfDeaf: st.selfDeaf, selfMute: st.selfMute });
  setTimeout(() => pushVoice(guild), 800);
  res.json(participants(guild));
}));

/* ---------------------------------- Sockets ------------------------------ */
io.use((socket, next) => sessionFor(socket.handshake.auth?.token) ? next() : next(new Error('unauthorized')));
io.on('connection', (socket) => {
  socket.on('guild:watch', (gid) => {
    for (const r of socket.rooms) if (r.startsWith('guild:')) socket.leave(r);
    if (gid) socket.join(`guild:${gid}`);
  });
  socket.on('audio:listen', (gid, on) => {
    if (on) socket.join(`audio:${gid}`); else socket.leave(`audio:${gid}`);
  });
  // Browser mic -> Discord. Expects Int16 mono PCM at 48 kHz.
  socket.on('audio:mic', (gid, buf) => {
    const st = voiceState.get(gid);
    if (!st || st.selfMute || !buf) return;
    const mono = Buffer.from(buf);
    const stereo = Buffer.alloc(mono.length * 2);
    for (let i = 0; i + 1 < mono.length; i += 2) {
      stereo[i * 2] = stereo[i * 2 + 2] = mono[i];
      stereo[i * 2 + 1] = stereo[i * 2 + 3] = mono[i + 1];
    }
    if (st.pcm.writableLength < 1e6) st.pcm.write(stereo);
  });
});

/* ------------------------------ Discord events --------------------------- */
client.on('messageCreate', (m) => {
  if (m.guildId) io.to(`guild:${m.guildId}`).emit('message:new', serializeMsg(m));
});
client.on('messageReactionAdd', async (r) => {
  try { if (r.partial) await r.fetch(); if (r.message.guildId) io.to(`guild:${r.message.guildId}`).emit('message:reaction', serializeMsg(await r.message.fetch())); } catch {}
});
client.on('voiceStateUpdate', (o, n) => {
  const g = n.guild || o.guild;
  if (g) pushVoice(g);
});
client.on('guildCreate', () => io.emit('guilds:update'));
client.on('guildDelete', () => io.emit('guilds:update'));
client.on('error', (e) => console.error('Client error:', e.message));
let booted = false;
const onReady = () => {
  if (booted) return; booted = true;
  console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
  db.schedules.forEach(armSchedule);
};
client.once('clientReady', onReady);
client.once('ready', onReady);

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
const shutdown = () => { client.destroy(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
if (!process.env.DISCORD_TOKEN) console.error('DISCORD_TOKEN is not set. Add it to your environment variables.');
else client.login(process.env.DISCORD_TOKEN).catch((e) => console.error('Discord login failed:', e.message));
