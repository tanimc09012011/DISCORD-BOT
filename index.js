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

// Permanent Head Admin
const HEAD_ADMIN_EMAIL = "tyronex.tanim@tyronex.com";
const HEAD_ADMIN_PASS = "2011.01.09";

let admins = [
    { id: "head-admin", email: HEAD_ADMIN_EMAIL, pass: HEAD_ADMIN_PASS, name: "Head Admin", isHead: true, status: "Active" }
];
let scheduledJobs = {};

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

// --- API ENDPOINTS ---

// Admin Auth
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    const admin = admins.find(a => a.email === email && a.pass === password && a.status === 'Active');
    if (admin) {
        return res.json({ status: 'success', admin: { email: admin.email, name: admin.name, isHead: admin.isHead } });
    }
    res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।' });
});

app.get('/api/admin/list', verifyAdmin, (req, res) => {
    res.json(admins.map(a => ({ id: a.id, email: a.email, name: a.name, isHead: a.isHead, status: a.status })));
});

app.post('/api/admin/add', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { email, password, name } = req.body;
    if (admins.find(a => a.email === email)) return res.status(400).json({ error: 'ইমেইলটি ব্যবহৃত হচ্ছে।' });

    admins.push({ id: 'admin_' + Date.now(), email, pass: password, name: name || 'Sub Admin', isHead: false, status: 'Active' });
    res.json({ status: 'success', message: 'নতুন এডমিন যুক্ত হয়েছে!' });
});

app.post('/api/admin/toggle-status', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { id } = req.body;
    const target = admins.find(a => a.id === id);
    if (target && !target.isHead) {
        target.status = target.status === 'Active' ? 'Inactive' : 'Active';
        return res.json({ status: 'success', newStatus: target.status });
    }
    res.status(400).json({ error: 'হেড এডমিন চেঞ্জ করা যাবে না।' });
});

app.post('/api/admin/delete', verifyAdmin, (req, res) => {
    if (!req.adminUser.isHead) return res.status(403).json({ error: 'অনুমতি নেই।' });
    const { id } = req.body;
    const target = admins.find(a => a.id === id);
    if (target && target.isHead) return res.status(400).json({ error: 'হেড এডমিন ডিলিট করা সম্ভব নয়।' });

    admins = admins.filter(a => a.id !== id);
    res.json({ status: 'success', message: 'এডমিন ডিলিট করা হয়েছে।' });
});

// Guilds & Channels API
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

app.get('/api/guild/:guildId/members-roles', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        await guild.members.fetch();
        
        const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
        const members = guild.members.cache.filter(m => !m.user.bot).map(m => ({ id: m.id, tag: m.user.tag }));

        res.json({ roles, members });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

// Send Normal Direct Message or Reply with File
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

// Assign Discord Role Directly
app.post('/api/assign-role', async (req, res) => {
    try {
        const { guildId, userId, roleId } = req.body;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        const role = await guild.roles.fetch(roleId);

        await member.roles.add(role);
        res.json({ status: 'success', message: `${member.user.tag} কে ${role.name} রোল দেওয়া হয়েছে!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schedule Message
app.post('/api/schedule-message', upload.single('file'), (req, res) => {
    try {
        const { channelId, messageText, time } = req.body;
        if (!channelId || !time) return res.status(400).json({ error: 'চ্যানেল ও টাইম নির্বাচন করুন।' });

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

        scheduledJobs[jobId] = { id: jobId, task, channelId, messageText, time };
        res.json({ status: 'success', message: `মেসেজটি ${time} সময়ে শিডিউল করা হয়েছে!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/scheduled-messages', (req, res) => {
    res.json(Object.values(scheduledJobs).map(j => ({ id: j.id, channelId: j.channelId, messageText: j.messageText, time: j.time })));
});

app.post('/api/cancel-scheduled-message', (req, res) => {
    const { jobId } = req.body;
    if (scheduledJobs[jobId]) {
        scheduledJobs[jobId].task.stop();
        delete scheduledJobs[jobId];
        return res.json({ status: 'success', message: 'শিডিউল ক্যানসেল করা হয়েছে।' });
    }
    res.status(404).json({ error: 'শিডিউল পাওয়া যায়নি।' });
});

const PORT = process.env.PORT || 3000;
client.on('ready', () => console.log(`🤖 TYRONEX Bot Ready: ${client.user.tag}`));
app.listen(PORT, () => console.log(`🌐 Dashboard Live on ${PORT}`));
client.login(process.env.BOT_TOKEN);