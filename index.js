import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
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
  handleTournamentSelectionButton,
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
  enqueueRoleSyncRetry,
  removeRoleSyncRetry,
  processPendingRoleSyncQueue,
  MAX_ROLE_SYNC_RETRIES,
  ROLE_SYNC_RETRY_INTERVAL_MS,
  handleTournamentModalSubmit,
  handleTournamentSelectMenuInteraction,
  publishGroupCredentials,
  handlePublishCredentialsCommand,
  publishRoundAllocationSummary,
  handleViewRoundsScreen,
  handleCreateSequentialRound,
  handleOpenIndividualRoundMenu,
  handlePromptStartRound,
  handleConfirmStartRound,
  handleEditRoundButton,
  handleEditRoundSubmit,
  handlePromptDeleteRound,
  handleConfirmDeleteRound,
  handleViewRoundAllocation,
  handleBackToTournamentPanel,
  pendingResultSubmissions,
  applyStrictGroupChannelPermissions,
  updateGroupControlMessage,
  handleGroupSubmitResultButton,
  handleGroupSubmitResultModal,
  handleSubmissionScreenshotUpload,
  handleGroupRevokeSubmissionButton,
  handleGroupReopenSubmissionButton,
  handleAdminAcceptResultButton,
  handleAdminRejectResultButton,
  handleAdminRejectResultModal,
  removeGroupResultControlMessage,
  updateGroupSlotListMessage,
  updateGlobalSubmissionControlPanel,
  handleOpenSubmissionsButton,
  handleCloseSubmissionsButton,
  handleRefreshSubmissionsButton,
  handleQualifyTeamButton,
  handleConfirmQualifyTeams,
  handleSubmitResultPromptCommand,
  generateEmptyRoundGroups,
  handleDashCommand,
  handleDashboardNavigationInteraction,
  handleRoundRegistrationMessage,
  handleDashboardQualifySelection,
  fetchTournamentRegistrationsFromBackend,
  handleTournamentVerificationMessage,
  handlePermanentTournamentDeleteCommand,
  executeTournamentPermanentDeletion,
  resumePendingTournamentDeletions,
  handleOrganiserCommand,
  handleOrganiserModalSubmit,
  handleOrganiserButtonInteraction,
  executeOrganiserLinkVerification,
  initOrganiserLinksCache,
  isAuthorizedGuild,
} from './tournamentService.js';
import {
  initMongo,
  isMongoConnected,
  ensurePersistenceAvailable,
  upsertManagedMessage,
  upsertManagedMessageBatch,
  deleteManagedMessages,
  saveGuildSettingsToDb,
  saveTournamentToDb,
  findTournamentByBotCommandsChannel,
  getGuildSettingsFromDb,
  loadAllGuildSettingsFromDb,
  loadAllTournamentsFromDb,
  syncGuildSettingsCacheToDb,
  migrateJsonToMongo,
  reconcileManagedBotState,
  closeMongo,
  setDiscordAuditClient,
} from './mongoService.js';
import {
  createAuditEmbed,
  sendAuditLog,
  AUDIT_COLORS,
  AUDIT_FOOTER_TEXT,
  logRoleCreated,
  logRoleBatchCreated,
  handleRoleCreateWithBatching,
  logRoleDeleted,
  logRoleUpdated,
  logRolesGiven,
  logRolesRemoved,
  logChannelCreated,
  logChannelDeleted,
  logChannelUpdated,
  logMemberJoined,
  logMemberLeft,
  logMemberBanned,
  logMemberUnbanned,
  logMessageSent,
  logMessageEdited,
  logMessageDeleted,
  logTournamentAction,
} from './auditLogger.js';
import {
  handleTicketSetupCommand,
  handleTicketInteraction,
} from './ticketService.js';
import {
  handleMessageModeration,
  handleMessageUpdateModeration,
  handleUnmuteCommand,
  handleUnbanCommand,
  verifyBotModerationPermissions,
} from './moderationService.js';
import {
  handleAnncSetupCommand,
  handleAnnouncementChannelMessage,
  handleAnnouncementInteraction,
} from './announcementService.js';
import {
  refreshGuildMemberCacheOnce,
  updateGuildMemberCache,
  removeGuildMemberFromCache,
} from './memberCacheService.js';

export {
  handleListTournamentCommand,
  handleTournamentSelectionButton,
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
  enqueueRoleSyncRetry,
  removeRoleSyncRetry,
  processPendingRoleSyncQueue,
  MAX_ROLE_SYNC_RETRIES,
  ROLE_SYNC_RETRY_INTERVAL_MS,
  handleTournamentModalSubmit,
  handleTournamentSelectMenuInteraction,
  publishGroupCredentials,
  handlePublishCredentialsCommand,
  publishRoundAllocationSummary,
  handleViewRoundsScreen,
  handleCreateSequentialRound,
  handleOpenIndividualRoundMenu,
  handlePromptStartRound,
  handleConfirmStartRound,
  handleEditRoundButton,
  handleEditRoundSubmit,
  handlePromptDeleteRound,
  handleConfirmDeleteRound,
  handleViewRoundAllocation,
  handleBackToTournamentPanel,
  pendingResultSubmissions,
  applyStrictGroupChannelPermissions,
  updateGroupControlMessage,
  handleGroupSubmitResultButton,
  handleGroupSubmitResultModal,
  handleSubmissionScreenshotUpload,
  handleGroupRevokeSubmissionButton,
  handleGroupReopenSubmissionButton,
  handleAdminAcceptResultButton,
  handleAdminRejectResultButton,
  handleAdminRejectResultModal,
  removeGroupResultControlMessage,
  updateGroupSlotListMessage,
  updateGlobalSubmissionControlPanel,
  handleOpenSubmissionsButton,
  handleCloseSubmissionsButton,
  handleRefreshSubmissionsButton,
  handleQualifyTeamButton,
  handleConfirmQualifyTeams,
  handleSubmitResultPromptCommand,
  generateEmptyRoundGroups,
  handleDashCommand,
  handleDashboardNavigationInteraction,
  handleRoundRegistrationMessage,
  handleDashboardQualifySelection,
  fetchTournamentRegistrationsFromBackend,
  handlePermanentTournamentDeleteCommand,
  executeTournamentPermanentDeletion,
  resumePendingTournamentDeletions,
  handleOrganiserCommand,
  handleOrganiserModalSubmit,
  handleOrganiserButtonInteraction,
  executeOrganiserLinkVerification,
  initOrganiserLinksCache,
  isAuthorizedGuild,
  initMongo,
  isMongoConnected,
  ensurePersistenceAvailable,
  upsertManagedMessage,
  upsertManagedMessageBatch,
  deleteManagedMessages,
  saveGuildSettingsToDb,
  getGuildSettingsFromDb,
  loadAllGuildSettingsFromDb,
  loadAllTournamentsFromDb,
  syncGuildSettingsCacheToDb,
  migrateJsonToMongo,
  reconcileManagedBotState,
  closeMongo,
  createAuditEmbed,
  sendAuditLog,
  AUDIT_COLORS,
  AUDIT_FOOTER_TEXT,
  logRoleCreated,
  logRoleBatchCreated,
  handleRoleCreateWithBatching,
  logRoleDeleted,
  logRoleUpdated,
  logRolesGiven,
  logRolesRemoved,
  logChannelCreated,
  logChannelDeleted,
  logChannelUpdated,
  logMemberJoined,
  logMemberLeft,
  logMemberBanned,
  logMemberUnbanned,
  logMessageSent,
  logMessageEdited,
  logMessageDeleted,
  logTournamentAction,
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
  {
    key: 'modLogId',
    name: 'mod-log',
    topic: 'Private MatchDistrict Moderation Logs (Link Blocking, Abusive Words, Timeouts, Bans)',
  },
  {
    key: 'channelCreateLogId',
    name: 'channel-create-log',
    topic: 'Private MatchDistrict Channel Creation Logs',
  },
  {
    key: 'channelDeleteLogId',
    name: 'channel-delete-log',
    topic: 'Private MatchDistrict Channel Deletion Logs',
  },
  {
    key: 'roleCreateLogId',
    name: 'role-create-log',
    topic: 'Private MatchDistrict Role Creation Logs',
  },
  {
    key: 'roleDeleteLogId',
    name: 'role-delete-log',
    topic: 'Private MatchDistrict Role Deletion Logs',
  },
  {
    key: 'tournamentLogId',
    name: 'tournament-log',
    topic: 'Private MatchDistrict Tournament Management Logs',
  },
  {
    key: 'ticketLogId',
    name: 'ticket-log',
    topic: 'Private MatchDistrict Ticket Event Logs (Opened, Closed, Deleted, Errors)',
  },
  {
    key: 'staffAppLogId',
    name: 'staff-application-log',
    topic: 'Private MatchDistrict Staff Application Logs (Applications & Statuses)',
  },
];

export const RESERVED_LOG_CHANNEL_NAMES = new Set([
  'bot-preview',
  'dm-log',
  'msg-log',
  'ban-unban-log',
  'mod-log',
  'channel-create-log',
  'channel-delete-log',
  'role-create-log',
  'role-delete-log',
  'tournament-log',
  'ticket-log',
  'staff-application-log',
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

  // Persist to MongoDB collections if connected
  if (isMongoConnected() && settings) {
    syncGuildSettingsCacheToDb(settings).catch((err) => {
      console.warn('[MongoDB] ⚠️ Error syncing settings cache to database:', err.message);
    });
  }
}

export let guildSettingsCache = loadGuildSettings();

export function getGuildSettings(guildId) {
  if (!guildId) return null;
  return guildSettingsCache[guildId] || null;
}

export function isModerationEnabled(guildId) {
  if (!guildId) return false;
  const settings = guildSettingsCache[guildId];
  return Boolean(settings?.setupActive && settings?.moderationEnabled);
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
export const recentChannelCreates = new Map(); // Key: channelId, Value: timestamp
export const recentChannelDeletes = new Map(); // Key: channelId, Value: timestamp
export const recentRoleCreates = new Map(); // Key: roleId, Value: timestamp
export const recentRoleDeletes = new Map(); // Key: roleId, Value: timestamp
export const pendingSetupRemovals = new Map(); // Key: guildId, Value: { adminId, timestamp, timer }
const memberCountUpdateTimers = new Map();
const memberCountSetupPromises = new Map();

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
  if (member.guild && member.guild.ownerId === member.id) return true;
  return (
    Boolean(member.permissions?.has(PermissionFlagsBits.Administrator)) ||
    Boolean(member.permissions?.has(PermissionFlagsBits.ManageGuild)) ||
    false
  );
}

/**
 * Formats the official MatchDistrict welcome message for a new member.
 */
export function buildWelcomeMessage(name) {
  return `Hey **${name}**! Welcome to **Match District** 🎉\n\n` +
    `Match District is an esports platform where you can join tournaments, register your squad, follow live leaderboards and results, and get verified prize payouts.\n\n` +
    `🌐 https://matchdistrict.in\n\n` +
    `See you in the battleground! 🚀\n` +
    `— **Team MatchDistrict**`;
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
    `  - 🔨 **Ban/Unban Logs:** ${channelMap.banUnbanLogId ? `<#${channelMap.banUnbanLogId}>` : 'Not configured'}\n` +
    `  - 📁 **Channel Create Logs:** ${channelMap.channelCreateLogId ? `<#${channelMap.channelCreateLogId}>` : 'Not configured'}\n` +
    `  - 🗑️ **Channel Delete Logs:** ${channelMap.channelDeleteLogId ? `<#${channelMap.channelDeleteLogId}>` : 'Not configured'}\n` +
    `  - 🏷️ **Role Create Logs:** ${channelMap.roleCreateLogId ? `<#${channelMap.roleCreateLogId}>` : 'Not configured'}\n` +
    `  - ❌ **Role Delete Logs:** ${channelMap.roleDeleteLogId ? `<#${channelMap.roleDeleteLogId}>` : 'Not configured'}\n\n` +
    `**Management Commands (Prefix: \`${PREFIX}\`):**\n` +
    `• \`${PREFIX}setup\` — Run or refresh server channels and permissions\n` +
    `• \`${PREFIX}member count <text>\` — Customize the member-count voice channel name\n` +
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
    `• \`${prefix}clear <1-100>\` — *(Mod Only)* Bulk delete recent messages\n` +
    `• \`${prefix}unmute <@user|id>\` — *(Mod Only)* Remove timeout from a user\n` +
    `• \`${prefix}unban <@user|id>\` — *(Mod Only)* Unban a user from the server\n` +
    `• \`${prefix}ticket setup\` — *(Admin Only)* Setup support ticket panel in #support-ticket\n` +
    `• \`${prefix}annc setup\` — *(Admin Only)* Setup private announcement DM dispatch channel\n\n` +
    `**🏆 Tournament & Organiser Management:**\n` +
    `• \`${prefix}organiser\` — *(Admin Only)* Connect this Discord server to your MatchDistrict organiser account\n` +
    `• \`${prefix}organiser unlink\` — *(Admin Only)* Disconnect this Discord server from the organiser account\n` +
    `• \`${prefix}list tournament [all]\` — *(Admin Only)* List tournaments & open control panel via selection\n` +
    `• \`${prefix}select tournament <id>\` — *(Admin Only)* Open or refresh control panel in #bot-commands\n` +
    `• \`${prefix}dash\` — *(Admin Only)* Restore/resynchronize the tournament control panel in #bot-commands\n` +
    `• \`${prefix}delete tournament <id>\` — *(Admin Only)* Permanently delete tournament, channels, roles, and database records\n` +
    `• \`${prefix}fetch teams [id]\` — *(Admin Only)* Provision tournament channels & sync live registered roster\n` +
    `• \`${prefix}cred <room_id> <password>\` — *(Admin Only)* Publish match credentials inside a private group channel\n\n` +
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

function memberCountChannelName(guild, prefix = getGuildSettings(guild?.id)?.memberCountPrefix || 'Members') {
  const count = Number(guild?.memberCount);
  return `${prefix}: ${(Number.isFinite(count) && count >= 0 ? count : 0).toLocaleString('en-US')}`;
}

async function resolveSavedMemberCountChannel(guild) {
  const channelId = getGuildSettings(guild.id)?.channels?.memberCountId;
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) ||
    (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(channelId).catch(() => null) : null);
  return channel?.type === ChannelType.GuildVoice ? channel : null;
}

async function refreshMemberCountChannel(guild) {
  try {
    const channel = await resolveSavedMemberCountChannel(guild);
    if (!channel) return false;
    const desiredName = memberCountChannelName(guild);
    if (channel.name !== desiredName) await channel.setName(desiredName, 'Update live server member count');
    return true;
  } catch (error) {
    console.warn(`[Discord Bot] Could not update member-count channel for guild ${guild?.id}:`, error?.message || error);
    return false;
  }
}

function scheduleMemberCountChannelRefresh(guild) {
  if (!guild?.id) return;
  const existingTimer = memberCountUpdateTimers.get(guild.id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(async () => {
    memberCountUpdateTimers.delete(guild.id);
    await refreshMemberCountChannel(guild);
  }, 1500);
  if (timer.unref) timer.unref();
  memberCountUpdateTimers.set(guild.id, timer);
}

async function ensureMemberCountVoiceChannel(guild, botMember) {
  if (memberCountSetupPromises.has(guild.id)) return memberCountSetupPromises.get(guild.id);
  const setupPromise = (async () => {
    const channels = getGuildSettings(guild.id)?.channels || {};
    let channel = channels.memberCountId
      ? (guild.channels.cache.get(channels.memberCountId) || await guild.channels.fetch(channels.memberCountId).catch(() => null))
      : null;

    if (channel?.type !== ChannelType.GuildVoice) channel = null;
    if (!channel) {
      await guild.channels.fetch().catch(() => null);
      channel = guild.channels.cache.find((candidate) => candidate.type === ChannelType.GuildVoice && /^Members: [\d,]+$/.test(candidate.name)) || null;
    }

    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels],
      },
      {
        id: botMember.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
      },
    ];

    if (channel) {
      await channel.permissionOverwrites.set(permissionOverwrites);
      if (channel.name !== memberCountChannelName(guild)) {
        await channel.setName(memberCountChannelName(guild), 'Refresh live server member count during .setup');
      }
      return { channel, created: false };
    }

    channel = await guild.channels.create({
      name: memberCountChannelName(guild),
      type: ChannelType.GuildVoice,
      permissionOverwrites,
      reason: 'Create public locked live server member-count channel during .setup',
    });
    return { channel, created: true };
  })();

  memberCountSetupPromises.set(guild.id, setupPromise);
  try {
    return await setupPromise;
  } finally {
    memberCountSetupPromises.delete(guild.id);
  }
}

export async function handleMemberCountCommand(guild, member, args, replyFn) {
  if (!guild) {
    await replyFn('❌ This command must be used inside a Discord server.');
    return;
  }
  if (!isAdmin(member)) {
    await replyFn('❌ Only server Administrators or members with `Manage Server` permission can change the member-count channel name.');
    return;
  }

  const prefix = (Array.isArray(args) ? args.join(' ') : String(args || '')).trim();
  if (!prefix) {
    await replyFn(`ℹ️ Usage: \`${PREFIX}member count <custom text>\` — Example: \`${PREFIX}member count Our Community\``);
    return;
  }
  if (prefix.length > 90) {
    await replyFn('❌ The custom text must be 90 characters or fewer so the member count fits within Discord’s channel-name limit.');
    return;
  }

  try {
    guildSettingsCache[guild.id] ||= {};
    guildSettingsCache[guild.id].memberCountPrefix = prefix;
    guildSettingsCache[guild.id].updatedAt = new Date().toISOString();
    saveGuildSettings(guildSettingsCache);
    await syncGuildSettingsCacheToDb(guildSettingsCache);

    const updated = await refreshMemberCountChannel(guild);
    if (!updated) {
      await replyFn(`✅ Saved the member-count prefix as **${prefix}**. The channel is missing; run \`${PREFIX}setup\` to recreate it.`);
      return;
    }
    await replyFn(`✅ Member-count channel updated to **${memberCountChannelName(guild, prefix)}**.`);
  } catch (error) {
    console.warn(`[Discord Bot] Could not set member-count prefix for guild ${guild.id}:`, error?.message || error);
    await replyFn('❌ Could not update the member-count channel. Please try again.');
  }
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
      targetChannel = guild.channels.cache.get(existingId) ||
        (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(existingId).catch(() => null) : null);
    }

    // If not found by saved ID, check by channel name
    if (!targetChannel) {
      if (typeof guild.channels?.fetch === 'function') {
        await guild.channels.fetch().catch(() => null);
      }
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
          PermissionFlagsBits.ManageChannels,
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

  // 3a. Create or reuse the public, locked live member-count voice channel.
  try {
    const { channel: memberCountChannel, created } = await ensureMemberCountVoiceChannel(guild, botMember);
    channelMap.memberCountId = memberCountChannel.id;
    (created ? results.created : results.reused).push(memberCountChannel);
  } catch (err) {
    console.error(`[Discord Bot] ❌ Failed to configure member-count voice channel in guild ${guild.id}:`, err.message);
    results.failed.push({ name: 'member-count voice channel', error: err.message });
  }

  // 4. Save guild settings
  const welcomeCurrentlyEnabled = currentSettings.welcomeEnabled !== undefined ? currentSettings.welcomeEnabled : true;
  const updatedChannels = {};
  for (const req of REQUIRED_CHANNELS) {
    updatedChannels[req.key] = channelMap[req.key] || savedChannels[req.key] || null;
  }
  updatedChannels.memberCountId = channelMap.memberCountId || savedChannels.memberCountId || null;

  guildSettingsCache[guild.id] = {
    ...currentSettings,
    setupActive: true,
    moderationEnabled: true,
    welcomeEnabled: welcomeCurrentlyEnabled,
    channels: updatedChannels,
    logChannelId: channelMap.dmLogId || savedChannels.dmLogId || null, // legacy
    setupBy: member.id,
    setupAt: new Date().toISOString(),
  };
  saveGuildSettings(guildSettingsCache);
  await syncGuildSettingsCacheToDb(guildSettingsCache);

  // 5. Send or refresh management card in #bot-preview idempotently
  const previewChannelId = channelMap.botPreviewId || savedChannels.botPreviewId;
  const previewChannel = previewChannelId ? guild.channels.cache.get(previewChannelId) : null;
  if (previewChannel) {
    try {
      const logicalKey = `guild:${guild.id}:channel:${previewChannel.id}:bot_preview`;
      await upsertManagedMessage(guild.client, {
        guildId: guild.id,
        channelId: previewChannel.id,
        channel: previewChannel,
        logicalKey,
        messageType: 'bot_preview_panel',
        payload: buildBotPreviewMessage(guild, welcomeCurrentlyEnabled, channelMap),
      });
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
  summary += `• **Member Count:** ${channelMap.memberCountId ? `<#${channelMap.memberCountId}>` : 'Not configured'}\n`;
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
    .join('\n') + (savedChannels.memberCountId ? `\n• <#${savedChannels.memberCountId}> (live member-count voice channel)` : '');

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
    const channel = guild.channels.cache.get(channelId) ||
      (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(channelId).catch(() => null) : null);
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

  if (savedChannels.memberCountId) {
    const channelId = savedChannels.memberCountId;
    const channel = guild.channels.cache.get(channelId) ||
      (typeof guild.channels?.fetch === 'function' ? await guild.channels.fetch(channelId).catch(() => null) : null);
    if (!channel) {
      skipped.push({ name: 'member-count voice channel', reason: 'Already deleted or not found' });
    } else if ((channel.guildId || channel.guild?.id) !== guild.id || channel.id !== channelId || channel.type !== ChannelType.GuildVoice) {
      failed.push({ name: 'member-count voice channel', error: 'Channel does not belong to this server configuration' });
    } else {
      try {
        await channel.delete(`MatchDistrict .setup remove confirmed by ${member.user?.tag || member.id} (${member.id})`);
        deleted.push({ id: channelId, name: channel.name });
      } catch (err) {
        failed.push({ name: 'member-count voice channel', error: err.message });
      }
    }
  }

  // 7. Clear stored channel IDs and mark setup as inactive
  const clearedChannels = {};
  for (const req of REQUIRED_CHANNELS) {
    clearedChannels[req.key] = null;
  }
  clearedChannels.memberCountId = null;

  guildSettingsCache[guild.id] = {
    ...currentSettings,
    setupActive: false,
    moderationEnabled: false,
    channels: clearedChannels,
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

  // 7. Log to #ban-unban-log with standardized audit embed
  try {
    await logMemberBanned(guild, targetUser, member, reason, `Bot Command (${PREFIX}ban)`);
  } catch (logErr) {
    console.warn('[Discord Bot] ⚠️ Could not write to #ban-unban-log:', logErr.message);
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
 * Handles .deletemsg <message_id | logical_key | tournament:<id>>
 * Persistent administrative deletion across restarts using stored MongoDB records.
 */
export async function handleDeleteManagedMessageCommand(guild, member, args, replyFn) {
  if (!guild) {
    await replyFn('❌ **Error:** This command must be executed within a Discord server.');
    return;
  }
  if (!isAdmin(member)) {
    await replyFn('❌ **Permission Denied:** Only server Administrators can delete bot managed messages.');
    return;
  }

  const target = (args[0] || '').trim();
  if (!target) {
    await replyFn(`ℹ️ **Usage:** \`${PREFIX}deletemsg <message_id | logical_key | tournament:<tournament_id>>\``);
    return;
  }

  let filter = { guildId: guild.id };
  if (target.startsWith('tournament:')) {
    filter.tournamentId = target.slice('tournament:'.length).trim();
  } else if (target.includes(':')) {
    filter.logicalKey = target;
  } else {
    filter.messageId = target;
  }

  try {
    const result = await deleteManagedMessages(guild.client, filter, member);
    if (result.deletedCount > 0) {
      await replyFn(`🗑️ **Managed Message(s) Deleted:** Successfully deleted **${result.deletedCount}** message(s) from Discord and archived database record(s).`);
    } else {
      await replyFn(`⚠️ **No Active Messages Found:** No active managed message matched \`${target}\`. If the message was already deleted from Discord, its status has been reconciled in the database.`);
    }
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error executing deletemsg command:', err.message);
    await replyFn(`❌ **Error:** Failed to delete managed message: ${err.message}`);
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

    await logMessageSent(message);
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

    await logMessageEdited(oldMessage, newMessage);
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

    await logMessageDeleted(message);
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

    await logMemberBanned(
      guild,
      user,
      moderator || (cached?.moderatorId ? { id: cached.moderatorId, tag: cached.moderatorTag } : null),
      reason,
      cached ? 'Bot Command' : 'Discord Native / External'
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

    await logMemberUnbanned(guild, user, moderator, reason);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in GuildBanRemove handler:', err.message);
  }
}

/**
 * Format human-readable channel type name.
 */
export function formatChannelTypeName(type) {
  switch (type) {
    case ChannelType.GuildText: return 'Text Channel';
    case ChannelType.GuildVoice: return 'Voice Channel';
    case ChannelType.GuildCategory: return 'Category';
    case ChannelType.GuildAnnouncement: return 'Announcement Channel';
    case ChannelType.AnnouncementThread: return 'Announcement Thread';
    case ChannelType.PublicThread: return 'Public Thread';
    case ChannelType.PrivateThread: return 'Private Thread';
    case ChannelType.GuildStageVoice: return 'Stage Voice Channel';
    case ChannelType.GuildForum: return 'Forum Channel';
    case ChannelType.GuildMedia: return 'Media Channel';
    default: return `Channel (Type ${type})`;
  }
}

/**
 * Handles ChannelCreate audit logging into #channel-create-log
 */
export async function handleChannelCreateAuditLog(channel) {
  try {
    if (!channel || !channel.guild) return;
    const guild = channel.guild;

    // Official server or setup active check
    if (!isOfficialGuild(guild) && !isSetupActive(guild.id)) return;

    // Deduplication check
    if (recentChannelCreates.has(channel.id)) return;
    recentChannelCreates.set(channel.id, Date.now());
    for (const [k, v] of recentChannelCreates.entries()) {
      if (Date.now() - v > 60000) recentChannelCreates.delete(k);
    }

    const logChannelId = getGuildChannelId(guild.id, 'channelCreateLogId');
    let logChannel = logChannelId ? guild.channels.cache?.get(logChannelId) : null;
    if (!logChannel && typeof guild.channels.cache?.find === 'function') {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'channel-create-log'
      );
    }

    const botMember = guild.members.me;
    if (!logChannel || (typeof logChannel.permissionsFor === 'function' && !logChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages))) {
      return;
    }

    let creator = null;
    try {
      if (botMember?.permissions?.has && botMember.permissions.has(PermissionFlagsBits.ViewAuditLog) && typeof guild.fetchAuditLogs === 'function') {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.ChannelCreate,
          limit: 5,
        });
        const match = auditLogs.entries.find(
          (e) => e.target?.id === channel.id && Date.now() - e.createdTimestamp < 30000
        );
        if (match) {
          creator = match.executor;
        }
      }
    } catch (auditErr) {
      console.warn('[Discord Bot] ⚠️ Could not query audit logs for channel create:', auditErr.message);
    }

    const isBot = creator?.id === channel.client?.user?.id || (channel.client?.user?.id && creator?.bot);
    const sourceDisplay = isBot
      ? '🤖 Bot Operation (MatchDistrict Bot)'
      : (creator ? '👤 Server Member / Moderator' : 'External / Discord Native Action');

    const creatorDisplay = creator
      ? `<@${creator.id}> (\`${creator.tag || creator.username}\` | ID: \`${creator.id}\`)`
      : 'Unavailable (Audit Log permission required or entry missing)';

    let parentDisplay = 'None (Top-Level)';
    if (channel.parentId) {
      const parentCat = channel.parent || (guild.channels.cache?.get ? guild.channels.cache.get(channel.parentId) : null);
      parentDisplay = parentCat ? `📁 **${parentCat.name}** (ID: \`${channel.parentId}\`)` : `ID: \`${channel.parentId}\``;
    }

    const channelDisplay = channel.type === ChannelType.GuildCategory
      ? `📁 **${channel.name}** (Category | ID: \`${channel.id}\`)`
      : `<#${channel.id}> (\`#${channel.name}\` | ID: \`${channel.id}\`)`;

    await logChannelCreated(channel, creator, sourceDisplay);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in ChannelCreate audit logger:', err.message);
  }
}

/**
 * Handles ChannelDelete audit logging into #channel-delete-log
 */
export async function handleChannelDeleteAuditLog(channel) {
  try {
    if (!channel || !channel.guild) return;
    const guild = channel.guild;

    if (!isOfficialGuild(guild) && !isSetupActive(guild.id)) return;

    if (recentChannelDeletes.has(channel.id)) return;
    recentChannelDeletes.set(channel.id, Date.now());
    for (const [k, v] of recentChannelDeletes.entries()) {
      if (Date.now() - v > 60000) recentChannelDeletes.delete(k);
    }

    const logChannelId = getGuildChannelId(guild.id, 'channelDeleteLogId');
    let logChannel = logChannelId ? guild.channels.cache?.get(logChannelId) : null;
    if (!logChannel && typeof guild.channels.cache?.find === 'function') {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'channel-delete-log'
      );
    }

    const botMember = guild.members.me;
    if (!logChannel || (typeof logChannel.permissionsFor === 'function' && !logChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages))) {
      return;
    }

    let actor = null;
    let reason = null;
    try {
      if (botMember?.permissions?.has && botMember.permissions.has(PermissionFlagsBits.ViewAuditLog) && typeof guild.fetchAuditLogs === 'function') {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.ChannelDelete,
          limit: 5,
        });
        const match = auditLogs.entries.find(
          (e) => e.target?.id === channel.id && Date.now() - e.createdTimestamp < 30000
        );
        if (match) {
          actor = match.executor;
          reason = match.reason || null;
        }
      }
    } catch (auditErr) {
      console.warn('[Discord Bot] ⚠️ Could not query audit logs for channel delete:', auditErr.message);
    }

    const isBot = actor?.id === channel.client?.user?.id || (channel.client?.user?.id && actor?.bot);
    const sourceDisplay = isBot
      ? '🤖 Bot Operation (MatchDistrict Bot)'
      : (actor ? '👤 Server Member / Moderator' : 'External / Discord Native Action');

    const actorDisplay = actor
      ? `<@${actor.id}> (\`${actor.tag || actor.username}\` | ID: \`${actor.id}\`)`
      : 'Unavailable (Audit Log permission required or entry missing)';

    let parentDisplay = 'None (Top-Level)';
    if (channel.parentId) {
      const parentCat = channel.parent || (guild.channels.cache?.get ? guild.channels.cache.get(channel.parentId) : null);
      parentDisplay = parentCat ? `📁 **${parentCat.name}** (ID: \`${channel.parentId}\`)` : `ID: \`${channel.parentId}\``;
    }

    await logChannelDeleted(channel, actor, reason, sourceDisplay);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in ChannelDelete audit logger:', err.message);
  }
}

/**
 * Handles GuildRoleCreate audit logging into #role-create-log
 */
export async function handleRoleCreateAuditLog(role) {
  try {
    if (!role || !role.guild) return;
    const guild = role.guild;

    if (!isOfficialGuild(guild) && !isSetupActive(guild.id)) return;

    if (recentRoleCreates.has(role.id)) return;
    recentRoleCreates.set(role.id, Date.now());
    for (const [k, v] of recentRoleCreates.entries()) {
      if (Date.now() - v > 60000) recentRoleCreates.delete(k);
    }

    const logChannelId = getGuildChannelId(guild.id, 'roleCreateLogId');
    let logChannel = logChannelId ? guild.channels.cache?.get(logChannelId) : null;
    if (!logChannel && typeof guild.channels.cache?.find === 'function') {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'role-create-log'
      );
    }

    const botMember = guild.members.me;
    if (!logChannel || (typeof logChannel.permissionsFor === 'function' && !logChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages))) {
      return;
    }

    let creator = null;
    try {
      if (botMember?.permissions?.has && botMember.permissions.has(PermissionFlagsBits.ViewAuditLog) && typeof guild.fetchAuditLogs === 'function') {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.RoleCreate,
          limit: 5,
        });
        const match = auditLogs.entries.find(
          (e) => e.target?.id === role.id && Date.now() - e.createdTimestamp < 30000
        );
        if (match) {
          creator = match.executor;
        }
      }
    } catch (auditErr) {
      console.warn('[Discord Bot] ⚠️ Could not query audit logs for role create:', auditErr.message);
    }

    const isBot = creator?.id === role.client?.user?.id || (role.client?.user?.id && creator?.bot);
    const sourceDisplay = isBot
      ? '🤖 Bot Operation (MatchDistrict Bot)'
      : (creator ? '👤 Server Member / Moderator' : 'External / Discord Native Action');

    const creatorDisplay = creator
      ? `<@${creator.id}> (\`${creator.tag || creator.username}\` | ID: \`${creator.id}\`)`
      : 'Unavailable (Audit Log permission required or entry missing)';

    await handleRoleCreateWithBatching(role, creator, sourceDisplay);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in RoleCreate audit logger:', err.message);
  }
}

/**
 * Handles GuildRoleDelete audit logging into #role-delete-log
 */
export async function handleRoleDeleteAuditLog(role) {
  try {
    if (!role || !role.guild) return;
    const guild = role.guild;

    if (!isOfficialGuild(guild) && !isSetupActive(guild.id)) return;

    if (recentRoleDeletes.has(role.id)) return;
    recentRoleDeletes.set(role.id, Date.now());
    for (const [k, v] of recentRoleDeletes.entries()) {
      if (Date.now() - v > 60000) recentRoleDeletes.delete(k);
    }

    const logChannelId = getGuildChannelId(guild.id, 'roleDeleteLogId');
    let logChannel = logChannelId ? guild.channels.cache?.get(logChannelId) : null;
    if (!logChannel && typeof guild.channels.cache?.find === 'function') {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === 'role-delete-log'
      );
    }

    const botMember = guild.members.me;
    if (!logChannel || (typeof logChannel.permissionsFor === 'function' && !logChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages))) {
      return;
    }

    let actor = null;
    let reason = null;
    try {
      if (botMember?.permissions?.has && botMember.permissions.has(PermissionFlagsBits.ViewAuditLog) && typeof guild.fetchAuditLogs === 'function') {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.RoleDelete,
          limit: 5,
        });
        const match = auditLogs.entries.find(
          (e) => e.target?.id === role.id && Date.now() - e.createdTimestamp < 30000
        );
        if (match) {
          actor = match.executor;
          reason = match.reason || null;
        }
      }
    } catch (auditErr) {
      console.warn('[Discord Bot] ⚠️ Could not query audit logs for role delete:', auditErr.message);
    }

    const isBot = actor?.id === role.client?.user?.id || (role.client?.user?.id && actor?.bot);
    const sourceDisplay = isBot
      ? '🤖 Bot Operation (MatchDistrict Bot)'
      : (actor ? '👤 Server Member / Moderator' : 'External / Discord Native Action');

    const actorDisplay = actor
      ? `<@${actor.id}> (\`${actor.tag || actor.username}\` | ID: \`${actor.id}\`)`
      : 'Unavailable (Audit Log permission required or entry missing)';

    await logRoleDeleted(role, actor, reason, sourceDisplay);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in RoleDelete audit logger:', err.message);
  }
}

/**
 * Handles GuildRoleUpdate audit logging
 */
export async function handleRoleUpdateAuditLog(oldRole, newRole) {
  try {
    if (!newRole || !newRole.guild) return;
    if (!isOfficialGuild(newRole.guild) && !isSetupActive(newRole.guild.id)) return;
    await logRoleUpdated(oldRole, newRole);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in RoleUpdate audit logger:', err.message);
  }
}

/**
 * Handles ChannelUpdate audit logging
 */
export async function handleChannelUpdateAuditLog(oldChannel, newChannel) {
  try {
    if (!newChannel || !newChannel.guild) return;
    if (!isOfficialGuild(newChannel.guild) && !isSetupActive(newChannel.guild.id)) return;
    await logChannelUpdated(oldChannel, newChannel);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in ChannelUpdate audit logger:', err.message);
  }
}

/**
 * Handles member departure event
 */
export async function handleGuildMemberRemove(member) {
  try {
    if (!member || !member.guild) return;
    if (!isOfficialGuild(member.guild) && !isSetupActive(member.guild.id)) return;
    await logMemberLeft(member);
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in GuildMemberRemove audit logger:', err.message);
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
    const name = member.displayName || member.user?.globalName || member.user?.username || 'Player';
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

    const welcomeMessage = buildWelcomeMessage(name);

    // Locate dm-log channel
    const dmLogId = getGuildChannelId(guildId, 'dmLogId');
    let logChannel = dmLogId ? member.guild.channels.cache.get(dmLogId) : null;
    if (!logChannel && member.guild.channels?.cache) {
      logChannel = Array.from(member.guild.channels.cache.values()).find(
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
      if (dmError?.code === 50007 || dmError?.status === 403 || String(dmError?.message).toLowerCase().includes('cannot send messages to this user')) {
        failReason = 'Closed DMs';
        // If the user has DMs closed, ignore the error silently
      } else {
        failReason = dmError?.message || 'Unknown delivery failure';
        console.warn(`[Discord Bot] ⚠️ Could not send welcome DM to ${userTag}: ${dmError?.message}`);
      }
    }

    // Log to #dm-log if setup channels are active
    if (isSetupActive(guildId)) {
      await logMemberJoined(
        member,
        dmDelivered ? { delivered: true } : { delivered: false, reason: failReason }
      );
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

setDiscordAuditClient(client);

let roleSyncInterval = null;

export function startRoleSyncScheduler(targetClient = client) {
  if (roleSyncInterval) return;
  roleSyncInterval = setInterval(async () => {
    try {
      const officialGuildId = getOfficialGuildId();
      if (!officialGuildId || !targetClient?.guilds) return;
      const guild = targetClient.guilds.cache?.get(officialGuildId) ||
        await targetClient.guilds.fetch?.(officialGuildId).catch(() => null);
      if (guild) {
        await processPendingRoleSyncQueue(guild);
      }
    } catch (schedErr) {
      console.warn('[Discord Bot] ⚠️ Error in role sync retry scheduler:', schedErr.message);
    }
  }, 30000);
  if (roleSyncInterval.unref) roleSyncInterval.unref();
}

export function stopRoleSyncScheduler() {
  if (roleSyncInterval) {
    clearInterval(roleSyncInterval);
    roleSyncInterval = null;
  }
}

// Bot ready event listener
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Discord Bot] 🚀 Logged in as ${readyClient.user.tag} (ID: ${readyClient.user.id})`);
  console.log(`[Discord Bot] 🎮 MatchDistrict Bot is active across ${readyClient.guilds.cache.size} server(s).`);
  console.log(`[Discord Bot] ⚡ Command prefix: "${PREFIX}"`);
  startRoleSyncScheduler(readyClient);

  // Verify bot moderation permissions across joined guilds
  for (const guild of readyClient.guilds.cache.values()) {
    verifyBotModerationPermissions(guild);
  }

  // Startup reconciliation and deletion recovery for managed Discord resources across MongoDB and Discord
  try {
    await initOrganiserLinksCache();
    await resumePendingTournamentDeletions(readyClient);
    const officialGuildId = getOfficialGuildId();
    if (officialGuildId) {
      // Pending deletions resumed for all guilds
      await reconcileManagedBotState(readyClient, officialGuildId);
    }
  } catch (recErr) {
    console.warn('[MongoDB] ⚠️ Error in startup recovery and reconciliation:', recErr.message);
  }

  // Populate each guild's member cache once, serially, before dashboard refreshes.
  const startupGuilds = [...readyClient.guilds.cache.values()];
  for (let index = 0; index < startupGuilds.length; index++) {
    await refreshGuildMemberCacheOnce(startupGuilds[index]);
    await refreshMemberCountChannel(startupGuilds[index]);
    if (index < startupGuilds.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // Restore each persisted dashboard in place and clean its command channel after every restart.
  for (const guild of readyClient.guilds.cache.values()) {
    const tournaments = guildSettingsCache[guild.id]?.tournaments || {};
    for (const [tournamentId, savedTournament] of Object.entries(tournaments)) {
      if (!savedTournament?.channels?.botCommandsId || ['deletion_pending', 'deleting', 'deleted'].includes(savedTournament.deletionStatus)) continue;
      try {
        const channel = guild.channels.cache.get(savedTournament.channels.botCommandsId) ||
          await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null);
        if (!channel) continue;
        const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
        await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me);
      } catch (dashboardErr) {
        if (dashboardErr?.message?.includes('was not found on the MatchDistrict website')) {
          console.warn(`[Discord Bot] ℹ️ Tournament "${tournamentId}" was not found on the MatchDistrict website (deleted or orphaned). Skipping startup dashboard refresh.`);
        } else {
          console.error(`[Discord Bot] Dashboard startup refresh failed for tournament ${tournamentId}:`, dashboardErr?.message || dashboardErr);
        }
      }
    }
  }
});

// Handle prefix commands and message create logging
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message) return;
    if (message.guild && message.channel?.id) {
      const savedTournaments = guildSettingsCache[message.guild.id]?.tournaments || {};
      const dashboard = Object.values(savedTournaments).find((saved) => saved?.channels?.botCommandsId === message.channel.id);
      const isDashboard = message.id === dashboard?.controlPanelMessageId ||
        (message.author?.bot && message.embeds?.some((embed) => embed.title?.startsWith('🏆 Tournament Control Panel:')));
      if (dashboard && !isDashboard) {
        const commandText = message.content?.trim() || '';
        const withoutPrefix = commandText.startsWith(PREFIX)
          ? commandText.slice(PREFIX.length).trim()
          : commandText.replace(new RegExp(`^<@!?${client.user?.id}>\\s*`), '');
        const dashboardCommand = (commandText.startsWith(PREFIX) || withoutPrefix !== commandText) &&
          ['dash', 'dashboard', 'setup', 'member'].includes(withoutPrefix.split(/\s+/)[0]?.toLowerCase());
        if (dashboardCommand) {
          // Let .dash run; its handler deletes the invocation after access checks.
        } else {
          await message.delete().catch(() => {});
          return;
        }
      }
    }
    if (message.author?.bot) return;

    if (message.guild && await handleRoundRegistrationMessage(message)) return;

    // Run automated moderation (link blocking & abusive words filtering)
    if (message.guild) {
      const moderated = await handleMessageModeration(message);
      if (moderated) return;
    }

    if (message.guild && await handleTournamentVerificationMessage(message)) return;

    const corrId = crypto.randomBytes(4).toString('hex');
    console.log(`[Discord Bot] [corr:${corrId}] 1. Message event received: guildId=${message.guild?.id || 'DM'}, authorId=${message.author?.id}, hasContent=${Boolean(message.content)}`);

    // Check if message is a submission screenshot upload in temporary upload channel/thread
    const handledScreenshot = await handleSubmissionScreenshotUpload(message);
    if (handledScreenshot) return;

    const content = message.content?.trim();

    // Diagnostic notice if message content intent is stripped by Discord Gateway
    if (!content && message.guild) {
      console.warn(`[Discord Bot] [corr:${corrId}] ⚠️ Message received but message.content is empty! Ensure "MESSAGE CONTENT INTENT" is enabled in Discord Developer Portal under Bot -> Privileged Gateway Intents.`);
    }

    // Check if this is a prefix command (supports PREFIX or bot mention)
    let isCommand = false;
    let withoutPrefix = '';

    if (content && content.startsWith(PREFIX)) {
      isCommand = true;
      withoutPrefix = content.slice(PREFIX.length).trim();
    } else if (content && client.user && (content.startsWith(`<@${client.user.id}>`) || content.startsWith(`<@!${client.user.id}>`))) {
      isCommand = true;
      const mentionMatch = content.match(/^<@!?\d+>\s*/);
      withoutPrefix = content.slice(mentionMatch[0].length).trim();
    }

    if (isCommand && withoutPrefix) {
      console.log(`[Discord Bot] [corr:${corrId}] 2. Message recognized as prefix command (prefix: "${PREFIX}")`);

      const args = withoutPrefix.split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();

      console.log(`[Discord Bot] [corr:${corrId}] 3. Command parsed: "${cmd}", argsCount=${args.length}`);

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
      } else if (cmd === 'member') {
        if ((args[0] || '').toLowerCase() === 'count') {
          await handleMemberCountCommand(message.guild, message.member, args.slice(1), (text) => message.reply(text));
        } else {
          await message.reply(`ℹ️ Usage: \`${PREFIX}member count <custom text>\` — Example: \`${PREFIX}member count Our Community\``);
        }
        return;
      } else if (cmd === 'annc') {
        const subCmd = (args[0] || '').toLowerCase();
        if (subCmd === 'setup') {
          await handleAnncSetupCommand(
            message.guild,
            message.member,
            message.channel,
            (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts })
          );
          return;
        }
        await message.reply(`ℹ️ **Usage:** \`${PREFIX}annc setup\` — Setup the announcement DM channel.`);
        return;
      } else if (cmd === 'ticket') {
        const subCmd = (args[0] || '').toLowerCase();
        if (subCmd === 'setup') {
          await handleTicketSetupCommand(
            message.guild,
            message.member,
            message.channel,
            (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts })
          );
          return;
        }
        await message.reply(`ℹ️ **Usage:** \`${PREFIX}ticket setup\` — Setup the support ticket panel.`);
        return;
      } else if (cmd === 'dm') {
        await handleDmCommand(message.guild, message.member, args, (text) => message.reply(text));
        return;
      } else if (cmd === 'ban') {
        await handleBanCommand(message.guild, message.member, args, (text) => message.reply(text));
        return;
      } else if (cmd === 'unmute') {
        await handleUnmuteCommand(
          message.guild,
          message.member,
          message.channel,
          args,
          (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts })
        );
        return;
      } else if (cmd === 'unban') {
        await handleUnbanCommand(
          message.guild,
          message.member,
          message.channel,
          args,
          (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts })
        );
        return;
      } else if (cmd === 'deletemsg' || cmd === 'deletemessage') {
        await handleDeleteManagedMessageCommand(message.guild, message.member, args, (text) => message.reply(text));
        return;
      } else if (cmd === 'organiser' || cmd === 'organizer') {
        try {
          await handleOrganiserCommand(
            message.guild,
            message.member,
            message.channel,
            args,
            async (text, opts) => {
              try {
                if (typeof text === 'object') {
                  return await message.reply(text);
                }
                return await message.reply({ content: text, ...opts });
              } catch (replyErr) {
                return await message.channel.send(typeof text === 'object' ? text : { content: text, ...opts }).catch(() => {});
              }
            },
            message
          );
        } catch (orgErr) {
          console.error(`[Discord Bot] [corr:${corrId}] ❌ Error in handleOrganiserCommand:`, orgErr);
          await message.reply(`❌ **An unexpected error occurred:** ${orgErr.message}`).catch(() => {});
        }
        return;
      } else if (cmd === 'dash' || cmd === 'dashboard') {
        await handleDashCommand(
          message.guild,
          message.member,
          message.channel,
          (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }),
          message
        );
        return;
      } else if (cmd === 'delete') {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'tournament' || sub === 'tournaments') {
          const targetId = args[1];
          await handlePermanentTournamentDeleteCommand(
            message.guild,
            message.member,
            message.channel,
            targetId,
            (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts })
          );
          return;
        }
        await message.reply(`ℹ️ **Usage:** \`${PREFIX}delete tournament <tournament_id>\` — Permanently delete a tournament.`);
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
      } else if (cmd === 'submit') {
        await handleSubmitResultPromptCommand(
          message.guild,
          message.member,
          message.channel,
          (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts })
        );
        return;
      } else if (cmd === 'cred' || cmd === 'credentials' || cmd === 'room') {
        await handlePublishCredentialsCommand(
          message.guild,
          message.member,
          message.channel,
          args,
          (text, opts) => message.reply(typeof text === 'object' ? text : { content: text, ...opts }),
          message
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

    // Check if this is an announcement message in the announcement-dm channel
    if (message.guild) {
      const isAnnouncement = await handleAnnouncementChannelMessage(message);
      if (isAnnouncement) return;
    }

    // If not a command, log regular member messages
    await handleMessageCreateLog(message);
  } catch (error) {
    console.warn('[Discord Bot] ⚠️ Error in MessageCreate handler:', error.message);
  }
});

// Interaction deduplication cache (prevents duplicate execution of identical interaction IDs)
const processedInteractionIds = new Map();

export function checkAndTrackInteraction(interactionId) {
  if (!interactionId) return true;
  const now = Date.now();
  if (processedInteractionIds.size > 1000) {
    for (const [id, ts] of processedInteractionIds.entries()) {
      if (now - ts > 60000) processedInteractionIds.delete(id);
    }
  }
  if (processedInteractionIds.has(interactionId)) {
    return false; // Duplicate interaction event
  }
  processedInteractionIds.set(interactionId, now);
  return true;
}

// Persistent interaction listener (ensures tournament control panel buttons work across bot restarts)
client.on(Events.InteractionCreate, async (interaction) => {
  // Deduplicate rapid double clicks or repeated event deliveries
  if (!checkAndTrackInteraction(interaction.id)) {
    console.log(`[Discord Bot] ⚡ Ignored duplicate interaction ${interaction.id} (${interaction.customId || 'unnamed'})`);
    return;
  }

  // Handle support ticket interactions (select menus & buttons)
  if (interaction.customId?.startsWith('ticket:')) {
    const handled = await handleTicketInteraction(interaction);
    if (handled) return;
  }

  // Handle announcement DM confirmation interactions (Confirm & Cancel)
  if (interaction.customId?.startsWith('annc:')) {
    const handled = await handleAnnouncementInteraction(interaction);
    if (handled) return;
  }

  let dashboardContext = null;
  try {
    const roundAnnouncementModal = interaction.isModalSubmit?.() && (
      interaction.customId?.startsWith('dash:round:announcement-submit:') ||
      interaction.customId?.startsWith('dash:registration-submit:')
    );
    const isUserSelectInteraction = interaction.isUserSelectMenu?.() === true;
    const interactionCustomId = String(interaction.customId || '');
    const isDashboardComponent = (interaction.isButton?.() || isUserSelectInteraction) && interactionCustomId.startsWith('dash:');
    const opensDashboardModal = interaction.isButton?.() && (
      interactionCustomId.startsWith('md_tour_create_round:') ||
      interactionCustomId.startsWith('md_round_edit:') ||
      interactionCustomId.startsWith('dash:round:announcement:') ||
      interactionCustomId.startsWith('dash:add-team-method:open-registration:') ||
      interactionCustomId.startsWith('dash:add-team:group:')
    );

    // Acknowledge before any Mongo lookup or dashboard recovery work. Main actions
    // are delegated to established handlers that use editReply, so acknowledge them
    // as an ephemeral reply. Navigation/select actions edit the dashboard message.
    if (isDashboardComponent && !opensDashboardModal && !interaction.deferred && !interaction.replied) {
      if (interactionCustomId.startsWith('dash:main:')) await interaction.deferReply({ ephemeral: true });
      else await interaction.deferUpdate();
    }
    if ((interaction.isButton?.() || isUserSelectInteraction || roundAnnouncementModal) && interaction.guild && interaction.channelId) {
      const guildId = interaction.guild.id;
      const savedTournaments = guildSettingsCache[guildId]?.tournaments || {};
      let match = Object.entries(savedTournaments).find(([, saved]) => saved?.channels?.botCommandsId === interaction.channelId);
      if (!match) {
        // Mongo is authoritative for dashboard routing; hydrate by stored channel ID if the local cache is stale.
        const persistedTournament = await findTournamentByBotCommandsChannel(guildId, interaction.channelId);
        if (persistedTournament?.tournamentId) {
          guildSettingsCache[guildId] ||= {};
          guildSettingsCache[guildId].tournaments ||= {};
          guildSettingsCache[guildId].tournaments[persistedTournament.tournamentId] = persistedTournament;
          match = [persistedTournament.tournamentId, persistedTournament];
        }
      }
      if (match) {
        dashboardContext = { tournamentId: match[0], savedTournament: match[1] };
        const isButtonInteraction = interaction.isButton?.();
        const isCanonicalDashboard = !isDashboardComponent || interaction.message?.id === match[1]?.controlPanelMessageId;
        if (isDashboardComponent && !isCanonicalDashboard && interaction.message?.id && String(interaction.customId || '').startsWith('dash:')) {
          // The channel is kept to one dashboard message. If Mongo's message ID is stale,
          // adopt the clicked dashboard and route this same interaction instead of consuming a click on refresh.
          match[1].controlPanelMessageId = interaction.message.id;
          guildSettingsCache[interaction.guild.id].tournaments[match[0]] = match[1];
          saveGuildSettings(guildSettingsCache);
          const saved = await saveTournamentToDb(interaction.guild.id, match[0], match[1]);
          if (!saved) console.warn(`[Discord Bot] Could not persist the recovered dashboard message ID for ${match[0]}.`);
        }
      }
    }

    if ((interaction.isButton() || isUserSelectInteraction) && interaction.customId?.startsWith('dash:')) {
      if (interaction.customId?.startsWith('dash:tournament:select:')) {
        await handleTournamentSelectionButton(interaction);
        return;
      }
      const handled = await handleDashboardNavigationInteraction(interaction);
      if (handled) return;
    }
    if (roundAnnouncementModal) {
      const handled = await handleDashboardNavigationInteraction(interaction);
      if (handled) return;
    }
    if (interaction.isButton() && (
      interaction.customId?.startsWith('md_tour_') ||
      interaction.customId?.startsWith('md_round_') ||
      interaction.customId?.startsWith('md_group_') ||
      interaction.customId?.startsWith('md_result_') ||
      interaction.customId?.startsWith('md_qualify_') ||
      interaction.customId === 'md_cancel_qualify'
    )) {
      await handleTournamentButtonInteraction(interaction);
      return;
    }
    if (interaction.isButton() && (
      interaction.customId?.startsWith('md_btn_enter_org_code') ||
      interaction.customId?.startsWith('md_btn_unlink_org') ||
      interaction.customId?.startsWith('md_btn_confirm_unlink_org') ||
      interaction.customId?.startsWith('md_btn_cancel_unlink_org')
    )) {
      await handleOrganiserButtonInteraction(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === 'md_modal_organiser_link') {
      await handleOrganiserModalSubmit(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId?.startsWith('md_modal_')) {
      await handleTournamentModalSubmit(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && (
      interaction.customId?.startsWith('dash:qualify:select:') ||
      interaction.customId?.startsWith('md_tour_') ||
      interaction.customId?.startsWith('md_round_') ||
      interaction.customId?.startsWith('md_group_') ||
      interaction.customId?.startsWith('md_result_') ||
      interaction.customId?.startsWith('md_select_qualify_teams') ||
      interaction.customId === 'md_select_tournament'
    )) {
      if (interaction.customId?.startsWith('dash:qualify:select:')) {
        await handleDashboardQualifySelection(interaction);
        return;
      }
      await handleTournamentSelectMenuInteraction(interaction);
      return;
    }
    if ((interaction.isButton() || isUserSelectInteraction) && dashboardContext) {
      // Unknown or stale dashboard controls recover to the canonical Home screen.
      const backendData = await fetchTournamentRegistrationsFromBackend(dashboardContext.tournamentId);
      await setupTournamentControlPanel(interaction.guild, backendData.tournament, backendData.summary, interaction.guild.members.me);
      if (interaction.deferred && String(interaction.customId || '').startsWith('dash:main:')) {
        await interaction.editReply({ content: 'This dashboard action is no longer available. The dashboard has been refreshed.', components: [] });
      }
      return;
    }
    if ((interaction.isButton() || isUserSelectInteraction) && String(interaction.customId || '').startsWith('dash:')) {
      const missingDashboard = 'The dashboard configuration for this channel could not be found. Use `.dash` to restore it, then try again.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: missingDashboard, components: [] });
      else await interaction.reply({ content: missingDashboard, ephemeral: true });
      return;
    }
  } catch (error) {
    console.error('[Discord Bot] ⚠️ Error in InteractionCreate handler:', error);
    try {
      if (dashboardContext && interaction.guild) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: `❌ **Dashboard interaction failed:** ${error.message}`, ephemeral: true }).catch(() => {});
        }
        try {
          const backendData = await fetchTournamentRegistrationsFromBackend(dashboardContext.tournamentId);
          await setupTournamentControlPanel(interaction.guild, backendData.tournament, backendData.summary, interaction.guild.members.me);
          if (interaction.deferred && String(interaction.customId || '').startsWith('dash:main:')) {
            await interaction.editReply({ content: `❌ Dashboard action failed: ${error.message}. The dashboard was refreshed.`, components: [] }).catch(() => {});
          }
        } catch (refreshError) {
          console.error(`[Discord Bot] Dashboard recovery failed for ${dashboardContext.tournamentId}:`, refreshError);
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `⚠️ Dashboard action failed: ${error.message}. Refresh the dashboard and try again.` }).catch((editError) => {
              console.error('[Discord Bot] Could not report dashboard recovery failure:', editError);
            });
          }
        }
        return;
      }
      if (!interaction.isModalSubmit()) {
        const errorMsg = `❌ **Interaction Error:** ${error.message}`;
        if (interaction.deferred) {
          await interaction.editReply({ content: errorMsg }).catch(() => {});
        } else if (!interaction.replied) {
          await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
        }
      }
    } catch {}
  }
});

// Message edit and delete listeners
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage && newMessage.guild) {
    const moderated = await handleMessageUpdateModeration(oldMessage, newMessage);
    if (moderated) return;
  }
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

// Channel creation and deletion audit listeners
client.on(Events.ChannelCreate, async (channel) => {
  await handleChannelCreateAuditLog(channel);
});

client.on(Events.ChannelDelete, async (channel) => {
  await handleChannelDeleteAuditLog(channel);
});

// Role creation and deletion audit listeners
client.on(Events.GuildRoleCreate, async (role) => {
  await handleRoleCreateAuditLog(role);
});

client.on(Events.GuildRoleDelete, async (role) => {
  await handleRoleDeleteAuditLog(role);
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  await handleRoleUpdateAuditLog(oldRole, newRole);
});

client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  await handleChannelUpdateAuditLog(oldChannel, newChannel);
});

client.on(Events.GuildMemberAdd, updateGuildMemberCache);
client.on(Events.GuildMemberRemove, removeGuildMemberFromCache);
client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => updateGuildMemberCache(newMember));
client.on(Events.GuildMemberAdd, (member) => scheduleMemberCountChannelRefresh(member.guild));
client.on(Events.GuildMemberRemove, (member) => scheduleMemberCountChannelRefresh(member.guild));

client.on(Events.GuildMemberRemove, async (member) => {
  await handleGuildMemberRemove(member);
});

// Member join listener
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleGuildMemberAdd(member);
  } catch (welcErr) {
    console.warn(`[Discord Bot] ⚠️ Error in welcome handler for member ${member?.id}:`, welcErr.message);
  }

  try {
    if (member?.guild && isOfficialGuild(member.guild)) {
      await syncMemberTournamentRoles(member).catch((roleErr) => {
        console.warn(`[Discord Bot] ⚠️ Error syncing roles on join for member ${member?.id}:`, roleErr.message);
      });
      await syncMemberTournamentAccess(member).catch((accessErr) => {
        console.warn(`[Discord Bot] ⚠️ Error syncing access on join for member ${member?.id}:`, accessErr.message);
      });
    }
  } catch (tourErr) {
    console.warn(`[Discord Bot] ⚠️ Error in tournament join handler for member ${member?.id}:`, tourErr.message);
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
    // 1. Connect to MongoDB and synchronize persistent state before starting Gateway
    try {
      const mongoOk = await initMongo();
      if (!mongoOk) throw new Error('MongoDB must be connected before the Discord bot starts.');
      await migrateJsonToMongo(guildSettingsCache);
      const [dbSettings, tournaments] = await Promise.all([
        loadAllGuildSettingsFromDb(),
        loadAllTournamentsFromDb(),
      ]);
      guildSettingsCache = { ...guildSettingsCache, ...dbSettings };
      for (const tournament of tournaments) {
        if (!tournament.guildId || !tournament.tournamentId) continue;
        guildSettingsCache[tournament.guildId] ||= {};
        guildSettingsCache[tournament.guildId].tournaments ||= {};
        guildSettingsCache[tournament.guildId].tournaments[tournament.tournamentId] = tournament;
      }
    } catch (mongoErr) {
      console.error('[MongoDB] ❌ Initialization failed; Discord Gateway startup cancelled:', mongoErr.message);
      throw mongoErr;
    }

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
    stopRoleSyncScheduler();
    if (healthServer) {
      healthServer.close();
    }
    await client.destroy();
    console.log('[Discord Bot] Disconnected from Discord.');
    await closeMongo();
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
