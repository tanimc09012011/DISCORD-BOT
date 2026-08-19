require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, EndBehaviorType } = require('@discordjs/voice');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const prism = require('prism-media');
const { PassThrough } = require('stream');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Persistent Admin Storage Setup
const ADMIN_FILE = path.join(__dirname, 'admins.json');
const HEAD_ADMIN_EMAIL = "tyronex.tanim@tyronex.com";
const HEAD_ADMIN_PASS = "2011.01.09";

function loadAdminsData() {
    if (!fs.existsSync(ADMIN_FILE)) {
        const initialData = {
            admins: [
                { 
                    id: "head-admin", 
                    email: HEAD_ADMIN_EMAIL, 
                    pass: HEAD_ADMIN_PASS, 
                    name: "Head Admin", 
                    isHead: true, 
                    status: "Active",
                    permissions: ["livechat", "schedule", "voice", "admin"]
                }
            ],
            adminServers: {}
        };
        fs.writeFileSync(ADMIN_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    try {
        return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    } catch (e) {
        return { admins: [], adminServers: {} };
    }
}

function saveAdminsData(data) {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2));
}

let scheduledJobs = {};
let activeVoiceConnection = null;
let currentAudioPlayer = null;
let voiceAudioStream = new PassThrough();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Admin Auth Middleware
function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'অথরাইজেশন আবশ্যক।' });

    const [email, password] = Buffer.from(authHeader.split(' ')[1] || '', 'base64').toString().split(':');
    const store = loadAdminsData();
    const target = store.admins.find(a => a.email === email && a.pass === password && a.status === 'Active');
    
    if (target) {
        req.adminUser = target;
        return next();
    }
    return res.status(403).json({ error: 'অনুমতি নেই অথবা একাউন্ট ইনঅ্যাক্টিভ!' });
}

// Admin Auth Routes
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    const store = loadAdminsData();
    const admin = store.admins.find(a => a.email === email && a.pass === password && a.status === 'Active');
    
    if (admin) {
        return res.json({ 
            status: 'success', 
            admin: { 
                email: admin.email, 
                name: admin.name, 
                isHead: admin.isHead,
                permissions: admin.permissions || ["livechat", "schedule", "voice"]
            },
            assignedServer: store.adminServers[admin.email] || null
        });
    }
    res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।' });
});

app.get('/api/admin/list', verifyAdmin, (req, res) => {
    const store = loadAdminsData();
    const isHead = req.adminUser.isHead;

    const sanitizedList = store.admins.map(a => ({ 
        id: a.id, 
        email: (a.isHead && !isHead) ? "***HIDDEN***" : a.email, 
        name: a.name, 
        isHead: a.isHead, 
        status: a.status,
        permissions: a.permissions || [],
        assignedServer: store.adminServers[a.email] || null
    }));

    res.json(sanitizedList);
});

app.post('/api/admin/add', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'শুধুমাত্র হেড এডমিন সাব-এডমিন যোগ করতে পারবেন।' });
    const { email, password, name, serverId, permissions } = req.body;
    
    const store = loadAdminsData();
    if (store.admins.find(a => a.email === email)) {
        return res.status(400).json({ error: 'এই ইমেইলটি ইতিপূর্বে যুক্ত করা হয়েছে।' });
    }

    const newAdmin = { 
        id: 'admin_' + Date.now(), 
        email, 
        pass: password, 
        name: name || 'Sub Admin', 
        isHead: false, 
        status: 'Active',
        permissions: permissions || ["livechat"]
    };

    store.admins.push(newAdmin);
    if (serverId) store.adminServers[email] = serverId;

    saveAdminsData(store);
    res.json({ status: 'success', message: 'নতুন সাব-এডমিন সফলভাবে যুক্ত হয়েছে!' });
});

app.post('/api/admin/toggle-status', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { id } = req.body;
    const store = loadAdminsData();
    const target = store.admins.find(a => a.id === id);

    if (target && !target.isHead) {
        target.status = target.status === 'Active' ? 'Inactive' : 'Active';
        saveAdminsData(store);
        return res.json({ status: 'success', newStatus: target.status });
    }
    res.status(400).json({ error: 'হেড এডমিনের স্ট্যাটাস পরিবর্তন করা সম্ভব নয়।' });
});

app.post('/api/admin/delete', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { id } = req.body;
    const store = loadAdminsData();
    const target = store.admins.find(a => a.id === id);

    if (target && target.isHead) return res.status(400).json({ error: 'হেড এডমিনকে ডিলিট করা সম্ভব নয়।' });

    if (target) {
        delete store.adminServers[target.email];
        store.admins = store.admins.filter(a => a.id !== id);
        saveAdminsData(store);
    }
    res.json({ status: 'success', message: 'এডমিন একাউন্ট ডিলিট করা হয়েছে।' });
});

// Guilds Filtering
app.get('/api/guilds', verifyAdmin, (req, res) => {
    if (!client.isReady()) return res.json([]);
    const store = loadAdminsData();
    const allGuilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.icon }));
    
    if (req.adminUser.isHead) {
        return res.json(allGuilds);
    } else {
        const allowedServerId = store.adminServers[req.adminUser.email];
        return res.json(allGuilds.filter(g => g.id === allowedServerId));
    }
});

// Get Category Channels (Text/Announcement)
app.get('/api/guild/:guildId/categories-channels', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        const channels = await guild.channels.fetch();

        const categories = {};
        const uncategorized = [];

        channels.forEach(ch => {
            if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
                const categoryName = ch.parent ? ch.parent.name : 'Uncategorized';
                const channelData = { id: ch.id, name: ch.name, type: ch.type === ChannelType.GuildAnnouncement ? 'Announcement' : 'Text' };

                if (ch.parent) {
                    if (!categories[categoryName]) categories[categoryName] = [];
                    categories[categoryName].push(channelData);
                } else {
                    uncategorized.push(channelData);
                }
            }
        });

        if (uncategorized.length > 0) categories['Uncategorized'] = uncategorized;
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Voice Channels
app.get('/api/guild/:guildId/voice-channels', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        const channels = await guild.channels.fetch();

        const categories = {};
        const uncategorized = [];

        channels.forEach(ch => {
            if (ch.type === ChannelType.GuildVoice) {
                const categoryName = ch.parent ? ch.parent.name : 'Uncategorized';
                const channelData = { id: ch.id, name: ch.name };

                if (ch.parent) {
                    if (!categories[categoryName]) categories[categoryName] = [];
                    categories[categoryName].push(channelData);
                } else {
                    uncategorized.push(channelData);
                }
            }
        });

        if (uncategorized.length > 0) categories['Uncategorized'] = uncategorized;
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fetch Members & Roles - Fast Caching Fix (Eliminating 10-12s Freeze)
app.get('/api/guild/:guildId/members-roles', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        
        const roles = guild.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor }));

        const members = guild.members.cache.filter(m => !m.user.bot).map(m => {
            const highestRole = m.roles.highest;
            return {
                id: m.id,
                tag: m.user.tag,
                username: m.user.username,
                avatar: m.user.displayAvatarURL({ extension: 'png' }),
                displayColor: highestRole ? highestRole.hexColor : '#ffffff',
                roles: m.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
            };
        });

        res.json({ roles, members });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fetch Channel Messages
app.get('/api/channel/:channelId/messages', async (req, res) => {
    try {
        const channel = await client.channels.fetch(req.params.channelId);
        const guild = channel.guild;
        const fetched = await channel.messages.fetch({ limit: 20 });
        
        const messages = await Promise.all(fetched.map(async m => {
            let authorColor = '#ffffff';
            let memberRoles = [];
            try {
                const member = guild.members.cache.get(m.author.id);
                if (member) {
                    authorColor = member.roles.highest ? member.roles.highest.hexColor : '#ffffff';
                    memberRoles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ name: r.name, color: r.hexColor }));
                }
            } catch (e) {}

            return {
                id: m.id,
                author: m.author.tag,
                authorId: m.author.id,
                authorAvatar: m.author.displayAvatarURL({ extension: 'png' }),
                authorColor: authorColor,
                memberRoles: memberRoles,
                content: m.content,
                attachments: m.attachments.map(a => a.url),
                timestamp: m.createdAt.toLocaleString('bn-BD')
            };
        }));
        res.json(messages.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Live Chat Message Emoji Reaction Endpoint (Tick & Cross)
app.post('/api/channel/message/react', async (req, res) => {
    try {
        const { channelId, messageId, emoji } = req.body;
        const channel = await client.channels.fetch(channelId);
        const msg = await channel.messages.fetch(messageId);
        await msg.react(emoji);
        res.json({ status: 'success', message: 'রিএকশন যুক্ত হয়েছে!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Message
app.post('/api/send-message', upload.single('file'), async (req, res) => {
    try {
        const { channelId, messageText, replyToMessageId } = req.body;
        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'চ্যানেলটি পাওয়া যায়নি।' });

        let sendPayload = {};
        if (messageText) sendPayload.content = messageText;
        if (replyToMessageId) sendPayload.reply = { messageReference: replyToMessageId };

        if (req.file) {
            sendPayload.files = [{
                attachment: req.file.path,
                name: req.file.originalname
            }];
        }

        await channel.send(sendPayload);
        if (req.file) fs.unlinkSync(req.file.path);

        res.json({ status: 'success', message: 'মেসেজটি সফলভাবে পাঠানো হয়েছে!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Assign Role
app.post('/api/assign-role-react', async (req, res) => {
    try {
        const { guildId, userId, roleId, channelId, messageId, actionType } = req.body;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        const role = await guild.roles.fetch(roleId);

        if (actionType === 'remove') {
            await member.roles.remove(role);
        } else {
            await member.roles.add(role);
        }

        if (channelId && messageId) {
            try {
                const channel = await client.channels.fetch(channelId);
                const targetMsg = await channel.messages.fetch(messageId);
                await targetMsg.react(actionType === 'remove' ? '❌' : '✅');
            } catch (rErr) {}
        }

        res.json({ status: 'success', message: `সফলভাবে রোল আপডেট করা হয়েছে!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schedule Message
app.post('/api/schedule-message-datetime', upload.single('file'), (req, res) => {
    try {
        const { channelId, messageText, dateTime } = req.body;
        if (!channelId || !dateTime) return res.status(400).json({ error: 'চ্যানেল এবং সময় নির্ধারণ করুন।' });

        const targetDate = new Date(dateTime);
        if (isNaN(targetDate.getTime()) || targetDate <= new Date()) {
            return res.status(400).json({ error: 'ভবিষ্যতের বৈধ তারিখ ও সময় সিলেক্ট করুন।' });
        }

        const minute = targetDate.getMinutes();
        const hour = targetDate.getHours();
        const dayOfMonth = targetDate.getDate();
        const month = targetDate.getMonth() + 1;

        const cronExpr = `${minute} ${hour} ${dayOfMonth} ${month} *`;
        const jobId = 'job_' + Date.now();

        const filePath = req.file ? req.file.path : null;
        const fileName = req.file ? req.file.originalname : null;

        const task = cron.schedule(cronExpr, async () => {
            try {
                const channel = await client.channels.fetch(channelId);
                let payload = {};
                if (messageText) payload.content = messageText;
                if (filePath && fs.existsSync(filePath)) {
                    payload.files = [{ attachment: filePath, name: fileName }];
                }
                await channel.send(payload);
                if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
                delete scheduledJobs[jobId];
            } catch (err) {
                console.error('Schedule Cron Error:', err);
            }
        });

        scheduledJobs[jobId] = { id: jobId, task, channelId, messageText, dateTime: targetDate.toLocaleString('bn-BD') };
        res.json({ status: 'success', message: `মেসেজটি শিডিউল করা হয়েছে!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/scheduled-list', (req, res) => {
    res.json(Object.values(scheduledJobs).map(j => ({ id: j.id, channelId: j.channelId, messageText: j.messageText, dateTime: j.dateTime })));
});

app.post('/api/cancel-schedule', (req, res) => {
    const { jobId } = req.body;
    if (scheduledJobs[jobId]) {
        scheduledJobs[jobId].task.stop();
        delete scheduledJobs[jobId];
        return res.json({ status: 'success', message: 'শিডিউল বাতিল করা হয়েছে।' });
    }
    res.status(404).json({ error: 'শিডিউলটি পাওয়া যায়নি।' });
});

// Dual Voice Control (Join & Listen Receiver Setup)
app.post('/api/voice/join', async (req, res) => {
    try {
        const { guildId, channelId } = req.body;
        const guild = await client.guilds.fetch(guildId);
        
        activeVoiceConnection = joinVoiceChannel({
            channelId: channelId,
            guildId: guildId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        currentAudioPlayer = createAudioPlayer();
        voiceAudioStream = new PassThrough();
        const resource = createAudioResource(voiceAudioStream);
        currentAudioPlayer.play(resource);
        activeVoiceConnection.subscribe(currentAudioPlayer);

        // Receive voice audio from Discord VC users and broadcast to Control Panel
        const receiver = activeVoiceConnection.receiver;
        receiver.speaking.on('start', (userId) => {
            const opusStream = receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: 100 }
            });
            const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
            const pcmStream = opusStream.pipe(decoder);

            pcmStream.on('data', (chunk) => {
                wss.clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) {
                        c.send(chunk);
                    }
                });
            });
        });

        res.json({ status: 'success', message: 'বট ভয়েস চ্যানেলে যুক্ত হয়েছে এবং ভয়েস কানেক্টিভিটি রেডি!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/voice/leave', (req, res) => {
    if (activeVoiceConnection) {
        activeVoiceConnection.destroy();
        activeVoiceConnection = null;
        currentAudioPlayer = null;
        return res.json({ status: 'success', message: 'ভয়েস চ্যানেল ডিসকানেক্ট করা হয়েছে।' });
    }
    res.status(400).json({ error: 'বট কোনো ভয়েস চ্যানেলে যুক্ত নেই।' });
});

// WebSocket Dual Streaming Handler
wss.on('connection', (ws) => {
    ws.on('message', (chunk) => {
        if (activeVoiceConnection && voiceAudioStream) {
            try {
                voiceAudioStream.write(chunk);
            } catch (err) {}
        }
    });
});

const PORT = process.env.PORT || 3000;
client.on('ready', () => console.log(`🤖 TYRONEX Bot Ready: ${client.user.tag}`));
server.listen(PORT, () => console.log(`🌐 Dashboard Live on Port ${PORT}`));
client.login(process.env.BOT_TOKEN);