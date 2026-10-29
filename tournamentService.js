import {
  QUEUE_CONFIG,
  enqueueDiscordAction,
  queueChannelCreate,
  queueChannelDelete,
  queueRoleCreate,
  queueRoleDelete,
  queueRoleAdd,
  queueRoleRemove,
  queueChannelSend,
  queueMessageEdit,
  queueMessageDelete,
  queueBulkDelete,
} from './discordQueue.js';
import process from 'node:process';
import crypto from 'crypto';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  isAdmin,
  guildSettingsCache,
  saveGuildSettings,
} from './index.js';
import {
  logRolesGiven,
  logRolesRemoved,
} from './auditLogger.js';
import {
  isMongoConnected,
  getDb,
  ensurePersistenceAvailable,
  upsertManagedMessage,
  upsertManagedMessageBatch,
  deleteManagedMessages,
  saveTournamentToDb,
  deleteTournamentFromDb,
  getTournamentFromDb,
  recordAuditLog,
  enforceSingleActiveRoundInDb,
  findTournamentByBotCommandsChannel,
  purgeAllTournamentDataFromDb,
  getPendingTournamentDeletions,
  saveOrganiserLink,
  getOrganiserLinkForGuild,
  unlinkOrganiserGuild,
  loadAllOrganiserLinksFromDb,
  isGuildLinkedToOrganiser,
} from './mongoService.js';

/** Shared and tournament-specific channels provisioned by Create Channels. */
export const REQUIRED_TOURNAMENT_CHANNELS = [
  {
    key: 'botCommandsId',
    name: 'bot-commands',
    topic: 'Tournament Management & Control Panel (Admin Only)',
    category: 'management',
    participantAccess: 'none',
  },
  {
    key: 'tournamentUpdateId',
    name: 'updates',
    topic: 'Official Announcements & Tournament Updates',
    category: 'public',
    participantAccess: 'read_only',
  },
  {
    key: 'tournamentRoadmapId',
    name: 'roadmap',
    topic: 'Tournament Roadmap',
    category: 'public',
    participantAccess: 'read_only',
  },
  {
    key: 'tournamentScoreboardId',
    name: 'scoreboard',
    topic: 'Tournament Scoreboard',
    category: 'public',
    participantAccess: 'read_only',
  },
  {
    key: 'tournamentHelpdeskId',
    name: 'helpdesk',
    topic: 'Participant Questions & Tournament Support Desk',
    category: 'public',
    participantAccess: 'read_write',
  },
  {
    key: 'tournamentRegisterId',
    name: 'register-here',
    topic: 'Tournament Registration & Official Details Link',
    category: 'public',
    participantAccess: 'read_only',
  },
  {
    key: 'tournamentVerificationId',
    name: 'verification',
    topic: 'Tournament Verification',
    category: 'public',
    participantAccess: 'read_write',
  },
  {
    key: 'tournamentTeamsId',
    name: 'registered-team',
    topic: 'Registered Teams & Tournament Roster (Admin Only)',
    category: 'management',
    participantAccess: 'none',
  },
  {
    key: 'tournamentLogId',
    name: 'tournament-log',
    topic: 'Tournament Management Activity Log',
    category: 'management',
    participantAccess: 'none',
  },
  {
    key: 'specResultId',
    name: 'spec-result',
    topic: 'Tournament Spectator Results',
    category: 'management',
    participantAccess: 'none',
  },
];

async function sendTournamentManagementLog(guild, tournament, round, action, actor, details = []) {
  try {
    const saved = guildSettingsCache[guild.id]?.tournaments?.[tournament?.id || tournament?.tournamentId];
    const channelIds = [...new Set([
      saved?.channels?.tournamentLogId,
      guildSettingsCache[guild.id]?.channels?.tournamentLogId,
    ].filter(Boolean))];
    if (channelIds.length === 0) return;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(action)
      .addFields(
        { name: 'Tournament', value: String(tournament?.title || saved?.tournamentTitle || tournament?.id || 'Unknown'), inline: true },
        { name: 'Round', value: String(round?.name || round?.roundId || 'N/A'), inline: true },
        { name: 'Action by', value: String(actor?.user?.tag || actor?.tag || actor?.id || 'Unknown'), inline: true },
        ...details.filter((field) => field?.value).map((field) => ({ name: field.name, value: String(field.value).slice(0, 1024), inline: false })),
      )
      .setTimestamp();
    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.send) await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.warn('[Discord Bot] Could not send tournament management log:', err.message);
  }
}

/**
 * Concurrency locks for ongoing tournament refreshes/synchronizations.
 * Prevents race conditions from producing duplicate messages or corrupted states.
 * Includes bounded TTL auto-expiration (60s) to prevent permanent locking after failures.
 */
const tournamentOperationLocks = new Map(); // tournamentId -> { timestamp, operationName }
const LOCK_TIMEOUT_MS = 60000;

export function isTournamentLocked(tournamentId) {
  if (!tournamentId) return false;
  const existing = tournamentOperationLocks.get(tournamentId);
  if (!existing) return false;
  if (Date.now() - existing.timestamp > LOCK_TIMEOUT_MS) {
    tournamentOperationLocks.delete(tournamentId);
    return false;
  }
  return true;
}

export async function withTournamentLock(tournamentId, taskFn, operationName = 'task') {
  if (!tournamentId) return taskFn();

  const now = Date.now();
  const existing = tournamentOperationLocks.get(tournamentId);
  if (existing) {
    if (now - existing.timestamp < LOCK_TIMEOUT_MS) {
      throw new Error(`A ${existing.operationName || 'task'} is already running for tournament "${tournamentId}". Please wait a moment.`);
    }
    // Expired lock: auto-evict
    tournamentOperationLocks.delete(tournamentId);
  }

  tournamentOperationLocks.set(tournamentId, { timestamp: now, operationName });
  try {
    return await taskFn();
  } finally {
    tournamentOperationLocks.delete(tournamentId);
  }
}

/**
 * Session storage for tournament listings per guild.
 * Maps guildId -> { lastTournaments: Array<{id, title}>, lastListedTournamentId: string|null, timestamp: number }
 */
export const guildTournamentSessions = new Map();

/**
 * Clean Discord snowflakes (17-20 digit strings)
 */
export function isValidDiscordSnowflake(id) {
  if (typeof id !== 'string') return false;
  return /^\d{17,20}$/.test(id.trim());
}

/**
 * Sanitize channel names according to Discord specifications:
 * Lowercase, alphanumeric and hyphens, 1-100 characters.
 */
export function sanitizeChannelName(name, prefix = '') {
  if (!name || typeof name !== 'string') return `${prefix}channel`;
  const sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const finalName = `${prefix}${sanitized}`.slice(0, 100);
  return finalName || `${prefix}channel`;
}

/**
 * Short prefix builder:
 * If the name has several words, use initials of words and ignore numbers/years (District League 2026 -> DL).
 * If it is a single word, use that word (BGMIS 2026 -> BGMIS).
 */
export function getTournamentShortPrefix(title, fallback = 'tour') {
  if (!title || typeof title !== 'string') return fallback;
  const withoutNumbers = title.replace(/\b\d+\b/g, '').trim();
  const clean = withoutNumbers.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const alphaOnly = title.replace(/[^a-zA-Z0-9]/g, '').trim();
    return alphaOnly ? alphaOnly.toUpperCase() : fallback.toUpperCase();
  }
  if (words.length === 1) {
    return words[0].toUpperCase();
  }
  return words.map((w) => w[0].toUpperCase()).join('');
}

/**
 * Returns primary (<prefix>｜<name>) and fallback (<prefix>-<name>) channel names for Discord text channels.
 */
export function getTournamentChannelNames(prefix, channelName) {
  const p = (prefix || 'tour').toLowerCase();
  const c = (channelName || '').toLowerCase().trim();
  return {
    primary: `${p}｜${c}`,
    fallback: `${p}-${c}`,
  };
}

/**
 * Category name builder using short prefix:
 * e.g. "DL INFO", "DL MANAGEMENT", "DL R1"
 */
export function getTournamentCategoryName(prefix, suffix = 'INFO') {
  const p = (prefix || 'TOUR').toUpperCase().trim();
  const s = (suffix || '').toUpperCase().trim();
  return s ? `${p} ${s}` : p;
}

/**
 * Sanitize category name: 1-100 characters.
 */
export function sanitizeCategoryName(name, suffix = 'INFO') {
  if (!name || typeof name !== 'string') return 'Tournament';
  const prefix = getTournamentShortPrefix(name);
  return getTournamentCategoryName(prefix, suffix);
}

function getTournamentShortName(title, fallback = 'tournament') {
  const withoutYear = String(title || '').replace(/\b(?:19|20)\d{2}\b/g, '').trim();
  return (withoutYear || fallback).slice(0, 80);
}

async function ensureTournamentCategory(guild, savedTournament, key, name, overwrites) {
  let category = savedTournament[key]
    ? guild.channels.cache.get(savedTournament[key]) || await guild.channels.fetch(savedTournament[key]).catch(() => null)
    : null;
  if (!category || category.type !== ChannelType.GuildCategory || (category.guildId || category.guild?.id) !== guild.id) {
    category = null;
  }
  if (!category) {
    category = await queueChannelCreate(guild, { name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
  } else {
    if (category.name !== name && typeof category.setName === 'function') {
      await category.setName(name).catch((err) => console.warn(`[Discord Bot] Could not rename category to ${name}:`, err.message));
    }
    if (typeof category.permissionOverwrites?.set === 'function') {
      await category.permissionOverwrites.set(overwrites).catch((err) => {
        console.warn(`[Discord Bot] Could not update ${name} category permissions:`, err.message);
      });
    }
  }
  savedTournament[key] = category.id;
  return category;
}

async function flattenTournamentCategories(guild, savedTournament, category) {
  if (!guild || !savedTournament || !category) return;
  const legacyIds = new Set([
    ...(savedTournament.legacyCategoryIds || []),
    savedTournament.publicCategoryId,
    savedTournament.managementCategoryId,
    ...Object.values(savedTournament.rounds || {}).map((round) => round?.categoryId),
  ].filter((id) => id && id !== category.id));
  const stillPresent = [];
  const otherTournaments = guildSettingsCache[guild.id]?.tournaments || {};

  for (const legacyId of legacyIds) {
    const shared = Object.entries(otherTournaments).some(([otherId, other]) => otherId !== savedTournament.tournamentId && (
      other?.categoryId === legacyId || other?.publicCategoryId === legacyId || other?.managementCategoryId === legacyId ||
      Object.values(other?.rounds || {}).some((round) => round?.categoryId === legacyId) ||
      (other?.legacyCategoryIds || []).includes(legacyId)
    ));
    if (shared) {
      stillPresent.push(legacyId);
      continue;
    }
    const legacyCategory = guild.channels.cache.get(legacyId) || await guild.channels.fetch(legacyId).catch(() => null);
    if (!legacyCategory || legacyCategory.type !== ChannelType.GuildCategory) continue;
    const children = guild.channels.cache.filter((channel) => channel.parentId === legacyId);
    for (const child of children.values()) {
      try {
        if (typeof child.setParent === 'function') await child.setParent(category.id, { lockPermissions: false });
      } catch (error) {
        console.error(`[Discord Bot] Could not move ${child.name} into tournament category ${category.name}:`, error);
      }
    }
    const remainingChildren = guild.channels.cache.filter((channel) => channel.parentId === legacyId);
    if (remainingChildren.size > 0) {
      stillPresent.push(legacyId);
      continue;
    }
    await legacyCategory.delete('Consolidating tournament channels into the main tournament category').catch((error) => {
      console.warn(`[Discord Bot] Could not remove empty legacy category ${legacyId}:`, error.message);
      stillPresent.push(legacyId);
    });
  }

  savedTournament.categoryId = category.id;
  savedTournament.publicCategoryId = category.id;
  savedTournament.managementCategoryId = category.id;
  for (const round of Object.values(savedTournament.rounds || {})) {
    if (round) round.categoryId = null;
  }
  savedTournament.legacyCategoryIds = [...new Set(stillPresent)];
}


function findInCache(cache, predicate) {
  if (!cache) return null;
  if (typeof cache.find === 'function') {
    return cache.find(predicate) || null;
  }
  if (typeof cache.values === 'function') {
    for (const item of cache.values()) {
      if (predicate(item)) return item;
    }
  }
  return null;
}

async function ensureManagementDashboardRoles(guild, savedTournament, botMember = guild.members.me) {
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
    throw new Error('The bot needs Manage Roles permission to create or assign tournament roles.');
  }
  await guild.roles.fetch().catch((error) => {
    console.warn('[Discord Bot] Could not refresh guild roles before management role assignment:', error.message);
  });
  const resolveRole = async (id) => id
    ? guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null)
    : null;
  let tourneyModRole = await resolveRole(savedTournament.tourneyModRoleId || savedTournament.modsRoleId);
  tourneyModRole ||= findInCache(guild.roles.cache, (role) => role.name.toLowerCase() === 'tourney-mod') || null;
  if (!tourneyModRole) {
    tourneyModRole = await queueRoleCreate(guild, { name: 'Tourney-mod', permissions: [], mentionable: false, reason: 'Tournament management access' });
  } else if (tourneyModRole.name !== 'Tourney-mod') {
    await tourneyModRole.setName('Tourney-mod');
  }

  let spectatorRole = await resolveRole(savedTournament.spectatorRoleId);
  spectatorRole ||= findInCache(guild.roles.cache, (role) => role.name.toLowerCase() === 'spectator') || null;
  if (!spectatorRole) {
    spectatorRole = await queueRoleCreate(guild, { name: 'Spectator', permissions: [], mentionable: false, reason: 'Tournament spectator access' });
  }

  const highestPosition = botMember.roles?.highest?.position;
  for (const role of [tourneyModRole, spectatorRole]) {
    if (typeof role.setPermissions === 'function' && role.permissions?.bitfield != null && BigInt(role.permissions.bitfield) !== 0n) {
      await role.setPermissions([]);
    }
    if (typeof highestPosition === 'number' && typeof role.position === 'number' && role.position >= highestPosition) {
      if (highestPosition <= 1 || typeof role.setPosition !== 'function') {
        throw new Error(`The bot's highest role must be above @${role.name} to assign it.`);
      }
      await role.setPosition(highestPosition - 1);
    }
    if (typeof role.comparePositionTo === 'function' && role.comparePositionTo(botMember.roles.highest) >= 0) {
      throw new Error(`The bot's highest role must be above @${role.name} to assign it.`);
    }
  }

  savedTournament.tourneyModRoleId = tourneyModRole.id;
  savedTournament.modsRoleId = tourneyModRole.id;
  savedTournament.spectatorRoleId = spectatorRole.id;
  await applyManagementRoleChannelAccess(guild, savedTournament, tourneyModRole);
  if (savedTournament.channels?.specResultId) {
    const specResult = guild.channels.cache.get(savedTournament.channels.specResultId) ||
      await guild.channels.fetch(savedTournament.channels.specResultId).catch(() => null);
    if (specResult?.permissionOverwrites?.edit) {
      await specResult.permissionOverwrites.edit(spectatorRole.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      }).catch((err) => console.warn('[Discord Bot] Could not grant Spectator access to #spec-result:', err.message));
    }
  }
  return { tourneyModRole, spectatorRole };
}

async function applyManagementRoleChannelAccess(guild, savedTournament, tourneyModRole) {
  const textPermissions = {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    AddReactions: true,
    AttachFiles: true,
    EmbedLinks: true,
    UseApplicationCommands: true,
    ManageMessages: true,
    ManageThreads: true,
    MentionEveryone: true,
  };
  const channelIds = new Set([
    ...Object.values(savedTournament.channels || {}).filter(Boolean),
    ...Object.values(savedTournament.rounds || {}).flatMap((round) => [
      ...(Array.isArray(round.groups) ? round.groups.flatMap((group) => [group.channelId, group.voiceChannelId]) : []),
      round.categoryId,
    ]).filter(Boolean),
    savedTournament.publicCategoryId,
    savedTournament.managementCategoryId,
  ].filter(Boolean));
  const voiceAllowed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
  const voiceDenied = [...new Set(Object.values(PermissionFlagsBits))].filter((permission) => !voiceAllowed.includes(permission));
  for (const id of channelIds) {
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (!channel?.permissionOverwrites?.edit) continue;
    if (channel.type === ChannelType.GuildVoice) {
      await channel.permissionOverwrites.edit(tourneyModRole.id, { allow: voiceAllowed, deny: voiceDenied }).catch((err) => {
        console.warn(`[Discord Bot] Could not grant Tourney-mod access to ${channel.name}:`, err.message);
      });
    } else if (channel.type === ChannelType.GuildCategory) {
      await channel.permissionOverwrites.edit(tourneyModRole.id, textPermissions).catch((err) => {
        console.warn(`[Discord Bot] Could not grant Tourney-mod access to ${channel.name}:`, err.message);
      });
    } else {
      await channel.permissionOverwrites.edit(tourneyModRole.id, textPermissions).catch((err) => {
        console.warn(`[Discord Bot] Could not grant Tourney-mod access to ${channel.name}:`, err.message);
      });
    }
  }
}

async function buildTournamentChannelStatus(guild, savedTournament, botCommandsChannel) {
  const labels = [
    ['updates', savedTournament.channels?.tournamentUpdateId],
    ['roadmap', savedTournament.channels?.tournamentRoadmapId],
    ['scoreboard', savedTournament.channels?.tournamentScoreboardId],
    ['helpdesk', savedTournament.channels?.tournamentHelpdeskId],
    ['register-here', savedTournament.channels?.tournamentRegisterId],
    ['verification', savedTournament.channels?.tournamentVerificationId],
    ['room-maker-vc', savedTournament.channels?.roomMakerVcId],
    ['registered-team', savedTournament.channels?.tournamentTeamsId],
    ['spec-result', savedTournament.channels?.specResultId],
    ['tournament-log', savedTournament.channels?.tournamentLogId],
  ];
  const ids = [savedTournament.categoryId,
    botCommandsChannel?.id, ...labels.map(([, id]) => id),
    ...(savedTournament.legacyCategoryIds || [])].filter(Boolean);
  await Promise.allSettled(ids.filter((id) => !guild.channels.cache.has(id)).map((id) => guild.channels.fetch(id)));
  const category = guild.channels.cache.get(savedTournament.categoryId);
  const found = labels.filter(([, id]) => id && guild.channels.cache.has(id));
  const legacyCategoryCount = (savedTournament.legacyCategoryIds || []).length;
  const configured = Boolean(category && botCommandsChannel && found.length === labels.length && legacyCategoryCount === 0);
  const statusText = `${configured ? '🟢 **Active**' : found.length === 0 ? '🟡 **Pending Creation**' : '⚠️ **Needs Repair**'}\n` +
    `**Tournament Category:** ${category ? `<#${category.id}>` : 'Missing'} · all tournament and round channels\n` +
    (legacyCategoryCount ? `**Legacy Categories:** ${legacyCategoryCount} still need channel moves\n` : '') +
    `**Channels:** ${botCommandsChannel ? `<#${botCommandsChannel.id}>` : 'bot-commands missing'} · ` +
    labels.map(([name, id]) => id && guild.channels.cache.has(id) ? `<#${id}>` : `\`${name}\` missing`).join(' · ');
  return { isConfigured: configured, activeCount: found.length + Number(Boolean(botCommandsChannel)) + Number(Boolean(category)), statusText };
}

/**
 * Retrieve the official MatchDistrict Discord Guild ID from environment.
 */
export function getOfficialGuildId() {
  const guildId = process.env.MATCHDISTRICT_GUILD_ID;
  if (typeof guildId !== 'string') return '';
  return guildId.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Verify whether the given guild is the official MatchDistrict server.
 */
export function isOfficialGuild(guild) {
  if (!guild || !guild.id) return false;
  const officialId = getOfficialGuildId();
  if (!officialId) return false;
  return guild.id === officialId;
}

/**
 * Checks whether a guild is authorized for tournament management:
 * 1. Official server (MATCHDISTRICT_GUILD_ID), OR
 * 2. An actively linked organiser server (discord_organiser_links in MongoDB / cache).
 *
 * @param {import('discord.js').Guild} guild
 * @returns {boolean}
 */
export function isAuthorizedGuild(guild) {
  if (!guild || !guild.id) return false;
  if (isOfficialGuild(guild)) return true;
  const link = guildSettingsCache[guild.id]?.organiserLink;
  return Boolean(link && link.status === 'linked');
}

/**
 * Server & Administrator Access Guard.
 * Enforces:
 * 1. Must be in a Discord guild (not DM).
 * 2. Member must be an Administrator or have Manage Server permission.
 * 3. Guild must be either the official MatchDistrict server OR linked to a verified organiser.
 */
export function checkTournamentAccess(guild, member) {
  if (!guild) {
    return {
      allowed: false,
      reason: '❌ **Error:** Tournament management commands can only be executed within a Discord server, not in Direct Messages.',
    };
  }

  if (!isAdmin(member)) {
    return {
      allowed: false,
      reason: '🚫 **Permission Denied:** You must be a server Administrator or have `Manage Server` permissions to use tournament management commands.',
    };
  }

  const officialId = getOfficialGuildId();
  const isOfficial = Boolean(officialId && guild.id === officialId);
  const organiserLink = guildSettingsCache[guild.id]?.organiserLink;
  const isOrganiserLinked = Boolean(organiserLink && organiserLink.status === 'linked');

  if (!isOfficial && !isOrganiserLinked) {
    return {
      allowed: false,
      reason: '🚫 **Unlinked Server:** This Discord server is not connected to a MatchDistrict organiser account.\n' +
        'Please run `.organiser` to link this server to your MatchDistrict organiser account.',
    };
  }

  return {
    allowed: true,
    isOfficial,
    isOrganiserLinked,
    organiserId: organiserLink?.organiserId || null,
    organiserName: organiserLink?.organiserName || null,
  };
}

async function loadOrganiserLinkForGuild(guildId) {
  if (!guildId) return null;
  const cachedLink = guildSettingsCache[guildId]?.organiserLink;
  if (cachedLink?.status === 'linked' && cachedLink.organiserId) return cachedLink;
  if (!isMongoConnected()) return cachedLink || null;

  const organiserLink = await getOrganiserLinkForGuild(guildId);
  if (organiserLink?.status === 'linked') {
    guildSettingsCache[guildId] ||= {};
    guildSettingsCache[guildId].organiserLink = organiserLink;
  }
  return organiserLink || cachedLink || null;
}

/**
 * Retrieve the backend API Base URL.
 */
export function getBackendApiUrl() {
  const envUrl = process.env.MATCHDISTRICT_API_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  const port = process.env.PORT || '10000';
  return `http://localhost:${port}`;
}

/**
 * Retrieve the backend Bot Secret.
 */
export function getBackendBotSecret() {
  const secret = process.env.MATCHDISTRICT_BOT_SECRET || process.env.BOT_API_SECRET;
  if (typeof secret !== 'string') return '';
  return secret.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Fetch real tournaments from the MatchDistrict backend.
 */
export async function fetchTournamentsFromBackend(options = {}) {
  const { status = 'published', organizerId = null, apiUrl = getBackendApiUrl(), secret = getBackendBotSecret() } = options;
  let url = `${apiUrl}/api/bot/tournaments?status=${encodeURIComponent(status)}`;
  if (organizerId) {
    url += `&organizer_id=${encodeURIComponent(organizerId)}`;
  }

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'MatchDistrict-Discord-Bot/1.0',
  };
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
    headers['x-bot-secret'] = secret;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (res.status === 401) {
      throw new Error('Backend authorization failed: Invalid or missing bot secret (MATCHDISTRICT_BOT_SECRET).');
    }
    if (!res.ok) {
      throw new Error(`Backend returned HTTP status ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!data || data.success === false) {
      throw new Error(data?.message || data?.error || 'Failed to retrieve tournaments.');
    }

    return Array.isArray(data.tournaments) ? data.tournaments : [];
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Backend request timed out while fetching tournaments (10s limit).');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch registered teams and linked Discord identities for a specific tournament.
 */
export async function fetchTournamentRegistrationsFromBackend(tournamentId, options = {}) {
  if (!tournamentId || typeof tournamentId !== 'string') {
    throw new Error('Invalid tournament ID.');
  }

  const { apiUrl = getBackendApiUrl(), secret = getBackendBotSecret() } = options;
  const url = `${apiUrl}/api/bot/tournaments/${encodeURIComponent(tournamentId.trim())}/registrations`;

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'MatchDistrict-Discord-Bot/1.0',
  };
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
    headers['x-bot-secret'] = secret;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (res.status === 401) {
      throw new Error('Backend authorization failed: Invalid or missing bot secret (MATCHDISTRICT_BOT_SECRET).');
    }
    if (res.status === 404) {
      throw new Error(`Tournament "${tournamentId}" was not found on the MatchDistrict website.`);
    }
    if (!res.ok) {
      throw new Error(`Backend returned HTTP status ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!data || data.success === false) {
      throw new Error(data?.message || data?.error || 'Failed to retrieve tournament registrations.');
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Backend request timed out while fetching registrations (12s limit).');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format pagination-aware tournament listing messages.
 * Splits items so that each message block never exceeds Discord's 2000 character limit.
 */
export function formatTournamentListPages(tournaments, { page = 1, pageSize = 5, showAll = false } = {}) {
  if (!Array.isArray(tournaments) || tournaments.length === 0) {
    return [
      `ℹ️ **No Tournaments Found:** There are currently no active/published tournaments hosted on MatchDistrict.\n` +
      `*(Use \`.list tournament all\` to include draft and archived tournaments)*`,
    ];
  }

  const totalPages = Math.ceil(tournaments.length / pageSize) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = tournaments.slice(startIndex, startIndex + pageSize);

  const header = `🏆 **MatchDistrict Tournaments** (Page **${currentPage}** of **${totalPages}** — **${tournaments.length}** total)\n` +
    `*Filter:* ${showAll ? '`All Statuses (including drafts)`' : '`Published & Active`'}\n\n`;

  const itemsText = pageItems.map((t, idx) => {
    const num = startIndex + idx + 1;
    const title = t.title || 'Untitled Tournament';
    const id = t.id;
    const game = t.game || 'Esports';
    const pubStatus = t.is_draft ? '📝 Draft' : (t.status ? `📢 ${t.status.toUpperCase()}` : '📢 Published');

    let regIndicator = '⚪ Unknown';
    const rStat = (t.registration_status || '').toLowerCase();
    if (rStat === 'open') regIndicator = '🟢 Open';
    else if (rStat === 'full') regIndicator = '🔴 Full';
    else if (rStat === 'closed') regIndicator = '🔒 Closed';
    else if (rStat === 'upcoming') regIndicator = '⏳ Upcoming';

    const slots = `${t.slots_filled || t.registered_teams_count || 0}/${t.slots_total || 'Unlimited'}`;

    return `**${num}. ${title}**\n` +
      `  • **Tournament ID:** \`${id}\`\n` +
      `  • **Game:** ${game}\n` +
      `  • **Publication:** ${pubStatus}\n` +
      `  • **Registration:** ${regIndicator} (${slots} teams/slots)`;
  }).join('\n\n');

  const footer = `\n\n📌 **Next Steps:**\n` +
    `• Select a tournament button below to open its **Control Panel** in \`#bot-commands\`\n` +
    `• Or manage directly: \`.fetch teams <tournament_id>\`\n` +
    (totalPages > 1 ? `• View other pages: \`.list tournament page <1-${totalPages}>\`` : '');

  return [header + itemsText + footer];
}

/**
 * Builds an optional Discord Select Menu for quick tournament selection.
 */
export function buildTournamentSelectMenu(tournaments, maxOptions = 25) {
  if (!Array.isArray(tournaments) || tournaments.length === 0) return null;
  const slice = tournaments.slice(0, maxOptions);

  try {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('md_select_tournament')
      .setPlaceholder('Select a tournament to open its Control Panel in #bot-commands...')
      .addOptions(
        slice.map((t) => {
          const opt = new StringSelectMenuOptionBuilder()
            .setLabel((t.title || t.id).slice(0, 100))
            .setValue(String(t.id).slice(0, 100))
            .setDescription(`${(t.game || 'Esports')} • Reg: ${t.registration_status || 'open'}`.slice(0, 100));
          return opt;
        })
      );
    return new ActionRowBuilder().addComponents(menu);
  } catch {
    return null;
  }
}

function buildTournamentSelectionRows(tournaments) {
  const rows = [];
  for (let i = 0; i < tournaments.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder();
    for (const tournament of tournaments.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder()
        .setCustomId(`dash:tournament:select:${tournament.id}`)
        .setLabel(String(tournament.title || tournament.id).slice(0, 80))
        .setStyle(ButtonStyle.Primary));
    }
    rows.push(row);
  }
  return rows;
}

export async function handleTournamentSelectionButton(interaction) {
  const tournamentId = String(interaction.customId || '').split(':')[3];
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  try {
    const organiserLink = await loadOrganiserLinkForGuild(interaction.guild.id);
    const access = checkTournamentAccess(interaction.guild, interaction.member);
    if (!access.allowed) {
      await interaction.followUp({ content: access.reason, ephemeral: true }).catch(() => {});
      return;
    }
    const organiserId = organiserLink?.organiserId || access.organiserId;
    if (access.isOrganiserLinked && !organiserId) throw new Error('The linked organiser account ID is missing from MongoDB. Re-link this server with its organiser code.');
    const tournaments = await fetchTournamentsFromBackend({ status: 'all', organizerId: organiserId });
    if (!tournaments.some((tournament) => String(tournament.id) === String(tournamentId))) {
      await interaction.editReply({
        content: tournaments.length ? formatTournamentListPages(tournaments, { pageSize: 25, showAll: true })[0] : 'ℹ️ **No Tournaments Found:** MatchDistrict returned an empty tournament list.',
        components: buildTournamentSelectionRows(tournaments),
      });
      return;
    }
    await handleSelectTournamentCommand(interaction.guild, interaction.member, tournamentId, (text) => interaction.editReply({ content: typeof text === 'string' ? text : text.content }));
  } catch (error) {
    console.error('[Discord Bot] Tournament selection failed:', error);
    await interaction.editReply({ content: `❌ **MatchDistrict fetch failed:** ${error.message}`, components: [] }).catch(() => {});
  }
}

/**
 * Verify a registered Discord-linked user from a message in the tournament's verification channel.
 * Verification is persisted locally in Mongo and synced to the website through the bot API.
 */
export async function handleTournamentVerificationMessage(message) {
  if (!message?.guild || !message.channel || message.author?.bot) return false;
  const tournaments = guildSettingsCache[message.guild.id]?.tournaments || {};
  const match = Object.entries(tournaments).find(([, tournament]) =>
    tournament?.channels?.tournamentVerificationId === message.channel.id
  );
  if (!match) return false;

  const [tournamentId, savedTournament] = match;
  try {
    const backend = await fetchTournamentRegistrationsFromBackend(tournamentId);
    const team = (backend.teams || []).find((entry) => {
      const status = String(entry.status || '').toLowerCase();
      if (status !== 'approved') return false;
      return (entry.linked_members || []).some((member) => String(member.discord_id) === String(message.author.id));
    });
    if (!team?.registration_id) {
      await message.reply('This Discord account is not linked to a registered team in this tournament.').catch(() => {});
      return true;
    }

    const candidateIds = [...new Set([...message.mentions.users.values()]
      .filter((user) => user && user.id !== message.author.id && !user.bot)
      .map((user) => user.id))];
    const validIds = [];
    for (const userId of candidateIds) {
      const member = await message.guild.members.fetch({ user: userId, force: true }).catch(() => null);
      if (member && !member.user.bot && userId !== message.author.id) validIds.push(userId);
    }
    if (validIds.length < 3) {
      await message.reply(`Verification needs 3 different real members of this server (excluding you). I found ${validIds.length} valid mention${validIds.length === 1 ? '' : 's'}.`).catch(() => {});
      return true;
    }

    const verifiedAt = new Date().toISOString();
    savedTournament.verifiedRegistrations ||= {};
    savedTournament.verifiedRegistrations[String(team.registration_id)] = {
      registrationId: String(team.registration_id),
      teamId: String(team.id || team.registration_id),
      teamName: team.team_name || 'Registered team',
      discordId: String(message.author.id),
      verifiedAt,
      mentionedMemberIds: validIds.slice(0, 3),
    };
    guildSettingsCache[message.guild.id].tournaments[tournamentId] = savedTournament;
    await saveTournamentToDb(message.guild.id, tournamentId, savedTournament);

    const apiUrl = getBackendApiUrl();
    const secret = getBackendBotSecret();
    const response = await fetch(`${apiUrl}/api/bot/tournaments/${encodeURIComponent(tournamentId)}/registrations/${encodeURIComponent(team.registration_id)}/verification`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}`, 'x-bot-secret': secret } : {}),
      },
      body: JSON.stringify({ discord_id: String(message.author.id) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      throw new Error(result.message || result.error || `Website verification sync failed (HTTP ${response.status}).`);
    }
    await message.reply(`✅ **${team.team_name || 'Your team'} is verified** for ${backend.tournament?.title || savedTournament.tournamentTitle || 'this tournament'}.`).catch(() => {});
  } catch (error) {
    console.error(`[Discord Bot] Verification processing failed for tournament ${tournamentId}, user ${message.author.id}:`, error);
    await message.reply(`Verification could not be completed: ${error.message}`).catch(() => {});
  }
  return true;
}

/**
 * Builds the Tournament Control Panel Discord Embed.
 */
export function buildTournamentControlPanelEmbed(tournament, summary, channelsStatus, roleInfo = null, roundsData = {}) {
  const isConfigured = Boolean(channelsStatus?.isConfigured);
  const statusColor = isConfigured ? 0x22c55e : 0xeab308; // Green or Gold

  const roleValue = roleInfo
    ? `• **Role:** <@&${roleInfo.roleId}> (\`${roleInfo.roleName}\`)\n` +
      `• **Role ID:** \`${roleInfo.roleId}\`\n` +
      `• **Members with Role:** **${roleInfo.membersWithRole ?? 0}**\n` +
      `• **Sync Status:** ${roleInfo.statusText || '🟢 Synchronized'}\n` +
      `• **Last Synced:** ${roleInfo.lastSyncedAt ? `<t:${Math.floor(new Date(roleInfo.lastSyncedAt).getTime() / 1000)}:R>` : 'Never'}`
    : `• **Role:** Ready to provision\n• Click **Sync Tournament Roles** below to assign dedicated role.`;

  const roundsList = Object.values(roundsData || {});
  const roundCount = roundsList.length;
  const activeRounds = roundsList.filter((r) => r.status === 'Active' || r.status === 'Started');
  const draftRounds = roundsList.filter((r) => r.status === 'Draft');
  const completedRounds = roundsList.filter((r) => r.status === 'Completed');
  const activeRound = activeRounds[activeRounds.length - 1] || draftRounds[0] || completedRounds[completedRounds.length - 1] || null;

  let roundStatusText = 'No rounds created';
  let groupSlotStatusText = '• **Group & Slot Status:** No active round started.';

  if (activeRound) {
    const isRoundActive = activeRound.status === 'Active' || activeRound.status === 'Started';
    const statusEmoji = isRoundActive ? '🟢' : (activeRound.status === 'Completed' ? '🏁' : '🟡');
    roundStatusText = `${statusEmoji} **${activeRound.name}** (\`${activeRound.roundId}\`) — **${activeRound.status}**`;

    if (isRoundActive && Array.isArray(activeRound.groups) && activeRound.groups.length > 0) {
      const totalGroups = activeRound.groups.length;
      let totalSlots = 0;
      let occupiedSlots = 0;
      let lockedSlots = 0;
      let unusedSlots = 0;
      let emptySlots = 0;
      for (const g of activeRound.groups) {
        for (const s of g.slots || []) {
          totalSlots++;
          if (s.status === 'LOCKED') lockedSlots++;
          else if (s.status === 'OCCUPIED') occupiedSlots++;
          else if (s.status === 'UNUSED' || s.status === 'RESERVED') unusedSlots++;
          else emptySlots++;
        }
      }
      groupSlotStatusText =
        `• **Active Groups:** **${totalGroups}** (${totalSlots} slots total, 25 slots/group)\n` +
        `• **Group Slot Policy:** 16 teams/group (Slots 01-02 LOCKED, Slots 03-18 Teams, Slots 19-25 UNUSED)\n` +
        `• **Allocation Breakdown:** 🔒 **${lockedSlots}** locked | 🎮 **${occupiedSlots}** occupied | ⚪ **${emptySlots}** empty | ⛔ **${unusedSlots}** unused`;
    } else {
      groupSlotStatusText = `• **Status:** Round configured in **${activeRound.status}** state.\n• Click **View Rounds** below to manage or start rounds.`;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Tournament Control Panel: ${tournament.title}`)
    .setColor(statusColor)
    .setDescription(
      `Welcome to the administration control panel for **${tournament.title}**.\n` +
      `Use the action buttons below to provision participant channels, organize tournament rounds, synchronize live teams, or manage Discord configuration.`
    )
    .addFields(
      {
        name: '🎮 Tournament Details',
        value:
          `• **Name:** **${tournament.title}**\n` +
          `• **Tournament ID:** \`${tournament.id}\`\n` +
          `• **Game:** ${tournament.game || 'Esports'}\n` +
          `• **Tournament Status:** ${tournament.status ? tournament.status.toUpperCase() : 'PUBLISHED'}\n` +
          `• **Registration Window:** ${tournament.registration_status ? tournament.registration_status.toUpperCase() : 'OPEN'}`,
        inline: false,
      },
      {
        name: '🏷️ Tournament Role',
        value: roleValue,
        inline: false,
      },
      {
        name: '👥 Registration Statistics',
        value:
          `• **Total Registered Teams:** **${summary.total_registered_teams}** (` +
          `🟢 **${summary.eligible_teams_count}** eligible, 🔴 **${summary.ineligible_teams_count}** ineligible)\n` +
          `• **Linked Discord Accounts:** **${summary.eligible_linked_members_count}** member(s) verified\n` +
          `• **Unlinked Participants:** **${summary.unlinked_members_count}** account(s) pending Discord link\n` +
          `• **Duplicate Discord IDs:** **${summary.duplicate_discord_ids_count || 0}** safely deduplicated`,
        inline: false,
      },
      {
        name: '⚔️ Round & Group Management',
        value:
          `• **Total Rounds:** **${roundCount}** (` +
          `🟢 **${Math.min(activeRounds.length, 1)}** Active [max 1], ` +
          `🟡 **${draftRounds.length}** Draft, ` +
          `🏁 **${completedRounds.length}** Completed)\n` +
          `• **Current Round:** ${roundStatusText}\n` +
          `${groupSlotStatusText}`,
        inline: false,
      },
      {
        name: '📁 Discord Channels Setup Status',
        value: channelsStatus.statusText,
        inline: false,
      }
    )
    .setFooter({ text: `MatchDistrict Tournament Management • ID: ${tournament.id}` })
    .setTimestamp();

  return embed;
}

/**
 * Builds the Interactive Action Buttons for the Tournament Control Panel.
 * Row 1 (Primary, Synchronization & Management):
 *   - Create Channels (Primary Action)
 *   - Sync & Refresh (Combined Data & Role Sync)
 *   - Round Management (Dedicated round progression screen)
 * Row 2 (Danger Zone):
 *   - Danger Zone (Single red button leading to Danger Zone screen)
 */
export function buildTournamentControlPanelButtons(tournamentId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dash:main:create-channels:${tournamentId}`)
      .setLabel('Create Channels')
      .setEmoji('📁')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dash:main:sync:${tournamentId}`)
      .setLabel('Sync & Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dash:main:refresh:${tournamentId}`)
      .setLabel('Refresh')
      .setEmoji('🔃')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('dash:home:rounds')
      .setLabel('Round Management')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('dash:management-roles:open')
      .setLabel('Management Roles')
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dash:screen:danger:${tournamentId}`)
      .setLabel('Danger Zone')
      .setEmoji('⚠️')
      .setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

export function buildDangerZoneEmbed(tournament) {
  const tourTitle = tournament?.title || tournament?.id || 'Tournament';
  const tourId = tournament?.id || tournament?.tournamentId || 'N/A';
  return new EmbedBuilder()
    .setTitle(`⚠️ Danger Zone · ${tourTitle}`)
    .setColor(0xED4245)
    .setDescription(
      `**Destructive Actions for Tournament:** \`${tourTitle}\` (\`${tourId}\`)\n\n` +
      `Choose an option below with caution:\n\n` +
      `🗑️ **Delete All Channels**\n` +
      `Deletes the tournament Discord category and non-preserved channels while **preserving all MongoDB tournament data**, teams, and results.\n\n` +
      `💣 **Delete Tournament**\n` +
      `Permanently removes the tournament from Discord and backend databases. This action is irreversible.\n\n` +
      `Use **Back** to return to the main Control Panel.`
    )
    .setFooter({ text: `Tournament ID: ${tourId} • MatchDistrict Danger Zone` })
    .setTimestamp();
}

export function buildDangerZoneButtons(tournamentId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dash:danger:delete-channels:${tournamentId}`)
      .setLabel('Delete All Channels')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`dash:danger:delete-tournament:${tournamentId}`)
      .setLabel('Delete Tournament')
      .setEmoji('💣')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`dash:danger:back:${tournamentId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`dash:danger:refresh:${tournamentId}`)
      .setLabel('Refresh')
      .setEmoji('🔃')
      .setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

export async function handleRenderDangerZoneScreen(interaction, tournamentId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  let tournament = null;
  try {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId).catch(() => null);
    tournament = backendData?.tournament;
  } catch {}

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId] || {};
  const tournamentObj = tournament || { id: tournamentId, title: savedTournament.tournamentTitle || tournamentId };

  const embed = buildDangerZoneEmbed(tournamentObj);
  const components = buildDangerZoneButtons(tournamentId);

  const payload = { content: null, embeds: [embed], components };
  if (typeof interaction.editReply === 'function' && (interaction.deferred || interaction.replied)) {
    await interaction.editReply(payload).catch(async () => {
      if (typeof interaction.update === 'function') {
        await interaction.update(payload).catch(() => {});
      }
    });
  } else if (typeof interaction.update === 'function') {
    await interaction.update(payload).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply(payload).catch(() => {});
  }
}

async function updateDashboardNavigation(guild, tournamentId, operation, screen = null) {
  const settings = guildSettingsCache[guild?.id] || {};
  const savedTournament = settings.tournaments?.[tournamentId];
  if (!savedTournament) return;
  const stack = Array.isArray(savedTournament.dashboardNavigationStack) && savedTournament.dashboardNavigationStack.length
    ? [...savedTournament.dashboardNavigationStack]
    : [{ screen: 'home' }];

  if (operation === 'push' && screen) {
    const current = stack[stack.length - 1];
    if (JSON.stringify(current) !== JSON.stringify(screen)) stack.push(screen);
  } else if (operation === 'back' && stack.length > 1) {
    stack.pop();
  } else if (operation === 'home') {
    stack.splice(0, stack.length, { screen: 'home' });
  }

  savedTournament.dashboardNavigationStack = stack;
  settings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = settings;
  saveGuildSettings(guildSettingsCache);
  try { await saveTournamentToDb(guild.id, tournamentId, savedTournament); } catch (error) {
    console.error(`[Discord Bot] Could not persist dashboard navigation for ${tournamentId}:`, error.message);
  }
}

function saveDashboardScreen(guild, tournamentId, savedTournament, screen) {
  const stack = Array.isArray(savedTournament.dashboardNavigationStack) && savedTournament.dashboardNavigationStack.length
    ? [...savedTournament.dashboardNavigationStack]
    : [{ screen: 'home' }];
  stack[stack.length - 1] = screen;
  savedTournament.dashboardNavigationStack = stack;
  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);
}

async function persistManagementRoleState(guildId, tournamentId, savedTournament) {
  const persisted = await saveTournamentToDb(guildId, tournamentId, savedTournament);
  if (!persisted) throw new Error('Could not save the role assignment state to MongoDB. Check the database connection and try again.');
}

async function renderManagementRoleScreen(interaction, savedTournament, errorText = '') {
  const roleLine = (label, id) => `• **${label}:** ${id ? `<@&${id}>` : 'Ready to create'}`;
  const embed = new EmbedBuilder()
    .setTitle(`Management Roles · ${savedTournament.tournamentTitle || 'Tournament'}`)
    .setColor(0x5865f2)
    .setDescription(`${errorText ? `⚠️ ${errorText}\n\n` : ''}${roleLine('Tourney-mod', savedTournament.tourneyModRoleId)}\n${roleLine('Spectator', savedTournament.spectatorRoleId)}`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash:management-roles:give').setLabel('Give Role').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('dash:management-roles:remove').setLabel('Remove Role').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('dash:management-roles:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:management-roles:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row], content: null });
}

async function renderManagementRoleChoiceScreen(interaction, operation, errorText = '') {
  const verb = operation === 'remove' ? 'Remove' : 'Give';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash:management-role-choice:role:tourney-mod').setLabel('Tourney-mod').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dash:management-role-choice:role:spectator').setLabel('Spectator').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dash:management-role-choice:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:management-role-choice:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  const embed = new EmbedBuilder().setTitle(`${verb} a Management Role`).setColor(0x5865f2)
    .setDescription(`${errorText ? `⚠️ ${errorText}\n\n` : ''}Choose **Tourney-mod** or **Spectator** to ${operation === 'remove' ? 'remove from' : 'give to'} selected users.`);
  await interaction.editReply({ embeds: [embed], components: [row], content: null });
}

async function renderManagementUserPicker(interaction, savedTournament, roleKey, errorText = '', operation = 'give') {
  const roleId = roleKey === 'tourney-mod' ? savedTournament.tourneyModRoleId : savedTournament.spectatorRoleId;
  const roleName = roleKey === 'tourney-mod' ? 'Tourney-mod' : 'Spectator';
  const picker = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('dash:management-users:select')
      .setPlaceholder(`Choose users to ${operation === 'remove' ? 'remove' : 'give'} ${roleName}`)
      .setMinValues(1)
      .setMaxValues(25)
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash:management-users:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:management-users:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  const embed = new EmbedBuilder().setTitle(`${operation === 'remove' ? 'Remove' : 'Assign'} ${roleName}`).setColor(0x5865f2)
    .setDescription(`${errorText ? `⚠️ ${errorText}\n\n` : ''}Choose one or more server users to ${operation === 'remove' ? 'remove' : 'give'} <@&${roleId}>.`);
  await interaction.editReply({ embeds: [embed], components: [picker, buttons], content: null });
}

function addLinesAsFields(embed, title, lines, emptyText) {
  const values = lines.length ? lines : [emptyText];
  let chunk = '';
  let part = 1;
  for (const line of values) {
    if (chunk && chunk.length + line.length + 1 > 950) {
      embed.addFields({ name: part === 1 ? title : `${title} (${part})`, value: chunk, inline: false });
      chunk = '';
      part++;
    }
    chunk += `${chunk ? '\n' : ''}${line}`;
  }
  if (chunk) embed.addFields({ name: part === 1 ? title : `${title} (${part})`, value: chunk, inline: false });
}

async function renderManagementAssignmentConfirm(interaction, savedTournament, pending, errorText = '') {
  const roleId = pending.roleKey === 'tourney-mod' ? savedTournament.tourneyModRoleId : savedTournament.spectatorRoleId;
  const roleName = pending.roleKey === 'tourney-mod' ? 'Tourney-mod' : 'Spectator';
  const mentions = (pending.userIds || []).map((id) => `<@${id}>`).join(', ') || 'No users selected';
  const embed = new EmbedBuilder().setTitle('Confirm Role Assignment').setColor(0xeab308)
    .setDescription(`${errorText ? `⚠️ ${errorText}\n\n` : ''}${pending.operation === 'remove' ? 'Remove' : 'Give'} <@&${roleId}> (**${roleName}**) ${pending.operation === 'remove' ? 'from' : 'to'}:\n${mentions}`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash:management-confirm:confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('dash:management-confirm:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:management-confirm:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row], content: null });
}

async function renderManagementAssignmentResult(interaction, result, errorText = '') {
  const verb = result.operation === 'remove' ? 'Removal' : 'Assignment';
  const changed = result.operation === 'remove' ? result.removed || [] : result.assigned || [];
  const embed = new EmbedBuilder().setTitle(`Role ${verb} Result · ${result.roleName}`)
    .setColor(result.failed?.length || !changed.length ? 0xeab308 : 0x22c55e)
    .setDescription(errorText || `Role: ${result.roleId ? `<@&${result.roleId}>` : result.roleName}`);
  addLinesAsFields(embed, result.operation === 'remove' ? 'Removed' : 'Given', changed.map((user) => `<@${user.id}>`), result.operation === 'remove' ? 'No users had the role removed.' : 'No users received the role.');
  addLinesAsFields(embed, result.operation === 'remove' ? 'Did Not Have Role' : 'Already Had Role', (result.alreadyHad || []).map((user) => `<@${user.id}> — ${String(user.reason).slice(0, 120)}`), result.operation === 'remove' ? 'None.' : 'None.');
  addLinesAsFields(embed, 'Failed / Skipped', (result.failed || result.skipped || []).map((user) => `<@${user.id}> — ${String(user.reason).slice(0, 120)}`), 'None.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash:management-result:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:management-result:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row], content: null });
}

async function handleManagementRolesDashboard(interaction, tournamentId, savedTournament, screen, action, roleKey = '') {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const access = checkTournamentAccess(interaction.guild, interaction.member);
  if (!access.allowed) {
    await interaction.editReply({ content: access.reason, embeds: [], components: [] }).catch(() => {});
    return true;
  }
  try {
    if (screen === 'management-roles' && action === 'open') {
      await ensureManagementDashboardRoles(interaction.guild, savedTournament, interaction.guild.members.me);
      savedTournament.dashboardNavigationStack = [{ screen: 'home' }, { screen: 'management-roles' }];
      guildSettingsCache[interaction.guild.id].tournaments[tournamentId] = savedTournament;
      saveGuildSettings(guildSettingsCache);
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      if (savedTournament.pendingManagementRoleAssignment) {
        savedTournament.dashboardNavigationStack.push({ screen: 'management-confirm' });
        saveGuildSettings(guildSettingsCache);
        await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
        await renderManagementAssignmentConfirm(interaction, savedTournament, savedTournament.pendingManagementRoleAssignment);
        return true;
      }
      await renderManagementRoleScreen(interaction, savedTournament);
      return true;
    }
    if (screen === 'management-roles' && action === 'refresh') {
      await ensureManagementDashboardRoles(interaction.guild, savedTournament, interaction.guild.members.me);
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      await renderManagementRoleScreen(interaction, savedTournament);
      return true;
    }
    if (screen === 'management-roles' && ['give', 'remove'].includes(action)) {
      await updateDashboardNavigation(interaction.guild, tournamentId, 'push', { screen: 'management-role-choice', operation: action });
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      await renderManagementRoleChoiceScreen(interaction, action);
      return true;
    }
    if (screen === 'management-roles' && action === 'back') {
      await updateDashboardNavigation(interaction.guild, tournamentId, 'back');
      await handleBackToTournamentPanel(interaction, tournamentId);
      return true;
    }
    if (screen === 'management-role-choice' && action === 'refresh') {
      await renderManagementRoleChoiceScreen(interaction, stackRoleContext(savedTournament).operation || 'give');
      return true;
    }
    if (screen === 'management-role-choice' && action === 'back') {
      await updateDashboardNavigation(interaction.guild, tournamentId, 'back');
      await renderManagementRoleScreen(interaction, savedTournament);
      return true;
    }
    if (screen === 'management-role-choice' && action === 'role' && ['tourney-mod', 'spectator'].includes(roleKey)) {
      await ensureManagementDashboardRoles(interaction.guild, savedTournament, interaction.guild.members.me);
      const operation = stackRoleContext(savedTournament).operation || 'give';
      await updateDashboardNavigation(interaction.guild, tournamentId, 'push', { screen: 'management-users', roleKey, operation });
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      await renderManagementUserPicker(interaction, savedTournament, roleKey, '', operation);
      return true;
    }
    if (screen === 'management-users' && interaction.isUserSelectMenu?.()) {
      const roleContext = stackRoleContext(savedTournament);
      const pending = { roleKey: roleContext.roleKey, operation: roleContext.operation || 'give', userIds: interaction.values || [], createdBy: interaction.user?.id, createdAt: new Date().toISOString() };
      if (!['tourney-mod', 'spectator'].includes(pending.roleKey) || pending.userIds.length === 0) throw new Error('Choose a role and at least one user.');
      savedTournament.pendingManagementRoleAssignment = pending;
      saveDashboardScreen(interaction.guild, tournamentId, savedTournament, { screen: 'management-confirm' });
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      await renderManagementAssignmentConfirm(interaction, savedTournament, pending);
      return true;
    }
    if (screen === 'management-users' && action === 'refresh') {
      const context = stackRoleContext(savedTournament);
      await renderManagementUserPicker(interaction, savedTournament, context.roleKey, '', context.operation || 'give');
      return true;
    }
    if (screen === 'management-users' && action === 'back') {
      await updateDashboardNavigation(interaction.guild, tournamentId, 'back');
      await renderManagementRoleChoiceScreen(interaction, stackRoleContext(savedTournament).operation || 'give');
      return true;
    }
    if (screen === 'management-confirm' && action === 'refresh') {
      const pending = savedTournament.pendingManagementRoleAssignment;
      if (!pending) throw new Error('The pending role assignment could not be found.');
      await renderManagementAssignmentConfirm(interaction, savedTournament, pending);
      return true;
    }
    if (screen === 'management-confirm' && action === 'cancel') {
      savedTournament.pendingManagementRoleAssignment = null;
      savedTournament.dashboardNavigationStack = [{ screen: 'home' }, { screen: 'management-roles' }];
      saveGuildSettings(guildSettingsCache);
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      await renderManagementRoleScreen(interaction, savedTournament);
      return true;
    }
    if (screen === 'management-confirm' && action === 'confirm') {
      const pending = savedTournament.pendingManagementRoleAssignment;
      if (!pending || !['tourney-mod', 'spectator'].includes(pending.roleKey)) throw new Error('The pending role assignment could not be found. Please choose the users again.');
      let roles;
      try {
        roles = await ensureManagementDashboardRoles(interaction.guild, savedTournament, interaction.guild.members.me);
      } catch (roleSetupError) {
        console.error(`[Discord Bot] Could not prepare management role for ${tournamentId}:`, roleSetupError);
        const roleName = pending.roleKey === 'tourney-mod' ? 'Tourney-mod' : 'Spectator';
        const roleId = pending.roleKey === 'tourney-mod' ? savedTournament.tourneyModRoleId : savedTournament.spectatorRoleId;
        const failedResult = {
          roleKey: pending.roleKey,
          operation: pending.operation === 'remove' ? 'remove' : 'give',
          roleName,
          roleId: roleId || null,
          assigned: [], removed: [], alreadyHad: [],
          failed: [...new Set(pending.userIds)].map((id) => ({ id, reason: roleSetupError.message })),
          completedAt: new Date().toISOString(),
        };
        savedTournament.lastManagementRoleAssignment = failedResult;
        savedTournament.pendingManagementRoleAssignment = null;
        saveDashboardScreen(interaction.guild, tournamentId, savedTournament, { screen: 'management-result' });
        await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
        await renderManagementAssignmentResult(interaction, failedResult);
        return true;
      }
      const role = pending.roleKey === 'tourney-mod' ? roles.tourneyModRole : roles.spectatorRole;
      const result = { roleKey: pending.roleKey, operation: pending.operation === 'remove' ? 'remove' : 'give', roleName: role.name, roleId: role.id, assigned: [], removed: [], alreadyHad: [], failed: [], completedAt: new Date().toISOString() };
      for (const userId of [...new Set(pending.userIds)]) {
        try {
          const member = await interaction.guild.members.fetch({ user: userId, force: true });
          if (!member) {
            result.failed.push({ id: userId, reason: 'User is not in this server.' });
            continue;
          }
          const hasRole = member.roles.cache.has(role.id);
          if (result.operation === 'remove') {
            if (!hasRole) {
              result.alreadyHad.push({ id: userId, reason: `User does not have ${role.name}.` });
              continue;
            }
            await member.roles.remove(role, `Removed ${role.name} from tournament dashboard by ${interaction.user?.tag || interaction.user?.id || 'administrator'}`);
            result.removed.push({ id: userId });
          } else {
            if (hasRole) {
              result.alreadyHad.push({ id: userId, reason: `User already has ${role.name}.` });
              continue;
            }
            await member.roles.add(role, `Assigned ${role.name} from tournament dashboard by ${interaction.user?.tag || interaction.user?.id || 'administrator'}`);
            result.assigned.push({ id: userId });
          }
        } catch (err) {
          result.failed.push({ id: userId, reason: err.code === 10007 ? 'User is not in this server.' : `Role ${result.operation === 'remove' ? 'removal' : 'assignment'} failed: ${err.message}` });
          console.warn(`[Discord Bot] Could not ${result.operation === 'remove' ? 'remove' : 'assign'} ${role.name} ${result.operation === 'remove' ? 'from' : 'to'} ${userId}:`, err.message);
        }
      }
      savedTournament.lastManagementRoleAssignment = result;
      savedTournament.pendingManagementRoleAssignment = null;
      saveDashboardScreen(interaction.guild, tournamentId, savedTournament, { screen: 'management-result' });
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      if (result.operation === 'give' && result.assigned.length > 0) {
        await sendTournamentManagementLog(interaction.guild, savedTournament, null, 'Management role given', interaction.member, [
          { name: 'Role given', value: `<@&${role.id}>` },
          { name: 'Users who received it', value: result.assigned.map((user) => `<@${user.id}>`).join(', ') },
        ]);
      }
      await renderManagementAssignmentResult(interaction, result);
      return true;
    }
    if (screen === 'management-result' && action === 'refresh') {
      const result = savedTournament.lastManagementRoleAssignment;
      if (!result) throw new Error('No role assignment result is available.');
      await renderManagementAssignmentResult(interaction, result);
      return true;
    }
    if (screen === 'management-result' && action === 'back') {
      savedTournament.dashboardNavigationStack = [{ screen: 'home' }, { screen: 'management-roles' }];
      saveGuildSettings(guildSettingsCache);
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);
      await renderManagementRoleScreen(interaction, savedTournament);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[Discord Bot] Management role dashboard failed for ${tournamentId}:`, err);
    if (err.message?.startsWith('Could not save the role assignment state to MongoDB')) {
      const pending = savedTournament.pendingManagementRoleAssignment;
      if (pending) {
        savedTournament.pendingManagementRoleAssignment = null;
        saveDashboardScreen(interaction.guild, tournamentId, savedTournament, { screen: 'management-users', roleKey: pending.roleKey, operation: pending.operation });
        await renderManagementUserPicker(interaction, savedTournament, pending.roleKey, err.message, pending.operation).catch(() => {});
        return true;
      }
    }
    const currentScreen = savedTournament.dashboardNavigationStack?.at(-1)?.screen || screen;
    if (currentScreen === 'management-confirm' && savedTournament.pendingManagementRoleAssignment) {
      await renderManagementAssignmentConfirm(interaction, savedTournament, savedTournament.pendingManagementRoleAssignment, err.message).catch(() => {});
    } else if (currentScreen === 'management-users') {
      const context = stackRoleContext(savedTournament);
      await renderManagementUserPicker(interaction, savedTournament, context.roleKey, err.message, context.operation || 'give').catch(() => {});
    } else if (currentScreen === 'management-role-choice') {
      await renderManagementRoleChoiceScreen(interaction, stackRoleContext(savedTournament).operation || 'give', err.message).catch(() => {});
    } else {
      await renderManagementRoleScreen(interaction, savedTournament, err.message).catch(() => {});
    }
    return true;
  }
}

function stackRoleContext(savedTournament) {
  const stack = savedTournament.dashboardNavigationStack || [];
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index]?.roleKey || stack[index]?.operation) {
      return { roleKey: stack[index].roleKey || '', operation: stack[index].operation || '' };
    }
  }
  return { roleKey: '', operation: '' };
}

export async function handleDashboardNavigationInteraction(interaction) {
  const idParts = String(interaction.customId || '').split(':');
  const [namespace, screen, action] = idParts;
  if (namespace !== 'dash') return false;
  const settings = guildSettingsCache[interaction.guild.id] || {};
  let match = Object.entries(settings.tournaments || {}).find(([, saved]) => saved?.channels?.botCommandsId === interaction.channelId);
  let tournamentId = null;
  let savedTournament = null;
  if (match) {
    [tournamentId, savedTournament] = match;
  } else {
    const candidateId = idParts.find((p) => settings.tournaments?.[p]);
    if (candidateId) {
      tournamentId = candidateId;
      savedTournament = settings.tournaments[candidateId];
    }
  }
  if (!tournamentId || !savedTournament) return false;
  const stack = Array.isArray(savedTournament.dashboardNavigationStack) && savedTournament.dashboardNavigationStack.length
    ? savedTournament.dashboardNavigationStack
    : [{ screen: 'home' }];

  if ((screen === 'screen' && action === 'danger') || (screen === 'home' && action === 'danger') || (screen === 'danger' && action === 'open')) {
    updateDashboardNavigation(interaction.guild, tournamentId, 'push', { screen: 'danger' });
    await handleRenderDangerZoneScreen(interaction, tournamentId);
    return true;
  }

  if (screen === 'danger') {
    if (action === 'delete-channels') {
      await handleTournamentButtonInteraction(interaction, `md_tour_delete_channels:${tournamentId}`);
      return true;
    }
    if (action === 'delete-tournament') {
      await handleTournamentButtonInteraction(interaction, `md_tour_delete_permanent:${tournamentId}`);
      return true;
    }
    if (action === 'back') {
      updateDashboardNavigation(interaction.guild, tournamentId, 'home');
      await handleBackToTournamentPanel(interaction, tournamentId);
      return true;
    }
    if (action === 'refresh') {
      await handleRenderDangerZoneScreen(interaction, tournamentId);
      return true;
    }
  }

  if (screen?.startsWith('management-roles') || screen?.startsWith('management-role-choice') || screen?.startsWith('management-users') ||
      screen?.startsWith('management-confirm') || screen?.startsWith('management-result')) {
    return await handleManagementRolesDashboard(interaction, tournamentId, savedTournament, screen, action, idParts[3] || '');
  }

  if (screen === 'qualify') {
    const roundId = idParts[3];
    const groupId = idParts[4];
    if (action === 'group') {
      updateDashboardNavigation(interaction.guild, tournamentId, 'push', { screen: 'qualify-group', roundId, groupId });
      await handleDashboardQualifyGroup(interaction, tournamentId, roundId, groupId);
      return true;
    }
    if (action === 'groups' || action === 'refresh_groups') {
      if (action === 'groups') updateDashboardNavigation(interaction.guild, tournamentId, 'back');
      await handleRoundQualifyGroupSelection(interaction, tournamentId, roundId);
      return true;
    }
    if (action === 'refresh') {
      await handleDashboardQualifyGroup(interaction, tournamentId, roundId, groupId);
      return true;
    }
    if (action === 'home') {
      updateDashboardNavigation(interaction.guild, tournamentId, 'home');
      await handleBackToTournamentPanel(interaction, tournamentId);
      return true;
    }
  }

  if (screen === 'main') {
    const actionMap = {
      'create-channels': 'create_channels',
      sync: 'sync_refresh',
      refresh: 'refresh',
      'delete-channels': 'delete_channels',
      'confirm-delete-channels': 'confirm_delete',
      'cancel-delete-channels': 'cancel_delete',
      'delete-tournament': 'delete_permanent',
      'confirm-delete-tournament': 'confirm_delete_permanent',
      'cancel-delete-tournament': 'cancel_delete_permanent',
    };
    const mappedAction = actionMap[action];
    if (!mappedAction) return false;
    await handleTournamentButtonInteraction(interaction, `md_tour_${mappedAction}:${tournamentId}`);
    return true;
  }

  if (screen === 'home' && action === 'rounds') {
    updateDashboardNavigation(interaction.guild, tournamentId, 'push', { screen: 'rounds' });
    await handleViewRoundsScreen(interaction, tournamentId);
    return true;
  }
  if (screen === 'home' && action === 'refresh') {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    await setupTournamentControlPanel(interaction.guild, backendData.tournament, backendData.summary, interaction.guild.members.me);
    return true;
  }
  if (screen === 'rounds' && action === 'refresh') {
    await handleViewRoundsScreen(interaction, tournamentId);
    return true;
  }
  if (screen === 'rounds' && action === 'back') {
    updateDashboardNavigation(interaction.guild, tournamentId, 'home');
    await handleBackToTournamentPanel(interaction, tournamentId);
    return true;
  }
  if (screen === 'round' && action === 'refresh') {
    const current = stack[stack.length - 1];
    if (current?.screen === 'round' && current.roundId) {
      await handleOpenIndividualRoundMenu(interaction, tournamentId, current.roundId);
    } else {
      updateDashboardNavigation(interaction.guild, tournamentId, 'home');
      await handleBackToTournamentPanel(interaction, tournamentId);
    }
    return true;
  }
  if (screen === 'round' && action === 'submit-results') {
    await handleToggleRoundGroupMessages(interaction, tournamentId, idParts[3]);
    return true;
  }
  if (screen === 'round' && action === 'announcement') {
    const roundId = idParts[3];
    const round = savedTournament.rounds?.[roundId];
    if (!round) {
      await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, `❌ Round \`${roundId}\` was not found.`);
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`dash:round:announcement-submit:${roundId}`)
      .setTitle(`Announce to ${round.name}`)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('announcement_text')
          .setLabel('Announcement message')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800)
      ));
    await interaction.showModal(modal);
    return true;
  }
  if (screen === 'round' && action === 'announcement-submit') {
    await handleRoundAnnouncementSubmit(interaction, tournamentId, idParts[3]);
    return true;
  }
  if (screen === 'round' && action === 'back') {
    updateDashboardNavigation(interaction.guild, tournamentId, 'back');
    const prior = savedTournament.dashboardNavigationStack?.at(-1);
    if (prior?.screen === 'rounds') await handleViewRoundsScreen(interaction, tournamentId);
    else {
      updateDashboardNavigation(interaction.guild, tournamentId, 'home');
      await handleBackToTournamentPanel(interaction, tournamentId);
    }
    return true;
  }
  if (screen === 'round' && action === 'home') {
    updateDashboardNavigation(interaction.guild, tournamentId, 'home');
    await handleBackToTournamentPanel(interaction, tournamentId);
    return true;
  }
  return false;
}

/**
 * Formats the registered teams list to be published into the shared #tournament-teams channel.
 */
export function formatTeamsChannelRoster(tournament, teams = []) {
  const eligibleTeams = teams.filter((t) => t.is_eligible);
  if (eligibleTeams.length === 0) {
    return [
      `📋 **Tournament Registered Teams** — **${tournament.title}** (ID: \`${tournament.id}\`)\n\n` +
      `*No confirmed or approved teams have been registered yet.*`,
    ];
  }

  const chunks = [];
  let currentChunk = `📋 **Tournament Registered Teams** — **${tournament.title}** (ID: \`${tournament.id}\`)\n` +
    `• **Total Confirmed Teams:** **${eligibleTeams.length}**\n` +
    `• **Last Updated:** <t:${Math.floor(Date.now() / 1000)}:R>\n` +
    `────────────────────────────────────────\n\n`;

  for (let i = 0; i < eligibleTeams.length; i++) {
    const team = eligibleTeams[i];
    const leaderMention = team.leader?.discord_id ? `<@${team.leader.discord_id}>` : (team.captain || 'Leader');
    let teamText = `**${i + 1}. ${team.team_name}**\n` +
      `  • **Captain:** ${leaderMention}\n`;

    if (Array.isArray(team.members) && team.members.length > 0) {
      const memberList = team.members.map((m) => {
        if (m.discord_id) return `<@${m.discord_id}>`;
        return m.name || 'Member';
      }).join(', ');
      teamText += `  • **Roster:** ${memberList}\n`;
    }
    teamText += '\n';

    if (currentChunk.length + teamText.length > 1950) {
      chunks.push(currentChunk);
      currentChunk = teamText;
    } else {
      currentChunk += teamText;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Formats the official tournament registration link message.
 */
export function formatRegistrationMessage(tournament, directUrl) {
  return `🔗 **Official Tournament Registration & Details**\n\n` +
    `• **Tournament:** **${tournament.title || tournament.id}**\n` +
    `• **Game:** ${tournament.game || 'Esports'}\n` +
    `• **Direct Details & Registration Page:**\n` +
    `👉 <${directUrl}>\n\n` +
    `*All team registrations, player brackets, and official updates are hosted securely on MatchDistrict.*`;
}

/**
 * Updates the shared #tournament-teams channel messages in place.
 * Reuses and edits existing messages, handles pagination, and prevents duplicate messages across refreshes and restarts.
 */
export async function updateTeamsRosterMessages(guild, tournament, teams, teamsChannel, savedTournament) {
  if (!teamsChannel || typeof teamsChannel.send !== 'function') return false;

  const rosterChunks = formatTeamsChannelRoster(tournament, teams);
  const logicalKeyPrefix = `guild:${guild.id}:tournament:${savedTournament.tournamentId}:teams_roster`;
  const pagesPayloads = rosterChunks.map((chunk) => (typeof chunk === 'string' ? { content: chunk } : chunk));

  try {
    const updatedIds = await upsertManagedMessageBatch(guild.client, {
      guildId: guild.id,
      channelId: teamsChannel.id,
      channel: teamsChannel,
      logicalKeyPrefix,
      messageType: 'teams_roster',
      tournamentId: savedTournament.tournamentId,
      pagesPayloads,
    });

    savedTournament.teamListMessageIds = updatedIds;
    savedTournament.teamListMessageId = updatedIds[0] || null;
    return true;
  } catch (upsertErr) {
    console.warn('[Discord Bot] ⚠️ Error in upsertManagedMessageBatch for teams roster:', upsertErr.message);

    let existingIds = Array.isArray(savedTournament.teamListMessageIds)
      ? [...savedTournament.teamListMessageIds]
      : (savedTournament.teamListMessageId ? [savedTournament.teamListMessageId] : []);

    const updatedIds = [];

    for (let i = 0; i < rosterChunks.length; i++) {
      const chunk = rosterChunks[i];
      const existingId = existingIds[i];
      let msg = null;

      if (existingId && typeof teamsChannel.messages?.fetch === 'function') {
        try {
          msg = await teamsChannel.messages.fetch(existingId).catch(() => null);
        } catch {
          msg = null;
        }
      }

      if (msg && typeof msg.edit === 'function') {
        try {
          await msg.edit(chunk);
          updatedIds.push(msg.id);
        } catch (err) {
          if (err.code === 10008 || String(err.message).includes('Unknown Message')) {
            msg = null;
          } else {
            throw err;
          }
        }
      }

      if (!msg) {
        const newMsg = await teamsChannel.send(chunk);
        updatedIds.push(newMsg.id);
      }
    }

    if (existingIds.length > rosterChunks.length && typeof teamsChannel.messages?.fetch === 'function') {
      for (let j = rosterChunks.length; j < existingIds.length; j++) {
        const surplusId = existingIds[j];
        try {
          const surplusMsg = await teamsChannel.messages.fetch(surplusId).catch(() => null);
          if (surplusMsg && typeof surplusMsg.delete === 'function') {
            await surplusMsg.delete().catch(() => {});
          }
        } catch {}
      }
    }

    savedTournament.teamListMessageIds = updatedIds;
    savedTournament.teamListMessageId = updatedIds[0] || null;
    return true;
  }
}

/**
 * Updates the official tournament registration link message in #tournament-register in place.
 */
export async function updateRegistrationLinkMessage(guild, tournament, registerChannel, savedTournament) {
  if (!registerChannel || typeof registerChannel.send !== 'function') return false;

  const websiteBaseUrl = (process.env.MATCHDISTRICT_WEBSITE_URL || process.env.MATCHDISTRICT_API_URL || 'https://matchdistrict.in').replace(/\/+$/, '');
  const directUrl = tournament.url || `${websiteBaseUrl}/tournaments/${tournament.id}`;
  const regContent = formatRegistrationMessage(tournament, directUrl);

  const logicalKey = `guild:${guild.id}:tournament:${savedTournament.tournamentId}:registration_link`;

  try {
    const result = await upsertManagedMessage(guild.client, {
      guildId: guild.id,
      channelId: registerChannel.id,
      channel: registerChannel,
      logicalKey,
      messageType: 'registration_link',
      tournamentId: savedTournament.tournamentId,
      payload: { content: regContent },
      extraMetadata: { tournamentTitle: tournament.title },
    });

    savedTournament.registrationMessageId = result.messageId;
    return true;
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in upsertManagedMessage for registration link:', err.message);

    let regMsg = null;
    const existingId = savedTournament.registrationMessageId;

    if (existingId && typeof registerChannel.messages?.fetch === 'function') {
      try {
        regMsg = await registerChannel.messages.fetch(existingId).catch(() => null);
      } catch {
        regMsg = null;
      }
    }

    if (regMsg && typeof regMsg.edit === 'function') {
      try {
        await regMsg.edit(regContent);
        savedTournament.registrationMessageId = regMsg.id;
        return true;
      } catch (editErr) {
        if (editErr.code !== 10008 && !String(editErr.message).includes('Unknown Message')) {
          throw editErr;
        }
      }
    }

    const newMsg = await registerChannel.send(regContent);
    savedTournament.registrationMessageId = newMsg.id;
    return true;
  }
}

/**
 * Normalizes a tournament name into a valid Discord role name:
 * Lowercase, remove spaces and unsupported characters (only [a-z0-9]).
 * For example: "BGIS 2026" -> "bgis2026".
 */
export function normalizeTournamentRoleName(title, tournamentId = '') {
  if (typeof title !== 'string') title = '';
  let normalized = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) {
    normalized = `tour${String(tournamentId).replace(/[^a-z0-9]/g, '') || 'role'}`;
  }
  return normalized.slice(0, 100);
}

/**
 * Creates or reuses a dedicated tournament role in the guild.
 * Maps roleId, roleName to guild settings and avoids creating duplicates.
 */
export async function getOrCreateTournamentRole(guild, tournament) {
  if (!guild || !tournament) return null;
  const tournamentId = tournament.id;
  const currentSettings = guildSettingsCache[guild.id] || {};
  if (!currentSettings.tournaments) {
    currentSettings.tournaments = {};
  }
  const savedTournament = currentSettings.tournaments[tournamentId] || {
    tournamentId,
    tournamentTitle: tournament.title,
    guildId: guild.id,
    categoryId: null,
    channels: {},
    allEligibleMemberIds: [],
    setupStatus: 'pending_channels',
  };

  const expectedRoleName = normalizeTournamentRoleName(tournament.title, tournamentId);

  // 1. Try to find existing role by stored roleId
  let role = null;
  if (savedTournament.roleId && guild.roles) {
    role = guild.roles.cache?.get(savedTournament.roleId) ||
      await guild.roles.fetch?.(savedTournament.roleId).catch(() => null);
    if (!role) {
      console.warn(`[Discord Bot] ⚠️ Mapped tournament role with ID "${savedTournament.roleId}" for "${tournament.title}" was not found or was deleted from server. Triggering safe role recreation.`);
    }
  }

  // 2. Fallback: match by normalized name if roleId wasn't stored or role was deleted
  if (!role && guild.roles?.cache) {
    role = Array.from(guild.roles.cache.values()).find(
      (r) => r.name.toLowerCase() === expectedRoleName.toLowerCase()
    );
  }

  // 3. Create role if not found (strictly no admin permissions)
  if (!role && typeof guild.roles?.create === 'function') {
    role = await queueRoleCreate(guild, {
      name: expectedRoleName,
      permissions: [],
      mentionable: true,
      reason: `Tournament role for ${tournament.title} (ID: ${tournamentId})`,
    });
  }

  if (role) {
    const botMember = guild.members?.me || (guild.members?.cache ? guild.members.cache.get(guild.client?.user?.id) : null);
    if (botMember?.permissions?.has && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error(`Cannot manage @${role.name}: the bot needs the Manage Roles permission.`);
    }
    if (botMember?.roles?.highest && role.position >= botMember.roles.highest.position) {
      const targetPosition = Math.max(1, botMember.roles.highest.position - 1);
      try {
        await role.setPosition(targetPosition, { reason: `Place ${role.name} below the bot's highest role for tournament member sync` });
        role = guild.roles.cache.get(role.id) || role;
      } catch (err) {
        throw new Error(`Cannot manage @${role.name}: its position is not below the bot's highest role and could not be moved (${err.message}).`);
      }
    }

    // Security check: ensure tournament role strictly avoids granting Administrator permission
    if (role.permissions?.has && role.permissions.has(PermissionFlagsBits.Administrator)) {
      console.warn(`[Discord Bot] 🚨 Security Warning: Tournament role @${role.name} has Administrator permission. Removing elevated permissions.`);
      if (typeof role.setPermissions === 'function') {
        await role.setPermissions([], 'Enforce unprivileged tournament role').catch(() => {});
      }
    }

    savedTournament.roleId = role.id;
    savedTournament.roleName = role.name;
    currentSettings.tournaments[tournamentId] = savedTournament;
    guildSettingsCache[guild.id] = currentSettings;
    saveGuildSettings(guildSettingsCache);
  }

  return role;
}

/**
 * Reusable role-synchronization service for a tournament.
 * Synchronizes dedicated tournament role assignment across eligible members in the official server.
 * Assigns role to newly eligible registered members, removes from ineligible/cancelled members,
 * skips unlinked or missing server members, and tracks stats.
 */
export async function syncTournamentRoles(guild, tournamentId, preloadedData = null) {
  if (!guild) throw new Error('A Discord server is required to synchronize tournament roles.');

  let tournament = preloadedData?.tournament;
  let teams = preloadedData?.teams;

  if (!tournament || !teams) {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    tournament = tournament || backendData?.tournament;
    teams = teams || backendData?.teams || [];
  }

  if (!tournament) {
    throw new Error(`No tournament metadata found for ID "${tournamentId}".`);
  }

  let role;
  try {
    role = await getOrCreateTournamentRole(guild, tournament);
  } catch (err) {
    const failedSettings = guildSettingsCache[guild.id] || {};
    const failedTournament = failedSettings.tournaments?.[tournamentId] || { tournamentId, guildId: guild.id, tournamentTitle: tournament.title };
    failedTournament.roleLastSyncedAt = new Date().toISOString();
    failedTournament.roleSyncStats = { status: 'failed', error: err.message, assigned: 0, removed: 0, skipped: 0, failed: 1, membersWithRole: 0 };
    failedSettings.tournaments ||= {};
    failedSettings.tournaments[tournamentId] = failedTournament;
    guildSettingsCache[guild.id] = failedSettings;
    saveGuildSettings(guildSettingsCache);
    await saveTournamentToDb(guild.id, tournamentId, failedTournament);
    console.error(`[Discord Bot] Tournament role setup failed for ${tournament.title}:`, err);
    throw err;
  }
  if (!role) {
    throw new Error(`Failed to create or resolve tournament role for "${tournament.title}".`);
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  if (!currentSettings.tournaments) currentSettings.tournaments = {};
  const savedTournament = currentSettings.tournaments[tournamentId] || {
    tournamentId,
    tournamentTitle: tournament.title,
    guildId: guild.id,
    channels: {},
    allEligibleMemberIds: [],
    setupStatus: 'pending_channels',
  };

  // Extract eligible linked Discord IDs (deduplicated)
  const currentEligibleDiscordIds = new Set();
  const eligibleTeams = (teams || []).filter((t) => t.is_eligible);

  for (const team of eligibleTeams) {
    if (Array.isArray(team.linked_members)) {
      for (const m of team.linked_members) {
        if (m.discord_id && isValidDiscordSnowflake(m.discord_id)) {
          currentEligibleDiscordIds.add(m.discord_id);
        }
      }
    }
  }

  const newlyAssignedMembers = [];
  const newlyRemovedMembers = [];
  const failureReasons = [];

  const stats = {
    assigned: 0,
    alreadyAssigned: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    roleId: role.id,
    roleName: role.name,
    totalEligible: currentEligibleDiscordIds.size,
    membersWithRole: 0,
    status: 'syncing',
    error: null,
  };

  // Check bot permissions and hierarchy
  const botMember = guild.members?.me || (guild.members?.cache ? guild.members.cache.get(guild.client?.user?.id) : null);
  const botHasManageRoles = Boolean(botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles));
  let memberFetchError = null;
  if (!botHasManageRoles) {
    memberFetchError = 'The bot is missing the Manage Roles permission.';
    console.error(`[Discord Bot] Tournament role sync failed for ${tournament.title}: ${memberFetchError}`);
  } else if (botMember?.roles?.highest && role.position >= botMember.roles.highest.position) {
    memberFetchError = `Tournament role @${role.name} is not below the bot's highest role.`;
    console.error(`[Discord Bot] Tournament role sync failed for ${tournament.title}: ${memberFetchError}`);
  }

  // Pre-fetch all guild members once and reuse across role assignment, revocation, and counting
  let cachedMembers = guild.members?.cache || null;
  if (typeof guild.members?.fetch === 'function') {
    try {
      const fetched = await guild.members.fetch().catch(() => null);
      if (fetched) cachedMembers = fetched;
    } catch {}
  }

  // Assign role to eligible members in guild
  for (const discordId of botHasManageRoles && !memberFetchError ? currentEligibleDiscordIds : []) {
    let member = cachedMembers?.get?.(discordId) || (guild.members?.cache?.get?.(discordId)) || null;
    if (!member && typeof guild.members?.fetch === 'function') {
      try {
        member = await guild.members.fetch(discordId);
      } catch (err) {
        if (err.code === 10007 || err.code === 10013) {
          stats.skipped++;
          console.log(`[Discord Bot] Skipping tournament role for ${discordId}: member is not in guild ${guild.id}.`);
          continue;
        }
        stats.failed++;
        failureReasons.push(`Fetch ${discordId}: ${err.message}`);
        console.warn(`[Discord Bot] Could not fetch registered Discord member ${discordId} for ${tournament.title}:`, err.message);
        continue;
      }
    }

    if (!member) {
      stats.skipped++;
      continue;
    }

    if (member.roles?.cache?.has(role.id)) {
      stats.alreadyAssigned++;
    } else if (typeof member.roles?.add === 'function') {
      if (botMember?.roles?.highest && typeof botMember.roles.highest.comparePositionTo === 'function') {
        if (botMember.roles.highest.comparePositionTo(role) <= 0) {
          stats.failed++;
          failureReasons.push(`Assign ${discordId}: bot role hierarchy is too low.`);
          console.warn(`[Discord Bot] ⚠️ Cannot assign role @${role.name} to member ${discordId}: Bot's highest role is not positioned higher than @${role.name} in role hierarchy.`);
          continue;
        }
      }
      try {
        await queueRoleAdd(member, role.id, `Eligible tournament registration for ${tournament.title}`);
        stats.assigned++;
        newlyAssignedMembers.push(member);
      } catch (err) {
        stats.failed++;
        failureReasons.push(`Assign ${discordId}: ${err.message}`);
        console.warn(`[Discord Bot] Failed to assign role ${role.name} to member ${discordId}:`, err.message);
      }
    }
  }

  // Revoke role from members no longer eligible/registered for this tournament
  if (botHasManageRoles && !memberFetchError) {
    try {
      const memberList = Array.from((cachedMembers?.values?.() || guild.members?.cache?.values?.() || []));
      for (const member of memberList) {
        if (member.roles?.cache?.has(role.id) && !currentEligibleDiscordIds.has(member.id)) {
          if (typeof member.roles?.remove === 'function') {
            if (botMember?.roles?.highest && typeof botMember.roles.highest.comparePositionTo === 'function') {
              if (botMember.roles.highest.comparePositionTo(role) <= 0) {
                stats.failed++;
                failureReasons.push(`Remove ${member.id}: bot role hierarchy is too low.`);
                continue;
              }
            }
            try {
              await queueRoleRemove(member, role.id, `Registration cancelled or ineligible for ${tournament.title}`);
              stats.removed++;
              newlyRemovedMembers.push(member);
            } catch (err) {
              stats.failed++;
              failureReasons.push(`Remove ${member.id}: ${err.message}`);
              console.warn(`[Discord Bot] Failed to remove role ${role.name} from member ${member.id}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      stats.failed++;
      memberFetchError = `Could not fetch guild members to remove stale role assignments: ${err.message}`;
      failureReasons.push(memberFetchError);
      console.error(`[Discord Bot] ${memberFetchError}`);
    }
  }

  // Count members holding role
  let membersWithRoleCount = 0;
  try {
    const memberList = Array.from((cachedMembers?.values?.() || guild.members?.cache?.values?.() || []));
    membersWithRoleCount = memberList.filter((m) => m.roles?.cache?.has(role.id)).length;
  } catch (err) {
    stats.failed++;
    memberFetchError ||= `Could not count members holding the role: ${err.message}`;
    failureReasons.push(memberFetchError);
    console.error(`[Discord Bot] ${memberFetchError}`);
  }
  stats.membersWithRole = membersWithRoleCount;
  stats.status = stats.failed > 0 || Boolean(memberFetchError) ? 'failed' : 'successful';
  stats.error = memberFetchError || (failureReasons.length ? failureReasons.slice(0, 5).join(' ') : null);

  // Persist role sync state
  savedTournament.roleId = role.id;
  savedTournament.roleName = role.name;
  savedTournament.roleSyncStats = stats;
  savedTournament.roleLastSyncedAt = new Date().toISOString();
  savedTournament.allEligibleMemberIds = Array.from(currentEligibleDiscordIds);

  currentSettings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  const saved = await saveTournamentToDb(guild.id, tournamentId, savedTournament);
  if (!saved) {
    stats.status = 'failed';
    stats.error = 'Role sync results could not be saved to MongoDB.';
    savedTournament.roleSyncStats = stats;
    console.error(`[Discord Bot] ${stats.error} for tournament ${tournamentId}.`);
  }

  // Dispatch unified audit logs
  if (newlyAssignedMembers.length > 0) {
    await logRolesGiven(guild, role, newlyAssignedMembers, null, `${tournament.title} Registration Sync`).catch(() => {});
  }
  if (newlyRemovedMembers.length > 0) {
    await logRolesRemoved(guild, role, newlyRemovedMembers, null, `${tournament.title} Ineligible / Cancelled`).catch(() => {});
  }
  await recordAuditLog(guild.id, 'ROLES_SYNCED', {
    tournamentId,
    tournamentTitle: tournament.title,
    roleId: role.id,
    roleName: role.name,
    assigned: stats.assigned,
    removed: stats.removed,
    membersWithRole: stats.membersWithRole,
  }).catch(() => {});

  return stats;
}

/**
 * Retry constants & bounded persistent retry queue for member tournament role synchronization.
 */
export const MAX_ROLE_SYNC_RETRIES = 3;
export const ROLE_SYNC_RETRY_INTERVAL_MS = 5000;

export function enqueueRoleSyncRetry(guildId, discordId, errorMessage = '') {
  if (!guildId || !discordId) return false;
  const currentSettings = guildSettingsCache[guildId] || {};
  if (!Array.isArray(currentSettings.pendingRoleSync)) {
    currentSettings.pendingRoleSync = [];
  }

  const existingIdx = currentSettings.pendingRoleSync.findIndex((item) => item.discordId === discordId);
  const now = Date.now();

  if (existingIdx >= 0) {
    const existing = currentSettings.pendingRoleSync[existingIdx];
    if (existing.attempts >= MAX_ROLE_SYNC_RETRIES) {
      console.warn(`[Discord Bot] ⚠️ Member ${discordId} already reached max retry attempts (${MAX_ROLE_SYNC_RETRIES}). Skipping enqueue.`);
      return false;
    }
    existing.attempts += 1;
    existing.lastError = errorMessage;
    existing.nextRetryTimestamp = now + (existing.attempts * ROLE_SYNC_RETRY_INTERVAL_MS);
    currentSettings.pendingRoleSync[existingIdx] = existing;
  } else {
    currentSettings.pendingRoleSync.push({
      discordId,
      attempts: 1,
      nextRetryTimestamp: now + ROLE_SYNC_RETRY_INTERVAL_MS,
      lastError: errorMessage,
      createdAt: new Date().toISOString(),
    });
  }

  guildSettingsCache[guildId] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  return true;
}

export function removeRoleSyncRetry(guildId, discordId) {
  if (!guildId || !discordId) return;
  const currentSettings = guildSettingsCache[guildId];
  if (!currentSettings || !Array.isArray(currentSettings.pendingRoleSync)) return;

  const initialLen = currentSettings.pendingRoleSync.length;
  currentSettings.pendingRoleSync = currentSettings.pendingRoleSync.filter((item) => item.discordId !== discordId);
  if (currentSettings.pendingRoleSync.length !== initialLen) {
    saveGuildSettings(guildSettingsCache);
  }
}

export async function processPendingRoleSyncQueue(guild) {
  if (!guild || !isOfficialGuild(guild)) return { processed: 0, succeeded: 0, dropped: 0 };
  const currentSettings = guildSettingsCache[guild.id];
  if (!currentSettings || !Array.isArray(currentSettings.pendingRoleSync) || currentSettings.pendingRoleSync.length === 0) {
    return { processed: 0, succeeded: 0, dropped: 0 };
  }

  const now = Date.now();
  const queue = [...currentSettings.pendingRoleSync];
  let processed = 0;
  let succeeded = 0;
  let dropped = 0;

  for (const item of queue) {
    if (item.nextRetryTimestamp > now) {
      continue;
    }
    processed++;

    let member = null;
    try {
      member = guild.members.cache?.get(item.discordId) ||
        await guild.members.fetch?.(item.discordId).catch(() => null);
    } catch {
      member = null;
    }

    if (!member) {
      // Member is no longer in the guild, drop from queue
      removeRoleSyncRetry(guild.id, item.discordId);
      dropped++;
      continue;
    }

    const syncRes = await syncMemberTournamentRoles(member);
    if (syncRes.success) {
      succeeded++;
      removeRoleSyncRetry(guild.id, item.discordId);
      console.log(`[Discord Bot] ✅ Successfully resolved tournament roles on retry for member ${item.discordId}`);
    } else {
      if (item.attempts >= MAX_ROLE_SYNC_RETRIES) {
        removeRoleSyncRetry(guild.id, item.discordId);
        dropped++;
        console.warn(`[Discord Bot] ❌ Dropping member ${item.discordId} from role sync queue: reached max attempts (${MAX_ROLE_SYNC_RETRIES}).`);
      }
    }
  }

  return { processed, succeeded, dropped };
}

/**
 * Synchronizes applicable tournament roles for a single member across all eligible tournaments.
 * Runs on guildMemberAdd and on post-link webhooks.
 * Strictly verifies official server and verified linked Discord user ID.
 */
export async function syncMemberTournamentRoles(member) {
  if (!member || !member.guild || !isOfficialGuild(member.guild)) {
    return { success: false, reason: 'unauthorized_guild' };
  }
  const discordId = member.id;
  if (!isValidDiscordSnowflake(discordId)) {
    return { success: false, reason: 'invalid_snowflake' };
  }

  try {
    const backendData = await fetchUserEligibleTournamentsFromBackend(discordId);
    if (!backendData || !Array.isArray(backendData.eligible_tournaments)) {
      removeRoleSyncRetry(member.guild.id, discordId);
      return { success: true, assignedCount: 0, alreadyAssignedCount: 0, removedCount: 0, reason: 'no_eligible_tournaments' };
    }

    const currentSettings = guildSettingsCache[member.guild.id] || {};
    const trackedTournaments = currentSettings.tournaments || {};
    const eligibleTourIds = new Set(backendData.eligible_tournaments.map((t) => t.id));

    let assignedCount = 0;
    let alreadyAssignedCount = 0;
    let removedCount = 0;
    let skippedCount = 0;

    const botMember = member.guild.members?.me || (member.guild.members?.cache ? member.guild.members.cache.get(member.guild.client?.user?.id) : null);
    const botHasManageRoles = !botMember?.permissions || (typeof botMember.permissions.has === 'function' ? botMember.permissions.has(PermissionFlagsBits.ManageRoles) : true);

    // 1. Assign roles for eligible active tournaments
    for (const tour of backendData.eligible_tournaments) {
      const saved = trackedTournaments[tour.id];
      if (!saved || saved.setupStatus === 'deleted') continue;

      const role = await getOrCreateTournamentRole(member.guild, tour);
      if (!role) {
        skippedCount++;
        continue;
      }

      // Check if member already has role (idempotent, avoids redundant Discord API calls)
      if (member.roles?.cache?.has(role.id)) {
        alreadyAssignedCount++;
        continue;
      }

      // Check bot permissions
      if (!botHasManageRoles) {
        skippedCount++;
        console.warn(`[Discord Bot] ⚠️ Cannot assign role @${role.name} to member ${member.id}: Bot lacks 'Manage Roles' permission.`);
        continue;
      }

      // Check role hierarchy
      if (botMember?.roles?.highest && typeof botMember.roles.highest.comparePositionTo === 'function') {
        const comparison = botMember.roles.highest.comparePositionTo(role);
        if (comparison <= 0) {
          skippedCount++;
          console.warn(`[Discord Bot] ⚠️ Cannot assign role @${role.name} to member ${member.id}: Bot's highest role is not positioned higher than @${role.name} in role hierarchy.`);
          continue;
        }
      }

      if (typeof member.roles?.add === 'function') {
        try {
          await member.roles.add(role.id, `Eligible registration for tournament ${tour.title}`);
          assignedCount++;
          console.log(`[Discord Bot] 🏷️ Assigned tournament role @${role.name} to ${member.user?.tag || member.id} for "${tour.title}"`);
        } catch (err) {
          skippedCount++;
          console.warn(`[Discord Bot] Failed to assign role ${role.name} to member ${member.id}:`, err.message);
        }
      }
    }

    // 2. Revoke roles for active tournaments where user is no longer eligible
    for (const [tourId, saved] of Object.entries(trackedTournaments)) {
      if (!saved || saved.setupStatus === 'deleted' || !saved.roleId) continue;
      if (!eligibleTourIds.has(tourId)) {
        if (member.roles?.cache?.has(saved.roleId) && typeof member.roles?.remove === 'function') {
          if (botHasManageRoles) {
            const roleObj = member.guild.roles?.cache?.get(saved.roleId);
            if (!roleObj || !botMember?.roles?.highest || typeof botMember.roles.highest.comparePositionTo !== 'function' || botMember.roles.highest.comparePositionTo(roleObj) > 0) {
              try {
                await member.roles.remove(saved.roleId, 'Member no longer eligible for tournament');
                removedCount++;
                console.log(`[Discord Bot] 🏷️ Removed tournament role @${saved.roleName} from ${member.user?.tag || member.id}`);
              } catch (err) {
                console.warn(`[Discord Bot] Failed to remove role ${saved.roleName} from member ${member.id}:`, err.message);
              }
            }
          }
        }
      }
    }

    // Successful sync: clear retry state for member
    removeRoleSyncRetry(member.guild.id, discordId);

    return { success: true, assignedCount, alreadyAssignedCount, removedCount, skippedCount };
  } catch (err) {
    console.warn(`[Discord Bot] Failed to sync tournament roles for member ${discordId}:`, err.message);
    const queued = enqueueRoleSyncRetry(member.guild.id, discordId, err.message);
    return { success: false, queuedForRetry: queued, error: err.message };
  }
}

/**
 * Reconciles roles across all tracked tournaments in the official server.
 */
export async function reconcileAllTournamentRoles(guild) {
  if (!guild || !isOfficialGuild(guild)) {
    return { synchronizedRoles: 0, failures: [] };
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const trackedTournaments = currentSettings.tournaments || {};
  const results = {
    synchronizedRoles: 0,
    failures: [],
  };

  for (const [tournamentId, saved] of Object.entries(trackedTournaments)) {
    if (!saved || saved.setupStatus === 'deleted') continue;

    try {
      await withTournamentLock(tournamentId, async () => {
        await syncTournamentRoles(guild, tournamentId);
        results.synchronizedRoles++;
      });
    } catch (err) {
      results.failures.push(`Role sync error for ${tournamentId}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Handles the administrator-only `.sync roles [tournament_id]` command.
 */
export async function handleSyncRolesCommand(guild, member, args = [], replyFn, messageChannel = null) {
  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await replyFn(access.reason);
    return;
  }

  let tournamentId = args[0] ? args[0].trim() : null;

  // Context resolution: auto-detect tournament if run inside #bot-commands
  if (!tournamentId && messageChannel) {
    const currentSettings = guildSettingsCache[guild.id] || {};
    const tournaments = currentSettings.tournaments || {};
    for (const [id, data] of Object.entries(tournaments)) {
      if (data.channels?.botCommandsId === messageChannel.id || data.categoryId === messageChannel.parentId) {
        tournamentId = id;
        break;
      }
    }
  }

  if (!tournamentId) {
    await replyFn(
      `⚠️ **Missing Tournament ID:**\n` +
      `Please provide a tournament ID or run this command inside a tournament's **#bot-commands** channel:\n` +
      `> \`.sync roles <tournament_id>\`\n\n` +
      `*(Run \`.list tournament\` first to see available tournaments)*`
    );
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await replyFn(
      '❌ **Missing Bot Permissions:** The bot requires the **Manage Roles** permission in this server to create and assign tournament roles.'
    );
    return;
  }

  try {
    const stats = await syncTournamentRoles(guild, tournamentId);
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId).catch(() => null);
    if (backendData?.tournament && backendData?.summary) {
      await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, botMember).catch(() => {});
    }

    const roleMention = stats.roleId ? `<@&${stats.roleId}>` : `\`${stats.roleName}\``;
    await replyFn(
      `✅ **Tournament Roles Synchronized:**\n` +
      `• **Tournament ID:** \`${tournamentId}\`\n` +
      `• **Dedicated Role:** ${roleMention} (\`${stats.roleName}\` | ID: \`${stats.roleId}\`)\n` +
      `• **Roles Assigned:** **${stats.assigned}** new participant(s)\n` +
      `• **Already Assigned:** **${stats.alreadyAssigned}** member(s)\n` +
      `• **Roles Removed (Ineligible):** **${stats.removed}** member(s)\n` +
      `• **Skipped (Not in Server / Unlinked):** **${stats.skipped}** account(s)\n` +
      `• **Total Members Holding Role:** **${stats.membersWithRole}** member(s)`
    );
  } catch (err) {
    await replyFn(`❌ **Role Synchronization Failed for Tournament \`${tournamentId}\`:**\n> ${err.message}`);
  }
}

/**
 * Keeps exactly one message in #bot-commands: the canonical dashboard.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').TextChannel} botCommandsChannel
 * @param {string} tournamentId
 * @param {string} activeDashboardMessageId
 */
export async function cleanupBotCommandsClutter(guild, botCommandsChannel, tournamentId, activeDashboardMessageId, activeSubmissionMessageId = null) {
  if (!botCommandsChannel || typeof botCommandsChannel.messages?.fetch !== 'function') return;

  try {
    let before;
    let hasMore = true;
    while (hasMore) {
      const fetched = await botCommandsChannel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!fetched?.size) break;
      for (const msg of fetched.values()) {
        if (msg.id !== activeDashboardMessageId) await msg.delete().catch(() => {});
      }
      before = fetched.last()?.id;
      hasMore = fetched.size === 100 && Boolean(before);
    }

    // Mark every other managed message record for this channel as deleted.
    if (isMongoConnected() && activeDashboardMessageId) {
      const db = getDb();
      if (db) {
        const msgCol = db.collection('discord_managed_messages');
        await msgCol.updateMany(
          {
            guildId: guild.id,
            channelId: botCommandsChannel.id,
            messageId: { $ne: activeDashboardMessageId },
            status: 'active',
          },
          {
            $set: {
              status: 'deleted',
              deletedAt: new Date(),
            },
          }
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[Discord Bot] ⚠️ Error in cleanupBotCommandsClutter for ${tournamentId}:`, err.message);
  }
}

/**
 * Sets up or refreshes the Tournament Control Panel inside #bot-commands.
 */
export async function setupTournamentControlPanel(guild, tournament, summary, botMember) {
  const tournamentId = tournament.id;
  if (!guild || !tournamentId) throw new Error('Cannot build the tournament dashboard without a guild and tournament ID.');
  if (!botMember && typeof guild.members?.fetchMe === 'function') {
    botMember = await guild.members.fetchMe().catch((err) => {
      throw new Error(`Could not fetch the bot's guild member: ${err.message}`);
    });
  }
  if (!botMember?.id) throw new Error('Cannot build the tournament dashboard because the bot is not available as a guild member.');
  const currentSettings = guildSettingsCache[guild.id] || {};
  if (!currentSettings.tournaments) {
    currentSettings.tournaments = {};
  }
  const savedTournament = currentSettings.tournaments[tournamentId] || {
    tournamentId,
    tournamentTitle: tournament.title,
    guildId: guild.id,
    categoryId: null,
    channels: {},
    allEligibleMemberIds: [],
    setupStatus: 'pending_channels',
    controlPanelMessageId: null,
  };

  if (!savedTournament.channels) {
    savedTournament.channels = {};
  }
  if (!Array.isArray(savedTournament.dashboardNavigationStack) || savedTournament.dashboardNavigationStack.length === 0) {
    savedTournament.dashboardNavigationStack = [{ screen: 'home' }];
  }
  const persistSetupProgress = async () => {
    savedTournament.tournamentId = tournamentId;
    savedTournament.tournamentTitle = tournament.title;
    savedTournament.guildId = guild.id;
    if (summary && typeof summary === 'object' && summary.total_registered_teams !== undefined) {
      savedTournament.dashboardLastSummary = summary;
      savedTournament.dashboardLastTournament = {
        id: tournament.id,
        title: tournament.title,
        game: tournament.game || null,
        status: tournament.status || null,
        registration_status: tournament.registration_status || null,
      };
    }
    currentSettings.tournaments[tournamentId] = savedTournament;
    guildSettingsCache[guild.id] = currentSettings;
    saveGuildSettings(guildSettingsCache);
    if (!(await saveTournamentToDb(guild.id, tournamentId, savedTournament))) {
      console.warn(`[Discord Bot] MongoDB did not confirm dashboard setup progress for ${tournamentId}.`);
    }
  };

  // Ensure tournament role exists or is fetched
  let role = null;
  const previousRoleId = savedTournament.roleId || null;
  try {
    role = await getOrCreateTournamentRole(guild, tournament);
  } catch (err) {
    console.warn('[Discord Bot] Role creation error in control panel setup:', err.message);
  }
  let managementRole = null;
  try {
    ({ tourneyModRole: managementRole } = await ensureManagementDashboardRoles(guild, savedTournament, botMember));
  } catch (roleSetupError) {
    console.error(`[Discord Bot] Could not fully prepare management roles for dashboard ${tournamentId}:`, roleSetupError);
    const savedRoleId = savedTournament.tourneyModRoleId || savedTournament.modsRoleId;
    managementRole = (savedRoleId && (guild.roles.cache.get(savedRoleId) || await guild.roles.fetch(savedRoleId).catch(() => null))) ||
      findInCache(guild.roles.cache, (candidate) => candidate.name.toLowerCase() === 'tourney-mod') || null;
    if (!managementRole) {
      throw new Error(`Dashboard setup cannot continue because the Tourney-mod role is unavailable: ${roleSetupError.message}`);
    }
  }
  await persistSetupProgress();

  if (role && (!savedTournament.roleLastSyncedAt || previousRoleId !== role.id)) {
    try {
      await syncTournamentRoles(guild, tournamentId);
    } catch (err) {
      console.error(`[Discord Bot] Initial tournament role sync failed for ${tournamentId}:`, err.message);
    }
  }

  let membersWithRoleCount = 0;
  if (role) {
    const members = await guild.members.fetch().catch((err) => {
      console.warn(`[Discord Bot] Could not refresh member count for tournament role ${role.name}:`, err.message);
      return null;
    });
    if (members) membersWithRoleCount = Array.from(members.values()).filter((member) => member.roles?.cache?.has(role.id)).length;
  }

  const roleStats = savedTournament.roleSyncStats || {};
  const roleInfo = role ? {
    roleId: role.id,
    roleName: role.name,
    membersWithRole: membersWithRoleCount,
    statusText: roleStats.status === 'failed'
      ? `🔴 Failed: ${roleStats.error || 'See bot logs for details.'}`
      : savedTournament.roleLastSyncedAt && roleStats.status === 'successful'
        ? `🟢 Synchronized (${roleStats.assigned ?? 0} assigned, ${roleStats.removed ?? 0} removed, ${roleStats.skipped ?? 0} skipped)`
      : '🟡 Pending Sync',
    lastSyncedAt: savedTournament.roleLastSyncedAt || null,
  } : null;

  // Pre-fetch all channels to ensure full API cache across bot restarts
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }

  // A tournament has one category. Adopt an existing saved category before creating
  // anything so `.dash` can recover without producing a duplicate category.
  const tournamentShort = getTournamentShortName(tournament.title, tournament.id);
  const categoryName = sanitizeCategoryName(tournament.title || tournament.id);
  const savedCategoryIds = [
    savedTournament.categoryId,
    savedTournament.publicCategoryId,
    savedTournament.managementCategoryId,
    ...Object.values(savedTournament.rounds || {}).map((round) => round?.categoryId),
  ].filter(Boolean);
  let category = null;
  for (const categoryId of savedCategoryIds) {
    category = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(() => null);
    if (category?.type === ChannelType.GuildCategory && (category.guildId || category.guild?.id) === guild.id) break;
    category = null;
  }

  const categoryOverwrites = [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: managementRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
    { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
  ];
  if (category) {
    if (category.name !== categoryName) await category.setName(categoryName).catch((err) => console.warn(`[Discord Bot] Could not rename tournament category: ${err.message}`));
    await category.permissionOverwrites?.set?.(categoryOverwrites).catch((err) => {
      console.warn(`[Discord Bot] Could not update tournament category permissions: ${err.message}`);
    });
  } else {
    category = await queueChannelCreate(guild, { name: categoryName, type: ChannelType.GuildCategory, permissionOverwrites: categoryOverwrites });
  }
  savedTournament.categoryId = category.id;
  await flattenTournamentCategories(guild, savedTournament, category);
  const knownTournamentChannelIds = new Set([
    ...Object.values(savedTournament.channels || {}),
    ...Object.values(savedTournament.rounds || {}).flatMap((round) => (round.groups || []).flatMap((group) => [group.channelId, group.voiceChannelId])),
  ].filter(Boolean));
  for (const channelId of knownTournamentChannelIds) {
    const knownChannel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!knownChannel || knownChannel.type === ChannelType.GuildCategory || knownChannel.parentId === category.id) continue;
    if (typeof knownChannel.setParent === 'function') await knownChannel.setParent(category.id, { lockPermissions: false }).catch((moveError) => {
      console.error(`[Discord Bot] Could not move stored channel ${channelId} into tournament category ${category.id}:`, moveError);
    });
  }
  const spectatorRole = savedTournament.spectatorRoleId
    ? guild.roles.cache.get(savedTournament.spectatorRoleId) || await guild.roles.fetch(savedTournament.spectatorRoleId).catch(() => null)
    : null;
  const botChannelOverwrite = {
    id: botMember.id,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks],
  };
  for (const [channelKey, channelId] of Object.entries(savedTournament.channels || {})) {
    if (!channelId || !['botCommandsId', 'tournamentLogId', 'tournamentTeamsId', 'specResultId'].includes(channelKey)) continue;
    const privateChannel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!privateChannel?.permissionOverwrites?.set) continue;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: managementRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
      ...(channelKey === 'specResultId' && spectatorRole ? [{
        id: spectatorRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
      }] : []),
      botChannelOverwrite,
    ];
    await privateChannel.permissionOverwrites.set(overwrites).catch((permissionError) => {
      console.error(`[Discord Bot] Could not preserve private access on ${privateChannel.name}:`, permissionError);
    });
  }
  const managementCategory = category;
  await persistSetupProgress();

  // 2. Locate, move, or create #bot-commands inside MANAGEMENT.
  const shortPrefix = getTournamentShortPrefix(tournament.title, tournament.id);
  const { primary: botCmdPrimary, fallback: botCmdFallback } = getTournamentChannelNames(shortPrefix, 'bot-commands');
  let botCommandsChannel = null;
  if (savedTournament.channels.botCommandsId) {
    botCommandsChannel = guild.channels.cache.get(savedTournament.channels.botCommandsId) ||
      await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null);
    if (botCommandsChannel && (botCommandsChannel.type !== ChannelType.GuildText || (botCommandsChannel.guildId || botCommandsChannel.guild?.id) !== guild.id)) {
      botCommandsChannel = null;
    }
  }


  const botCommandsOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: managementRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];

  if (botCommandsChannel) {
    if (botCommandsChannel.name !== botCmdPrimary && botCommandsChannel.name !== botCmdFallback) {
      try {
        await botCommandsChannel.setName(botCmdPrimary);
      } catch (err) {
        await botCommandsChannel.setName(botCmdFallback).catch((fbErr) => console.warn(`[Discord Bot] Could not rename bot-commands channel: ${fbErr.message}`));
      }
    }
    if (botCommandsChannel.parentId !== managementCategory.id) {
      await botCommandsChannel.setParent(managementCategory.id, { lockPermissions: false });
    }
    if (typeof botCommandsChannel.permissionOverwrites?.set === 'function') {
      await botCommandsChannel.permissionOverwrites.set(botCommandsOverwrites).catch(() => {});
    }
  } else {
    try {
      botCommandsChannel = await queueChannelCreate(guild, {
        name: botCmdPrimary,
        type: ChannelType.GuildText,
        parent: managementCategory.id,
        topic: `Tournament Management & Control Panel (Admin Only) — ${tournament.title} (ID: ${tournamentId})`,
        permissionOverwrites: botCommandsOverwrites,
      });
    } catch (createPrimaryErr) {
      botCommandsChannel = await queueChannelCreate(guild, {
        name: botCmdFallback,
        type: ChannelType.GuildText,
        parent: managementCategory.id,
        topic: `Tournament Management & Control Panel (Admin Only) — ${tournament.title} (ID: ${tournamentId})`,
        permissionOverwrites: botCommandsOverwrites,
      });
    }
    savedTournament.channels.botCommandsId = botCommandsChannel.id;
  }
  await persistSetupProgress();

  // 3. Compute channel and category status from the current Discord state.
  let channelsStatus;
  try {
    channelsStatus = await buildTournamentChannelStatus(guild, savedTournament, botCommandsChannel);
  } catch (statusError) {
    console.error(`[Discord Bot] Could not inspect channel status for dashboard ${tournamentId}:`, statusError);
    channelsStatus = {
      isConfigured: false,
      activeCount: 0,
      statusText: `⚠️ **Status unavailable:** ${String(statusError.message || statusError).slice(0, 300)}`,
    };
  }
  const isConfigured = Boolean(channelsStatus?.isConfigured);

  // Persist resource IDs before dashboard-message work so a failed send or edit can
  // be retried without creating another category or channel on the next attempt.
  savedTournament.tournamentId = tournamentId;
  savedTournament.tournamentTitle = tournament.title;
  savedTournament.guildId = guild.id;
  savedTournament.categoryId = category.id;
  savedTournament.managementCategoryId = managementCategory.id;
  savedTournament.channels.botCommandsId = botCommandsChannel.id;
  currentSettings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  const checkpointSaved = await saveTournamentToDb(guild.id, tournamentId, savedTournament);
  if (!checkpointSaved) console.warn(`[Discord Bot] MongoDB did not confirm dashboard resource checkpoint for ${tournamentId}.`);

  // 4. Construct Embed and Action Buttons
  const embed = buildTournamentControlPanelEmbed(tournament, summary, channelsStatus, roleInfo, savedTournament.rounds || {});
  const buttons = buildTournamentControlPanelButtons(tournamentId);

  // 5. Update or Send Control Panel Message in #bot-commands idempotently
  let panelMessage = null;
  const canonicalLogicalKey = `tournament:${tournamentId}:management-dashboard`;

  try {
    const upsertRes = await upsertManagedMessage(guild.client, {
      guildId: guild.id,
      channelId: botCommandsChannel.id,
      logicalKey: canonicalLogicalKey,
      messageType: 'tournament_control_panel',
      tournamentId,
      existingMessageId: savedTournament.controlPanelMessageId || null,
      payload: { embeds: [embed], components: buttons },
      extraMetadata: { tournamentTitle: tournament.title },
    });
    panelMessage = upsertRes.message;
  } catch (upsertErr) {
    console.warn(`[Discord Bot] ⚠️ Error in upsertManagedMessage for control panel:`, upsertErr.message);

    if (savedTournament.controlPanelMessageId && typeof botCommandsChannel.messages?.fetch === 'function') {
      try {
        panelMessage = await botCommandsChannel.messages.fetch(savedTournament.controlPanelMessageId);
        if (panelMessage && typeof panelMessage.edit === 'function') {
          await panelMessage.edit({ embeds: [embed], components: buttons });
        }
      } catch {
        panelMessage = null;
      }
    }

    // Secondary fallback: scan recent messages to adopt existing dashboard if message ID was unrecorded
    if (!panelMessage && typeof botCommandsChannel.messages?.fetch === 'function') {
      try {
        const recent = await botCommandsChannel.messages.fetch({ limit: 15 }).catch(() => null);
        if (recent) {
          for (const m of recent.values()) {
            if (m.author?.id === guild.client?.user?.id) {
              const isPanel = m.embeds?.some((e) => e.title?.includes('MatchDistrict Tournament Control Panel')) ||
                m.components?.some((r) => r.components?.some((c) => c.customId?.includes(tournamentId)));
              if (isPanel && typeof m.edit === 'function') {
                await m.edit({ embeds: [embed], components: buttons });
                panelMessage = m;
                break;
              }
            }
          }
        }
      } catch {}
    }

    if (!panelMessage && typeof botCommandsChannel.send === 'function') {
      panelMessage = await botCommandsChannel.send({ embeds: [embed], components: buttons });
    }
  }

  // 6. Persist mapping
  savedTournament.categoryId = category.id;
  savedTournament.channels.botCommandsId = botCommandsChannel.id;
  savedTournament.setupStatus = isConfigured ? 'active' : 'pending_channels';
  savedTournament.controlPanelMessageId = panelMessage ? panelMessage.id : null;
  savedTournament.controlPanelLogicalKey = canonicalLogicalKey;
  savedTournament.controlPanelVersion = (savedTournament.controlPanelVersion || 0) + 1;
  savedTournament.lastSyncedAt = new Date().toISOString();

  await persistSetupProgress();

  // Keep the dashboard as the only message in this channel.
  // 7. Remove command invocations, user messages, and any other messages.
  if (panelMessage?.id) {
    await cleanupBotCommandsClutter(
      guild,
      botCommandsChannel,
      tournamentId,
      panelMessage.id
    );
  }

  return {
    category,
    botCommandsChannel,
    controlPanelMessageId: panelMessage ? panelMessage.id : null,
    isConfigured,
  };
}

/**
 * Handles selecting a tournament from .list tournament or .select tournament <id>.
 */
export async function handleSelectTournamentCommand(guild, member, tournamentId, replyFn) {
  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await replyFn(access.reason);
    return;
  }

  if (!tournamentId || typeof tournamentId !== 'string') {
    await replyFn('⚠️ **Missing Tournament ID:** Please specify a tournament ID: `.select tournament <tournament_id>`');
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await replyFn(
      '❌ **Missing Bot Permissions:** The bot requires the **Manage Channels** permission in this server to initialize tournament categories and channels.'
    );
    return;
  }

  let backendData;
  try {
    backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
  } catch (err) {
    await replyFn(`❌ **Failed to retrieve tournament details for \`${tournamentId}\`:**\n> ${err.message}`);
    return;
  }

  const { tournament, summary } = backendData;
  if (!tournament) {
    await replyFn(`❌ **Error:** No tournament metadata returned for ID \`${tournamentId}\`.`);
    return;
  }

  let panelResult;
  try {
    panelResult = await withTournamentLock(tournamentId, async () => {
      return await setupTournamentControlPanel(guild, tournament, summary, botMember);
    }, 'select_tournament');
  } catch (lockErr) {
    await replyFn(`⚠️ **Operation in progress:** ${lockErr.message}`);
    return;
  }

  await replyFn(
    `✅ **Tournament Selected:** **${tournament.title}** (ID: \`${tournament.id}\`)\n` +
    `• Control panel initialized in <#${panelResult.botCommandsChannel.id}>.\n` +
    `• Use the action buttons in <#${panelResult.botCommandsChannel.id}> to provision participant channels, refresh stats, or manage the tournament.`
  );
}

/**
 * Handles the ".list tournament" command.
 */
export async function handleListTournamentCommand(guild, member, args = [], replyFn) {
  if (guild?.id) await loadOrganiserLinkForGuild(guild.id);
  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await replyFn(access.reason);
    return;
  }

  const showAll = args.some((a) => (a || '').toLowerCase() === 'all');
  let requestedPage = 1;
  const pageIdx = args.findIndex((a) => (a || '').toLowerCase() === 'page');
  if (pageIdx !== -1 && args[pageIdx + 1]) {
    requestedPage = parseInt(args[pageIdx + 1], 10) || 1;
  } else {
    const numericArg = args.find((a) => /^\d+$/.test(a));
    if (numericArg) requestedPage = parseInt(numericArg, 10) || 1;
  }

  try {
    if (access.isOrganiserLinked && !access.organiserId) {
      throw new Error('The linked organiser account ID is missing from MongoDB. Re-link this server with its organiser code.');
    }
    const tournaments = await fetchTournamentsFromBackend({
      status: showAll ? 'all' : 'published',
      organizerId: access.organiserId,
    });

    if (tournaments.length === 0) {
      if (access.organiserId) {
        await replyFn(`ℹ️ **No Tournaments Found:** No active tournaments found for organiser **${access.organiserName || 'your account'}**.\nCreate a tournament on the [MatchDistrict Website](https://matchdistrict.in) to begin!`);
        return;
      }
      await replyFn(`ℹ️ **No Tournaments Found:** No ${showAll ? '' : 'published '}tournaments currently available on MatchDistrict.`);
      return;
    }

    const pages = formatTournamentListPages(tournaments, {
      page: requestedPage,
      pageSize: 25,
      showAll,
    });
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(tournaments.length / pageSize));
    const currentPage = Math.max(1, Math.min(requestedPage, pageCount));
    const pageItems = tournaments.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    await replyFn({ content: pages[0], components: buildTournamentSelectionRows(pageItems) });
  } catch (err) {
    console.error(`[Discord Bot] Failed to fetch tournaments for guild ${guild.id} (organiser ${access.organiserId || 'all'}):`, err);
    await replyFn(`❌ **MatchDistrict fetch failed:** Could not retrieve tournaments. ${err.message}`);
  }
}

/**
 * Handles the ".fetch teams" command.
 * Can be executed with an explicit tournament ID or from inside a tournament's #bot-commands channel.
 */
export async function handleFetchTeamsCommand(guild, member, args = [], replyFn, messageChannel = null) {
  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await replyFn(access.reason);
    return;
  }

  // 1. Identify tournament ID from arguments, active channel, or guild session
  let tournamentId = (args[0] || '').trim();
  if (tournamentId.toLowerCase() === 'teams' || tournamentId.toLowerCase() === 'team') {
    tournamentId = (args[1] || '').trim();
  }

  // If not provided in args, check if executed inside a tournament's #bot-commands channel
  if (!tournamentId && messageChannel && guildSettingsCache[guild.id]?.tournaments) {
    for (const [tId, tData] of Object.entries(guildSettingsCache[guild.id].tournaments)) {
      const bCmdId = tData.channels?.botCommandsId || tData.botCommandsId;
      if (bCmdId && bCmdId === messageChannel.id) {
        tournamentId = tId;
        break;
      }
    }
  }

  // Fallback to session if unambiguous
  if (!tournamentId) {
    const session = guildTournamentSessions.get(guild.id);
    if (session && session.lastListedTournamentId) {
      tournamentId = session.lastListedTournamentId;
    } else if (session && Array.isArray(session.lastTournaments) && session.lastTournaments.length > 1) {
      await replyFn(
        `⚠️ **Multiple Tournaments Available:**\n` +
        `Please specify the target tournament ID or run this command inside the tournament's **#bot-commands** channel:\n` +
        `> \`.fetch teams <tournament_id>\`\n\n` +
        `*(Run \`.list tournament\` to view all tournament IDs)*`
      );
      return;
    } else {
      await replyFn(
        `⚠️ **Missing Tournament ID:**\n` +
        `Please provide a tournament ID or run this command inside a tournament's **#bot-commands** channel:\n` +
        `> \`.fetch teams <tournament_id>\`\n\n` +
        `*(Run \`.list tournament\` first to see available tournaments)*`
      );
      return;
    }
  }

  // Verify Bot Permissions in the guild
  const botMember = guild.members.me;
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await replyFn(
      '❌ **Missing Bot Permissions:** The bot requires the **Manage Channels** permission in this server to create tournament categories and configure channels.'
    );
    return;
  }

  try {
    await withTournamentLock(tournamentId, async () => {
      // Fetch registrations from website backend
      const backendPayload = await fetchTournamentRegistrationsFromBackend(tournamentId);
      const { tournament, teams, summary } = backendPayload;
      if (!tournament) {
        await replyFn(`❌ **Error:** No tournament metadata returned for ID \`${tournamentId}\`.`);
        return;
      }

      // Synchronize category, all shared channels, roster, and member permissions
      const syncResult = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);

      // Refresh or setup control panel embed in #bot-commands
      await setupTournamentControlPanel(guild, tournament, summary, botMember);

      // Format final summary report
      const summaryMessage = formatSyncSummaryMessage(tournament, summary, syncResult);
      await replyFn(summaryMessage);

      // If command was executed outside the tournament's #bot-commands channel, post a copy to #bot-commands
      const botCmdId = syncResult.channelIds?.botCommandsId;
      if (botCmdId && (!messageChannel || messageChannel.id !== botCmdId)) {
        try {
          const bChannel = guild.channels.cache.get(botCmdId) || await guild.channels.fetch(botCmdId).catch(() => null);
          if (bChannel && typeof bChannel.send === 'function') {
            await bChannel.send(summaryMessage).catch(() => { });
          }
        } catch {
          // Ignore notification mirror errors
        }
      }
    });
  } catch (err) {
    await replyFn(`❌ **Failed to fetch registrations for tournament \`${tournamentId}\`:**\n> ${err.message}`);
    return;
  }
}

/**
 * Synchronize tournament Discord category and exactly four shared channels:
 * 1. #bot-commands (Admin only)
 * 2. #tournament-update (Admin post, participants read-only)
 * 3. #tournament-teams (Admin post / bot roster, participants read-only)
 * 4. #tournament-helpdesk (Participants can chat, admins/mods respond)
 *
 * Removes per-squad channel creation completely and migrates away from obsolete squad channels.
 */
export async function syncTournamentDiscordChannels(guild, tournament, teams = [], botMember) {
  const tournamentId = tournament.id;
  const currentSettings = guildSettingsCache[guild.id] || {};
  if (!currentSettings.tournaments) {
    currentSettings.tournaments = {};
  }
  const savedTournament = currentSettings.tournaments[tournamentId] || {
    tournamentId,
    tournamentTitle: tournament.title,
    guildId: guild.id,
    categoryId: null,
    channels: {},
    allEligibleMemberIds: [],
    setupStatus: 'pending_channels',
  };

  if (!savedTournament.channels) {
    savedTournament.channels = {};
  }

  const syncResult = {
    categoryAction: 'none', // created, reused, failed
    categoryId: null,
    publicCategoryId: null,
    managementCategoryId: null,
    channelsCreated: [],
    channelsReused: [],
    channelIds: {},
    teamsUpdatedInChannel: false,
    permissionsUpdated: 0,
    permissionsRemoved: 0,
    obsoleteSquadChannelsDeleted: 0,
    failures: [],
  };

  // Pre-fetch all channels to ensure full API cache across bot restarts
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }

  // 1. Resolve one canonical tournament category, reusing any saved legacy ID.
  const shortPrefix = getTournamentShortPrefix(tournament.title, tournament.id);
  const categoryName = getTournamentCategoryName(shortPrefix, 'INFO');
  const savedCategoryIds = [savedTournament.categoryId, savedTournament.publicCategoryId, savedTournament.managementCategoryId,
    ...Object.values(savedTournament.rounds || {}).map((round) => round?.categoryId)].filter(Boolean);
  let category = null;
  for (const categoryId of savedCategoryIds) {
    category = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(() => null);
    if (category?.type === ChannelType.GuildCategory && (category.guildId || category.guild?.id) === guild.id) break;
    category = null;
  }
  if (category) {
    syncResult.categoryAction = 'reused';
    if (category.name !== categoryName) await category.setName(categoryName).catch((err) => syncResult.failures.push(`Failed to rename tournament category: ${err.message}`));
  } else {
    try {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
          { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
        ],
      });
      syncResult.categoryAction = 'created';
    } catch (err) {
      syncResult.categoryAction = 'failed';
      syncResult.failures.push(`Failed to create tournament category: ${err.message}`);
      return syncResult;
    }
  }
  syncResult.categoryId = category.id;
  savedTournament.categoryId = category.id;

  // Rename any other categories stored in MongoDB strictly by ID
  if (savedTournament.managementCategoryId && savedTournament.managementCategoryId !== category.id) {
    const mgmtCat = guild.channels.cache.get(savedTournament.managementCategoryId) ||
      await guild.channels.fetch(savedTournament.managementCategoryId).catch(() => null);
    if (mgmtCat && mgmtCat.type === ChannelType.GuildCategory) {
      const mgmtExpected = getTournamentCategoryName(shortPrefix, 'MANAGEMENT');
      if (mgmtCat.name !== mgmtExpected) {
        await mgmtCat.setName(mgmtExpected).catch((err) => syncResult.failures.push(`Failed to rename management category: ${err.message}`));
      }
    }
  }
  if (savedTournament.rounds && typeof savedTournament.rounds === 'object') {
    for (const round of Object.values(savedTournament.rounds)) {
      if (round?.categoryId && round.categoryId !== category.id) {
        const rCat = guild.channels.cache.get(round.categoryId) ||
          await guild.channels.fetch(round.categoryId).catch(() => null);
        if (rCat && rCat.type === ChannelType.GuildCategory) {
          const rExpected = getTournamentCategoryName(shortPrefix, `R${round.roundNumber || 1}`);
          if (rCat.name !== rExpected) {
            await rCat.setName(rExpected).catch((err) => syncResult.failures.push(`Failed to rename round category: ${err.message}`));
          }
        }
      }
    }
  }

  const { tourneyModRole: modsRole, spectatorRole } = await ensureManagementDashboardRoles(guild, savedTournament, botMember);
  const botOverwrite = {
    id: botMember.id,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks],
  };
  const categoryOverwrites = [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: modsRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
    botOverwrite,
  ];
  await category.permissionOverwrites?.set?.(categoryOverwrites).catch((err) => {
    syncResult.failures.push(`Failed to update tournament category permissions: ${err.message}`);
  });
  await flattenTournamentCategories(guild, savedTournament, category);
  savedTournament.publicCategoryId = category.id;
  savedTournament.managementCategoryId = category.id;
  syncResult.publicCategoryId = category.id;
  syncResult.managementCategoryId = category.id;

  // Ensure dedicated tournament role is created or resolved
  let tournamentRole = null;
  try {
    tournamentRole = await getOrCreateTournamentRole(guild, tournament);
    if (tournamentRole) {
      savedTournament.roleId = tournamentRole.id;
      savedTournament.roleName = tournamentRole.name;
    }
  } catch (err) {
    console.warn(`[Discord Bot] Could not resolve tournament role for ${tournamentId}:`, err.message);
  }

  // 2. Migration: Safely clean up any obsolete per-squad channels from older bot versions
  if (savedTournament.teamChannels && typeof savedTournament.teamChannels === 'object') {
    const obsoleteIds = Object.values(savedTournament.teamChannels);
    for (const chId of obsoleteIds) {
      if (!chId) continue;
      try {
        const ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
        if (ch && ch.parentId === category.id && ch.name.startsWith('team-')) {
          await ch.delete('Migrating away from obsolete per-squad channels to shared tournament channels').catch(() => { });
          syncResult.obsoleteSquadChannelsDeleted++;
        }
      } catch {
        // Ignore deletion failures for non-existent channels
      }
    }
    delete savedTournament.teamChannels;
  }

  // 3. Collect all currently eligible linked member Discord IDs
  const currentEligibleMemberIds = new Set();
  const eligibleTeams = teams.filter((t) => t.is_eligible);

  for (const team of eligibleTeams) {
    if (Array.isArray(team.linked_members)) {
      for (const m of team.linked_members) {
        if (m.discord_id && isValidDiscordSnowflake(m.discord_id)) {
          currentEligibleMemberIds.add(m.discord_id);
        }
      }
    }
  }

  // 4. Create or reuse exactly the required channels
  const activeChannels = {};

  for (const channelDef of REQUIRED_TOURNAMENT_CHANNELS) {
    const existingId = savedTournament.channels[channelDef.key];
    const desiredName = `${tournamentPrefix}-${channelDef.name}`;
    const targetCategory = category;
    let channelInstance = null;

    if (existingId) {
      channelInstance = guild.channels.cache.get(existingId) ||
        await guild.channels.fetch(existingId).catch(() => null);
      if (channelInstance && (channelInstance.type !== ChannelType.GuildText || (channelInstance.guildId || channelInstance.guild?.id) !== guild.id)) {
        channelInstance = null;
      }
    }

    // Determine initial permission overwrites based on channel type
    let targetOverwrites = [];

    if (channelDef.category === 'management') {
      targetOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: modsRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
        ...(channelDef.key === 'specResultId' ? [{
          id: spectatorRole.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
        }] : []),
        botOverwrite,
      ];
    } else if (channelDef.participantAccess === 'read_write') {
      targetOverwrites = [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
            ...(channelDef.key === 'tournamentVerificationId' ? [PermissionFlagsBits.MentionEveryone] : [])],
        },
        { id: modsRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.MentionEveryone] },
        botOverwrite,
      ];
    } else if (channelDef.category === 'public') {
      targetOverwrites = [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.AddReactions,
          ],
        },
        { id: modsRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.AddReactions, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MentionEveryone] },
        botOverwrite,
      ];
    } else {
      targetOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ...(channelDef.key === 'botCommandsId' || channelDef.key === 'tournamentLogId' ? [{
          id: modsRole.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
        }] : []),
        botOverwrite,
      ];
    }

    if (channelInstance) {
      if (channelInstance.parentId !== targetCategory.id) {
        await channelInstance.setParent(targetCategory.id, { lockPermissions: false }).catch((err) => {
          syncResult.failures.push(`Failed to move #${channelInstance.name}: ${err.message}`);
        });
      }
      if (channelInstance.name !== desiredName) {
        await channelInstance.setName(desiredName).catch((err) => syncResult.failures.push(`Failed to rename channel: ${err.message}`));
      }
      syncResult.channelsReused.push(desiredName);
      savedTournament.channels[channelDef.key] = channelInstance.id;
      activeChannels[channelDef.key] = channelInstance;

      // Apply or repair permission overwrites on existing channel
      if (typeof channelInstance.permissionOverwrites?.set === 'function') {
        try {
          await channelInstance.permissionOverwrites.set(targetOverwrites);
        } catch (owErr) {
          console.warn(`[Discord Bot] ⚠️ Could not repair overwrites on #${desiredName}:`, owErr.message);
        }
      }
    } else {
      try {
        channelInstance = await queueChannelCreate(guild, {
          name: desiredName,
          type: ChannelType.GuildText,
          parent: targetCategory.id,
          topic: `${channelDef.topic} — ${tournament.title}`,
          permissionOverwrites: targetOverwrites,
        });

        syncResult.channelsCreated.push(desiredName);
        savedTournament.channels[channelDef.key] = channelInstance.id;
        activeChannels[channelDef.key] = channelInstance;
      } catch (err) {
        syncResult.failures.push(`Failed to create #${desiredName}: ${err.message}`);
      }
    }
  }

  // 4b. Ensure room-maker-vc voice channel with a 15-user limit
  let voiceChannelInstance = null;
  const existingVcId = savedTournament.channels.roomMakerVcId;
  if (existingVcId) {
    voiceChannelInstance = guild.channels.cache.get(existingVcId) ||
      await guild.channels.fetch(existingVcId).catch(() => null);
    if (voiceChannelInstance && (voiceChannelInstance.type !== ChannelType.GuildVoice || (voiceChannelInstance.guildId || voiceChannelInstance.guild?.id) !== guild.id)) {
      voiceChannelInstance = null;
    }
  }


  const voiceAllowedBits = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];
  const voiceDeniedBits = [...new Set(Object.values(PermissionFlagsBits))]
    .filter((permission) => !voiceAllowedBits.includes(permission));
  const registeredVoiceOverwrites = [
    ...(tournamentRole ? [{ id: tournamentRole.id, allow: voiceAllowedBits, deny: voiceDeniedBits }] : Array.from(currentEligibleMemberIds, (memberId) => ({
      id: memberId,
      allow: voiceAllowedBits,
      deny: voiceDeniedBits,
    }))),
    { id: modsRole.id, allow: voiceAllowedBits, deny: voiceDeniedBits },
  ];
  const voiceOverwrites = [
    { id: guild.roles.everyone.id, deny: [...new Set(Object.values(PermissionFlagsBits))] },
    ...registeredVoiceOverwrites,
  ];

  const roomMakerName = `${tournamentPrefix}-room-maker-vc`;
  if (voiceChannelInstance) {
    if (voiceChannelInstance.name !== roomMakerName) await voiceChannelInstance.setName(roomMakerName).catch((err) => syncResult.failures.push(`Failed to rename room-maker voice channel: ${err.message}`));
    savedTournament.channels.roomMakerVcId = voiceChannelInstance.id;
    if (voiceChannelInstance.parentId !== category.id) {
      await voiceChannelInstance.setParent(category.id, { lockPermissions: false }).catch((err) => {
        syncResult.failures.push(`Failed to move room-maker-vc: ${err.message}`);
      });
    }
    syncResult.channelsReused.push(roomMakerName);
    if (voiceChannelInstance.userLimit !== 15 && typeof voiceChannelInstance.setUserLimit === 'function') {
      try {
        await voiceChannelInstance.setUserLimit(15, 'Enforcing 15-user limit for MatchDistrict room maker');
      } catch (vcErr) {
        console.warn(`[Discord Bot] Could not update user limit on room-maker-vc:`, vcErr.message);
      }
    }
    if (typeof voiceChannelInstance.permissionOverwrites?.set === 'function') {
      await voiceChannelInstance.permissionOverwrites.set(voiceOverwrites).catch(() => {});
    }
  } else {
    try {
      voiceChannelInstance = await queueChannelCreate(guild, {
        name: roomMakerName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        userLimit: 15,
        permissionOverwrites: voiceOverwrites,
      });
      savedTournament.channels.roomMakerVcId = voiceChannelInstance.id;
      syncResult.channelsCreated.push(roomMakerName);
    } catch (vcErr) {
      syncResult.failures.push(`Failed to create room-maker-vc: ${vcErr.message}`);
    }
  }

  syncResult.channelIds = { ...savedTournament.channels };

  // 5. Synchronize Permissions: Enforce public access architecture & remove legacy participant overwrites
  const allKnownMemberIds = new Set([
    ...(savedTournament.allEligibleMemberIds || []),
    ...currentEligibleMemberIds,
  ]);

  // Update public channels: viewable by all server members (@everyone)
  const publicChannels = [
    {
      channel: activeChannels.tournamentUpdateId,
      permissions: {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        AddReactions: false,
      },
    },
    {
      channel: activeChannels.tournamentRegisterId,
      permissions: {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        AddReactions: false,
      },
    },
    {
      channel: activeChannels.tournamentHelpdeskId,
      permissions: {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      },
    },
  ];

  for (const { channel, permissions } of publicChannels) {
    if (!channel) continue;
    try {
      if (channel.permissionOverwrites?.edit) {
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, permissions).catch(() => { });
        syncResult.permissionsUpdated++;
      }
      // Remove old user-specific permission overwrites since @everyone now grants access
      if (channel.permissionOverwrites?.delete) {
        for (const mId of allKnownMemberIds) {
          await channel.permissionOverwrites.delete(mId).catch(() => { });
          syncResult.permissionsRemoved++;
        }
      }
    } catch (err) {
      syncResult.failures.push(`Permission error on #${channel.name}: ${err.message}`);
    }
  }

  // Update private admin-only channels: ensure @everyone and tournament role cannot view
  const privateChannels = [
    activeChannels.botCommandsId,
    activeChannels.tournamentTeamsId,
  ].filter(Boolean);

  for (const ch of privateChannels) {
    try {
      if (ch.permissionOverwrites?.edit) {
        await ch.permissionOverwrites.edit(guild.roles.everyone.id, {
          ViewChannel: false,
          SendMessages: false,
        }).catch(() => { });
        if (tournamentRole) {
          await ch.permissionOverwrites.edit(tournamentRole.id, {
            ViewChannel: false,
            SendMessages: false,
          }).catch(() => { });
        }
      }
      if (ch.permissionOverwrites?.delete) {
        for (const mId of allKnownMemberIds) {
          await ch.permissionOverwrites.delete(mId).catch(() => { });
        }
      }
    } catch { }
  }

  // Automatically synchronize tournament roles
  try {
    const roleStats = await syncTournamentRoles(guild, tournamentId, { tournament, teams });
    syncResult.roleStats = roleStats;
  } catch (err) {
    syncResult.failures.push(`Failed to sync tournament roles: ${err.message}`);
  }

  // 6. Update the shared #tournament-teams channel with the latest registered team roster (stable message editing)
  const teamsChannel = activeChannels.tournamentTeamsId;
  if (teamsChannel) {
    try {
      await updateTeamsRosterMessages(guild, tournament, teams, teamsChannel, savedTournament);
      syncResult.teamsUpdatedInChannel = true;
    } catch (err) {
      syncResult.failures.push(`Failed to update roster in #tournament-teams: ${err.message}`);
    }
  }

  // 7. Update the #tournament-register channel with the direct details URL (stable message editing)
  const registerChannel = activeChannels.tournamentRegisterId;
  if (registerChannel) {
    try {
      await updateRegistrationLinkMessage(guild, tournament, registerChannel, savedTournament);
      syncResult.registrationLinkUpdated = true;
    } catch (err) {
      syncResult.failures.push(`Failed to update link in #tournament-register: ${err.message}`);
    }
  }

  // 8. Recreate, reuse, or reapply strict permissions and update control messages on all round group channels
  if (savedTournament.rounds && typeof savedTournament.rounds === 'object') {
    const tourPrefix = normalizeTournamentRoleName(tournament.title, tournament.id);
    for (const round of Object.values(savedTournament.rounds)) {
      if (Array.isArray(round.groups)) {
        const roundNum = round.roundNumber || 1;
        round.categoryId = null;
        const roundCategory = category;
        for (const group of round.groups) {
          const g = group.groupNumber;
          const roleName = `${tournament.title} R${roundNum} G${g}`.slice(0, 100);
          const altRoleName = `${tourPrefix}-r${roundNum}-g${g}`;
          const channelName = sanitizeChannelName(`${tourPrefix}-r${roundNum}-g${g}`);

          // Ensure group role exists
          let grpRole = null;
          if (group.roleId && guild.roles) {
            grpRole = guild.roles.cache.get(group.roleId) || await guild.roles.fetch(group.roleId).catch(() => null);
          }
          if (!grpRole && guild.roles) {
            grpRole = findInCache(guild.roles.cache, (r) => r.name.toLowerCase() === roleName.toLowerCase() || r.name.toLowerCase() === altRoleName.toLowerCase()) || null;
          }
          if (!grpRole && typeof guild.roles?.create === 'function') {
            grpRole = await queueRoleCreate(guild, {
              name: roleName,
              permissions: [],
              mentionable: false,
              reason: `MatchDistrict group role for ${tournament.title} ${round.name} Group ${g}`,
            }).catch(() => null);
          }
          if (grpRole) {
            group.roleId = grpRole.id;
            group.roleName = grpRole.name;
          }

          // Locate or recreate private group channel under tournament category
          let grpChannel = null;
          if (group.channelId) {
            grpChannel = guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null);
            if (grpChannel && (grpChannel.type !== ChannelType.GuildText || (grpChannel.guildId || grpChannel.guild?.id) !== guild.id)) {
              grpChannel = null;
            }
          }

          if (!grpChannel && typeof guild.channels?.create === 'function') {
            const groupOverwrites = [
              {
                id: guild.roles.everyone.id,
                deny: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.SendMessagesInThreads,
                  PermissionFlagsBits.CreatePublicThreads,
                  PermissionFlagsBits.CreatePrivateThreads,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.EmbedLinks,
                  PermissionFlagsBits.UseApplicationCommands,
                  PermissionFlagsBits.ManageMessages,
                  PermissionFlagsBits.ManageThreads,
                  PermissionFlagsBits.MentionEveryone,
                ],
              },
              ...(grpRole ? [{
                id: grpRole.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
                deny: [
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.SendMessagesInThreads,
                  PermissionFlagsBits.CreatePublicThreads,
                  PermissionFlagsBits.CreatePrivateThreads,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.EmbedLinks,
                  PermissionFlagsBits.UseApplicationCommands,
                  PermissionFlagsBits.ManageMessages,
                  PermissionFlagsBits.ManageThreads,
                  PermissionFlagsBits.MentionEveryone,
                ],
              }] : []),
              ...(tournamentRole ? [{
                id: tournamentRole.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
                deny: [
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.SendMessagesInThreads,
                  PermissionFlagsBits.CreatePublicThreads,
                  PermissionFlagsBits.CreatePrivateThreads,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.EmbedLinks,
                  PermissionFlagsBits.UseApplicationCommands,
                  PermissionFlagsBits.ManageMessages,
                  PermissionFlagsBits.ManageThreads,
                  PermissionFlagsBits.MentionEveryone,
                ],
              }] : []),
              ...(botMember ? [{
                id: botMember.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.ManageMessages,
                  PermissionFlagsBits.EmbedLinks,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.ManageChannels,
                ],
              }] : []),
            ];

            grpChannel = await queueChannelCreate(guild, {
              name: channelName,
              type: ChannelType.GuildText,
              parent: roundCategory.id,
              topic: `MatchDistrict ID/PWD & Slot Details for ${round.name} Group ${g}`,
              permissionOverwrites: groupOverwrites,
            }).catch((err) => {
              syncResult.failures.push(`Failed to recreate channel for Group ${g}: ${err.message}`);
              return null;
            });

            if (grpChannel) {
              syncResult.channelsCreated.push(grpChannel.name);
            }
          } else if (grpChannel) {
            syncResult.channelsReused.push(grpChannel.name);
          }

          if (grpChannel) {
            group.channelId = grpChannel.id;
            group.channelName = grpChannel.name;
            if (grpChannel.parentId !== category.id) {
              await grpChannel.setParent(category.id, { lockPermissions: false }).catch((err) => {
                syncResult.failures.push(`Failed to move ${grpChannel.name} into the tournament category: ${err.message}`);
              });
            }
            await applyStrictGroupChannelPermissions(guild, grpChannel, grpRole, tournamentRole, botMember, round.groupMessagesOpen, modsRole);
            await removeGroupResultControlMessage(guild, group, grpChannel);
            await updateGroupSlotListMessage(guild, tournament, round, group, grpChannel);
          }
        }
      }
    }
  }

  // 9. Persist tournament mapping to guild settings
  savedTournament.tournamentId = tournamentId;
  savedTournament.tournamentTitle = tournament.title;
  savedTournament.guildId = guild.id;
  savedTournament.categoryId = category.id;
  savedTournament.roleId = savedTournament.roleId || tournamentRole?.id || null;
  savedTournament.roleName = savedTournament.roleName || tournamentRole?.name || null;
  savedTournament.allEligibleMemberIds = Array.from(currentEligibleMemberIds);
  savedTournament.setupStatus = (syncResult.channelsCreated.length + syncResult.channelsReused.length >= 6) ? 'active' : 'pending_channels';
  savedTournament.lastSyncedAt = new Date().toISOString();
  savedTournament.lastParticipantSyncAt = new Date().toISOString();

  currentSettings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);

  // If bot-commands exists and active round is present, update summary and global submission control
  if (savedTournament.channels?.botCommandsId) {
    const botCommandsChannel = guild.channels.cache.get(savedTournament.channels.botCommandsId) ||
      await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null);
    if (botCommandsChannel) {
      const activeRound = Object.values(savedTournament.rounds || {}).find((r) => r.status === 'Active' || r.status === 'Started');
      if (activeRound) {
        await publishRoundAllocationSummary(guild, tournament, activeRound, botCommandsChannel, savedTournament);
        await updateGlobalSubmissionControlPanel(guild, tournament, activeRound, botCommandsChannel);
      }
    }
  }

  if (syncResult.channelsCreated?.length > 0 || syncResult.categoryAction === 'created') {
    await recordAuditLog(guild.id, 'TOURNAMENT_CHANNELS_CREATED', {
      tournamentId,
      tournamentTitle: tournament.title,
      categoryName: category?.name,
      channelCount: (syncResult.channelsCreated?.length || 0) + (syncResult.channelsReused?.length || 0),
    }).catch(() => {});
  }

  return syncResult;
}

  /**
   * Safely deletes all managed Discord channels, voice channels, and category for a tournament.
   * Preserves all tournament database records, round allocations, 25-slot group configurations,
   * match results, team registrations, and qualification records in MongoDB.
   */
  export async function deleteTournamentDiscordChannels(guild, tournamentId) {
    return await withTournamentLock(tournamentId, async () => {
      const currentSettings = guildSettingsCache[guild.id] || {};
      let savedTournament = currentSettings.tournaments?.[tournamentId];

      if (!savedTournament && isMongoConnected()) {
        try {
          savedTournament = await getTournamentFromDb(guild.id, tournamentId);
          if (savedTournament) {
            if (!currentSettings.tournaments) currentSettings.tournaments = {};
            currentSettings.tournaments[tournamentId] = savedTournament;
            guildSettingsCache[guild.id] = currentSettings;
          }
        } catch (err) {
          console.warn(`[Delete Channels] Error fetching tournament ${tournamentId} from MongoDB:`, err.message);
        }
      }

      const summary = {
        deletedChannels: [],
        categoryDeleted: false,
        failures: [],
      };

      if (!savedTournament) return summary;

      const knownCategoryId = [savedTournament.categoryId, savedTournament.publicCategoryId, savedTournament.managementCategoryId]
        .find(Boolean);
      const knownCategory = knownCategoryId
        ? guild.channels.cache.get(knownCategoryId) || await guild.channels.fetch(knownCategoryId).catch(() => null)
        : null;
      if (knownCategory?.type === ChannelType.GuildCategory) {
        await flattenTournamentCategories(guild, savedTournament, knownCategory);
      }

      const categoryId = savedTournament.categoryId;
      const legacyCategoryShared = Object.entries(currentSettings.tournaments || {}).some(([otherId, other]) =>
        otherId !== tournamentId && [other.categoryId, other.publicCategoryId, other.managementCategoryId,
          ...Object.values(other.rounds || {}).map((round) => round?.categoryId), ...(other.legacyCategoryIds || [])].includes(categoryId)
      );

      // 1. Delete all round group ID/PWD channels and voice channels first (Child Channels First)
      if (savedTournament.rounds && typeof savedTournament.rounds === 'object') {
        for (const round of Object.values(savedTournament.rounds)) {
          if (Array.isArray(round.groups)) {
            for (const group of round.groups) {
              // Delete text channel (ID/PWD channel e.g. bgmis2026-r1-g1)
              if (group.channelId) {
                try {
                  const gch = guild.channels.cache.get(group.channelId) ||
                    await guild.channels.fetch(group.channelId).catch(() => null);
                  if (gch) {
                    const gchName = gch.name;
                    await gch.delete('Tournament management: delete round group ID/PWD channel').catch(() => {});
                    if (!summary.deletedChannels.includes(gchName)) {
                      summary.deletedChannels.push(gchName);
                    }
                  }
                } catch (err) {
                  if (err.code !== 10003) {
                    summary.failures.push(`Failed to delete group channel ${group.channelId}: ${err.message}`);
                  }
                }
              }

              // Delete voice channel if present
              if (group.voiceChannelId) {
                try {
                  const gvc = guild.channels.cache.get(group.voiceChannelId) ||
                    await guild.channels.fetch(group.voiceChannelId).catch(() => null);
                  if (gvc) {
                    const gvcName = gvc.name;
                    await gvc.delete('Tournament management: delete round group voice channel').catch(() => {});
                    if (!summary.deletedChannels.includes(gvcName)) {
                      summary.deletedChannels.push(gvcName);
                    }
                  }
                } catch (err) {
                  if (err.code !== 10003) {
                    summary.failures.push(`Failed to delete group voice channel ${group.voiceChannelId}: ${err.message}`);
                  }
                }
              }

              // CRITICAL: Clear only Discord channel and message IDs; preserve slots, submissions, qualifications, roles
              group.channelId = null;
              group.voiceChannelId = null;
              group.slotListMessageId = null;
              group.credentialsMessageId = null;
              group.submissionControlMessageId = null;
            }
          }
          if (round.categoryId) {
            const roundCategory = guild.channels.cache.get(round.categoryId) || await guild.channels.fetch(round.categoryId).catch(() => null);
            if (roundCategory?.type === ChannelType.GuildCategory) {
              for (const child of guild.channels.cache.filter((channel) => channel.parentId === roundCategory.id).values()) {
                await child.delete('Tournament management: delete round category channel').catch((err) => {
                  summary.failures.push(`Failed to delete ${child.name}: ${err.message}`);
                });
              }
              await roundCategory.delete('Tournament management: delete round category').catch((err) => {
                summary.failures.push(`Failed to delete round category ${round.categoryId}: ${err.message}`);
              });
              summary.categoryDeleted = true;
            }
            round.categoryId = null;
          }
        }
        // Progressive update to MongoDB (restart-safe and idempotent)
        await saveTournamentToDb(guild.id, tournamentId, savedTournament).catch(() => {});
      }

      // 2. Delete legacy squad channels if recorded
      if (savedTournament.teamChannels && typeof savedTournament.teamChannels === 'object') {
        for (const [teamId, chId] of Object.entries(savedTournament.teamChannels)) {
          if (!chId) continue;
          try {
            const channel = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
            if (channel) {
              const chName = channel.name;
              await queueChannelDelete(channel, 'Tournament management: deleted legacy squad channel').catch(() => {});
              if (!summary.deletedChannels.includes(chName)) {
                summary.deletedChannels.push(chName);
              }
            }
          } catch (err) {
            if (err.code !== 10003) {
              summary.failures.push(`Failed to delete squad channel ${chId}: ${err.message}`);
            }
          }
        }
        savedTournament.teamChannels = {};
      }

      // 3. Delete any additional child channels under the tournament category (e.g. temporary verify channels)
      if (categoryId && !legacyCategoryShared) {
        try {
          const childChannels = guild.channels.cache.filter((c) => c.parentId === categoryId);
          for (const [cId, child] of childChannels) {
            if (cId !== savedTournament.channels?.botCommandsId && cId !== savedTournament.channels?.tournamentLogId) {
              try {
                const chName = child.name;
                await child.delete('Tournament management: deleted category child channel').catch(() => {});
                if (!summary.deletedChannels.includes(chName)) {
                  summary.deletedChannels.push(chName);
                }
              } catch (err) {
                if (err.code !== 10003) {
                  summary.failures.push(`Failed to delete child channel ${cId}: ${err.message}`);
                }
              }
            }
          }
        } catch {}
      }
      if (savedTournament.managementCategoryId && !legacyCategoryShared) {
        const managementChildren = guild.channels.cache.filter((channel) => channel.parentId === savedTournament.managementCategoryId);
        for (const [childId, child] of managementChildren) {
          if ([savedTournament.channels?.botCommandsId, savedTournament.channels?.tournamentLogId].includes(childId)) continue;
          await child.delete('Tournament management: deleted management category child channel').catch((err) => {
            summary.failures.push(`Failed to delete child channel ${childId}: ${err.message}`);
          });
        }
      }

      // 4. Delete verified tournament channels in savedTournament.channels (#bot-commands deleted last among child channels)
      const channelEntries = Object.entries(savedTournament.channels || {});
      const sortedChannelEntries = channelEntries.filter(([key]) => !['botCommandsId', 'tournamentLogId'].includes(key));

      for (const [chKey, chId] of sortedChannelEntries) {
        if (!chId) continue;
        try {
          const channel = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
          if (channel) {
            const chName = channel.name;
            await queueChannelDelete(channel, 'Tournament management: deleted tournament channel').catch(() => {});
            if (!summary.deletedChannels.includes(chName)) {
              summary.deletedChannels.push(chName);
            }
          }
        } catch (err) {
          if (err.code !== 10003) {
            summary.failures.push(`Failed to delete channel ${chId}: ${err.message}`);
          }
        }
        savedTournament.channels[chKey] = null;
      }

      // Keep the single category when its preserved bot-commands/log channels remain;
      // otherwise remove it after deleting its children. Deduplicate legacy aliases.
      const preserveIds = new Set([savedTournament.channels?.botCommandsId, savedTournament.channels?.tournamentLogId].filter(Boolean));
      const categoryIds = new Set([savedTournament.categoryId, savedTournament.publicCategoryId, savedTournament.managementCategoryId,
        ...(savedTournament.legacyCategoryIds || [])].filter(Boolean));
      let retainedCategoryId = null;
      for (const categoryIdToDelete of categoryIds) {
        const shared = Object.entries(currentSettings.tournaments || {}).some(([otherId, other]) => otherId !== tournamentId &&
          [other.categoryId, other.publicCategoryId, other.managementCategoryId,
            ...Object.values(other.rounds || {}).map((round) => round?.categoryId), ...(other.legacyCategoryIds || [])].includes(categoryIdToDelete));
        if (shared) continue;
        const cat = guild.channels.cache.get(categoryIdToDelete) || await guild.channels.fetch(categoryIdToDelete).catch(() => null);
        if (!cat || cat.type !== ChannelType.GuildCategory) continue;
        for (const child of guild.channels.cache.filter((channel) => channel.parentId === cat.id).values()) {
          if (preserveIds.has(child.id)) {
            retainedCategoryId = cat.id;
            continue;
          }
          await queueChannelDelete(child, 'Tournament management: delete tournament structure channel').catch((err) => {
            summary.failures.push(`Failed to delete ${child.name}: ${err.message}`);
          });
        }
        const remainingChildren = guild.channels.cache.filter((channel) => channel.parentId === cat.id);
        if (remainingChildren.size > 0) {
          retainedCategoryId = cat.id;
          continue;
        }
        await queueChannelDelete(cat, 'Tournament management: delete tournament structure category').catch((err) => {
          summary.failures.push(`Failed to delete category ${cat.name}: ${err.message}`);
        });
        summary.categoryDeleted = true;
      }
      savedTournament.categoryId = retainedCategoryId;
      savedTournament.publicCategoryId = retainedCategoryId;
      savedTournament.managementCategoryId = retainedCategoryId;
      savedTournament.legacyCategoryIds = [];

      // 6. Delete managed messages mappings in MongoDB for this tournament
      try {
        const delMsgResult = await deleteManagedMessages(guild.client, {
          guildId: guild.id,
          tournamentId,
        });
        summary.deletedManagedMessagesCount = delMsgResult?.deletedCount || 0;
      } catch (delErr) {
        console.warn(`[MongoDB] Error deleting managed messages for tournament ${tournamentId}:`, delErr.message);
      }

      // 7. Update persistent state - DO NOT DELETE TOURNAMENT, ROUNDS, OR ROLES FROM DB!
      const persistentChannels = {
        botCommandsId: savedTournament.channels?.botCommandsId || null,
        tournamentLogId: savedTournament.channels?.tournamentLogId || null,
      };
      savedTournament.channels = persistentChannels;
      savedTournament.controlPanelMessageId = null;
      savedTournament.teamListMessageId = null;
      savedTournament.teamListMessageIds = [];
      savedTournament.registrationMessageId = null;
      savedTournament.setupStatus = 'pending_channels';
      savedTournament.channelsDeletedAt = new Date().toISOString();

      currentSettings.tournaments[tournamentId] = savedTournament;
      guildSettingsCache[guild.id] = currentSettings;
      saveGuildSettings(guildSettingsCache);

      await saveTournamentToDb(guild.id, tournamentId, savedTournament);

      return summary;
    }, 'channel deletion');
  }

  /**
   * Handles all tournament button interactions:
   * - md_tour_create_channels:<tournamentId>
   * - md_tour_refresh:<tournamentId>
   * - md_tour_sync_roles:<tournamentId>
   * - md_tour_delete_channels:<tournamentId>
   * - md_tour_confirm_delete:<tournamentId>
   * - md_tour_cancel_delete:<tournamentId>
   */
  export async function handleTournamentButtonInteraction(interaction, customIdOverride = null) {
    const customId = customIdOverride || interaction.customId || '';
    if (
      !customId.startsWith('md_tour_') &&
      !customId.startsWith('md_round_') &&
      !customId.startsWith('md_group_') &&
      !customId.startsWith('md_result_') &&
      !customId.startsWith('md_qual_') &&
      !customId.startsWith('md_qualify_') &&
      customId !== 'md_cancel_qualify'
    ) return;

    // Direct routing for group result submission (accessible by eligible group participants without requiring server admin role)
    if (customId.startsWith('md_group_submit_result:')) {
      const [, tourId, rId, gId] = customId.split(':');
      await handleGroupSubmitResultButton(interaction, tourId, rId, gId);
      return;
    }

    // Qualify team button in ID/PWD channel
    if (customId.startsWith('md_qualify_team:')) {
      const [, tourId, rId, gId] = customId.split(':');
      await handleRoundQualifySlotSelection(interaction, tourId, rId, gId);
      return;
    }

    if (customId.startsWith('md_qual_group:')) {
      const [, tourId, rId, gId] = customId.split(':');
      await handleRoundQualifySlotSelection(interaction, tourId, rId, gId);
      return;
    }

    if (customId.startsWith('md_qual_commit:')) {
      const [, tourId, rId, gId, slotsParam] = customId.split(':');
      const slotNumbers = (slotsParam || '').split(',').map((n) => parseInt(n, 10)).filter(Boolean);
      await handleExecuteQualifyCommit(interaction, tourId, rId, gId, slotNumbers);
      return;
    }

    if (customId === 'md_cancel_qualify') {
      await interaction.update({ content: '🛑 Qualification cancelled.', embeds: [], components: [] }).catch(() => {});
      return;
    }

    // Global result submission control buttons in #bot-commands
    if (customId.startsWith('md_tour_open_submissions:')) {
      const [, tourId, rId] = customId.split(':');
      await handleOpenSubmissionsButton(interaction, tourId, rId);
      return;
    }

    if (customId.startsWith('md_tour_close_submissions:')) {
      const [, tourId, rId] = customId.split(':');
      await handleCloseSubmissionsButton(interaction, tourId, rId);
      return;
    }

    if (customId.startsWith('md_tour_refresh_submissions:')) {
      const [, tourId, rId] = customId.split(':');
      await handleRefreshSubmissionsButton(interaction, tourId, rId);
      return;
    }

    const parts = customId.split(':');
    const actionPart = parts[0] || '';
    const tournamentId = parts[1] || '';
    const extraParam = parts[2] || '';
    let action = '';
    if (actionPart.startsWith('md_tour_')) {
      action = actionPart.replace('md_tour_', '');
    } else if (actionPart.startsWith('md_round_')) {
      action = actionPart.replace('md_round_', '');
    } else if (actionPart.startsWith('md_group_')) {
      action = actionPart.replace('md_group_', '');
    } else if (actionPart.startsWith('md_result_')) {
      action = actionPart.replace('md_result_', '');
    }

    const guild = interaction.guild;
    const member = interaction.member;

    // 1. Authorization & Official Server check (for administrative actions)
    const access = checkTournamentAccess(guild, member);
    if (!access.allowed) {
      if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: access.reason, components: [] }).catch(() => {});
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => { });
      }
      return;
    }

    // Database persistence check: disable state-changing operations if MongoDB is configured but unavailable
    const stateModifyingActions = [
      'create_channels',
      'delete_channels',
      'confirm_delete',
      'delete_permanent',
      'confirm_delete_permanent',
      'sync_roles',
      'create_seq',
      'confirm_start',
      'publish_cred',
      'revoke_sub',
      'reopen_sub',
      'accept',
      'reject',
    ];

    if (process.env.MONGODB_URI && !isMongoConnected() && stateModifyingActions.some((a) => action.includes(a) || actionPart.includes(a))) {
      const dbErr = '⚠️ **Database Unavailable:** MongoDB persistence is currently disconnected. State-changing operations requiring persistence are disabled. Please verify database connectivity or contact an administrator.';
      if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: dbErr, components: [] }).catch(() => {});
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: dbErr, ephemeral: true }).catch(() => {});
      } else if (typeof interaction.followUp === 'function') {
        await interaction.followUp({ content: dbErr, ephemeral: true }).catch(() => {});
      }
      return;
    }

    // Check if tournament is currently undergoing permanent deletion
    const currentTourSaved = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
    if (currentTourSaved && (currentTourSaved.deletionStatus === 'deletion_pending' || currentTourSaved.deletionStatus === 'deleting')) {
      if (action !== 'cancel_delete_permanent' && action !== 'confirm_delete_permanent') {
        const delMsg = '⚠️ **Action Blocked:** This tournament is currently undergoing permanent deletion.';
        if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
          await interaction.editReply({ content: delMsg, components: [] }).catch(() => {});
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: delMsg, ephemeral: true }).catch(() => {});
        } else if (typeof interaction.followUp === 'function') {
          await interaction.followUp({ content: delMsg, ephemeral: true }).catch(() => {});
        }
        return;
      }
    }

    // Check if interaction was clicked on an obsolete/replaced dashboard panel
    if (
      currentTourSaved &&
      currentTourSaved.controlPanelMessageId &&
      interaction.message?.id &&
      interaction.channelId === currentTourSaved.channels?.botCommandsId &&
      interaction.message.id !== currentTourSaved.controlPanelMessageId &&
      ['create_channels', 'refresh', 'sync_refresh', 'view_rounds', 'round_mgmt', 'sync_roles', 'delete_channels', 'delete_permanent'].includes(action)
    ) {
      const obsoleteMsg = '⚠️ **Obsolete Dashboard:** This dashboard control panel has been replaced by a newer version. Please use the active dashboard in this channel or run `.dash` to restore it.';
      if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: obsoleteMsg, ephemeral: true }).catch(() => {});
      }
      return;
    }

    const botMember = guild.members.me;

    // Group submission management buttons (Admin only)
    if (actionPart === 'md_group_revoke_sub') {
      const [, tourId, rId, gId] = customId.split(':');
      await handleGroupRevokeSubmissionButton(interaction, tourId, rId, gId);
      return;
    }
    if (actionPart === 'md_group_reopen_sub') {
      const [, tourId, rId, gId] = customId.split(':');
      await handleGroupReopenSubmissionButton(interaction, tourId, rId, gId);
      return;
    }

    // Admin result verification buttons
    if (actionPart === 'md_result_accept') {
      const [, tourId, rId, gId, subId] = customId.split(':');
      await handleAdminAcceptResultButton(interaction, tourId, rId, gId, subId);
      return;
    }
    if (actionPart === 'md_result_reject') {
      const [, tourId, rId, gId, subId] = customId.split(':');
      await handleAdminRejectResultButton(interaction, tourId, rId, gId, subId);
      return;
    }

    // Action: View Rounds / Round Management (Dedicated Screen)
    if (action === 'view_rounds' || action === 'round_mgmt' || action === 'back_to_rounds') {
      if (action === 'back_to_rounds') updateDashboardNavigation(guild, tournamentId, 'back');
      else updateDashboardNavigation(guild, tournamentId, 'push', { screen: 'rounds' });
      await handleViewRoundsScreen(interaction, tournamentId);
      return;
    }

    // Action: Qualify Teams (Dedicated Group Selection Screen)
    if (action === 'qualify') {
      updateDashboardNavigation(guild, tournamentId, 'push', { screen: 'qualify-groups', roundId: extraParam });
      await handleRoundQualifyGroupSelection(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Create Sequential Round (Legacy fallback)
    if (action === 'create_sequential_round') {
      await handleCreateSequentialRound(interaction, tournamentId);
      return;
    }

    // Action: Refresh Rounds List
    if (action === 'refresh_rounds') {
      await handleViewRoundsScreen(interaction, tournamentId);
      return;
    }

    if (action === 'refresh_round') {
      await handleOpenIndividualRoundMenu(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Back to Tournament Dashboard
    if (action === 'back_to_panel') {
      updateDashboardNavigation(guild, tournamentId, 'home');
      await handleBackToTournamentPanel(interaction, tournamentId);
      return;
    }

    // Action: Open / Back to Individual Round Menu
    if (action === 'back_to_menu' || action === 'manage_round' || action === 'cancel_nav') {
      await handleOpenIndividualRoundMenu(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Start Round (from Individual Round Menu or legacy button)
    if (action === 'start_round' || action === 'start') {
      if (extraParam) {
        await handleConfirmStartRound(interaction, tournamentId, extraParam);
      } else {
        await handleViewRoundsScreen(interaction, tournamentId);
      }
      return;
    }

    // Action: Confirm Start Round
    if (action === 'confirm_start') {
      const roundId = extraParam;
      await handleConfirmStartRound(interaction, tournamentId, roundId);
      return;
    }

    // Action: Cancel Start Round
    if (action === 'cancel_start') {
      if (extraParam) {
        await handleOpenIndividualRoundMenu(interaction, tournamentId, extraParam);
      } else {
        await handleViewRoundsScreen(interaction, tournamentId);
      }
      return;
    }

    // Action: Edit Round
    if (action === 'edit') {
      await handleEditRoundButton(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Delete Round Prompt
    if (action === 'delete') {
      await handlePromptDeleteRound(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Confirm Delete Round
    if (action === 'confirm_delete_round' || (action === 'confirm_delete' && parts[0] === 'md_round_confirm_delete')) {
      await handleConfirmDeleteRound(interaction, tournamentId, extraParam);
      return;
    }

    // Action: View Allocation
    if (action === 'view_alloc') {
      await handleViewRoundAllocation(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Create Round (Modal)
    if (action === 'create_round') {
      const modal = new ModalBuilder()
        .setCustomId(`md_modal_create_round:${tournamentId}`)
        .setTitle('Create Tournament Round');

      const roundNameInput = new TextInputBuilder()
        .setCustomId('round_name')
        .setLabel('Round Name')
        .setPlaceholder('e.g. Round 1, Quarter Finals')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

      const capacityInput = new TextInputBuilder()
        .setCustomId('teams_per_group')
        .setLabel('Teams Per Group (Max 23)')
        .setPlaceholder('e.g. 16')
        .setValue('16')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4);

      modal.addComponents(
        new ActionRowBuilder().addComponents(roundNameInput),
        new ActionRowBuilder().addComponents(capacityInput)
      );
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    // Action: Create Channels
    if (action === 'create_channels') {
      if (typeof interaction.deferReply === 'function' && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }

      try {
        await withTournamentLock(tournamentId, async () => {
          const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
          const { tournament, teams, summary } = backendData;

          const syncResult = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);
          const summaryMsg = formatSyncSummaryMessage(tournament, summary, syncResult);

          // Refresh Control Panel embed
          await setupTournamentControlPanel(guild, tournament, summary, botMember);

          const resp = `✅ **Participant channels provisioned & synchronized.**\n\n${summaryMsg}`;
          if (typeof interaction.editReply === 'function') {
            await interaction.editReply({ content: resp });
          } else if (typeof interaction.reply === 'function') {
            await interaction.reply({ content: resp, ephemeral: true });
          }
        });
      } catch (err) {
        const errorMsg = `❌ **Failed to create channels:** ${err.message}`;
        if (typeof interaction.editReply === 'function') {
          await interaction.editReply({ content: errorMsg });
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: errorMsg, ephemeral: true });
        }
      }
      return;
    }

    // Action: Sync & Refresh (combines registration/channel sync + role sync + statistics refresh)
    if (action === 'sync_refresh' || action === 'refresh' || action === 'sync_roles') {
      if (typeof interaction.deferReply === 'function' && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }

      try {
        await withTournamentLock(tournamentId, async () => {
          // 1. Fetch latest backend data
          const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
          const { tournament, teams, summary } = backendData;

          // 2. Perform channel & participant sync (edits roster in #tournament-teams & registration link in place)
          let channelSyncError = null;
          let syncResult = null;
          try {
            syncResult = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);
          } catch (err) {
            channelSyncError = err.message;
          }

          // 3. Refresh tournament role assignments
          let roleSyncError = null;
          let roleStats = null;
          try {
            roleStats = await syncTournamentRoles(guild, tournamentId, backendData);
          } catch (err) {
            roleSyncError = err.message;
          }

          // 4. Refresh Control Panel embed & statistics
          await setupTournamentControlPanel(guild, tournament, summary, botMember);

          // 5. Check for partial failures and report clearly
          if (channelSyncError || roleSyncError) {
            const warningMsg = `⚠️ **Sync & Refresh Completed with Warnings:**\n` +
              (channelSyncError ? `• **Channel/Roster Sync Failed:** ${channelSyncError}\n` : `• **Channels:** Updated successfully.\n`) +
              (roleSyncError ? `• **Role Sync Failed:** ${roleSyncError}\n` : `• **Roles:** ${roleStats ? `${roleStats.assigned} assigned, ${roleStats.alreadyAssigned} verified.` : 'Updated.'}\n`) +
              `• **Dashboard:** Refreshed with latest registrations.`;
            if (typeof interaction.editReply === 'function') {
              await interaction.editReply({ content: warningMsg });
            } else if (typeof interaction.reply === 'function') {
              await interaction.reply({ content: warningMsg, ephemeral: true });
            }
          } else {
            const roleMention = roleStats?.roleId ? `<@&${roleStats.roleId}>` : `\`${roleStats?.roleName || 'Tournament Role'}\``;
            const replyContent = `✅ **Tournament Synchronized & Refreshed Successfully!**\n` +
              `• **Registrations:** **${summary.total_registered_teams}** teams (**${summary.eligible_teams_count}** eligible)\n` +
              `• **Linked Discord Accounts:** **${summary.eligible_linked_members_count}** verified\n` +
              `• **Roles Synchronized:** ${roleMention} — **${roleStats?.assigned || 0}** newly assigned, **${roleStats?.alreadyAssigned || 0}** verified, **${roleStats?.removed || 0}** removed (ineligible)\n` +
              `• **Channels & Dashboard:** Updated in place without duplicates.`;
            if (typeof interaction.editReply === 'function') {
              await interaction.editReply({ content: replyContent });
            } else if (typeof interaction.reply === 'function') {
              await interaction.reply({ content: replyContent, ephemeral: true });
            }
          }
        });
      } catch (err) {
        const errorMsg = `❌ **Failed to sync & refresh tournament:** ${err.message}`;
        if (typeof interaction.editReply === 'function') {
          await interaction.editReply({ content: errorMsg });
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: errorMsg, ephemeral: true });
        }
      }
      return;
    }

    // Action: Prompt Delete All Channels
    if (action === 'delete_channels') {
      let saved = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
      if (!saved && isMongoConnected()) {
        try {
          saved = await getTournamentFromDb(guild.id, tournamentId);
        } catch {}
      }

      // Collect group channels list
      const groupChannelNames = [];
      if (saved?.rounds && typeof saved.rounds === 'object') {
        for (const r of Object.values(saved.rounds)) {
          if (Array.isArray(r.groups)) {
            for (const g of r.groups) {
              if (g.channelName || g.channelId) {
                groupChannelNames.push(g.channelName || `r${r.roundNumber || 1}-g${g.groupNumber}`);
              }
            }
          }
        }
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`dash:main:confirm-delete-channels:${tournamentId}`)
          .setLabel('Yes, Delete All Channels')
          .setEmoji('⚠️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`dash:main:cancel-delete-channels:${tournamentId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      const groupDetails = groupChannelNames.length > 0
        ? `• **${groupChannelNames.length} Round Group ID/PWD Channels:** ${groupChannelNames.slice(0, 8).map(n => `\`#${n}\``).join(', ')}${groupChannelNames.length > 8 ? ` + ${groupChannelNames.length - 8} more` : ''}\n`
        : `• All round-specific group ID/PWD channels (e.g. \`bgmis2026-r1-g1\`, \`bgmis2026-r1-g2\`)\n`;

      const promptText = `⚠️ **Confirm Tournament Channels Deletion**\n` +
        `Are you sure you want to delete the Discord channel structure for tournament \`${tournamentId}\`?\n\n` +
        `**This will permanently delete from Discord:**\n` +
        `• The single tournament category and all non-preserved tournament channels\n` +
        `• \`#updates\`, \`#roadmap\`, \`#scoreboard\`, \`#helpdesk\`, \`#register-here\`, and \`#verification\`\n` +
        `• \`#registered-team\`, \`#spec-result\`, and \`room-maker-vc\`\n` +
        groupDetails +
        `• Any empty legacy categories left from the previous layout\n\n` +
        `**Preserved Discord channels:** \`#bot-commands\` and \`#tournament-log\` stay in MANAGEMENT.\n\n` +
        `🛡️ **Preserved Data:**\n` +
        `Tournament records, registered teams, round configurations, 25-slot group allocations, results, and qualifications in MongoDB are **NOT deleted** and will remain completely preserved.\n\n` +
        `*(You can recreate the channel structure at any time by clicking **Create Channels**)*\n` +
        `⏱️ **This confirmation prompt will expire in 30 seconds.**`;

      await interaction.editReply({ content: promptText, components: [confirmRow], embeds: [] }).catch(() => {});
      return;
    }

    // Action: Cancel Delete
    if (action === 'cancel_delete') {
      if (typeof interaction.editReply === 'function') {
        await interaction.editReply({
          content: 'ℹ️ **Deletion Cancelled:** All tournament channels and configuration remain intact.',
          components: [],
        });
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: 'ℹ️ **Deletion Cancelled:** All tournament channels and configuration remain intact.',
          ephemeral: true,
        });
      }
      return;
    }

    // Action: Confirm Delete
    if (action === 'confirm_delete') {
      let saved = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
      if (!saved && isMongoConnected()) {
        try {
          saved = await getTournamentFromDb(guild.id, tournamentId);
        } catch {}
      }

      if (!saved || (saved.setupStatus === 'pending_channels' && !saved.categoryId && Object.values(saved.channels || {}).every(c => !c))) {
        const msg = '⚠️ **Notice:** This tournament has no active Discord channels or they were already deleted.';
        if (typeof interaction.editReply === 'function' && (interaction.deferred || interaction.replied)) {
          await interaction.editReply({ content: msg, components: [] });
        } else if (typeof interaction.update === 'function') {
          await interaction.update({ content: msg, components: [] });
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: msg, ephemeral: true });
        }
        return;
      }

      if (typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: '⏳ **Deleting tournament channels, ID/PWD channels, and category...**', components: [] });
      }

      const deletionSummary = await deleteTournamentDiscordChannels(guild, tournamentId);

      await recordAuditLog(guild.id, 'DELETE_ALL_CHANNELS', {
        tournamentId,
        deletedChannelsCount: deletionSummary.deletedChannels.length,
        categoryDeleted: deletionSummary.categoryDeleted,
        adminId: interaction.user.id,
      }).catch(() => {});

      const resultMsg = `🗑️ **Tournament Channels Cleanup Complete:**\n` +
        `• **Deleted Channels (${deletionSummary.deletedChannels.length}):** ${deletionSummary.deletedChannels.length > 0 ? deletionSummary.deletedChannels.map(n => `\`#${n}\``).join(', ') : 'None'}\n` +
        `• **Category Deleted:** ${deletionSummary.categoryDeleted ? 'Yes' : 'No'}\n` +
        `• **Status:** \`pending_channels\`\n\n` +
        `🛡️ **Tournament Data Preserved:**\n` +
        `Website registrations, round structures, 25-slot team allocations, match results, and qualifications remain completely intact in MongoDB.\n` +
        `💡 Click **Create Channels** in the tournament management panel whenever you wish to restore the channels.`;

      // Update dashboard message after channel deletion
      try {
        const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId).catch(() => null);
        if (backendData?.tournament) {
          await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, botMember);
        }
      } catch (dashErr) {
        console.warn('[Discord Bot] Could not refresh dashboard after channels deletion:', dashErr.message);
      }

      if (typeof interaction.followUp === 'function') {
        await interaction.followUp({ content: resultMsg, ephemeral: true });
      } else if (typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: resultMsg });
      }
      return;
    }

    // Action: Delete Tournament Prompt (Permanent)
    if (action === 'delete_permanent') {
      await handlePermanentTournamentDeletePrompt(interaction, tournamentId);
      return;
    }

    // Action: Confirm Delete Tournament (Permanent)
    if (action === 'confirm_delete_permanent') {
      await handleConfirmPermanentTournamentDelete(interaction, tournamentId);
      return;
    }

    // Action: Cancel Delete Tournament (Permanent)
    if (action === 'cancel_delete_permanent') {
      if (typeof interaction.editReply === 'function' && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({
          content: 'ℹ️ **Permanent Deletion Cancelled:** Tournament and all associated channels remain intact.',
          components: [],
        });
      } else if (typeof interaction.update === 'function') {
        await interaction.update({
          content: 'ℹ️ **Permanent Deletion Cancelled:** Tournament and all associated channels remain intact.',
          components: [],
        });
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: 'ℹ️ **Permanent Deletion Cancelled:** Tournament and all associated channels remain intact.',
          ephemeral: true,
        });
      }
      return;
    }
  }

/**
 * Renders the dedicated View Rounds Screen listing all rounds in numerical order.
 */
export async function handleViewRoundsScreen(interaction, tournamentId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    const notInitMsg = `❌ Tournament \`${tournamentId}\` is not initialized.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: notInitMsg, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: notInitMsg, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: notInitMsg, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const rounds = Object.values(savedTournament.rounds || {});
  const sortedRounds = [...rounds].sort((a, b) => {
    const numA = a.roundNumber || parseInt(String(a.name).replace(/\D+/g, '') || '0', 10);
    const numB = b.roundNumber || parseInt(String(b.name).replace(/\D+/g, '') || '0', 10);
    return numA - numB;
  });

  const activeRounds = sortedRounds.filter((r) => r.status === 'Active' || r.status === 'Started');
  const draftRounds = sortedRounds.filter((r) => r.status === 'Draft');
  const completedRounds = sortedRounds.filter((r) => r.status === 'Completed');

  const embed = new EmbedBuilder()
    .setTitle(`📋 Tournament Rounds — ${savedTournament.tournamentTitle || 'Tournament'}`)
    .setColor(0x3b82f6)
    .setDescription(
      `Manage tournament rounds, sequential progression, group slots, and match allocations.\n` +
      `**Tournament ID:** \`${tournamentId}\`\n\n` +
      `• **Active Rounds:** **${Math.min(activeRounds.length, 1)}** (Single Active Round Policy)\n` +
      `• **Draft Rounds:** **${draftRounds.length}** | **Completed Rounds:** **${completedRounds.length}**`
    )
    .setTimestamp();

  if (sortedRounds.length === 0) {
    embed.addFields({
      name: '📋 Existing Rounds',
      value: '⚠️ *No rounds have been created for this tournament yet.*\nClick **Create Round** below to create Round 1.',
      inline: false,
    });
  } else {
    let roundsText = '';
    for (const r of sortedRounds) {
      let statusEmoji = '🟡';
      if (r.status === 'Active' || r.status === 'Started') statusEmoji = '🟢';
      else if (r.status === 'Completed') statusEmoji = '🏁';

      let allocatedTeams = 0;
      if (Array.isArray(r.groups)) {
        for (const g of r.groups) {
          allocatedTeams += (g.slots || []).filter((s) => s.status === 'OCCUPIED').length;
        }
      }

      roundsText +=
        `• ${statusEmoji} **${r.name}** (\`${r.roundId}\`)\n` +
        `  └ **Status:** **${r.status}** | **Groups:** **${r.groups?.length || 0}** | **Teams/Group:** **${r.teamsPerGroup || 16}** | **Allocated:** **${allocatedTeams}**\n`;
    }
    embed.addFields({
      name: `📋 Existing Rounds (${sortedRounds.length})`,
      value: roundsText.slice(0, 1024),
      inline: false,
    });
  }

  const components = [];

  // Round Selection Menu if rounds exist
  if (sortedRounds.length > 0) {
    const selectOptions = sortedRounds.slice(0, 25).map((r) => {
      let emoji = '🟡';
      if (r.status === 'Active' || r.status === 'Started') emoji = '🟢';
      else if (r.status === 'Completed') emoji = '🏁';

      let allocatedTeams = 0;
      if (Array.isArray(r.groups)) {
        for (const g of r.groups) {
          allocatedTeams += (g.slots || []).filter((s) => s.status === 'OCCUPIED').length;
        }
      }

      return new StringSelectMenuOptionBuilder()
        .setLabel(r.name.slice(0, 100))
        .setValue(r.roundId)
        .setDescription(`Status: ${r.status} | Groups: ${r.groups?.length || 0} | Teams/Group: ${r.teamsPerGroup || 16} | Teams: ${allocatedTeams}`.slice(0, 100))
        .setEmoji(emoji);
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`md_tour_select_round_menu:${tournamentId}`)
      .setPlaceholder('Select a round to manage...')
      .addOptions(selectOptions);

    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  // Action Buttons
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_tour_create_round:${tournamentId}`)
      .setLabel('Create Round')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('dash:rounds:refresh')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('dash:rounds:back')
      .setLabel('Back to Dashboard')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(buttonRow);

  if (interaction.deferred) {
    await interaction.editReply({ content: null, embeds: [embed], components }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: null, embeds: [embed], components }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [embed], components, ephemeral: true }).catch(() => {});
  }
}

/**
 * Creates the next sequential round (Round 1, Round 2, Round 3, etc.) in Draft state.
 */
export async function handleCreateSequentialRound(interaction, tournamentId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately before performing state transitions
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    const errText = `❌ Tournament \`${tournamentId}\` is not initialized.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: errText, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: errText, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!savedTournament.rounds) {
    savedTournament.rounds = {};
  }

  const existingRounds = Object.values(savedTournament.rounds);
  let maxNum = 0;
  for (const r of existingRounds) {
    const num = r.roundNumber || parseInt(String(r.name).replace(/\D+/g, '') || '0', 10);
    if (num > maxNum) maxNum = num;
  }

  const nextNum = maxNum + 1;
  const candidateRoundId = `r${nextNum}`;
  const roundName = `Round ${nextNum}`;

  const newRound = {
    roundId: candidateRoundId,
    roundNumber: nextNum,
    name: roundName,
    tournamentId,
    status: 'Draft',
    notes: '',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    groups: [],
    summaryMessageIds: [],
  };

  savedTournament.rounds[candidateRoundId] = newRound;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);
  await sendTournamentManagementLog(guild, savedTournament, newRound, 'Round created', interaction.member);

  // Update View Rounds Screen in place immediately
  await handleViewRoundsScreen(interaction, tournamentId);

  // Background refresh of main control panel (non-blocking)
  fetchTournamentRegistrationsFromBackend(tournamentId)
    .then((backendData) => setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me))
    .catch((err) => console.warn('[Discord Bot] Control panel background refresh warning after round create:', err.message));
}

/**
 * Opens the dedicated management view for an individual selected round.
 */
export async function handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, notice = null) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    const errText = notice || `❌ Round \`${roundId}\` was not found.`;
    if (interaction.deferred) {
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dash:round:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('dash:round:back').setLabel('Back to Rounds').setEmoji('📋').setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({ content: errText, embeds: [], components: [navRow] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: errText, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: errText, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const isActive = round.status === 'Active' || round.status === 'Started';
  const isCompleted = round.status === 'Completed';

  let statusEmoji = '🟡';
  let embedColor = 0xeab308; // Gold
  if (isActive) {
    statusEmoji = '🟢';
    embedColor = 0x22c55e; // Green
  } else if (isCompleted) {
    statusEmoji = '🏁';
    embedColor = 0x64748b; // Slate
  }

  let totalAllocatedTeams = 0;
  let groupsDetailText = '• *No groups have been allocated yet.*';
  if (Array.isArray(round.groups) && round.groups.length > 0) {
    const lines = [];
    for (const g of round.groups) {
      const occupied = (g.slots || []).filter((s) => s.status === 'OCCUPIED').length;
      totalAllocatedTeams += occupied;
      const chMention = g.channelId ? `<#${g.channelId}>` : `#${g.channelName}`;
      const roleMention = g.roleId ? `<@&${g.roleId}>` : `@${g.roleName}`;
      lines.push(`• **Group ${g.groupNumber}:** ${chMention} | ${roleMention} (${occupied}/16 teams)`);
    }
    groupsDetailText = lines.slice(0, 10).join('\n');
    if (lines.length > 10) groupsDetailText += `\n*...and ${lines.length - 10} more groups.*`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Round Management: ${round.name}`)
    .setColor(embedColor)
    .setDescription(
      `Manage configuration, allocation, match credentials, and status for **${round.name}**.\n` +
      `**Tournament:** ${savedTournament.tournamentTitle || tournamentId} (\`${tournamentId}\`)\n` +
      `**Round ID:** \`${round.roundId}\``
    )
    .addFields(
      {
        name: '📋 Round Status & Details',
        value:
          `• **Status:** ${statusEmoji} **${round.status}**\n` +
          `• **Stage Notes:** ${round.notes || '*None*'}\n` +
          `• **Created:** <t:${Math.floor(new Date(round.createdAt).getTime() / 1000)}:R>\n` +
          `• **Started:** ${round.startedAt ? `<t:${Math.floor(new Date(round.startedAt).getTime() / 1000)}:R>` : '*Not started*'}\n` +
          `• **Completed:** ${round.completedAt ? `<t:${Math.floor(new Date(round.completedAt).getTime() / 1000)}:R>` : '*N/A*'}`,
        inline: false,
      },
      {
        name: '👥 Groups & Slot Allocation',
        value:
          `• **Total Groups:** **${round.groups?.length || 0}**\n` +
          `• **Configured Capacity:** **${round.teamsPerGroup || 16}** teams per group\n` +
          `• **Teams Allocated:** **${totalAllocatedTeams}**\n` +
          `• **Qualified from this Round:** **${(round.qualifications || []).length}** 🏆\n` +
          `• **Capacity Policy:** 25 slots per group (Slots 01-02 LOCKED, Slots 03 to ${2 + (round.teamsPerGroup || 16)} Teams, Remaining Slots UNUSED)\n` +
          `${groupsDetailText}`,
        inline: false,
      }
    )
    .setTimestamp();

  // Action Buttons:
  // Row 1 (4 actions): Edit, Delete, Start, Qualify
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_edit:${tournamentId}:${round.roundId}`)
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_round_delete:${tournamentId}:${round.roundId}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isActive),
    new ButtonBuilder()
      .setCustomId(`md_round_start:${tournamentId}:${round.roundId}`)
      .setLabel('Start')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isActive || isCompleted),
    new ButtonBuilder()
      .setCustomId(`md_round_qualify:${tournamentId}:${round.roundId}`)
      .setLabel('Qualify')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Success)
  );

  // Row 2: Refresh the current screen and navigate back.
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('dash:round:refresh')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('dash:round:back')
      .setLabel('Back to Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('dash:round:home')
      .setLabel('Back to Dashboard')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const groupMessagesOpen = round.groupMessagesOpen === true;
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dash:round:submit-results:${round.roundId}`)
      .setLabel(`Submit Results: ${groupMessagesOpen ? 'ON' : 'OFF'}`)
      .setEmoji(groupMessagesOpen ? '🟢' : '🔴')
      .setStyle(groupMessagesOpen ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`dash:round:announcement:${round.roundId}`)
      .setLabel('Announcement Message')
      .setEmoji('📢')
      .setStyle(ButtonStyle.Primary)
  );

  if (interaction.deferred) {
    await interaction.editReply({ content: notice, embeds: [embed], components: [row1, row2, row3] }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: notice, embeds: [embed], components: [row1, row2, row3] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [embed], components: [row1, row2, row3], ephemeral: true }).catch(() => {});
  }
}

async function handleToggleRoundGroupMessages(interaction, tournamentId, roundId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  try {
    const guild = interaction.guild;
    const access = checkTournamentAccess(guild, interaction.member);
    const savedTournament = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
    const round = savedTournament?.rounds?.[roundId];
    if (!access.allowed) throw new Error(access.reason);
    if (!round) throw new Error(`Round \`${roundId}\` was not found.`);
    if (!Array.isArray(round.groups) || round.groups.length === 0) throw new Error('No groups are allocated in this round.');

    const wasOpen = round.groupMessagesOpen === true;
    const shouldOpen = !wasOpen;
    const changedGroups = [];
    try {
      for (const group of round.groups) {
        if (!group.roleId || !group.channelId) throw new Error(`Group ${group.groupNumber} is missing its role or channel.`);
        const channel = guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null);
        if (!channel?.permissionOverwrites?.edit) throw new Error(`The channel for Group ${group.groupNumber} could not be found.`);
        await channel.permissionOverwrites.edit(group.roleId, { SendMessages: shouldOpen });
        changedGroups.push({ channel, roleId: group.roleId });
      }
    } catch (error) {
      await Promise.allSettled(changedGroups.map(({ channel, roleId }) => channel.permissionOverwrites.edit(roleId, { SendMessages: wasOpen })));
      throw error;
    }

    round.groupMessagesOpen = shouldOpen;
    guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
    saveGuildSettings(guildSettingsCache);
    try {
      await saveTournamentToDb(guild.id, tournamentId, savedTournament);
    } catch (error) {
      round.groupMessagesOpen = wasOpen;
      saveGuildSettings(guildSettingsCache);
      await Promise.allSettled(changedGroups.map(({ channel, roleId }) => channel.permissionOverwrites.edit(roleId, { SendMessages: wasOpen })));
      throw error;
    }
    await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, `✅ Group messaging is now **${shouldOpen ? 'ON' : 'OFF'}** for this round.`);
  } catch (error) {
    console.error(`[Discord Bot] Failed to toggle group messaging for ${tournamentId}/${roundId}:`, error);
    await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, `❌ Could not update Submit Results: ${error.message}`);
  }
}

async function handleRoundAnnouncementSubmit(interaction, tournamentId, roundId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  try {
    const guild = interaction.guild;
    const access = checkTournamentAccess(guild, interaction.member);
    if (!access.allowed) throw new Error(access.reason);
    const savedTournament = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
    const round = savedTournament?.rounds?.[roundId];
    if (!round) throw new Error(`Round \`${roundId}\` was not found.`);
    if (!Array.isArray(round.groups) || round.groups.length === 0) throw new Error('No groups are allocated in this round.');
    const announcement = interaction.fields?.getTextInputValue('announcement_text')?.trim();
    if (!announcement) throw new Error('Announcement text cannot be empty.');

    const failures = [];
    for (const group of round.groups) {
      if (!group.channelId || !group.roleId) {
        failures.push(`Group ${group.groupNumber} is missing its channel or role.`);
        continue;
      }
      const channel = guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null);
      if (!channel?.send) {
        failures.push(`The channel for Group ${group.groupNumber} could not be found.`);
        continue;
      }
      try {
        await channel.send({
          content: `${announcement}\n\n<@&${group.roleId}>`,
          allowedMentions: { parse: [], roles: [group.roleId] },
        });
      } catch (error) {
        failures.push(`Group ${group.groupNumber}: ${error.message}`);
      }
    }
    const notice = failures.length
      ? `⚠️ Announcement sent with errors: ${failures.join(' • ')}`
      : `✅ Announcement sent to all ${round.groups.length} group channels.`;
    await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, notice);
  } catch (error) {
    console.error(`[Discord Bot] Failed to send round announcement for ${tournamentId}/${roundId}:`, error);
    await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, `❌ Could not send announcement: ${error.message}`);
  }
}

/**
 * Handles Start Round prompt from individual round menu.
 * Enforces Single Active Round Rule preview.
 */
export async function handlePromptStartRound(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    const notFound = `❌ Round \`${roundId}\` was not found.`;
    if (typeof interaction.update === 'function') {
      await interaction.update({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: notFound, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (round.status === 'Active' || round.status === 'Started') {
    const alreadyMsg = `⚠️ **${round.name}** is already **Active**.\nTo reconcile participant roles, use **Refresh Tournament Data**.`;
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: alreadyMsg, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Check if another round is currently Active
  const existingActive = Object.values(savedTournament.rounds || {}).find(
    (r) => (r.status === 'Active' || r.status === 'Started') && r.roundId !== roundId
  );

  let activeWarning = '';
  if (existingActive) {
    activeWarning = `⚠️ **Single Active Round Rule:**\n` +
      `**${existingActive.name}** (\`${existingActive.roundId}\`) is currently **Active**.\n` +
      `Starting **${round.name}** will automatically transition **${existingActive.name}** to **Completed**.\n\n`;
  }

  const precedingRounds = Object.values(savedTournament.rounds || {})
    .filter((r) => (r.roundNumber || 0) < (round.roundNumber || 1))
    .sort((a, b) => (b.roundNumber || 0) - (a.roundNumber || 0));
  const prevRound = precedingRounds[0];
  const hasPrevQuals = prevRound && Array.isArray(prevRound.qualifications) && prevRound.qualifications.length > 0;

  const capacity = Math.min(Math.max(round.teamsPerGroup || 16, 1), 23);
  let poolSourceText = '';
  let estimatedGroupsText = '';

  if (hasPrevQuals) {
    const qualCount = prevRound.qualifications.length;
    const calcGroups = Math.ceil(qualCount / capacity) || 1;
    poolSourceText = `• **Allocation Source:** Qualified from **${prevRound.name}** (**${qualCount}** team(s))\n`;
    estimatedGroupsText = `• **Estimated Groups to Provision:** **${calcGroups}** group(s) based on capacity **${capacity}** teams/group\n`;
  } else {
    poolSourceText = `• **Allocation Source:** Verified eligible registrations from MatchDistrict backend\n`;
    estimatedGroupsText = `• **Configured Group Capacity:** **${capacity}** teams/group\n`;
  }

  const promptText = `⚠️ **Confirm Starting ${round.name}**\n\n` +
    activeWarning +
    `This will execute the official tournament allocation workflow:\n` +
    poolSourceText +
    estimatedGroupsText +
    `• **25-Slot Policy:** Slots 01–02 LOCKED, Slots 03–${2 + capacity} Teams, Slots ${3 + capacity}–25 UNUSED\n` +
    `• Create/reuse dedicated group roles and private ID/password channels\n` +
    `• Set strict read-only permissions on group channels for participants\n` +
    `• Assign group roles to verified linked Discord players\n` +
    `• Clean up obsolete group roles from preceding rounds (preserving tournament role)\n` +
    `• Transition **${round.name}** to **Active** status\n` +
    `• Publish allocation summary to <#${savedTournament.channels?.botCommandsId || 'bot-commands'}>\n\n` +
    `Click **Confirm & Start ${round.name}** to proceed.`;

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_confirm_start:${tournamentId}:${round.roundId}`)
      .setLabel(`Confirm & Start ${round.name}`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  if (typeof interaction.update === 'function') {
    await interaction.update({ content: promptText, embeds: [], components: [confirmRow] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ content: promptText, components: [confirmRow], ephemeral: true }).catch(() => {});
  }
}

/**
 * Handles Edit Round button click: opens modal to edit name and stage notes.
 */
export async function handleEditRoundButton(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    const errText = `❌ Round \`${roundId}\` was not found.`;
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: errText, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`md_modal_edit_round:${tournamentId}:${roundId}`)
    .setTitle(`Edit ${round.name}`.slice(0, 45));

  const nameInput = new TextInputBuilder()
    .setCustomId('round_name')
    .setLabel('Round Display Name')
    .setValue(round.name || `Round ${round.roundNumber || 1}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const capacityInput = new TextInputBuilder()
    .setCustomId('teams_per_group')
    .setLabel('Teams Per Group (Capacity 1-23)')
    .setValue(String(round.teamsPerGroup || 16))
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(4);

  const notesInput = new TextInputBuilder()
    .setCustomId('round_notes')
    .setLabel('Round Stage Description / Notes')
    .setValue(round.notes || '')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(capacityInput),
    new ActionRowBuilder().addComponents(notesInput)
  );

  await interaction.showModal(modal).catch(() => {});
}

/**
 * Handles submission of Edit Round modal.
 */
export async function handleEditRoundSubmit(interaction, tournamentId, roundId, newName, capacityStr = '16', newNotes = '') {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    await interaction.reply({ content: `❌ Round \`${roundId}\` was not found.`, ephemeral: true }).catch(() => {});
    return;
  }

  if (!newName) {
    await interaction.reply({ content: '❌ Round name cannot be empty.', ephemeral: true }).catch(() => {});
    return;
  }

  const parsedCap = parseInt(capacityStr, 10);
  if (isNaN(parsedCap) || parsedCap < 1 || parsedCap > 23) {
    await interaction.reply({
      content: '❌ **Teams per group must be a positive integer between 1 and 23** (slots 01–02 are locked in the 25-slot layout).',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // Defer reply immediately so modal submit responds well within 3s deadline
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  round.name = newName;
  round.teamsPerGroup = parsedCap;
  round.notes = newNotes || '';
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  saveTournamentToDb(guild.id, tournamentId, savedTournament);

  const successRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${roundId}`)
      .setLabel(`Manage ${newName}`)
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_rounds:${tournamentId}`)
      .setLabel('Back to Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_tour_back_to_panel:${tournamentId}`)
      .setLabel('Back to Dashboard')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: `✅ Updated **${newName}** (ID: \`${roundId}\`) successfully.`,
    components: [successRow],
  }).catch(() => {});

  // Background refresh of control panel (non-blocking)
  fetchTournamentRegistrationsFromBackend(tournamentId)
    .then((backendData) => setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me))
    .catch((err) => console.warn('[Discord Bot] Control panel background refresh warning after round edit:', err.message));
}

/**
 * Handles Delete Round prompt. Prohibits deletion if round is Active.
 */
export async function handlePromptDeleteRound(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    const notFound = `❌ Round \`${roundId}\` was not found.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: notFound, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (round.status === 'Active' || round.status === 'Started') {
    const warnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_round_back_to_menu:${tournamentId}:${roundId}`)
        .setLabel('Back to Round Menu')
        .setStyle(ButtonStyle.Secondary)
    );
    const msg = `❌ **Cannot Delete Active Round:**\n` +
      `**${round.name}** (\`${round.roundId}\`) is currently **Active**.\n` +
      `Active rounds cannot be deleted while in progress. Please complete the round first before deleting it.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg, embeds: [], components: [warnRow] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: msg, embeds: [], components: [warnRow] }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, components: [warnRow], ephemeral: true }).catch(() => {});
    }
    return;
  }

  const promptText = `⚠️ **Confirm Deletion of ${round.name}**\n` +
    `Are you sure you want to permanently delete **${round.name}** (\`${round.roundId}\`)?\n\n` +
    `• Any group channels and roles for this round will be safely cleaned up.\n` +
    `• Tournament registrations on the website remain untouched.\n\n` +
    `Click **Yes, Delete Round** to confirm.`;

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_confirm_delete:${tournamentId}:${round.roundId}`)
      .setLabel(`Yes, Delete ${round.name}`)
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  if (interaction.deferred) {
    await interaction.editReply({ content: promptText, embeds: [], components: [confirmRow] }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: promptText, embeds: [], components: [confirmRow] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ content: promptText, components: [confirmRow], ephemeral: true }).catch(() => {});
  }
}

/**
 * Handles confirmation and execution of round deletion.
 */
export async function handleConfirmDeleteRound(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately before performing deletion I/O
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    const notFound = `❌ Round \`${roundId}\` was not found.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: notFound, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (round.status === 'Active' || round.status === 'Started') {
    const errMsg = `❌ **Cannot Delete Active Round:** **${round.name}** is currently active.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: errMsg, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: errMsg, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Clean up group channels and group roles for this round
  if (Array.isArray(round.groups)) {
    for (const group of round.groups) {
      if (group.channelId) {
        try {
          const gch = guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null);
          if (gch) await gch.delete('Tournament management: delete round group channel').catch(() => {});
        } catch {}
      }
      if (group.voiceChannelId) {
        try {
          const voice = guild.channels.cache.get(group.voiceChannelId) || await guild.channels.fetch(group.voiceChannelId).catch(() => null);
          if (voice) await voice.delete('Tournament management: delete round group voice channel').catch(() => {});
        } catch {}
      }
      if (group.roleId && guild.roles) {
        try {
          const gr = guild.roles.cache.get(group.roleId) || await guild.roles.fetch(group.roleId).catch(() => null);
          if (gr && typeof gr.delete === 'function') {
            await gr.delete('Tournament management: delete round group role').catch(() => {});
          }
        } catch {}
      }
    }
  }

  if (round.categoryId) {
    const roundCategory = guild.channels.cache.get(round.categoryId) || await guild.channels.fetch(round.categoryId).catch(() => null);
    if (roundCategory?.type === ChannelType.GuildCategory) {
      for (const child of guild.channels.cache.filter((channel) => channel.parentId === roundCategory.id).values()) {
        await child.delete('Tournament management: delete round category channel').catch(() => {});
      }
      await roundCategory.delete('Tournament management: delete round category').catch((err) => {
        console.warn(`[Discord Bot] Could not delete round category ${round.categoryId}:`, err.message);
      });
    }
  }

  delete savedTournament.rounds[roundId];
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);

  await recordAuditLog(guild.id, 'ROUND_DELETED', {
    tournamentId,
    roundId,
    roundName: round.name,
    adminId: interaction.member?.id,
    adminTag: interaction.member?.user?.tag,
  }).catch(() => {});
  await sendTournamentManagementLog(guild, savedTournament, round, 'Round deleted', interaction.member);

  // Navigate back to View Rounds screen immediately
  await handleViewRoundsScreen(interaction, tournamentId);

  // Background refresh of control panel (non-blocking)
  fetchTournamentRegistrationsFromBackend(tournamentId)
    .then((backendData) => setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me))
    .catch((err) => console.warn('[Discord Bot] Control panel background refresh warning after round delete:', err.message));
}

/**
 * Displays the 25-slot layout and allocation details for a selected round.
 */
export async function handleViewRoundAllocation(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    const notFound = `❌ Round \`${roundId}\` was not found.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: notFound, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: notFound, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!Array.isArray(round.groups) || round.groups.length === 0) {
    const noGroupsMsg = `⚠️ Round **${round.name}** has no groups allocated yet. Start the round to perform slot allocation.`;
    if (interaction.deferred) {
      await interaction.editReply({ content: noGroupsMsg, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: noGroupsMsg, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Format allocation embed
  const embed = new EmbedBuilder()
    .setTitle(`📋 Slot Allocation: ${round.name}`)
    .setColor(0x3b82f6)
    .setDescription(
      `**Tournament:** ${savedTournament.tournamentTitle || tournamentId}\n` +
      `**Status:** **${round.status}** | **Groups:** ${round.groups.length}`
    )
    .setTimestamp();

  for (const group of round.groups.slice(0, 5)) {
    let groupText = '';
    for (let slotNumber = 1; slotNumber <= 25; slotNumber++) {
      const slot = (group.slots || []).find((item) => Number(item.slotNumber) === slotNumber);
      if (slotNumber <= 2 || slot?.status === 'LOCKED') groupText += `Slot ${String(slotNumber).padStart(2, '0')} → 🔒 LOCKED\n`;
      else if (slot?.status === 'OCCUPIED' && slot.teamName) groupText += `Slot ${String(slotNumber).padStart(2, '0')} → ${slot.teamName}\n`;
    }
    const chMention = group.channelId ? `<#${group.channelId}>` : `#${group.channelName}`;
    const roleMention = group.roleId ? `<@&${group.roleId}>` : `@${group.roleName}`;
    embed.addFields({
      name: `⚔️ Group ${group.groupNumber} (${chMention} | ${roleMention})`,
      value: groupText.slice(0, 1024) || 'No slots',
      inline: false,
    });
  }

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${roundId}`)
      .setLabel('Back to Round Menu')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_rounds:${tournamentId}`)
      .setLabel('Back to Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary)
  );

  if (interaction.deferred) {
    await interaction.editReply({ content: null, embeds: [embed], components: [backRow] }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: null, embeds: [embed], components: [backRow] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [embed], components: [backRow], ephemeral: true }).catch(() => {});
  }
}

/**
 * Returns to the main tournament control panel view.
 */
export async function handleBackToTournamentPanel(interaction, tournamentId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately before fetching backend data or channels
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  try {
    const currentSettings = guildSettingsCache[guild.id] || {};
    const savedTournament = currentSettings.tournaments?.[tournamentId] || {};

    // Parallelize backend fetch and channel fetches concurrently
    const [backendData] = await Promise.all([
      fetchTournamentRegistrationsFromBackend(tournamentId),
      (async () => {
        const expectedChannels = [
          savedTournament.categoryId,
          savedTournament.channels?.tournamentUpdateId,
          savedTournament.channels?.tournamentTeamsId,
          savedTournament.channels?.tournamentLogId,
          savedTournament.channels?.tournamentHelpdeskId,
          savedTournament.channels?.tournamentRegisterId,
          savedTournament.channels?.roomMakerVcId,
        ].filter(Boolean);
        const uncachedIds = expectedChannels.filter((id) => !guild.channels.cache.has(id));
        if (uncachedIds.length > 0) {
          await Promise.allSettled(uncachedIds.map((chId) => guild.channels.fetch(chId).catch(() => null)));
        }
      })(),
    ]);

    const { tournament, summary } = backendData;

    const botCommandsChannel = savedTournament.channels?.botCommandsId
      ? guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null)
      : null;
    const channelsStatus = await buildTournamentChannelStatus(guild, savedTournament, botCommandsChannel);

    let roleInfo = null;
    if (savedTournament.roleId) {
      const role = guild.roles.cache.get(savedTournament.roleId) ||
        await guild.roles.fetch(savedTournament.roleId).catch(() => null);
      if (role) {
        const members = await guild.members.fetch().catch((err) => {
          console.warn(`[Discord Bot] Could not refresh tournament role member count:`, err.message);
          return null;
        });
        const roleStats = savedTournament.roleSyncStats || {};
        roleInfo = {
          roleId: role.id,
          roleName: role.name,
          membersWithRole: members ? Array.from(members.values()).filter((member) => member.roles?.cache?.has(role.id)).length : 0,
          statusText: roleStats.status === 'failed'
            ? `🔴 Failed: ${roleStats.error || 'See bot logs for details.'}`
            : roleStats.status === 'successful'
              ? `🟢 Synchronized (${roleStats.assigned ?? 0} assigned, ${roleStats.removed ?? 0} removed, ${roleStats.skipped ?? 0} skipped)`
              : '🟡 Pending Sync',
          lastSyncedAt: savedTournament.roleLastSyncedAt || null,
        };
      }
    }

    const embed = buildTournamentControlPanelEmbed(tournament, summary, channelsStatus, roleInfo, savedTournament.rounds || {});
    const buttons = buildTournamentControlPanelButtons(tournamentId);

    if (interaction.deferred) {
      await interaction.editReply({ content: null, embeds: [embed], components: buttons }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: null, embeds: [embed], components: buttons }).catch(() => {});
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply({ embeds: [embed], components: buttons, ephemeral: true }).catch(() => {});
    }
  } catch (err) {
    const errorMsg = `❌ **Failed to load tournament panel:** ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: errorMsg, embeds: [], components: [] }).catch(() => {});
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles round creation submission from modal.
 */
export async function handleCreateRoundSubmit(interaction, tournamentId, roundName, teamsPerGroupStr = '16') {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  if (!roundName) {
    await interaction.reply({ content: '❌ **Round name cannot be empty.**', ephemeral: true }).catch(() => {});
    return;
  }

  const parsedCapacity = parseInt(teamsPerGroupStr, 10);
  if (isNaN(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 23) {
    await interaction.reply({
      content: '❌ **Teams per group must be a positive integer between 1 and 23** (slots 01–02 are locked for coordinators in the 25-slot layout).',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    await interaction.reply({ content: `❌ Tournament with ID \`${tournamentId}\` is not initialized.`, ephemeral: true }).catch(() => {});
    return;
  }

  if (!savedTournament.rounds) {
    savedTournament.rounds = {};
  }

  const existingRounds = Object.values(savedTournament.rounds);
  const match = roundName.match(/round\s*(\d+)/i);
  let roundNum = match ? parseInt(match[1], 10) : existingRounds.length + 1;
  let candidateRoundId = `r${roundNum}`;

  // Duplicate check: Prevent duplicate round creation when same request is submitted twice or round with same name exists in Draft
  const duplicateDraft = existingRounds.find(
    (r) =>
      r.status === 'Draft' &&
      (r.name.toLowerCase() === roundName.toLowerCase() || r.roundId === candidateRoundId)
  );

  // Defer reply immediately so modal submit responds within 3s deadline
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  if (duplicateDraft) {
    await interaction.editReply({
      content: `⚠️ A round named **${duplicateDraft.name}** (ID: \`${duplicateDraft.roundId}\`) already exists in **Draft** status. Duplicate round creation prevented.`,
    }).catch(() => {});
    return;
  }

  if (savedTournament.rounds[candidateRoundId]) {
    candidateRoundId = `r${roundNum}_${Date.now().toString(36).slice(-4)}`;
  }

  const newRound = {
    roundId: candidateRoundId,
    roundNumber: roundNum,
    name: roundName,
    tournamentId,
    teamsPerGroup: parsedCapacity,
    status: 'Draft',
    notes: '',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    groups: [],
    qualifications: [],
    summaryMessageIds: [],
  };

  savedTournament.rounds[candidateRoundId] = newRound;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  saveTournamentToDb(guild.id, tournamentId, savedTournament);

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${candidateRoundId}`)
      .setLabel(`Manage ${roundName}`)
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_rounds:${tournamentId}`)
      .setLabel('Back to Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_tour_back_to_panel:${tournamentId}`)
      .setLabel('Back to Dashboard')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: `✅ Created **${roundName}** (ID: \`${candidateRoundId}\`) with capacity **${parsedCapacity}** teams/group in status **Draft**.\n` +
      `Click **Manage ${roundName}** when you are ready to review allocations and start the round.`,
    components: [actionRow],
  }).catch(() => {});

  // Background refresh of Control Panel embed (non-blocking)
  fetchTournamentRegistrationsFromBackend(tournamentId)
    .then((backendData) => setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me))
    .catch((err) => console.warn(`[Discord Bot] Control panel refresh warning after round create:`, err.message));
}

/**
 * Handles Start Round button click: presents draft rounds or confirmation prompt.
 */
export async function handleStartRoundButton(interaction, tournamentId) {
  const guild = interaction.guild;
  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];

  if (!savedTournament) {
    await interaction.reply({ content: `❌ Tournament \`${tournamentId}\` is not initialized.`, ephemeral: true }).catch(() => {});
    return;
  }

  const rounds = Object.values(savedTournament.rounds || {});
  const draftRounds = rounds.filter((r) => r.status === 'Draft');
  const startedRounds = rounds.filter((r) => r.status === 'Started');

  if (rounds.length === 0) {
    await interaction.reply({
      content: `⚠️ No rounds have been created for this tournament yet. Click **Create Round** first.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  if (draftRounds.length === 0) {
    const startedList = startedRounds.map((r) => `• **${r.name}** (\`${r.roundId}\`): ${r.groups?.length || 0} group(s)`).join('\n');
    await interaction.reply({
      content: `⚠️ **All created rounds have already started:**\n${startedList}\n\n` +
        `To create another round, click **Create Round**. To update teams or credentials for started rounds, use **Refresh Tournament Data** or \`.cred\`.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  if (draftRounds.length === 1) {
    const targetRound = draftRounds[0];
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_tour_confirm_start:${tournamentId}:${targetRound.roundId}`)
        .setLabel(`Confirm & Start ${targetRound.name}`)
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`md_tour_cancel_start:${tournamentId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    const promptText = `⚠️ **Confirm Starting ${targetRound.name}**\n` +
      `This will execute the official allocation workflow:\n` +
      `• Fetch latest verified registrations from MatchDistrict backend\n` +
      `• Divide eligible teams into groups of 16 across 25 slots (Slots 01-02 LOCKED, Slots 03-18 Teams, Slots 19-25 UNUSED)\n` +
      `• Create/reuse dedicated group roles and private ID/password channels\n` +
      `• Assign group roles to verified linked Discord players\n` +
      `• Publish allocation summary to <#${savedTournament.channels?.botCommandsId || 'bot-commands'}>\n\n` +
      `Click **Confirm & Start ${targetRound.name}** to commit the allocation.`;

    await interaction.reply({ content: promptText, components: [confirmRow], ephemeral: true }).catch(() => {});
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`md_tour_select_start_round:${tournamentId}`)
    .setPlaceholder('Select a draft round to start...')
    .addOptions(
      draftRounds.slice(0, 25).map((r) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(r.name)
          .setValue(r.roundId)
          .setDescription(`Status: Draft | Created: ${new Date(r.createdAt).toLocaleDateString()}`)
      )
    );

  const row = new ActionRowBuilder().addComponents(menu);
  await interaction.reply({
    content: '📋 **Select which draft round to start:**',
    components: [row],
    ephemeral: true,
  }).catch(() => {});
}

/**
 * Handles confirmation and execution of Start Round.
 */
export async function handleConfirmStartRound(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const member = interaction.member;
  const botMember = guild.members.me;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch((ackError) => {
      console.warn(`[Discord Bot] Could not acknowledge start-round interaction ${interaction.id}:`, ackError.message);
    });
  }

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.followUp === 'function') {
      await interaction.followUp({ content: access.reason, ephemeral: true }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ content: access.reason });
    }
    return;
  }

  try {
    await withTournamentLock(tournamentId, async () => {
      const currentSettings = guildSettingsCache[guild.id] || {};
      const savedTournament = currentSettings.tournaments?.[tournamentId];
      if (!savedTournament) {
        throw new Error(`Tournament "${tournamentId}" is not configured in this server.`);
      }

      const round = savedTournament.rounds?.[roundId];
      if (!round) {
        throw new Error(`Round "${roundId}" was not found.`);
      }

      // Prevent duplicate allocations if button is clicked again
      if (round.status === 'Active' || round.status === 'Started') {
        const msg = `⚠️ **${round.name}** has already been started with **${round.groups?.length || 0}** groups.\n` +
          `Automatic duplicate allocation was prevented. Use **Refresh Tournament Data** if you need to reconcile participant roles.`;
        await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, msg);
        return;
      }

      // Fetch latest registrations from backend
      const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
      const { tournament, teams, summary } = backendData;

      // Determine eligible allocation pool: derived from preceding round's qualifications if present, otherwise live backend registrations
      const precedingRounds = Object.values(savedTournament.rounds || {})
        .filter((r) => (r.roundNumber || 0) < (round.roundNumber || 1))
        .sort((a, b) => (b.roundNumber || 0) - (a.roundNumber || 0));
      const prevRound = precedingRounds[0];
      const hasPrevQuals = prevRound && Array.isArray(prevRound.qualifications) && prevRound.qualifications.length > 0;

      let eligibleTeams = [];
      if (hasPrevQuals) {
        // Derive eligible pool from preceding round's qualified teams
        for (const qual of prevRound.qualifications) {
          qual.destinationRoundId = round.roundId;
          eligibleTeams.push({
            id: qual.teamId,
            team_id: qual.teamId,
            team_name: qual.teamName,
            is_eligible: true,
            members: qual.members || [],
            linked_members: qual.members || [],
            leader: qual.members?.[0] || null,
            sourceRoundId: qual.sourceRoundId,
            sourceGroupId: qual.sourceGroupId,
            sourceSlot: qual.sourceSlot,
          });
        }
      } else {
        eligibleTeams = (Array.isArray(teams) ? teams : []).filter((t) => t.is_eligible);
      }

      if (eligibleTeams.length === 0) {
        throw new Error(
          hasPrevQuals
            ? `No qualified teams found from "${prevRound?.name || 'preceding round'}". Cannot start round without eligible teams.`
            : `No eligible registered teams found for tournament "${tournament.title}". Cannot allocate empty round.`
        );
      }

      // Group & Slot Allocation Rules:
      // Configured capacity per group (default 16, max 23 in 25-slot layout)
      const ASSIGNABLE_SLOTS_PER_GROUP = Math.min(Math.max(round.teamsPerGroup || 16, 1), 23);
      round.teamsPerGroup = ASSIGNABLE_SLOTS_PER_GROUP;
      const groupCount = Math.ceil(eligibleTeams.length / ASSIGNABLE_SLOTS_PER_GROUP) || 1;

      // Ensure canonical category exists
      let category = null;
      if (savedTournament.categoryId) {
        category = guild.channels.cache.get(savedTournament.categoryId) ||
          await guild.channels.fetch(savedTournament.categoryId).catch(() => null);
      }
      if (!category) {
        throw new Error(`Tournament category not found. Please click "Create Channels" first.`);
      }

      const tourRole = savedTournament.roleId ? guild.roles.cache.get(savedTournament.roleId) : null;
      const { tourneyModRole: modsRole } = await ensureManagementDashboardRoles(guild, savedTournament, botMember);
      const roundNum = round.roundNumber || 1;
      const tourPrefix = normalizeTournamentRoleName(tournament.title, tournament.id);
      round.categoryId = null;
      const roundCategory = category;

      const groups = [];
      let totalAssignedMembers = 0;
      let unlinkedTeamsCount = 0;
      const newAssignedGroupMembers = new Map(); // discordId -> Set of roleIds in this round

      for (let g = 1; g <= groupCount; g++) {
        const groupId = `${round.roundId}_g${g}`;
        const groupNumber = g;
        const roleName = `${tournament.title} R${roundNum} G${g}`.slice(0, 100);
        const altRoleName = `${tourPrefix}-r${roundNum}-g${g}`;
        const channelName = sanitizeChannelName(`${tourPrefix}-r${roundNum}-g${g}`);

        // 1. Create or reuse group role (no admin permissions)
        let groupRole = null;
        const existingGroup = (round.groups || []).find((gr) => gr.groupNumber === g);
        if (existingGroup?.roleId && guild.roles) {
          groupRole = guild.roles.cache.get(existingGroup.roleId) ||
            await guild.roles.fetch(existingGroup.roleId).catch(() => null);
        }
        if (!groupRole && guild.roles) {
          groupRole = findInCache(guild.roles.cache, (r) => r.name.toLowerCase() === roleName.toLowerCase() || r.name.toLowerCase() === altRoleName.toLowerCase()) || null;
        }
        if (!groupRole && typeof guild.roles?.create === 'function') {
          groupRole = await queueRoleCreate(guild, {
            name: roleName,
            permissions: [],
            mentionable: false,
            reason: `MatchDistrict group role for ${tournament.title} ${round.name} Group ${g}`,
          });
        }

        // 2. Create or reuse private group channel
        let groupChannel = null;
        if (existingGroup?.channelId) {
          groupChannel = guild.channels.cache.get(existingGroup.channelId) ||
            await guild.channels.fetch(existingGroup.channelId).catch(() => null);
          if (groupChannel && (groupChannel.type !== ChannelType.GuildText || (groupChannel.guildId || groupChannel.guild?.id) !== guild.id)) {
            groupChannel = null;
          }
        }

        const groupOverwrites = [
          {
            id: guild.roles.everyone.id,
            deny: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.UseApplicationCommands,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ManageThreads,
              PermissionFlagsBits.MentionEveryone,
            ],
          },
          ...(groupRole ? [{
            id: groupRole.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
            ],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.UseApplicationCommands,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ManageThreads,
              PermissionFlagsBits.MentionEveryone,
            ],
          }] : []),
          ...(tourRole ? [{
            id: tourRole.id,
            deny: [PermissionFlagsBits.ViewChannel],
          }] : []),
          {
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ManageThreads,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.AddReactions,
            ],
          },
        ];

        if (groupChannel) {
          if (groupChannel.parentId !== category.id) {
            await groupChannel.setParent(category.id, { lockPermissions: false });
          }
          if (typeof groupChannel.permissionOverwrites?.set === 'function') {
            await groupChannel.permissionOverwrites.set(groupOverwrites).catch(() => {});
          }
        } else {
          groupChannel = await queueChannelCreate(guild, {
            name: channelName,
            type: ChannelType.GuildText,
            parent: roundCategory.id,
            topic: `Private Match Credentials for Group ${g} (${round.name}) — ${tournament.title}`,
            permissionOverwrites: groupOverwrites,
          });
        }

        // 3. Populate slots 1-25
        const slots = [
          { slotNumber: 1, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] },
          { slotNumber: 2, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] },
        ];

        const maxAssignableSlot = 2 + ASSIGNABLE_SLOTS_PER_GROUP;

        for (let s = 3; s <= maxAssignableSlot; s++) {
          const teamIdx = (g - 1) * ASSIGNABLE_SLOTS_PER_GROUP + (s - 3);
          if (teamIdx < eligibleTeams.length) {
            const team = eligibleTeams[teamIdx];
            const linkedMembers = [];

            if (team.leader?.discord_id && isValidDiscordSnowflake(team.leader.discord_id)) {
              linkedMembers.push({
                discord_id: team.leader.discord_id,
                username: team.captain || team.leader.username || 'Leader',
              });
            }

            if (Array.isArray(team.members)) {
              for (const m of team.members) {
                if (m.discord_id && isValidDiscordSnowflake(m.discord_id) && !linkedMembers.some((lm) => lm.discord_id === m.discord_id)) {
                  linkedMembers.push({
                    discord_id: m.discord_id,
                    username: m.username || m.in_game_name || 'Member',
                  });
                }
              }
            }

            if (Array.isArray(team.linked_members)) {
              for (const m of team.linked_members) {
                if (m.discord_id && isValidDiscordSnowflake(m.discord_id) && !linkedMembers.some((lm) => lm.discord_id === m.discord_id)) {
                  linkedMembers.push({
                    discord_id: m.discord_id,
                    username: m.username || 'Member',
                  });
                }
              }
            }

            if (linkedMembers.length === 0) {
              unlinkedTeamsCount++;
            }

            slots.push({
              slotNumber: s,
              status: 'OCCUPIED',
              label: team.team_name,
              teamId: team.id || team.team_id || String(teamIdx + 1),
              teamName: team.team_name,
              members: linkedMembers,
              qualificationStatus: 'Pending',
            });

            // Assign group role to verified linked members
            if (groupRole) {
              for (const mem of linkedMembers) {
                if (!newAssignedGroupMembers.has(mem.discord_id)) {
                  newAssignedGroupMembers.set(mem.discord_id, new Set());
                }
                newAssignedGroupMembers.get(mem.discord_id).add(groupRole.id);
                try {
                  const gm = await guild.members.fetch(mem.discord_id).catch(() => null);
                  if (gm && !gm.roles.cache.has(groupRole.id)) {
                    await gm.roles.add(groupRole.id, `Allocated to ${round.name} Group ${g}`);
                    totalAssignedMembers++;
                  }
                } catch {}
              }
            }
          } else {
            slots.push({
              slotNumber: s,
              status: 'EMPTY',
              label: 'EMPTY',
              teamId: null,
              teamName: null,
              members: [],
              qualificationStatus: 'Pending',
            });
          }
        }

        // Slots after configured capacity up to 25 are UNUSED
        for (let s = maxAssignableSlot + 1; s <= 25; s++) {
          slots.push({
            slotNumber: s,
            status: 'UNUSED',
            label: 'UNUSED',
            teamId: null,
            teamName: null,
            members: [],
          });
        }

        const groupObj = {
          groupId,
          groupNumber: g,
          roleId: groupRole?.id || null,
          roleName: groupRole?.name || roleName,
          channelId: groupChannel?.id || null,
          channelName: groupChannel?.name || channelName,
          slots,
          credentialsMessageId: existingGroup?.credentialsMessageId || null,
          submissionControlMessageId: existingGroup?.submissionControlMessageId || null,
          submissionStatus: existingGroup?.submissionStatus || 'Awaiting submission',
          submissions: existingGroup?.submissions || [],
          submissionAudit: existingGroup?.submissionAudit || [],
        };
        groups.push(groupObj);

        if (groupChannel) {
          await applyStrictGroupChannelPermissions(guild, groupChannel, groupRole, tourRole, botMember, round.groupMessagesOpen, modsRole);
          await removeGroupResultControlMessage(guild, groupObj, groupChannel);
          await updateGroupSlotListMessage(guild, tournament, round, groupObj, groupChannel);
        }
      }

      // Role transition: Clean up obsolete group roles from preceding rounds of THIS tournament
      const previousGroupRoleIds = new Set();
      for (const pr of Object.values(savedTournament.rounds || {})) {
        if (pr.roundId !== round.roundId && Array.isArray(pr.groups)) {
          for (const pg of pr.groups) {
            if (pg.roleId) previousGroupRoleIds.add(pg.roleId);
          }
        }
      }

      if (previousGroupRoleIds.size > 0) {
        for (const [discordId, assignedRoleSet] of newAssignedGroupMembers.entries()) {
          try {
            const gm = await guild.members.fetch(discordId).catch(() => null);
            if (gm) {
              for (const prevRoleId of previousGroupRoleIds) {
                if (gm.roles.cache.has(prevRoleId) && !assignedRoleSet.has(prevRoleId)) {
                  await gm.roles.remove(prevRoleId, `Progression transition to ${round.name}`).catch(() => {});
                }
              }
            }
          } catch {}
        }
      }

      // Also clean up obsolete group roles for members who did not qualify for this round
      if (hasPrevQuals && prevRound && Array.isArray(prevRound.groups)) {
        for (const pg of prevRound.groups) {
          if (!pg.roleId) continue;
          for (const pslot of (pg.slots || [])) {
            if (pslot.status === 'OCCUPIED' && Array.isArray(pslot.members)) {
              for (const mem of pslot.members) {
                if (mem.discord_id && !newAssignedGroupMembers.has(mem.discord_id)) {
                  try {
                    const gm = await guild.members.fetch(mem.discord_id).catch(() => null);
                    if (gm && gm.roles.cache.has(pg.roleId)) {
                      await gm.roles.remove(pg.roleId, `Did not qualify for ${round.name}`).catch(() => {});
                    }
                  } catch {}
                }
              }
            }
          }
        }
      }

      // Single Active Round Rule: Safely and atomically transition any previous active round to Completed
      for (const r of Object.values(savedTournament.rounds || {})) {
        if ((r.status === 'Active' || r.status === 'Started') && r.roundId !== roundId) {
          r.status = 'Completed';
          r.completedAt = r.completedAt || new Date().toISOString();
        }
      }

      // Update round status & metadata (submissions Closed by default until explicitly opened by admin)
      round.status = 'Started';
      round.startedAt = new Date().toISOString();
      round.groups = groups;
      round.globalSubmissionStatus = 'Closed';

      savedTournament.rounds[round.roundId] = round;
      guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
      saveGuildSettings(guildSettingsCache);
      await enforceSingleActiveRoundInDb(guild.id, tournamentId, round.roundId);
      await saveTournamentToDb(guild.id, tournamentId, savedTournament);

      await recordAuditLog(guild.id, 'ROUND_STARTED', {
        tournamentId,
        tournamentTitle: tournament.title,
        roundId: round.roundId,
        roundName: round.name,
        adminId: member.id,
        adminTag: member.user?.tag,
        groupsCount: groups.length,
        teamsAllocatedCount: eligibleTeams.length,
      }).catch(() => {});
      await sendTournamentManagementLog(guild, tournament, round, 'Round started', member, [
        { name: 'Groups', value: String(groups.length) },
        { name: 'Teams allocated', value: String(eligibleTeams.length) },
      ]);

      // Publish or update allocation summary & global submission panel in #bot-commands
      const botCommandsChannel = savedTournament.channels?.botCommandsId
        ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
        : null;

      if (botCommandsChannel) {
        await publishRoundAllocationSummary(guild, tournament, round, botCommandsChannel, savedTournament);
        await updateGlobalSubmissionControlPanel(guild, tournament, round, botCommandsChannel);
      }

      // Refresh Control Panel embed
      await setupTournamentControlPanel(guild, tournament, summary, botMember);
      await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId);
    });
  } catch (err) {
    console.error(`[Discord Bot] Failed to start round ${roundId} for tournament ${tournamentId}:`, err);
    await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId, `❌ Failed to start round: ${err.message}`);
  }
}

/**
 * Handles select menu interaction for round selection and start prompts.
 */
export async function handleTournamentSelectMenuInteraction(interaction) {
  const customId = interaction.customId || '';
  if (
    !customId.startsWith('md_tour_select_') &&
    !customId.startsWith('md_round_select_') &&
    !customId.startsWith('md_qual_select_') &&
    !customId.startsWith('md_select_qualify_teams:') &&
    customId !== 'md_select_tournament'
  ) return;

  // Persistent handler for .list tournament selection menu (remains functional across restarts and after collector expiry)
  if (customId === 'md_select_tournament') {
    const access = checkTournamentAccess(interaction.guild, interaction.member);
    if (!access.allowed) {
      if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
      }
      return;
    }

    const selectedTournamentId = interaction.values?.[0];
    if (!selectedTournamentId) return;

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    await handleSelectTournamentCommand(
      interaction.guild,
      interaction.member,
      selectedTournamentId,
      (text) => interaction.followUp(typeof text === 'object' ? text : { content: text, ephemeral: true })
    );
    return;
  }

  if (customId.startsWith('md_qual_select_slots:') || customId.startsWith('md_select_qualify_teams:')) {
    const [, tourId, rId, gId] = customId.split(':');
    await handleQualifyPromptConfirmation(interaction, tourId, rId, gId, interaction.values || []);
    return;
  }

  if (customId.startsWith('md_tour_select_round_menu:')) {
    const tournamentId = customId.split(':')[1];
    const roundId = interaction.values?.[0];
    if (roundId) updateDashboardNavigation(interaction.guild, tournamentId, 'push', { screen: 'round', roundId });
    await handleOpenIndividualRoundMenu(interaction, tournamentId, roundId);
    return;
  }

  if (customId.startsWith('md_tour_select_start_round:')) {
    const tournamentId = customId.split(':')[1];
    const roundId = interaction.values?.[0];
    await handlePromptStartRound(interaction, tournamentId, roundId);
    return;
  }
}

/**
 * Handles modal submissions for tournament actions.
 */
export async function handleTournamentModalSubmit(interaction) {
  const customId = interaction.customId || '';
  if (customId.startsWith('md_modal_create_round:')) {
    const tournamentId = customId.split(':')[1];
    const roundName = interaction.fields?.getTextInputValue('round_name')?.trim();
    const capacityStr = interaction.fields?.getTextInputValue('teams_per_group')?.trim();
    await handleCreateRoundSubmit(interaction, tournamentId, roundName, capacityStr);
    return;
  }

  if (customId.startsWith('md_modal_edit_round:')) {
    const parts = customId.split(':');
    const tournamentId = parts[1];
    const roundId = parts[2];
    const newName = interaction.fields?.getTextInputValue('round_name')?.trim();
    const capacityStr = interaction.fields?.getTextInputValue('teams_per_group')?.trim();
    const newNotes = interaction.fields?.getTextInputValue('round_notes')?.trim() || '';
    await handleEditRoundSubmit(interaction, tournamentId, roundId, newName, capacityStr, newNotes);
    return;
  }

  if (customId.startsWith('md_modal_submit_result:')) {
    const parts = customId.split(':');
    const tournamentId = parts[1];
    const roundId = parts[2];
    const groupId = parts[3];
    await handleGroupSubmitResultModal(interaction, tournamentId, roundId, groupId);
    return;
  }

  if (customId.startsWith('md_modal_reject_result:')) {
    const parts = customId.split(':');
    const tournamentId = parts[1];
    const roundId = parts[2];
    const groupId = parts[3];
    const submissionId = parts[4];
    await handleAdminRejectResultModal(interaction, tournamentId, roundId, groupId, submissionId);
    return;
  }
}

/**
 * Publishes or updates the round allocation summary in #bot-commands.
 * Reuses and edits existing messages, handles pagination, and prevents duplicates.
 */
export async function publishRoundAllocationSummary(guild, tournament, round, botCommandsChannel, savedTournament) {
  if (!botCommandsChannel || typeof botCommandsChannel.send !== 'function') return false;

  const isOpen = round.globalSubmissionStatus === 'Open';
  const header = `📊 **Round Allocation & Qualification Summary — ${round.name}** (ID: \`${round.roundId}\`)\n` +
    `• **Tournament:** **${tournament.title || tournament.id}** (\`${tournament.id}\`)\n` +
    `• **Round Status:** 🟢 **${round.status}**\n` +
    `• **Global Result Submissions:** ${isOpen ? '🟢 **OPEN**' : '🔴 **CLOSED**'}\n` +
    `• **Allocated At:** <t:${Math.floor(new Date(round.startedAt || Date.now()).getTime() / 1000)}:f>\n` +
    `────────────────────────────────────────\n\n`;

  let groupsOverview = '';
  for (const group of round.groups || []) {
    const channelMention = group.channelId ? `<#${group.channelId}>` : `#${group.channelName}`;
    const roleMention = group.roleId ? `<@&${group.roleId}>` : `@${group.roleName}`;
    const assignedSlots = (group.slots || []).filter((s) => s.status === 'OCCUPIED' && s.teamName);
    const qualifiedSlots = assignedSlots.filter((s) => s.qualificationStatus === 'Qualified');

    groupsOverview += `⚔️ **Group ${group.groupNumber}** (${channelMention} | ${roleMention})\n` +
      `  • Teams Allocated: **${assignedSlots.length}/16**\n` +
      `  • Qualified: **${qualifiedSlots.length}** 🏆\n` +
      `  • Match Credentials: ${group.credentials?.roomId ? '✅ Published' : '⏳ Pending'}\n\n`;
  }

  groupsOverview += `📌 *Note: Complete 25-slot lists and match credentials are sent directly to each group's private ID/PWD channel.*`;

  const fullContent = header + groupsOverview;
  const logicalKeyPrefix = `guild:${guild.id}:tournament:${tournament.id}:round:${round.roundId}:allocation_summary`;

  try {
    const updatedIds = await upsertManagedMessageBatch(guild.client, {
      guildId: guild.id,
      channelId: botCommandsChannel.id,
      logicalKeyPrefix,
      messageType: 'round_allocation_summary',
      tournamentId: tournament.id,
      roundId: round.roundId,
      pagesPayloads: [{ content: fullContent }],
    });
    round.summaryMessageIds = updatedIds;
  } catch (upsertErr) {
    console.warn('[Discord Bot] ⚠️ Error in upsertManagedMessageBatch for round allocation summary:', upsertErr.message);
  }

  // Prune any legacy detailed slot dump messages in botCommandsChannel
  try {
    const recentMsgs = await botCommandsChannel.messages.fetch({ limit: 40 }).catch(() => null);
    if (recentMsgs && recentMsgs.size > 0) {
      for (const m of recentMsgs.values()) {
        if (
          (m.author.id === guild.client.user?.id || m.author.bot) &&
          !round.summaryMessageIds?.includes(m.id) &&
          m.id !== savedTournament?.controlPanelMessageId &&
          m.id !== round.globalSubmissionControlMessageId &&
          m.content?.includes('Capacity: 25 slots per group') &&
          m.content?.includes('Group 1')
        ) {
          await m.delete().catch(() => {});
        }
      }
    }
  } catch {}

  return true;
}

/**
 * Active pending screenshot uploads for match result submissions.
 * Key: temporary thread/channel ID -> Value: submission metadata.
 */
export const pendingResultSubmissions = new Map();

/**
 * Applies strict read-only permissions to a round group's ID/PWD channel.
 * Ensures ordinary participants have strict view-only access with NO ability to:
 * - Post messages or messages in threads
 * - Create public or private threads
 * - Add reactions
 * - Attach files or embed links
 * - Use slash commands or manage messages/threads
 * - Mention everyone/here
 * Also audits and purges any unauthorized active or archived threads under the channel.
 */
export async function applyStrictGroupChannelPermissions(guild, groupChannel, groupRole, tourRole, botMember, groupMessagesOpen = false, modsRole = null) {
  if (!groupChannel || typeof groupChannel.permissionOverwrites?.set !== 'function') return;

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.UseApplicationCommands,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.MentionEveryone,
      ],
    },
    ...(groupRole ? [{
      id: groupRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        ...(groupMessagesOpen ? [PermissionFlagsBits.SendMessages] : []),
      ],
      deny: [
        ...(!groupMessagesOpen ? [PermissionFlagsBits.SendMessages] : []),
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.UseApplicationCommands,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.MentionEveryone,
      ],
    }] : []),
    ...(tourRole ? [{
      id: tourRole.id,
      deny: [PermissionFlagsBits.ViewChannel],
    }] : []),
    ...(modsRole ? [{
      id: modsRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.UseApplicationCommands,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.MentionEveryone,
      ],
    }] : []),
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
      ],
    },
  ];

  await groupChannel.permissionOverwrites.set(overwrites).catch((err) => {
    console.warn(`[Discord Bot] Failed to set strict overwrites on #${groupChannel.name}:`, err.message);
  });

  // Audit and delete unauthorized threads
  try {
    if (groupChannel.threads) {
      const activeThreads = await groupChannel.threads.fetchActive().catch(() => null);
      if (activeThreads?.threads) {
        for (const [, thread] of activeThreads.threads) {
          if (!pendingResultSubmissions.has(thread.id)) {
            await thread.delete('Audit: Unauthorized thread in ID/PWD channel').catch(() => {});
          }
        }
      }
      const archivedPublic = await groupChannel.threads.fetchArchived({ type: 'public' }).catch(() => null);
      if (archivedPublic?.threads) {
        for (const [, thread] of archivedPublic.threads) {
          if (!pendingResultSubmissions.has(thread.id)) {
            await thread.delete('Audit: Unauthorized archived thread in ID/PWD channel').catch(() => {});
          }
        }
      }
      const archivedPrivate = await groupChannel.threads.fetchArchived({ type: 'private' }).catch(() => null);
      if (archivedPrivate?.threads) {
        for (const [, thread] of archivedPrivate.threads) {
          if (!pendingResultSubmissions.has(thread.id)) {
            await thread.delete('Audit: Unauthorized private thread in ID/PWD channel').catch(() => {});
          }
        }
      }
    }
  } catch (threadAuditErr) {
    console.warn(`[Discord Bot] Thread audit warning on #${groupChannel.name}:`, threadAuditErr.message);
  }
}

/**
 * Removes legacy result-submission controls from an ID/PWD channel to ensure
 * the channel remains strictly read-only for ordinary group members.
 * Preserves match ID/password messages and slot lists.
 */
export async function removeGroupResultControlMessage(guild, group, channel) {
  if (!channel) return;

  // 1. If stored message ID exists, delete it
  if (group.submissionControlMessageId) {
    try {
      const msg = await channel.messages.fetch(group.submissionControlMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    } catch {}
    await deleteManagedMessages(guild.client, {
      guildId: guild.id,
      messageId: group.submissionControlMessageId,
    }).catch(() => {});
    group.submissionControlMessageId = null;
  }

  // 2. Search for any legacy "Match Results & Verification" bot messages in the channel
  try {
    const recentMsgs = await channel.messages.fetch({ limit: 40 }).catch(() => null);
    if (recentMsgs && recentMsgs.size > 0) {
      for (const m of recentMsgs.values()) {
        if (
          (m.author.id === guild.client.user?.id || m.author.bot) &&
          m.embeds?.some((e) => e.title?.includes('Match Results & Verification'))
        ) {
          await m.delete().catch(() => {});
        }
      }
    }
  } catch {}
}

/**
 * Sends or updates a group's persistent 25-slot list and match ID/password information
 * inside that group's private ID/PWD channel.
 * Publishes only the slot list and match credentials.
 */
export async function updateGroupSlotListMessage(guild, tournament, round, group, channel) {
  if (!channel || typeof channel.send !== 'function') return null;

  // Display only locked and filled slots in the agreed format.
  let slotsText = '';
  const slots = Array.isArray(group.slots) ? group.slots : [];
  for (let s = 1; s <= 25; s++) {
    const slotNum = String(s).padStart(2, '0');
    const slotData = slots.find((sl) => sl.slotNumber === s);
    if (s <= 2) slotsText += `Slot ${slotNum} → 🔒 LOCKED\n`;
    else if (slotData?.status === 'OCCUPIED' && slotData.teamName) slotsText += `Slot ${slotNum} → ${slotData.teamName}\n`;
  }
  const slotListContent = `\`\`\`\n${slotsText.trim()}\n\`\`\``;

  const logicalKey = `guild:${guild.id}:tournament:${tournament.id}:round:${round.roundId}:group:${group.groupId}:slot_list`;

  try {
    await deleteManagedMessages(guild.client, {
      guildId: guild.id,
      tournamentId: tournament.id,
      roundId: round.roundId,
      groupId: group.groupId,
      logicalKey: `${logicalKey}:credentials`,
    }).catch(() => {});
    await deleteManagedMessages(guild.client, {
      guildId: guild.id,
      tournamentId: tournament.id,
      roundId: round.roundId,
      groupId: group.groupId,
      messageType: 'group_match_credential_part',
    }).catch(() => {});
    const result = await upsertManagedMessage(guild.client, {
      guildId: guild.id,
      channelId: channel.id,
      logicalKey,
      messageType: 'group_slot_list',
      tournamentId: tournament.id,
      roundId: round.roundId,
      groupId: group.groupId,
      payload: { content: slotListContent, embeds: [], components: [] },
    });
    group.slotListMessageId = result.messageId;
    const oldCredentialMessages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    for (const message of oldCredentialMessages?.values?.() || []) {
      if ((message.author.id === guild.client.user?.id || message.author.bot) && message.embeds?.some((embed) => embed.title?.includes('Match Credentials'))) {
        await message.delete().catch(() => {});
      }
    }
    return result.messageId;
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in upsertManagedMessage for group slot list:', err.message);
    let msg = null;
    if (group.slotListMessageId && typeof channel.messages?.fetch === 'function') {
      msg = await channel.messages.fetch(group.slotListMessageId).catch(() => null);
    }
    if (msg && typeof msg.edit === 'function') {
      await msg.edit({ content: slotListContent, embeds: [], components: [] }).catch(() => {});
      group.slotListMessageId = msg.id;
    } else {
      const newMsg = await channel.send({ content: slotListContent, components: [] }).catch(() => null);
      if (newMsg) group.slotListMessageId = newMsg.id;
    }
    await deleteManagedMessages(guild.client, {
      guildId: guild.id,
      tournamentId: tournament.id,
      roundId: round.roundId,
      groupId: group.groupId,
      messageType: 'group_match_credential_part',
    }).catch(() => {});
    const oldCredentialMessages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    for (const message of oldCredentialMessages?.values?.() || []) {
      if ((message.author.id === guild.client.user?.id || message.author.bot) && message.embeds?.some((embed) => embed.title?.includes('Match Credentials'))) {
        await message.delete().catch(() => {});
      }
    }
    return group.slotListMessageId;
  }
}

/**
 * Backward compatibility wrapper for updateGroupControlMessage.
 * Cleans up legacy result controls and keeps slot list updated.
 */
export async function updateGroupControlMessage(guild, tournament, round, group, channel) {
  await removeGroupResultControlMessage(guild, group, channel);
  return await updateGroupSlotListMessage(guild, tournament, round, group, channel);
}

/**
 * Publishes or updates the Global Result Submission control panel in #bot-commands.
 * Controlled by a global switch for every group simultaneously.
 */
export async function updateGlobalSubmissionControlPanel(guild, tournament, round, botCommandsChannel) {
  if (!botCommandsChannel || typeof botCommandsChannel.send !== 'function') return null;

  const isOpen = round.globalSubmissionStatus === 'Open';
  const statusEmoji = isOpen ? '🟢' : '🔴';
  const statusText = isOpen ? 'OPEN (Accepting Submissions)' : 'CLOSED (Submissions Locked)';
  const groupCount = Array.isArray(round.groups) ? round.groups.length : 0;

  let totalSubmissions = 0;
  let acceptedSubmissions = 0;
  if (Array.isArray(round.groups)) {
    for (const g of round.groups) {
      if (Array.isArray(g.submissions)) {
        totalSubmissions += g.submissions.length;
        acceptedSubmissions += g.submissions.filter((s) => s.status === 'Accepted').length;
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`⚖️ Global Result Submissions — ${round.name}`)
    .setColor(isOpen ? 0x22c55e : 0xef4444)
    .setDescription(
      `Centralized Match Result Submission Control for **${tournament.title || tournament.id}**.\n\n` +
      `• **Tournament:** **${tournament.title || tournament.id}**\n` +
      `• **Current Round:** **${round.name}** (\`${round.roundId}\`)\n` +
      `• **Submission Status:** ${statusEmoji} **${statusText}**\n` +
      `• **Eligible Groups Allowed:** **${groupCount}** group(s) (${round.groups?.map(g => `Group ${g.groupNumber}`).join(', ') || 'None'})\n` +
      `• **Submissions Received:** **${totalSubmissions}** (${acceptedSubmissions} Accepted)\n\n` +
      `*Use the buttons below to open or close result submission for all groups simultaneously.*`
    )
    .setFooter({ text: `Round ID: ${round.roundId} • MatchDistrict Control Panel` })
    .setTimestamp();

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_tour_open_submissions:${tournament.id}:${round.roundId}`)
      .setLabel('Open Result Submission')
      .setEmoji('🟢')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isOpen),
    new ButtonBuilder()
      .setCustomId(`md_tour_close_submissions:${tournament.id}:${round.roundId}`)
      .setLabel('Close Result Submission')
      .setEmoji('🔴')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isOpen),
    new ButtonBuilder()
      .setCustomId(`md_tour_refresh_submissions:${tournament.id}:${round.roundId}`)
      .setLabel('Refresh Status')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  const logicalKey = `guild:${guild.id}:tournament:${tournament.id}:round:${round.roundId}:global_submission_control`;

  try {
    const result = await upsertManagedMessage(guild.client, {
      guildId: guild.id,
      channelId: botCommandsChannel.id,
      logicalKey,
      messageType: 'global_submission_control',
      tournamentId: tournament.id,
      roundId: round.roundId,
      payload: { embeds: [embed], components: [actionRow] },
    });
    round.globalSubmissionControlMessageId = result.messageId;
    return result.messageId;
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in upsertManagedMessage for global submission panel:', err.message);
    return null;
  }
}

/**
 * Handles the "Open Result Submission" button in #bot-commands.
 */
export async function handleOpenSubmissionsButton(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    await interaction.editReply({ content: '❌ Tournament configuration not found.' }).catch(() => {});
    return;
  }

  const round = savedTournament.rounds?.[roundId];
  if (!round) {
    await interaction.editReply({ content: '❌ Round not found.' }).catch(() => {});
    return;
  }

  round.globalSubmissionStatus = 'Open';

  for (const group of round.groups || []) {
    if (group.submissionStatus !== 'Accepted') {
      group.submissionStatus = 'Awaiting submission';
    }
  }

  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);
  await recordAuditLog(guild.id, 'OPEN_GLOBAL_SUBMISSIONS', {
    tournamentId,
    roundId,
    adminId: member.id,
  });

  const botCommandsChannel = savedTournament.channels?.botCommandsId
    ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
    : null;

  if (botCommandsChannel) {
    await updateGlobalSubmissionControlPanel(guild, savedTournament, round, botCommandsChannel);
    await publishRoundAllocationSummary(guild, savedTournament, round, botCommandsChannel, savedTournament);
  }

  await interaction.editReply({
    content: `🟢 **Result Submissions Opened:** Result submissions are now **OPEN** for all groups in **${round.name}**! Eligible verified players may now submit results.`,
  }).catch(() => {});
}

/**
 * Handles the "Close Result Submission" button in #bot-commands.
 */
export async function handleCloseSubmissionsButton(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    await interaction.editReply({ content: '❌ Tournament configuration not found.' }).catch(() => {});
    return;
  }

  const round = savedTournament.rounds?.[roundId];
  if (!round) {
    await interaction.editReply({ content: '❌ Round not found.' }).catch(() => {});
    return;
  }

  round.globalSubmissionStatus = 'Closed';

  for (const group of round.groups || []) {
    if (group.submissionStatus === 'Awaiting submission') {
      group.submissionStatus = 'Submission Closed';
    }
  }

  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);
  await recordAuditLog(guild.id, 'CLOSE_GLOBAL_SUBMISSIONS', {
    tournamentId,
    roundId,
    adminId: member.id,
  });

  const botCommandsChannel = savedTournament.channels?.botCommandsId
    ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
    : null;

  if (botCommandsChannel) {
    await updateGlobalSubmissionControlPanel(guild, savedTournament, round, botCommandsChannel);
    await publishRoundAllocationSummary(guild, savedTournament, round, botCommandsChannel, savedTournament);
  }

  await interaction.editReply({
    content: `🔴 **Result Submissions Closed:** Result submissions for **${round.name}** are now **CLOSED**. All new and pending unaccepted submissions are locked.`,
  }).catch(() => {});
}

/**
 * Handles the "Refresh Status" button in #bot-commands.
 */
export async function handleRefreshSubmissionsButton(interaction, tournamentId, roundId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  const botCommandsChannel = savedTournament?.channels?.botCommandsId
    ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
    : null;

  if (savedTournament && round && botCommandsChannel) {
    await updateGlobalSubmissionControlPanel(guild, savedTournament, round, botCommandsChannel);
    await publishRoundAllocationSummary(guild, savedTournament, round, botCommandsChannel, savedTournament);
  }

  await interaction.editReply({
    content: '🔄 **Submission status refreshed successfully.**',
  }).catch(() => {});
}

/**
 * Generates initial empty groups following the 25-slot structure:
 * - Slots 01-02: LOCKED
 * - Slots 03-18: 16 team positions (initially EMPTY)
 * - Slots 19-25: UNUSED / RESERVED
 */
export function generateEmptyRoundGroups(count = 4, roundName = 'Round 2') {
  const groups = [];
  for (let g = 1; g <= count; g++) {
    const slots = [];
    for (let s = 1; s <= 2; s++) {
      slots.push({ slotNumber: s, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] });
    }
    for (let s = 3; s <= 18; s++) {
      slots.push({ slotNumber: s, status: 'EMPTY', label: 'EMPTY', teamId: null, teamName: null, members: [], qualificationStatus: 'Pending' });
    }
    for (let s = 19; s <= 25; s++) {
      slots.push({ slotNumber: s, status: 'UNUSED', label: 'UNUSED', teamId: null, teamName: null, members: [] });
    }
    groups.push({
      groupId: `group-${g}-${Date.now().toString(36)}`,
      groupNumber: g,
      groupName: `Group ${g}`,
      channelId: null,
      roleId: null,
      slots,
      credentials: null,
      slotListMessageId: null,
      submissionControlMessageId: null,
      submissionStatus: 'Awaiting submission',
      submissions: [],
      submissionAudit: [],
    });
  }
  return groups;
}

function getQualifiedSlotsForGroup(round, group) {
  const existing = new Set(
    (round.qualifications || [])
      .filter((q) => q.sourceGroupId === group.groupId && q.qualificationStatus === 'Qualified')
      .map((q) => Number(q.sourceSlot))
  );
  return new Set((group.slots || [])
    .filter((slot) => slot.status === 'OCCUPIED' && slot.teamName &&
      (slot.qualificationStatus === 'Qualified' || existing.has(Number(slot.slotNumber))))
    .map((slot) => Number(slot.slotNumber)));
}

function getTotalQualifiedForRound(round) {
  const qualified = new Set();
  for (const group of (Array.isArray(round.groups) ? round.groups : [])) {
    for (const slotNumber of getQualifiedSlotsForGroup(round, group)) {
      qualified.add(`${group.groupId}:${slotNumber}`);
    }
  }
  return qualified.size;
}

function buildQualifyGroupListScreen(round, tournamentId) {
  const groups = Array.isArray(round.groups) ? round.groups : [];
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${round.name} — Qualify Teams`)
    .setColor(0x22c55e)
    .setDescription(
      `Select a source group from **${round.name}** to review its 25-slot list and qualify teams for the next round.\n\n` +
      `• **Source Round:** **${round.name}** (\`${round.roundId}\`)\n` +
      `• **Total Groups:** **${groups.length}** group(s)\n` +
      `• **Configured Capacity:** **${round.teamsPerGroup || 16}** teams per group\n` +
      `• **Currently Qualified:** **${getTotalQualifiedForRound(round)}** team(s) qualified from this round\n\n` +
      `*Choose a group to update its qualified teams:*`
    )
    .setTimestamp();

  const components = [];
  let currentRow = new ActionRowBuilder();
  for (let i = 0; i < groups.length && components.length < 4; i++) {
    const group = groups[i];
    const count = getQualifiedSlotsForGroup(round, group).size;
    const label = `G${group.groupNumber}${count ? ` (${count} 🏆)` : ''}`;
    currentRow.addComponents(new ButtonBuilder()
      .setCustomId(`dash:qualify:group:${round.roundId}:${group.groupId}`)
      .setLabel(label.slice(0, 80))
      .setStyle(count ? ButtonStyle.Success : ButtonStyle.Primary));
    if (currentRow.components.length === 5 || i === groups.length - 1) {
      components.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dash:qualify:refresh_groups:${round.roundId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`).setLabel('Back to Round').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:qualify:home').setLabel('Back to Dashboard').setEmoji('🏠').setStyle(ButtonStyle.Secondary)
  ));
  return { embed, components };
}

function buildQualifyGroupScreen(round, group) {
  const qualifiedSlots = getQualifiedSlotsForGroup(round, group);
  const slotsByNumber = new Map((group.slots || []).map((slot) => [Number(slot.slotNumber), slot]));
  const slotLines = Array.from({ length: 25 }, (_, index) => {
    const slotNumber = index + 1;
    const slot = slotsByNumber.get(slotNumber);
    const slotLabel = `Slot ${String(slotNumber).padStart(2, '0')}`;
    if (slot?.status === 'LOCKED' || slotNumber <= 2) return `Slot ${String(slotNumber).padStart(2, '0')} → 🔒 LOCKED`;
    if (slot?.status === 'UNUSED' || slot?.status === 'RESERVED') return null;
    if (slot?.status === 'OCCUPIED' && slot.teamName) {
      return `Slot ${String(slotNumber).padStart(2, '0')} → ${slot.teamName}`;
    }
    return null;
  }).filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Qualify Teams — ${round.name} (Group ${group.groupNumber})`)
    .setColor(0x22c55e)
    .setDescription(
      `Select the registered teams from Group ${group.groupNumber} that qualify for the next round.\n` +
      `**Already Qualified:** ${qualifiedSlots.size} team(s)\n\n` +
        `**Slot List**\n${slotLines.join('\n')}`
    )
    .setTimestamp();

  const components = [];
  const occupiedSlots = (group.slots || [])
    .filter((slot) => slot.status === 'OCCUPIED' && slot.teamName)
    .sort((a, b) => a.slotNumber - b.slotNumber);
  if (occupiedSlots.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`dash:qualify:select:${round.roundId}:${group.groupId}`)
      .setPlaceholder(`Select qualified teams from Group ${group.groupNumber}`)
      .setMinValues(0)
      .setMaxValues(occupiedSlots.length);
    for (const slot of occupiedSlots) {
      menu.addOptions(new StringSelectMenuOptionBuilder()
        .setLabel(`Slot ${String(slot.slotNumber).padStart(2, '0')}: ${slot.teamName}`.slice(0, 100))
        .setValue(`slot_${slot.slotNumber}`)
        .setDescription(qualifiedSlots.has(Number(slot.slotNumber)) ? 'Already qualified' : 'Not qualified')
        .setDefault(qualifiedSlots.has(Number(slot.slotNumber))));
    }
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dash:qualify:groups:${round.roundId}`).setLabel('Back to Groups').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash:qualify:home').setLabel('Back to Dashboard').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dash:qualify:refresh:${round.roundId}:${group.groupId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
  ));
  return { embed, components };
}

async function renderQualifyGroupList(interaction, tournamentId, roundId) {
  const round = guildSettingsCache[interaction.guild.id]?.tournaments?.[tournamentId]?.rounds?.[roundId];
  if (!round) throw new Error(`Round ${roundId} not found.`);
  const { embed, components } = buildQualifyGroupListScreen(round, tournamentId);
  await interaction.editReply({ content: null, embeds: [embed], components });
}

export async function handleRoundQualifyGroupSelection(interaction, tournamentId, roundId) {
  try {
    const access = checkTournamentAccess(interaction.guild, interaction.member);
    if (!access.allowed) {
      if (!interaction.deferred && !interaction.replied) await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
      return;
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const savedTournament = guildSettingsCache[interaction.guild.id]?.tournaments?.[tournamentId];
    const round = savedTournament?.rounds?.[roundId];
    if (!round) throw new Error(`Round ${roundId} not found.`);
    const groups = Array.isArray(round.groups) ? round.groups : [];
    if (!groups.length) {
      await interaction.editReply({ content: `⚠️ No groups are allocated in ${round.name}. Start the round before qualifying teams.`, embeds: [], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash:qualify:refresh_groups:${roundId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`md_round_back_to_menu:${tournamentId}:${roundId}`).setLabel('Back to Round').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('dash:qualify:home').setLabel('Back to Dashboard').setEmoji('🏠').setStyle(ButtonStyle.Secondary)
      )] });
      return;
    }
    await renderQualifyGroupList(interaction, tournamentId, roundId);
  } catch (error) {
    console.error(`[Discord Bot] Failed to render qualify groups for round ${roundId}:`, error);
    if (interaction.deferred) await interaction.editReply({ content: `❌ ${error.message}`, embeds: [], components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dash:qualify:refresh_groups:${roundId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dash:qualify:home').setLabel('Back to Dashboard').setEmoji('🏠').setStyle(ButtonStyle.Secondary)
    )] }).catch(() => {});
  }
}

export async function handleDashboardQualifyGroup(interaction, tournamentId, roundId, groupId) {
  try {
    const access = checkTournamentAccess(interaction.guild, interaction.member);
    if (!access.allowed) {
      if (!interaction.deferred && !interaction.replied) await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
      return;
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const round = guildSettingsCache[interaction.guild.id]?.tournaments?.[tournamentId]?.rounds?.[roundId];
    const group = (round?.groups || []).find((item) => item.groupId === groupId || String(item.groupNumber) === String(groupId));
    if (!round || !group) throw new Error('Round or group configuration not found.');
    const { embed, components } = buildQualifyGroupScreen(round, group);
    await interaction.editReply({ content: null, embeds: [embed], components });
  } catch (error) {
    console.error(`[Discord Bot] Failed to render qualify group ${groupId} in round ${roundId}:`, error);
    if (interaction.deferred) await interaction.editReply({ content: `❌ ${error.message}`, embeds: [], components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dash:qualify:groups:${roundId}`).setLabel('Back to Groups').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dash:qualify:home').setLabel('Back to Dashboard').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`dash:qualify:refresh_groups:${roundId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    )] }).catch(() => {});
  }
}

export async function handleDashboardQualifySelection(interaction) {
  const [, , , roundId, groupId] = String(interaction.customId || '').split(':');
  const settings = guildSettingsCache[interaction.guild?.id] || {};
  const match = Object.entries(settings.tournaments || {}).find(([, saved]) => saved?.channels?.botCommandsId === interaction.channelId);
  const tournamentId = match?.[0];
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    if (!tournamentId) throw new Error('Tournament dashboard not found for this channel.');
    const access = checkTournamentAccess(interaction.guild, interaction.member);
    if (!access.allowed) {
      await interaction.followUp({ content: access.reason, ephemeral: true }).catch(() => {});
      return;
    }
    const savedTournament = settings.tournaments[tournamentId];
    const round = savedTournament.rounds?.[roundId];
    const group = (round?.groups || []).find((item) => item.groupId === groupId || String(item.groupNumber) === String(groupId));
    if (!round || !group) throw new Error('Round or group configuration not found.');

    const selectedSlots = new Set((interaction.values || [])
      .map((value) => Number(String(value).replace(/^slot_/, '')))
      .filter(Number.isInteger));
    const occupiedSlots = (group.slots || []).filter((slot) => slot.status === 'OCCUPIED' && slot.teamName);
    if ([...selectedSlots].some((slotNumber) => !occupiedSlots.some((slot) => Number(slot.slotNumber) === slotNumber))) {
      throw new Error('The selection contains a team that is not registered in this group.');
    }

    const previousRecords = Array.isArray(round.qualifications) ? round.qualifications : [];
    const recordsBySlot = new Map(previousRecords
      .filter((record) => record.sourceGroupId === group.groupId)
      .map((record) => [Number(record.sourceSlot), record]));
    group.qualifications = [];
    for (const slot of occupiedSlots) {
      const slotNumber = Number(slot.slotNumber);
      const selected = selectedSlots.has(slotNumber);
      slot.qualificationStatus = selected ? 'Qualified' : 'Pending';
      if (!selected) continue;
      const prior = recordsBySlot.get(slotNumber) || {};
      group.qualifications.push({
        ...prior,
        tournamentId,
        sourceRoundId: round.roundId,
        sourceGroupId: group.groupId,
        sourceSlot: slotNumber,
        teamId: slot.teamId || `team_${slotNumber}`,
        teamName: slot.teamName,
        members: slot.members || [],
        qualificationStatus: 'Qualified',
        timestamp: prior.timestamp || new Date().toISOString(),
        destinationRoundId: prior.destinationRoundId || null,
      });
    }
    const qualifications = [];
    for (const sourceGroup of (round.groups || [])) {
      const groupRecords = Array.isArray(sourceGroup.qualifications) ? sourceGroup.qualifications : [];
      const records = groupRecords.length ? groupRecords : (sourceGroup.slots || [])
        .filter((slot) => slot.qualificationStatus === 'Qualified' && slot.teamName)
        .map((slot) => ({
          tournamentId,
          sourceRoundId: round.roundId,
          sourceGroupId: sourceGroup.groupId,
          sourceSlot: slot.slotNumber,
          teamId: slot.teamId || `team_${slot.slotNumber}`,
          teamName: slot.teamName,
          members: slot.members || [],
          qualificationStatus: 'Qualified',
          destinationRoundId: null,
        }));
      qualifications.push(...records);
    }
    round.qualifications = qualifications;
    settings.tournaments[tournamentId] = savedTournament;
    guildSettingsCache[interaction.guild.id] = settings;
    saveGuildSettings(guildSettingsCache);
      await persistManagementRoleState(interaction.guild.id, tournamentId, savedTournament);

    const { embed, components } = buildQualifyGroupScreen(round, group);
    await interaction.editReply({ content: null, embeds: [embed], components });
  } catch (error) {
    console.error(`[Discord Bot] Failed to save qualified teams for round ${roundId}, group ${groupId}:`, error);
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dash:qualify:refresh:${roundId}:${groupId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`dash:qualify:groups:${roundId}`).setLabel('Back to Groups').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dash:qualify:home').setLabel('Back to Dashboard').setEmoji('🏠').setStyle(ButtonStyle.Secondary)
    );
    if (interaction.deferred) await interaction.editReply({ content: `❌ ${error.message}`, components: [navRow] }).catch(() => {});
  }
}

/**
 * Step B — Select Slots for the chosen group.
 * Displays the group's occupied team slots (excluding locked 01-02 and unused slots).
 * Allows admin to select teams to qualify.
 */
export async function handleRoundQualifySlotSelection(interaction, tournamentId, roundId, groupId) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  if (!round) {
    const errText = `❌ Round \`${roundId}\` not found.`;
    if (interaction.deferred) await interaction.editReply({ content: errText, embeds: [], components: [] }).catch(() => {});
    return;
  }

  const group = (round.groups || []).find((g) => g.groupId === groupId || String(g.groupNumber) === String(groupId));
  if (!group) {
    const errText = `❌ Group not found in round ${round.name}.`;
    if (interaction.deferred) await interaction.editReply({ content: errText, embeds: [], components: [] }).catch(() => {});
    return;
  }

  const occupiedSlots = (group.slots || []).filter((s) => s.status === 'OCCUPIED' && s.teamName);
  if (occupiedSlots.length === 0) {
    const noTeamsText = `⚠️ No teams are currently occupied in **Group ${group.groupNumber}**.`;
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_round_qualify:${tournamentId}:${round.roundId}`)
        .setLabel('Back to Groups')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );
    if (interaction.deferred) {
      await interaction.editReply({ content: noTeamsText, embeds: [], components: [backRow] }).catch(() => {});
    } else if (typeof interaction.update === 'function') {
      await interaction.update({ content: noTeamsText, embeds: [], components: [backRow] }).catch(() => {});
    }
    return;
  }

  const qualifiedSlots = occupiedSlots.filter((s) => s.qualificationStatus === 'Qualified');

  const slotSummaryLines = occupiedSlots.map((s) => {
    const isQual = s.qualificationStatus === 'Qualified';
    const qualTag = isQual ? '🏆 **(QUALIFIED)**' : '⏳ *(Pending)*';
    return `• **Slot ${String(s.slotNumber).padStart(2, '0')}:** **${s.teamName}** ${qualTag}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Qualify Teams — ${round.name} (Group ${group.groupNumber})`)
    .setColor(0x22c55e)
    .setDescription(
      `Select one or more team slots from **Group ${group.groupNumber}** to qualify for the next round stage.\n\n` +
      `• **Group:** Group ${group.groupNumber} (${occupiedSlots.length} team(s) assigned)\n` +
      `• **Already Qualified:** **${qualifiedSlots.length}** team(s)\n` +
      `• **Display Policy:** Locked slots (01–02) and unused slots cannot be selected.\n\n` +
      `**Current Team Slots:**\n` +
      slotSummaryLines.slice(0, 16).join('\n')
    )
    .setFooter({ text: 'Admin Action • Select teams below to proceed to confirmation' })
    .setTimestamp();

  // Select menu for occupied slots
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`md_qual_select_slots:${tournamentId}:${round.roundId}:${group.groupId}`)
    .setPlaceholder(`Select team(s) from Group ${group.groupNumber} to qualify...`)
    .setMinValues(1)
    .setMaxValues(occupiedSlots.length);

  for (const slot of occupiedSlots) {
    const isQual = slot.qualificationStatus === 'Qualified';
    const label = `Slot ${String(slot.slotNumber).padStart(2, '0')}: ${slot.teamName}`.slice(0, 100);
    const desc = isQual ? 'ALREADY QUALIFIED 🏆' : 'Pending Qualification ⏳';
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(`slot_${slot.slotNumber}`)
        .setDescription(desc)
        .setEmoji(isQual ? '🏆' : '🎮')
    );
  }

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_qualify:${tournamentId}:${round.roundId}`)
      .setLabel('Back to Groups')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`)
      .setLabel('Back to Round')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Secondary)
  );

  if (interaction.deferred) {
    await interaction.editReply({ content: null, embeds: [embed], components: [row1, row2] }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: null, embeds: [embed], components: [row1, row2] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true }).catch(() => {});
  }
}

/**
 * Step B Confirmation — Shows preview of selected teams and requests explicit admin confirmation.
 */
export async function handleQualifyPromptConfirmation(interaction, tournamentId, roundId, groupId, selectedSlotValues = []) {
  const guild = interaction.guild;
  const access = checkTournamentAccess(guild, interaction.member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId || String(g.groupNumber) === String(groupId));

  if (!round || !group) {
    const errText = '❌ Round or group configuration not found.';
    if (interaction.deferred) await interaction.editReply({ content: errText, embeds: [], components: [] }).catch(() => {});
    return;
  }

  const slotNums = selectedSlotValues
    .map((v) => parseInt(v.replace(/^slot_/, '').replace(/^team_/, ''), 10))
    .filter((n) => !isNaN(n));

  const selectedSlots = (group.slots || []).filter((s) => slotNums.includes(s.slotNumber));
  if (selectedSlots.length === 0) {
    const errText = '⚠️ No valid team slots were selected.';
    if (interaction.deferred) await interaction.editReply({ content: errText, embeds: [], components: [] }).catch(() => {});
    return;
  }

  const slotNumbersCsv = selectedSlots.map((s) => s.slotNumber).join(',');

  const teamListText = selectedSlots.map((s) => {
    const isQual = s.qualificationStatus === 'Qualified';
    return `• **Slot ${String(s.slotNumber).padStart(2, '0')}:** **${s.teamName}** ${isQual ? '(Already Qualified 🏆)' : '(New Qualification 🟢)'}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Confirm Qualification — ${round.name} (Group ${group.groupNumber})`)
    .setColor(0xeab308) // Amber
    .setDescription(
      `Are you sure you want to qualify the following **${selectedSlots.length}** team(s) from **Group ${group.groupNumber}**?\n\n` +
      `${teamListText}\n\n` +
      `🛡️ **Progression Rule:**\n` +
      `• Qualified teams will be saved in MongoDB with persistent qualification records.\n` +
      `• When you create and start the next round, these qualified teams will form the eligible allocation pool.\n` +
      `• The source slot list and qualification summary will be updated in place immediately.\n\n` +
      `Click **Qualify Selected Teams** to commit.`
    )
    .setFooter({ text: `Admin: ${interaction.member?.user?.tag || interaction.member?.id}` })
    .setTimestamp();

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_qual_commit:${tournamentId}:${round.roundId}:${group.groupId}:${slotNumbersCsv}`)
      .setLabel('Qualify Selected Teams')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_qual_group:${tournamentId}:${round.roundId}:${group.groupId}`)
      .setLabel('Back to Slots')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  if (interaction.deferred) {
    await interaction.editReply({ content: null, embeds: [embed], components: [confirmRow] }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: null, embeds: [embed], components: [confirmRow] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [embed], components: [confirmRow], ephemeral: true }).catch(() => {});
  }
}

/**
 * Step C — Persist Qualification.
 * Persists qualification records idempotently, updates slot lists in place, and records audit log.
 */
export async function handleExecuteQualifyCommit(interaction, tournamentId, roundId, groupId, slotNumbers = []) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(() => {});
    }
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId || String(g.groupNumber) === String(groupId));

  if (!round || !group) {
    const errText = '❌ Round or group configuration not found.';
    if (interaction.deferred) await interaction.editReply({ content: errText, embeds: [], components: [] }).catch(() => {});
    return;
  }

  if (!Array.isArray(round.qualifications)) {
    round.qualifications = [];
  }

  const newlyQualifiedNames = [];
  const alreadyQualifiedNames = [];

  for (const num of slotNumbers) {
    const slot = (group.slots || []).find((s) => s.slotNumber === num);
    if (!slot || slot.status !== 'OCCUPIED' || !slot.teamName) continue;

    slot.qualificationStatus = 'Qualified';

    const qualRecord = {
      tournamentId,
      sourceRoundId: round.roundId,
      sourceGroupId: group.groupId,
      sourceSlot: slot.slotNumber,
      teamId: slot.teamId || `team_${slot.slotNumber}`,
      teamName: slot.teamName,
      members: slot.members || [],
      qualificationStatus: 'Qualified',
      adminId: member.id,
      timestamp: new Date().toISOString(),
      destinationRoundId: null,
    };

    const existingIdx = round.qualifications.findIndex(
      (q) => q.sourceGroupId === group.groupId && q.sourceSlot === slot.slotNumber
    );

    if (existingIdx >= 0) {
      round.qualifications[existingIdx] = { ...round.qualifications[existingIdx], ...qualRecord };
      alreadyQualifiedNames.push(slot.teamName);
    } else {
      round.qualifications.push(qualRecord);
      newlyQualifiedNames.push(slot.teamName);
    }
  }

  // Save to memory cache & MongoDB persistently
  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);

  // Update source group's slot-list message in its private channel in place
  const groupChannel = group.channelId
    ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null))
    : null;
  if (groupChannel) {
    await updateGroupSlotListMessage(guild, savedTournament, round, group, groupChannel);
  }

  // Update allocation summary in #bot-commands
  const botCommandsChannel = savedTournament.channels?.botCommandsId
    ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
    : null;
  if (botCommandsChannel) {
    await publishRoundAllocationSummary(guild, savedTournament, round, botCommandsChannel, savedTournament);
    await updateGlobalSubmissionControlPanel(guild, savedTournament, round, botCommandsChannel);
  }

  await recordAuditLog(guild.id, 'QUALIFY_TEAMS', {
    tournamentId,
    sourceRoundId: round.roundId,
    sourceGroupId: group.groupId,
    newlyQualified: newlyQualifiedNames,
    alreadyQualified: alreadyQualifiedNames,
    adminId: member.id,
    adminTag: member.user?.tag,
  }).catch(() => {});
  const qualifiedTeamNames = [...newlyQualifiedNames, ...alreadyQualifiedNames];
  await sendTournamentManagementLog(guild, savedTournament, round, 'Teams qualified', member, [
    { name: 'Group', value: `Group ${group.groupNumber}` },
    { name: 'Qualified for next round', value: qualifiedTeamNames.join(', ') || 'No teams selected' },
  ]);

  const successEmbed = new EmbedBuilder()
    .setTitle(`🏆 Qualification Confirmed — Group ${group.groupNumber}`)
    .setColor(0x22c55e)
    .setDescription(
      `Successfully updated qualification for **${newlyQualifiedNames.length + alreadyQualifiedNames.length}** team(s) from **Group ${group.groupNumber}**!\n\n` +
      (newlyQualifiedNames.length > 0 ? `• **Newly Qualified:** ${newlyQualifiedNames.map((n) => `**${n}**`).join(', ')}\n` : '') +
      (alreadyQualifiedNames.length > 0 ? `• **Already Qualified:** ${alreadyQualifiedNames.map((n) => `*${n}*`).join(', ')}\n` : '') +
      `\n• **Progression Status:** Teams are saved in MongoDB and will be eligible when creating and starting the next round.\n` +
      `• The group slot list and bot-commands summaries have been updated in place.`
    )
    .setFooter({ text: `Admin: ${member.user?.tag || member.id}` })
    .setTimestamp();

  const successRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_qualify:${tournamentId}:${round.roundId}`)
      .setLabel('Back to Groups')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`)
      .setLabel('Back to Round')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_tour_back_to_panel:${tournamentId}`)
      .setLabel('Back to Dashboard')
      .setEmoji('🏠')
      .setStyle(ButtonStyle.Secondary)
  );

  if (interaction.deferred) {
    await interaction.editReply({ content: null, embeds: [successEmbed], components: [successRow] }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: null, embeds: [successEmbed], components: [successRow] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [successEmbed], components: [successRow], ephemeral: true }).catch(() => {});
  }
}

/**
 * Handles the "Qualify Team" button click in an ID/PWD channel (delegates to slot selection).
 */
export async function handleQualifyTeamButton(interaction, tournamentId, roundId, groupId) {
  return handleRoundQualifySlotSelection(interaction, tournamentId, roundId, groupId);
}

/**
 * Handles confirmation of team qualification from select menu (delegates to prompt confirmation).
 */
export async function handleConfirmQualifyTeams(interaction, tournamentId, roundId, groupId, selectedTeamValues) {
  return handleQualifyPromptConfirmation(interaction, tournamentId, roundId, groupId, selectedTeamValues);
}

/**
 * Handles .submit result command executed by participants.
 * Checks global submission switch and verifies group eligibility.
 */
export async function handleSubmitResultPromptCommand(guild, member, channel, replyFn) {
  if (!guild || !isOfficialGuild(guild)) {
    await replyFn('❌ Result submission is restricted to the official MatchDistrict Discord server.');
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const tournaments = currentSettings.tournaments || {};

  let activeTour = null;
  let activeRound = null;
  let userGroup = null;

  for (const tour of Object.values(tournaments)) {
    for (const r of Object.values(tour.rounds || {})) {
      if (r.status === 'Active' || r.status === 'Started') {
        for (const g of r.groups || []) {
          const hasMember = (g.slots || []).some((s) =>
            s.status === 'OCCUPIED' &&
            Array.isArray(s.members) &&
            s.members.some((m) => m.discord_id === member.id)
          );
          if (hasMember) {
            activeTour = tour;
            activeRound = r;
            userGroup = g;
            break;
          }
        }
      }
      if (userGroup) break;
    }
    if (userGroup) break;
  }

  if (!userGroup) {
    if (isAdmin(member)) {
      await replyFn('ℹ️ **Admin Notice:** Use the **Global Result Submission** control panel in the tournament\'s `#bot-commands` channel to open or close submissions.');
      return;
    }
    await replyFn('❌ **Not Found:** You are not an assigned team member in any group of the active tournament round.');
    return;
  }

  if (activeRound.globalSubmissionStatus !== 'Open') {
    await replyFn(`🔴 **Submissions Closed:** Match result submissions for **${activeRound.name}** are currently closed by tournament administrators.`);
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_group_submit_result:${activeTour.tournamentId}:${activeRound.roundId}:${userGroup.groupId}`)
      .setLabel(`Submit Result for Group ${userGroup.groupNumber}`)
      .setEmoji('📤')
      .setStyle(ButtonStyle.Success)
  );

  await replyFn({
    content: `📋 **Match Result Submission Portal**\n` +
      `• **Tournament:** **${activeTour.tournamentTitle || activeTour.tournamentId}**\n` +
      `• **Round:** **${activeRound.name}**\n` +
      `• **Group:** **Group ${userGroup.groupNumber}**\n\n` +
      `Click the button below to submit your match placement, kills, and scorecard screenshot:`,
    components: [row],
  });
}

/**
 * Handles "Submit Result" button click in an ID/PWD channel.
 */
export async function handleGroupSubmitResultButton(interaction, tournamentId, roundId, groupId) {
  const guild = interaction.guild;
  const member = interaction.member;

  if (!guild || !isOfficialGuild(guild)) {
    await interaction.reply({
      content: '❌ Result submission is restricted to the official MatchDistrict Discord server.',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    await interaction.reply({ content: '❌ Tournament configuration not found.', ephemeral: true }).catch(() => {});
    return;
  }

  const round = savedTournament.rounds?.[roundId];
  if (!round) {
    await interaction.reply({ content: '❌ Round not found.', ephemeral: true }).catch(() => {});
    return;
  }

  const group = (round.groups || []).find((g) => g.groupId === groupId);
  if (!group) {
    await interaction.reply({ content: '❌ Group not found.', ephemeral: true }).catch(() => {});
    return;
  }

  // Check round active status
  if (round.status !== 'Active' && round.status !== 'Started') {
    await interaction.reply({
      content: `❌ **Submission Unavailable:** Result submission is only permitted for the active tournament round. (Current status: **${round.status}**)`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // Check global round submission switch
  if (round.globalSubmissionStatus !== 'Open') {
    await interaction.reply({
      content: `🔴 **Submissions Closed:** Global result submissions for **${round.name}** are currently closed by tournament administrators.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // Check group submission status
  if (group.submissionStatus === 'Submission Closed') {
    await interaction.reply({
      content: `🔒 **Submissions Closed:** Result submissions for this group have been closed by tournament administrators.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  if (group.submissionStatus === 'Accepted') {
    await interaction.reply({
      content: `✅ **Result Already Accepted:** The official match result for this group has already been verified and accepted.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // Verify that the user is an eligible registered member of this group (or an administrator)
  const isMemberInGroup = (group.slots || []).some((slot) =>
    slot.status === 'OCCUPIED' &&
    Array.isArray(slot.members) &&
    slot.members.some((m) => m.discord_id === member.id)
  );

  const isTournamentAdmin = checkTournamentAccess(guild, member).allowed;

  if (!isMemberInGroup && !isTournamentAdmin) {
    await interaction.reply({
      content: `❌ **Unauthorized:** You are not an eligible registered participant allocated to **${round.name} — Group ${group.groupNumber}**.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // Find user's allocated team name if available
  const userSlot = (group.slots || []).find((slot) =>
    slot.status === 'OCCUPIED' &&
    Array.isArray(slot.members) &&
    slot.members.some((m) => m.discord_id === member.id)
  );
  const defaultTeamName = userSlot ? userSlot.teamName : '';

  const modal = new ModalBuilder()
    .setCustomId(`md_modal_submit_result:${tournamentId}:${roundId}:${groupId}`)
    .setTitle(`Submit Result — Group ${group.groupNumber}`.slice(0, 45));

  const teamInput = new TextInputBuilder()
    .setCustomId('team_name')
    .setLabel('Team Name')
    .setValue(defaultTeamName)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const rankInput = new TextInputBuilder()
    .setCustomId('placement_rank')
    .setLabel('Placement / Rank (#)')
    .setPlaceholder('e.g. 1, 2, 3...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(2);

  const killsInput = new TextInputBuilder()
    .setCustomId('total_kills')
    .setLabel('Total Team Kills')
    .setPlaceholder('e.g. 12')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(4);

  const notesInput = new TextInputBuilder()
    .setCustomId('match_notes')
    .setLabel('Match Notes / Remarks (Optional)')
    .setPlaceholder('Optional match details, opponents, timing...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300);

  modal.addComponents(
    new ActionRowBuilder().addComponents(teamInput),
    new ActionRowBuilder().addComponents(rankInput),
    new ActionRowBuilder().addComponents(killsInput),
    new ActionRowBuilder().addComponents(notesInput)
  );

  await interaction.showModal(modal).catch(() => {});
}

/**
 * Handles text field submission from the Result Submission modal.
 * Creates a secure temporary upload interface for screenshot verification.
 */
export async function handleGroupSubmitResultModal(interaction, tournamentId, roundId, groupId) {
  const guild = interaction.guild;
  const member = interaction.member;

  if (!guild || !isOfficialGuild(guild)) {
    await interaction.reply({
      content: '❌ Result submission is restricted to the official MatchDistrict Discord server.',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const teamName = interaction.fields?.getTextInputValue('team_name')?.trim();
  const placementRank = interaction.fields?.getTextInputValue('placement_rank')?.trim();
  const totalKills = interaction.fields?.getTextInputValue('total_kills')?.trim();
  const matchNotes = interaction.fields?.getTextInputValue('match_notes')?.trim() || '';

  const rankNum = parseInt(placementRank, 10);
  const killsNum = parseInt(totalKills, 10);

  if (isNaN(rankNum) || rankNum < 1 || rankNum > 25) {
    await interaction.reply({
      content: '❌ **Invalid Placement:** Placement / Rank must be a number between 1 and 25.',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  if (isNaN(killsNum) || killsNum < 0) {
    await interaction.reply({
      content: '❌ **Invalid Kills:** Total kills must be a valid non-negative number.',
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // Defer reply immediately so channel/thread creation does not violate Discord 3s interaction deadline
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);

  if (!savedTournament || !round || !group) {
    await interaction.editReply({ content: '❌ Group or round configuration not found.' }).catch(() => {});
    return;
  }

  const groupChannel = group.channelId
    ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null))
    : null;

  if (!groupChannel) {
    await interaction.editReply({ content: '❌ Group channel not found.' }).catch(() => {});
    return;
  }

  const submissionId = 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(-4);
  const cleanTeam = teamName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'team';
  const botMember = guild.members.me;

  let tempUploadChannel = null;
  let isThread = false;

  // Try creating a Private Thread on the group channel first
  try {
    if (typeof groupChannel.threads?.create === 'function') {
      tempUploadChannel = await groupChannel.threads.create({
        name: `verify-${cleanTeam}-${Date.now().toString(36).slice(-4)}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60,
        reason: `Temporary result verification upload for ${teamName}`,
      });
      isThread = true;
      if (tempUploadChannel?.members?.add) {
        await tempUploadChannel.members.add(member.id).catch(() => {});
      }
    }
  } catch (threadErr) {
    console.warn('[Discord Bot] Private thread creation not available, creating private upload channel:', threadErr.message);
  }

  // Fallback to creating a temporary private text channel in the tournament category
  if (!tempUploadChannel) {
    try {
      tempUploadChannel = await guild.channels.create({
        name: `verify-${cleanTeam}`,
        type: ChannelType.GuildText,
        parent: groupChannel.parentId,
        topic: `Temporary result verification upload for ${teamName} (${round.name} Group ${group.groupNumber})`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
            ],
          },
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      });
    } catch (createErr) {
      await interaction.reply({
        content: `❌ Failed to create temporary upload interface: ${createErr.message}`,
        ephemeral: true,
      }).catch(() => {});
      return;
    }
  }

  // Register in pending submissions map
  pendingResultSubmissions.set(tempUploadChannel.id, {
    submissionId,
    tournamentId,
    roundId,
    groupId,
    submitterId: member.id,
    submitterTag: member.user?.tag || member.user?.username,
    teamName,
    placementRank: rankNum,
    totalKills: killsNum,
    matchNotes,
    createdAt: Date.now(),
    isThread,
  });

  // Post instructions in the temporary upload channel
  const uploadEmbed = new EmbedBuilder()
    .setTitle(`📸 Match Result Verification — Step 2 of 2`)
    .setColor(0x3b82f6)
    .setDescription(
      `Hello <@${member.id}>! Your match result text details have been recorded:\n\n` +
      `• **Team Name:** **${teamName}**\n` +
      `• **Placement / Rank:** **#${rankNum}**\n` +
      `• **Total Kills:** **${killsNum}**\n` +
      (matchNotes ? `• **Notes:** *${matchNotes}*\n` : '') +
      `\n**Required Final Step:**\n` +
      `Please upload your **end-game screenshot** directly in this private channel.\n` +
      `• Must be a valid image file (\`.png\`, \`.jpg\`, \`.jpeg\`, \`.webp\`).\n` +
      `• Maximum file size: **10 MB**.\n` +
      `• Once uploaded, your submission will be securely saved and forwarded to tournament administrators for review.`
    )
    .setFooter({ text: 'This temporary verification channel will automatically close once your screenshot is received.' });

  await tempUploadChannel.send({ content: `<@${member.id}>`, embeds: [uploadEmbed] }).catch(() => {});

  // Set 10-minute timeout to clean up abandoned temporary channel
  setTimeout(async () => {
    if (pendingResultSubmissions.has(tempUploadChannel.id)) {
      pendingResultSubmissions.delete(tempUploadChannel.id);
      try {
        await tempUploadChannel.delete('Result submission timed out');
      } catch {}
    }
  }, 10 * 60 * 1000);

  await interaction.editReply({
    content: `✅ **Result details registered!** Please upload your match screenshot in <#${tempUploadChannel.id}> to complete your submission.`,
  }).catch(() => {});
}

/**
 * Handles screenshot upload messages in temporary verification channels/threads.
 * Returns true if handled.
 */
export async function handleSubmissionScreenshotUpload(message) {
  if (!message || message.author?.bot) return false;
  if (!pendingResultSubmissions.has(message.channel.id)) return false;

  const pending = pendingResultSubmissions.get(message.channel.id);
  const isAdminUser = checkTournamentAccess(message.guild, message.member).allowed;

  if (message.author.id !== pending.submitterId && !isAdminUser) {
    return true; // Ignore other users
  }

  const attachment = message.attachments?.first();
  if (!attachment) {
    await message.reply('⚠️ Please attach a valid image screenshot (.png, .jpg, .jpeg, or .webp) for result verification.').catch(() => {});
    return true;
  }

  const contentType = attachment.contentType || '';
  const filename = (attachment.name || '').toLowerCase();
  const isImage = contentType.startsWith('image/') ||
    filename.endsWith('.png') ||
    filename.endsWith('.jpg') ||
    filename.endsWith('.jpeg') ||
    filename.endsWith('.webp');

  if (!isImage) {
    await message.reply('❌ **Invalid File:** Only image files (.png, .jpg, .jpeg, .webp) are accepted. Please re-upload your match screenshot.').catch(() => {});
    return true;
  }

  if (attachment.size > 10 * 1024 * 1024) {
    await message.reply('❌ **File Too Large:** Screenshot image size exceeds 10 MB. Please upload a smaller or compressed image.').catch(() => {});
    return true;
  }

  const currentSettings = guildSettingsCache[message.guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[pending.tournamentId];
  const round = savedTournament?.rounds?.[pending.roundId];
  const group = (round?.groups || []).find((g) => g.groupId === pending.groupId);

  if (!savedTournament || !round || !group) {
    await message.reply('❌ An error occurred finding the tournament group configuration.').catch(() => {});
    return true;
  }

  // Reject upload immediately if global submission switch is Closed
  if (round.globalSubmissionStatus !== 'Open') {
    await message.reply('🔴 **Submission Rejected:** Global result submissions have been closed by tournament administrators.').catch(() => {});
    return true;
  }

  const submissionRecord = {
    submissionId: pending.submissionId,
    roundId: pending.roundId,
    groupId: pending.groupId,
    groupNumber: group.groupNumber,
    submitterDiscordId: pending.submitterId,
    submitterUsername: pending.submitterTag,
    teamName: pending.teamName,
    placementRank: pending.placementRank,
    totalKills: pending.totalKills,
    matchNotes: pending.matchNotes,
    screenshotUrl: attachment.url,
    screenshotProxyUrl: attachment.proxyURL || attachment.url,
    screenshotName: attachment.name || 'screenshot.png',
    screenshotSize: attachment.size,
    submittedAt: new Date().toISOString(),
    status: 'Submitted',
    reviewNotes: null,
    reviewedBy: null,
    reviewedAt: null,
  };

  if (!Array.isArray(group.submissions)) {
    group.submissions = [];
  }
  group.submissions.push(submissionRecord);
  group.submissionStatus = 'Submitted';

  if (!Array.isArray(group.submissionAudit)) {
    group.submissionAudit = [];
  }
  group.submissionAudit.push({
    action: 'submitted',
    submissionId: pending.submissionId,
    submitterId: pending.submitterId,
    teamName: pending.teamName,
    timestamp: new Date().toISOString(),
  });

  guildSettingsCache[message.guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);

  await message.reply(
    '✅ **Screenshot Received & Result Submitted!**\n' +
    'Your result has been forwarded to tournament administrators for review.\n' +
    'This temporary verification channel will automatically close shortly.'
  ).catch(() => {});

  // Update control message in the group ID/PWD channel
  const groupChannel = group.channelId
    ? (message.guild.channels.cache.get(group.channelId) || await message.guild.channels.fetch(group.channelId).catch(() => null))
    : null;

  if (groupChannel) {
    await updateGroupControlMessage(message.guild, savedTournament, round, group, groupChannel);
  }

  // Send admin review notification into #bot-commands
  const botCommandsId = savedTournament.channels?.botCommandsId;
  const botCommandsChannel = botCommandsId
    ? (message.guild.channels.cache.get(botCommandsId) || await message.guild.channels.fetch(botCommandsId).catch(() => null))
    : null;

  if (botCommandsChannel) {
    const reviewEmbed = new EmbedBuilder()
      .setTitle(`📥 Result Awaiting Review — ${round.name} (Group ${group.groupNumber})`)
      .setColor(0xeab308) // Gold
      .setDescription(
        `A match result has been submitted for **${round.name} — Group ${group.groupNumber}** in **${savedTournament.tournamentTitle}**.\n` +
        `Channel: <#${group.channelId}>\n` +
        `• **Status:** 🟡 **Submitted / Under Review**`
      )
      .addFields(
        { name: '🎮 Team Name', value: `**${pending.teamName}**`, inline: true },
        { name: '🏆 Placement / Rank', value: `**#${pending.placementRank}**`, inline: true },
        { name: '🎯 Total Kills', value: `**${pending.totalKills}**`, inline: true },
        { name: '👤 Submitter', value: `<@${pending.submitterId}> (\`${pending.submitterTag}\`)`, inline: true },
        { name: '⏰ Submitted At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
        { name: '📝 Notes', value: pending.matchNotes ? pending.matchNotes : '*None*', inline: false }
      )
      .setImage(attachment.url)
      .setFooter({ text: `Submission ID: ${pending.submissionId}` })
      .setTimestamp();

    const reviewRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_result_accept:${pending.tournamentId}:${pending.roundId}:${pending.groupId}:${pending.submissionId}`)
        .setLabel('Accept Result')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`md_result_reject:${pending.tournamentId}:${pending.roundId}:${pending.groupId}:${pending.submissionId}`)
        .setLabel('Reject Result')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
    );

    await botCommandsChannel.send({ embeds: [reviewEmbed], components: [reviewRow] }).catch(() => {});
  }

  // Clean up temporary upload channel
  const tempChannel = message.channel;
  pendingResultSubmissions.delete(tempChannel.id);

  setTimeout(async () => {
    try {
      if (tempChannel.isThread && tempChannel.isThread()) {
        await tempChannel.setLocked(true).catch(() => {});
        await tempChannel.setArchived(true).catch(() => {});
        await tempChannel.delete('Result submission finalized').catch(() => {});
      } else {
        await tempChannel.delete('Result submission finalized').catch(() => {});
      }
    } catch {}
  }, 4000);

  return true;
}

/**
 * Handles administrator "Revoke Submission" button.
 */
export async function handleGroupRevokeSubmissionButton(interaction, tournamentId, roundId, groupId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);

  if (!savedTournament || !round || !group) {
    await interaction.editReply({ content: '❌ Group or round was not found.' }).catch(() => {});
    return;
  }

  group.submissionStatus = 'Submission Closed';
  if (!Array.isArray(group.submissionAudit)) group.submissionAudit = [];
  group.submissionAudit.push({
    action: 'revoked',
    by: member.id,
    byTag: member.user?.tag || member.user?.username,
    timestamp: new Date().toISOString(),
  });

  saveGuildSettings(guildSettingsCache);

  // Clean up any pending upload channels for this group
  for (const [chId, pend] of pendingResultSubmissions.entries()) {
    if (pend.tournamentId === tournamentId && pend.roundId === roundId && pend.groupId === groupId) {
      pendingResultSubmissions.delete(chId);
      try {
        const ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
        if (ch) await ch.delete('Submissions revoked by admin');
      } catch {}
    }
  }

  const groupChannel = group.channelId ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null)) : null;
  if (groupChannel) {
    await updateGroupControlMessage(guild, savedTournament, round, group, groupChannel);
  }

  await interaction.editReply({
    content: `🔒 **Submissions Closed:** Results for **${round.name} — Group ${group.groupNumber}** have been closed. Further submissions are disabled.`,
  }).catch(() => {});
}

/**
 * Handles administrator "Reopen Submission" button.
 */
export async function handleGroupReopenSubmissionButton(interaction, tournamentId, roundId, groupId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);

  if (!savedTournament || !round || !group) {
    await interaction.editReply({ content: '❌ Group or round was not found.' }).catch(() => {});
    return;
  }

  group.submissionStatus = 'Awaiting submission';
  if (!Array.isArray(group.submissionAudit)) group.submissionAudit = [];
  group.submissionAudit.push({
    action: 'reopened',
    by: member.id,
    byTag: member.user?.tag || member.user?.username,
    timestamp: new Date().toISOString(),
  });

  saveGuildSettings(guildSettingsCache);

  const groupChannel = group.channelId ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null)) : null;
  if (groupChannel) {
    await updateGroupControlMessage(guild, savedTournament, round, group, groupChannel);
  }

  await interaction.editReply({
    content: `🔓 **Submissions Reopened:** Result submission window for **${round.name} — Group ${group.groupNumber}** has been reopened.`,
  }).catch(() => {});
}

/**
 * Handles administrator "Accept Result" button.
 */
export async function handleAdminAcceptResultButton(interaction, tournamentId, roundId, groupId, submissionId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Acknowledge interaction immediately within Discord deadline (<3s)
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);
  const submission = (group?.submissions || []).find((s) => s.submissionId === submissionId);

  if (!savedTournament || !round || !group || !submission) {
    await interaction.editReply({ content: '❌ Submission or group record not found.' }).catch(() => {});
    return;
  }

  submission.status = 'Accepted';
  submission.reviewedBy = member.id;
  submission.reviewedAt = new Date().toISOString();
  group.submissionStatus = 'Accepted';

  if (!Array.isArray(group.submissionAudit)) group.submissionAudit = [];
  group.submissionAudit.push({
    action: 'accepted',
    submissionId,
    by: member.id,
    timestamp: new Date().toISOString(),
  });

  saveGuildSettings(guildSettingsCache);

  // Update control message in the group channel
  const groupChannel = group.channelId ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null)) : null;
  if (groupChannel) {
    await updateGroupControlMessage(guild, savedTournament, round, group, groupChannel);
  }

  // Update review embed in #bot-commands
  if (interaction.message && typeof interaction.message.edit === 'function') {
    const existingEmbeds = interaction.message.embeds || [];
    if (existingEmbeds.length > 0) {
      const updatedEmbed = EmbedBuilder.from(existingEmbeds[0])
        .setColor(0x22c55e)
        .setTitle(`✅ Result Accepted — ${round.name} (Group ${group.groupNumber})`)
        .setFooter({ text: `Accepted by ${member.user?.tag || member.user?.username} • ID: ${submissionId}` });
      await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
    }
  }

  await interaction.editReply({
    content: `✅ Result for **${submission.teamName}** in **${round.name} — Group ${group.groupNumber}** officially **Accepted**!`,
  }).catch(() => {});
}

/**
 * Handles administrator "Reject Result" button click: displays rejection reason modal.
 */
export async function handleAdminRejectResultButton(interaction, tournamentId, roundId, groupId, submissionId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`md_modal_reject_result:${tournamentId}:${roundId}:${groupId}:${submissionId}`)
    .setTitle(`Reject Result — Group ${groupId}`.slice(0, 45));

  const reasonInput = new TextInputBuilder()
    .setCustomId('rejection_reason')
    .setLabel('Reason for Rejection')
    .setPlaceholder('e.g. Blurry screenshot, rank mismatch, wrong lobby...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(300);

  modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
  await interaction.showModal(modal).catch(() => {});
}

/**
 * Handles submission of Reject Result modal.
 */
export async function handleAdminRejectResultModal(interaction, tournamentId, roundId, groupId, submissionId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Defer reply immediately so Discord deadline is satisfied during channel/message updates
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  const reason = interaction.fields?.getTextInputValue('rejection_reason')?.trim() || 'Criteria not met';

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);
  const submission = (group?.submissions || []).find((s) => s.submissionId === submissionId);

  if (!savedTournament || !round || !group || !submission) {
    await interaction.editReply({ content: '❌ Submission or group record not found.' }).catch(() => {});
    return;
  }

  submission.status = 'Rejected';
  submission.reviewNotes = reason;
  submission.reviewedBy = member.id;
  submission.reviewedAt = new Date().toISOString();
  group.submissionStatus = 'Rejected';

  if (!Array.isArray(group.submissionAudit)) group.submissionAudit = [];
  group.submissionAudit.push({
    action: 'rejected',
    submissionId,
    reason,
    by: member.id,
    timestamp: new Date().toISOString(),
  });

  saveGuildSettings(guildSettingsCache);

  // Update control message in the group channel (Submit Result is now re-enabled for resubmission)
  const groupChannel = group.channelId ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null)) : null;
  if (groupChannel) {
    await updateGroupControlMessage(guild, savedTournament, round, group, groupChannel);
  }

  // Update review embed in #bot-commands if possible
  const botCommandsId = savedTournament.channels?.botCommandsId;
  const botCommandsChannel = botCommandsId ? (guild.channels.cache.get(botCommandsId) || await guild.channels.fetch(botCommandsId).catch(() => null)) : null;
  if (botCommandsChannel) {
    try {
      const recent = await botCommandsChannel.messages.fetch({ limit: 20 }).catch(() => null);
      const matchMsg = recent?.find(m => m.embeds?.some(e => e.footer?.text?.includes(submissionId)));
      if (matchMsg) {
        const updated = EmbedBuilder.from(matchMsg.embeds[0])
          .setColor(0xef4444)
          .setTitle(`❌ Result Rejected — ${round.name} (Group ${group.groupNumber})`)
          .addFields({ name: '⚠️ Rejection Reason', value: reason, inline: false })
          .setFooter({ text: `Rejected by ${member.user?.tag || member.user?.username} • ID: ${submissionId}` });
        await matchMsg.edit({ embeds: [updated], components: [] }).catch(() => {});
      }
    } catch {}
  }

  await interaction.editReply({
    content: `❌ Result rejected with reason: "${reason}". The group may now submit a corrected result.`,
  }).catch(() => {});
}

/**
 * Publishes or updates match credentials (Room ID & Password) in a private group channel.
 * Updates existing message in place without leaking credentials to public channels.
 */
export async function publishGroupCredentials(guild, tournamentId, roundId, groupNumber, roomId, password) {
  if (!guild || !isOfficialGuild(guild)) {
    return { success: false, reason: 'Tournament operations are restricted to the official MatchDistrict Discord server.' };
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    return { success: false, reason: `Tournament "${tournamentId}" is not configured in this server.` };
  }

  const rounds = savedTournament.rounds || {};
  let targetRound = rounds[roundId];
  if (!targetRound) {
    targetRound = Object.values(rounds).find(
      (r) => r.roundId === roundId || r.roundNumber === Number(roundId) || r.name.toLowerCase() === String(roundId).toLowerCase()
    );
  }
  if (!targetRound) {
    targetRound = Object.values(rounds).reverse().find((r) => r.status === 'Started');
  }

  if (!targetRound) {
    return { success: false, reason: 'No active or matching round found for publishing match credentials.' };
  }

  const group = (targetRound.groups || []).find(
    (g) => g.groupNumber === Number(groupNumber) || g.groupId === groupNumber
  );

  if (!group) {
    return { success: false, reason: `Group "${groupNumber}" was not found in ${targetRound.name}.` };
  }

  const channel = group.channelId
    ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null))
    : null;

  if (!channel) {
    return { success: false, reason: `Private channel for Group ${group.groupNumber} not found.` };
  }

  const occupiedSlots = (group.slots || []).filter((slot) => slot?.status === 'OCCUPIED' && slot.teamName);
  const verifiedEntries = Object.values(savedTournament.verifiedRegistrations || {});
  const verifiedTeamIds = new Set(verifiedEntries.flatMap((entry) => [String(entry.registrationId || ''), String(entry.teamId || '')]));
  const verifiedTeamNames = new Set(verifiedEntries.map((entry) => String(entry.teamName || '').trim().toLowerCase()).filter(Boolean));
  const unverifiedTeams = occupiedSlots.filter((slot) =>
    !verifiedTeamIds.has(String(slot.teamId || '')) &&
    !verifiedTeamNames.has(String(slot.teamName || '').trim().toLowerCase())
  );
  if (unverifiedTeams.length > 0) {
    return {
      success: false,
      reason: `Room ID and password are locked until every registered team in Group ${group.groupNumber} completes verification in #verification.`,
    };
  }

  group.credentials = {
    roomId,
    password,
    publishedAt: new Date().toISOString(),
  };

  // Ensure strict read-only permissions and update slot list with credentials
  const groupRole = group.roleId ? (guild.roles.cache.get(group.roleId) || await guild.roles.fetch(group.roleId).catch(() => null)) : null;
  const tourRole = savedTournament.roleId ? (guild.roles.cache.get(savedTournament.roleId) || await guild.roles.fetch(savedTournament.roleId).catch(() => null)) : null;
  const { tourneyModRole: modsRole } = await ensureManagementDashboardRoles(guild, savedTournament, guild.members.me);
  await applyStrictGroupChannelPermissions(guild, channel, groupRole, tourRole, guild.members.me, targetRound.groupMessagesOpen, modsRole);
  await removeGroupResultControlMessage(guild, group, channel);
  await updateGroupSlotListMessage(guild, savedTournament, targetRound, group, channel);

  savedTournament.rounds[targetRound.roundId] = targetRound;
  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);

  // Refresh #bot-commands summary
  if (savedTournament.channels?.botCommandsId) {
    const botCommandsChannel = guild.channels.cache.get(savedTournament.channels.botCommandsId) ||
      await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null);
    if (botCommandsChannel) {
      await publishRoundAllocationSummary(guild, savedTournament, targetRound, botCommandsChannel, savedTournament);
    }
  }

  return {
    success: true,
    channelId: channel.id,
    messageId: group.credentialsMessageId,
    roundName: targetRound.name,
    groupNumber: group.groupNumber,
  };
}

/**
 * Handles administrator prefix command for publishing match credentials (.cred, .credentials, .room).
 */
export async function handlePublishCredentialsCommand(guild, member, channel, args = [], replyFn, originalMessage = null) {
  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await replyFn(access.reason);
    return;
  }

  // Protect secret: delete command message if possible
  if (originalMessage && typeof originalMessage.delete === 'function') {
    await originalMessage.delete().catch(() => {});
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const tournaments = currentSettings.tournaments || {};

  let targetTournamentId = null;
  let targetRoundId = null;
  let targetGroupNumber = null;
  let roomId = null;
  let password = null;

  // Case 1: Check if invoked directly inside a group channel
  for (const [tourId, tourData] of Object.entries(tournaments)) {
    for (const [rId, rData] of Object.entries(tourData.rounds || {})) {
      for (const grp of rData.groups || []) {
        if (grp.channelId === channel.id) {
          targetTournamentId = tourId;
          targetRoundId = rId;
          targetGroupNumber = grp.groupNumber;
          break;
        }
      }
      if (targetTournamentId) break;
    }
    if (targetTournamentId) break;
  }

  if (targetTournamentId && targetGroupNumber) {
    // Command syntax in group channel: .cred <room_id> <password>
    if (args.length < 2) {
      await replyFn('ℹ️ **Usage in group channel:** `.cred <room_id> <password>`');
      return;
    }
    roomId = args[0];
    password = args[1];
  } else {
    // Case 2: Check if invoked in #bot-commands
    for (const [tourId, tourData] of Object.entries(tournaments)) {
      if (tourData.channels?.botCommandsId === channel.id) {
        targetTournamentId = tourId;
        break;
      }
    }

    if (targetTournamentId && args.length === 3) {
      // Syntax: .cred <group_number> <room_id> <password>
      targetGroupNumber = parseInt(args[0], 10);
      roomId = args[1];
      password = args[2];
    } else if (targetTournamentId && args.length === 4) {
      // Syntax: .cred <round_id_or_number> <group_number> <room_id> <password>
      targetRoundId = args[0];
      targetGroupNumber = parseInt(args[1], 10);
      roomId = args[2];
      password = args[3];
    } else if (args.length >= 5) {
      // Universal syntax: .cred <tournament_id> <round_id> <group_number> <room_id> <password>
      targetTournamentId = args[0];
      targetRoundId = args[1];
      targetGroupNumber = parseInt(args[2], 10);
      roomId = args[3];
      password = args[4];
    } else {
      await replyFn(
        'ℹ️ **Credential Publishing Usage:**\n' +
        '• **Inside group channel:** `.cred <room_id> <password>`\n' +
        '• **Inside #bot-commands:** `.cred <group_number> <room_id> <password>` or `.cred <round_id> <group_number> <room_id> <password>`\n' +
        '• **Anywhere (Admin):** `.cred <tournament_id> <round_id> <group_number> <room_id> <password>`'
      );
      return;
    }
  }

  if (!roomId || !password || isNaN(targetGroupNumber)) {
    await replyFn('❌ **Invalid arguments.** Both `room_id` and `password` are required.');
    return;
  }

  const result = await publishGroupCredentials(guild, targetTournamentId, targetRoundId, targetGroupNumber, roomId, password);
  if (!result.success) {
    await replyFn(`❌ **Failed to publish credentials:** ${result.reason}`);
    return;
  }

  await replyFn(
    `✅ **Credentials Published:** Official room details sent to <#${result.channelId}> for **${result.roundName} (Group ${result.groupNumber})** without leaking to public channels.`
  );
}

  /**
   * Format synchronization completion summary message.
   */
  export function formatSyncSummaryMessage(tournament, summary, syncResult) {
    const isPartial = syncResult.failures.length > 0;
    const statusEmoji = isPartial ? '⚠️' : '✅';
    const statusTitle = isPartial
      ? '**Tournament Synchronization Completed with Warnings**'
      : '**Tournament Synchronization Complete**';

    let msg = `${statusEmoji} ${statusTitle}\n\n` +
      `• 🏆 **Tournament:** **${tournament.title}** (ID: \`${tournament.id}\`)\n` +
      `• 🎮 **Status:** ${tournament.status?.toUpperCase() || 'PUBLISHED'}\n` +
      `• 👥 **Registered Teams:** **${summary.total_registered_teams}** total (` +
      `🟢 **${summary.eligible_teams_count}** eligible, 🔴 **${summary.ineligible_teams_count}** ineligible/rejected)\n` +
      `• 🔗 **Eligible Linked Discord Members:** **${summary.eligible_linked_members_count}** participant(s) granted channel access\n` +
      `• ⚠️ **Unlinked Participants:** **${summary.unlinked_members_count}** account(s) not linked to Discord on website\n` +
      `• 🛡️ **Duplicate Discord IDs:** **${summary.duplicate_discord_ids_count || 0}** safely deduplicated\n\n` +
      `📁 **Tournament Categories & Channels:**\n` +
      `• **Category:** <#${syncResult.categoryId}> — all tournament and round channels\n` +
      `  - 🤖 **Bot Commands (Admin Only):** ${syncResult.channelIds?.botCommandsId ? `<#${syncResult.channelIds.botCommandsId}>` : '#bot-commands'}\n` +
      `  - 📢 **Updates:** ${syncResult.channelIds?.tournamentUpdateId ? `<#${syncResult.channelIds.tournamentUpdateId}>` : '#updates'}\n` +
      `  - 🗺️ **Roadmap:** ${syncResult.channelIds?.tournamentRoadmapId ? `<#${syncResult.channelIds.tournamentRoadmapId}>` : '#roadmap'}\n` +
      `  - 📊 **Scoreboard:** ${syncResult.channelIds?.tournamentScoreboardId ? `<#${syncResult.channelIds.tournamentScoreboardId}>` : '#scoreboard'}\n` +
      `  - 💬 **Helpdesk:** ${syncResult.channelIds?.tournamentHelpdeskId ? `<#${syncResult.channelIds.tournamentHelpdeskId}>` : '#helpdesk'}\n` +
      `  - 🔗 **Register:** ${syncResult.channelIds?.tournamentRegisterId ? `<#${syncResult.channelIds.tournamentRegisterId}>` : '#register-here'}\n` +
      `  - ✅ **Verification:** ${syncResult.channelIds?.tournamentVerificationId ? `<#${syncResult.channelIds.tournamentVerificationId}>` : '#verification'}\n` +
      `  - 👥 **Registered Teams:** ${syncResult.channelIds?.tournamentTeamsId ? `<#${syncResult.channelIds.tournamentTeamsId}>` : '#registered-team'}\n` +
      `  - 🧾 **Spec Results:** ${syncResult.channelIds?.specResultId ? `<#${syncResult.channelIds.specResultId}>` : '#spec-result'}\n` +
      `  - 🧾 **Tournament Log:** ${syncResult.channelIds?.tournamentLogId ? `<#${syncResult.channelIds.tournamentLogId}>` : '#tournament-log'}\n` +
      `  - 🔊 **Room Maker:** ${syncResult.channelIds?.roomMakerVcId ? `<#${syncResult.channelIds.roomMakerVcId}>` : '#room-maker-vc'}\n` +
      `• **Roster Status:** ${syncResult.teamsUpdatedInChannel ? '🟢 **Published to #registered-team**' : '⚪ **Roster ready**'}\n` +
      `• **Permission Overwrites:** **${syncResult.permissionsUpdated}** applied, **${syncResult.permissionsRemoved}** removed\n`;

    if (syncResult.obsoleteSquadChannelsDeleted > 0) {
      msg += `• 🧹 **Migration:** Safely deleted **${syncResult.obsoleteSquadChannelsDeleted}** obsolete squad channel(s)\n`;
    }

    if (syncResult.failures.length > 0) {
      msg += `\n⚠️ **Warnings:**\n`;
      for (const f of syncResult.failures.slice(0, 5)) {
        msg += `  • ${f}\n`;
      }
    }

    return msg;
  }

  /**
   * Fetches tournaments a user is eligible to access from the MatchDistrict backend by verified Discord ID.
   */
  export async function fetchUserEligibleTournamentsFromBackend(discordId) {
    const apiUrl = getBackendApiUrl();
    const secret = getBackendBotSecret();
    const url = `${apiUrl}/api/bot/users/${encodeURIComponent(discordId)}/eligible-tournaments`;

    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'MatchDistrict-Discord-Bot/1.0',
    };
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
      headers['x-bot-secret'] = secret;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (res.status === 401) {
        throw new Error('Backend authorization failed: Invalid or missing bot secret (MATCHDISTRICT_BOT_SECRET).');
      }
      if (!res.ok) {
        throw new Error(`Backend returned HTTP status ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Backend request timed out while fetching user eligible tournaments (10s limit).');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Synchronizes channel access for a single member across all eligible tournaments.
   * Runs on guildMemberAdd and on post-link webhooks.
   * Strictly verifies official server and verified linked Discord user ID.
   * Grants access ONLY to #tournament-update, #tournament-helpdesk, and #tournament-register.
   * NEVER grants access to #bot-commands or #tournament-teams.
   */
  export async function syncMemberTournamentAccess(member) {
    if (!member || !member.guild || !isOfficialGuild(member.guild)) {
      return { success: false, reason: 'unauthorized_guild' };
    }
    const discordId = member.id;
    if (!isValidDiscordSnowflake(discordId)) {
      return { success: false, reason: 'invalid_snowflake' };
    }

    try {
      const backendData = await fetchUserEligibleTournamentsFromBackend(discordId);
      if (!backendData || !Array.isArray(backendData.eligible_tournaments) || backendData.eligible_tournaments.length === 0) {
        return { success: true, grantedCount: 0, reason: 'no_eligible_tournaments' };
      }

      const currentSettings = guildSettingsCache[member.guild.id] || {};
      const trackedTournaments = currentSettings.tournaments || {};
      let grantedCount = 0;

      for (const eligibleTour of backendData.eligible_tournaments) {
        const saved = trackedTournaments[eligibleTour.id];
        if (!saved || saved.setupStatus === 'deleted') continue;

        const channels = saved.channels || {};
        const participantChannelsConfig = [
          {
            key: 'tournamentUpdateId',
            permissions: {
              ViewChannel: true,
              ReadMessageHistory: true,
              SendMessages: false,
              CreatePublicThreads: false,
              CreatePrivateThreads: false,
              AddReactions: false,
            },
          },
          {
            key: 'tournamentRegisterId',
            permissions: {
              ViewChannel: true,
              ReadMessageHistory: true,
              SendMessages: false,
              CreatePublicThreads: false,
              CreatePrivateThreads: false,
              AddReactions: false,
            },
          },
          {
            key: 'tournamentHelpdeskId',
            permissions: {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
              AttachFiles: true,
              EmbedLinks: true,
            },
          },
        ];

        for (const { key, permissions } of participantChannelsConfig) {
          const chId = channels[key];
          if (!chId) continue;
          const channel = member.guild.channels.cache.get(chId) || await member.guild.channels.fetch(chId).catch(() => null);
          if (channel && channel.permissionOverwrites) {
            await channel.permissionOverwrites.edit(discordId, permissions).catch(() => { });
            grantedCount++;
          }
        }

        // Ensure member has NO access to bot-commands or tournament-teams
        for (const key of ['botCommandsId', 'tournamentTeamsId']) {
          const chId = channels[key];
          if (!chId) continue;
          const channel = member.guild.channels.cache.get(chId) || await member.guild.channels.fetch(chId).catch(() => null);
          if (channel && channel.permissionOverwrites) {
            await channel.permissionOverwrites.delete(discordId).catch(() => { });
          }
        }

        if (!Array.isArray(saved.allEligibleMemberIds)) {
          saved.allEligibleMemberIds = [];
        }
        if (!saved.allEligibleMemberIds.includes(discordId)) {
          saved.allEligibleMemberIds.push(discordId);
        }
      }

      saveGuildSettings(guildSettingsCache);
      return { success: true, grantedCount };
    } catch (err) {
      console.warn(`[Discord Bot] Failed to synchronize tournament access for member ${discordId}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Reconciles participant access across all active tournaments in the official server.
   * Handles existing members and revokes access when members are no longer eligible.
   */
  export async function reconcileAllTournamentAccess(guild) {
    if (!guild || !isOfficialGuild(guild)) {
      return { synchronizedTournaments: 0, failures: [] };
    }

    const currentSettings = guildSettingsCache[guild.id] || {};
    const trackedTournaments = currentSettings.tournaments || {};
    const botMember = guild.members.me;
    const results = {
      synchronizedTournaments: 0,
      failures: [],
    };

    for (const [tournamentId, saved] of Object.entries(trackedTournaments)) {
      if (!saved || saved.setupStatus === 'deleted') continue;

      try {
        await withTournamentLock(tournamentId, async () => {
          const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
          const { tournament, teams, summary } = backendData;

          await syncTournamentDiscordChannels(guild, tournament, teams, botMember);
          await setupTournamentControlPanel(guild, tournament, summary, botMember);

          saved.lastParticipantSyncAt = new Date().toISOString();
          results.synchronizedTournaments++;
        });
      } catch (err) {
        results.failures.push(`Reconcile error for ${tournamentId}: ${err.message}`);
      }
    }

    saveGuildSettings(guildSettingsCache);
    return results;
  }

  /**
   * Prompts an administrator with a 30-second confirmation dialog before permanently deleting a tournament.
   *
   * @param {import('discord.js').ButtonInteraction} interaction
   * @param {string} tournamentId
   */
  export async function handlePermanentTournamentDeletePrompt(interaction, tournamentId) {
    const guild = interaction.guild;
    const member = interaction.member;
    const access = checkTournamentAccess(guild, member);
    if (!access.allowed) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
      }
      return;
    }

    const saved = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
    const tourTitle = saved?.tournamentTitle || tournamentId;

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dash:main:confirm-delete-tournament:${tournamentId}`)
        .setLabel('Confirm Permanent Deletion')
        .setEmoji('💣')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`dash:main:cancel-delete-tournament:${tournamentId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    const promptText = `💣 **Confirm Permanent Tournament Deletion**\n` +
      `Are you sure you want to permanently delete tournament **${tourTitle}** (\`${tournamentId}\`)?\n\n` +
      `⚠️ **This action is irreversible and will permanently delete:**\n` +
      `• ALL Discord channels including \`#bot-commands\`, announcements, teams, helpdesk, voice channels, and group channels\n` +
      `• The tournament category and any empty legacy categories\n` +
      `• The tournament role and round group roles; Tourney-mod and Spectator are preserved\n` +
      `• All MongoDB tournament documents, rounds, slot lists, and managed message mappings\n\n` +
      `⏱️ **This confirmation prompt will expire in 30 seconds.**`;

    await interaction.editReply({ content: promptText, components: [confirmRow], embeds: [] }).catch(() => {});
  }

  /**
   * Confirms and triggers permanent tournament deletion from button interaction.
   *
   * @param {import('discord.js').ButtonInteraction} interaction
   * @param {string} tournamentId
   */
  export async function handleConfirmPermanentTournamentDelete(interaction, tournamentId) {
    const guild = interaction.guild;
    const member = interaction.member;
    const access = checkTournamentAccess(guild, member);
    if (!access.allowed) {
      if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: access.reason, components: [] }).catch(() => {});
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
      }
      return;
    }

    if (typeof interaction.editReply === 'function') {
      await interaction.editReply({
        content: `⏳ **Initiating permanent deletion for tournament \`${tournamentId}\`...**\n*Deleting channels, roles, and MongoDB data.*`,
        components: [],
      }).catch(() => {});
    }

    const result = await executeTournamentPermanentDeletion(guild, tournamentId, member);

    const replyMsg = `🗑️ **Permanent Tournament Deletion Completed**\n` +
      `• **Tournament:** \`${tournamentId}\`\n` +
      `• **Channels Deleted:** ${result.deletedChannels.length > 0 ? result.deletedChannels.map((c) => `\`#${c}\``).join(', ') : 'None'}\n` +
      `• **Category Deleted:** ${result.categoryDeleted ? 'Yes' : 'No'}\n` +
      `• **Roles Deleted:** ${result.rolesDeletedCount}\n` +
      `• **Database Records Purged:** Yes (MongoDB records, rounds, slot lists, and managed messages purged)\n` +
      `• **Status:** \`deleted\``;

    if (typeof interaction.followUp === 'function') {
      await interaction.followUp({ content: replyMsg, ephemeral: true }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ content: replyMsg }).catch(() => {});
    }
  }

  /**
   * Command handler for prefix `.delete tournament <id>`
   */
  export async function handlePermanentTournamentDeleteCommand(guild, member, channel, tournamentId, replyFn) {
    const access = checkTournamentAccess(guild, member);
    if (!access.allowed) {
      await replyFn(access.reason);
      return;
    }

    if (!tournamentId) {
      await replyFn('ℹ️ **Usage:** `.delete tournament <tournament_id>` — Permanently delete a tournament and all its channels.');
      return;
    }

    const saved = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
    const tourTitle = saved?.tournamentTitle || tournamentId;

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_tour_confirm_delete_permanent:${tournamentId}`)
        .setLabel('Confirm Permanent Deletion')
        .setEmoji('💣')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`md_tour_cancel_delete_permanent:${tournamentId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    const promptText = `💣 **Confirm Permanent Tournament Deletion**\n` +
      `Are you sure you want to permanently delete tournament **${tourTitle}** (\`${tournamentId}\`)?\n\n` +
      `⚠️ **This action is irreversible and will permanently delete:**\n` +
      `• ALL Discord channels including \`#bot-commands\`, announcements, teams, helpdesk, voice channels, and group channels\n` +
      `• The tournament category and any empty legacy categories\n` +
      `• The dedicated tournament role and round group roles\n` +
      `• The Tourney-mod and Spectator roles are preserved\n` +
      `• All MongoDB tournament documents, rounds, slot lists, and managed message mappings\n\n` +
      `⏱️ **This confirmation prompt will expire in 30 seconds.**`;

    await replyFn({ content: promptText, components: [confirmRow] });
  }

  /**
   * Executes full permanent tournament deletion across Discord and MongoDB.
   * Follows strict state machine: active -> deletion_pending -> deleting -> deleted
   *
   * @param {import('discord.js').Guild} guild
   * @param {string} tournamentId
   * @param {import('discord.js').GuildMember|null} adminMember
   */
  export async function executeTournamentPermanentDeletion(guild, tournamentId, adminMember = null) {
    const currentSettings = guildSettingsCache[guild.id] || {};
    let saved = currentSettings.tournaments?.[tournamentId];

    if (!saved && isMongoConnected()) {
      try {
        saved = await findTournamentByBotCommandsChannel(guild.id, tournamentId);
      } catch {}
    }

    const summary = {
      deletedChannels: [],
      categoryDeleted: false,
      rolesDeletedCount: 0,
      failures: [],
    };

    if (!saved) {
      await purgeAllTournamentDataFromDb(guild.id, tournamentId);
      return summary;
    }
    const legacyCategoryShared = Object.entries(currentSettings.tournaments || {}).some(([otherId, other]) =>
      otherId !== tournamentId && [other.categoryId, other.publicCategoryId, other.managementCategoryId,
        ...Object.values(other.rounds || {}).map((round) => round?.categoryId)].includes(saved.categoryId)
    );

    // 1. Transition state: deletion_pending -> deleting
    saved.deletionStatus = 'deletion_pending';
    if (guildSettingsCache[guild.id]?.tournaments) {
      guildSettingsCache[guild.id].tournaments[tournamentId] = saved;
      saveGuildSettings(guildSettingsCache);
    }
    await saveTournamentToDb(guild.id, tournamentId, saved).catch(() => {});

    saved.deletionStatus = 'deleting';
    if (guildSettingsCache[guild.id]?.tournaments) {
      guildSettingsCache[guild.id].tournaments[tournamentId] = saved;
      saveGuildSettings(guildSettingsCache);
    }
    await saveTournamentToDb(guild.id, tournamentId, saved).catch(() => {});

    // 2. Delete managed messages
    try {
      await deleteManagedMessages(guild.client, {
        guildId: guild.id,
        tournamentId,
      });
    } catch (err) {
      summary.failures.push(`Managed messages delete: ${err.message}`);
    }

    // 3. Delete round group channels and group roles
    if (saved.rounds && typeof saved.rounds === 'object') {
      for (const round of Object.values(saved.rounds)) {
        if (Array.isArray(round.groups)) {
          for (const group of round.groups) {
            if (group.channelId) {
              try {
                const gch = guild.channels.cache.get(group.channelId) ||
                  await guild.channels.fetch(group.channelId).catch(() => null);
                if (gch) {
                  const gchName = gch.name;
                  await gch.delete('Tournament permanent deletion: round group channel').catch(() => {});
                  summary.deletedChannels.push(gchName);
                }
              } catch {}
            }
            if (group.voiceChannelId) {
              try {
                const vch = guild.channels.cache.get(group.voiceChannelId) ||
                  await guild.channels.fetch(group.voiceChannelId).catch(() => null);
                if (vch) {
                  const vchName = vch.name;
                  await vch.delete('Tournament permanent deletion: round group voice channel').catch(() => {});
                  summary.deletedChannels.push(vchName);
                }
              } catch {}
            }
            if (group.roleId && guild.roles) {
              try {
                const gr = guild.roles.cache.get(group.roleId) ||
                  await guild.roles.fetch(group.roleId).catch(() => null);
                if (gr && typeof gr.delete === 'function') {
                  await gr.delete('Tournament permanent deletion: round group role').catch(() => {});
                  summary.rolesDeletedCount++;
                }
              } catch {}
            }
          }
        }
      }
    }

    // 4. Delete participant channels & bot-commands & roomMakerVc
    const channelIds = Object.values(saved.channels || {});
    for (const chId of channelIds) {
      if (!chId) continue;
      try {
        const channel = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
        if (channel) {
          const chName = channel.name;
          await queueChannelDelete(channel, 'Tournament permanent deletion').catch(() => {});
          summary.deletedChannels.push(chName);
        }
      } catch (err) {
        summary.failures.push(`Failed to delete channel ${chId}: ${err.message}`);
      }
    }

    // 5. Delete every category owned by the tournament after removing its channels.
    const categoriesUsedByOthers = new Set(Object.entries(currentSettings.tournaments || {})
      .filter(([otherId]) => otherId !== tournamentId)
      .flatMap(([, other]) => [other.categoryId, other.publicCategoryId, other.managementCategoryId,
        ...Object.values(other.rounds || {}).map((round) => round?.categoryId), ...(other.legacyCategoryIds || [])])
      .filter(Boolean));
    const tournamentCategoryIds = new Set([
      saved.categoryId,
      saved.publicCategoryId,
      saved.managementCategoryId,
      ...Object.values(saved.rounds || {}).map((round) => round.categoryId),
      ...(saved.legacyCategoryIds || []),
    ].filter((categoryId) => categoryId && !categoriesUsedByOthers.has(categoryId)));
    for (const categoryId of tournamentCategoryIds) {
      const category = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) continue;
      for (const child of guild.channels.cache.filter((channel) => channel.parentId === category.id).values()) {
        await child.delete('Tournament permanent deletion: category child').catch(() => {});
      }
      try {
        await category.delete('Tournament permanent deletion: category');
        summary.categoryDeleted = true;
      } catch (err) {
        if (err.code !== 10003) summary.failures.push(`Failed to delete category ${category.name}: ${err.message}`);
      }
    }

    // 6. Delete main tournament role
    if (saved.roleId && guild.roles) {
      try {
        const role = guild.roles.cache?.get(saved.roleId) ||
          await guild.roles.fetch?.(saved.roleId).catch(() => null);
        if (role && typeof role.delete === 'function') {
          try {
            await queueRoleDelete(role, `Tournament ${saved.tournamentTitle || tournamentId} permanent deletion`);
            summary.rolesDeletedCount++;
          } catch (err) {
            if (err.code !== 10011 && err.code !== 10003) {
              summary.failures.push(`Failed to delete tournament role ${saved.roleId}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        summary.failures.push(`Failed to delete role: ${err.message}`);
      }
    }

    // 7. Purge all records from MongoDB
    await purgeAllTournamentDataFromDb(guild.id, tournamentId);

    // 8. Log audit trail
    try {
      const adminTag = adminMember?.user?.tag || adminMember?.tag || 'System / Auto-Recovery';
      console.log(`[Audit] 🗑️ Permanent tournament deletion executed for ${tournamentId} by ${adminTag}.`);
    } catch {}

    // 9. Remove from guildSettingsCache and save
    if (guildSettingsCache[guild.id]?.tournaments) {
      delete guildSettingsCache[guild.id].tournaments[tournamentId];
      saveGuildSettings(guildSettingsCache);
    }

    return summary;
  }

  /**
   * Resumes and finalizes any tournament deletions that were interrupted by a bot restart.
   *
   * @param {import('discord.js').Client} client
   * @param {string} guildId
   */
  export async function resumePendingTournamentDeletions(client, guildId) {
    if (!client) return;
    try {
      const guild = guildId ? client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null)) : null;
      if (!guild) return;

      const pendingDeletions = await getPendingTournamentDeletions(guild.id);
      const pendingIds = new Set(pendingDeletions.map((p) => p.tournamentId));

      const cachedTournaments = guildSettingsCache[guild.id]?.tournaments || {};
      for (const [tId, tData] of Object.entries(cachedTournaments)) {
        if (tData?.deletionStatus === 'deletion_pending' || tData?.deletionStatus === 'deleting') {
          pendingIds.add(tId);
        }
      }

      if (pendingIds.size === 0) return;

      console.log(`[Startup Recovery] 🧹 Resuming permanent deletion for ${pendingIds.size} tournament(s)...`);
      for (const tId of pendingIds) {
        try {
          console.log(`[Startup Recovery] 🗑️ Completing pending deletion for tournament ${tId}...`);
          await executeTournamentPermanentDeletion(guild, tId, null);
        } catch (err) {
          console.warn(`[Startup Recovery] ⚠️ Error completing deletion for tournament ${tId}:`, err.message);
        }
      }
      console.log(`[Startup Recovery] ✅ Completed all pending tournament deletions.`);
    } catch (err) {
      console.warn('[Startup Recovery] ⚠️ Error in resumePendingTournamentDeletions:', err.message);
    }
  }

  /**
   * Handles the `.dash` command to restore or update the tournament control panel in `#bot-commands`.
   * Works only inside the designated #bot-commands channel registered in MongoDB.
   *
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').GuildMember} member
   * @param {import('discord.js').TextChannel} channel
   * @param {Function} replyFn
   * @param {import('discord.js').Message} [originalMessage]
   */
  export async function handleDashCommand(guild, member, channel, replyFn, originalMessage) {
    const access = checkTournamentAccess(guild, member);
    if (!access.allowed) {
      await replyFn(access.reason);
      return;
    }

    if (!channel || !channel.id) {
      await replyFn('⚠️ **Error:** Unable to determine channel context.');
      return;
    }

    // Resolve tournament strictly by channel.id === channels.botCommandsId
    let resolvedTournamentId = null;
    let tournamentData = null;

    // Check local memory cache
    const cachedTournaments = guildSettingsCache[guild.id]?.tournaments || {};
    for (const [tId, tData] of Object.entries(cachedTournaments)) {
      if (tData?.channels?.botCommandsId === channel.id) {
        resolvedTournamentId = tId;
        tournamentData = tData;
        break;
      }
    }

    // Fallback to MongoDB lookup
    if (!resolvedTournamentId && isMongoConnected()) {
      const dbTour = await findTournamentByBotCommandsChannel(guild.id, channel.id);
      if (dbTour) {
        resolvedTournamentId = dbTour.tournamentId;
        tournamentData = dbTour;
        guildSettingsCache[guild.id] ||= {};
        guildSettingsCache[guild.id].tournaments ||= {};
        guildSettingsCache[guild.id].tournaments[resolvedTournamentId] = dbTour;
        saveGuildSettings(guildSettingsCache);
      }
    }

    // Rejection rule: Must only work in designated bot-commands channel
    if (!resolvedTournamentId || !tournamentData) {
      if (!isMongoConnected()) {
        await replyFn('⚠️ **Dashboard Unavailable:** MongoDB is disconnected and this channel is not in the local dashboard cache. Reconnect the database, then run `.dash` again.');
        return;
      }
      await replyFn('⚠️ **Invalid Channel:** The `.dash` command can only be used inside an active tournament\'s designated `#bot-commands` channel.');
      return;
    }

    // Rejection rule: Block if tournament is undergoing deletion
    if (
      tournamentData.deletionStatus === 'deletion_pending' ||
      tournamentData.deletionStatus === 'deleting' ||
      tournamentData.deletionStatus === 'deleted' ||
      tournamentData.setupStatus === 'deleted'
    ) {
      await replyFn('⚠️ **Tournament Unavailable:** This tournament is currently undergoing permanent deletion or has been deleted.');
      return;
    }

    try {
      // Delete command invocation message to keep channel pristine
      if (originalMessage?.deletable) {
        await originalMessage.delete().catch(() => {});
      }

      await withTournamentLock(resolvedTournamentId, async () => {
        let tournament;
        let summary;
        try {
          const backendData = await fetchTournamentRegistrationsFromBackend(resolvedTournamentId);
          ({ tournament, summary } = backendData);
        } catch (backendError) {
          // A network/API outage should not hide the dashboard. Reuse the last
          // persisted snapshot and render a minimal panel if this is the first open.
          console.error(`[Discord Bot] Live data unavailable while restoring dashboard ${resolvedTournamentId}:`, backendError);
          const saved = guildSettingsCache[guild.id]?.tournaments?.[resolvedTournamentId] || tournamentData;
          tournament = saved.dashboardLastTournament || {
            id: resolvedTournamentId,
            title: saved.tournamentTitle || resolvedTournamentId,
            game: 'Esports',
            status: 'PUBLISHED',
            registration_status: 'UNKNOWN',
          };
          summary = saved.dashboardLastSummary || {
            total_registered_teams: 0,
            eligible_teams_count: 0,
            ineligible_teams_count: 0,
            eligible_linked_members_count: 0,
            unlinked_members_count: 0,
            duplicate_discord_ids_count: 0,
          };
        }

        updateDashboardNavigation(guild, resolvedTournamentId, 'home');

        const botMember = guild.members.me;
        await setupTournamentControlPanel(guild, tournament, summary, botMember);

        // The dashboard message is the sole message in this channel; avoid posting a confirmation.
      }, 'dashboard_restore');
    } catch (err) {
      console.error(`[Discord Bot] Error in .dash command for tournament ${resolvedTournamentId}:`, err);
      await replyFn(`❌ **Failed to restore dashboard:** ${err.message}`);
    }
  }

  /**
   * Handles the ".organiser" or ".organizer" prefix command.
   * Guides administrators through connecting their Discord server to a MatchDistrict organiser account.
   */
  /**
   * Executes the complete backend verification and MongoDB persistence pipeline for an organiser linking code.
   */
  export async function executeOrganiserLinkVerification({
    guild,
    user,
    rawCode,
    correlationId = null,
    replyFn = null,
    interaction = null,
    originalMessage = null,
  }) {
    const corrId = correlationId || crypto.randomBytes(4).toString('hex');
    console.log(`[Discord Bot] [corr:${corrId}] 4. Organiser handler invoked: guild=${guild.id}, user=${user.id}, hasCode=${Boolean(rawCode)}`);

    const sendResponse = async (payload) => {
      if (interaction) {
        if (interaction.deferred || interaction.replied) {
          return await interaction.editReply(payload).catch(() => {});
        }
        return await interaction.reply(payload).catch(() => {});
      }
      if (replyFn) {
        return await replyFn(payload);
      }
    };

    const botSecret = getBackendBotSecret();
    if (!botSecret) {
      console.warn(`[Discord Bot] [corr:${corrId}] 7. Linking failed: Missing MATCHDISTRICT_BOT_SECRET`);
      await sendResponse('❌ **Configuration Error:** Missing required environment variable `MATCHDISTRICT_BOT_SECRET`. Please configure it in your bot environment variables.');
      return;
    }

    const code = (rawCode || '').trim();
    if (!code) {
      await sendResponse('❌ **Invalid Code:** Please provide a valid Organiser Linking Code (e.g. `MD-ORG-XXXX-XXXX-XXXX`).');
      return;
    }

    const apiUrl = getBackendApiUrl();
    console.log(`[Discord Bot] [corr:${corrId}] 5. Backend verification request started: url="${apiUrl}/api/bot/organizer/verify-link", guild=${guild.id}`);

    let response = null;
    let data = null;

    try {
      response = await fetch(`${apiUrl}/api/bot/organizer/verify-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'MatchDistrict-Discord-Bot/1.0',
          'x-bot-secret': botSecret,
          'Authorization': `Bearer ${botSecret}`,
        },
        body: JSON.stringify({
          code,
          guild_id: guild.id,
          guild_name: guild.name,
          discord_user_id: user.id,
        }),
      });

      data = await response.json().catch(() => null);
    } catch (netErr) {
      console.warn(`[Discord Bot] [corr:${corrId}] 6. Backend request error:`, netErr.message);
      await sendResponse(`❌ **Service Unavailable:** Could not contact MatchDistrict backend server (${netErr.message}). Please verify the backend API is online.`);
      return;
    }

    console.log(`[Discord Bot] [corr:${corrId}] 6. Backend verification response received: status=${response?.status}, success=${Boolean(data?.success)}`);

    if (!response.ok || !data || !data.success) {
      const errMsg = data?.message || data?.error || `Verification failed with HTTP ${response.status}`;
      console.warn(`[Discord Bot] [corr:${corrId}] 7. Organiser linking failed: reason="${errMsg}"`);
      await sendResponse(`❌ **Linking Failed:** ${errMsg}`);
      return;
    }

    const organiser = data.organizer;
    const tournaments = data.tournaments || [];

    // Save link persistently to MongoDB
    const linkDoc = {
      guildId: guild.id,
      guildName: guild.name,
      organiserId: organiser.id,
      organiserName: organiser.name,
      organiserHandle: organiser.handle,
      status: 'linked',
      linkedBy: user.id,
      linkedAt: new Date().toISOString(),
    };

    try {
      await saveOrganiserLink(guild.id, linkDoc);
      console.log(`[Discord Bot] [corr:${corrId}] 7. MongoDB link saved successfully: organiserId=${organiser.id}, guild=${guild.id}`);
    } catch (dbErr) {
      console.warn(`[Discord Bot] [corr:${corrId}] 7. MongoDB save error:`, dbErr.message);
    }

    // Update in-memory cache
    if (!guildSettingsCache[guild.id]) guildSettingsCache[guild.id] = {};
    guildSettingsCache[guild.id].organiserLink = linkDoc;
    saveGuildSettings(guildSettingsCache);

    // Record audit log
    await recordAuditLog(guild.id, 'LINK_ORGANISER', {
      organiserId: organiser.id,
      organiserName: organiser.name,
      guildId: guild.id,
      guildName: guild.name,
      adminId: user.id,
      tournamentsCount: tournaments.length,
    }).catch(() => {});

    const successEmbed = new EmbedBuilder()
      .setTitle('🎉 Server Successfully Linked!')
      .setColor(0x10b981)
      .setDescription(
        `**${guild.name}** is now connected to your MatchDistrict organiser account.\n\n` +
        `• **Organiser:** **${organiser.name}** (\`${organiser.handle || organiser.id}\`)\n` +
        `• **Discord Server:** **${guild.name}** (\`${guild.id}\`)\n` +
        `• **Active Tournaments Available:** **${tournaments.length}**\n\n` +
        `🚀 **What to do next:**\n` +
        `1️⃣ Run \`.list tournament\` in any channel to view and select your tournaments.\n` +
        `2️⃣ Select your tournament to provision the management dashboard in \`#bot-commands\`.\n` +
        `3️⃣ Manage rounds, 25-slot group allocations, and match credentials directly from Discord!`
      )
      .setFooter({ text: 'MatchDistrict Multi-Organiser System' })
      .setTimestamp();

    await sendResponse({ embeds: [successEmbed] });

    // If command was sent via chat message, delete it to protect code from chat history
    if (originalMessage && typeof originalMessage.delete === 'function') {
      originalMessage.delete().catch(() => {});
    }
  }

  /**
   * Handles the .organiser command across subcommands, code arguments, and status checks.
   */
  export async function handleOrganiserCommand(guild, member, channel, args = [], replyFn, message = null) {
    const corrId = crypto.randomBytes(4).toString('hex');

    if (!guild) {
      await replyFn('❌ **Error:** The `.organiser` command can only be used within a Discord server, not in Direct Messages.');
      return;
    }

    // Safely resolve member if uncached
    let resolvedMember = member;
    if (!resolvedMember && guild && message?.author?.id && typeof guild.members?.fetch === 'function') {
      resolvedMember = await guild.members.fetch(message.author.id).catch(() => null);
    }
    const user = resolvedMember?.user || message?.author || { id: 'unknown' };

    // Check user permissions: Administrator, ManageGuild, or Server Owner
    const isOwner = guild.ownerId === (resolvedMember?.id || user.id);
    const isAdminUser = Boolean(resolvedMember?.permissions?.has?.(PermissionFlagsBits.Administrator));
    const isManageGuild = Boolean(resolvedMember?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
    const hasServerAuthority = isOwner || isAdminUser || isManageGuild;

    if (!hasServerAuthority) {
      await replyFn('🚫 **Permission Denied:** You must be a server Administrator or have `Manage Server` permissions to link this server to an organiser account.');
      return;
    }

    // Safely resolve botMember
    let botMember = guild.members.me;
    if (!botMember && typeof guild.members?.fetchMe === 'function') {
      botMember = await guild.members.fetchMe().catch(() => null);
    }

    // Check basic bot permissions
    if (botMember && typeof botMember.permissions?.has === 'function') {
      const missingBasic = [];
      if (!botMember.permissions.has(PermissionFlagsBits.SendMessages)) missingBasic.push('Send Messages');
      if (!botMember.permissions.has(PermissionFlagsBits.EmbedLinks)) missingBasic.push('Embed Links');
      if (missingBasic.length > 0) {
        await replyFn(`⚠️ **Missing Bot Permissions:** MatchDistrict bot requires **${missingBasic.join(', ')}** in this server.`);
        return;
      }
    }

    const firstArg = (args[0] || '').trim();
    const sub = firstArg.toLowerCase();
    const argStr = args.join(' ').trim();

    // Subcommand: unlink
    if (sub === 'unlink') {
      const currentLink = guildSettingsCache[guild.id]?.organiserLink || (isMongoConnected() ? await getOrganiserLinkForGuild(guild.id) : null);
      if (!currentLink || currentLink.status !== 'linked') {
        await replyFn('ℹ️ **Notice:** This Discord server is not currently linked to any MatchDistrict organiser account.');
        return;
      }

      const unlinkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`md_btn_confirm_unlink_org:${guild.id}`)
          .setLabel('Yes, Unlink Server')
          .setEmoji('⚠️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('md_btn_cancel_unlink_org')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      await replyFn({
        content: `⚠️ **Confirm Server Unlinking**\n` +
          `Are you sure you want to unlink this Discord server from organiser **${currentLink.organiserName || currentLink.organiserId}**?\n\n` +
          `• Existing Discord channels and website tournaments will **not** be deleted.\n` +
          `• Tournament management operations in this server will be stopped until relinked.`,
        components: [unlinkRow],
      });
      return;
    }

    // Subcommand: status
    if (sub === 'status') {
      let currentLink = guildSettingsCache[guild.id]?.organiserLink || (isMongoConnected() ? await getOrganiserLinkForGuild(guild.id) : null);
      if (!currentLink || currentLink.status !== 'linked') {
        await replyFn('ℹ️ **Status:** This Discord server is not linked to any MatchDistrict organiser account. Run `.organiser <CODE>` or `.organiser` to connect.');
        return;
      }

      const statusEmbed = new EmbedBuilder()
        .setTitle('🔗 MatchDistrict Organiser Link Status')
        .setColor(0x10b981)
        .setDescription(
          `• **Status:** ✅ **Active Link**\n` +
          `• **Organiser:** **${currentLink.organiserName}** (\`${currentLink.organiserHandle || currentLink.organiserId}\`)\n` +
          `• **Discord Server:** **${guild.name}** (\`${guild.id}\`)\n` +
          `• **Linked By:** <@${currentLink.linkedBy}>\n` +
          `• **Linked At:** <t:${Math.floor(new Date(currentLink.linkedAt || Date.now()).getTime() / 1000)}:R>`
        )
        .setFooter({ text: 'MatchDistrict Organiser System' })
        .setTimestamp();

      await replyFn({ embeds: [statusEmbed] });
      return;
    }

    // Check if an organiser linking code was provided in the arguments
    let codeCandidate = null;
    if (sub === 'link' && args[1]) {
      codeCandidate = args.slice(1).join(' ').trim();
    } else if (firstArg && (firstArg.toUpperCase().startsWith('MD-ORG-') || /^MD-ORG/i.test(firstArg))) {
      codeCandidate = firstArg;
    } else if (argStr && /^MD-ORG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(argStr)) {
      codeCandidate = argStr;
    } else if (firstArg && firstArg.length >= 10 && firstArg.includes('-') && !['unlink', 'status', 'help'].includes(sub)) {
      codeCandidate = firstArg;
    }

    if (codeCandidate) {
      await executeOrganiserLinkVerification({
        guild,
        user,
        rawCode: codeCandidate,
        correlationId: corrId,
        replyFn,
        originalMessage: message,
      });
      return;
    }

    // No code provided: Check current link status
    let link = guildSettingsCache[guild.id]?.organiserLink;
    if (!link && isMongoConnected()) {
      link = await getOrganiserLinkForGuild(guild.id);
      if (link) {
        if (!guildSettingsCache[guild.id]) guildSettingsCache[guild.id] = {};
        guildSettingsCache[guild.id].organiserLink = link;
      }
    }

    if (link && link.status === 'linked') {
      // Already linked
      const linkedEmbed = new EmbedBuilder()
        .setTitle('🔗 MatchDistrict Organiser Link Active')
        .setColor(0x10b981)
        .setDescription(
          `This Discord server is connected to a verified MatchDistrict organiser.\n\n` +
          `• **Organiser:** **${link.organiserName}** (\`${link.organiserHandle || link.organiserId}\`)\n` +
          `• **Discord Server:** **${guild.name}** (\`${guild.id}\`)\n` +
          `• **Linked At:** <t:${Math.floor(new Date(link.linkedAt || Date.now()).getTime() / 1000)}:R>\n\n` +
          `**Next Steps:**\n` +
          `• Run \`.list tournament\` to view and manage your tournaments.\n` +
          `• Run \`.organiser unlink\` to disconnect this server from the organiser.`
        )
        .setFooter({ text: 'MatchDistrict Organiser System' })
        .setTimestamp();

      const unlinkBtnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`md_btn_unlink_org:${guild.id}`)
          .setLabel('Unlink Server')
          .setEmoji('🔗')
          .setStyle(ButtonStyle.Secondary)
      );

      await replyFn({ embeds: [linkedEmbed], components: [unlinkBtnRow] });
      return;
    }

    // Not linked: Provide explanation and instructions
    const linkEmbed = new EmbedBuilder()
      .setTitle('🔗 Connect Server to MatchDistrict Organiser')
      .setColor(0x3b82f6)
      .setDescription(
        `Connect **${guild.name}** to your MatchDistrict organiser account to host and manage esports tournaments, allocate groups, and run private ID/password channels.\n\n` +
        `**How to link your server:**\n` +
        `1️⃣ Sign in to your organiser account on the **[MatchDistrict Website](https://matchdistrict.in)**.\n` +
        `2️⃣ Go to your **Profile / Organizer Dashboard**.\n` +
        `3️⃣ Find your unique **Organiser Linking Code** and click **Copy**.\n\n` +
        `**Choose how to link:**\n` +
        `• **Option A:** Click **Enter Organiser Code** below to submit via modal.\n` +
        `• **Option B:** Run \`.organiser <CODE>\` directly in this channel.\n` +
        `  *(Example: \`.organiser MD-ORG-XXXX-XXXX-XXXX\`)*`
      )
      .setFooter({ text: 'Never share your linking code with unauthorized parties' })
      .setTimestamp();

    const enterCodeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('md_btn_enter_org_code')
        .setLabel('Enter Organiser Code')
        .setEmoji('🔑')
        .setStyle(ButtonStyle.Primary)
    );

    await replyFn({ embeds: [linkEmbed], components: [enterCodeRow] });
  }

  /**
   * Handles modal submission for organiser code linking.
   */
  export async function handleOrganiserModalSubmit(interaction) {
    if (interaction.customId !== 'md_modal_organiser_link') return;

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '❌ This action can only be performed in a server.', ephemeral: true }).catch(() => {});
      return;
    }

    const member = interaction.member;
    const isOwner = guild.ownerId === (member?.id || interaction.user?.id);
    const hasServerAuthority = isOwner ||
      Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator)) ||
      Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));

    if (!hasServerAuthority) {
      await interaction.reply({ content: '🚫 You must be a server Administrator or have `Manage Server` permissions to link this server.', ephemeral: true }).catch(() => {});
      return;
    }

    // Acknowledge immediately within Discord <3s deadline
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const rawCode = (interaction.fields.getTextInputValue('org_code') || '').trim();
    const corrId = crypto.randomBytes(4).toString('hex');

    await executeOrganiserLinkVerification({
      guild,
      user: interaction.user,
      rawCode,
      correlationId: corrId,
      interaction,
    });
  }

  /**
   * Handles button interactions for organiser linking and unlinking.
   */
  export async function handleOrganiserButtonInteraction(interaction) {
    const customId = interaction.customId || '';

    if (customId === 'md_btn_enter_org_code') {
      const member = interaction.member;
      const hasServerAuthority = member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild);

      if (!hasServerAuthority) {
        await interaction.reply({
          content: '🚫 You must be a server Administrator or have `Manage Server` permissions to link this server.',
          ephemeral: true,
        }).catch(() => {});
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('md_modal_organiser_link')
        .setTitle('Enter Organiser Linking Code');

      const codeInput = new TextInputBuilder()
        .setCustomId('org_code')
        .setLabel('MatchDistrict Organiser Linking Code')
        .setPlaceholder('MD-ORG-XXXX-XXXX-XXXX')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(64);

      modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    if (customId.startsWith('md_btn_unlink_org:')) {
      const member = interaction.member;
      const hasServerAuthority = member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild);

      if (!hasServerAuthority) {
        await interaction.reply({
          content: '🚫 You must be a server Administrator to unlink this server.',
          ephemeral: true,
        }).catch(() => {});
        return;
      }

      const guildId = customId.split(':')[1];
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`md_btn_confirm_unlink_org:${guildId}`)
          .setLabel('Confirm Unlink')
          .setEmoji('⚠️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('md_btn_cancel_unlink_org')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: '⚠️ **Are you sure you want to unlink this Discord server?**\n' +
          '• Tournament management features in this server will be paused.\n' +
          '• Website tournaments, registrations, and Discord channels will **not** be deleted.',
        components: [confirmRow],
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    if (customId === 'md_btn_cancel_unlink_org') {
      await interaction.update({
        content: 'ℹ️ **Unlink Cancelled:** Server remains linked to your organiser account.',
        components: [],
      }).catch(() => {});
      return;
    }

    if (customId.startsWith('md_btn_confirm_unlink_org:')) {
      const member = interaction.member;
      const hasServerAuthority = member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild);

      if (!hasServerAuthority) {
        await interaction.reply({
          content: '🚫 You must be a server Administrator to unlink this server.',
          ephemeral: true,
        }).catch(() => {});
        return;
      }

      const guild = interaction.guild;
      const guildId = customId.split(':')[1] || guild.id;

      await interaction.deferUpdate().catch(() => {});

      try {
        const apiUrl = getBackendApiUrl();
        const botSecret = getBackendBotSecret();

        await fetch(`${apiUrl}/api/bot/organizer/unlink`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bot-secret': botSecret,
            'Authorization': `Bearer ${botSecret}`,
          },
          body: JSON.stringify({
            guild_id: guildId,
            discord_user_id: interaction.user.id,
          }),
        }).catch(() => {});

        await unlinkOrganiserGuild(guildId, interaction.user.id);

        if (guildSettingsCache[guildId]) {
          delete guildSettingsCache[guildId].organiserLink;
          saveGuildSettings(guildSettingsCache);
        }

        await recordAuditLog(guildId, 'UNLINK_ORGANISER', {
          guildId,
          adminId: interaction.user.id,
        }).catch(() => {});

        await interaction.editReply({
          content: '✅ **Server Unlinked:** This Discord server has been disconnected from the MatchDistrict organiser account.\n' +
            'Run `.organiser` whenever you wish to connect a server again.',
          components: [],
        }).catch(() => {});
      } catch (err) {
        await interaction.editReply({
          content: `❌ **Failed to unlink:** ${err.message}`,
          components: [],
        }).catch(() => {});
      }
    }
  }

  /**
   * Initializes the in-memory cache of all active organiser links from MongoDB.
   */
  export async function initOrganiserLinksCache() {
    if (!isMongoConnected()) return;
    try {
      const allLinks = await loadAllOrganiserLinksFromDb();
      let count = 0;
      for (const [guildId, linkDoc] of Object.entries(allLinks)) {
        if (!guildSettingsCache[guildId]) {
          guildSettingsCache[guildId] = {};
        }
        guildSettingsCache[guildId].organiserLink = linkDoc;
        count++;
      }
      console.log(`[MongoDB] 🔗 Loaded ${count} active organiser link(s) into memory cache.`);
    } catch (err) {
      console.warn('[MongoDB] ⚠️ Failed to load organiser links cache:', err.message);
    }
  }
