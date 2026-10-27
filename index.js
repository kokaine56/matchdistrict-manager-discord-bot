import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import process from 'node:process';
import http from 'http';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';

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
 * Command response templates
 */
export function getPingResponse(roundtripLatency, wsLatency) {
  return `🏓 **Pong!**\n• Latency: **${roundtripLatency}ms**\n• WebSocket API: **${wsLatency >= 0 ? wsLatency : 0}ms**`;
}

export function getHelpResponse(prefix = PREFIX) {
  return (
    `🎮 **MatchDistrict Bot Commands**\n` +
    `Prefix: \`${prefix}\`\n\n` +
    `• \`${prefix}ping\` — Check bot response time & WebSocket latency\n` +
    `• \`${prefix}website\` — Get the official MatchDistrict platform link\n` +
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
  console.log(`[Discord Bot] ⚡ Active command prefix: "${PREFIX}" (.ping, .help, .website)`);

  try {
    // Automatically register slash commands with Discord API
    await readyClient.application.commands.set(COMMANDS);
    console.log('[Discord Bot] ⚡ Registered slash commands successfully.');
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Could not register slash commands:', error.message);
  }
});

// Handle Prefix Commands (.ping, .help, .website)
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

    if (cmd === 'ping') {
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
    if (interaction.commandName === 'ping') {
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

    const username = member.user?.globalName || member.user?.username || member.displayName || 'Gamer';
    const userTag = member.user?.tag || member.user?.username || member.id;
    const guildName = member.guild?.name || 'MatchDistrict';

    console.log(`[Discord Bot] 👤 New member joined "${guildName}": ${userTag} (${member.id})`);

    const welcomeMessage = buildWelcomeMessage(username, guildName);

    // Attempt to deliver the welcome message via Direct Message (DM)
    try {
      await member.send(welcomeMessage);
      console.log(`[Discord Bot] ✅ Successfully sent welcome DM to ${userTag} (${member.id})`);
    } catch (dmError) {
      // Handle members with DMs disabled (Discord error code 50007: "Cannot send messages to this user")
      if (dmError?.code === 50007) {
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag} (${member.id}): User has DMs disabled or blocked. Attempting fallback to public welcome channel.`);
        // Fallback: Post welcoming greeting with website link in system/welcome channel if available
        const welcomeChannel = member.guild?.systemChannel || member.guild?.channels?.cache?.find(c =>
          c.isTextBased?.() && /welcome|general|lounge|chat/i.test(c.name)
        );
        if (welcomeChannel && welcomeChannel.permissionsFor(member.guild.members.me)?.has('SendMessages')) {
          await welcomeChannel.send(
            `Hey ${member}! Welcome to **${guildName}**! 🎉 Check out our platform and tournaments at https://matchdistrict.in *(Enable DMs from server members to receive full tournament updates!)*`
          );
        }
      } else {
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag} (${member.id}): ${dmError.message}`);
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
