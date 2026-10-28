import process from 'node:process';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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
    topic: 'Tournament Management & Bot Commands (Admin Only)',
    participantAccess: 'none', // Strictly admins only
  },
  {
    key: 'tournamentUpdateId',
    name: 'tournament-update',
    topic: 'Official Announcements & Tournament Updates',
    participantAccess: 'read_only', // Participants read-only
  },
  {
    key: 'tournamentTeamsId',
    name: 'tournament-teams',
    topic: 'Registered Teams & Tournament Roster',
    participantAccess: 'read_only', // Participants read-only
  },
  {
    key: 'tournamentHelpdeskId',
    name: 'tournament-helpdesk',
    topic: 'Participant Questions & Tournament Support Desk',
    participantAccess: 'read_write', // Participants can send messages
  },
];

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
    `• To select a tournament & setup channels: \`.fetch teams <tournament_id>\` (or use the menu below)\n` +
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
      .setPlaceholder('Select a tournament to setup category & channels...')
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
          await interaction.deferUpdate().catch(() => {});
          await handleFetchTeamsCommand(guild, interaction.member, [selectedTournamentId], (text) => interaction.followUp(text));
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

  // Fetch registrations from website backend
  let backendPayload = null;
  try {
    backendPayload = await fetchTournamentRegistrationsFromBackend(tournamentId);
  } catch (err) {
    await replyFn(`❌ **Failed to fetch registrations for tournament \`${tournamentId}\`:**\n> ${err.message}`);
    return;
  }

  const { tournament, teams, summary } = backendPayload;
  if (!tournament) {
    await replyFn(`❌ **Error:** No tournament metadata returned for ID \`${tournamentId}\`.`);
    return;
  }

  // Synchronize category, exactly the four shared channels, and member permissions
  const syncResult = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);

  // Format final summary report
  const summaryMessage = formatSyncSummaryMessage(tournament, summary, syncResult);
  await replyFn(summaryMessage);

  // If command was executed outside the tournament's #bot-commands channel, post a copy to #bot-commands
  const botCmdId = syncResult.channelIds?.botCommandsId;
  if (botCmdId && (!messageChannel || messageChannel.id !== botCmdId)) {
    try {
      const bChannel = guild.channels.cache.get(botCmdId) || await guild.channels.fetch(botCmdId).catch(() => null);
      if (bChannel && typeof bChannel.send === 'function') {
        await bChannel.send(summaryMessage).catch(() => {});
      }
    } catch {
      // Ignore notification mirror errors
    }
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
    categoryId: null,
    channels: {},
    allEligibleMemberIds: [],
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

  // 1. Locate or create Tournament Category
  let category = null;
  if (savedTournament.categoryId) {
    category = guild.channels.cache.get(savedTournament.categoryId) ||
      await guild.channels.fetch(savedTournament.categoryId).catch(() => null);
  }

  if (category && category.type === ChannelType.GuildCategory) {
    syncResult.categoryAction = 'reused';
    syncResult.categoryId = category.id;
  } else {
    try {
      const categoryName = sanitizeCategoryName(tournament.title);
      const overwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
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

  // 2. Migration: Safely clean up any obsolete per-squad channels from older bot versions
  if (savedTournament.teamChannels && typeof savedTournament.teamChannels === 'object') {
    const obsoleteIds = Object.values(savedTournament.teamChannels);
    for (const chId of obsoleteIds) {
      if (!chId) continue;
      try {
        const ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
        if (ch && ch.parentId === category.id && ch.name.startsWith('team-')) {
          await ch.delete('Migrating away from obsolete per-squad channels to shared tournament channels').catch(() => {});
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

  // 4. Create or reuse exactly the four required channels
  const activeChannels = {};

  for (const channelDef of REQUIRED_TOURNAMENT_CHANNELS) {
    const existingId = savedTournament.channels[channelDef.key];
    let channelInstance = null;

    if (existingId) {
      channelInstance = guild.channels.cache.get(existingId) ||
        await guild.channels.fetch(existingId).catch(() => null);
    }

    // Fallback: search by name inside the category if mapping was missing
    if (!channelInstance) {
      channelInstance = Array.from(guild.channels.cache.values()).find(
        (c) => c.parentId === category.id && c.name === channelDef.name
      );
    }

    if (channelInstance && channelInstance.parentId === category.id) {
      syncResult.channelsReused.push(channelDef.name);
      savedTournament.channels[channelDef.key] = channelInstance.id;
      activeChannels[channelDef.key] = channelInstance;
    } else {
      // Create channel
      try {
        const initialOverwrites = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
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

        channelInstance = await guild.channels.create({
          name: channelDef.name,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `${channelDef.topic} — ${tournament.title}`,
          permissionOverwrites: initialOverwrites,
        });

        syncResult.channelsCreated.push(channelDef.name);
        savedTournament.channels[channelDef.key] = channelInstance.id;
        activeChannels[channelDef.key] = channelInstance;
      } catch (err) {
        syncResult.failures.push(`Failed to create #${channelDef.name}: ${err.message}`);
      }
    }
  }

  syncResult.channelIds = { ...savedTournament.channels };

  // 5. Synchronize Permissions across the four channels
  const previousMemberIds = new Set(savedTournament.allEligibleMemberIds || []);

  // Channels that eligible participants should be granted access to
  const participantChannels = [
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
      channel: activeChannels.tournamentTeamsId,
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

  // A. Grant or update permissions for currently eligible linked members
  for (const discordId of currentEligibleMemberIds) {
    for (const { channel, permissions } of participantChannels) {
      if (!channel) continue;
      try {
        await channel.permissionOverwrites.edit(discordId, permissions);
        syncResult.permissionsUpdated++;
      } catch (err) {
        syncResult.failures.push(`Permission error on #${channel.name} for user ${discordId}: ${err.message}`);
      }
    }

    // Ensure eligible participants do NOT have view access to #bot-commands
    if (activeChannels.botCommandsId) {
      try {
        await activeChannels.botCommandsId.permissionOverwrites.delete(discordId).catch(() => {});
      } catch {}
    }
  }

  // B. Revoke access from members who are no longer eligible
  for (const oldId of previousMemberIds) {
    if (!currentEligibleMemberIds.has(oldId)) {
      for (const { channel } of participantChannels) {
        if (!channel) continue;
        try {
          await channel.permissionOverwrites.delete(oldId);
          syncResult.permissionsRemoved++;
        } catch {}
      }
    }
  }

  // 6. Update the shared #tournament-teams channel with the latest registered team roster
  const teamsChannel = activeChannels.tournamentTeamsId;
  if (teamsChannel && typeof teamsChannel.send === 'function') {
    try {
      const rosterChunks = formatTeamsChannelRoster(tournament, teams);
      for (const chunk of rosterChunks) {
        await teamsChannel.send(chunk);
      }
      syncResult.teamsUpdatedInChannel = true;
    } catch (err) {
      syncResult.failures.push(`Failed to update roster in #tournament-teams: ${err.message}`);
    }
  }

  // 7. Persist tournament mapping to guild settings
  savedTournament.allEligibleMemberIds = Array.from(currentEligibleMemberIds);
  savedTournament.tournamentTitle = tournament.title;
  savedTournament.lastSyncedAt = new Date().toISOString();
  currentSettings.tournaments[tournamentId] = savedTournament;
  guildSettingsCache[guild.id] = currentSettings;
  saveGuildSettings(guildSettingsCache);

  return syncResult;
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
    `  - 🤖 **Bot Commands (Admin Only):** ${syncResult.channelIds?.botCommandsId ? `<#${syncResult.channelIds.botCommandsId}>` : '#bot-commands'}\n` +
    `  - 📢 **Announcements & Updates:** ${syncResult.channelIds?.tournamentUpdateId ? `<#${syncResult.channelIds.tournamentUpdateId}>` : '#tournament-update'}\n` +
    `  - 📋 **Registered Teams Roster:** ${syncResult.channelIds?.tournamentTeamsId ? `<#${syncResult.channelIds.tournamentTeamsId}>` : '#tournament-teams'}\n` +
    `  - 💬 **Helpdesk & Support:** ${syncResult.channelIds?.tournamentHelpdeskId ? `<#${syncResult.channelIds.tournamentHelpdeskId}>` : '#tournament-helpdesk'}\n` +
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
