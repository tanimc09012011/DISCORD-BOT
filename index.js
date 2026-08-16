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
let teamDatabase = {}; // Format: { "GROUP-A": ["NO MERCY", "VIKINGS"], "GROUP-B": ["TTR"] }
let summaryLogs = []; // Successful role assignments

// --- 1. Team Parsing Function ---
function parseTeamList(rawText) {
    const lines = rawText.split('\n');
    let currentGroup = null;
    const parsedData = {};

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Detect GROUP headers (e.g., GROUP - A, GROUP-B)
        const groupHeaderMatch = trimmed.match(/^GROUP\s*-\s*([A-Z0-9]+)/i);
        if (groupHeaderMatch) {
            currentGroup = `GROUP - ${groupHeaderMatch[1].toUpperCase()}`;
            if (!parsedData[currentGroup]) {
                parsedData[currentGroup] = [];
            }
            return;
        }

        // Detect Team Name (e.g., 1.NO MERCY or NO MERCY)
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

                    // Find or Grant Roles
                    const groupRoleName = userGroupKey; // e.g., GROUP - A
                    let groupRole = message.guild.roles.cache.find(r => r.name.toUpperCase() === groupRoleName.toUpperCase());
                    
                    if (groupRole) {
                        await message.member.roles.add(groupRole);
                    }

                    // Add Group Code Role if present
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

// Save Team List API
app.post('/api/save-teams', (req, res) => {
    const { rawList } = req.body;
    if (rawList) {
        teamDatabase = parseTeamList(rawList);
        return res.json({ status: 'success', message: 'টিম লিস্ট সেভ হয়েছে!', data: teamDatabase });
    }
    res.status(400).json({ status: 'error', message: 'টিম লিস্ট ফাঁকা হতে পারে না।' });
});

// Get Current Team List API
app.get('/api/get-teams', (req, res) => {
    res.json({ teams: teamDatabase });
});

// Send Direct Message & File API
app.post('/api/send-message', upload.single('file'), async (req, res) => {
    try {
        const { channelId, messageText } = req.body;
        if (!channelId) return res.status(400).json({ error: 'চ্যানেল আই‌ডি প্রয়োজন' });

        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'চ্যানেল পাওয়া যায়নি' });

        let sendPayload = {};
        if (messageText) sendPayload.content = messageText;

        if (req.file) {
            sendPayload.files = [{
                attachment: req.file.path,
                name: req.file.originalname
            }];
        }

        await channel.send(sendPayload);

        // Delete uploaded temp file
        if (req.file) fs.unlinkSync(req.file.path);

        res.json({ status: 'success', message: 'মেসেজ পাঠানো হয়েছে!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'মেসেজ পাঠানো ব্যর্থ হয়েছে: ' + err.message });
    }
});

// Schedule Message API
app.post('/api/schedule-message', (req, res) => {
    try {
        const { channelId, messageText, time } = req.body;
        if (!channelId || !messageText || !time) {
            return res.status(400).json({ error: 'সকল ফিল্ড পূরণ করুন।' });
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

// --- 4. Start Bot and Server ---
const PORT = process.env.PORT || 3000;

client.on('ready', () => {
    console.log(`🤖 Bot Logged in as ${client.user.tag}`);
});

app.listen(PORT, () => {
    console.log(`🌐 Web Dashboard running on port ${PORT}`);
});

// Login Bot using Environment Variable
client.login(process.env.BOT_TOKEN);