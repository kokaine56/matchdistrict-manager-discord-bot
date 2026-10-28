import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import http from 'http';
import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';

import {
  isOfficialGuild,
  checkTournamentAccess,
  isValidDiscordSnowflake,
  sanitizeChannelName,
  sanitizeCategoryName,
  formatTournamentListPages,
  buildTournamentSelectMenu,
  formatTeamsChannelRoster,
  fetchTournamentsFromBackend,
  fetchTournamentRegistrationsFromBackend,
  handleListTournamentCommand,
  handleFetchTeamsCommand,
  syncTournamentDiscordChannels,
  formatSyncSummaryMessage,
  guildTournamentSessions,
  REQUIRED_TOURNAMENT_CHANNELS,
} from '../tournamentService.js';
import {
  guildSettingsCache,
  saveGuildSettings,
} from '../index.js';

// --- MOCK BUILDERS ---

function createMockGuild(id = 'official-guild-12345', name = 'MatchDistrict Official') {
  const channelsMap = new Map();
  channelsMap.filter = (fn) => {
    const res = new Map();
    for (const [k, v] of channelsMap.entries()) {
      if (fn(v, k, channelsMap)) res.set(k, v);
    }
    return res;
  };
  let channelIdCounter = 1;

  const guild = {
    id,
    name,
    roles: {
      everyone: { id: id, name: '@everyone' },
    },
    channels: {
      cache: channelsMap,
      fetch: async (channelId) => channelsMap.get(channelId) || null,
      create: async (data) => {
        const newId = `ch-${channelIdCounter++}`;
        const overwritesMap = new Map();

        if (Array.isArray(data.permissionOverwrites)) {
          for (const ow of data.permissionOverwrites) {
            overwritesMap.set(ow.id, {
              id: ow.id,
              allow: Array.isArray(ow.allow) ? ow.allow : [],
              deny: Array.isArray(ow.deny) ? ow.deny : [],
            });
          }
        }

        const sentMessages = [];
        const channel = {
          id: newId,
          name: data.name,
          type: data.type,
          parentId: data.parent || null,
          topic: data.topic || null,
          sentMessages,
          send: async (msg) => {
            const m = typeof msg === 'object' ? msg : { content: msg };
            sentMessages.push(m);
            return m;
          },
          delete: async () => {
            channelsMap.delete(newId);
            return channel;
          },
          permissionOverwrites: {
            cache: overwritesMap,
            edit: async (targetId, permissions) => {
              overwritesMap.set(targetId, {
                id: targetId,
                allow: Object.entries(permissions).filter(([k, v]) => v === true).map(([k]) => k),
                deny: Object.entries(permissions).filter(([k, v]) => v === false).map(([k]) => k),
              });
              return channel;
            },
            delete: async (targetId) => {
              overwritesMap.delete(targetId);
              return channel;
            },
          },
        };

        channelsMap.set(newId, channel);
        return channel;
      },
    },
    members: {
      me: {
        id: 'bot-user-999',
        permissions: {
          has: (perm) => true,
        },
      },
    },
  };

  return guild;
}

function createMockMember(options = {}) {
  const {
    id = 'user-admin-1',
    isAdmin = true,
  } = options;

  return {
    id,
    permissions: {
      has: (perm) => {
        if (!isAdmin) return false;
        return (
          perm === PermissionFlagsBits.Administrator ||
          perm === PermissionFlagsBits.ManageGuild
        );
      },
    },
  };
}

describe('MatchDistrict Discord Bot Tournament Integration', () => {
  const OFFICIAL_GUILD_ID = 'matchdistrict-official-guild-777';
  let originalGuildId;
  let originalBotSecret;
  let originalApiUrl;

  beforeEach(() => {
    originalGuildId = process.env.MATCHDISTRICT_GUILD_ID;
    originalBotSecret = process.env.MATCHDISTRICT_BOT_SECRET;
    originalApiUrl = process.env.MATCHDISTRICT_API_URL;

    process.env.MATCHDISTRICT_GUILD_ID = OFFICIAL_GUILD_ID;
    process.env.MATCHDISTRICT_BOT_SECRET = 'test-bot-secret-key-123';
    guildTournamentSessions.clear();
  });

  afterEach(() => {
    process.env.MATCHDISTRICT_GUILD_ID = originalGuildId;
    process.env.MATCHDISTRICT_BOT_SECRET = originalBotSecret;
    process.env.MATCHDISTRICT_API_URL = originalApiUrl;
  });

  // --- Requirement 1: Official Server Restriction ---

  test('1. Official Server Restriction: rejects DM invocations', () => {
    const member = createMockMember({ isAdmin: true });
    const access = checkTournamentAccess(null, member);
    assert.equal(access.allowed, false);
    assert.match(access.reason, /Direct Messages/i);
  });

  test('1. Official Server Restriction: rejects when MATCHDISTRICT_GUILD_ID is unset', () => {
    delete process.env.MATCHDISTRICT_GUILD_ID;
    const guild = createMockGuild('any-guild');
    const member = createMockMember({ isAdmin: true });
    const access = checkTournamentAccess(guild, member);
    assert.equal(access.allowed, false);
    assert.match(access.reason, /MATCHDISTRICT_GUILD_ID/i);
  });

  test('1. Official Server Restriction: rejects commands executed in unauthorized servers', () => {
    const unauthorizedGuild = createMockGuild('unauthorized-guild-999');
    const member = createMockMember({ isAdmin: true });
    const access = checkTournamentAccess(unauthorizedGuild, member);
    assert.equal(access.allowed, false);
    assert.match(access.reason, /restricted exclusively to the official MatchDistrict Discord server/i);
  });

  test('1. Official Server Restriction: rejects non-administrators even in official server', () => {
    const officialGuild = createMockGuild(OFFICIAL_GUILD_ID);
    const regularMember = createMockMember({ isAdmin: false });
    const access = checkTournamentAccess(officialGuild, regularMember);
    assert.equal(access.allowed, false);
    assert.match(access.reason, /Administrator/i);
  });

  test('1. Official Server Restriction: permits authorized administrators in official server', () => {
    const officialGuild = createMockGuild(OFFICIAL_GUILD_ID);
    const adminMember = createMockMember({ isAdmin: true });
    const access = checkTournamentAccess(officialGuild, adminMember);
    assert.equal(access.allowed, true);
  });

  // --- Requirement 2: Utilities & Validation ---

  test('2. Snowflake validation & Channel sanitization', () => {
    assert.equal(isValidDiscordSnowflake('123456789012345678'), true);
    assert.equal(isValidDiscordSnowflake('9876543210987654321'), true);
    assert.equal(isValidDiscordSnowflake('abc'), false);
    assert.equal(isValidDiscordSnowflake('12345'), false); // Too short for snowflake
    assert.equal(isValidDiscordSnowflake(''), false);
    assert.equal(isValidDiscordSnowflake(null), false);

    assert.equal(sanitizeChannelName('Team Alpha'), 'team-alpha');
    assert.equal(sanitizeChannelName('PRO $CR!MS #1'), 'pro-cr-ms-1');
    assert.match(sanitizeCategoryName('BGMI Pro League'), /🏆 \| BGMI Pro League/);
  });

  // --- Requirement 2: .list tournament formatting & pagination ---

  test('3. .list tournament: formats pagination and distinguishes registration vs publication status', () => {
    const mockTournaments = [
      {
        id: 'tour-1',
        title: 'BGMI Championship',
        game: 'BGMI',
        status: 'published',
        is_draft: false,
        registration_status: 'open',
        slots_total: 100,
        slots_filled: 25,
      },
      {
        id: 'tour-2',
        title: 'Valorant Cup Draft',
        game: 'Valorant',
        status: 'draft',
        is_draft: true,
        registration_status: 'upcoming',
        slots_total: 32,
        slots_filled: 0,
      },
    ];

    const pages = formatTournamentListPages(mockTournaments, { page: 1, pageSize: 5, showAll: true });
    assert.equal(pages.length, 1);
    const content = pages[0];

    assert.match(content, /BGMI Championship/);
    assert.match(content, /Tournament ID:\*\* `tour-1`/);
    assert.match(content, /Publication:\*\* 📢 PUBLISHED/);
    assert.match(content, /Registration:\*\* 🟢 Open \(25\/100/);

    assert.match(content, /Valorant Cup Draft/);
    assert.match(content, /Publication:\*\* 📝 Draft/);
    assert.match(content, /Registration:\*\* ⏳ Upcoming/);
  });

  test('4. .list tournament: handles empty tournament list gracefully', () => {
    const pages = formatTournamentListPages([], { page: 1 });
    assert.equal(pages.length, 1);
    assert.match(pages[0], /No Tournaments Found/);
    assert.match(pages[0], /\.list tournament all/);
  });

  test('5. .list tournament: generates interactive Select Menu for up to 25 tournaments', () => {
    const mockTournaments = [
      { id: 'tour-a', title: 'Tournament A', game: 'BGMI', registration_status: 'open' },
      { id: 'tour-b', title: 'Tournament B', game: 'Free Fire', registration_status: 'closed' },
    ];
    const selectRow = buildTournamentSelectMenu(mockTournaments);
    assert.ok(selectRow);
    assert.equal(selectRow.components.length, 1);
    const menu = selectRow.components[0];
    assert.equal(menu.data.custom_id, 'md_select_tournament');
    assert.equal(menu.options.length, 2);
    assert.equal(menu.options[0].data.value, 'tour-a');
    assert.equal(menu.options[1].data.value, 'tour-b');
  });

  // --- Requirement 3 & 7: Backend API Client & Error Handling ---

  test('6. Backend API Client: fetchTournaments handles successful responses', async () => {
    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      assert.equal(url.pathname, '/api/bot/tournaments');
      assert.equal(req.headers['x-bot-secret'], 'test-bot-secret-key-123');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: 1,
        tournaments: [
          {
            id: 'tour-mock-1',
            title: 'Mock BGMI Battle',
            game: 'BGMI',
            status: 'published',
            registration_status: 'open',
          },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;

    try {
      const tournaments = await fetchTournamentsFromBackend({
        apiUrl: `http://127.0.0.1:${port}`,
        secret: 'test-bot-secret-key-123',
      });
      assert.equal(tournaments.length, 1);
      assert.equal(tournaments[0].id, 'tour-mock-1');
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('7. Backend API Client: handles 401 Unauthorized securely without token leakage', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'UNAUTHORIZED' }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;

    try {
      await assert.rejects(
        fetchTournamentsFromBackend({
          apiUrl: `http://127.0.0.1:${port}`,
          secret: 'wrong-secret',
        }),
        /Backend authorization failed/
      );
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  // --- Requirement 3, 4, 5, 6: .fetch teams, 4 Channels & Access Control ---

  test('8. .fetch teams: rejects when multiple tournaments exist and no tournament ID is specified outside tournament channel', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const member = createMockMember({ isAdmin: true });

    guildTournamentSessions.set(guild.id, {
      lastTournaments: [
        { id: 'tour-1', title: 'Tour 1' },
        { id: 'tour-2', title: 'Tour 2' },
      ],
      lastListedTournamentId: null,
      timestamp: Date.now(),
    });

    let repliedText = '';
    await handleFetchTeamsCommand(guild, member, [], async (msg) => {
      repliedText = typeof msg === 'object' ? msg.content : msg;
    });

    assert.match(repliedText, /Multiple Tournaments Available/);
    assert.match(repliedText, /\.fetch teams <tournament_id>/);
  });

  test('9. .fetch teams: rejects when bot lacks Manage Channels permission', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    guild.members.me.permissions.has = () => false;
    const member = createMockMember({ isAdmin: true });

    let repliedText = '';
    await handleFetchTeamsCommand(guild, member, ['tour-xyz'], async (msg) => {
      repliedText = typeof msg === 'object' ? msg.content : msg;
    });

    assert.match(repliedText, /Missing Bot Permissions/);
    assert.match(repliedText, /Manage Channels/);
  });

  test('10. Four Channels Architecture: creates 1 category and exactly the 4 required channels without per-squad channels', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-sync-1',
      title: 'BGMI Super League',
      status: 'published',
    };

    const mockTeams = [
      {
        id: 'team-1',
        team_name: 'GodLike',
        status: 'approved',
        is_eligible: true,
        linked_members: [
          { discord_id: '111111111111111111', is_linked: true },
          { discord_id: '222222222222222222', is_linked: true },
        ],
        unlinked_count: 0,
      },
      {
        id: 'team-2',
        team_name: 'Soul Esports',
        status: 'confirmed',
        is_eligible: true,
        linked_members: [
          { discord_id: '333333333333333333', is_linked: true },
        ],
        unlinked_count: 1,
      },
      {
        id: 'team-3',
        team_name: 'Rejected Team',
        status: 'rejected',
        is_eligible: false,
        linked_members: [
          { discord_id: '444444444444444444', is_linked: true },
        ],
        unlinked_count: 0,
      },
    ];

    const result = await syncTournamentDiscordChannels(guild, mockTournament, mockTeams, botMember);

    assert.equal(result.categoryAction, 'created');
    assert.ok(result.categoryId);

    // Verify exactly 4 channels were created
    assert.equal(result.channelsCreated.length, 4);
    assert.deepEqual(result.channelsCreated, [
      'bot-commands',
      'tournament-update',
      'tournament-teams',
      'tournament-helpdesk',
    ]);

    // Verify NO squad channels exist (e.g. team-godlike or team-soul-esports)
    const allChannelNames = Array.from(guild.channels.cache.values()).map((c) => c.name);
    assert.equal(allChannelNames.some((n) => n.startsWith('team-')), false);

    // Verify Category
    const categoryChannel = guild.channels.cache.get(result.categoryId);
    assert.equal(categoryChannel.type, ChannelType.GuildCategory);
    assert.match(categoryChannel.name, /BGMI Super League/);
    const catEveryoneOw = categoryChannel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(catEveryoneOw.deny.includes(PermissionFlagsBits.ViewChannel));

    // A. #bot-commands: Admin only; participants CANNOT view
    const botCmdCh = guild.channels.cache.get(result.channelIds.botCommandsId);
    assert.ok(botCmdCh);
    assert.equal(botCmdCh.parentId, result.categoryId);
    const botCmdEveryoneOw = botCmdCh.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(botCmdEveryoneOw.deny.includes(PermissionFlagsBits.ViewChannel));
    // Participants have NO overwrite to view bot-commands
    assert.equal(botCmdCh.permissionOverwrites.cache.has('111111111111111111'), false);
    assert.equal(botCmdCh.permissionOverwrites.cache.has('222222222222222222'), false);

    // B. #tournament-update: Eligible participants can read; CANNOT post
    const updateCh = guild.channels.cache.get(result.channelIds.tournamentUpdateId);
    assert.ok(updateCh);
    assert.equal(updateCh.parentId, result.categoryId);
    const updateOw1 = updateCh.permissionOverwrites.cache.get('111111111111111111');
    assert.ok(updateOw1);
    assert.ok(updateOw1.allow.includes('ViewChannel'));
    assert.ok(updateOw1.deny.includes('SendMessages'));
    assert.ok(updateOw1.deny.includes('CreatePublicThreads'));

    // C. #tournament-teams: Eligible participants can read; CANNOT post; contains published roster
    const teamsCh = guild.channels.cache.get(result.channelIds.tournamentTeamsId);
    assert.ok(teamsCh);
    assert.equal(teamsCh.parentId, result.categoryId);
    const teamsOw1 = teamsCh.permissionOverwrites.cache.get('111111111111111111');
    assert.ok(teamsOw1);
    assert.ok(teamsOw1.allow.includes('ViewChannel'));
    assert.ok(teamsOw1.deny.includes('SendMessages'));
    // Ineligible member 444444444444444444 must NOT have access
    assert.equal(teamsCh.permissionOverwrites.cache.has('444444444444444444'), false);
    // Verified teams roster was published to teamsCh
    assert.equal(result.teamsUpdatedInChannel, true);
    assert.ok(teamsCh.sentMessages.length > 0);
    assert.match(teamsCh.sentMessages[0].content, /GodLike/);
    assert.match(teamsCh.sentMessages[0].content, /Soul Esports/);

    // D. #tournament-helpdesk: Eligible participants CAN post messages
    const helpdeskCh = guild.channels.cache.get(result.channelIds.tournamentHelpdeskId);
    assert.ok(helpdeskCh);
    assert.equal(helpdeskCh.parentId, result.categoryId);
    const helpdeskOw1 = helpdeskCh.permissionOverwrites.cache.get('111111111111111111');
    assert.ok(helpdeskOw1);
    assert.ok(helpdeskOw1.allow.includes('ViewChannel'));
    assert.ok(helpdeskOw1.allow.includes('SendMessages'));
    assert.ok(helpdeskOw1.allow.includes('AttachFiles'));

    // Verify persistent storage
    const saved = guildSettingsCache[guild.id]?.tournaments?.[mockTournament.id];
    assert.ok(saved);
    assert.equal(saved.categoryId, result.categoryId);
    assert.equal(saved.channels.botCommandsId, result.channelIds.botCommandsId);
    assert.equal(saved.channels.tournamentUpdateId, result.channelIds.tournamentUpdateId);
    assert.equal(saved.channels.tournamentTeamsId, result.channelIds.tournamentTeamsId);
    assert.equal(saved.channels.tournamentHelpdeskId, result.channelIds.tournamentHelpdeskId);
  });

  test('11. Channel Reuse: reuses existing category and all 4 channels without creating duplicates', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-reuse-2',
      title: 'Valorant Invitational',
      status: 'published',
    };

    const initialTeams = [
      {
        id: 'team-a',
        team_name: 'Team Alpha',
        status: 'approved',
        is_eligible: true,
        linked_members: [{ discord_id: '111111111111111111', is_linked: true }],
        unlinked_count: 0,
      },
    ];

    // First run
    const firstSync = await syncTournamentDiscordChannels(guild, mockTournament, initialTeams, botMember);
    assert.equal(firstSync.categoryAction, 'created');
    assert.equal(firstSync.channelsCreated.length, 4);

    // Second run
    const secondSync = await syncTournamentDiscordChannels(guild, mockTournament, initialTeams, botMember);
    assert.equal(secondSync.categoryAction, 'reused');
    assert.equal(secondSync.categoryId, firstSync.categoryId);
    assert.equal(secondSync.channelsCreated.length, 0);
    assert.equal(secondSync.channelsReused.length, 4);
    assert.deepEqual(secondSync.channelIds, firstSync.channelIds);
  });

  test('12. Ineligibility Revocation: removes participant channel access when a team/user becomes ineligible', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-revoke-3',
      title: 'Apex Legends Cup',
      status: 'published',
    };

    const initialTeams = [
      {
        id: 'team-x',
        team_name: 'Team X',
        status: 'approved',
        is_eligible: true,
        linked_members: [{ discord_id: '111111111111111111', is_linked: true }],
        unlinked_count: 0,
      },
    ];

    const firstSync = await syncTournamentDiscordChannels(guild, mockTournament, initialTeams, botMember);
    const updateCh = guild.channels.cache.get(firstSync.channelIds.tournamentUpdateId);
    const helpdeskCh = guild.channels.cache.get(firstSync.channelIds.tournamentHelpdeskId);

    assert.ok(updateCh.permissionOverwrites.cache.has('111111111111111111'));
    assert.ok(helpdeskCh.permissionOverwrites.cache.has('111111111111111111'));

    // Second sync: Team X cancelled/disqualified -> user is no longer eligible
    const revokedTeams = [
      {
        id: 'team-x',
        team_name: 'Team X',
        status: 'cancelled',
        is_eligible: false,
        linked_members: [{ discord_id: '111111111111111111', is_linked: true }],
        unlinked_count: 0,
      },
    ];

    const secondSync = await syncTournamentDiscordChannels(guild, mockTournament, revokedTeams, botMember);
    assert.ok(secondSync.permissionsRemoved > 0);

    // Permissions on update and helpdesk channels must be removed!
    assert.equal(updateCh.permissionOverwrites.cache.has('111111111111111111'), false);
    assert.equal(helpdeskCh.permissionOverwrites.cache.has('111111111111111111'), false);
  });

  test('13. Migration & Obsolete Squad Channel Cleanup: deletes legacy per-squad channels safely', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-legacy-mig',
      title: 'Legacy Migration Cup',
      status: 'published',
    };

    // Pre-create category and an obsolete squad channel
    const category = await guild.channels.create({
      name: '🏆 | Legacy Migration Cup',
      type: ChannelType.GuildCategory,
    });

    const obsoleteSquadChannel = await guild.channels.create({
      name: 'team-old-squad',
      type: ChannelType.GuildText,
      parent: category.id,
    });

    const unrelatedChannel = await guild.channels.create({
      name: 'general-chat',
      type: ChannelType.GuildText,
    });

    // Seed guildSettingsCache with legacy teamChannels state
    guildSettingsCache[guild.id] = {
      tournaments: {
        'tour-legacy-mig': {
          categoryId: category.id,
          teamChannels: {
            'old-squad': obsoleteSquadChannel.id,
          },
        },
      },
    };

    const syncResult = await syncTournamentDiscordChannels(guild, mockTournament, [], botMember);

    // Obsolete squad channel deleted
    assert.equal(syncResult.obsoleteSquadChannelsDeleted, 1);
    assert.equal(guild.channels.cache.has(obsoleteSquadChannel.id), false);
    // Unrelated channel preserved
    assert.equal(guild.channels.cache.has(unrelatedChannel.id), true);
    // 4 shared tournament channels created
    assert.equal(syncResult.channelsCreated.length, 4);
  });

  test('14. Context Resolution: .fetch teams resolves tournament ID automatically when run inside #bot-commands', async () => {
    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      assert.match(url.pathname, /\/api\/bot\/tournaments\/tour-auto-ctx\/registrations/);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: {
          id: 'tour-auto-ctx',
          title: 'Context Resolution League',
          status: 'published',
        },
        summary: {
          total_registered_teams: 1,
          eligible_teams_count: 1,
          ineligible_teams_count: 0,
          eligible_linked_members_count: 1,
          unlinked_members_count: 0,
        },
        teams: [
          {
            id: 'team-1',
            team_name: 'Context Squad',
            status: 'approved',
            is_eligible: true,
            linked_members: [{ discord_id: '123456789012345678', is_linked: true }],
            unlinked_count: 0,
          },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const adminMember = createMockMember({ isAdmin: true });

      // Create a mock bot-commands channel and register it in guild settings
      const botCmdChannel = await guild.channels.create({
        name: 'bot-commands',
        type: ChannelType.GuildText,
      });

      guildSettingsCache[guild.id] = {
        tournaments: {
          'tour-auto-ctx': {
            channels: {
              botCommandsId: botCmdChannel.id,
            },
          },
        },
      };

      let replyOutput = '';
      // Run .fetch teams with NO arguments inside the tournament's bot-commands channel
      await handleFetchTeamsCommand(guild, adminMember, [], async (msg) => {
        replyOutput = typeof msg === 'object' ? msg.content : msg;
      }, botCmdChannel);

      assert.match(replyOutput, /Tournament Synchronization Complete/);
      assert.match(replyOutput, /Context Resolution League/);
      assert.match(replyOutput, /tour-auto-ctx/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('15. Sync Summary: formats accurate 4-channel report', () => {
    const tournament = { id: 'tour-sum-1', title: 'Free Fire Open', status: 'published' };
    const summary = {
      total_registered_teams: 16,
      eligible_teams_count: 14,
      ineligible_teams_count: 2,
      eligible_linked_members_count: 48,
      unlinked_members_count: 8,
      duplicate_discord_ids_count: 1,
    };
    const syncResult = {
      categoryAction: 'created',
      categoryId: 'cat-123',
      channelsCreated: ['bot-commands', 'tournament-update', 'tournament-teams', 'tournament-helpdesk'],
      channelsReused: [],
      channelIds: {
        botCommandsId: 'ch-1',
        tournamentUpdateId: 'ch-2',
        tournamentTeamsId: 'ch-3',
        tournamentHelpdeskId: 'ch-4',
      },
      teamsUpdatedInChannel: true,
      permissionsUpdated: 48,
      permissionsRemoved: 0,
      obsoleteSquadChannelsDeleted: 0,
      failures: [],
    };

    const message = formatSyncSummaryMessage(tournament, summary, syncResult);
    assert.match(message, /Tournament Synchronization Complete/);
    assert.match(message, /Free Fire Open/);
    assert.match(message, /Four Shared Channels/);
    assert.match(message, /Bot Commands \(Admin Only\):/);
    assert.match(message, /Announcements & Updates:/);
    assert.match(message, /Registered Teams Roster:/);
    assert.match(message, /Helpdesk & Support:/);
    assert.match(message, /Published to #tournament-teams/);
  });
});
