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
    `• To fetch teams and sync Discord channels: \`.fetch teams <tournament_id>\`\n` +
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
      .setPlaceholder('Select a tournament to fetch teams & sync channels...')
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
 */
export async function handleFetchTeamsCommand(guild, member, args = [], replyFn) {
  const access = checkTournamentAccess(guild, member);
  if (!access.allowed) {
    await replyFn(access.reason);
    return;
  }

  // 1. Identify tournament ID from arguments or guild session
  let tournamentId = (args[0] || '').trim();
  if (tournamentId.toLowerCase() === 'teams' || tournamentId.toLowerCase() === 'team') {
    tournamentId = (args[1] || '').trim();
  }

  if (!tournamentId) {
    const session = guildTournamentSessions.get(guild.id);
    if (session && session.lastListedTournamentId) {
      tournamentId = session.lastListedTournamentId;
    } else if (session && Array.isArray(session.lastTournaments) && session.lastTournaments.length > 1) {
      await replyFn(
        `⚠️ **Multiple Tournaments Available:**\n` +
        `Please specify the target tournament ID:\n` +
        `> \`.fetch teams <tournament_id>\`\n\n` +
        `*(Run \`.list tournament\` to view all tournament IDs)*`
      );
      return;
    } else {
      await replyFn(
        `⚠️ **Missing Tournament ID:**\n` +
        `Please provide a tournament ID to fetch registrations:\n` +
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
      '❌ **Missing Bot Permissions:** The bot requires the **Manage Channels** permission in this server to create tournament categories and team channels.'
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

  // Synchronize category, channels, and member permissions
  const syncResult = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);

  // Format final summary report
  const summaryMessage = formatSyncSummaryMessage(tournament, summary, syncResult);
  await replyFn(summaryMessage);
}

/**
 * Synchronize tournament Discord category, general channel, and team channels.
 * Reuses existing category & channels mapped to tournament ID in persistent storage.
 */
export async function syncTournamentDiscordChannels(guild, tournament, teams = [], botMember) {
  const tournamentId = tournament.id;
  const currentSettings = guildSettingsCache[guild.id] || {};
  if (!currentSettings.tournaments) {
    currentSettings.tournaments = {};
  }
  const savedTournament = currentSettings.tournaments[tournamentId] || {
    categoryId: null,
    generalChannelId: null,
    teamChannels: {},
    allEligibleMemberIds: [],
  };

  const syncResult = {
    categoryAction: 'none', // created, reused, failed
    categoryId: null,
    generalChannelAction: 'none', // created, reused, failed
    generalChannelId: null,
    teamChannelsCreated: 0,
    teamChannelsReused: 0,
    permissionsUpdated: 0,
    permissionsRemoved: 0,
    skippedTeams: [],
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
    // Create new category
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

  // 2. Locate or create General Text Channel
  let generalChannel = null;
  if (savedTournament.generalChannelId) {
    generalChannel = guild.channels.cache.get(savedTournament.generalChannelId) ||
      await guild.channels.fetch(savedTournament.generalChannelId).catch(() => null);
  }

  if (generalChannel && generalChannel.parentId === category.id) {
    syncResult.generalChannelAction = 'reused';
    syncResult.generalChannelId = generalChannel.id;
  } else {
    try {
      generalChannel = await guild.channels.create({
        name: '📢-announcements',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Official announcements & general information for ${tournament.title} (ID: ${tournamentId})`,
        permissionOverwrites: [
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
        ],
      });
      syncResult.generalChannelAction = 'created';
      syncResult.generalChannelId = generalChannel.id;
      savedTournament.generalChannelId = generalChannel.id;
    } catch (err) {
      syncResult.generalChannelAction = 'failed';
      syncResult.failures.push(`Failed to create general channel: ${err.message}`);
    }
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

  // 4. Synchronize General Channel Permissions (grant access to all eligible participants, revoke for removed)
  if (generalChannel) {
    const previousMemberIds = new Set(savedTournament.allEligibleMemberIds || []);

    // Grant access to new eligible members
    for (const discordId of currentEligibleMemberIds) {
      try {
        await generalChannel.permissionOverwrites.edit(discordId, {
          ViewChannel: true,
          ReadMessageHistory: true,
        });
        syncResult.permissionsUpdated++;
      } catch (err) {
        // Individual permission overwrite failure (e.g. member left guild or invalid)
        syncResult.failures.push(`General channel permission error for user ${discordId}: ${err.message}`);
      }
    }

    // Revoke access for members who are no longer eligible
    for (const oldId of previousMemberIds) {
      if (!currentEligibleMemberIds.has(oldId)) {
        try {
          await generalChannel.permissionOverwrites.delete(oldId);
          syncResult.permissionsRemoved++;
        } catch {
          // Ignore if overwrite already deleted
        }
      }
    }
  }

  // 5. Synchronize Private Team Channels
  if (!savedTournament.teamChannels) {
    savedTournament.teamChannels = {};
  }

  for (const team of eligibleTeams) {
    const teamKey = team.id || sanitizeChannelName(team.team_name);
    const channelName = sanitizeChannelName(team.team_name, 'team-');
    const existingChannelId = savedTournament.teamChannels[teamKey];

    let teamChannel = null;
    if (existingChannelId) {
      teamChannel = guild.channels.cache.get(existingChannelId) ||
        await guild.channels.fetch(existingChannelId).catch(() => null);
    }

    // Get valid linked Discord members for this team
    const teamLinkedDiscordIds = (team.linked_members || [])
      .map((m) => m.discord_id)
      .filter(isValidDiscordSnowflake);

    if (teamChannel && teamChannel.parentId === category.id) {
      syncResult.teamChannelsReused++;
      // Update permissions on reused team channel
      for (const discordId of teamLinkedDiscordIds) {
        try {
          await teamChannel.permissionOverwrites.edit(discordId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
          });
          syncResult.permissionsUpdated++;
        } catch (err) {
          syncResult.failures.push(`Permission error on #${teamChannel.name} for ${discordId}: ${err.message}`);
        }
      }
    } else {
      // Check category channel limit (Discord limit: 50 channels per category)
      let currentCategoryChannelCount = 0;
      if (typeof guild.channels.cache?.filter === 'function') {
        currentCategoryChannelCount = guild.channels.cache.filter((c) => c.parentId === category.id).size;
      } else if (guild.channels.cache?.values) {
        for (const c of guild.channels.cache.values()) {
          if (c.parentId === category.id) currentCategoryChannelCount++;
        }
      }
      if (currentCategoryChannelCount >= 50) {
        syncResult.skippedTeams.push({
          teamName: team.team_name,
          reason: 'Discord category limit of 50 channels reached.',
        });
        continue;
      }

      try {
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

        for (const discordId of teamLinkedDiscordIds) {
          overwrites.push({
            id: discordId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
            ],
          });
        }

        teamChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `Private team channel for ${team.team_name} — ${tournament.title}`,
          permissionOverwrites: overwrites,
        });

        syncResult.teamChannelsCreated++;
        savedTournament.teamChannels[teamKey] = teamChannel.id;
      } catch (err) {
        syncResult.failures.push(`Failed to create channel for team "${team.team_name}": ${err.message}`);
      }
    }
  }

  // 6. Persist association to guild settings
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
  const isPartial = syncResult.failures.length > 0 || syncResult.skippedTeams.length > 0;
  const statusEmoji = isPartial ? '⚠️' : '✅';
  const statusTitle = isPartial
    ? '**Tournament Synchronization Completed with Warnings**'
    : '**Tournament Synchronization Complete**';

  const catActionText = syncResult.categoryAction === 'created'
    ? `Created (<#${syncResult.categoryId}>)`
    : syncResult.categoryAction === 'reused'
      ? `Reused (<#${syncResult.categoryId}>)`
      : 'Failed';

  const genActionText = syncResult.generalChannelAction === 'created'
    ? `Created (<#${syncResult.generalChannelId}>)`
    : syncResult.generalChannelAction === 'reused'
      ? `Reused (<#${syncResult.generalChannelId}>)`
      : 'Failed';

  let msg = `${statusEmoji} ${statusTitle}\n\n` +
    `• 🏆 **Tournament:** **${tournament.title}** (ID: \`${tournament.id}\`)\n` +
    `• 🎮 **Status:** ${tournament.status?.toUpperCase() || 'PUBLISHED'}\n` +
    `• 👥 **Registered Teams:** **${summary.total_registered_teams}** total (` +
    `🟢 **${summary.eligible_teams_count}** eligible, 🔴 **${summary.ineligible_teams_count}** ineligible/rejected)\n` +
    `• 🔗 **Eligible Linked Discord Members:** **${summary.eligible_linked_members_count}** participant(s) granted channel access\n` +
    `• ⚠️ **Unlinked Participants:** **${summary.unlinked_members_count}** account(s) not linked to Discord on website\n` +
    `• 🛡️ **Duplicate Discord IDs:** **${summary.duplicate_discord_ids_count || 0}** safely deduplicated\n\n` +
    `📁 **Discord Category & Channels:**\n` +
    `• **Category:** ${catActionText}\n` +
    `• **General Announcements:** ${genActionText}\n` +
    `• **Team Channels:** **${syncResult.teamChannelsCreated}** created, **${syncResult.teamChannelsReused}** reused\n` +
    `• **Permission Overwrites:** **${syncResult.permissionsUpdated}** applied, **${syncResult.permissionsRemoved}** removed\n`;

  if (syncResult.skippedTeams.length > 0) {
    msg += `\n⚠️ **Skipped Teams (${syncResult.skippedTeams.length}):**\n`;
    for (const st of syncResult.skippedTeams.slice(0, 5)) {
      msg += `  • *${st.teamName}:* ${st.reason}\n`;
    }
    if (syncResult.skippedTeams.length > 5) {
      msg += `  • ...and ${syncResult.skippedTeams.length - 5} more\n`;
    }
  }

  if (syncResult.failures.length > 0) {
    msg += `\n⚠️ **Warnings & Notice:**\n`;
    for (const f of syncResult.failures.slice(0, 5)) {
      msg += `  • ${f}\n`;
    }
    if (syncResult.failures.length > 5) {
      msg += `  • ...and ${syncResult.failures.length - 5} more\n`;
    }
    msg += `\n*You can safely re-run \`.fetch teams ${tournament.id}\` to retry partial channel creations.*`;
  }

  return msg;
}
