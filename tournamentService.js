import process from 'node:process';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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
  isMongoConnected,
  ensurePersistenceAvailable,
  upsertManagedMessage,
  upsertManagedMessageBatch,
  deleteManagedMessages,
  saveTournamentToDb,
  deleteTournamentFromDb,
  enforceSingleActiveRoundInDb,
} from './mongoService.js';

/**
 * Required 4 shared tournament channels structure
 */
export const REQUIRED_TOURNAMENT_CHANNELS = [
  {
    key: 'botCommandsId',
    name: 'bot-commands',
    topic: 'Tournament Management & Control Panel (Admin Only)',
    participantAccess: 'none', // Strictly admins only
  },
  {
    key: 'tournamentUpdateId',
    name: 'tournament-update',
    topic: 'Official Announcements & Tournament Updates',
    participantAccess: 'read_only', // Participants view-only
  },
  {
    key: 'tournamentTeamsId',
    name: 'tournament-teams',
    topic: 'Registered Teams & Tournament Roster (Admin Only)',
    participantAccess: 'none', // Strictly admins only! Ordinary participants must not be granted access
  },
  {
    key: 'tournamentHelpdeskId',
    name: 'tournament-helpdesk',
    topic: 'Participant Questions & Tournament Support Desk',
    participantAccess: 'read_write', // Participants can send messages
  },
  {
    key: 'tournamentRegisterId',
    name: 'tournament-register',
    topic: 'Tournament Registration & Official Details Link',
    participantAccess: 'read_only', // Participants view-only
  },
];

/**
 * Concurrency locks for ongoing tournament refreshes/synchronizations.
 * Prevents race conditions from producing duplicate messages or corrupted states.
 */
const tournamentRefreshLocks = new Set();

export async function withTournamentLock(tournamentId, taskFn) {
  if (!tournamentId) return taskFn();
  if (tournamentRefreshLocks.has(tournamentId)) {
    throw new Error(`A synchronization or refresh task is already running for tournament "${tournamentId}".`);
  }
  tournamentRefreshLocks.add(tournamentId);
  try {
    return await taskFn();
  } finally {
    tournamentRefreshLocks.delete(tournamentId);
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
 * Sanitize category name: 1-100 characters.
 */
export function sanitizeCategoryName(name) {
  if (!name || typeof name !== 'string') return 'Tournament';
  const clean = name.trim().slice(0, 95);
  return `🏆 | ${clean}`;
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
 * Official Server & Administrator Access Guard.
 * Enforces:
 * 1. Must be in a Discord guild (not DM).
 * 2. Official server ID must be configured in environment.
 * 3. Guild ID must strictly match MATCHDISTRICT_GUILD_ID.
 * 4. Member must be an Administrator or have Manage Server permission.
 */
export function checkTournamentAccess(guild, member) {
  if (!guild) {
    return {
      allowed: false,
      reason: '❌ **Error:** Tournament management commands can only be executed within the official MatchDistrict Discord server, not in Direct Messages.',
    };
  }

  const officialId = getOfficialGuildId();
  if (!officialId) {
    return {
      allowed: false,
      reason: '⚠️ **Configuration Error:** The official server ID (`MATCHDISTRICT_GUILD_ID`) is not configured in the bot environment. Tournament commands are restricted until configured.',
    };
  }

  if (guild.id !== officialId) {
    return {
      allowed: false,
      reason: '🚫 **Access Denied:** Tournament commands are restricted exclusively to the official MatchDistrict Discord server.',
    };
  }

  if (!isAdmin(member)) {
    return {
      allowed: false,
      reason: '🚫 **Permission Denied:** You must be a server Administrator or have Manage Server permissions to use tournament management commands.',
    };
  }

  return { allowed: true };
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
  const { status = 'published', apiUrl = getBackendApiUrl(), secret = getBackendBotSecret() } = options;
  const url = `${apiUrl}/api/bot/tournaments?status=${encodeURIComponent(status)}`;

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
    `• Select a tournament from the menu below to open its **Control Panel** in \`#bot-commands\`\n` +
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
 * Button Row 1: Create Channels, Refresh Tournament Data, View Rounds, Delete All Channels
 * Button Row 2: Sync Tournament Roles
 */
export function buildTournamentControlPanelButtons(tournamentId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_tour_create_channels:${tournamentId}`)
      .setLabel('Create Channels')
      .setEmoji('📁')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_tour_refresh:${tournamentId}`)
      .setLabel('Refresh Tournament Data')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_tour_view_rounds:${tournamentId}`)
      .setLabel('View Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_tour_delete_channels:${tournamentId}`)
      .setLabel('Delete All Channels')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_tour_sync_roles:${tournamentId}`)
      .setLabel('Sync Tournament Roles')
      .setEmoji('👥')
      .setStyle(ButtonStyle.Primary)
  );

  return [row1, row2];
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

    if (currentChunk.length + teamText.length > 1850) {
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
    role = await guild.roles.create({
      name: expectedRoleName,
      permissions: [],
      mentionable: true,
      reason: `Tournament role for ${tournament.title} (ID: ${tournamentId})`,
    });
  }

  if (role) {
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
  if (!guild || !isOfficialGuild(guild)) {
    throw new Error('Tournament roles can only be synchronized in the official MatchDistrict Discord server.');
  }

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

  const role = await getOrCreateTournamentRole(guild, tournament);
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
  };

  // Check bot permissions and hierarchy
  const botMember = guild.members?.me || (guild.members?.cache ? guild.members.cache.get(guild.client?.user?.id) : null);
  const botHasManageRoles = !botMember?.permissions || (typeof botMember.permissions.has === 'function' ? botMember.permissions.has(PermissionFlagsBits.ManageRoles) : true);

  // Assign role to eligible members in guild
  for (const discordId of currentEligibleDiscordIds) {
    let member = null;
    try {
      member = guild.members?.cache?.get(discordId) ||
        await guild.members?.fetch?.(discordId).catch(() => null);
    } catch {
      member = null;
    }

    if (!member) {
      stats.skipped++;
      continue;
    }

    if (member.roles?.cache?.has(role.id)) {
      stats.alreadyAssigned++;
    } else if (typeof member.roles?.add === 'function') {
      if (!botHasManageRoles) {
        stats.failed++;
        console.warn(`[Discord Bot] ⚠️ Cannot assign role @${role.name} to member ${discordId}: Bot lacks 'Manage Roles' permission.`);
        continue;
      }
      if (botMember?.roles?.highest && typeof botMember.roles.highest.comparePositionTo === 'function') {
        if (botMember.roles.highest.comparePositionTo(role) <= 0) {
          stats.failed++;
          console.warn(`[Discord Bot] ⚠️ Cannot assign role @${role.name} to member ${discordId}: Bot's highest role is not positioned higher than @${role.name} in role hierarchy.`);
          continue;
        }
      }
      try {
        await member.roles.add(role.id, `Eligible tournament registration for ${tournament.title}`);
        stats.assigned++;
      } catch (err) {
        stats.failed++;
        console.warn(`[Discord Bot] Failed to assign role ${role.name} to member ${discordId}:`, err.message);
      }
    }
  }

  // Revoke role from members no longer eligible/registered for this tournament
  if (guild.members?.cache) {
    for (const member of guild.members.cache.values()) {
      if (member.roles?.cache?.has(role.id) && !currentEligibleDiscordIds.has(member.id)) {
        if (typeof member.roles?.remove === 'function') {
          if (!botHasManageRoles) {
            stats.failed++;
            continue;
          }
          if (botMember?.roles?.highest && typeof botMember.roles.highest.comparePositionTo === 'function') {
            if (botMember.roles.highest.comparePositionTo(role) <= 0) {
              stats.failed++;
              continue;
            }
          }
          try {
            await member.roles.remove(role.id, `Registration cancelled or ineligible for ${tournament.title}`);
            stats.removed++;
          } catch (err) {
            stats.failed++;
            console.warn(`[Discord Bot] Failed to remove role ${role.name} from member ${member.id}:`, err.message);
          }
        }
      }
    }
  }

  // Count members holding role
  let membersWithRoleCount = 0;
  if (role.members?.size !== undefined) {
    membersWithRoleCount = role.members.size;
  } else if (guild.members?.cache) {
    membersWithRoleCount = Array.from(guild.members.cache.values()).filter((m) => m.roles?.cache?.has(role.id)).length;
  }
  stats.membersWithRole = membersWithRoleCount;

  // Persist role sync state
  savedTournament.roleId = role.id;
  savedTournament.roleName = role.name;
  savedTournament.roleSyncStats = stats;
  savedTournament.roleLastSyncedAt = new Date().toISOString();
  savedTournament.allEligibleMemberIds = Array.from(currentEligibleDiscordIds);

  currentSettings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);

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
 * Sets up or refreshes the Tournament Control Panel inside #bot-commands.
 */
export async function setupTournamentControlPanel(guild, tournament, summary, botMember) {
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
    controlPanelMessageId: null,
  };

  if (!savedTournament.channels) {
    savedTournament.channels = {};
  }

  // Ensure tournament role exists or is fetched
  let role = null;
  try {
    role = await getOrCreateTournamentRole(guild, tournament);
  } catch (err) {
    console.warn('[Discord Bot] Role creation error in control panel setup:', err.message);
  }

  let membersWithRoleCount = 0;
  if (role) {
    if (role.members?.size !== undefined) {
      membersWithRoleCount = role.members.size;
    } else if (guild.members?.cache) {
      membersWithRoleCount = Array.from(guild.members.cache.values()).filter((m) => m.roles?.cache?.has(role.id)).length;
    }
  }

  const roleStats = savedTournament.roleSyncStats || {};
  const roleInfo = role ? {
    roleId: role.id,
    roleName: role.name,
    membersWithRole: membersWithRoleCount,
    statusText: savedTournament.roleLastSyncedAt
      ? `🟢 Synchronized (${roleStats.assigned ?? 0} assigned, ${roleStats.removed ?? 0} removed, ${roleStats.skipped ?? 0} skipped)`
      : '🟡 Pending Sync',
    lastSyncedAt: savedTournament.roleLastSyncedAt || null,
  } : null;

  // Pre-fetch all channels to ensure full API cache across bot restarts
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }

  // 1. Locate or create Category
  let category = null;
  if (savedTournament.categoryId) {
    category = guild.channels.cache.get(savedTournament.categoryId) ||
      await guild.channels.fetch(savedTournament.categoryId).catch(() => null);
    if (category && (category.type !== ChannelType.GuildCategory || (category.guildId || category.guild?.id) !== guild.id)) {
      category = null;
    }
  }

  const categoryName = sanitizeCategoryName(tournament.title);
  if (!category) {
    const matchingCategories = Array.from(guild.channels.cache.values()).filter(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (matchingCategories.length > 0) {
      category = matchingCategories.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))[0];
      savedTournament.categoryId = category.id;
    }
  }

  if (!category || category.type !== ChannelType.GuildCategory) {
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];

    category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
    });
    savedTournament.categoryId = category.id;
  }

  // 2. Locate or create #bot-commands channel inside category
  let botCommandsChannel = null;
  if (savedTournament.channels.botCommandsId) {
    botCommandsChannel = guild.channels.cache.get(savedTournament.channels.botCommandsId) ||
      await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null);
    if (botCommandsChannel && (botCommandsChannel.parentId !== category.id || botCommandsChannel.type !== ChannelType.GuildText || (botCommandsChannel.guildId || botCommandsChannel.guild?.id) !== guild.id)) {
      botCommandsChannel = null;
    }
  }

  if (!botCommandsChannel) {
    const matching = Array.from(guild.channels.cache.values()).filter(
      (c) => c.parentId === category.id && c.type === ChannelType.GuildText && c.name === 'bot-commands'
    );
    if (matching.length > 0) {
      botCommandsChannel = matching.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))[0];
      savedTournament.channels.botCommandsId = botCommandsChannel.id;
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
  ];

  if (botCommandsChannel) {
    if (typeof botCommandsChannel.permissionOverwrites?.set === 'function') {
      await botCommandsChannel.permissionOverwrites.set(botCommandsOverwrites).catch(() => {});
    }
  } else {
    botCommandsChannel = await guild.channels.create({
      name: 'bot-commands',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Tournament Management & Control Panel (Admin Only) — ${tournament.title} (ID: ${tournamentId})`,
      permissionOverwrites: botCommandsOverwrites,
    });
    savedTournament.channels.botCommandsId = botCommandsChannel.id;
  }

  // 3. Compute Channel Setup Status
  const updateId = savedTournament.channels.tournamentUpdateId;
  const teamsId = savedTournament.channels.tournamentTeamsId;
  const helpdeskId = savedTournament.channels.tournamentHelpdeskId;
  const registerId = savedTournament.channels.tournamentRegisterId;
  const voiceId = savedTournament.channels.roomMakerVcId;

  const updateCh = updateId ? (guild.channels.cache.get(updateId) || await guild.channels.fetch(updateId).catch(() => null)) : null;
  const teamsCh = teamsId ? (guild.channels.cache.get(teamsId) || await guild.channels.fetch(teamsId).catch(() => null)) : null;
  const helpdeskCh = helpdeskId ? (guild.channels.cache.get(helpdeskId) || await guild.channels.fetch(helpdeskId).catch(() => null)) : null;
  const registerCh = registerId ? (guild.channels.cache.get(registerId) || await guild.channels.fetch(registerId).catch(() => null)) : null;
  const voiceCh = voiceId ? (guild.channels.cache.get(voiceId) || await guild.channels.fetch(voiceId).catch(() => null)) : null;

  const activeParticipantChannelCount = [updateCh, teamsCh, helpdeskCh, registerCh, voiceCh].filter(Boolean).length;
  const isConfigured = activeParticipantChannelCount === 5;

  let statusText = '';
  if (isConfigured) {
    statusText = `🟢 **Active** — All 6 tournament channels configured:\n` +
      `  • 🤖 <#${botCommandsChannel.id}>\n` +
      `  • 📢 <#${updateCh.id}>\n` +
      `  • 📋 <#${teamsCh.id}>\n` +
      `  • 💬 <#${helpdeskCh.id}>\n` +
      `  • 🔗 <#${registerCh.id}>\n` +
      `  • 🔊 <#${voiceCh.id}> (\`room-maker-vc\` [Limit: ${voiceCh.userLimit || 15}])`;
  } else if (activeParticipantChannelCount === 0) {
    statusText = `🟡 **Pending Creation** — Participant channels not created yet.\n` +
      `*Click **Create Channels** below to provision announcements, registered teams, helpdesk, registration, and room-maker voice channels.*`;
  } else {
    statusText = `⚠️ **Needs Repair** — Only ${activeParticipantChannelCount}/5 channels active.\n` +
      `*Click **Create Channels** below to repair missing channels.*`;
  }

  const channelsStatus = {
    isConfigured,
    activeCount: activeParticipantChannelCount + 1,
    statusText,
  };

  // 4. Construct Embed and Action Buttons
  const embed = buildTournamentControlPanelEmbed(tournament, summary, channelsStatus, roleInfo, savedTournament.rounds || {});
  const buttons = buildTournamentControlPanelButtons(tournamentId);

  // 5. Update or Send Control Panel Message in #bot-commands idempotently
  let panelMessage = null;
  const logicalKey = `guild:${guild.id}:tournament:${tournamentId}:control_panel`;

  try {
    const upsertRes = await upsertManagedMessage(guild.client, {
      guildId: guild.id,
      channelId: botCommandsChannel.id,
      logicalKey,
      messageType: 'tournament_control_panel',
      tournamentId,
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

    if (!panelMessage && typeof botCommandsChannel.send === 'function') {
      panelMessage = await botCommandsChannel.send({ embeds: [embed], components: buttons });
    }
  }

  // 6. Persist mapping
  savedTournament.tournamentId = tournamentId;
  savedTournament.tournamentTitle = tournament.title;
  savedTournament.guildId = guild.id;
  savedTournament.categoryId = category.id;
  savedTournament.channels.botCommandsId = botCommandsChannel.id;
  savedTournament.setupStatus = isConfigured ? 'active' : 'pending_channels';
  savedTournament.controlPanelMessageId = panelMessage ? panelMessage.id : null;
  savedTournament.lastSyncedAt = new Date().toISOString();

  currentSettings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);
  saveTournamentToDb(guild.id, tournamentId, savedTournament);

  // If an active round exists, ensure global submission control panel is kept updated in #bot-commands
  const activeRound = Object.values(savedTournament.rounds || {}).find((r) => r.status === 'Active' || r.status === 'Started');
  if (activeRound) {
    await updateGlobalSubmissionControlPanel(guild, tournament, activeRound, botCommandsChannel);
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

  const panelResult = await setupTournamentControlPanel(guild, tournament, summary, botMember);

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
    const tournaments = await fetchTournamentsFromBackend({
      status: showAll ? 'all' : 'published',
    });

    // Store in guild session
    guildTournamentSessions.set(guild.id, {
      lastTournaments: tournaments.map((t) => ({ id: t.id, title: t.title })),
      lastListedTournamentId: tournaments.length === 1 ? tournaments[0].id : null,
      timestamp: Date.now(),
    });

    const pages = formatTournamentListPages(tournaments, {
      page: requestedPage,
      pageSize: 5,
      showAll,
    });

    const selectRow = tournaments.length > 0 && tournaments.length <= 25
      ? buildTournamentSelectMenu(tournaments)
      : null;

    for (let i = 0; i < pages.length; i++) {
      const isLast = i === pages.length - 1;
      const opts = isLast && selectRow ? { components: [selectRow] } : {};
      const sent = await replyFn(typeof opts.components !== 'undefined' ? { content: pages[i], ...opts } : pages[i]);

      // If interactive collector is supported, handle select menu clicks
      if (isLast && selectRow && sent?.createMessageComponentCollector) {
        const collector = sent.createMessageComponentCollector({
          time: 60000,
        });

        collector.on('collect', async (interaction) => {
          if (!interaction.isStringSelectMenu() || interaction.customId !== 'md_select_tournament') return;

          if (interaction.user.id !== member.id) {
            await interaction.reply({
              content: '❌ **Unauthorized:** Only the administrator who requested the tournament list can make a selection.',
              ephemeral: true,
            });
            return;
          }

          if (!isAdmin(interaction.member)) {
            await interaction.reply({
              content: '❌ **Permission Denied:** You must be an administrator to manage tournaments.',
              ephemeral: true,
            });
            return;
          }

          const selectedTournamentId = interaction.values[0];
          collector.stop('selected');
          await interaction.deferUpdate().catch(() => { });
          await handleSelectTournamentCommand(guild, interaction.member, selectedTournamentId, (text) => interaction.followUp(text));
        });
      }
    }
  } catch (err) {
    await replyFn(`❌ **Error retrieving tournaments from MatchDistrict:**\n> ${err.message}`);
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

  // 1. Locate or create Tournament Category (visible to everyone)
  let category = null;
  if (savedTournament.categoryId) {
    category = guild.channels.cache.get(savedTournament.categoryId) ||
      await guild.channels.fetch(savedTournament.categoryId).catch(() => null);
    if (category && (category.type !== ChannelType.GuildCategory || (category.guildId || category.guild?.id) !== guild.id)) {
      category = null;
    }
  }

  const categoryName = sanitizeCategoryName(tournament.title);
  if (!category) {
    const matchingCategories = Array.from(guild.channels.cache.values()).filter(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (matchingCategories.length > 0) {
      category = matchingCategories.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))[0];
      savedTournament.categoryId = category.id;
      if (matchingCategories.length > 1) {
        console.warn(`[Discord Bot] ⚠️ Multiple categories found for "${categoryName}". Reusing canonical category ${category.id}.`);
        syncResult.failures.push(`Duplicate categories detected for "${categoryName}". Selected <#${category.id}> as canonical.`);
      }
    }
  }

  if (category && category.type === ChannelType.GuildCategory) {
    syncResult.categoryAction = 'reused';
    syncResult.categoryId = category.id;
    savedTournament.categoryId = category.id;
    if (category.permissionOverwrites?.edit) {
      await category.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: true,
      }).catch(() => { });
    }
  } else {
    try {
      const overwrites = [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: botMember.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites,
      });

      syncResult.categoryAction = 'created';
      syncResult.categoryId = category.id;
      savedTournament.categoryId = category.id;
    } catch (err) {
      syncResult.categoryAction = 'failed';
      syncResult.failures.push(`Failed to create category: ${err.message}`);
      return syncResult;
    }
  }

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
    let channelInstance = null;

    if (existingId) {
      channelInstance = guild.channels.cache.get(existingId) ||
        await guild.channels.fetch(existingId).catch(() => null);
      if (channelInstance && (channelInstance.parentId !== category.id || channelInstance.type !== ChannelType.GuildText || (channelInstance.guildId || channelInstance.guild?.id) !== guild.id)) {
        channelInstance = null;
      }
    }

    // Fallback: search by name inside the category if mapping was missing or invalid
    if (!channelInstance) {
      const matching = Array.from(guild.channels.cache.values()).filter(
        (c) => c.parentId === category.id && c.type === ChannelType.GuildText && c.name.toLowerCase() === channelDef.name.toLowerCase()
      );
      if (matching.length > 0) {
        const canonical = matching.find((c) => c.id === existingId) ||
          matching.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))[0];
        channelInstance = canonical;
        if (matching.length > 1) {
          console.warn(`[Discord Bot] ⚠️ Multiple channels found for #${channelDef.name} inside category ${category.name} (${category.id}). Selecting ${canonical.id} as canonical; reporting duplicate for administrator review.`);
          syncResult.failures.push(`Duplicate channels detected for #${channelDef.name}. Selected <#${canonical.id}> as canonical.`);
        }
      }
    }

    // Determine initial permission overwrites based on channel type
    let targetOverwrites = [];

    if (channelDef.key === 'botCommandsId' || channelDef.key === 'tournamentTeamsId') {
      // Restricted admin-only channels: deny @everyone and deny tournament role
      targetOverwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
        ...(tournamentRole ? [{
          id: tournamentRole.id,
          deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        }] : []),
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
      ];
    } else if (channelDef.key === 'tournamentHelpdeskId') {
      // Public channel with chat: all server members can view and send messages
      targetOverwrites = [
        {
          id: guild.roles.everyone.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
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
      ];
    } else {
      // Public view-only channels (tournament-update, tournament-register)
      targetOverwrites = [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.AddReactions,
          ],
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
      ];
    }

    if (channelInstance && channelInstance.parentId === category.id) {
      syncResult.channelsReused.push(channelDef.name);
      savedTournament.channels[channelDef.key] = channelInstance.id;
      activeChannels[channelDef.key] = channelInstance;

      // Apply or repair permission overwrites on existing channel
      if (typeof channelInstance.permissionOverwrites?.set === 'function') {
        try {
          await channelInstance.permissionOverwrites.set(targetOverwrites);
        } catch (owErr) {
          console.warn(`[Discord Bot] ⚠️ Could not repair overwrites on #${channelDef.name}:`, owErr.message);
        }
      }
    } else {
      try {
        channelInstance = await guild.channels.create({
          name: channelDef.name,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `${channelDef.topic} — ${tournament.title}`,
          permissionOverwrites: targetOverwrites,
        });

        syncResult.channelsCreated.push(channelDef.name);
        savedTournament.channels[channelDef.key] = channelInstance.id;
        activeChannels[channelDef.key] = channelInstance;
      } catch (err) {
        syncResult.failures.push(`Failed to create #${channelDef.name}: ${err.message}`);
      }
    }
  }

  // 4b. Ensure room-maker-vc voice channel with a 15-user limit
  let voiceChannelInstance = null;
  const existingVcId = savedTournament.channels.roomMakerVcId;
  if (existingVcId) {
    voiceChannelInstance = guild.channels.cache.get(existingVcId) ||
      await guild.channels.fetch(existingVcId).catch(() => null);
    if (voiceChannelInstance && (voiceChannelInstance.parentId !== category.id || voiceChannelInstance.type !== ChannelType.GuildVoice || (voiceChannelInstance.guildId || voiceChannelInstance.guild?.id) !== guild.id)) {
      voiceChannelInstance = null;
    }
  }

  if (!voiceChannelInstance) {
    const matchingVc = Array.from(guild.channels.cache.values()).find(
      (c) => c.parentId === category.id && c.type === ChannelType.GuildVoice && c.name.toLowerCase() === 'room-maker-vc'
    );
    if (matchingVc) {
      voiceChannelInstance = matchingVc;
    }
  }

  const voiceOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    },
    ...(tournamentRole ? [{
      id: tournamentRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    }] : []),
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.MuteMembers,
        PermissionFlagsBits.DeafenMembers,
        PermissionFlagsBits.MoveMembers,
      ],
    },
  ];

  if (voiceChannelInstance) {
    savedTournament.channels.roomMakerVcId = voiceChannelInstance.id;
    syncResult.channelsReused.push('room-maker-vc');
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
      voiceChannelInstance = await guild.channels.create({
        name: 'room-maker-vc',
        type: ChannelType.GuildVoice,
        parent: category.id,
        userLimit: 15,
        permissionOverwrites: voiceOverwrites,
      });
      savedTournament.channels.roomMakerVcId = voiceChannelInstance.id;
      syncResult.channelsCreated.push('room-maker-vc');
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

  // 8. Reapply strict read-only permissions and update control messages on all existing group channels
  if (savedTournament.rounds && typeof savedTournament.rounds === 'object') {
    for (const round of Object.values(savedTournament.rounds)) {
      if (Array.isArray(round.groups)) {
        for (const group of round.groups) {
          if (group.channelId) {
            const grpChannel = guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null);
            if (grpChannel) {
              const grpRole = group.roleId ? (guild.roles.cache.get(group.roleId) || await guild.roles.fetch(group.roleId).catch(() => null)) : null;
              await applyStrictGroupChannelPermissions(guild, grpChannel, grpRole, tournamentRole, botMember);
              await removeGroupResultControlMessage(guild, group, grpChannel);
              await updateGroupSlotListMessage(guild, tournament, round, group, grpChannel);
            }
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

  return syncResult;
}

  /**
   * Safely deletes all managed Discord channels, voice channel, round channels/roles, and category for a tournament.
   */
  export async function deleteTournamentDiscordChannels(guild, tournamentId) {
    const currentSettings = guildSettingsCache[guild.id] || {};
    const savedTournament = currentSettings.tournaments?.[tournamentId];

    const summary = {
      deletedChannels: [],
      categoryDeleted: false,
      failures: [],
    };

    if (!savedTournament) return summary;

    // 1. Delete all verified channels in savedTournament.channels (including room-maker-vc)
    const channelIds = Object.values(savedTournament.channels || {});
    for (const chId of channelIds) {
      if (!chId) continue;
      try {
        const channel = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
        if (channel) {
          // Verify channel belongs to the tournament's category
          if (!savedTournament.categoryId || channel.parentId === savedTournament.categoryId) {
            const chName = channel.name;
            await channel.delete('Tournament management: deleted all tournament channels').catch(() => { });
            summary.deletedChannels.push(chName);
          }
        }
      } catch (err) {
        summary.failures.push(`Failed to delete channel ${chId}: ${err.message}`);
      }
    }

    // 2. Delete all group channels and group roles for rounds
    if (savedTournament.rounds && typeof savedTournament.rounds === 'object') {
      for (const round of Object.values(savedTournament.rounds)) {
        if (Array.isArray(round.groups)) {
          for (const group of round.groups) {
            if (group.channelId) {
              try {
                const gch = guild.channels.cache.get(group.channelId) ||
                  await guild.channels.fetch(group.channelId).catch(() => null);
                if (gch && (!savedTournament.categoryId || gch.parentId === savedTournament.categoryId)) {
                  const gchName = gch.name;
                  await gch.delete('Tournament management: delete round group channel').catch(() => {});
                  summary.deletedChannels.push(gchName);
                }
              } catch {}
            }
            if (group.roleId && guild.roles) {
              try {
                const gr = guild.roles.cache.get(group.roleId) ||
                  await guild.roles.fetch(group.roleId).catch(() => null);
                if (gr && typeof gr.delete === 'function') {
                  await gr.delete('Tournament management: delete round group role').catch(() => {});
                }
              } catch {}
            }
          }
        }
      }
      savedTournament.rounds = {};
    }

    // 3. Also delete any legacy squad channels if recorded
    if (savedTournament.teamChannels && typeof savedTournament.teamChannels === 'object') {
      for (const chId of Object.values(savedTournament.teamChannels)) {
        if (!chId) continue;
        try {
          const channel = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
          if (channel && (!savedTournament.categoryId || channel.parentId === savedTournament.categoryId)) {
            const chName = channel.name;
            await channel.delete('Tournament management: deleted legacy squad channel').catch(() => { });
            summary.deletedChannels.push(chName);
          }
        } catch { }
      }
    }

    // 4. Delete the category if it exists
    if (savedTournament.categoryId) {
      try {
        const cat = guild.channels.cache.get(savedTournament.categoryId) ||
          await guild.channels.fetch(savedTournament.categoryId).catch(() => null);
        if (cat && cat.type === ChannelType.GuildCategory) {
          await cat.delete('Tournament management: deleted tournament category').catch(() => { });
          summary.categoryDeleted = true;
        }
      } catch (err) {
        summary.failures.push(`Failed to delete category: ${err.message}`);
      }
    }

    // 5. Delete the dedicated tournament role if it exists
    if (savedTournament.roleId && guild.roles) {
      try {
        const role = guild.roles.cache?.get(savedTournament.roleId) ||
          await guild.roles.fetch?.(savedTournament.roleId).catch(() => null);
        if (role && typeof role.delete === 'function') {
          await role.delete(`Tournament ${savedTournament.tournamentTitle || tournamentId} deleted by administrator`).catch(() => { });
          summary.roleDeleted = true;
        }
      } catch (err) {
        summary.failures.push(`Failed to delete tournament role: ${err.message}`);
      }
      savedTournament.roleId = null;
      savedTournament.roleName = null;
      savedTournament.roleSyncStats = null;
    }

    // 6. Delete all persistent managed messages for this tournament using stored message IDs in MongoDB
    try {
      const delMsgResult = await deleteManagedMessages(guild.client, {
        guildId: guild.id,
        tournamentId,
      });
      summary.deletedManagedMessagesCount = delMsgResult.deletedCount;
    } catch (delErr) {
      console.warn(`[MongoDB] Error deleting managed messages for tournament ${tournamentId}:`, delErr.message);
    }

    // 7. Remove tournament from MongoDB collection discord_tournaments
    try {
      await deleteTournamentFromDb(guild.id, tournamentId);
    } catch {}

    return summary;
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
  export async function handleTournamentButtonInteraction(interaction) {
    const customId = interaction.customId || '';
    if (
      !customId.startsWith('md_tour_') &&
      !customId.startsWith('md_round_') &&
      !customId.startsWith('md_group_') &&
      !customId.startsWith('md_result_') &&
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
      await handleQualifyTeamButton(interaction, tourId, rId, gId);
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
      if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => { });
      }
      return;
    }

    // Database persistence check: disable state-changing operations if MongoDB is configured but unavailable
    const stateModifyingActions = [
      'create_channels',
      'delete_channels',
      'confirm_delete',
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
      if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: dbErr, ephemeral: true }).catch(() => {});
      } else if (typeof interaction.followUp === 'function') {
        await interaction.followUp({ content: dbErr, ephemeral: true }).catch(() => {});
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

    // Action: View Rounds (Dedicated Screen)
    if (action === 'view_rounds' || action === 'back_to_rounds') {
      await handleViewRoundsScreen(interaction, tournamentId);
      return;
    }

    // Action: Create Sequential Round
    if (action === 'create_sequential_round') {
      await handleCreateSequentialRound(interaction, tournamentId);
      return;
    }

    // Action: Refresh Rounds List
    if (action === 'refresh_rounds') {
      await handleViewRoundsScreen(interaction, tournamentId);
      return;
    }

    // Action: Back to Tournament Panel
    if (action === 'back_to_panel') {
      await handleBackToTournamentPanel(interaction, tournamentId);
      return;
    }

    // Action: Open / Back to Individual Round Menu
    if (action === 'back_to_menu' || action === 'manage_round') {
      await handleOpenIndividualRoundMenu(interaction, tournamentId, extraParam);
      return;
    }

    // Action: Start Round (from Individual Round Menu or legacy button)
    if (action === 'start_round' || action === 'start') {
      if (extraParam) {
        await handlePromptStartRound(interaction, tournamentId, extraParam);
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

    // Action: Create Round (Modal fallback)
    if (action === 'create_round') {
      const modal = new ModalBuilder()
        .setCustomId(`md_modal_create_round:${tournamentId}`)
        .setTitle('Create Tournament Round');

      const roundNameInput = new TextInputBuilder()
        .setCustomId('round_name')
        .setLabel('Round Name or Number')
        .setPlaceholder('e.g. Round 1, Round 2, Quarter Finals')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

      modal.addComponents(new ActionRowBuilder().addComponents(roundNameInput));
      await interaction.showModal(modal).catch(() => {});
      return;
    }

    // Action: Create Channels
    if (action === 'create_channels') {
      if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
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

    // Action: Refresh Tournament Data
    if (action === 'refresh') {
      if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
      }

      try {
        await withTournamentLock(tournamentId, async () => {
          const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
          const { tournament, teams, summary } = backendData;

          // Perform full channel & participant sync (edits roster in #tournament-teams & registration link in place)
          await syncTournamentDiscordChannels(guild, tournament, teams, botMember);

          // Refresh Control Panel embed
          await setupTournamentControlPanel(guild, tournament, summary, botMember);

          const replyContent = `✅ **Tournament Data Refreshed:** Live registrations, stats, and roster updated.`;
          if (typeof interaction.editReply === 'function') {
            await interaction.editReply({ content: replyContent });
          } else if (typeof interaction.reply === 'function') {
            await interaction.reply({ content: replyContent, ephemeral: true });
          }
        });
      } catch (err) {
        const errorMsg = `❌ **Failed to refresh tournament data:** ${err.message}`;
        if (typeof interaction.editReply === 'function') {
          await interaction.editReply({ content: errorMsg });
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: errorMsg, ephemeral: true });
        }
      }
      return;
    }

    // Action: Sync Tournament Roles
    if (action === 'sync_roles') {
      if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
      }

      try {
        const stats = await syncTournamentRoles(guild, tournamentId);
        const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
        const { tournament, summary } = backendData;

        // Refresh Control Panel embed with updated role statistics
        await setupTournamentControlPanel(guild, tournament, summary, botMember);

        const roleMention = stats.roleId ? `<@&${stats.roleId}>` : `\`${stats.roleName}\``;
        const resp = `✅ **Tournament Roles Synchronized:**\n` +
          `• **Role:** ${roleMention} (\`${stats.roleName}\` | ID: \`${stats.roleId}\`)\n` +
          `• **Roles Assigned:** **${stats.assigned}** new member(s)\n` +
          `• **Already Assigned:** **${stats.alreadyAssigned}** member(s)\n` +
          `• **Roles Removed (Ineligible):** **${stats.removed}** member(s)\n` +
          `• **Skipped:** **${stats.skipped}** (unlinked accounts or users not in server)\n` +
          `• **Total Members Holding Role:** **${stats.membersWithRole}**`;

        if (typeof interaction.editReply === 'function') {
          await interaction.editReply({ content: resp });
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: resp, ephemeral: true });
        }
      } catch (err) {
        const errorMsg = `❌ **Failed to sync tournament roles:** ${err.message}`;
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
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`md_tour_confirm_delete:${tournamentId}`)
          .setLabel('Yes, Delete All Channels')
          .setEmoji('⚠️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`md_tour_cancel_delete:${tournamentId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      const promptText = `⚠️ **Confirm Permanent Channel Deletion**\n` +
        `Are you sure you want to delete all Discord channels for tournament \`${tournamentId}\`?\n\n` +
        `**This will permanently delete:**\n` +
        `• \`#bot-commands\`\n` +
        `• \`#tournament-update\`\n` +
        `• \`#tournament-teams\`\n` +
        `• \`#tournament-helpdesk\`\n` +
        `• The tournament category\n\n` +
        `*(The website tournament and database registrations will NOT be deleted).*\n` +
        `⏱️ **This confirmation prompt will expire in 30 seconds.**`;

      if (typeof interaction.reply === 'function') {
        const sent = await interaction.reply({
          content: promptText,
          components: [confirmRow],
          ephemeral: true,
        });

        if (sent?.createMessageComponentCollector) {
          const collector = sent.createMessageComponentCollector({ time: 30000 });
          collector.on('end', (collected, reason) => {
            if (reason === 'time') {
              interaction.editReply({
                content: '⏱️ **Confirmation Timed Out:** Tournament channel deletion was cancelled.',
                components: [],
              }).catch(() => { });
            }
          });
        }
      }
      return;
    }

    // Action: Cancel Delete
    if (action === 'cancel_delete') {
      if (typeof interaction.update === 'function') {
        await interaction.update({
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
      const saved = guildSettingsCache[guild.id]?.tournaments?.[tournamentId];
      if (!saved || saved.setupStatus === 'deleted') {
        const msg = '⚠️ **Notice:** This tournament has no active Discord channels or they were already deleted.';
        if (typeof interaction.update === 'function') {
          await interaction.update({ content: msg, components: [] });
        } else if (typeof interaction.reply === 'function') {
          await interaction.reply({ content: msg, ephemeral: true });
        }
        return;
      }

      if (typeof interaction.update === 'function') {
        await interaction.update({ content: '⏳ **Deleting tournament channels...**', components: [] });
      }

      const deletionSummary = await deleteTournamentDiscordChannels(guild, tournamentId);

      // Update persistent state to mark deleted
      saved.setupStatus = 'deleted';
      saved.channels = {};
      saved.categoryId = null;
      saved.roleId = null;
      saved.roleName = null;
      saved.roleSyncStats = null;
      saved.roleLastSyncedAt = null;
      saved.allEligibleMemberIds = [];
      saved.controlPanelMessageId = null;
      saved.teamListMessageIds = [];
      saved.teamListMessageId = null;
      saved.registrationMessageId = null;
      saved.rounds = {};
      saved.deletedAt = new Date().toISOString();
      guildSettingsCache[guild.id].tournaments[tournamentId] = saved;
      saveGuildSettings(guildSettingsCache);

      const resultMsg = `🗑️ **Tournament Channels Deleted:**\n` +
        `• **Deleted Channels:** ${deletionSummary.deletedChannels.length > 0 ? deletionSummary.deletedChannels.map(n => `\`#${n}\``).join(', ') : 'None'}\n` +
        `• **Category Deleted:** ${deletionSummary.categoryDeleted ? 'Yes' : 'No'}\n` +
        `• Website tournament data and database registrations remain completely untouched.`;

      if (typeof interaction.followUp === 'function') {
        await interaction.followUp({ content: resultMsg, ephemeral: true });
      } else if (typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: resultMsg });
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
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    const notInitMsg = `❌ Tournament \`${tournamentId}\` is not initialized.`;
    if (typeof interaction.update === 'function') {
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
        `  └ **Status:** **${r.status}** | **Groups:** **${r.groups?.length || 0}** | **Teams Allocated:** **${allocatedTeams}**\n`;
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
        .setDescription(`Status: ${r.status} | Groups: ${r.groups?.length || 0} | Teams: ${allocatedTeams}`.slice(0, 100))
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
      .setCustomId(`md_tour_create_sequential_round:${tournamentId}`)
      .setLabel('Create Round')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_tour_refresh_rounds:${tournamentId}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_tour_back_to_panel:${tournamentId}`)
      .setLabel('Back to Tournament Panel')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(buttonRow);

  if (typeof interaction.update === 'function') {
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
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    const errText = `❌ Tournament \`${tournamentId}\` is not initialized.`;
    if (typeof interaction.reply === 'function') {
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

  // Background refresh of main control panel
  try {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me);
  } catch (err) {
    console.warn('[Discord Bot] Control panel background refresh warning after round create:', err.message);
  }

  // Update View Rounds Screen in place
  await handleViewRoundsScreen(interaction, tournamentId);
}

/**
 * Opens the dedicated management view for an individual selected round.
 */
export async function handleOpenIndividualRoundMenu(interaction, tournamentId, roundId) {
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
    if (typeof interaction.update === 'function') {
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
          `• **Teams Allocated:** **${totalAllocatedTeams}**\n` +
          `• **Capacity Policy:** 25 slots per group (Slots 01-02 LOCKED, Slots 03-18 Teams [max 16], Slots 19-25 UNUSED)\n` +
          `${groupsDetailText}`,
        inline: false,
      }
    )
    .setTimestamp();

  // Action Buttons:
  // Row 1: Start Round, Edit Round, Delete Round, View Allocation
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_start:${tournamentId}:${round.roundId}`)
      .setLabel('Start Round')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(isActive || isCompleted),
    new ButtonBuilder()
      .setCustomId(`md_round_edit:${tournamentId}:${round.roundId}`)
      .setLabel('Edit Round')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_round_delete:${tournamentId}:${round.roundId}`)
      .setLabel('Delete Round')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isActive),
    new ButtonBuilder()
      .setCustomId(`md_round_view_alloc:${tournamentId}:${round.roundId}`)
      .setLabel('View Allocation')
      .setEmoji('👁️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!round.groups || round.groups.length === 0)
  );

  // Row 2: Back to Rounds, Back to Tournament Panel
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_rounds:${tournamentId}`)
      .setLabel('Back to Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`md_tour_back_to_panel:${tournamentId}`)
      .setLabel('Back to Tournament Panel')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  if (typeof interaction.update === 'function') {
    await interaction.update({ content: null, embeds: [embed], components: [row1, row2] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true }).catch(() => {});
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

  const promptText = `⚠️ **Confirm Starting ${round.name}**\n\n` +
    activeWarning +
    `This will execute the official tournament allocation workflow:\n` +
    `• Fetch latest verified registrations from MatchDistrict backend\n` +
    `• Divide eligible teams into groups of 16 across 25 slots (Slots 01-02 LOCKED, Slots 03-18 Teams, Slots 19-25 UNUSED)\n` +
    `• Create/reuse dedicated group roles and private ID/password channels\n` +
    `• Assign group roles to verified linked Discord players\n` +
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

  const notesInput = new TextInputBuilder()
    .setCustomId('round_notes')
    .setLabel('Round Stage Description / Notes')
    .setValue(round.notes || '')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(notesInput)
  );

  await interaction.showModal(modal).catch(() => {});
}

/**
 * Handles submission of Edit Round modal.
 */
export async function handleEditRoundSubmit(interaction, tournamentId, roundId, newName, newNotes) {
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

  round.name = newName;
  round.notes = newNotes || '';
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);

  // Background refresh of control panel
  try {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me);
  } catch (err) {
    console.warn('[Discord Bot] Control panel background refresh warning after round edit:', err.message);
  }

  const successRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_menu:${tournamentId}:${roundId}`)
      .setLabel(`Manage ${newName}`)
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_round_back_to_rounds:${tournamentId}`)
      .setLabel('View Rounds')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: `✅ Updated **${newName}** (ID: \`${roundId}\`) successfully.`,
    components: [successRow],
    ephemeral: true,
  }).catch(() => {});
}

/**
 * Handles Delete Round prompt. Prohibits deletion if round is Active.
 */
export async function handlePromptDeleteRound(interaction, tournamentId, roundId) {
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
    const warnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_round_back_to_menu:${tournamentId}:${roundId}`)
        .setLabel('Back to Round Menu')
        .setStyle(ButtonStyle.Secondary)
    );
    const msg = `❌ **Cannot Delete Active Round:**\n` +
      `**${round.name}** (\`${round.roundId}\`) is currently **Active**.\n` +
      `Active rounds cannot be deleted while in progress. Please complete the round first before deleting it.`;
    if (typeof interaction.update === 'function') {
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

  if (typeof interaction.update === 'function') {
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
    const errMsg = `❌ **Cannot Delete Active Round:** **${round.name}** is currently active.`;
    if (typeof interaction.update === 'function') {
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

  delete savedTournament.rounds[roundId];
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);

  // Background refresh of control panel
  try {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me);
  } catch (err) {
    console.warn('[Discord Bot] Control panel background refresh warning after round delete:', err.message);
  }

  // Navigate back to View Rounds screen
  await handleViewRoundsScreen(interaction, tournamentId);
}

/**
 * Displays the 25-slot layout and allocation details for a selected round.
 */
export async function handleViewRoundAllocation(interaction, tournamentId, roundId) {
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

  if (!Array.isArray(round.groups) || round.groups.length === 0) {
    const noGroupsMsg = `⚠️ Round **${round.name}** has no groups allocated yet. Start the round to perform slot allocation.`;
    if (typeof interaction.reply === 'function') {
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
      `**Status:** **${round.status}** | **Groups:** ${round.groups.length}\n` +
      `**Slot Policy:** 25 slots per group (Slots 01-02 LOCKED, Slots 03-18 Teams [max 16], Slots 19-25 UNUSED)`
    )
    .setTimestamp();

  for (const group of round.groups.slice(0, 5)) {
    let groupText = '';
    for (const slot of group.slots || []) {
      const slotNumStr = String(slot.slotNumber).padStart(2, '0');
      if (slot.status === 'LOCKED') {
        groupText += `🔒 **Slot ${slotNumStr}:** \`LOCKED\`\n`;
      } else if (slot.status === 'OCCUPIED') {
        const memberCount = Array.isArray(slot.members) ? slot.members.length : 0;
        groupText += `🎮 **Slot ${slotNumStr}:** **${slot.teamName}** (${memberCount} linked)\n`;
      } else if (slot.status === 'UNUSED' || slot.status === 'RESERVED') {
        groupText += `⛔ **Slot ${slotNumStr}:** \`UNUSED\`\n`;
      } else {
        groupText += `⚪ **Slot ${slotNumStr}:** *EMPTY*\n`;
      }
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

  if (typeof interaction.update === 'function') {
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
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  try {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    const { tournament, summary } = backendData;
    const currentSettings = guildSettingsCache[guild.id] || {};
    const savedTournament = currentSettings.tournaments?.[tournamentId] || {};

    let category = null;
    if (savedTournament.categoryId) {
      category = guild.channels.cache.get(savedTournament.categoryId) ||
        await guild.channels.fetch(savedTournament.categoryId).catch(() => null);
    }

    const channels = savedTournament.channels || {};
    let activeParticipantChannelCount = 0;
    const expectedChannels = [
      channels.tournamentUpdateId,
      channels.tournamentTeamsId,
      channels.tournamentHelpdeskId,
      channels.tournamentRegisterId,
      channels.roomMakerVcId,
    ].filter(Boolean);

    for (const chId of expectedChannels) {
      const ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
      if (ch) activeParticipantChannelCount++;
    }

    const isConfigured = Boolean(category && activeParticipantChannelCount >= 5);
    const channelsStatus = {
      isConfigured,
      activeCount: activeParticipantChannelCount + 1,
      statusText: isConfigured
        ? `🟢 **Active & Configured** — All 5 channels & category operational.`
        : `🟡 **Pending Creation** — Participant channels not created yet.`,
    };

    let roleInfo = null;
    if (savedTournament.roleId) {
      const role = guild.roles.cache.get(savedTournament.roleId) ||
        await guild.roles.fetch(savedTournament.roleId).catch(() => null);
      if (role) {
        roleInfo = {
          roleId: role.id,
          roleName: role.name,
          membersWithRole: role.members.size,
          lastSyncedAt: savedTournament.roleLastSyncedAt || null,
        };
      }
    }

    const embed = buildTournamentControlPanelEmbed(tournament, summary, channelsStatus, roleInfo, savedTournament.rounds || {});
    const buttons = buildTournamentControlPanelButtons(tournamentId);

    if (typeof interaction.update === 'function') {
      await interaction.update({ content: null, embeds: [embed], components: buttons }).catch(() => {});
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply({ embeds: [embed], components: buttons, ephemeral: true }).catch(() => {});
    }
  } catch (err) {
    const errorMsg = `❌ **Failed to load tournament panel:** ${err.message}`;
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles round creation submission from modal.
 */
export async function handleCreateRoundSubmit(interaction, tournamentId, roundName) {
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

  if (duplicateDraft) {
    await interaction.reply({
      content: `⚠️ A round named **${duplicateDraft.name}** (ID: \`${duplicateDraft.roundId}\`) already exists in **Draft** status. Duplicate round creation prevented.`,
      ephemeral: true,
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
    status: 'Draft',
    createdAt: new Date().toISOString(),
    startedAt: null,
    groups: [],
    summaryMessageIds: [],
  };

  savedTournament.rounds[candidateRoundId] = newRound;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);

  // Refresh Control Panel embed
  try {
    const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
    await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me);
  } catch (err) {
    console.warn(`[Discord Bot] Control panel refresh warning after round create:`, err.message);
  }

  await interaction.reply({
    content: `✅ Created **${roundName}** (ID: \`${candidateRoundId}\`) with status **Draft**.\n` +
      `Click **Start Round** when you are ready to allocate registered teams into groups.`,
    ephemeral: true,
  }).catch(() => {});
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

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (typeof interaction.deferReply === 'function') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  } else if (typeof interaction.update === 'function') {
    await interaction.update({ content: '⏳ **Allocating groups and slots...**', components: [] }).catch(() => {});
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
        if (typeof interaction.editReply === 'function') {
          await interaction.editReply({ content: msg, components: [] });
        } else if (typeof interaction.followUp === 'function') {
          await interaction.followUp({ content: msg, ephemeral: true });
        }
        return;
      }

      // Fetch latest registrations from backend
      const backendData = await fetchTournamentRegistrationsFromBackend(tournamentId);
      const { tournament, teams, summary } = backendData;

      const eligibleTeams = teams.filter((t) => t.is_eligible);
      if (eligibleTeams.length === 0) {
        throw new Error(`No eligible registered teams found for tournament "${tournament.title}". Cannot allocate empty round.`);
      }

      // Group & Slot Allocation Rules:
      // Group size: exactly 25 slots. Slots 01-02: LOCKED. Slots 03-18: 16 teams. Slots 19-25: UNUSED.
      const ASSIGNABLE_SLOTS_PER_GROUP = 16;
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
      const tourPrefix = normalizeTournamentRoleName(tournament.title, tournament.id);
      const roundNum = round.roundNumber || 1;

      const groups = [];
      let totalAssignedMembers = 0;
      let unlinkedTeamsCount = 0;

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
          groupRole = guild.roles.cache.find(
            (r) =>
              r.name.toLowerCase() === roleName.toLowerCase() ||
              r.name.toLowerCase() === altRoleName.toLowerCase()
          ) || null;
        }
        if (!groupRole && typeof guild.roles?.create === 'function') {
          groupRole = await guild.roles.create({
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
          if (groupChannel && groupChannel.parentId !== category.id) {
            groupChannel = null;
          }
        }
        if (!groupChannel) {
          groupChannel = Array.from(guild.channels.cache.values()).find(
            (c) => c.parentId === category.id && c.type === ChannelType.GuildText && c.name.toLowerCase() === channelName.toLowerCase()
          ) || null;
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
          if (typeof groupChannel.permissionOverwrites?.set === 'function') {
            await groupChannel.permissionOverwrites.set(groupOverwrites).catch(() => {});
          }
        } else {
          groupChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `Private Match Credentials for Group ${g} (${round.name}) — ${tournament.title}`,
            permissionOverwrites: groupOverwrites,
          });
        }

        // 3. Populate slots 1-25
        const slots = [
          { slotNumber: 1, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] },
          { slotNumber: 2, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] },
        ];

        // Slots 03–18: exactly 16 team positions
        for (let s = 3; s <= 18; s++) {
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
            });

            // Assign group role to verified linked members
            if (groupRole) {
              for (const mem of linkedMembers) {
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
            });
          }
        }

        // Slots 19–25: "UNUSED" or "RESERVED"; do not assign teams to these positions
        for (let s = 19; s <= 25; s++) {
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
          await applyStrictGroupChannelPermissions(guild, groupChannel, groupRole, tourRole, botMember);
          await removeGroupResultControlMessage(guild, groupObj, groupChannel);
          await updateGroupSlotListMessage(guild, tournament, round, groupObj, groupChannel);
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
      round.status = 'Active';
      round.startedAt = new Date().toISOString();
      round.groups = groups;
      round.globalSubmissionStatus = 'Closed';

      savedTournament.rounds[round.roundId] = round;
      guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
      saveGuildSettings(guildSettingsCache);
      await enforceSingleActiveRoundInDb(guild.id, tournamentId, round.roundId);
      await saveTournamentToDb(guild.id, tournamentId, savedTournament);

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

      const successMsg = `✅ **${round.name} Started Successfully!**\n` +
        `• **Eligible Teams Allocated:** **${eligibleTeams.length}** across **${groupCount}** group(s)\n` +
        `• **Capacity Policy:** Exactly 16 teams/group across 25 slots (Slots 01-02 LOCKED, Slots 03-18 Teams, Slots 19-25 UNUSED)\n` +
        `• **Group Roles & Channels:** **${groups.length}** private text channel(s) and role(s) configured\n` +
        `• **Group Roles Assigned:** **${totalAssignedMembers}** verified member(s)\n` +
        (unlinkedTeamsCount > 0 ? `• ⚠️ **Pending Links:** **${unlinkedTeamsCount}** team(s) have unlinked Discord accounts\n` : '') +
        `• **Allocation Summary:** Published in <#${savedTournament.channels?.botCommandsId || 'bot-commands'}>.`;

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`md_round_back_to_menu:${tournamentId}:${round.roundId}`)
          .setLabel(`Manage ${round.name}`)
          .setEmoji('⚔️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`md_round_back_to_rounds:${tournamentId}`)
          .setLabel('View Rounds')
          .setEmoji('📋')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`md_tour_back_to_panel:${tournamentId}`)
          .setLabel('Back to Tournament Panel')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
      );

      if (typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: successMsg, embeds: [], components: [navRow] });
      } else if (typeof interaction.followUp === 'function') {
        await interaction.followUp({ content: successMsg, components: [navRow], ephemeral: true });
      }
    });
  } catch (err) {
    const errorMsg = `❌ **Failed to start round:** ${err.message}`;
    if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ content: errorMsg, embeds: [], components: [] });
    } else if (typeof interaction.followUp === 'function') {
      await interaction.followUp({ content: errorMsg, ephemeral: true });
    }
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
    !customId.startsWith('md_select_qualify_teams:')
  ) return;

  if (customId.startsWith('md_select_qualify_teams:')) {
    const [, tourId, rId, gId] = customId.split(':');
    await handleConfirmQualifyTeams(interaction, tourId, rId, gId, interaction.values || []);
    return;
  }

  if (customId.startsWith('md_tour_select_round_menu:')) {
    const tournamentId = customId.split(':')[1];
    const roundId = interaction.values?.[0];
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
    await handleCreateRoundSubmit(interaction, tournamentId, roundName);
    return;
  }

  if (customId.startsWith('md_modal_edit_round:')) {
    const parts = customId.split(':');
    const tournamentId = parts[1];
    const roundId = parts[2];
    const newName = interaction.fields?.getTextInputValue('round_name')?.trim();
    const newNotes = interaction.fields?.getTextInputValue('round_notes')?.trim() || '';
    await handleEditRoundSubmit(interaction, tournamentId, roundId, newName, newNotes);
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
export async function applyStrictGroupChannelPermissions(guild, groupChannel, groupRole, tourRole, botMember) {
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
 * Includes the administrative "Qualify Team" button.
 */
export async function updateGroupSlotListMessage(guild, tournament, round, group, channel) {
  if (!channel || typeof channel.send !== 'function') return null;

  const roleMention = group.roleId ? `<@&${group.roleId}>` : `@${group.roleName}`;

  // Credential info
  let credentialsText = '🔒 **Match ID & Password:** *Not published yet. Room details will appear here once published by tournament officials.*';
  if (group.credentials?.roomId && group.credentials?.password) {
    credentialsText = `🎮 **Room ID / Name:** \`${group.credentials.roomId}\`\n` +
      `🔑 **Password:** \`${group.credentials.password}\`\n` +
      `⏰ **Published:** <t:${Math.floor(new Date(group.credentials.publishedAt || Date.now()).getTime() / 1000)}:R>`;
  }

  // All 25 slots representation
  let slotsText = '';
  const slots = Array.isArray(group.slots) ? group.slots : [];

  for (let s = 1; s <= 25; s++) {
    const slotNum = String(s).padStart(2, '0');
    const slotData = slots.find((sl) => sl.slotNumber === s);

    if (s >= 1 && s <= 2) {
      slotsText += `🔒 **Slot ${slotNum}:** \`LOCKED\`\n`;
    } else if (s >= 3 && s <= 18) {
      if (slotData && (slotData.status === 'OCCUPIED' || slotData.teamName)) {
        const isQualified = slotData.qualificationStatus === 'Qualified';
        const qualTag = isQualified ? ' **[QUALIFIED 🏆]**' : ' *[Pending ⏳]*';
        slotsText += `🎮 **Slot ${slotNum}:** **${slotData.teamName}**${qualTag}\n`;
      } else {
        slotsText += `⚪ **Slot ${slotNum}:** *EMPTY*\n`;
      }
    } else {
      slotsText += `⛔ **Slot ${slotNum}:** \`UNUSED / RESERVED\`\n`;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${tournament.title || tournament.id} — ${round.name} (Group ${group.groupNumber})`)
    .setColor(0x3b82f6)
    .setDescription(
      `Official Slot Allocation & Match Hub for **${round.name} — Group ${group.groupNumber}** (${roleMention})\n\n` +
      `📢 **Instructions:** Be in the lobby at least 10 minutes prior to match start. Ensure you occupy your assigned slot number.\n\n` +
      `────────────────────────────────────────\n` +
      `### 🔑 Match Credentials\n${credentialsText}\n` +
      `────────────────────────────────────────\n` +
      `### ⚔️ Group Slot Assignments (1–25)\n${slotsText}`
    )
    .setFooter({ text: `${tournament.title || 'MatchDistrict'} • Group ${group.groupNumber} • Admin: Qualify Team below` })
    .setTimestamp();

  // "Qualify Team" button for administrators
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_qualify_team:${tournament.id}:${round.roundId}:${group.groupId}`)
      .setLabel('Qualify Team')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Success)
  );

  const logicalKey = `guild:${guild.id}:tournament:${tournament.id}:round:${round.roundId}:group:${group.groupId}:slot_list`;

  try {
    const result = await upsertManagedMessage(guild.client, {
      guildId: guild.id,
      channelId: channel.id,
      logicalKey,
      messageType: 'group_slot_list',
      tournamentId: tournament.id,
      roundId: round.roundId,
      groupId: group.groupId,
      payload: { embeds: [embed], components: [actionRow] },
    });
    group.slotListMessageId = result.messageId;
    return result.messageId;
  } catch (err) {
    console.warn('[Discord Bot] ⚠️ Error in upsertManagedMessage for group slot list:', err.message);
    let msg = null;
    if (group.slotListMessageId && typeof channel.messages?.fetch === 'function') {
      msg = await channel.messages.fetch(group.slotListMessageId).catch(() => null);
    }
    if (msg && typeof msg.edit === 'function') {
      await msg.edit({ embeds: [embed], components: [actionRow] }).catch(() => {});
      group.slotListMessageId = msg.id;
    } else {
      const newMsg = await channel.send({ embeds: [embed], components: [actionRow] }).catch(() => null);
      if (newMsg) group.slotListMessageId = newMsg.id;
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `🟢 **Result Submissions Opened:** Result submissions are now **OPEN** for all groups in **${round.name}**! Eligible verified players may now submit results.`,
    ephemeral: true,
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `🔴 **Result Submissions Closed:** Result submissions for **${round.name}** are now **CLOSED**. All new and pending unaccepted submissions are locked.`,
    ephemeral: true,
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
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

  await interaction.reply({
    content: '🔄 **Submission status refreshed successfully.**',
    ephemeral: true,
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

/**
 * Handles the "Qualify Team" button click in an ID/PWD channel.
 * Opens an ephemeral StringSelectMenu allowing the administrator to select teams.
 */
export async function handleQualifyTeamButton(interaction, tournamentId, roundId, groupId) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
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

  const group = (round.groups || []).find((g) => g.groupId === groupId || g.groupNumber === Number(groupId));
  if (!group) {
    await interaction.reply({ content: '❌ Group not found.', ephemeral: true }).catch(() => {});
    return;
  }

  const assignedSlots = (group.slots || []).filter((s) => s.status === 'OCCUPIED' && s.teamName);
  if (assignedSlots.length === 0) {
    await interaction.reply({
      content: `⚠️ No teams are currently assigned to **Group ${group.groupNumber}**.`,
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const targetRoundNum = (round.roundNumber || 1) + 1;
  const nextRoundName = `Round ${targetRoundNum}`;

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`md_select_qualify_teams:${tournamentId}:${roundId}:${group.groupId}`)
    .setPlaceholder('Select team(s) to qualify into next round...')
    .setMinValues(1)
    .setMaxValues(assignedSlots.length);

  for (const slot of assignedSlots) {
    const isQual = slot.qualificationStatus === 'Qualified';
    const label = `Slot ${String(slot.slotNumber).padStart(2, '0')}: ${slot.teamName}`.slice(0, 100);
    const desc = isQual ? 'ALREADY QUALIFIED 🏆' : 'Pending Qualification ⏳';
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(`team_${slot.teamId || slot.slotNumber}`)
        .setDescription(desc)
        .setEmoji(isQual ? '🏆' : '🎮')
    );
  }

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('md_cancel_qualify')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Qualify Teams — ${round.name} (Group ${group.groupNumber})`)
    .setColor(0x22c55e)
    .setDescription(
      `Select one or more teams from **Group ${group.groupNumber}** to qualify for **${nextRoundName}**.\n\n` +
      `• **Current Group:** Group ${group.groupNumber} (${assignedSlots.length} teams assigned)\n` +
      `• **Destination:** **${nextRoundName}**\n\n` +
      `*Selected teams will have their status updated to Qualified and will be automatically allocated into open slots of ${nextRoundName}.*`
    )
    .setFooter({ text: 'Admin Action • Changes are saved immediately upon selection' });

  await interaction.reply({
    embeds: [embed],
    components: [row1, row2],
    ephemeral: true,
  }).catch(() => {});
}

/**
 * Handles confirmation of team qualification from select menu.
 * Idempotently qualifies selected teams and allocates them to the destination round.
 */
export async function handleConfirmQualifyTeams(interaction, tournamentId, roundId, groupId, selectedTeamValues) {
  const guild = interaction.guild;
  const member = interaction.member;

  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await interaction.update({ content: access.reason, embeds: [], components: [] }).catch(() => {});
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  if (!savedTournament) {
    await interaction.update({ content: '❌ Tournament configuration not found.', embeds: [], components: [] }).catch(() => {});
    return;
  }

  const round = savedTournament.rounds?.[roundId];
  if (!round) {
    await interaction.update({ content: '❌ Source round not found.', embeds: [], components: [] }).catch(() => {});
    return;
  }

  const group = (round.groups || []).find((g) => g.groupId === groupId || g.groupNumber === Number(groupId));
  if (!group) {
    await interaction.update({ content: '❌ Source group not found.', embeds: [], components: [] }).catch(() => {});
    return;
  }

  if (!selectedTeamValues || selectedTeamValues.length === 0) {
    await interaction.update({ content: '⚠️ No teams were selected for qualification.', embeds: [], components: [] }).catch(() => {});
    return;
  }

  const currentRoundNum = round.roundNumber || 1;
  const destRoundNum = currentRoundNum + 1;

  let destRound = Object.values(savedTournament.rounds || {}).find((r) => r.roundNumber === destRoundNum);
  if (!destRound) {
    const destRoundId = `round-${destRoundNum}-${Date.now().toString(36)}`;
    destRound = {
      roundId: destRoundId,
      roundNumber: destRoundNum,
      name: `Round ${destRoundNum}`,
      status: 'Upcoming',
      groups: generateEmptyRoundGroups(4, `Round ${destRoundNum}`),
      createdAt: new Date().toISOString(),
      globalSubmissionStatus: 'Closed',
      qualifications: [],
    };
    savedTournament.rounds[destRoundId] = destRound;
  } else if (!Array.isArray(destRound.groups) || destRound.groups.length === 0) {
    destRound.groups = generateEmptyRoundGroups(4, destRound.name);
  }

  // Destination capacity check before applying batch
  let availableDestSlots = 0;
  for (const dg of destRound.groups) {
    for (const dslot of dg.slots || []) {
      if (dslot.slotNumber >= 3 && dslot.slotNumber <= 18 && dslot.status !== 'OCCUPIED') {
        availableDestSlots++;
      }
    }
  }

  const teamsToAllocate = [];
  const alreadyQualifiedNames = [];

  for (const teamVal of selectedTeamValues) {
    const cleanId = teamVal.replace(/^team_/, '');
    const sourceSlot = (group.slots || []).find(
      (s) => s.teamId === cleanId || String(s.slotNumber) === cleanId || s.teamName === cleanId
    );

    if (!sourceSlot || sourceSlot.status !== 'OCCUPIED' || !sourceSlot.teamName) {
      continue;
    }

    const alreadyInDest = destRound.groups.some((dg) =>
      (dg.slots || []).some((ds) => ds.status === 'OCCUPIED' && (ds.teamId === sourceSlot.teamId || ds.teamName === sourceSlot.teamName))
    );

    if (alreadyInDest) {
      alreadyQualifiedNames.push(sourceSlot.teamName);
      sourceSlot.qualificationStatus = 'Qualified';
    } else {
      teamsToAllocate.push(sourceSlot);
    }
  }

  if (teamsToAllocate.length > availableDestSlots) {
    await interaction.update({
      content: `❌ **Insufficient Capacity in ${destRound.name}:** Needed **${teamsToAllocate.length}** open slot(s), but only **${availableDestSlots}** slot(s) remain open. Qualification batch cancelled to prevent partial assignment.`,
      embeds: [],
      components: [],
    }).catch(() => {});
    return;
  }

  // Apply qualification and allocation atomically
  const newlyQualifiedNames = [];
  if (!Array.isArray(round.qualifications)) round.qualifications = [];

  for (const sourceSlot of teamsToAllocate) {
    sourceSlot.qualificationStatus = 'Qualified';

    let allocated = false;
    for (const dg of destRound.groups) {
      for (const dslot of dg.slots) {
        if (dslot.slotNumber >= 3 && dslot.slotNumber <= 18 && dslot.status !== 'OCCUPIED') {
          dslot.status = 'OCCUPIED';
          dslot.teamId = sourceSlot.teamId || `team-${Date.now().toString(36)}`;
          dslot.teamName = sourceSlot.teamName;
          dslot.label = sourceSlot.teamName;
          dslot.members = sourceSlot.members || [];
          dslot.qualificationStatus = 'Pending';
          allocated = true;
          break;
        }
      }
      if (allocated) break;
    }

    const qualRecord = {
      teamId: sourceSlot.teamId,
      teamName: sourceSlot.teamName,
      sourceRoundId: round.roundId,
      sourceGroupId: group.groupId,
      destinationRoundId: destRound.roundId,
      adminId: member.id,
      timestamp: new Date().toISOString(),
    };
    round.qualifications.push(qualRecord);
    newlyQualifiedNames.push(sourceSlot.teamName);
  }

  // Persist state in memory and database
  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);
  await saveTournamentToDb(guild.id, tournamentId, savedTournament);
  await recordAuditLog(guild.id, 'QUALIFY_TEAMS', {
    tournamentId,
    sourceRoundId: round.roundId,
    sourceGroupId: group.groupId,
    destinationRoundId: destRound.roundId,
    newlyQualified: newlyQualifiedNames,
    adminId: member.id,
  });

  // Update source group's slot-list message in its channel in place
  const groupChannel = group.channelId ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null)) : null;
  if (groupChannel) {
    await updateGroupSlotListMessage(guild, savedTournament, round, group, groupChannel);
  }

  // Refresh #bot-commands
  const botCommandsChannel = savedTournament.channels?.botCommandsId
    ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
    : null;

  if (botCommandsChannel) {
    await publishRoundAllocationSummary(guild, savedTournament, round, botCommandsChannel, savedTournament);
    await updateGlobalSubmissionControlPanel(guild, savedTournament, round, botCommandsChannel);
  }

  const successEmbed = new EmbedBuilder()
    .setTitle(`🏆 Qualification Confirmed — ${round.name} (Group ${group.groupNumber})`)
    .setColor(0x22c55e)
    .setDescription(
      `Successfully qualified **${newlyQualifiedNames.length + alreadyQualifiedNames.length}** team(s) from **Group ${group.groupNumber}** into **${destRound.name}**!\n\n` +
      (newlyQualifiedNames.length > 0 ? `• **Newly Qualified & Allocated:** ${newlyQualifiedNames.map(n => `**${n}**`).join(', ')}\n` : '') +
      (alreadyQualifiedNames.length > 0 ? `• **Already Qualified:** ${alreadyQualifiedNames.map(n => `*${n}*`).join(', ')}\n` : '') +
      `• **Destination Round:** **${destRound.name}** (\`${destRound.roundId}\` — Status: **${destRound.status}**)\n` +
      `• The group slot list and bot-commands summaries have been updated in place.`
    )
    .setFooter({ text: `Admin: ${member.user?.tag || member.id}` })
    .setTimestamp();

  await interaction.update({
    content: null,
    embeds: [successEmbed],
    components: [],
  }).catch(() => {});
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

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);

  if (!savedTournament || !round || !group) {
    await interaction.reply({ content: '❌ Group or round configuration not found.', ephemeral: true }).catch(() => {});
    return;
  }

  const groupChannel = group.channelId
    ? (guild.channels.cache.get(group.channelId) || await guild.channels.fetch(group.channelId).catch(() => null))
    : null;

  if (!groupChannel) {
    await interaction.reply({ content: '❌ Group channel not found.', ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `✅ **Result details registered!** Please upload your match screenshot in <#${tempUploadChannel.id}> to complete your submission.`,
    ephemeral: true,
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);

  if (!savedTournament || !round || !group) {
    await interaction.reply({ content: '❌ Group or round was not found.', ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `🔒 **Submissions Closed:** Results for **${round.name} — Group ${group.groupNumber}** have been closed. Further submissions are disabled.`,
    ephemeral: true,
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);

  if (!savedTournament || !round || !group) {
    await interaction.reply({ content: '❌ Group or round was not found.', ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `🔓 **Submissions Reopened:** Result submission window for **${round.name} — Group ${group.groupNumber}** has been reopened.`,
    ephemeral: true,
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);
  const submission = (group?.submissions || []).find((s) => s.submissionId === submissionId);

  if (!savedTournament || !round || !group || !submission) {
    await interaction.reply({ content: '❌ Submission or group record not found.', ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `✅ Result for **${submission.teamName}** in **${round.name} — Group ${group.groupNumber}** officially **Accepted**!`,
    ephemeral: true,
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
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  const reason = interaction.fields?.getTextInputValue('rejection_reason')?.trim() || 'Criteria not met';

  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];
  const group = (round?.groups || []).find((g) => g.groupId === groupId);
  const submission = (group?.submissions || []).find((s) => s.submissionId === submissionId);

  if (!savedTournament || !round || !group || !submission) {
    await interaction.reply({ content: '❌ Submission or group record not found.', ephemeral: true }).catch(() => {});
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

  await interaction.reply({
    content: `❌ Result rejected with reason: "${reason}". The group may now submit a corrected result.`,
    ephemeral: true,
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

  const embed = new EmbedBuilder()
    .setTitle(`🔑 Match Credentials — ${targetRound.name} (Group ${group.groupNumber})`)
    .setColor(0x3b82f6)
    .setDescription(`Official Room Details for **${targetRound.name} — Group ${group.groupNumber}**\n*Only members of this group and administrators can view this channel.*`)
    .addFields(
      { name: '🎮 Room ID / Name', value: `\`${roomId}\``, inline: true },
      { name: '🔒 Password', value: `\`${password}\``, inline: true },
      { name: '⏰ Published At', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: false }
    )
    .setFooter({ text: `${savedTournament.tournamentTitle || 'MatchDistrict'} • Do NOT share credentials outside your squad!` })
    .setTimestamp();

  let credMsg = null;
  if (group.credentialsMessageId && typeof channel.messages?.fetch === 'function') {
    try {
      credMsg = await channel.messages.fetch(group.credentialsMessageId).catch(() => null);
    } catch {
      credMsg = null;
    }
  }

  // Duplicate prevention: search channel for existing bot credentials message
  if (!credMsg && typeof channel.messages?.fetch === 'function') {
    try {
      const recentMsgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recentMsgs && recentMsgs.size > 0) {
        credMsg = Array.from(recentMsgs.values()).find(
          (m) =>
            (m.author.id === guild.client.user?.id || m.author.bot) &&
            m.embeds?.some((e) => e.title?.includes('Match Credentials'))
        ) || null;
      }
    } catch {}
  }

  if (credMsg && typeof credMsg.edit === 'function') {
    await credMsg.edit({ embeds: [embed] });
    group.credentialsMessageId = credMsg.id;
  } else {
    const newMsg = await channel.send({ embeds: [embed] });
    group.credentialsMessageId = newMsg.id;
  }

  group.credentials = {
    roomId,
    password,
    publishedAt: new Date().toISOString(),
  };

  // Ensure strict read-only permissions and update slot list with credentials
  const groupRole = group.roleId ? (guild.roles.cache.get(group.roleId) || await guild.roles.fetch(group.roleId).catch(() => null)) : null;
  const tourRole = savedTournament.roleId ? (guild.roles.cache.get(savedTournament.roleId) || await guild.roles.fetch(savedTournament.roleId).catch(() => null)) : null;
  await applyStrictGroupChannelPermissions(guild, channel, groupRole, tourRole, guild.members.me);
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

    const catActionText = syncResult.categoryAction === 'created'
      ? `Created (<#${syncResult.categoryId}>)`
      : syncResult.categoryAction === 'reused'
        ? `Reused (<#${syncResult.categoryId}>)`
        : 'Failed';

    let msg = `${statusEmoji} ${statusTitle}\n\n` +
      `• 🏆 **Tournament:** **${tournament.title}** (ID: \`${tournament.id}\`)\n` +
      `• 🎮 **Status:** ${tournament.status?.toUpperCase() || 'PUBLISHED'}\n` +
      `• 👥 **Registered Teams:** **${summary.total_registered_teams}** total (` +
      `🟢 **${summary.eligible_teams_count}** eligible, 🔴 **${summary.ineligible_teams_count}** ineligible/rejected)\n` +
      `• 🔗 **Eligible Linked Discord Members:** **${summary.eligible_linked_members_count}** participant(s) granted channel access\n` +
      `• ⚠️ **Unlinked Participants:** **${summary.unlinked_members_count}** account(s) not linked to Discord on website\n` +
      `• 🛡️ **Duplicate Discord IDs:** **${summary.duplicate_discord_ids_count || 0}** safely deduplicated\n\n` +
      `📁 **Tournament Category & Channels:**\n` +
      `• **Category:** ${catActionText}\n` +
      `• **Four Shared Channels:**\n` +
      `• **Four Shared Channels & Registration Link:**\n` +
      `  - 🤖 **Bot Commands (Admin Only):** ${syncResult.channelIds?.botCommandsId ? `<#${syncResult.channelIds.botCommandsId}>` : '#bot-commands'}\n` +
      `  - 📢 **Announcements & Updates:** ${syncResult.channelIds?.tournamentUpdateId ? `<#${syncResult.channelIds.tournamentUpdateId}>` : '#tournament-update'}\n` +
      `  - 📋 **Registered Teams Roster:** ${syncResult.channelIds?.tournamentTeamsId ? `<#${syncResult.channelIds.tournamentTeamsId}>` : '#tournament-teams'}\n` +
      `  - 📋 **Registered Teams Roster:** ${syncResult.channelIds?.tournamentTeamsId ? `<#${syncResult.channelIds.tournamentTeamsId}>` : '#tournament-teams'} (Admin Only)\n` +
      `  - 💬 **Helpdesk & Support:** ${syncResult.channelIds?.tournamentHelpdeskId ? `<#${syncResult.channelIds.tournamentHelpdeskId}>` : '#tournament-helpdesk'}\n` +
      `  - 🔗 **Registration & Details:** ${syncResult.channelIds?.tournamentRegisterId ? `<#${syncResult.channelIds.tournamentRegisterId}>` : '#tournament-register'}\n` +
      `• **Roster Status:** ${syncResult.teamsUpdatedInChannel ? '🟢 **Published to #tournament-teams**' : '⚪ **Roster ready**'}\n` +
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
