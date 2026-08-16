require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin Authentication Credentials
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "tyronex.tanim@tyronex.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "2011.01.09";

// Auth Verification Middleware
function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'পাসওয়ার্ড এবং ইমেইল দেওয়া বাধ্যতামূলক।' });
    }

    const [email, password] = Buffer.from(authHeader.split(' ')[1] || '', 'base64').toString().split(':');
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
        return next();
    }
    return res.status(403).json({ error: 'ভুল ইমেইল বা পাসওয়ার্ড!' });
}

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Global Store for Data
let teamDatabase = {}; // Format: { "GROUP - B": ["TTR", "NO MERCY"] }
let summaryLogs = []; // Successful role assignments

// --- 1. Team Parsing Function ---
function parseTeamList(rawText) {
    const lines = rawText.split('\n');
    let currentGroup = null;
    const parsedData = {};

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Detect GROUP headers (e.g., GROUP - A, GROUP-B, GROUP B)
        const groupHeaderMatch = trimmed.match(/^GROUP\s*-?\s*([A-Z0-9]+)/i);
        if (groupHeaderMatch) {
            currentGroup = `GROUP - ${groupHeaderMatch[1].toUpperCase()}`;
            if (!parsedData[currentGroup]) {
                parsedData[currentGroup] = [];
            }
            return;
        }

        // Detect Team Name (e.g., 1. TTR or TTR)
        if (currentGroup) {
            const teamName = trimmed.replace(/^\d+[\.\s]*/, '').trim().toUpperCase();
            if (teamName) {
                parsedData[currentGroup].push(teamName);
            }
        }
    });

    return parsedData;
}

// --- 2. Discord Bot Auto Verification Logic ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const text = message.content;

    // Check if the message contains required fields
    if (text.toUpperCase().includes('TEAM NAME') && text.toUpperCase().includes('GROUP NO')) {
        const teamMatch = text.match(/TEAM\s*NAME\s*:\s*(.+)/i);
        const groupNoMatch = text.match(/GROUP\s*NO\s*-\s*([A-Z0-9]+)/i);
        const groupCodeMatch = text.match(/GROUP\s*CODE\s*-\s*([A-Z0-9]+)/i);

        if (teamMatch && groupNoMatch) {
            const userTeam = teamMatch[1].trim().toUpperCase();
            const userGroupKey = `GROUP - ${groupNoMatch[1].trim().toUpperCase()}`;
            const userCode = groupCodeMatch ? groupCodeMatch[1].trim().toUpperCase() : null;

            // Check if team exists in saved team list
            const validTeams = teamDatabase[userGroupKey] || [];
            const isTeamValid = validTeams.includes(userTeam);

            if (isTeamValid) {
                try {
                    // React with Checkmark
                    await message.react('✅');

                    // Grant Group Role (e.g., GROUP - B)
                    let groupRole = message.guild.roles.cache.find(r => r.name.toUpperCase() === userGroupKey.toUpperCase());
                    if (groupRole) {
                        await message.member.roles.add(groupRole);
                    }

                    // Grant Group Code Role if present (e.g., 79)
                    if (userCode) {
                        let codeRole = message.guild.roles.cache.find(r => r.name.toUpperCase() === userCode);
                        if (codeRole) {
                            await message.member.roles.add(codeRole);
                        }
                    }

                    // Save to summary log
                    summaryLogs.push({
                        user: message.author.tag,
                        team: userTeam,
                        group: userGroupKey,
                        code: userCode || 'N/A',
                        guild: message.guild.name,
                        time: new Date().toLocaleString('bn-BD')
                    });

                } catch (err) {
                    console.error('Error granting role:', err);
                }
            } else {
                // React with Cross if validation fails
                await message.react('❌');
            }
        }
    }
});

// --- 3. Web Dashboard API Endpoints ---

// Get All Active Guilds/Servers where bot is added
app.get('/api/guilds', (req, res) => {
    if (!client.isReady()) return res.json([]);
    
    const guilds = client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon
    }));
    
    res.json(guilds);
});

// Get Channels of a specific Server
app.get('/api/guild/:guildId/channels', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'সার্ভার পাওয়া যায়নি' });

        const channels = guild.channels.cache
            .filter(c => c.type === 0) // 0 = Text Channel
            .map(c => ({ id: c.id, name: c.name }));

        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Roles of a specific Server
app.get('/api/guild/:guildId/roles', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'সার্ভার পাওয়া যায়নি' });

        const roles = guild.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => ({ id: r.id, name: r.name }));

        res.json(roles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save Team List API
app.post('/api/save-teams', authenticateAdmin, (req, res) => {
    const { rawList } = req.body;
    if (rawList) {
        teamDatabase = parseTeamList(rawList);
        return res.json({ status: 'success', message: 'টিম লিস্ট সফলভাবে সেভ হয়েছে!', data: teamDatabase });
    }
    res.status(400).json({ status: 'error', message: 'টিম লিস্ট খালি হতে পারে না।' });
});

// Get Current Team List API
app.get('/api/get-teams', (req, res) => {
    res.json({ teams: teamDatabase });
});

// Send Direct Message & File API
app.post('/api/send-message', upload.single('file'), async (req, res) => {
    try {
        const { channelId, messageText } = req.body;
        if (!channelId) return res.status(400).json({ error: 'একটি চ্যানেল সিলেক্ট করুন।' });

        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'চ্যানেল পাওয়া যায়নি।' });

        let sendPayload = {};
        if (messageText) sendPayload.content = messageText;

        if (req.file) {
            sendPayload.files = [{
                attachment: req.file.path,
                name: req.file.originalname
            }];
        }

        await channel.send(sendPayload);

        if (req.file) fs.unlinkSync(req.file.path);

        res.json({ status: 'success', message: 'মেসেজ সফলতা সহকারে পাঠানো হয়েছে!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'মেসেজ পাঠাতে সমস্যা হয়েছে: ' + err.message });
    }
});

// Schedule Message API
app.post('/api/schedule-message', (req, res) => {
    try {
        const { channelId, messageText, time } = req.body;
        if (!channelId || !messageText || !time) {
            return res.status(400).json({ error: 'সবগুলো ঘর ঠিকমতো পূরণ করুন।' });
        }

        const [hours, minutes] = time.split(':');
        const cronExpression = `${minutes} ${hours} * * *`;

        cron.schedule(cronExpression, async () => {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel) {
                    await channel.send(messageText);
                    console.log(`Scheduled message sent to ${channelId}`);
                }
            } catch (err) {
                console.error('Error sending scheduled message:', err);
            }
        }, {
            scheduled: true,
            timezone: "Asia/Dhaka"
        });

        res.json({ status: 'success', message: `মেসেজটি ${time} সময়ে শিডিউল করা হয়েছে!` });
    } catch (err) {
        res.status(500).json({ error: 'শিডিউল করা সম্ভব হয়নি: ' + err.message });
    }
});

// Get Role Summary Logs API
app.get('/api/summary', (req, res) => {
    res.json({ logs: summaryLogs });
});

// --- 4. Start Server ---
const PORT = process.env.PORT || 3000;

client.on('ready', () => {
    console.log(`🤖 Bot Logged in as ${client.user.tag}`);
});

app.listen(PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${PORT}`);
});

client.login(process.env.BOT_TOKEN);