require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Permanent Head Admin Credentials
const HEAD_ADMIN_EMAIL = "tyronex.tanim@tyronex.com";
const HEAD_ADMIN_PASS = "2011.01.09";

// In-Memory Data Stores
let admins = [
    { id: "head-admin", email: HEAD_ADMIN_EMAIL, pass: HEAD_ADMIN_PASS, name: "Head Admin", isHead: true, status: "Active" }
];
let teamDatabase = {};
let summaryLogs = [];
let scheduledJobs = {}; // Format: { jobId: { cronTask, info } }

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Admin Auth Middleware
function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'অথরাইজেশন আবশ্যক।' });

    const [email, password] = Buffer.from(authHeader.split(' ')[1] || '', 'base64').toString().split(':');
    const target = admins.find(a => a.email === email && a.pass === password && a.status === 'Active');
    
    if (target) {
        req.adminUser = target;
        return next();
    }
    return res.status(403).json({ error: 'অনুমতি নেই অথবা একাউন্ট ইনঅ্যাক্টিভ!' });
}

// Parse Raw Team List
function parseTeamList(rawText) {
    const lines = rawText.split('\n');
    let currentGroup = null;
    const parsedData = {};

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        const groupHeaderMatch = trimmed.match(/^GROUP\s*-?\s*([A-Z0-9]+)/i);
        if (groupHeaderMatch) {
            currentGroup = `GROUP - ${groupHeaderMatch[1].toUpperCase()}`;
            if (!parsedData[currentGroup]) parsedData[currentGroup] = [];
            return;
        }

        if (currentGroup) {
            const teamName = trimmed.replace(/^\d+[\.\s]*/, '').trim().toUpperCase();
            if (teamName) parsedData[currentGroup].push(teamName);
        }
    });

    return parsedData;
}

// Auto Verification Logic
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const text = message.content;
    if (text.toUpperCase().includes('TEAM NAME') && text.toUpperCase().includes('GROUP NO')) {
        const teamMatch = text.match(/TEAM\s*NAME\s*:\s*(.+)/i);
        const groupNoMatch = text.match(/GROUP\s*NO\s*-\s*([A-Z0-9]+)/i);
        const groupCodeMatch = text.match(/GROUP\s*CODE\s*-\s*([A-Z0-9]+)/i);

        if (teamMatch && groupNoMatch) {
            const userTeam = teamMatch[1].trim().toUpperCase();
            const userGroupKey = `GROUP - ${groupNoMatch[1].trim().toUpperCase()}`;
            const userCode = groupCodeMatch ? groupCodeMatch[1].trim().toUpperCase() : null;

            const validTeams = teamDatabase[userGroupKey] || [];
            if (validTeams.includes(userTeam)) {
                try {
                    await message.react('✅');
                    let groupRole = message.guild.roles.cache.find(r => r.name.toUpperCase() === userGroupKey.toUpperCase());
                    if (groupRole) await message.member.roles.add(groupRole);

                    if (userCode) {
                        let codeRole = message.guild.roles.cache.find(r => r.name.toUpperCase() === userCode);
                        if (codeRole) await message.member.roles.add(codeRole);
                    }

                    summaryLogs.push({
                        user: message.author.tag,
                        team: userTeam,
                        group: userGroupKey,
                        code: userCode || 'N/A',
                        guild: message.guild.name,
                        time: new Date().toLocaleString('bn-BD')
                    });
                } catch (err) {
                    console.error('Role add error:', err);
                }
            } else {
                await message.react('❌');
            }
        }
    }
});

// --- API ENDPOINTS ---

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    const admin = admins.find(a => a.email === email && a.pass === password && a.status === 'Active');
    if (admin) {
        return res.json({ status: 'success', admin: { email: admin.email, name: admin.name, isHead: admin.isHead } });
    }
    res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।' });
});

// Admin Management APIs
app.get('/api/admin/list', verifyAdmin, (req, res) => {
    res.json(admins.map(a => ({ id: a.id, email: a.email, name: a.name, isHead: a.isHead, status: a.status })));
});

app.post('/api/admin/add', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'শুধুমাত্র হেড এডমিন সাব-এডমিন যোগ করতে পারবেন।' });
    const { email, password, name } = req.body;
    if (admins.find(a => a.email === email)) return res.status(400).json({ error: 'ইমেইলটি ইতোমধ্যে ব্যবহৃত হচ্ছে।' });

    const newAdmin = { id: 'admin_' + Date.now(), email, pass: password, name: name || 'Sub Admin', isHead: false, status: 'Active' };
    admins.push(newAdmin);
    res.json({ status: 'success', message: 'নতুন এডমিন সফলভাবে যুক্ত হয়েছে!' });
});

app.post('/api/admin/toggle-status', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { id } = req.body;
    const target = admins.find(a => a.id === id);
    if (target && !target.isHead) {
        target.status = target.status === 'Active' ? 'Inactive' : 'Active';
        return res.json({ status: 'success', newStatus: target.status });
    }
    res.status(400).json({ error: 'হেড এডমিন স্ট্যাটাস পরিবর্তনযোগ্য নয়।' });
});

app.post('/api/admin/delete', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { id } = req.body;
    const target = admins.find(a => a.id === id);
    if (target && target.isHead) return res.status(400).json({ error: 'হেড এডমিন ডিলিট করা সম্ভব নয়।' });

    admins = admins.filter(a => a.id !== id);
    res.json({ status: 'success', message: 'এডমিন ডিলিট করা হয়েছে।' });
});

// Guilds, Channels & Messages Control
app.get('/api/guilds', (req, res) => {
    if (!client.isReady()) return res.json([]);
    res.json(client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.icon })));
});

app.get('/api/guild/:guildId/channels', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/guild/:guildId/roles', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
        res.json(roles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fetch Recent Channel Messages for Live Interaction
app.get('/api/channel/:channelId/messages', async (req, res) => {
    try {
        const channel = await client.channels.fetch(req.params.channelId);
        const fetched = await channel.messages.fetch({ limit: 15 });
        const messages = fetched.map(m => ({
            id: m.id,
            author: m.author.tag,
            authorId: m.author.id,
            content: m.content,
            attachments: m.attachments.map(a => a.url),
            timestamp: m.createdAt.toLocaleString('bn-BD')
        }));
        res.json(messages.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Message with File Attachment & Optional Reply
app.post('/api/send-message', upload.single('file'), async (req, res) => {
    try {
        const { channelId, messageText, replyToMessageId } = req.body;
        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'চ্যানেল পাওয়া যায়নি।' });

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

        res.json({ status: 'success', message: 'মেসেজ পাঠানো হয়েছে!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schedule Message API with Edit & Cancel
app.post('/api/schedule-message', upload.single('file'), (req, res) => {
    try {
        const { channelId, messageText, time } = req.body;
        if (!channelId || !time) return res.status(400).json({ error: 'সকল ফিল্ড পূরণ করুন।' });

        const [hours, minutes] = time.split(':');
        const cronExpr = `${minutes} ${hours} * * *`;
        const jobId = 'job_' + Date.now();

        const task = cron.schedule(cronExpr, async () => {
            try {
                const channel = await client.channels.fetch(channelId);
                let payload = {};
                if (messageText) payload.content = messageText;
                if (req.file) payload.files = [{ attachment: req.file.path, name: req.file.originalname }];
                await channel.send(payload);
                if (req.file) fs.unlinkSync(req.file.path);
            } catch (err) {
                console.error(err);
            }
        }, { scheduled: true, timezone: "Asia/Dhaka" });

        scheduledJobs[jobId] = {
            id: jobId,
            task,
            channelId,
            messageText,
            time,
            filePath: req.file ? req.file.path : null
        };

        res.json({ status: 'success', message: `মেসেজটি ${time} সময়ে শিডিউল করা হয়েছে!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/scheduled-messages', (req, res) => {
    const jobs = Object.values(scheduledJobs).map(j => ({
        id: j.id,
        channelId: j.channelId,
        messageText: j.messageText,
        time: j.time
    }));
    res.json(jobs);
});

app.post('/api/cancel-scheduled-message', (req, res) => {
    const { jobId } = req.body;
    if (scheduledJobs[jobId]) {
        scheduledJobs[jobId].task.stop();
        if (scheduledJobs[jobId].filePath && fs.existsSync(scheduledJobs[jobId].filePath)) {
            fs.unlinkSync(scheduledJobs[jobId].filePath);
        }
        delete scheduledJobs[jobId];
        return res.json({ status: 'success', message: 'শিডিউল মেসেজ ক্যানসেল করা হয়েছে।' });
    }
    res.status(404).json({ error: 'মেসেজ পাওয়া যায়নি।' });
});

// Assign Member Role via Live Control
app.post('/api/assign-role', async (req, res) => {
    try {
        const { guildId, userId, roleId } = req.body;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(roleId);
        res.json({ status: 'success', message: 'রোল সফলভাবে আসাইন করা হয়েছে!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save Team Database API
app.post('/api/save-teams', verifyAdmin, (req, res) => {
    const { rawList } = req.body;
    if (rawList) {
        teamDatabase = parseTeamList(rawList);
        return res.json({ status: 'success', message: 'টিম লিস্ট সেভ হয়েছে!', data: teamDatabase });
    }
    res.status(400).json({ error: 'টিম লিস্ট খালি হতে পারে না।' });
});

const PORT = process.env.PORT || 3000;
client.on('ready', () => console.log(`🤖 Bot Ready: ${client.user.tag}`));
app.listen(PORT, () => console.log(`🌐 TYRONEX PRODUCTION Dashboard Live on ${PORT}`));
client.login(process.env.BOT_TOKEN);