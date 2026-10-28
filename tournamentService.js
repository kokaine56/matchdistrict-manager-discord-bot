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
  const startedRounds = roundsList.filter((r) => r.status === 'Started');
  const draftRounds = roundsList.filter((r) => r.status === 'Draft');
  const activeRound = startedRounds[startedRounds.length - 1] || draftRounds[0] || null;

  let roundStatusText = 'No rounds created';
  let groupSlotStatusText = '• **Group & Slot Status:** No active round started.';

  if (activeRound) {
    const statusEmoji = activeRound.status === 'Started' ? '🟢' : '🟡';
    roundStatusText = `${statusEmoji} **${activeRound.name}** (\`${activeRound.roundId}\`) — **${activeRound.status}**`;

    if (activeRound.status === 'Started' && Array.isArray(activeRound.groups) && activeRound.groups.length > 0) {
      const totalGroups = activeRound.groups.length;
      let totalSlots = 0;
      let occupiedSlots = 0;
      let lockedSlots = 0;
      let emptySlots = 0;
      for (const g of activeRound.groups) {
        for (const s of g.slots || []) {
          totalSlots++;
          if (s.status === 'LOCKED') lockedSlots++;
          else if (s.status === 'OCCUPIED') occupiedSlots++;
          else emptySlots++;
        }
      }
      groupSlotStatusText =
        `• **Active Groups:** **${totalGroups}** (${totalSlots} slots total)\n` +
        `• **Group Slot Policy:** Exactly 16 slots/group (Slots 01-02 LOCKED, 14 assignable teams/group)\n` +
        `• **Allocation Breakdown:** 🔒 **${lockedSlots}** locked | 🎮 **${occupiedSlots}** occupied | ⚪ **${emptySlots}** empty`;
    } else {
      groupSlotStatusText = `• **Status:** Round configured in **Draft** state.\n• Click **Start Round** below to allocate registered teams into groups.`;
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
          `• **Total Rounds:** **${roundCount}** (${startedRounds.length} started, ${draftRounds.length} draft)\n` +
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
 * Button Row 1: Create Channels, Refresh Tournament Data, Create Round, Start Round, Delete All Channels
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
      .setCustomId(`md_tour_create_round:${tournamentId}`)
      .setLabel('Create Round')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`md_tour_start_round:${tournamentId}`)
      .setLabel('Start Round')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success),
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
  let existingIds = Array.isArray(savedTournament.teamListMessageIds)
    ? [...savedTournament.teamListMessageIds]
    : (savedTournament.teamListMessageId ? [savedTournament.teamListMessageId] : []);

  // Duplicate prevention: If no stored message IDs, search channel for bot's existing roster messages before sending new ones
  if (existingIds.length === 0 && typeof teamsChannel.messages?.fetch === 'function') {
    try {
      const recentMsgs = await teamsChannel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recentMsgs && recentMsgs.size > 0) {
        const botMsgs = Array.from(recentMsgs.values())
          .filter(
            (m) =>
              (m.author.id === guild.client.user?.id || m.author.bot) &&
              (m.content.includes('Tournament Registered Teams') ||
                m.content.includes(tournament.id) ||
                m.content.includes(tournament.title))
          )
          .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));

        if (botMsgs.length > 0) {
          existingIds = botMsgs.map((m) => m.id);
        }
      }
    } catch (searchErr) {
      console.warn(`[Discord Bot] Could not search existing messages in #tournament-teams:`, searchErr.message);
    }
  }

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

  // Safely remove any trailing messages from previous refreshes that are no longer needed
  if (existingIds.length > rosterChunks.length && typeof teamsChannel.messages?.fetch === 'function') {
    for (let j = rosterChunks.length; j < existingIds.length; j++) {
      const surplusId = existingIds[j];
      try {
        const surplusMsg = await teamsChannel.messages.fetch(surplusId).catch(() => null);
        if (surplusMsg && typeof surplusMsg.delete === 'function') {
          await surplusMsg.delete().catch(() => { });
        }
      } catch { }
    }
  }

  savedTournament.teamListMessageIds = updatedIds;
  savedTournament.teamListMessageId = updatedIds[0] || null;
  return true;
}

/**
 * Updates the official tournament registration link message in #tournament-register in place.
 */
export async function updateRegistrationLinkMessage(guild, tournament, registerChannel, savedTournament) {
  if (!registerChannel || typeof registerChannel.send !== 'function') return false;

  const websiteBaseUrl = (process.env.MATCHDISTRICT_WEBSITE_URL || process.env.MATCHDISTRICT_API_URL || 'https://matchdistrict.in').replace(/\/+$/, '');
  const directUrl = tournament.url || `${websiteBaseUrl}/tournaments/${tournament.id}`;
  const regContent = formatRegistrationMessage(tournament, directUrl);

  let regMsg = null;
  const existingId = savedTournament.registrationMessageId;

  if (existingId && typeof registerChannel.messages?.fetch === 'function') {
    try {
      regMsg = await registerChannel.messages.fetch(existingId).catch(() => null);
    } catch {
      regMsg = null;
    }
  }

  // Duplicate prevention: If no stored message ID, search channel for bot's existing registration message
  if (!regMsg && typeof registerChannel.messages?.fetch === 'function') {
    try {
      const recentMsgs = await registerChannel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recentMsgs && recentMsgs.size > 0) {
        regMsg = Array.from(recentMsgs.values()).find(
          (m) =>
            (m.author.id === guild.client.user?.id || m.author.bot) &&
            (m.content.includes(tournament.id) ||
              m.content.includes(tournament.title) ||
              m.content.includes('Tournament Registration Details'))
        ) || null;
      }
    } catch (searchErr) {
      console.warn(`[Discord Bot] Could not search existing messages in #tournament-register:`, searchErr.message);
    }
  }

  if (regMsg && typeof regMsg.edit === 'function') {
    try {
      await regMsg.edit(regContent);
      savedTournament.registrationMessageId = regMsg.id;
      return true;
    } catch (err) {
      if (err.code === 10008 || String(err.message).includes('Unknown Message')) {
        regMsg = null;
      } else {
        throw err;
      }
    }
  }

  if (!regMsg) {
    const newMsg = await registerChannel.send(regContent);
    savedTournament.registrationMessageId = newMsg.id;
  }

  return true;
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

  // 5. Update or Send Control Panel Message in #bot-commands
  let panelMessage = null;
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

  // Duplicate prevention: If no stored message ID or message was missing, search channel for existing bot control panel message
  if (!panelMessage && typeof botCommandsChannel.messages?.fetch === 'function') {
    try {
      const recentMsgs = await botCommandsChannel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recentMsgs && recentMsgs.size > 0) {
        panelMessage = Array.from(recentMsgs.values()).find(
          (m) =>
            (m.author.id === botMember.id || m.author.bot) &&
            m.embeds?.some(
              (e) =>
                e.title?.includes('Tournament Control Panel') &&
                (e.title?.includes(tournament.title) || e.footer?.text?.includes(tournament.id))
            )
        ) || null;

        if (panelMessage && typeof panelMessage.edit === 'function') {
          await panelMessage.edit({ embeds: [embed], components: buttons });
        }
      }
    } catch (searchErr) {
      console.warn(`[Discord Bot] Could not search existing messages in #bot-commands:`, searchErr.message);
    }
  }

  if (!panelMessage && typeof botCommandsChannel.send === 'function') {
    panelMessage = await botCommandsChannel.send({ embeds: [embed], components: buttons });
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

  // 8. Persist tournament mapping to guild settings
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
    if (!customId.startsWith('md_tour_')) return;

    const parts = customId.split(':');
    const actionPart = parts[0] || '';
    const tournamentId = parts[1] || '';
    const extraParam = parts[2] || '';
    const action = actionPart.replace('md_tour_', '');

    const guild = interaction.guild;
    const member = interaction.member;

    // 1. Authorization & Official Server check
    const access = checkTournamentAccess(guild, member);
    if (!access.allowed) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => { });
      }
      return;
    }

    const botMember = guild.members.me;

    // Action: Create Round (Show Modal)
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

    // Action: Start Round (Select or Confirm Draft Round)
    if (action === 'start_round') {
      await handleStartRoundButton(interaction, tournamentId);
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
      if (typeof interaction.update === 'function') {
        await interaction.update({
          content: 'ℹ️ **Round Start Cancelled:** No teams were allocated.',
          components: [],
        }).catch(() => {});
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: 'ℹ️ **Round Start Cancelled:** No teams were allocated.',
          ephemeral: true,
        }).catch(() => {});
      }
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
      `• Divide eligible teams into groups of 16 (Slots 01 & 02 LOCKED, max 14 teams per group)\n` +
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
      if (round.status === 'Started') {
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
      // Group size: exactly 16 slots. Slots 01 and 02 are LOCKED. Slots 03-16 are available (14 teams max per group).
      const ASSIGNABLE_SLOTS_PER_GROUP = 14;
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
        const roleName = `${tourPrefix}-r${roundNum}-g${g}`;
        const channelName = sanitizeChannelName(`${tourPrefix}-r${roundNum}-g${g}`);

        // 1. Create or reuse group role (no admin permissions)
        let groupRole = null;
        const existingGroup = (round.groups || []).find((gr) => gr.groupNumber === g);
        if (existingGroup?.roleId && guild.roles) {
          groupRole = guild.roles.cache.get(existingGroup.roleId) ||
            await guild.roles.fetch(existingGroup.roleId).catch(() => null);
        }
        if (!groupRole && guild.roles) {
          groupRole = guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase()) || null;
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
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
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
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.EmbedLinks,
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

        // 3. Populate slots 1-16
        const slots = [
          { slotNumber: 1, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] },
          { slotNumber: 2, status: 'LOCKED', label: 'LOCKED', teamId: null, teamName: null, members: [] },
        ];

        for (let s = 3; s <= 16; s++) {
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

        groups.push({
          groupId,
          groupNumber: g,
          roleId: groupRole?.id || null,
          roleName: groupRole?.name || roleName,
          channelId: groupChannel?.id || null,
          channelName: groupChannel?.name || channelName,
          slots,
          credentialsMessageId: existingGroup?.credentialsMessageId || null,
        });
      }

      // Update round status & metadata
      round.status = 'Started';
      round.startedAt = new Date().toISOString();
      round.groups = groups;

      savedTournament.rounds[round.roundId] = round;
      guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
      saveGuildSettings(guildSettingsCache);

      // Publish or update allocation summary in #bot-commands
      const botCommandsChannel = savedTournament.channels?.botCommandsId
        ? (guild.channels.cache.get(savedTournament.channels.botCommandsId) || await guild.channels.fetch(savedTournament.channels.botCommandsId).catch(() => null))
        : null;

      if (botCommandsChannel) {
        await publishRoundAllocationSummary(guild, tournament, round, botCommandsChannel, savedTournament);
      }

      // Refresh Control Panel embed
      await setupTournamentControlPanel(guild, tournament, summary, botMember);

      const successMsg = `✅ **${round.name} Started Successfully!**\n` +
        `• **Eligible Teams Allocated:** **${eligibleTeams.length}** across **${groupCount}** group(s)\n` +
        `• **Capacity Policy:** Exactly 16 slots/group (Slots 01-02 LOCKED, 14 assignable teams/group)\n` +
        `• **Group Roles & Channels:** **${groups.length}** private text channel(s) and role(s) configured\n` +
        `• **Group Roles Assigned:** **${totalAssignedMembers}** verified member(s)\n` +
        (unlinkedTeamsCount > 0 ? `• ⚠️ **Pending Links:** **${unlinkedTeamsCount}** team(s) have unlinked Discord accounts\n` : '') +
        `• **Allocation Summary:** Published in <#${savedTournament.channels?.botCommandsId || 'bot-commands'}>.`;

      if (typeof interaction.editReply === 'function') {
        await interaction.editReply({ content: successMsg, components: [] });
      } else if (typeof interaction.followUp === 'function') {
        await interaction.followUp({ content: successMsg, ephemeral: true });
      }
    });
  } catch (err) {
    const errorMsg = `❌ **Failed to start round:** ${err.message}`;
    if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ content: errorMsg, components: [] });
    } else if (typeof interaction.followUp === 'function') {
      await interaction.followUp({ content: errorMsg, ephemeral: true });
    }
  }
}

/**
 * Handles select menu interaction for selecting which draft round to start.
 */
export async function handleTournamentSelectMenuInteraction(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('md_tour_select_start_round:')) return;

  const tournamentId = customId.split(':')[1];
  const roundId = interaction.values?.[0];

  const guild = interaction.guild;
  const currentSettings = guildSettingsCache[guild.id] || {};
  const savedTournament = currentSettings.tournaments?.[tournamentId];
  const round = savedTournament?.rounds?.[roundId];

  if (!round) {
    await interaction.reply({ content: `❌ Selected round was not found.`, ephemeral: true }).catch(() => {});
    return;
  }

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_tour_confirm_start:${tournamentId}:${round.roundId}`)
      .setLabel(`Confirm & Start ${round.name}`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_tour_cancel_start:${tournamentId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  const promptText = `⚠️ **Confirm Starting ${round.name}**\n` +
    `This will execute the official allocation workflow:\n` +
    `• Fetch latest verified registrations from MatchDistrict backend\n` +
    `• Divide eligible teams into groups of 16 (Slots 01 & 02 LOCKED, max 14 teams per group)\n` +
    `• Create/reuse dedicated group roles and private ID/password channels\n` +
    `• Assign group roles to verified linked Discord players\n` +
    `• Publish allocation summary to <#${savedTournament.channels?.botCommandsId || 'bot-commands'}>\n\n` +
    `Click **Confirm & Start ${round.name}** to commit the allocation.`;

  if (typeof interaction.update === 'function') {
    await interaction.update({ content: promptText, components: [confirmRow] }).catch(() => {});
  } else if (typeof interaction.reply === 'function') {
    await interaction.reply({ content: promptText, components: [confirmRow], ephemeral: true }).catch(() => {});
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
  }
}

/**
 * Publishes or updates the round allocation summary in #bot-commands.
 * Reuses and edits existing messages, handles pagination, and prevents duplicates.
 */
export async function publishRoundAllocationSummary(guild, tournament, round, botCommandsChannel, savedTournament) {
  if (!botCommandsChannel || typeof botCommandsChannel.send !== 'function') return false;

  const header = `📊 **Round Allocation Summary — ${round.name}** (ID: \`${round.roundId}\`)\n` +
    `• **Tournament:** **${tournament.title}** (\`${tournament.id}\`)\n` +
    `• **Round Status:** 🟢 **${round.status}**\n` +
    `• **Groups:** **${round.groups.length}** | **Capacity:** 16 slots per group (Slots 01-02 LOCKED, Slots 03–16 assigned)\n` +
    `• **Allocated At:** <t:${Math.floor(new Date(round.startedAt || Date.now()).getTime() / 1000)}:f>\n` +
    `────────────────────────────────────────\n\n`;

  const chunks = [];
  let currentChunk = header;

  for (const group of round.groups) {
    const channelMention = group.channelId ? `<#${group.channelId}>` : `#${group.channelName}`;
    const roleMention = group.roleId ? `<@&${group.roleId}>` : `@${group.roleName}`;

    let groupText = `⚔️ **${round.name} — Group ${group.groupNumber}** (${channelMention} | ${roleMention})\n`;

    for (const slot of group.slots) {
      const slotNumStr = String(slot.slotNumber).padStart(2, '0');
      if (slot.status === 'LOCKED') {
        groupText += `  • 🔒 **Slot ${slotNumStr}:** \`LOCKED\`\n`;
      } else if (slot.status === 'OCCUPIED') {
        const linkedCount = Array.isArray(slot.members) ? slot.members.length : 0;
        groupText += `  • 🎮 **Slot ${slotNumStr}:** **${slot.teamName}** (${linkedCount} linked member${linkedCount === 1 ? '' : 's'})\n`;
      } else {
        groupText += `  • ⚪ **Slot ${slotNumStr}:** *EMPTY*\n`;
      }
    }
    groupText += '\n';

    if (currentChunk.length + groupText.length > 1900) {
      chunks.push(currentChunk.trim());
      currentChunk = groupText;
    } else {
      currentChunk += groupText;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  let existingIds = Array.isArray(round.summaryMessageIds) ? [...round.summaryMessageIds] : [];

  // Duplicate prevention: If no stored message IDs, search channel for bot's existing summary messages
  if (existingIds.length === 0 && typeof botCommandsChannel.messages?.fetch === 'function') {
    try {
      const recentMsgs = await botCommandsChannel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recentMsgs && recentMsgs.size > 0) {
        const botMsgs = Array.from(recentMsgs.values())
          .filter(
            (m) =>
              (m.author.id === guild.client.user?.id || m.author.bot) &&
              m.content.includes(`Round Allocation Summary — ${round.name}`)
          )
          .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));

        if (botMsgs.length > 0) {
          existingIds = botMsgs.map((m) => m.id);
        }
      }
    } catch {}
  }

  const updatedIds = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const existingId = existingIds[i];
    let msg = null;

    if (existingId && typeof botCommandsChannel.messages?.fetch === 'function') {
      try {
        msg = await botCommandsChannel.messages.fetch(existingId).catch(() => null);
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
      const newMsg = await botCommandsChannel.send(chunk);
      updatedIds.push(newMsg.id);
    }
  }

  // Remove surplus messages from previous larger summaries
  if (existingIds.length > chunks.length && typeof botCommandsChannel.messages?.fetch === 'function') {
    for (let j = chunks.length; j < existingIds.length; j++) {
      const surplusId = existingIds[j];
      try {
        const surplusMsg = await botCommandsChannel.messages.fetch(surplusId).catch(() => null);
        if (surplusMsg && typeof surplusMsg.delete === 'function') {
          await surplusMsg.delete().catch(() => {});
        }
      } catch {}
    }
  }

  round.summaryMessageIds = updatedIds;
  return true;
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

  savedTournament.rounds[targetRound.roundId] = targetRound;
  guildSettingsCache[guild.id].tournaments[tournamentId] = savedTournament;
  saveGuildSettings(guildSettingsCache);

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
