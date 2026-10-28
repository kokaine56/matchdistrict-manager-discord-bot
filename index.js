import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import process from 'node:process';
import http from 'http';
import dotenv from 'dotenv';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  PermissionFlagsBits,
  ChannelType,
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  handleListTournamentCommand,
  handleFetchTeamsCommand,
  checkTournamentAccess,
  isOfficialGuild,
  getOfficialGuildId,
  syncTournamentDiscordChannels,
  formatTournamentListPages,
  guildTournamentSessions,
  buildTournamentControlPanelEmbed,
  buildTournamentControlPanelButtons,
  setupTournamentControlPanel,
  handleSelectTournamentCommand,
  handleTournamentButtonInteraction,
  deleteTournamentDiscordChannels,
  updateTeamsRosterMessages,
  updateRegistrationLinkMessage,
  formatRegistrationMessage,
  withTournamentLock,
  fetchUserEligibleTournamentsFromBackend,
  syncMemberTournamentAccess,
  reconcileAllTournamentAccess,
  normalizeTournamentRoleName,
  getOrCreateTournamentRole,
  syncTournamentRoles,
  syncMemberTournamentRoles,
  reconcileAllTournamentRoles,
  handleSyncRolesCommand,
} from './tournamentService.js';

export {
  handleListTournamentCommand,
  handleFetchTeamsCommand,
  checkTournamentAccess,
  isOfficialGuild,
  getOfficialGuildId,
  syncTournamentDiscordChannels,
  formatTournamentListPages,
  guildTournamentSessions,
  buildTournamentControlPanelEmbed,
  buildTournamentControlPanelButtons,
  setupTournamentControlPanel,
  handleSelectTournamentCommand,
  handleTournamentButtonInteraction,
  deleteTournamentDiscordChannels,
  updateTeamsRosterMessages,
  updateRegistrationLinkMessage,
  formatRegistrationMessage,
  withTournamentLock,
  fetchUserEligibleTournamentsFromBackend,
  syncMemberTournamentAccess,
  reconcileAllTournamentAccess,
  normalizeTournamentRoleName,
  getOrCreateTournamentRole,
  syncTournamentRoles,
  syncMemberTournamentRoles,
  reconcileAllTournamentRoles,
  handleSyncRolesCommand,
};

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

// HTTP server for health checks & secure backend-to-bot sync endpoints
let healthServer = null;
const healthPort = process.env.PORT;
if (healthPort) {
  try {
    healthServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'matchdistrict-manager-discord-bot' }));
        return;
      }

      // Authenticated Webhook / Sync endpoint: POST /api/bot/sync/user
      if (req.method === 'POST' && pathname === '/api/bot/sync/user') {
        const secret = process.env.MATCHDISTRICT_BOT_SECRET;
        const incoming = req.headers['x-bot-secret'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
        if (!secret || incoming !== secret) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'UNAUTHORIZED' }));
          return;
        }

        let bodyStr = '';
        req.on('data', (chunk) => { bodyStr += chunk; });
        req.on('end', async () => {
          try {
            const body = JSON.parse(bodyStr || '{}');
            const discordId = body.discord_id;
            const officialGuildId = getOfficialGuildId();
            if (discordId && officialGuildId && client?.guilds) {
              const guild = client.guilds.cache.get(officialGuildId) || await client.guilds.fetch(officialGuildId).catch(() => null);
              if (guild) {
                const member = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
                if (member) {
                  const roleResult = await syncMemberTournamentRoles(member).catch(() => null);
                  const syncResult = await syncMemberTournamentAccess(member).catch(() => null);
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true, member_found: true, roleResult, syncResult }));
                  return;
                }
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, member_found: false }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }

      // Authenticated Webhook / Reconcile endpoint: POST /api/bot/sync/reconcile
      if (req.method === 'POST' && pathname === '/api/bot/sync/reconcile') {
        const secret = process.env.MATCHDISTRICT_BOT_SECRET;
        const incoming = req.headers['x-bot-secret'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
        if (!secret || incoming !== secret) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'UNAUTHORIZED' }));
          return;
        }

        const officialGuildId = getOfficialGuildId();
        if (officialGuildId && client?.guilds) {
          const guild = client.guilds.cache.get(officialGuildId) || await client.guilds.fetch(officialGuildId).catch(() => null);
          if (guild) {
            const roleResults = await reconcileAllTournamentRoles(guild).catch(() => null);
            const accessResults = await reconcileAllTournamentAccess(guild).catch(() => null);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, roleResults, accessResults }));
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Official guild not found or client not ready' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });
    healthServer.listen(healthPort, '0.0.0.0', () => {
      console.log(`[Discord Bot] 🌐 Server listening on port ${healthPort}`);
    });
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Server error:', err.message);
  }
}

/**
 * Clean and retrieve the Discord Bot Token from environment variables.
 * Never prints or leaks the token to logs or errors.
 */
export function getBotToken() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (typeof token !== 'string') return '';
  return token.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Bot Command Prefix (Default: '.')
 */
export const PREFIX = process.env.DISCORD_PREFIX || '.';

/**
 * Required audit and management channels configured by .setup
 */
export const REQUIRED_CHANNELS = [
  {
    key: 'botPreviewId',
    name: 'bot-preview',
    topic: 'Private MatchDistrict Bot Preview & Management Channel',
  },
  {
    key: 'dmLogId',
    name: 'dm-log',
    topic: 'Private MatchDistrict DM Delivery Logs (Welcome DMs & Bot Outreach)',
  },
  {
    key: 'msgLogId',
    name: 'msg-log',
    topic: 'Private MatchDistrict Message Logs (Edits, Deletions & Member Messages)',
  },
  {
    key: 'banUnbanLogId',
    name: 'ban-unban-log',
    topic: 'Private MatchDistrict Moderation Logs (Member Bans & Unbans)',
  },
];

export const RESERVED_LOG_CHANNEL_NAMES = new Set([
  'bot-preview',
  'dm-log',
  'msg-log',
  'ban-unban-log',
  'matchdistrict-logs',
  'md-welcome-logs',
]);

/**
 * Guild settings persistence for welcome activation and private management channels.
 */
const SETTINGS_FILE = path.resolve(__dirname, 'guildSettings.json');

export function loadGuildSettings() {
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

export function saveGuildSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error saving guild settings:', err.message);
  }
}

export let guildSettingsCache = loadGuildSettings();

export function getGuildSettings(guildId) {
  if (!guildId) return null;
  return guildSettingsCache[guildId] || null;
}

export function isWelcomeEnabled(guildId) {
  if (!guildId) return false;
  return Boolean(guildSettingsCache[guildId]?.welcomeEnabled);
}

export function setWelcomeEnabled(guildId, enabled) {
  if (!guildId) return;
  if (!guildSettingsCache[guildId]) {
    guildSettingsCache[guildId] = {};
  }
  guildSettingsCache[guildId].welcomeEnabled = Boolean(enabled);
  guildSettingsCache[guildId].updatedAt = new Date().toISOString();
  saveGuildSettings(guildSettingsCache);
}

export function getGuildChannels(guildId) {
  if (!guildId) return {};
  const settings = guildSettingsCache[guildId];
  return settings?.channels || {};
}

export function getGuildChannelId(guildId, key) {
  if (!guildId) return null;
  const settings = guildSettingsCache[guildId];
  if (!settings || settings.setupActive === false) return null;
  if (settings.channels && settings.channels[key]) {
    return settings.channels[key];
  }
  // Backwards compatibility for logChannelId
  if (key === 'dmLogId' || key === 'logChannelId') {
    return settings.channels?.dmLogId || settings.logChannelId || null;
  }
  return null;
}

/**
 * Check whether server management channels are actively setup
 */
export function isSetupActive(guildId) {
  if (!guildId) return false;
  const settings = guildSettingsCache[guildId];
  if (!settings) return false;
  if (settings.setupActive === false) return false;
  if (settings.channels && Object.values(settings.channels).some((id) => Boolean(id))) {
    return true;
  }
  return false;
}

/**
 * Deduplication & Pending Confirmation caches
 */
export const recentBans = new Map(); // Key: `${guildId}:${userId}`, Value: { moderatorId, reason, logged: boolean, timestamp }
export const recentJoins = new Map(); // Key: `${guildId}:${userId}`, Value: timestamp
export const pendingSetupRemovals = new Map(); // Key: guildId, Value: { adminId, timestamp, timer }

/**
 * Helper to redact sensitive tokens, passwords, and secrets from logged messages
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  let sanitized = text;

  // Redact current bot token if set
  const currentToken = getBotToken();
  if (currentToken && currentToken.length > 8) {
    sanitized = sanitized.replaceAll(currentToken, '[REDACTED_BOT_TOKEN]');
  }

  // Redact generic Discord bot tokens (3 parts or mfa)
  sanitized = sanitized.replace(/(?:[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}|mfa\.[\w-]{20,})/g, '[REDACTED_TOKEN]');

  // Redact API keys / secrets / password assignments (avoid matching already redacted tokens)
  sanitized = sanitized.replace(/(?:(?:api[_-]?key|secret|password|bearer|auth|token)\s*[:=]\s*)['"]?(?!\[REDACTED_)([^\s'"]{8,})['"]?/gi, (match, secret) => {
    return match.replace(secret, '[REDACTED_SECRET]');
  });

  return sanitized;
}

/**
 * Check if a channel is one of the reserved audit/log channels
 */
export function isAuditOrLogChannel(channel, guildId) {
  if (!channel) return false;
  const channelId = channel.id;

  if (guildId && isSetupActive(guildId)) {
    const configuredChannels = getGuildChannels(guildId);
    if (Object.values(configuredChannels).filter(Boolean).includes(channelId)) {
      return true;
    }
    const legacyLogId = guildSettingsCache[guildId]?.logChannelId;
    if (legacyLogId && legacyLogId === channelId) {
      return true;
    }
  }

  const channelName = channel.name?.toLowerCase();
  if (channelName && RESERVED_LOG_CHANNEL_NAMES.has(channelName)) {
    if (guildId && isSetupActive(guildId)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a member has Administrator or Manage Server permissions
 */
export function isAdmin(member) {
  if (!member) return false;
  return (
    member.permissions?.has(PermissionFlagsBits.Administrator) ||
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    false
  );
}

/**
 * Formats the official MatchDistrict welcome message for a new member.
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

🤖 **Server Bot Commands (Prefix: \`${PREFIX}\`):**
• \`${PREFIX}website\` — Get direct links to the MatchDistrict platform
• \`${PREFIX}ping\` — Check bot latency & status
• \`${PREFIX}help\` — View available commands

Have fun, play fair, and see you in the battleground! 🚀

— **Team MatchDistrict**`;
}

/**
 * Formats the dashboard preview message for #bot-preview
 */
export function buildBotPreviewMessage(guild, welcomeEnabled, channelMap) {
  return (
    `🤖 **MatchDistrict Server Management Dashboard**\n` +
    `• **Server:** ${guild.name} (ID: \`${guild.id}\`)\n` +
    `• **Welcome DMs:** ${welcomeEnabled ? '🟢 **Active / Enabled**' : '🔴 **Disabled**'}\n` +
    `• **Configured Channels:**\n` +
    `  - 📋 **Preview & Control:** ${channelMap.botPreviewId ? `<#${channelMap.botPreviewId}>` : 'Not configured'}\n` +
    `  - 📬 **DM Logs:** ${channelMap.dmLogId ? `<#${channelMap.dmLogId}>` : 'Not configured'}\n` +
    `  - 💬 **Message Logs:** ${channelMap.msgLogId ? `<#${channelMap.msgLogId}>` : 'Not configured'}\n` +
    `  - 🔨 **Ban/Unban Logs:** ${channelMap.banUnbanLogId ? `<#${channelMap.banUnbanLogId}>` : 'Not configured'}\n\n` +
    `**Management Commands (Prefix: \`${PREFIX}\`):**\n` +
    `• \`${PREFIX}setup\` — Run or refresh server channels and permissions\n` +
    `• \`${PREFIX}dm welcome on\` — Turn on welcome DMs for new members\n` +
    `• \`${PREFIX}dm welcome off\` — Turn off welcome DMs\n` +
    `• \`${PREFIX}ban @user [reason]\` — Ban a member with audit trail\n` +
    `• \`${PREFIX}clear <1-100>\` — Bulk delete messages in a channel\n` +
    `• \`${PREFIX}status\` — Check current server configuration\n` +
    `• \`${PREFIX}ping\` — Verify bot latency & gateway health\n` +
    `• \`${PREFIX}help\` — Show complete command guide\n\n` +
    `*Visit MatchDistrict:* https://matchdistrict.in`
  );
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
    `**🛡️ Administrator & Moderation:**\n` +
    `• \`${prefix}setup\` — *(Admin Only)* Create/configure private audit channels & initialize bot\n` +
    `• \`${prefix}setup remove\` — *(Admin Only)* Safely remove and delete management channels (requires confirmation)\n` +
    `• \`${prefix}dm welcome on\` — *(Admin Only)* Enable welcome DMs for new members\n` +
    `• \`${prefix}dm welcome off\` — *(Admin Only)* Disable welcome DMs for new members\n` +
    `• \`${prefix}ban @user [reason]\` — *(Mod Only)* Ban a user with audit logging\n` +
    `• \`${prefix}clear <1-100>\` — *(Mod Only)* Bulk delete recent messages\n\n` +
    `**🏆 Tournament Management (Official Server Only):**\n` +
    `• \`${prefix}list tournament [all]\` — *(Admin Only)* List tournaments & open control panel via selection\n` +
    `• \`${prefix}select tournament <id>\` — *(Admin Only)* Open or refresh control panel in #bot-commands\n` +
    `• \`${prefix}fetch teams [id]\` — *(Admin Only)* Provision tournament channels & sync live registered roster\n\n` +
    `**ℹ️ General Information:**\n` +
    `• \`${prefix}status\` — Check server configuration & welcome status\n` +
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
 * Handles the .setup command:
 * Idempotently creates or configures #bot-preview, #dm-log, #msg-log, #ban-unban-log.
 */
export async function handleSetupCommand(guild, member, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  // 1. Check user permissions
  if (!isAdmin(member)) {
    await replyFn('❌ **Permission Denied:** Only server Administrators or members with `Manage Server` permission can run `.setup`.');
    return;
  }

  // 2. Check bot permissions to manage channels
  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await replyFn('❌ **Bot Permission Missing:** I need the `Manage Channels` permission to create and configure the private management channels. Please grant this permission and try `.setup` again.');
    return;
  }

  const results = {
    created: [],
    reused: [],
    failed: [],
  };

  const channelMap = {};
  const currentSettings = getGuildSettings(guild.id) || {};
  const savedChannels = currentSettings.channels || {};

  // 3. Process each required channel
  for (const req of REQUIRED_CHANNELS) {
    let targetChannel = null;

    // Check if channel ID already saved in guild settings and still exists
    const existingId = savedChannels[req.key];
    if (existingId) {
      targetChannel = guild.channels.cache.get(existingId);
    }

    // If not found by saved ID, check by channel name
    if (!targetChannel) {
      targetChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === req.name
      );
    }

    // Permission overwrites: private to @everyone, full access for bot
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];

    if (targetChannel) {
      try {
        await targetChannel.permissionOverwrites.set(overwrites);
        results.reused.push(targetChannel);
        channelMap[req.key] = targetChannel.id;
      } catch (err) {
        console.warn(`[Discord Bot] ⚠️ Could not update overwrites for #${req.name}:`, err.message);
        results.reused.push(targetChannel);
        channelMap[req.key] = targetChannel.id;
      }
    } else {
      try {
        targetChannel = await guild.channels.create({
          name: req.name,
          type: ChannelType.GuildText,
          topic: req.topic,
          permissionOverwrites: overwrites,
        });
        results.created.push(targetChannel);
        channelMap[req.key] = targetChannel.id;
      } catch (err) {
        console.error(`[Discord Bot] ❌ Failed to create #${req.name}:`, err.message);
        results.failed.push({ name: req.name, error: err.message });
      }
    }
  }

  // 4. Save guild settings
  const welcomeCurrentlyEnabled = currentSettings.welcomeEnabled !== undefined ? currentSettings.welcomeEnabled : true;
  guildSettingsCache[guild.id] = {
    ...currentSettings,
    setupActive: true,
    welcomeEnabled: welcomeCurrentlyEnabled,
    channels: {
      botPreviewId: channelMap.botPreviewId || savedChannels.botPreviewId || null,
      dmLogId: channelMap.dmLogId || savedChannels.dmLogId || null,
      msgLogId: channelMap.msgLogId || savedChannels.msgLogId || null,
      banUnbanLogId: channelMap.banUnbanLogId || savedChannels.banUnbanLogId || null,
    },
    logChannelId: channelMap.dmLogId || savedChannels.dmLogId || null, // legacy
    setupBy: member.id,
    setupAt: new Date().toISOString(),
  };
  saveGuildSettings(guildSettingsCache);

  // 5. Send or refresh management card in #bot-preview
  const previewChannelId = channelMap.botPreviewId || savedChannels.botPreviewId;
  const previewChannel = previewChannelId ? guild.channels.cache.get(previewChannelId) : null;
  if (previewChannel) {
    try {
      await previewChannel.send(buildBotPreviewMessage(guild, welcomeCurrentlyEnabled, channelMap));
    } catch (err) {
      console.warn('[Discord Bot] ⚠️ Could not post dashboard into #bot-preview:', err.message);
    }
  }

  // 6. Build summary response
  let summary = '';
  if (results.failed.length === 0) {
    summary += `✅ **MatchDistrict Server Setup Complete!**\n\n`;
  } else {
    summary += `⚠️ **MatchDistrict Server Setup Completed with Errors**\n\n`;
  }

  if (results.created.length > 0) {
    summary += `✨ **Created Channels:**\n` + results.created.map((c) => `• <#${c.id}> (\`#${c.name}\`)`).join('\n') + '\n\n';
  }
  if (results.reused.length > 0) {
    summary += `♻️ **Reused Channels:**\n` + results.reused.map((c) => `• <#${c.id}> (\`#${c.name}\`)`).join('\n') + '\n\n';
  }
  if (results.failed.length > 0) {
    summary += `❌ **Failed Operations:**\n` + results.failed.map((f) => `• \`#${f.name}\`: ${f.error}`).join('\n') + '\n\n';
  }

  summary += `• **Welcome DMs:** ${welcomeCurrentlyEnabled ? '🟢 **Enabled**' : '🔴 **Disabled**'}\n`;
  summary += `• **Management Dashboard:** ${previewChannelId ? `<#${previewChannelId}>` : 'Not configured'}\n\n`;
  summary += `Use \`${PREFIX}dm welcome on\` or \`${PREFIX}dm welcome off\` to control welcome DMs.\nUse \`${PREFIX}help\` to view all commands.`;

  await replyFn(summary);
}

/**
 * Handles .setup remove: Initiates confirmation prompt for administrator to delete management channels
 */
export async function handleSetupRemoveCommand(guild, member, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  // 1. Authorization check
  if (!isAdmin(member)) {
    await replyFn('❌ **Permission Denied:** Only server Administrators or members with `Manage Server` permission can remove the setup.');
    return;
  }

  // 2. Idempotency check: if setup is already removed or no channels are configured
  if (!isSetupActive(guild.id)) {
    await replyFn(`ℹ️ **Setup Already Removed:** There are no active management channels configured for this server. Run \`${PREFIX}setup\` to set them up.`);
    return;
  }

  // 3. Bot permissions check
  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await replyFn('❌ **Bot Permission Missing:** I need the `Manage Channels` permission to remove the configured management channels.');
    return;
  }

  // 4. List channels to be deleted
  const savedChannels = getGuildChannels(guild.id);
  const channelsList = REQUIRED_CHANNELS
    .map((r) => {
      const id = savedChannels[r.key];
      return id ? `• <#${id}> (\`#${r.name}\`)` : `• \`#${r.name}\` *(unlinked)*`;
    })
    .join('\n');

  // 5. Store pending removal state with 30s timeout
  if (pendingSetupRemovals.has(guild.id)) {
    const existing = pendingSetupRemovals.get(guild.id);
    if (existing?.timer) clearTimeout(existing.timer);
  }

  const promptText = (
    `⚠️ **Confirmation Required: Remove Management Channels**\n\n` +
    `You are about to permanently delete the following channels configured by \`${PREFIX}setup\`:\n` +
    `${channelsList}\n\n` +
    `**⚠️ WARNING:** All channel messages, logs, and audit records within these channels will be permanently deleted.\n` +
    `• To proceed, administrator <@${member.id}> must type **\`${PREFIX}setup confirm\`** within **30 seconds**.\n` +
    `• To cancel, type **\`${PREFIX}setup cancel\`** or wait 30 seconds.`
  );

  const timer = setTimeout(() => {
    if (pendingSetupRemovals.has(guild.id)) {
      pendingSetupRemovals.delete(guild.id);
      replyFn(`⏱️ **Setup Removal Cancelled:** Confirmation was not received within 30 seconds. No channels were deleted.`);
    }
  }, 30000);
  if (timer.unref) timer.unref();

  pendingSetupRemovals.set(guild.id, {
    adminId: member.id,
    timestamp: Date.now(),
    timer,
  });

  // Build optional buttons
  let components = [];
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('md_confirm_setup_remove')
        .setLabel('Confirm Channel Deletion')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('md_cancel_setup_remove')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );
    components = [row];
  } catch {
    // Buttons unsupported in current context
  }

  let sent = null;
  try {
    if (components.length > 0) {
      sent = await replyFn({ content: promptText, components });
    } else {
      sent = await replyFn(promptText);
    }
  } catch {
    sent = await replyFn(promptText);
  }

  // If interactive collector available
  if (sent?.createMessageComponentCollector) {
    const collector = sent.createMessageComponentCollector({ time: 30000 });
    collector.on('collect', async (interaction) => {
      if (interaction.user.id !== member.id) {
        await interaction.reply({
          content: `❌ **Unauthorized:** Only the administrator who initiated the removal request (<@${member.id}>) can confirm it.`,
          ephemeral: true,
        });
        return;
      }

      if (!isAdmin(interaction.member)) {
        await interaction.reply({
          content: '❌ **Permission Denied:** Only administrators can confirm channel deletion.',
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId === 'md_confirm_setup_remove') {
        collector.stop('confirmed');
        await interaction.deferUpdate().catch(() => {});
        await handleSetupConfirmCommand(guild, interaction.member, (text) => interaction.followUp(text));
      } else if (interaction.customId === 'md_cancel_setup_remove') {
        collector.stop('cancelled');
        await interaction.deferUpdate().catch(() => {});
        await handleSetupCancelCommand(guild, interaction.member, (text) => interaction.followUp(text));
      }
    });

    collector.on('end', (collected, reason) => {
      if (reason !== 'confirmed' && reason !== 'cancelled') {
        if (pendingSetupRemovals.has(guild.id)) {
          pendingSetupRemovals.delete(guild.id);
          sent.edit?.({
            content: `⏱️ **Setup Removal Cancelled:** Confirmation was not received within 30 seconds. No channels were deleted.`,
            components: [],
          })?.catch(() => {});
        }
      }
    });
  }
}

/**
 * Handles confirmation of setup removal
 */
export async function handleSetupConfirmCommand(guild, member, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  // 1. Revalidate administrator permissions
  if (!isAdmin(member)) {
    await replyFn('❌ **Permission Denied:** Only administrators can confirm channel deletion.');
    return;
  }

  // 2. Verify pending confirmation
  const pending = pendingSetupRemovals.get(guild.id);
  if (!pending) {
    await replyFn(`ℹ️ **No Pending Request:** There is no pending setup removal to confirm. Run \`${PREFIX}setup remove\` first.`);
    return;
  }

  // 3. Prevent unauthorized users from confirming another administrator's request
  if (member.id !== pending.adminId) {
    await replyFn(`❌ **Unauthorized:** Only the administrator who requested removal (<@${pending.adminId}>) can confirm this operation.`);
    return;
  }

  // 4. Verify timeout
  if (Date.now() - pending.timestamp > 30000) {
    pendingSetupRemovals.delete(guild.id);
    await replyFn(`⏱️ **Confirmation Expired:** The 30-second window has expired. Please run \`${PREFIX}setup remove\` again.`);
    return;
  }

  // Clear timer and pending state
  if (pending.timer) clearTimeout(pending.timer);
  pendingSetupRemovals.delete(guild.id);

  // 5. Check bot permissions
  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await replyFn('❌ **Bot Permission Missing:** I need the `Manage Channels` permission to delete the management channels.');
    return;
  }

  // 6. Delete only channels managed by this bot's setup
  const deleted = [];
  const skipped = [];
  const failed = [];

  const currentSettings = getGuildSettings(guild.id) || {};
  const savedChannels = currentSettings.channels || {};

  for (const req of REQUIRED_CHANNELS) {
    const channelId = savedChannels[req.key];
    if (!channelId) {
      continue;
    }

    // Only lookup by stored ID - never by channel name
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      skipped.push({ name: req.name, reason: 'Already deleted or not found' });
      continue;
    }

    // Strict validation: channel belongs to current guild and matches stored ID
    const chGuildId = channel.guildId || channel.guild?.id;
    if (chGuildId !== guild.id || channel.id !== channelId) {
      failed.push({ name: req.name, error: 'Channel does not belong to this server configuration' });
      continue;
    }

    try {
      await channel.delete(`MatchDistrict .setup remove confirmed by ${member.user?.tag || member.id} (${member.id})`);
      deleted.push({ id: channelId, name: channel.name });
    } catch (err) {
      failed.push({ name: req.name, error: err.message });
    }
  }

  // 7. Clear stored channel IDs and mark setup as inactive
  guildSettingsCache[guild.id] = {
    ...currentSettings,
    setupActive: false,
    channels: {
      botPreviewId: null,
      dmLogId: null,
      msgLogId: null,
      banUnbanLogId: null,
    },
    logChannelId: null,
    removedBy: member.id,
    removedAt: new Date().toISOString(),
  };
  saveGuildSettings(guildSettingsCache);

  // 8. Build clear response summary
  let summary = '🗑️ **MatchDistrict Setup Removal Complete**\n\n';
  if (deleted.length > 0) {
    summary += `✨ **Deleted Channels:**\n` + deleted.map((c) => `• \`#${c.name}\` (\`${c.id}\`)`).join('\n') + '\n\n';
  }
  if (skipped.length > 0) {
    summary += `⏭️ **Skipped:**\n` + skipped.map((s) => `• \`#${s.name}\`: ${s.reason}`).join('\n') + '\n\n';
  }
  if (failed.length > 0) {
    summary += `❌ **Failed to Delete:**\n` + failed.map((f) => `• \`#${f.name}\`: ${f.error}`).join('\n') + '\n\n';
  }

  summary += `• **Setup Status:** 🔴 **Inactive** (Management & audit logging channels unlinked)\n`;
  summary += `• **Welcome DM Configuration:** Preserved (${isWelcomeEnabled(guild.id) ? '🟢 **Enabled**' : '🔴 **Disabled**'})\n\n`;
  summary += `Run \`${PREFIX}setup\` at any time to re-initialize server channels.`;

  await replyFn(summary);
}

/**
 * Handles .setup cancel
 */
export async function handleSetupCancelCommand(guild, member, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  if (!isAdmin(member)) {
    await replyFn('❌ **Permission Denied:** Only administrators can cancel this operation.');
    return;
  }

  const pending = pendingSetupRemovals.get(guild.id);
  if (!pending) {
    await replyFn('ℹ️ **No Pending Request:** There is no pending setup removal to cancel.');
    return;
  }

  if (member.id !== pending.adminId) {
    await replyFn(`❌ **Unauthorized:** Only <@${pending.adminId}> can cancel their pending removal request.`);
    return;
  }

  if (pending.timer) clearTimeout(pending.timer);
  pendingSetupRemovals.delete(guild.id);

  await replyFn('🛑 **Setup Removal Cancelled:** The pending removal operation was cancelled. No channels were deleted.');
}

/**
 * Handles .dm welcome on/off command
 */
export async function handleDmCommand(guild, member, args, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  if (!isAdmin(member)) {
    await replyFn('❌ **Permission Denied:** Only server Administrators or members with `Manage Server` permission can configure welcome DMs.');
    return;
  }

  const subCommand = (args[0] || '').toLowerCase();
  const option = (args[1] || '').toLowerCase();

  if (subCommand !== 'welcome' || (option !== 'on' && option !== 'off')) {
    const current = isWelcomeEnabled(guild.id);
    await replyFn(
      `ℹ️ **Usage:** \`${PREFIX}dm welcome on\` or \`${PREFIX}dm welcome off\`\n` +
      `• **Current Status:** Welcome DMs are ${current ? '🟢 **Enabled**' : '🔴 **Disabled**'}.`
    );
    return;
  }

  const enable = option === 'on';
  setWelcomeEnabled(guild.id, enable);

  // Notify invoking channel
  if (enable) {
    await replyFn('✅ **Welcome DMs Enabled:** The bot will now send a direct message welcoming new members when they join.');
  } else {
    await replyFn('🛑 **Welcome DMs Disabled:** The bot will not send welcome direct messages to new members.');
  }

  // Update or post notice in #bot-preview
  const previewChannelId = getGuildChannelId(guild.id, 'botPreviewId');
  const previewChannel = previewChannelId ? guild.channels.cache.get(previewChannelId) : null;
  if (previewChannel) {
    try {
      await previewChannel.send(
        `🔔 **Configuration Update:** Welcome DMs toggled **${enable ? 'ON 🟢' : 'OFF 🔴'}** by <@${member.id}> at <t:${Math.floor(Date.now() / 1000)}:T>.`
      );
    } catch (err) {
      console.warn('[Discord Bot] ⚠️ Could not notify #bot-preview:', err.message);
    }
  }
}

/**
 * Handles .ban @user [reason] command
 */
export async function handleBanCommand(guild, member, args, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }

  // 1. Check moderator permissions
  const canBan = member?.permissions?.has(PermissionFlagsBits.BanMembers) ||
                 member?.permissions?.has(PermissionFlagsBits.Administrator);
  if (!canBan) {
    await replyFn('❌ **Permission Denied:** You need the `Ban Members` permission to use this command.');
    return;
  }

  // 2. Check bot permissions
  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.BanMembers)) {
    await replyFn('❌ **Bot Permission Missing:** I need the `Ban Members` permission to ban users. Please grant this permission to my role.');
    return;
  }

  // 3. Parse target user
  const targetArg = args[0];
  if (!targetArg) {
    await replyFn(`❌ **Invalid Usage:** Please specify a user to ban.\nExample: \`${PREFIX}ban @user Breaking server rules\` or \`${PREFIX}ban 123456789012345678 Spammer\``);
    return;
  }

  const mentionMatch = targetArg.match(/^<@!?([a-zA-Z0-9_.-]{3,32})>$/);
  const targetId = mentionMatch ? mentionMatch[1] : (targetArg.match(/^[a-zA-Z0-9_.-]{3,32}$/) ? targetArg : null);

  if (!targetId) {
    await replyFn(`❌ **Invalid Target:** "${targetArg}" is not a valid user mention or Discord user ID.`);
    return;
  }

  const reason = args.slice(1).join(' ').trim() || 'No reason provided (Banned by moderator)';

  // 4. Protection checks
  if (targetId === member.id) {
    await replyFn('❌ **Action Prohibited:** You cannot ban yourself.');
    return;
  }

  if (targetId === guild.client.user.id) {
    await replyFn('❌ **Action Prohibited:** I cannot ban myself.');
    return;
  }

  if (targetId === guild.ownerId) {
    await replyFn('❌ **Action Prohibited:** Cannot ban the server owner.');
    return;
  }

  let targetUser = null;
  try {
    targetUser = await guild.client.users.fetch(targetId);
  } catch {
    await replyFn(`❌ **User Not Found:** Could not locate a Discord user with ID \`${targetId}\`.`);
    return;
  }

  // Hierarchy check if user is a member of the guild
  let targetMember = null;
  try {
    targetMember = await guild.members.fetch(targetId);
  } catch {
    // Member might not be in guild; Discord allows banning by user ID (hackban)
  }

  if (targetMember) {
    // Check moderator hierarchy
    if (member.id !== guild.ownerId && targetMember.roles.highest.position >= member.roles.highest.position) {
      await replyFn('❌ **Role Hierarchy Restriction:** You cannot ban this member because their highest role is equal to or higher than yours.');
      return;
    }

    // Check bot hierarchy
    if (!targetMember.bannable) {
      await replyFn('❌ **Bot Hierarchy Restriction:** I cannot ban this member because their highest role is equal to or higher than my highest role.');
      return;
    }
  }

  // 5. Register in recentBans to prevent duplicate logs from GuildBanAdd
  const banKey = `${guild.id}:${targetId}`;
  recentBans.set(banKey, {
    moderatorId: member.id,
    moderatorTag: member.user?.tag || member.id,
    reason,
    logged: false,
    timestamp: Date.now(),
  });

  // 6. Execute ban
  try {
    await guild.bans.create(targetId, {
      reason: `${reason} | By ${member.user?.tag || member.id} (${member.id})`,
    });
  } catch (err) {
    recentBans.delete(banKey);
    console.error('[Discord Bot] ❌ Ban creation failed:', err.message);
    await replyFn(`❌ **Ban Failed:** Could not ban user: ${err.message}`);
    return;
  }

  // 7. Log to #ban-unban-log
  const banLogId = getGuildChannelId(guild.id, 'banUnbanLogId');
  let banLogChannel = banLogId ? guild.channels.cache.get(banLogId) : null;
  if (!banLogChannel) {
    banLogChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === 'ban-unban-log'
    );
  }

  if (banLogChannel && banLogChannel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
    const nowTs = Math.floor(Date.now() / 1000);
    try {
      await banLogChannel.send(
        `🔨 **Member Banned**\n` +
        `• **Target User:** <@${targetUser.id}> (\`${targetUser.tag || targetUser.username}\` | ID: \`${targetUser.id}\`)\n` +
        `• **Moderator:** <@${member.id}> (\`${member.user?.tag || member.id}\`)\n` +
        `• **Reason:** ${reason}\n` +
        `• **Initiated Via:** Bot Command (\`${PREFIX}ban\`)\n` +
        `• **Timestamp:** <t:${nowTs}:F>`
      );
    } catch (logErr) {
      console.warn('[Discord Bot] ⚠️ Could not write to #ban-unban-log:', logErr.message);
    }
  }

  // Mark recentBan as already logged so GuildBanAdd won't duplicate
  const cachedBan = recentBans.get(banKey);
  if (cachedBan) {
    cachedBan.logged = true;
  }
  // Auto-expire cache entry after 30 seconds
  const banTimer = setTimeout(() => recentBans.delete(banKey), 30000);
  if (banTimer.unref) banTimer.unref();

  // 8. Reply in command channel
  await replyFn(
    `✅ Successfully banned **${targetUser.tag || targetUser.username}** (\`${targetId}\`).\n• **Reason:** ${reason}`
  );
}

/**
 * Handles .clear <1-100> command
 */
export async function handleClearCommand(guild, member, channel, args, replyFn) {
  if (!guild || !channel) {
    await replyFn('❌ **Error:** This command must be executed within a server text channel.');
    return;
  }

  // 1. Check moderator permissions
  const canClear = member?.permissions?.has(PermissionFlagsBits.ManageMessages) ||
                   member?.permissions?.has(PermissionFlagsBits.Administrator);
  if (!canClear) {
    await replyFn('❌ **Permission Denied:** You need the `Manage Messages` permission to clear messages.');
    return;
  }

  // 2. Prevent executing inside private audit / log channels
  if (isAuditOrLogChannel(channel, guild.id)) {
    await replyFn('❌ **Safety Restriction:** The `.clear` command cannot be executed inside private audit or logging channels.');
    return;
  }

  // 3. Check bot permissions in this channel
  const botMember = guild.members.me;
  if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
    await replyFn('❌ **Bot Permission Missing:** I need the `Manage Messages` permission in this channel to delete messages.');
    return;
  }

  // 4. Validate amount
  const rawAmount = args[0];
  const amount = parseInt(rawAmount, 10);
  if (isNaN(amount) || amount < 1 || amount > 100) {
    await replyFn(`❌ **Invalid Argument:** Please specify a number between 1 and 100.\nExample: \`${PREFIX}clear 25\``);
    return;
  }

  // 5. Bulk delete messages with 14-day filter
  try {
    const deleted = await channel.bulkDelete(amount, true);
    const count = deleted?.size ?? 0;

    let responseText = '';
    if (count === 0) {
      responseText = '⚠️ No messages were deleted. Messages older than 14 days cannot be bulk-deleted due to Discord limitations.';
    } else {
      responseText = `🧹 Deleted **${count}** message(s).`;
    }

    const confirmMsg = await channel.send(responseText);
    // Auto-clean confirmation after 5 seconds to keep chat tidy
    const clearTimer = setTimeout(() => {
      confirmMsg.delete().catch(() => {});
    }, 5000);
    if (clearTimer.unref) clearTimer.unref();
  } catch (err) {
    console.error('[Discord Bot] ❌ Bulk delete failed:', err.message);
    await replyFn(`❌ **Clear Failed:** Could not delete messages: ${err.message}`);
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
  const active = isSetupActive(guild.id);
  const channels = getGuildChannels(guild.id);
  const isOfficial = isOfficialGuild(guild);

  if (active) {
    await replyFn(
      `📊 **MatchDistrict Server Status**\n` +
      `• **Official MatchDistrict Server:** ${isOfficial ? '🟢 **Yes (Official Guild)**' : '⚪ **No (External / Community Guild)**'}\n` +
      `• **Setup Status:** 🟢 **Active**\n` +
      `• **Welcome DMs:** ${enabled ? '🟢 **Active / Enabled**' : '🔴 **Disabled**'}\n` +
      `• **Configured Channels:**\n` +
      `  - 📋 Preview: ${channels.botPreviewId ? `<#${channels.botPreviewId}>` : 'Not configured'}\n` +
      `  - 📬 DM Logs: ${channels.dmLogId ? `<#${channels.dmLogId}>` : 'Not configured'}\n` +
      `  - 💬 Message Logs: ${channels.msgLogId ? `<#${channels.msgLogId}>` : 'Not configured'}\n` +
      `  - 🔨 Moderation Logs: ${channels.banUnbanLogId ? `<#${channels.banUnbanLogId}>` : 'Not configured'}\n\n` +
      `• **Website:** https://matchdistrict.in`
    );
  } else {
    await replyFn(
      `📊 **MatchDistrict Server Status**\n` +
      `• **Official MatchDistrict Server:** ${isOfficial ? '🟢 **Yes (Official Guild)**' : '⚪ **No (External / Community Guild)**'}\n` +
      `• **Setup Status:** 🔴 **Inactive / Removed**\n` +
      `• **Welcome DMs:** ${enabled ? '🟢 **Active / Enabled**' : '🔴 **Disabled**'}\n` +
      `• **Configured Channels:** None (Run \`${PREFIX}setup\` to configure management channels)\n\n` +
      `• **Website:** https://matchdistrict.in`
    );
  }
}

/**
 * Handles message creation logging for regular server members
 */
export async function handleMessageCreateLog(message) {
  try {
    if (!message || !message.guild || !isSetupActive(message.guild.id)) return;
    if (message.author?.bot) return;

    // Exclude authorized administrators
    if (message.member && isAdmin(message.member)) return;

    // Never log messages from private audit channels
    if (isAuditOrLogChannel(message.channel, message.guild.id)) return;

    // Locate msg-log channel
    const msgLogId = getGuildChannelId(message.guild.id, 'msgLogId');
    let logChannel = msgLogId ? message.guild.channels.cache.get(msgLogId) : null;
    if (!logChannel) {
      logChannel = message.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'msg-log'
      );
    }

    if (!logChannel || !logChannel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      return;
    }

    const content = redactSecrets(message.content || '');
    const nowTs = Math.floor(message.createdTimestamp / 1000);
    const authorTag = message.author.tag || message.author.username;

    let attachmentInfo = '';
    if (message.attachments?.size > 0) {
      attachmentInfo = `\n• **Attachments:** ${message.attachments.map((a) => `[${a.name || 'file'}](${a.url})`).join(', ')}`;
    }

    let embedInfo = '';
    if (message.embeds?.length > 0) {
      embedInfo = `\n• **Embeds:** ${message.embeds.length} embed(s) attached`;
    }

    const displayContent = content ? `\n• **Content:** ${content}` : '\n• **Content:** *[Empty or non-text message]*';

    await logChannel.send(
      `💬 **Message Sent**\n` +
      `• **Author:** <@${message.author.id}> (\`${authorTag}\` | ID: \`${message.author.id}\`)\n` +
      `• **Channel:** <#${message.channel.id}>\n` +
      `• **Message ID:** \`${message.id}\`\n` +
      `• **Timestamp:** <t:${nowTs}:F>${displayContent}${attachmentInfo}${embedInfo}`
    );
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Message create logging error:', err.message);
  }
}

/**
 * Handles message update (edit) logging for regular server members
 */
export async function handleMessageUpdateLog(oldMessage, newMessage) {
  try {
    if (!newMessage || !newMessage.guild || !isSetupActive(newMessage.guild.id)) return;
    if (newMessage.author?.bot) return;

    if (newMessage.member && isAdmin(newMessage.member)) return;
    if (isAuditOrLogChannel(newMessage.channel, newMessage.guild.id)) return;

    // If content did not change (e.g. embed preview generated), skip
    if (oldMessage.content === newMessage.content) return;

    const msgLogId = getGuildChannelId(newMessage.guild.id, 'msgLogId');
    let logChannel = msgLogId ? newMessage.guild.channels.cache.get(msgLogId) : null;
    if (!logChannel) {
      logChannel = newMessage.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'msg-log'
      );
    }

    if (!logChannel || !logChannel.permissionsFor(newMessage.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      return;
    }

    const oldContent = redactSecrets(oldMessage.content || '[Content unavailable or uncached]');
    const newContent = redactSecrets(newMessage.content || '[Empty message]');
    const nowTs = Math.floor(Date.now() / 1000);
    const authorTag = newMessage.author?.tag || newMessage.author?.username || 'Unknown';

    await logChannel.send(
      `✏️ **Message Edited**\n` +
      `• **Author:** <@${newMessage.author?.id}> (\`${authorTag}\` | ID: \`${newMessage.author?.id}\`)\n` +
      `• **Channel:** <#${newMessage.channel.id}>\n` +
      `• **Message ID:** \`${newMessage.id}\`\n` +
      `• **Before:** ${oldContent}\n` +
      `• **After:** ${newContent}\n` +
      `• **Edited At:** <t:${nowTs}:F>`
    );
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Message edit logging error:', err.message);
  }
}

/**
 * Handles message deletion logging
 */
export async function handleMessageDeleteLog(message) {
  try {
    if (!message || !message.guild || !isSetupActive(message.guild.id)) return;
    if (message.author?.bot) return;
    if (message.member && isAdmin(message.member)) return;
    if (isAuditOrLogChannel(message.channel, message.guild.id)) return;

    const msgLogId = getGuildChannelId(message.guild.id, 'msgLogId');
    let logChannel = msgLogId ? message.guild.channels.cache.get(msgLogId) : null;
    if (!logChannel) {
      logChannel = message.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'msg-log'
      );
    }

    if (!logChannel || !logChannel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      return;
    }

    const content = message.content ? redactSecrets(message.content) : '[Content unavailable or uncached]';
    const nowTs = Math.floor(Date.now() / 1000);
    const authorDisplay = message.author
      ? `<@${message.author.id}> (\`${message.author.tag || message.author.username}\` | ID: \`${message.author.id}\`)`
      : 'Unknown User (Uncached)';

    await logChannel.send(
      `🗑️ **Message Deleted**\n` +
      `• **Author:** ${authorDisplay}\n` +
      `• **Channel:** <#${message.channel.id}>\n` +
      `• **Message ID:** \`${message.id}\`\n` +
      `• **Content:** ${content}\n` +
      `• **Deleted At:** <t:${nowTs}:F>`
    );
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Message delete logging error:', err.message);
  }
}

/**
 * Handles Discord native and external Ban events (GuildBanAdd)
 */
export async function handleGuildBanAdd(ban) {
  try {
    if (!ban || !ban.guild) return;
    const guild = ban.guild;
    const user = ban.user;
    const banKey = `${guild.id}:${user.id}`;

    // Deduplication check: if logged by .ban command, skip
    const cached = recentBans.get(banKey);
    if (cached?.logged) {
      recentBans.delete(banKey);
      return;
    }

    if (!isSetupActive(guild.id)) {
      recentBans.delete(banKey);
      return;
    }

    const banLogId = getGuildChannelId(guild.id, 'banUnbanLogId');
    let logChannel = banLogId ? guild.channels.cache.get(banLogId) : null;
    if (!logChannel) {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'ban-unban-log'
      );
    }

    if (!logChannel || !logChannel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      return;
    }

    let moderator = null;
    let reason = cached?.reason || ban.reason || null;

    // Fetch responsible moderator from audit log if possible
    try {
      if (guild.members.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.MemberBanAdd,
          limit: 3,
        });
        const match = auditLogs.entries.find(
          (e) => e.target?.id === user.id && Date.now() - e.createdTimestamp < 30000
        );
        if (match) {
          moderator = match.executor;
          if (!reason && match.reason) {
            reason = match.reason;
          }
        }
      }
    } catch (auditErr) {
      console.warn('[Discord Bot] ⚠️ Could not query audit logs for ban:', auditErr.message);
    }

    const modDisplay = moderator
      ? `<@${moderator.id}> (\`${moderator.tag || moderator.username}\` | ID: \`${moderator.id}\`)`
      : (cached?.moderatorId ? `<@${cached.moderatorId}> (\`${cached.moderatorTag}\`)` : 'Unavailable (Audit Log permission required or entry missing)');

    const nowTs = Math.floor(Date.now() / 1000);

    await logChannel.send(
      `🔨 **Member Banned**\n` +
      `• **Target User:** <@${user.id}> (\`${user.tag || user.username}\` | ID: \`${user.id}\`)\n` +
      `• **Moderator:** ${modDisplay}\n` +
      `• **Reason:** ${reason || 'No reason provided'}\n` +
      `• **Initiated Via:** ${cached ? 'Bot Command' : 'Discord Native / External'}\n` +
      `• **Timestamp:** <t:${nowTs}:F>`
    );

    recentBans.delete(banKey);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in GuildBanAdd handler:', err.message);
  }
}

/**
 * Handles Discord native and external Unban events (GuildBanRemove)
 */
export async function handleGuildBanRemove(ban) {
  try {
    if (!ban || !ban.guild || !isSetupActive(ban.guild.id)) return;
    const guild = ban.guild;
    const user = ban.user;

    const banLogId = getGuildChannelId(guild.id, 'banUnbanLogId');
    let logChannel = banLogId ? guild.channels.cache.get(banLogId) : null;
    if (!logChannel) {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'ban-unban-log'
      );
    }

    if (!logChannel || !logChannel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      return;
    }

    let moderator = null;
    let reason = null;

    try {
      if (guild.members.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.MemberBanRemove,
          limit: 3,
        });
        const match = auditLogs.entries.find(
          (e) => e.target?.id === user.id && Date.now() - e.createdTimestamp < 30000
        );
        if (match) {
          moderator = match.executor;
          reason = match.reason;
        }
      }
    } catch (auditErr) {
      console.warn('[Discord Bot] ⚠️ Could not query audit logs for unban:', auditErr.message);
    }

    const modDisplay = moderator
      ? `<@${moderator.id}> (\`${moderator.tag || moderator.username}\` | ID: \`${moderator.id}\`)`
      : 'Unavailable (Audit Log permission required or entry missing)';

    const nowTs = Math.floor(Date.now() / 1000);

    await logChannel.send(
      `🔓 **Member Unbanned**\n` +
      `• **Target User:** <@${user.id}> (\`${user.tag || user.username}\` | ID: \`${user.id}\`)\n` +
      `• **Moderator:** ${modDisplay}\n` +
      `• **Reason:** ${reason || 'No reason provided'}\n` +
      `• **Timestamp:** <t:${nowTs}:F>`
    );
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in GuildBanRemove handler:', err.message);
  }
}

/**
 * Handles member join event: sends welcome DM and logs attempt to #dm-log
 */
export async function handleGuildMemberAdd(member) {
  try {
    if (!member || member.user?.bot) return;

    const guildId = member.guild?.id;
    const guildName = member.guild?.name || 'MatchDistrict';
    const username = member.user?.globalName || member.user?.username || member.displayName || 'Gamer';
    const userTag = member.user?.tag || member.user?.username || member.id;

    // Check if welcome DMs are enabled
    if (!isWelcomeEnabled(guildId)) {
      console.log(`[Discord Bot] ℹ️ Member ${userTag} joined "${guildName}", but welcome DMs are disabled.`);
      return;
    }

    // Deduplication check: avoid duplicate welcome DMs for rapid join re-triggers
    const joinKey = `${guildId}:${member.id}`;
    if (recentJoins.has(joinKey)) {
      return;
    }
    recentJoins.set(joinKey, Date.now());
    const joinTimer = setTimeout(() => recentJoins.delete(joinKey), 60000);
    if (joinTimer.unref) joinTimer.unref();

    console.log(`[Discord Bot] 👤 New member joined "${guildName}": ${userTag} (${member.id})`);

    const welcomeMessage = buildWelcomeMessage(username, guildName);

    // Locate dm-log channel
    const dmLogId = getGuildChannelId(guildId, 'dmLogId');
    let logChannel = dmLogId ? member.guild.channels.cache.get(dmLogId) : null;
    if (!logChannel) {
      logChannel = member.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && (c.name === 'dm-log' || c.name === 'matchdistrict-logs')
      );
    }

    // Attempt to deliver welcome DM
    let dmDelivered = false;
    let failReason = null;
    try {
      await member.send(welcomeMessage);
      dmDelivered = true;
      console.log(`[Discord Bot] ✅ Successfully delivered welcome DM to ${userTag} (${member.id})`);
    } catch (dmError) {
      if (dmError?.code === 50007) {
        failReason = 'User has Direct Messages disabled in privacy settings or blocked the bot';
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag}: DMs disabled.`);
      } else {
        failReason = dmError.message || 'Unknown delivery failure';
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag}: ${dmError.message}`);
      }
    }

    // Log to #dm-log if setup channels are active
    if (isSetupActive(guildId) && logChannel && logChannel.permissionsFor(member.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      const accountAge = Math.floor(member.user.createdTimestamp / 1000);
      const nowTs = Math.floor(Date.now() / 1000);

      if (dmDelivered) {
        await logChannel.send(
          `📬 **Welcome DM Delivered**\n` +
          `• **Recipient:** <@${member.id}> (\`${userTag}\` | ID: \`${member.id}\`)\n` +
          `• **Event:** Member Join Welcome DM\n` +
          `• **Status:** ✅ **Delivered via Direct Message**\n` +
          `• **Account Created:** <t:${accountAge}:R>\n` +
          `• **Timestamp:** <t:${nowTs}:F>`
        );
      } else {
        await logChannel.send(
          `⚠️ **Welcome DM Delivery Failed**\n` +
          `• **Recipient:** <@${member.id}> (\`${userTag}\` | ID: \`${member.id}\`)\n` +
          `• **Event:** Member Join Welcome DM\n` +
          `• **Status:** ❌ **Failed (${failReason})**\n` +
          `• **Notice:** User does not accept direct messages from server members.\n` +
          `• **Account Created:** <t:${accountAge}:R>\n` +
          `• **Timestamp:** <t:${nowTs}:F>`
        );
      }
    }
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in GuildMemberAdd handler:', err.message);
  }
}

/**
 * Initialize Discord Client with required intents and partials.
 * Includes GuildModeration for ban/unban events, GuildMessages, MessageContent, GuildMembers, DirectMessages.
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Privileged Server Members Intent
    GatewayIntentBits.GuildMessages, // Message receive intent
    GatewayIntentBits.MessageContent, // Privileged Message Content Intent (for prefix commands & message logs)
    GatewayIntentBits.GuildModeration, // Ban & Unban audit tracking (intent 4)
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.GuildMember, Partials.User, Partials.Channel, Partials.Message],
});

// Bot ready event listener
client.once(Events.ClientReady, (readyClient) => {
  console.log(`[Discord Bot] 🚀 Logged in as ${readyClient.user.tag} (ID: ${readyClient.user.id})`);
  console.log(`[Discord Bot] 🎮 MatchDistrict Bot is active across ${readyClient.guilds.cache.size} server(s).`);
  console.log(`[Discord Bot] ⚡ Command prefix: "${PREFIX}"`);
});

// Handle prefix commands and message create logging
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message || message.author?.bot) return;

    const content = message.content?.trim();

    // Check if this is a prefix command
    if (content && content.startsWith(PREFIX)) {
      const withoutPrefix = content.slice(PREFIX.length).trim();
      if (!withoutPrefix) return;

      const args = withoutPrefix.split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();

      if (cmd === 'setup') {
        const subCmd = (args[0] || '').toLowerCase();
        if (subCmd === 'remove') {
          await handleSetupRemoveCommand(message.guild, message.member, (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }));
          return;
        } else if (subCmd === 'confirm') {
          await handleSetupConfirmCommand(message.guild, message.member, (text) => message.reply(text));
          return;
        } else if (subCmd === 'cancel') {
          await handleSetupCancelCommand(message.guild, message.member, (text) => message.reply(text));
          return;
        }
        await handleSetupCommand(message.guild, message.member, (text) => message.reply(text));
        return;
      } else if (cmd === 'dm') {
        await handleDmCommand(message.guild, message.member, args, (text) => message.reply(text));
        return;
      } else if (cmd === 'ban') {
        await handleBanCommand(message.guild, message.member, args, (text) => message.reply(text));
        return;
      } else if (cmd === 'clear') {
        // Delete command message invocation where practical
        await message.delete().catch(() => {});
        await handleClearCommand(message.guild, message.member, message.channel, args, (text) => message.channel.send(text));
        return;
      } else if (cmd === 'list') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'tournament' || sub === 'tournaments') {
          await handleListTournamentCommand(message.guild, message.member, args.slice(1), (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }));
          return;
        }
        await message.reply(`ℹ️ **Usage:** \`${PREFIX}list tournament [all]\` — List tournaments hosted on MatchDistrict.`);
        return;
      } else if (cmd === 'fetch') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'teams' || sub === 'team') {
          await handleFetchTeamsCommand(message.guild, message.member, args.slice(1), (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }), message.channel);
          return;
        }
        await message.reply(`ℹ️ **Usage:** \`${PREFIX}fetch teams <tournament_id>\` — Fetch registered teams & sync Discord channels.`);
        return;
      } else if (cmd === 'select' || cmd === 'manage') {
        const sub = (args[0] || '').toLowerCase();
        let targetId = args[0];
        if (sub === 'tournament' || sub === 'tournaments') {
          targetId = args[1];
        }
        await handleSelectTournamentCommand(message.guild, message.member, targetId, (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }));
        return;
      } else if (cmd === 'sync' || cmd === 'reconcile') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'roles' || sub === 'role') {
          await handleSyncRolesCommand(message.guild, message.member, args.slice(1), (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }), message.channel);
          return;
        }
        const access = checkTournamentAccess(message.guild, message.member);
        if (!access.allowed) {
          await message.reply(access.reason);
          return;
        }
        const waitMsg = await message.reply('⏳ **Reconciling tournament participant access in official Discord server...**');
        const results = await reconcileAllTournamentAccess(message.guild);
        await waitMsg.edit(
          `✅ **Reconciliation Complete:** Synchronized **${results.synchronizedTournaments}** tournament(s).` +
          (results.failures.length > 0 ? `\n⚠️ Warnings: ${results.failures.join(', ')}` : '')
        );
        return;
      } else if (cmd === 'status') {
        await handleStatusCommand(message.guild, (text) => message.reply(text));
        return;
      } else if (cmd === 'ping') {
        const sent = await message.reply('🏓 Pinging...');
        const roundtripLatency = sent.createdTimestamp - message.createdTimestamp;
        const wsLatency = Math.round(message.client.ws.ping);
        await sent.edit(getPingResponse(roundtripLatency, wsLatency));
        return;
      } else if (cmd === 'help') {
        await message.reply(getHelpResponse(PREFIX));
        return;
      } else if (cmd === 'website' || cmd === 'site') {
        await message.reply(getWebsiteResponse());
        return;
      }
    }

    // If not a command, log regular member messages
    await handleMessageCreateLog(message);
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Error in MessageCreate handler:', error.message);
  }
});

// Persistent interaction listener (ensures tournament control panel buttons work across bot restarts)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId?.startsWith('md_tour_')) {
      await handleTournamentButtonInteraction(interaction);
      return;
    }
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Error in InteractionCreate handler:', error.message);
  }
});

// Message edit and delete listeners
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  await handleMessageUpdateLog(oldMessage, newMessage);
});

client.on(Events.MessageDelete, async (message) => {
  await handleMessageDeleteLog(message);
});

// Ban and unban listeners
client.on(Events.GuildBanAdd, async (ban) => {
  await handleGuildBanAdd(ban);
});

client.on(Events.GuildBanRemove, async (ban) => {
  await handleGuildBanRemove(ban);
});

// Member join listener
client.on(Events.GuildMemberAdd, async (member) => {
  await handleGuildMemberAdd(member);
  if (isOfficialGuild(member.guild)) {
    await syncMemberTournamentRoles(member).catch(() => {});
    await syncMemberTournamentAccess(member).catch(() => {});
  }
});

// Error listeners
client.on(Events.Error, (error) => {
  console.error('[Discord Bot] ❌ Discord client encountered an error:', error.message);
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`[Discord Bot] ❌ Connection error on shard ${shardId}:`, error.message);
});

/**
 * Start the Discord bot using the configured DISCORD_BOT_TOKEN.
 */
export async function startBot(tokenOverride) {
  const token = tokenOverride || getBotToken();

  if (!token) {
    console.error('[Discord Bot] ❌ DISCORD_BOT_TOKEN is not configured.');
    console.error('[Discord Bot] ℹ️ Please configure DISCORD_BOT_TOKEN in your environment or .env file.');
    return null;
  }

  try {
    console.log('[Discord Bot] 🔄 Connecting to Discord Gateway...');
    await client.login(token);
    return client;
  } catch (error) {
    console.error('[Discord Bot] ❌ Connection failed:');
    if (error.message?.includes('Privileged intent') || error.message?.includes('disallowed intent')) {
      console.error('[Discord Bot] 🚨 Privileged Gateway Intent missing! Ensure you enable in Developer Portal:');
      console.error('[Discord Bot]    1. "SERVER MEMBERS INTENT" (for welcome DMs)');
      console.error('[Discord Bot]    2. "MESSAGE CONTENT INTENT" (for prefix commands & message logs)');
    } else if (error.message?.includes('An invalid token')) {
      console.error('[Discord Bot] 🚨 The provided DISCORD_BOT_TOKEN is invalid.');
    } else {
      console.error(`[Discord Bot] 🚨 ${error.message}`);
    }
    throw error;
  }
}

// Graceful shutdown handling
let isShuttingDown = false;
export async function gracefulShutdown(signal) {
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
}

process.once('SIGINT', () => {
  gracefulShutdown('SIGINT').then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  gracefulShutdown('SIGTERM').then(() => process.exit(0));
});

// Auto-start bot only when this file is executed directly (not when imported in test suites)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  startBot().catch((error) => {
    console.error('[Discord Bot] ❌ Fatal startup error:', error?.message || error);
    process.exit(1);
  });
}
