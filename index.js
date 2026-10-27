import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import process from 'node:process';
import http from 'http';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Events, Partials, PermissionFlagsBits, ChannelType } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables across standard local paths
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '.env'),
];

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

// Optional HTTP health check endpoint for platforms like Render Web Services
let healthServer = null;
const healthPort = process.env.PORT;
if (healthPort) {
  try {
    healthServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'matchdistrict-manager-discord-bot' }));
    });
    healthServer.listen(healthPort, '0.0.0.0', () => {
      console.log(`[Discord Bot] 🌐 Health check server listening on port ${healthPort}`);
    });
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Health check server error:', err.message);
  }
}

/**
 * Clean and retrieve the Discord Bot Token from environment variables.
 * Never prints or leaks the token to logs or errors.
 */
function getBotToken() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (typeof token !== 'string') return '';
  return token.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Formats the official MatchDistrict welcome message for a new member.
 * Sends complete platform details, tournaments info, and website link.
 * @param {string} username - Personalized name of the member.
 * @param {string} [guildName] - Name of the Discord server.
 * @returns {string} The formatted welcome message.
 */
export function buildWelcomeMessage(username, guildName = 'MatchDistrict') {
  return `Hey **${username}**! Welcome to **${guildName}**! 🎉

We are thrilled to have you in our esports gaming community!

🌐 **Official Website & Platform Details:**
• 🔗 **Website:** https://matchdistrict.in
• 🏆 **Tournaments & Scrims:** Join daily competitive cups, custom rooms, and paid/free tournaments (BGMI, Free Fire, Valorant, CODM).
• 📊 **Live Leaderboards:** Real-time player statistics, match results, standings, and automated qualification tracking.
• 👥 **Team Management:** Create or join esports squads, manage rosters, and register with your teammates.
• 💰 **Verified Prize Payouts:** Secure, transparent payouts directly to tournament winners.

🤖 **Server Bot Commands (Prefix: \`.\`):**
• \`.website\` — Get direct links to the MatchDistrict platform
• \`.ping\` — Check bot latency & status
• \`.help\` — View available commands

Have fun, play fair, and see you in the battleground! 🚀

— **Team MatchDistrict**`;
}

/**
 * Bot Command Prefix (Default: '.')
 */
export const PREFIX = process.env.DISCORD_PREFIX || '.';

/**
 * Guild settings persistence for welcome activation and private log channels.
 */
const SETTINGS_FILE = path.resolve(__dirname, 'guildSettings.json');

function loadGuildSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error loading guild settings:', err.message);
  }
  return {};
}

function saveGuildSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error saving guild settings:', err.message);
  }
}

export let guildSettingsCache = loadGuildSettings();

export function isWelcomeEnabled(guildId) {
  if (!guildId) return false;
  return Boolean(guildSettingsCache[guildId]?.welcomeEnabled);
}

export function getGuildLogChannelId(guildId) {
  if (!guildId) return null;
  return guildSettingsCache[guildId]?.logChannelId || null;
}

/**
 * Command response templates
 */
export function getPingResponse(roundtripLatency, wsLatency) {
  return `🏓 **Pong!**\n• Latency: **${roundtripLatency}ms**\n• WebSocket API: **${wsLatency >= 0 ? wsLatency : 0}ms**`;
}

export function getHelpResponse(prefix = PREFIX) {
  return (
    `🎮 **MatchDistrict Bot Commands**\n` +
    `Prefix: \`${prefix}\`\n\n` +
    `• \`${prefix}setup\` — *(Admin Only)* Enable welcome DMs & create private log channel\n` +
    `• \`${prefix}status\` — Check if welcome DMs are enabled on this server\n` +
    `• \`${prefix}website\` — Get the official MatchDistrict platform link\n` +
    `• \`${prefix}ping\` — Check bot response time & WebSocket latency\n` +
    `• \`${prefix}help\` — Show this list of commands\n\n` +
    `🌐 Visit our platform: https://matchdistrict.in\n` +
    `— Team MatchDistrict`
  );
}

export function getWebsiteResponse() {
  return (
    `🌐 **MatchDistrict Platform**\n` +
    `Official Website: https://matchdistrict.in\n\n` +
    `Compete in esports tournaments, discover teams, and climb live leaderboards!`
  );
}

/**
 * Handles the .setup command to enable welcome messages and create the private log channel.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {(msg: string) => Promise<any>} replyFn
 */
export async function handleSetupCommand(guild, member, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  // 1. Check user permissions (Administrator or ManageGuild required)
  const isAdmin = member?.permissions?.has(PermissionFlagsBits.Administrator) ||
                  member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) {
    await replyFn('❌ **Permission Denied:** Only server Administrators or members with `Manage Server` permission can run `.setup`.');
    return;
  }

  // 2. Check bot permissions to manage channels
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await replyFn('❌ **Bot Permission Missing:** I need the `Manage Channels` permission to create and configure the private log channel. Please grant this permission and try `.setup` again.');
    return;
  }

  // 3. Find existing log channel or create a new private channel
  const channelName = 'matchdistrict-logs';
  let logChannel = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && (c.name === channelName || c.name === 'md-welcome-logs')
  );

  if (!logChannel) {
    try {
      logChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: 'Private MatchDistrict Bot Logs (Welcome DMs & Join Events)',
        permissionOverwrites: [
          {
            id: guild.id, // @everyone role
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: guild.client.user.id, // Bot itself
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      });
    } catch (err) {
      console.error('[Discord Bot] ❌ Failed to create private log channel:', err);
      await replyFn(`❌ **Channel Creation Failed:** Could not create private log channel: ${err.message}`);
      return;
    }
  }

  // 4. Save guild settings
  guildSettingsCache[guild.id] = {
    welcomeEnabled: true,
    logChannelId: logChannel.id,
    setupBy: member.id,
    setupAt: new Date().toISOString(),
  };
  saveGuildSettings(guildSettingsCache);

  console.log(`[Discord Bot] 🔒 Setup completed for "${guild.name}" (${guild.id}). Welcome enabled, log channel: #${logChannel.name} (${logChannel.id})`);

  // 5. Send confirmation to the server channel
  await replyFn(
    `✅ **MatchDistrict Setup Complete!**\n\n` +
    `• **Welcome DMs:** **Enabled** for all new members joining this server.\n` +
    `• **Private Log Channel:** <#${logChannel.id}>\n\n` +
    `Whenever someone joins, the bot will send them a welcome DM containing website details and log the delivery in <#${logChannel.id}>.`
  );

  // 6. Send activation message into the private log channel
  try {
    await logChannel.send(
      `🔒 **MatchDistrict Private Log Channel Activated**\n` +
      `• **Status:** Active & logging welcome DMs\n` +
      `• **Configured by:** <@${member.id}>\n` +
      `• **Website Sent to Players:** https://matchdistrict.in\n` +
      `• **Timestamp:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
      `*All member join events and welcome DM delivery statuses will be posted here.*`
    );
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Could not send activation message to log channel:', err.message);
  }
}

/**
 * Handles the .status command to check server setup status.
 */
export async function handleStatusCommand(guild, replyFn) {
  if (!guild) {
    await replyFn('❌ This command must be executed within a Discord server.');
    return;
  }

  const enabled = isWelcomeEnabled(guild.id);
  const logChannelId = getGuildLogChannelId(guild.id);

  if (enabled) {
    await replyFn(
      `📊 **MatchDistrict Server Status**\n` +
      `• **Welcome DMs:** 🟢 **Active / Enabled**\n` +
      `• **Private Log Channel:** ${logChannelId ? `<#${logChannelId}>` : 'Not configured'}\n` +
      `• **Website:** https://matchdistrict.in`
    );
  } else {
    await replyFn(
      `📊 **MatchDistrict Server Status**\n` +
      `• **Welcome DMs:** 🔴 **Disabled**\n` +
      `• An administrator must run \`${PREFIX}setup\` in this server to enable welcome DMs and create the private log channel.`
    );
  }
}

/**
 * Initialize Discord Client with required intents and partials.
 * Includes Guilds, GuildMembers (welcome DMs), GuildMessages, and MessageContent (prefix commands).
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Privileged Server Members Intent
    GatewayIntentBits.GuildMessages, // Message receive intent
    GatewayIntentBits.MessageContent, // Privileged Message Content Intent (for .prefix commands)
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.GuildMember, Partials.User, Partials.Channel, Partials.Message],
});

/**
 * Application Slash Commands definition
 */
const COMMANDS = [
  {
    name: 'setup',
    description: 'Enable welcome DMs and create the private log channel (Admin only)',
  },
  {
    name: 'status',
    description: 'Check if welcome DMs are enabled on this server',
  },
  {
    name: 'ping',
    description: 'Check MatchDistrict bot response time and WebSocket latency',
  },
  {
    name: 'help',
    description: 'Show MatchDistrict bot commands and prefix information',
  },
  {
    name: 'website',
    description: 'Get the official MatchDistrict platform website link',
  },
];

// Bot ready event listener
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Discord Bot] 🚀 Logged in as ${readyClient.user.tag} (ID: ${readyClient.user.id})`);
  console.log(`[Discord Bot] 🎮 MatchDistrict Bot is active across ${readyClient.guilds.cache.size} server(s).`);
  console.log(`[Discord Bot] ⚡ Active command prefix: "${PREFIX}" (.setup, .status, .ping, .help, .website)`);

  try {
    // Automatically register slash commands with Discord API
    await readyClient.application.commands.set(COMMANDS);
    console.log('[Discord Bot] ⚡ Registered slash commands successfully.');
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Could not register slash commands:', error.message);
  }
});

// Handle Prefix Commands (.setup, .status, .ping, .help, .website)
client.on(Events.MessageCreate, async (message) => {
  try {
    // Ignore bots and empty messages
    if (!message || message.author?.bot) return;

    const content = message.content?.trim();
    if (!content || !content.startsWith(PREFIX)) return;

    // Parse command and arguments
    const withoutPrefix = content.slice(PREFIX.length).trim();
    if (!withoutPrefix) return;

    const [rawCmd] = withoutPrefix.split(/\s+/);
    const cmd = rawCmd.toLowerCase();

    if (cmd === 'setup') {
      await handleSetupCommand(message.guild, message.member, (text) => message.reply(text));
    } else if (cmd === 'status') {
      await handleStatusCommand(message.guild, (text) => message.reply(text));
    } else if (cmd === 'ping') {
      const sent = await message.reply('🏓 Pinging...');
      const roundtripLatency = sent.createdTimestamp - message.createdTimestamp;
      const wsLatency = Math.round(message.client.ws.ping);
      await sent.edit(getPingResponse(roundtripLatency, wsLatency));
    } else if (cmd === 'help') {
      await message.reply(getHelpResponse(PREFIX));
    } else if (cmd === 'website' || cmd === 'site') {
      await message.reply(getWebsiteResponse());
    }
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Error executing prefix command:', error.message);
  }
});

// Handle Slash Commands (Interactions)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'setup') {
      await interaction.deferReply();
      await handleSetupCommand(interaction.guild, interaction.member, async (text) => {
        if (interaction.deferred || interaction.replied) {
          return interaction.editReply(text);
        }
        return interaction.reply(text);
      });
    } else if (interaction.commandName === 'status') {
      await handleStatusCommand(interaction.guild, (text) => interaction.reply(text));
    } else if (interaction.commandName === 'ping') {
      const sent = await interaction.reply({
        content: '🏓 Pinging...',
        fetchReply: true,
      });

      const roundtripLatency = sent.createdTimestamp - interaction.createdTimestamp;
      const wsLatency = Math.round(interaction.client.ws.ping);

      await interaction.editReply(getPingResponse(roundtripLatency, wsLatency));
    } else if (interaction.commandName === 'help') {
      await interaction.reply(getHelpResponse(PREFIX));
    } else if (interaction.commandName === 'website') {
      await interaction.reply(getWebsiteResponse());
    }
  } catch (error) {
    console.warn(`[Discord Bot] ⚠️ Error executing /${interaction.commandName} command:`, error.message);
  }
});

// Listen for new members joining the server
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    // Ignore bot accounts to prevent loopbacks and spam
    if (!member || member.user?.bot) {
      return;
    }

    const guildId = member.guild?.id;
    const guildName = member.guild?.name || 'MatchDistrict';
    const username = member.user?.globalName || member.user?.username || member.displayName || 'Gamer';
    const userTag = member.user?.tag || member.user?.username || member.id;

    // Check if welcome is enabled for this server
    if (!isWelcomeEnabled(guildId)) {
      console.log(`[Discord Bot] ℹ️ Member ${userTag} joined "${guildName}", but welcome is NOT enabled on this server (Admin must run ${PREFIX}setup).`);
      return;
    }

    console.log(`[Discord Bot] 👤 New member joined "${guildName}": ${userTag} (${member.id})`);

    const welcomeMessage = buildWelcomeMessage(username, guildName);

    // Locate private log channel
    const logChannelId = getGuildLogChannelId(guildId);
    let logChannel = logChannelId ? member.guild.channels.cache.get(logChannelId) : null;
    if (!logChannel) {
      logChannel = member.guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && (c.name === 'matchdistrict-logs' || c.name === 'md-welcome-logs')
      );
    }

    // Attempt to deliver the welcome message via Direct Message (DM)
    let dmDelivered = false;
    let failReason = null;
    try {
      await member.send(welcomeMessage);
      dmDelivered = true;
      console.log(`[Discord Bot] ✅ Successfully sent welcome DM to ${userTag} (${member.id})`);
    } catch (dmError) {
      if (dmError?.code === 50007) {
        failReason = 'User has DMs disabled in privacy settings';
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag} (${member.id}): User has DMs disabled or blocked.`);
      } else {
        failReason = dmError.message;
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag} (${member.id}): ${dmError.message}`);
      }
    }

    // Send log entry to private log channel
    if (logChannel && logChannel.permissionsFor(member.guild.members.me)?.has('SendMessages')) {
      const accountAge = Math.floor(member.user.createdTimestamp / 1000);
      const nowTs = Math.floor(Date.now() / 1000);

      if (dmDelivered) {
        await logChannel.send(
          `📥 **Welcome DM Sent**\n` +
          `• **Member:** <@${member.id}> (\`${userTag}\` | ID: \`${member.id}\`)\n` +
          `• **Account Created:** <t:${accountAge}:R>\n` +
          `• **Status:** ✅ **Delivered via Direct Message**\n` +
          `• **Website Sent:** https://matchdistrict.in\n` +
          `• **Logged At:** <t:${nowTs}:T>`
        );
      } else {
        await logChannel.send(
          `⚠️ **Welcome DM Delivery Failed**\n` +
          `• **Member:** <@${member.id}> (\`${userTag}\` | ID: \`${member.id}\`)\n` +
          `• **Account Created:** <t:${accountAge}:R>\n` +
          `• **Status:** ❌ **Failed (${failReason})**\n` +
          `• **Notice:** User does not allow DMs from server members.\n` +
          `• **Logged At:** <t:${nowTs}:T>`
        );
      }
    }
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Unexpected error in GuildMemberAdd handler:', error.message);
  }
});

// Client connection and shard error handlers
client.on(Events.Error, (error) => {
  console.error('[Discord Bot] ❌ Discord client encountered an error:', error.message);
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`[Discord Bot] ❌ Connection error on shard ${shardId}:`, error.message);
});

/**
 * Start the Discord bot using the configured DISCORD_BOT_TOKEN.
 * @param {string} [tokenOverride] - Optional token override.
 * @returns {Promise<Client|null>}
 */
export async function startBot(tokenOverride) {
  const token = tokenOverride || getBotToken();

  if (!token) {
    console.error('[Discord Bot] ❌ DISCORD_BOT_TOKEN is not configured.');
    console.error('[Discord Bot] ℹ️ Please configure DISCORD_BOT_TOKEN in your environment or .env file.');
    console.error('[Discord Bot] ℹ️ Remember to enable "SERVER MEMBERS INTENT" in the Discord Developer Portal:');
    console.error('[Discord Bot]    https://discord.com/developers/applications -> [Your App] -> Bot -> Privileged Gateway Intents -> Server Members Intent.');
    return null;
  }

  try {
    console.log('[Discord Bot] 🔄 Connecting to Discord Gateway...');
    await client.login(token);
    return client;
  } catch (error) {
    console.error('[Discord Bot] ❌ Connection failed:');
    if (error.message?.includes('Privileged intent') || error.message?.includes('disallowed intent')) {
      console.error('[Discord Bot] 🚨 Privileged Gateway Intent missing! In the Discord Developer Portal, under Bot -> Privileged Gateway Intents, ensure you enable:');
      console.error('[Discord Bot]    1. "SERVER MEMBERS INTENT" (for welcome DMs)');
      console.error('[Discord Bot]    2. "MESSAGE CONTENT INTENT" (for prefix commands .ping, .help, .website)');
    } else if (error.message?.includes('An invalid token')) {
      console.error('[Discord Bot] 🚨 The provided DISCORD_BOT_TOKEN is invalid. Please double-check your bot token.');
    } else {
      console.error(`[Discord Bot] 🚨 ${error.message}`);
    }
    throw error;
  }
}

// Graceful shutdown handling
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Discord Bot] Received ${signal}. Shutting down bot gracefully...`);
  try {
    if (healthServer) {
      healthServer.close();
    }
    await client.destroy();
    console.log('[Discord Bot] Disconnected from Discord.');
  } catch {
    // Suppress destroy errors on exit
  }
  process.exit(0);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Auto-start bot when this file is executed
startBot().catch((error) => {
  console.error('[Discord Bot] ❌ Fatal startup error:', error?.message || error);
  process.exit(1);
});
