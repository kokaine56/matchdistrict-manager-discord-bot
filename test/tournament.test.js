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
  fetchTournamentsFromBackend,
  fetchTournamentRegistrationsFromBackend,
  handleListTournamentCommand,
  handleFetchTeamsCommand,
  syncTournamentDiscordChannels,
  formatSyncSummaryMessage,
  guildTournamentSessions,
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

        const channel = {
          id: newId,
          name: data.name,
          type: data.type,
          parentId: data.parent || null,
          topic: data.topic || null,
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
    assert.equal(sanitizeChannelName('Team Beta', 'team-'), 'team-team-beta');
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
    // Start local mock HTTP server
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

  // --- Requirement 3, 4, 5, 6: .fetch teams, validation & channel synchronization ---

  test('8. .fetch teams: rejects when multiple tournaments exist and no tournament ID is specified', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const member = createMockMember({ isAdmin: true });

    // Seed session with multiple tournaments
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
    guild.members.me.permissions.has = () => false; // Missing permission
    const member = createMockMember({ isAdmin: true });

    let repliedText = '';
    await handleFetchTeamsCommand(guild, member, ['tour-xyz'], async (msg) => {
      repliedText = typeof msg === 'object' ? msg.content : msg;
    });

    assert.match(repliedText, /Missing Bot Permissions/);
    assert.match(repliedText, /Manage Channels/);
  });

  test('10. Channel Synchronization: creates category, general announcements, and private team channels', async () => {
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
        unlinked_count: 1, // 1 unlinked member
      },
      {
        id: 'team-3',
        team_name: 'Rejected Team',
        status: 'rejected',
        is_eligible: false, // Ineligible -> must NOT get channel
        linked_members: [
          { discord_id: '444444444444444444', is_linked: true },
        ],
        unlinked_count: 0,
      },
    ];

    const result = await syncTournamentDiscordChannels(guild, mockTournament, mockTeams, botMember);

    assert.equal(result.categoryAction, 'created');
    assert.ok(result.categoryId);
    assert.equal(result.generalChannelAction, 'created');
    assert.ok(result.generalChannelId);
    assert.equal(result.teamChannelsCreated, 2); // GodLike & Soul Esports
    assert.equal(result.teamChannelsReused, 0);

    // Verify Category Overwrites (@everyone denied, bot allowed)
    const categoryChannel = guild.channels.cache.get(result.categoryId);
    assert.equal(categoryChannel.type, ChannelType.GuildCategory);
    assert.match(categoryChannel.name, /BGMI Super League/);
    const catEveryoneOw = categoryChannel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(catEveryoneOw.deny.includes(PermissionFlagsBits.ViewChannel));

    // Verify General Announcements Channel
    const generalChannel = guild.channels.cache.get(result.generalChannelId);
    assert.equal(generalChannel.parentId, result.categoryId);
    // Linked members from all eligible teams have ViewChannel on general channel
    assert.ok(generalChannel.permissionOverwrites.cache.has('111111111111111111'));
    assert.ok(generalChannel.permissionOverwrites.cache.has('222222222222222222'));
    assert.ok(generalChannel.permissionOverwrites.cache.has('333333333333333333'));
    // Ineligible team member (444444444444444444) MUST NOT have access
    assert.equal(generalChannel.permissionOverwrites.cache.has('444444444444444444'), false);

    // Verify Team Channel 1 (GodLike)
    const godlikeChannel = Array.from(guild.channels.cache.values()).find((c) => c.name === 'team-godlike');
    assert.ok(godlikeChannel);
    assert.equal(godlikeChannel.parentId, result.categoryId);
    // GodLike members have access
    assert.ok(godlikeChannel.permissionOverwrites.cache.has('111111111111111111'));
    assert.ok(godlikeChannel.permissionOverwrites.cache.has('222222222222222222'));
    // Member from Soul Esports (333333333333333333) MUST NOT have access to GodLike's channel!
    assert.equal(godlikeChannel.permissionOverwrites.cache.has('333333333333333333'), false);

    // Verify Rejected team channel does NOT exist
    const rejectedChannel = Array.from(guild.channels.cache.values()).find((c) => c.name === 'team-rejected-team');
    assert.equal(rejectedChannel, undefined);

    // Verify persistent storage in guildSettingsCache
    const saved = guildSettingsCache[guild.id]?.tournaments?.[mockTournament.id];
    assert.ok(saved);
    assert.equal(saved.categoryId, result.categoryId);
    assert.equal(saved.generalChannelId, result.generalChannelId);
    assert.equal(Object.keys(saved.teamChannels).length, 2);
  });

  test('11. Channel Synchronization & Reuse: reuses existing category & channels on subsequent sync', async () => {
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

    // First sync
    const firstSync = await syncTournamentDiscordChannels(guild, mockTournament, initialTeams, botMember);
    assert.equal(firstSync.categoryAction, 'created');
    assert.equal(firstSync.teamChannelsCreated, 1);

    // Second sync with an additional member joining Team Alpha
    const updatedTeams = [
      {
        id: 'team-a',
        team_name: 'Team Alpha',
        status: 'approved',
        is_eligible: true,
        linked_members: [
          { discord_id: '111111111111111111', is_linked: true },
          { discord_id: '555555555555555555', is_linked: true }, // New member
        ],
        unlinked_count: 0,
      },
    ];

    const secondSync = await syncTournamentDiscordChannels(guild, mockTournament, updatedTeams, botMember);
    assert.equal(secondSync.categoryAction, 'reused');
    assert.equal(secondSync.categoryId, firstSync.categoryId);
    assert.equal(secondSync.generalChannelAction, 'reused');
    assert.equal(secondSync.teamChannelsCreated, 0);
    assert.equal(secondSync.teamChannelsReused, 1);

    // New member granted access on reused channel
    const teamChannel = guild.channels.cache.get(guildSettingsCache[guild.id].tournaments[mockTournament.id].teamChannels['team-a']);
    assert.ok(teamChannel.permissionOverwrites.cache.has('555555555555555555'));
  });

  test('12. Ineligibility & Revocation: removes channel permissions for members who become ineligible', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-revoke-3',
      title: 'Apex Legends Cup',
      status: 'published',
    };

    // Member 111111111111111111 is initially eligible
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
    const generalChannel = guild.channels.cache.get(firstSync.generalChannelId);
    assert.ok(generalChannel.permissionOverwrites.cache.has('111111111111111111'));

    // In second sync, Team X was disqualified/cancelled -> Member 111111111111111111 is now ineligible
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
    // General channel permission overwrite for 111111111111111111 has been removed!
    assert.equal(generalChannel.permissionOverwrites.cache.has('111111111111111111'), false);
  });

  test('13. Sync Summary: formats accurate, comprehensive report', () => {
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
      generalChannelAction: 'created',
      generalChannelId: 'gen-456',
      teamChannelsCreated: 14,
      teamChannelsReused: 0,
      permissionsUpdated: 48,
      permissionsRemoved: 0,
      skippedTeams: [],
      failures: [],
    };

    const message = formatSyncSummaryMessage(tournament, summary, syncResult);
    assert.match(message, /Tournament Synchronization Complete/);
    assert.match(message, /Free Fire Open/);
    assert.match(message, /Registered Teams:\*\* \*\*16\*\* total/);
    assert.match(message, /14\*\* eligible/);
    assert.match(message, /48\*\* participant\(s\) granted channel access/);
    assert.match(message, /8\*\* account\(s\) not linked to Discord/);
    assert.match(message, /Team Channels:\*\* \*\*14\*\* created/);
  });

  test('14. Partial Failure & Resilience: continues safely when a single channel creation fails', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-partial-1',
      title: 'Crash Resiliency Cup',
      status: 'published',
    };

    let failOnTeamName = 'Flaky Team';
    const originalCreate = guild.channels.create;
    guild.channels.create = async (data) => {
      if (data.name === 'team-flaky-team') {
        throw new Error('Discord rate limit reached for channel create (50035)');
      }
      return originalCreate(data);
    };

    const teams = [
      {
        id: 'team-good',
        team_name: 'Good Team',
        status: 'approved',
        is_eligible: true,
        linked_members: [{ discord_id: '111111111111111111', is_linked: true }],
        unlinked_count: 0,
      },
      {
        id: 'team-bad',
        team_name: 'Flaky Team',
        status: 'approved',
        is_eligible: true,
        linked_members: [{ discord_id: '222222222222222222', is_linked: true }],
        unlinked_count: 0,
      },
    ];

    const result = await syncTournamentDiscordChannels(guild, mockTournament, teams, botMember);
    assert.equal(result.categoryAction, 'created');
    assert.equal(result.teamChannelsCreated, 1); // Good Team succeeded
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /Flaky Team/);

    const summaryText = formatSyncSummaryMessage(mockTournament, {
      total_registered_teams: 2,
      eligible_teams_count: 2,
      ineligible_teams_count: 0,
      eligible_linked_members_count: 2,
      unlinked_members_count: 0,
    }, result);

    assert.match(summaryText, /Completed with Warnings/);
    assert.match(summaryText, /safely re-run/);
  });

  test('15. End-to-End Command Flow: handleListTournamentCommand preserves session and formats response', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: 1,
        tournaments: [
          {
            id: 'tour-e2e-1',
            title: 'BGMI Champions Trophy',
            game: 'BGMI',
            status: 'published',
            registration_status: 'open',
            slots_total: 50,
            slots_filled: 12,
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

      let output = '';
      await handleListTournamentCommand(guild, adminMember, [], async (msg) => {
        output = typeof msg === 'object' ? msg.content : msg;
      });

      assert.match(output, /BGMI Champions Trophy/);
      assert.match(output, /Tournament ID:\*\* `tour-e2e-1`/);

      // Verify session was preserved
      const session = guildTournamentSessions.get(guild.id);
      assert.ok(session);
      assert.equal(session.lastListedTournamentId, 'tour-e2e-1');
      assert.equal(session.lastTournaments.length, 1);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('16. End-to-End Command Flow: handleFetchTeamsCommand fetches registrations and syncs channels', async () => {
    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      assert.match(url.pathname, /\/api\/bot\/tournaments\/tour-e2e-1\/registrations/);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: {
          id: 'tour-e2e-1',
          title: 'BGMI Champions Trophy',
          game: 'BGMI',
          status: 'published',
        },
        summary: {
          total_registered_teams: 1,
          eligible_teams_count: 1,
          ineligible_teams_count: 0,
          eligible_linked_members_count: 1,
          unlinked_members_count: 0,
          duplicate_discord_ids_count: 0,
        },
        teams: [
          {
            id: 'team-alpha-e2e',
            team_name: 'Team Alpha',
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

      let output = '';
      await handleFetchTeamsCommand(guild, adminMember, ['tour-e2e-1'], async (msg) => {
        output = typeof msg === 'object' ? msg.content : msg;
      });

      assert.match(output, /Tournament Synchronization Complete/);
      assert.match(output, /BGMI Champions Trophy/);
      assert.match(output, /Team Channels:\*\* \*\*1\*\* created/);

      // Verify channel created in guild
      const teamChannel = Array.from(guild.channels.cache.values()).find((c) => c.name === 'team-team-alpha');
      assert.ok(teamChannel);
      assert.ok(teamChannel.permissionOverwrites.cache.has('123456789012345678'));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});
