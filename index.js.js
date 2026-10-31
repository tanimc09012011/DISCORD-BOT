const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates 
    ] 
});

client.once('ready', async () => {
    console.log(`${client.user.tag} hisebe login kora hoyeche!`);

    // Command gulo register korar jonno setup
    const commands = [
        // १. /text command (lekha option soho)
        new SlashCommandBuilder()
            .setName('text')
            .setDescription('Apni ja likhben bot seta abar repeat korbe.')
            .addStringOption(option =>
                option.setName('message')
                    .setDescription('Je lekha ta bot diye pathate chan')
                    .setRequired(true)
            ),

        // ২. /play command (gan-er nam ba URL option soho)
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Voice channel-e gan play korbe.')
            .addStringOption(option =>
                option.setName('query')
                    .setDescription('Ganer nam ba link din')
                    .setRequired(true)
            ),

        // ৩. /join command (user je vc te ache sekhane join korbe)
        new SlashCommandBuilder()
            .setName('join')
            .setDescription('Apnar voice channel-e join korbe.')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken('YOUR_BOT_TOKEN');

    try {
        console.log('Slash commands registration cholteche...');
        await rest.put(
            Routes.applicationGuildCommands('YOUR_CLIENT_ID', 'YOUR_GUILD_ID'),
            { body: commands },
        );
        console.log('Slash commands safolvabe register hoyeche!');
    } catch (error) {
        console.error(error);
    }
});

// Command gulo kaj koranor logik
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // ১. /text command er kaj
    if (commandName === 'text') {
        const textMessage = interaction.options.getString('message');
        await interaction.reply({ content: textMessage });
    }

    // ২. /join command er kaj
    else if (commandName === 'join') {
        const memberChannel = interaction.member.voice.channel;

        if (!memberChannel) {
            return interaction.reply({ content: 'Prothome apnake kono voice channel-e join korte hobe!', ephemeral: true });
        }

        try {
            joinVoiceChannel({
                channelId: memberChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            await interaction.reply(`Connected to **${memberChannel.name}**!`);
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: 'Voice channel-e join korte somossa hoyeche.', ephemeral: true });
        }
    }

    // ৩. /play command er kaj
    else if (commandName === 'play') {
        const songQuery = interaction.options.getString('query');
        const memberChannel = interaction.member.voice.channel;

        if (!memberChannel) {
            return interaction.reply({ content: 'Gan shonar jonno prothome apnake voice channel-e thakte hobe!', ephemeral: true });
        }

        // Voice channel-e connect kora
        const connection = joinVoiceChannel({
            channelId: memberChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        // Ekhane apni apnar music player library (yemon: play-dl ba ytdl-core) connect korte parben.
        await interaction.reply(`Play kora hocche: **${songQuery}**`);
    }
});

client.login('YOUR_BOT_TOKEN');