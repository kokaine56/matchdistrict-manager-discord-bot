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
} from '../tournamentService.js';
import {
  guildSettingsCache,
  saveGuildSettings,
} from '../index.js';

// --- MOCK BUILDERS ---

function createMockGuild(id = 'official-guild-12345', name = 'MatchDistrict Official') {
  guildSettingsCache[id] = { tournaments: {} };
  const channelsMap = new Map();
  channelsMap.filter = (fn) => {
    const res = new Map();
    for (const [k, v] of channelsMap.entries()) {
      if (fn(v, k, channelsMap)) res.set(k, v);
    }
    return res;
  };
  let channelIdCounter = 1;
  let messageCounter = 1;
  let roleIdCounter = 100;

  const rolesMap = new Map();
  rolesMap.set(id, { id: id, name: '@everyone', mentionable: true });

  const membersMap = new Map();
  const botMember = {
    id: 'bot-user-999',
    user: { id: 'bot-user-999', tag: 'MatchDistrictBot#0001' },
    permissions: {
      has: (perm) => true,
    },
    roles: {
      cache: new Map(),
      highest: { comparePositionTo: () => 1 },
      add: async () => {},
      remove: async () => {},
    },
  };
  membersMap.set(botMember.id, botMember);

  const getOrCreateMember = (memberId) => {
    if (membersMap.has(memberId)) return membersMap.get(memberId);
    const memberRoles = new Map();
    const newMember = {
      id: memberId,
      guild: null,
      user: { id: memberId, tag: `User${memberId}#0001` },
      roles: {
        cache: memberRoles,
        addCalls: [],
        removeCalls: [],
        add: async (roleId, reason) => {
          newMember.roles.addCalls.push({ roleId, reason });
          const r = rolesMap.get(roleId) || { id: roleId, name: roleId };
          memberRoles.set(roleId, r);
          return newMember;
        },
        remove: async (roleId, reason) => {
          newMember.roles.removeCalls.push({ roleId, reason });
          memberRoles.delete(roleId);
          return newMember;
        },
      },
    };
    membersMap.set(memberId, newMember);
    return newMember;
  };

  const guild = {
    id,
    name,
    roles: {
      everyone: { id: id, name: '@everyone' },
      cache: rolesMap,
      fetch: async (roleId) => rolesMap.get(roleId) || null,
      create: async (data) => {
        const newRoleId = `role-${roleIdCounter++}`;
        const newRole = {
          id: newRoleId,
          name: data.name,
          mentionable: Boolean(data.mentionable),
          permissions: {
            has: (perm) => false,
          },
          setPermissions: async (perms) => {},
          members: {
            get size() {
              let count = 0;
              for (const m of membersMap.values()) {
                if (m.roles?.cache?.has(newRoleId)) count++;
              }
              return count;
            },
          },
          delete: async () => {
            rolesMap.delete(newRoleId);
            for (const m of membersMap.values()) {
              m.roles?.cache?.delete(newRoleId);
            }
          },
        };
        rolesMap.set(newRoleId, newRole);
        return newRole;
      },
    },
    members: {
      me: botMember,
      cache: membersMap,
      fetch: async (memberId) => membersMap.get(memberId) || null,
      getOrCreate: getOrCreateMember,
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
        const messagesMap = new Map();
        const channel = {
          id: newId,
          name: data.name,
          type: data.type,
          parentId: data.parent || null,
          topic: data.topic || null,
          sentMessages,
          messages: {
            cache: messagesMap,
            fetch: async (msgId) => messagesMap.get(msgId) || null,
          },
          send: async (msg) => {
            const msgId = `msg-${messageCounter++}`;
            const m = typeof msg === 'object' ? { ...msg, id: msgId } : { content: msg, id: msgId };
            m.edit = async (newContent) => {
              Object.assign(m, typeof newContent === 'object' ? newContent : { content: newContent });
              return m;
            };
            sentMessages.push(m);
            messagesMap.set(msgId, m);
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
  };

  botMember.guild = guild;
  return guild;
}

function createMockButtonInteraction(options = {}) {
  const {
    customId = 'md_tour_create_channels:test-tour',
    guild = createMockGuild(),
    member = createMockMember({ isAdmin: true }),
  } = options;

  let replied = null;
  let updated = null;
  let followedUp = null;
  let deferred = false;

  const interaction = {
    customId,
    guild,
    member,
    isButton: () => true,
    deferReply: async (opts) => {
      deferred = true;
      return opts;
    },
    reply: async (msg) => {
      replied = msg;
      return {
        createMessageComponentCollector: (collectorOpts) => ({
          on: (event, handler) => {},
        }),
      };
    },
    editReply: async (msg) => {
      replied = msg;
      return msg;
    },
    update: async (msg) => {
      updated = msg;
      return msg;
    },
    followUp: async (msg) => {
      followedUp = msg;
      return msg;
    },
    getReplied: () => replied,
    getUpdated: () => updated,
    getFollowedUp: () => followedUp,
    isDeferred: () => deferred,
  };

  return interaction;
}

function createMockMember(options = {}) {
  const {
    id = 'user-admin-1',
    isAdmin = true,
    guild = null,
  } = options;

  const rolesMap = new Map();
  const member = {
    id,
    guild,
    user: { id, tag: `User${id}#0001` },
    roles: {
      cache: rolesMap,
      add: async (roleId) => {
        rolesMap.set(roleId, { id: roleId, name: roleId });
        return member;
      },
      remove: async (roleId) => {
        rolesMap.delete(roleId);
        return member;
      },
    },
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

  return member;
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

    // Verify exactly 5 channels were created
    assert.equal(result.channelsCreated.length, 5);
    assert.deepEqual(result.channelsCreated, [
      'bot-commands',
      'tournament-update',
      'tournament-teams',
      'tournament-helpdesk',
      'tournament-register',
    ]);

    // Verify NO squad channels exist (e.g. team-godlike or team-soul-esports)
    const allChannelNames = Array.from(guild.channels.cache.values()).map((c) => c.name);
    assert.equal(allChannelNames.some((n) => n.startsWith('team-')), false);

    // Verify Category (visible to everyone)
    const categoryChannel = guild.channels.cache.get(result.categoryId);
    assert.equal(categoryChannel.type, ChannelType.GuildCategory);
    assert.match(categoryChannel.name, /BGMI Super League/);
    const catEveryoneOw = categoryChannel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(catEveryoneOw.allow.includes(PermissionFlagsBits.ViewChannel));

    // A. #bot-commands: Admin only; participants CANNOT view
    const botCmdCh = guild.channels.cache.get(result.channelIds.botCommandsId);
    assert.ok(botCmdCh);
    assert.equal(botCmdCh.parentId, result.categoryId);
    const botCmdEveryoneOw = botCmdCh.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(botCmdEveryoneOw.deny.includes(PermissionFlagsBits.ViewChannel) || botCmdEveryoneOw.deny.includes('ViewChannel'));
    // Ordinary participants have NO view overwrite to bot-commands
    assert.equal(botCmdCh.permissionOverwrites.cache.has('111111111111111111'), false);
    assert.equal(botCmdCh.permissionOverwrites.cache.has('222222222222222222'), false);

    // B. #tournament-update: Public for @everyone to view; read-only for participants
    const updateCh = guild.channels.cache.get(result.channelIds.tournamentUpdateId);
    assert.ok(updateCh);
    assert.equal(updateCh.parentId, result.categoryId);
    const updateEveryoneOw = updateCh.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(updateEveryoneOw.allow.includes('ViewChannel') || updateEveryoneOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(updateEveryoneOw.deny.includes('SendMessages') || updateEveryoneOw.deny.includes(PermissionFlagsBits.SendMessages));
    // User-specific overwrites removed
    assert.equal(updateCh.permissionOverwrites.cache.has('111111111111111111'), false);

    // C. #tournament-teams: Administrator and Bot access only; ordinary participants must NOT be granted access
    const teamsCh = guild.channels.cache.get(result.channelIds.tournamentTeamsId);
    assert.ok(teamsCh);
    assert.equal(teamsCh.parentId, result.categoryId);
    const teamsEveryoneOw = teamsCh.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(teamsEveryoneOw.deny.includes(PermissionFlagsBits.ViewChannel) || teamsEveryoneOw.deny.includes('ViewChannel'));
    assert.equal(teamsCh.permissionOverwrites.cache.has('111111111111111111'), false);
    assert.equal(teamsCh.permissionOverwrites.cache.has('222222222222222222'), false);
    assert.equal(teamsCh.permissionOverwrites.cache.has('444444444444444444'), false);
    // Verified teams roster was published to teamsCh
    assert.equal(result.teamsUpdatedInChannel, true);
    assert.ok(teamsCh.sentMessages.length > 0);
    assert.match(teamsCh.sentMessages[0].content, /GodLike/);
    assert.match(teamsCh.sentMessages[0].content, /Soul Esports/);

    // D. #tournament-helpdesk: Public for @everyone to view and send messages
    const helpdeskCh = guild.channels.cache.get(result.channelIds.tournamentHelpdeskId);
    assert.ok(helpdeskCh);
    assert.equal(helpdeskCh.parentId, result.categoryId);
    const helpdeskEveryoneOw = helpdeskCh.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(helpdeskEveryoneOw.allow.includes('ViewChannel') || helpdeskEveryoneOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(helpdeskEveryoneOw.allow.includes('SendMessages') || helpdeskEveryoneOw.allow.includes(PermissionFlagsBits.SendMessages));
    assert.equal(helpdeskCh.permissionOverwrites.cache.has('111111111111111111'), false);

    // E. #tournament-register: Public for @everyone to view; read-only for participants
    const registerCh = guild.channels.cache.get(result.channelIds.tournamentRegisterId);
    assert.ok(registerCh);
    assert.equal(registerCh.parentId, result.categoryId);
    const registerEveryoneOw = registerCh.permissionOverwrites.cache.get(guild.roles.everyone.id);
    assert.ok(registerEveryoneOw.allow.includes('ViewChannel') || registerEveryoneOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(registerEveryoneOw.deny.includes('SendMessages') || registerEveryoneOw.deny.includes(PermissionFlagsBits.SendMessages));
    assert.equal(registerCh.permissionOverwrites.cache.has('111111111111111111'), false);
    assert.ok(registerCh.sentMessages.length > 0);
    assert.match(registerCh.sentMessages[0].content, /Official Tournament Registration & Details/);
    assert.match(registerCh.sentMessages[0].content, /tour-sync-1/);

    // Verify persistent storage
    const saved = guildSettingsCache[guild.id]?.tournaments?.[mockTournament.id];
    assert.ok(saved);
    assert.equal(saved.categoryId, result.categoryId);
    assert.equal(saved.channels.botCommandsId, result.channelIds.botCommandsId);
    assert.equal(saved.channels.tournamentUpdateId, result.channelIds.tournamentUpdateId);
    assert.equal(saved.channels.tournamentTeamsId, result.channelIds.tournamentTeamsId);
    assert.equal(saved.channels.tournamentHelpdeskId, result.channelIds.tournamentHelpdeskId);
    assert.equal(saved.channels.tournamentRegisterId, result.channelIds.tournamentRegisterId);
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
    assert.equal(firstSync.channelsCreated.length, 5);

    // Second run
    const secondSync = await syncTournamentDiscordChannels(guild, mockTournament, initialTeams, botMember);
    assert.equal(secondSync.categoryAction, 'reused');
    assert.equal(secondSync.categoryId, firstSync.categoryId);
    assert.equal(secondSync.channelsCreated.length, 0);
    assert.equal(secondSync.channelsReused.length, 5);
    assert.deepEqual(secondSync.channelIds, firstSync.channelIds);
  });

  test('12. Ineligibility Revocation: removes tournament role and participant access when a team/user becomes ineligible', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const mockTournament = {
      id: 'tour-revoke-3',
      title: 'Apex Legends Cup',
      status: 'published',
    };

    // Pre-register member in guild
    const member = guild.members.getOrCreate('111111111111111111');

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
    const roleId = firstSync.roleStats?.roleId;
    assert.ok(roleId);
    assert.ok(member.roles.cache.has(roleId));

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
    assert.equal(secondSync.roleStats?.removed, 1);
    assert.equal(member.roles.cache.has(roleId), false);
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
    // 5 shared tournament channels created
    assert.equal(syncResult.channelsCreated.length, 5);
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

  // --- Requirement: Tournament Management Control Panel & Action Buttons ---

  test('16. Control Panel Embed & Buttons builder: produces required fields and interactive components', () => {
    const tournament = {
      id: 'tour-cp-1',
      title: 'Apex Legends Winter Championship',
      game: 'Apex Legends',
      status: 'published',
      registration_status: 'open',
    };
    const summary = {
      total_registered_teams: 20,
      eligible_teams_count: 18,
      ineligible_teams_count: 2,
      eligible_linked_members_count: 54,
      unlinked_members_count: 6,
    };
    const channelsStatus = {
      isConfigured: true,
      activeCount: 4,
      statusText: '🟢 **Active** — All 4 channels configured',
    };

    const roleInfo = {
      roleId: 'role-123456789012345678',
      roleName: 'apexlegends',
      membersWithRole: 15,
      statusText: '🟢 Synchronized (15 assigned, 0 removed)',
      lastSyncedAt: new Date().toISOString(),
    };

    const embed = buildTournamentControlPanelEmbed(tournament, summary, channelsStatus, roleInfo);
    const data = embed.data || embed;

    assert.match(data.title, /Tournament Control Panel/);
    assert.match(data.title, /Apex Legends Winter Championship/);
    assert.match(data.description, /Apex Legends Winter Championship/);

    const fields = data.fields;
    assert.ok(fields.some((f) => f.value.includes('tour-cp-1')));
    assert.ok(fields.some((f) => f.value.includes('Apex Legends')));
    assert.ok(fields.some((f) => f.value.includes('PUBLISHED')));
    assert.ok(fields.some((f) => f.value.includes('OPEN')));
    assert.ok(fields.some((f) => f.name.includes('Registration Statistics') && f.value.includes('20')));
    assert.ok(fields.some((f) => f.name.includes('Registration Statistics') && f.value.includes('54')));
    assert.ok(fields.some((f) => f.name.includes('Registration Statistics') && f.value.includes('6')));
    assert.ok(fields.some((f) => f.name.includes('Tournament Role') && f.value.includes('apexlegends')));
    assert.ok(fields.some((f) => f.name.includes('Tournament Role') && f.value.includes('role-123456789012345678')));
    assert.ok(fields.some((f) => f.name.includes('Discord Channels Setup Status')));

    const actionRows = buildTournamentControlPanelButtons('tour-cp-1');
    assert.equal(actionRows.length, 1);
    const row = actionRows[0];
    const buttons = row.components;
    assert.equal(buttons.length, 4);

    const btn1 = buttons[0].data || buttons[0];
    const btn2 = buttons[1].data || buttons[1];
    const btn3 = buttons[2].data || buttons[2];
    const btn4 = buttons[3].data || buttons[3];

    assert.equal(btn1.custom_id, 'md_tour_create_channels:tour-cp-1');
    assert.equal(btn1.label, 'Create Channels');

    assert.equal(btn2.custom_id, 'md_tour_refresh:tour-cp-1');
    assert.equal(btn2.label, 'Refresh Tournament Data');

    assert.equal(btn3.custom_id, 'md_tour_sync_roles:tour-cp-1');
    assert.equal(btn3.label, 'Sync Tournament Roles');

    assert.equal(btn4.custom_id, 'md_tour_delete_channels:tour-cp-1');
    assert.equal(btn4.label, 'Delete All Channels');
  });

  test('17. setupTournamentControlPanel: creates category and #bot-commands with embed and buttons idempotently', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;
    const tournament = {
      id: 'tour-setup-cp',
      title: 'Valorant Championship',
      game: 'Valorant',
      status: 'published',
      registration_status: 'open',
    };
    const summary = {
      total_registered_teams: 8,
      eligible_linked_members_count: 24,
      unlinked_members_count: 0,
    };

    // First setup: provisions category & #bot-commands
    const result1 = await setupTournamentControlPanel(guild, tournament, summary, botMember);
    assert.ok(result1.category);
    assert.ok(result1.botCommandsChannel);
    assert.ok(result1.controlPanelMessageId);

    const botCmds = result1.botCommandsChannel;
    assert.equal(botCmds.sentMessages.length, 1);
    assert.ok(botCmds.sentMessages[0].embeds);
    assert.ok(botCmds.sentMessages[0].components);

    const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-setup-cp'];
    assert.ok(saved);
    assert.equal(saved.tournamentId, 'tour-setup-cp');
    assert.equal(saved.tournamentTitle, 'Valorant Championship');
    assert.equal(saved.categoryId, result1.category.id);
    assert.equal(saved.channels.botCommandsId, botCmds.id);
    assert.equal(saved.controlPanelMessageId, result1.controlPanelMessageId);

    // Second setup: idempotent, edits message instead of posting duplicate
    const result2 = await setupTournamentControlPanel(guild, tournament, summary, botMember);
    assert.equal(result2.category.id, result1.category.id);
    assert.equal(result2.botCommandsChannel.id, botCmds.id);
    assert.equal(botCmds.sentMessages.length, 1); // No new message posted; edited existing
  });

  test('18. handleSelectTournamentCommand: sets up control panel and notifies admin', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: {
          id: 'tour-select-1',
          title: 'PUBG Mobile Cup',
          game: 'PUBG Mobile',
          status: 'published',
          registration_status: 'open',
        },
        summary: {
          total_registered_teams: 4,
          eligible_teams_count: 4,
          eligible_linked_members_count: 16,
          unlinked_members_count: 0,
        },
        teams: [],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const adminMember = createMockMember({ isAdmin: true });

      let replyMsg = '';
      await handleSelectTournamentCommand(guild, adminMember, 'tour-select-1', async (msg) => {
        replyMsg = typeof msg === 'object' ? msg.content : msg;
      });

      assert.match(replyMsg, /Tournament Selected/);
      assert.match(replyMsg, /PUBG Mobile Cup/);
      assert.match(replyMsg, /tour-select-1/);
      assert.match(replyMsg, /Control panel initialized in/i);

      const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-select-1'];
      assert.ok(saved);
      assert.ok(saved.channels.botCommandsId);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('19. Button Interaction: Create Channels provisions 3 participant channels and updates embed', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: {
          id: 'tour-btn-1',
          title: 'Call of Duty Masters',
          game: 'Call of Duty',
          status: 'published',
          registration_status: 'open',
        },
        summary: {
          total_registered_teams: 2,
          eligible_teams_count: 2,
          ineligible_teams_count: 0,
          eligible_linked_members_count: 8,
          unlinked_members_count: 0,
        },
        teams: [
          {
            id: 't-1',
            team_name: 'Delta Squad',
            status: 'approved',
            is_eligible: true,
            linked_members: [{ discord_id: '111111111111111111', is_linked: true }],
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

      // Initialize control panel first
      await setupTournamentControlPanel(guild, {
        id: 'tour-btn-1',
        title: 'Call of Duty Masters',
        game: 'Call of Duty',
        status: 'published',
        registration_status: 'open',
      }, {
        total_registered_teams: 2,
        eligible_linked_members_count: 8,
        unlinked_members_count: 0,
      }, guild.members.me);

      const interaction = createMockButtonInteraction({
        customId: 'md_tour_create_channels:tour-btn-1',
        guild,
        member: adminMember,
      });

      await handleTournamentButtonInteraction(interaction);

      const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-btn-1'];
      assert.ok(saved);
      assert.ok(saved.channels.botCommandsId);
      assert.ok(saved.channels.tournamentUpdateId);
      assert.ok(saved.channels.tournamentTeamsId);
      assert.ok(saved.channels.tournamentHelpdeskId);
      assert.equal(saved.setupStatus, 'active');

      const replied = interaction.getReplied();
      assert.ok(replied);
      assert.match(replied.content, /Participant channels provisioned & synchronized/);
      assert.match(replied.content, /Announcements & Updates/);
      assert.match(replied.content, /Registered Teams Roster/);
      assert.match(replied.content, /Helpdesk & Support/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('20. Button Interaction: Refresh Tournament Data updates roster and control panel', async () => {
    let callCount = 0;
    const mockServer = http.createServer((req, res) => {
      callCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: {
          id: 'tour-refresh-1',
          title: 'CS:GO Clash',
          game: 'Counter-Strike',
          status: 'published',
          registration_status: 'open',
        },
        summary: {
          total_registered_teams: callCount,
          eligible_teams_count: callCount,
          ineligible_teams_count: 0,
          eligible_linked_members_count: callCount * 5,
          unlinked_members_count: 0,
        },
        teams: [
          {
            id: 'team-cs-1',
            team_name: `CS Squad ${callCount}`,
            status: 'approved',
            is_eligible: true,
            linked_members: [{ discord_id: '222222222222222222', is_linked: true }],
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

      // Create full channel setup
      const backendData = await fetchTournamentRegistrationsFromBackend('tour-refresh-1');
      await syncTournamentDiscordChannels(guild, backendData.tournament, backendData.teams, guild.members.me);
      await setupTournamentControlPanel(guild, backendData.tournament, backendData.summary, guild.members.me);

      const interaction = createMockButtonInteraction({
        customId: 'md_tour_refresh:tour-refresh-1',
        guild,
        member: adminMember,
      });

      await handleTournamentButtonInteraction(interaction);

      const replied = interaction.getReplied();
      assert.ok(replied);
      assert.match(replied.content, /Tournament Data Refreshed/);
      assert.match(replied.content, /Live registrations, stats, and roster updated/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('21. Button Interaction: Delete All Channels prompt creates 30s confirmation dialog', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const adminMember = createMockMember({ isAdmin: true });

    const interaction = createMockButtonInteraction({
      customId: 'md_tour_delete_channels:tour-del-prompt',
      guild,
      member: adminMember,
    });

    await handleTournamentButtonInteraction(interaction);

    const replied = interaction.getReplied();
    assert.ok(replied);
    assert.match(replied.content, /Confirm Permanent Channel Deletion/);
    assert.match(replied.content, /#bot-commands/);
    assert.match(replied.content, /30 seconds/);

    assert.ok(replied.components && replied.components.length > 0);
    const buttons = replied.components[0].components;
    assert.equal(buttons.length, 2);
    assert.equal((buttons[0].data || buttons[0]).custom_id, 'md_tour_confirm_delete:tour-del-prompt');
    assert.equal((buttons[1].data || buttons[1]).custom_id, 'md_tour_cancel_delete:tour-del-prompt');
  });

  test('22. Button Interaction: Confirm Delete removes all 4 channels and category and updates storage', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const adminMember = createMockMember({ isAdmin: true });

    const tournament = {
      id: 'tour-del-confirm',
      title: 'Overwatch Cup',
      game: 'Overwatch',
      status: 'published',
      registration_status: 'open',
    };
    const summary = { total_registered_teams: 2, eligible_linked_members_count: 10, unlinked_members_count: 0 };

    await setupTournamentControlPanel(guild, tournament, summary, guild.members.me);
    await syncTournamentDiscordChannels(guild, tournament, [], guild.members.me);

    const savedBefore = guildSettingsCache[guild.id]?.tournaments?.['tour-del-confirm'];
    assert.ok(savedBefore);
    assert.equal(savedBefore.setupStatus, 'active');
    const catId = savedBefore.categoryId;
    const botCmdId = savedBefore.channels.botCommandsId;

    assert.ok(guild.channels.cache.get(catId));
    assert.ok(guild.channels.cache.get(botCmdId));

    const interaction = createMockButtonInteraction({
      customId: 'md_tour_confirm_delete:tour-del-confirm',
      guild,
      member: adminMember,
    });

    await handleTournamentButtonInteraction(interaction);

    const updated = interaction.getUpdated();
    assert.ok(updated);
    assert.match(updated.content, /Deleting tournament channels/);

    const followedUp = interaction.getFollowedUp();
    assert.ok(followedUp);
    assert.match(followedUp.content, /Tournament Channels Deleted/);

    // Verify channels and category were removed from guild cache
    assert.equal(guild.channels.cache.get(catId), undefined);
    assert.equal(guild.channels.cache.get(botCmdId), undefined);

    // Verify persistent storage marked as deleted
    const savedAfter = guildSettingsCache[guild.id]?.tournaments?.['tour-del-confirm'];
    assert.equal(savedAfter.setupStatus, 'deleted');
    assert.deepEqual(savedAfter.channels, {});
    assert.equal(savedAfter.categoryId, null);
    assert.ok(savedAfter.deletedAt);
  });

  test('23. Button Interaction: Cancel Delete leaves channels intact', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const adminMember = createMockMember({ isAdmin: true });

    const interaction = createMockButtonInteraction({
      customId: 'md_tour_cancel_delete:tour-cancel-test',
      guild,
      member: adminMember,
    });

    await handleTournamentButtonInteraction(interaction);

    const updated = interaction.getUpdated();
    assert.ok(updated);
    assert.match(updated.content, /Deletion Cancelled/);
    assert.match(updated.content, /channels and configuration remain intact/);
  });

  test('24. Button Interaction: Security & Authorization restricts to admins in official guild', async () => {
    const officialGuild = createMockGuild(OFFICIAL_GUILD_ID);
    const rogueGuild = createMockGuild('rogue-server-666');
    const adminMember = createMockMember({ isAdmin: true });
    const nonAdminMember = createMockMember({ isAdmin: false });

    // Unauthorized guild
    const rogueInteraction = createMockButtonInteraction({
      customId: 'md_tour_create_channels:tour-sec-1',
      guild: rogueGuild,
      member: adminMember,
    });
    await handleTournamentButtonInteraction(rogueInteraction);
    assert.match(rogueInteraction.getReplied().content, /official MatchDistrict Discord server/i);

    // Non-admin user
    const nonAdminInteraction = createMockButtonInteraction({
      customId: 'md_tour_create_channels:tour-sec-1',
      guild: officialGuild,
      member: nonAdminMember,
    });
    await handleTournamentButtonInteraction(nonAdminInteraction);
    assert.match(nonAdminInteraction.getReplied().content, /Administrator/i);
  });

  // --- Acceptance Tests (Deduplication, Channel Access Rules & Member Sync) ---

  test('Acceptance 1 & 2: First refresh sends team-list message and saves ID; second refresh edits existing message in-place', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const tournament = { id: 'tour-dedup-1', title: 'Free Fire Cup', game: 'Free Fire' };
    const initialTeams = [
      { id: 't-1', team_name: 'Squad One', captain: 'Player 1', is_eligible: true, members: [] },
    ];
    const teamsChannel = await guild.channels.create({ name: 'tournament-teams', type: ChannelType.GuildText });
    const savedTournament = { channels: { tournamentTeamsId: teamsChannel.id }, teamListMessageIds: [] };

    // 1st refresh: creates message and saves ID
    await updateTeamsRosterMessages(guild, tournament, initialTeams, teamsChannel, savedTournament);
    assert.equal(teamsChannel.sentMessages.length, 1);
    assert.equal(savedTournament.teamListMessageIds.length, 1);
    const firstMsgId = savedTournament.teamListMessageIds[0];
    assert.match(teamsChannel.sentMessages[0].content, /Squad One/);

    // 2nd refresh with new team: edits existing message, does NOT send new message
    const updatedTeams = [
      { id: 't-1', team_name: 'Squad One Updated', captain: 'Player 1', is_eligible: true, members: [] },
      { id: 't-2', team_name: 'Squad Two', captain: 'Player 2', is_eligible: true, members: [] },
    ];
    await updateTeamsRosterMessages(guild, tournament, updatedTeams, teamsChannel, savedTournament);
    assert.equal(teamsChannel.sentMessages.length, 1); // Still exactly 1 message
    assert.equal(savedTournament.teamListMessageIds[0], firstMsgId);
    assert.match(teamsChannel.sentMessages[0].content, /Squad One Updated/);
    assert.match(teamsChannel.sentMessages[0].content, /Squad Two/);
  });

  test('Acceptance 3: Restarting the bot preserves teamListMessageIds in storage and avoids duplicate messages', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const tournament = { id: 'tour-restart-1', title: 'Restart League', game: 'PUBG' };
    const teams = [{ id: 't-1', team_name: 'Alpha Team', captain: 'Captain A', is_eligible: true, members: [] }];
    const teamsChannel = await guild.channels.create({ name: 'tournament-teams', type: ChannelType.GuildText });

    const savedTournament = {
      tournamentId: 'tour-restart-1',
      channels: { tournamentTeamsId: teamsChannel.id },
      teamListMessageIds: [],
    };
    guildSettingsCache[guild.id] = { tournaments: { 'tour-restart-1': savedTournament } };

    // Initial publish
    await updateTeamsRosterMessages(guild, tournament, teams, teamsChannel, savedTournament);
    assert.equal(teamsChannel.sentMessages.length, 1);
    const storedMsgId = savedTournament.teamListMessageIds[0];

    // Simulate bot restart: reload from persistent settings
    const loadedSettings = JSON.parse(JSON.stringify(guildSettingsCache[guild.id]));
    const reloadedTournament = loadedSettings.tournaments['tour-restart-1'];
    assert.deepEqual(reloadedTournament.teamListMessageIds, [storedMsgId]);

    // Refresh after restart: edits existing message
    const teamsAfterRestart = [
      { id: 't-1', team_name: 'Alpha Team Post-Restart', captain: 'Captain A', is_eligible: true, members: [] },
    ];
    await updateTeamsRosterMessages(guild, tournament, teamsAfterRestart, teamsChannel, reloadedTournament);
    assert.equal(teamsChannel.sentMessages.length, 1); // No duplicate message sent
    assert.match(teamsChannel.sentMessages[0].content, /Alpha Team Post-Restart/);
  });

  test('Acceptance 4: Concurrent refresh requests are guarded by per-tournament lock', async () => {
    const tournamentId = 'tour-lock-test';
    let task1Completed = false;

    // Start task 1 holding lock
    const promise1 = withTournamentLock(tournamentId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task1Completed = true;
      return 'done1';
    });

    // Attempt concurrent task 2 with same tournamentId
    await assert.rejects(
      async () => {
        await withTournamentLock(tournamentId, async () => 'done2');
      },
      /already running/
    );

    const result1 = await promise1;
    assert.equal(result1, 'done1');
    assert.equal(task1Completed, true);

    // After task 1 finishes, lock is released and task 3 succeeds
    const result3 = await withTournamentLock(tournamentId, async () => 'done3');
    assert.equal(result3, 'done3');
  });

  test('Acceptance 5 & 6: Registered linked user who joins receives access to update, helpdesk, register; CANNOT access bot-commands or tournament-teams', async () => {
    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/bot/users/111222333444555666/eligible-tournaments') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          discord_id: '111222333444555666',
          user_id: 'usr-eligible-1',
          eligible_tournaments: [
            { id: 'tour-join-test', title: 'Join Championship', game: 'Valorant' },
          ],
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // Provision 5 channels for tour-join-test
      const mockTour = { id: 'tour-join-test', title: 'Join Championship', game: 'Valorant' };
      const syncRes = await syncTournamentDiscordChannels(guild, mockTour, [], botMember);
      assert.equal(syncRes.channelsCreated.length, 5);

      // Simulate member joining
      const joiningMember = {
        id: '111222333444555666',
        guild,
      };

      const syncResult = await syncMemberTournamentAccess(joiningMember);
      assert.equal(syncResult.success, true);
      assert.equal(syncResult.grantedCount, 3); // update, register, helpdesk

      // Verify access to update, register, helpdesk
      const updateCh = guild.channels.cache.get(syncRes.channelIds.tournamentUpdateId);
      const registerCh = guild.channels.cache.get(syncRes.channelIds.tournamentRegisterId);
      const helpdeskCh = guild.channels.cache.get(syncRes.channelIds.tournamentHelpdeskId);

      assert.ok(updateCh.permissionOverwrites.cache.has(joiningMember.id));
      assert.ok(registerCh.permissionOverwrites.cache.has(joiningMember.id));
      assert.ok(helpdeskCh.permissionOverwrites.cache.has(joiningMember.id));

      // Criteria 6: User CANNOT access bot-commands or tournament-teams
      const botCmdCh = guild.channels.cache.get(syncRes.channelIds.botCommandsId);
      const teamsCh = guild.channels.cache.get(syncRes.channelIds.tournamentTeamsId);
      assert.equal(botCmdCh.permissionOverwrites.cache.has(joiningMember.id), false);
      assert.equal(teamsCh.permissionOverwrites.cache.has(joiningMember.id), false);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Acceptance 7: User with no linked Discord account receives no tournament-specific access upon joining', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '999888777666555444',
        user_id: null,
        eligible_tournaments: [],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const unlinkedMember = { id: '999888777666555444', guild };

      const syncResult = await syncMemberTournamentAccess(unlinkedMember);
      assert.equal(syncResult.success, true);
      assert.equal(syncResult.grantedCount, 0);
      assert.equal(syncResult.reason, 'no_eligible_tournaments');
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Acceptance 8: Member who links their account after joining receives access through synchronization mechanism', async () => {
    let isLinked = false;
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!isLinked) {
        res.end(JSON.stringify({ success: true, discord_id: '555444333222111000', user_id: null, eligible_tournaments: [] }));
      } else {
        res.end(JSON.stringify({
          success: true,
          discord_id: '555444333222111000',
          user_id: 'usr-late-linker',
          eligible_tournaments: [{ id: 'tour-late-link', title: 'Late Link Tourney', game: 'CS2' }],
        }));
      }
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;
      const syncRes = await syncTournamentDiscordChannels(guild, { id: 'tour-late-link', title: 'Late Link Tourney' }, [], botMember);

      const existingMember = { id: '555444333222111000', guild };

      // Member joined prior to linking: 0 granted
      const resBefore = await syncMemberTournamentAccess(existingMember);
      assert.equal(resBefore.grantedCount, 0);

      // User links account on website
      isLinked = true;

      // Sync triggered (post-link event/webhook): access granted
      const resAfter = await syncMemberTournamentAccess(existingMember);
      assert.equal(resAfter.success, true);
      assert.equal(resAfter.grantedCount, 3);

      const updateCh = guild.channels.cache.get(syncRes.channelIds.tournamentUpdateId);
      assert.ok(updateCh.permissionOverwrites.cache.has(existingMember.id));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Acceptance 9 & 10: Users registered for multiple tournaments receive access only to their eligible tournaments; ineligible registrations excluded', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '777666555444333222',
        user_id: 'usr-multi-tour',
        eligible_tournaments: [
          // Eligible for Tour A only; NOT eligible for Tour B (cancelled/rejected)
          { id: 'tour-multi-A', title: 'Tournament Alpha', game: 'Apex' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      const syncA = await syncTournamentDiscordChannels(guild, { id: 'tour-multi-A', title: 'Tournament Alpha' }, [], botMember);
      const syncB = await syncTournamentDiscordChannels(guild, { id: 'tour-multi-B', title: 'Tournament Beta' }, [], botMember);

      const member = { id: '777666555444333222', guild };
      const syncResult = await syncMemberTournamentAccess(member);
      assert.equal(syncResult.success, true);

      // Access granted to Tour A channels
      const updateChA = guild.channels.cache.get(syncA.channelIds.tournamentUpdateId);
      assert.ok(updateChA.permissionOverwrites.cache.has(member.id));

      // No access to Tour B channels
      const updateChB = guild.channels.cache.get(syncB.channelIds.tournamentUpdateId);
      assert.equal(updateChB.permissionOverwrites.cache.has(member.id), false);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Acceptance 11, 12, & 13: Channel IDs & Message IDs are reused; no per-squad channels; registration channel contains authentic URL', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;
    const tournament = {
      id: 'tour-accept-11',
      title: 'Grand Invitational',
      url: 'https://matchdistrict.in/tournaments/tour-accept-11',
    };
    const teams = [
      { id: 't-1', team_name: 'Squad Uno', captain: 'Leader 1', is_eligible: true, members: [] },
    ];

    // First setup
    const sync1 = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);
    assert.equal(sync1.channelsCreated.length, 5);

    // Verify registration link channel content
    const regCh = guild.channels.cache.get(sync1.channelIds.tournamentRegisterId);
    assert.ok(regCh);
    assert.equal(regCh.sentMessages.length, 1);
    assert.match(regCh.sentMessages[0].content, /https:\/\/matchdistrict\.in\/tournaments\/tour-accept-11/);

    const saved1 = guildSettingsCache[guild.id].tournaments['tour-accept-11'];
    assert.ok(saved1.registrationMessageId);
    assert.ok(saved1.teamListMessageIds.length > 0);

    // Second setup: verify channel IDs and message IDs are reused
    const sync2 = await syncTournamentDiscordChannels(guild, tournament, teams, botMember);
    assert.equal(sync2.channelsCreated.length, 0);
    assert.equal(sync2.channelsReused.length, 5);
    assert.deepEqual(sync2.channelIds, sync1.channelIds);

    // Verify no new message posted to registration channel (edited in place)
    assert.equal(regCh.sentMessages.length, 1);

    // Acceptance 12: Verify no per-squad channels created
    const allChannels = Array.from(guild.channels.cache.values());
    assert.equal(allChannels.some((c) => c.name.startsWith('team-')), false);
  });

  // --- Tournament Roles & Automatic Synchronization Tests ---

  test('Role 1: normalizeTournamentRoleName generates lowercase alphanumeric role name', () => {
    assert.equal(normalizeTournamentRoleName('BGIS 2026'), 'bgis2026');
    assert.equal(normalizeTournamentRoleName('PUBG Mobile (Club Open) 2026!'), 'pubgmobileclubopen2026');
    assert.equal(normalizeTournamentRoleName('Valorant Champions Tour @ Berlin'), 'valorantchampionstourberlin');
    assert.equal(normalizeTournamentRoleName('   Special   Chars #42   '), 'specialchars42');
    assert.equal(normalizeTournamentRoleName('!@#$%^&*()', '123'), 'tour123');
    assert.equal(normalizeTournamentRoleName('', '456'), 'tour456');
    assert.equal(normalizeTournamentRoleName(''), 'tourrole');
  });

  test('Role 2: getOrCreateTournamentRole creates role idempotently and persists mapping', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const tournament = { id: 'tour-bgis', title: 'BGIS 2026' };

    // First call creates role
    const role1 = await getOrCreateTournamentRole(guild, tournament);
    assert.ok(role1);
    assert.equal(role1.name, 'bgis2026');
    assert.equal(role1.mentionable, true);

    const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-bgis'];
    assert.ok(saved);
    assert.equal(saved.roleId, role1.id);
    assert.equal(saved.roleName, 'bgis2026');

    // Second call reuses role without creating a new one
    const role2 = await getOrCreateTournamentRole(guild, tournament);
    assert.equal(role2.id, role1.id);
    assert.equal(guild.roles.cache.size, 2); // @everyone + 1 role
  });

  test('Role 3: syncTournamentRoles assigns role, skips unlinked/missing members, deduplicates, and revokes on ineligibility', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const tournament = { id: 'tour-roles-sync', title: 'BGIS 2026' };

    // Set up members in guild
    const member1 = guild.members.getOrCreate('111111111111111111');
    const member2 = guild.members.getOrCreate('222222222222222222');
    // Pre-assign an unrelated role to member1 to verify it is NOT removed
    await member1.roles.add('unrelated-role-999');

    // User 333333333333333333 is eligible but NOT in the server (skipped)
    // User unlinked has no discord ID (skipped)
    // member1 is on two different teams (deduplicated)
    const teams = [
      {
        id: 'team-alpha',
        team_name: 'Team Alpha',
        is_eligible: true,
        linked_members: [
          { discord_id: '111111111111111111', is_linked: true },
          { discord_id: '222222222222222222', is_linked: true },
          { discord_id: null, is_linked: false },
        ],
      },
      {
        id: 'team-beta',
        team_name: 'Team Beta',
        is_eligible: true,
        linked_members: [
          { discord_id: '111111111111111111', is_linked: true }, // duplicate
          { discord_id: '333333333333333333', is_linked: true }, // not in server
        ],
      },
    ];

    const stats1 = await syncTournamentRoles(guild, tournament.id, { tournament, teams });
    assert.equal(stats1.assigned, 2); // member1 and member2
    assert.equal(stats1.alreadyAssigned, 0);
    assert.equal(stats1.skipped, 1); // 333333333333333333 (not in server)
    assert.equal(stats1.removed, 0);
    assert.equal(stats1.membersWithRole, 2);

    assert.ok(member1.roles.cache.has(stats1.roleId));
    assert.ok(member2.roles.cache.has(stats1.roleId));
    // Unrelated role remains intact
    assert.ok(member1.roles.cache.has('unrelated-role-999'));

    // Second sync: member1 and member2 already have role
    const stats2 = await syncTournamentRoles(guild, tournament.id, { tournament, teams });
    assert.equal(stats2.assigned, 0);
    assert.equal(stats2.alreadyAssigned, 2);

    // Third sync: member2's team is disqualified/ineligible -> role revoked from member2
    const revokedTeams = [
      {
        id: 'team-alpha',
        team_name: 'Team Alpha',
        is_eligible: false, // disqualified!
        linked_members: [
          { discord_id: '222222222222222222', is_linked: true },
        ],
      },
      {
        id: 'team-beta',
        team_name: 'Team Beta',
        is_eligible: true,
        linked_members: [
          { discord_id: '111111111111111111', is_linked: true },
        ],
      },
    ];

    const stats3 = await syncTournamentRoles(guild, tournament.id, { tournament, teams: revokedTeams });
    assert.equal(stats3.removed, 1);
    assert.equal(member2.roles.cache.has(stats1.roleId), false);
    assert.ok(member1.roles.cache.has(stats1.roleId));
    assert.ok(member1.roles.cache.has('unrelated-role-999')); // untouched
  });

  test('Role 4: syncMemberTournamentRoles assigns multiple tournament roles on member join', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '666777888999000111',
        eligible_tournaments: [
          { id: 'tour-bgis-2026', title: 'BGIS 2026' },
          { id: 'tour-pmco-2026', title: 'PMCO 2026' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // Provision both tournaments
      await syncTournamentDiscordChannels(guild, { id: 'tour-bgis-2026', title: 'BGIS 2026' }, [], botMember);
      await syncTournamentDiscordChannels(guild, { id: 'tour-pmco-2026', title: 'PMCO 2026' }, [], botMember);

      const joiningMember = guild.members.getOrCreate('666777888999000111');
      joiningMember.guild = guild;

      const result = await syncMemberTournamentRoles(joiningMember);
      assert.equal(result.success, true);
      assert.equal(result.assignedCount, 2);

      const savedBgis = guildSettingsCache[guild.id]?.tournaments?.['tour-bgis-2026'];
      const savedPmco = guildSettingsCache[guild.id]?.tournaments?.['tour-pmco-2026'];

      assert.ok(joiningMember.roles.cache.has(savedBgis.roleId));
      assert.ok(joiningMember.roles.cache.has(savedPmco.roleId));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Role 5: Button interaction md_tour_sync_roles synchronizes roles and updates control panel', async () => {
    let mockTeams = [
      {
        id: 'team-btn',
        team_name: 'Button Squad',
        is_eligible: true,
        linked_members: [{ discord_id: '123123123123123123', is_linked: true }],
      },
    ];

    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: { id: 'tour-btn-sync', title: 'Button Tourney' },
        teams: mockTeams,
        summary: {
          total_registered_teams: mockTeams.length,
          eligible_teams_count: mockTeams.filter(t => t.is_eligible).length,
          ineligible_teams_count: 0,
          eligible_linked_members_count: 1,
          unlinked_members_count: 0,
        },
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // Setup tournament channels & control panel
      await syncTournamentDiscordChannels(guild, { id: 'tour-btn-sync', title: 'Button Tourney' }, mockTeams, botMember);
      await setupTournamentControlPanel(guild, { id: 'tour-btn-sync', title: 'Button Tourney' }, {
        total_registered_teams: 1,
        eligible_teams_count: 1,
        ineligible_teams_count: 0,
        eligible_linked_members_count: 1,
        unlinked_members_count: 0,
      }, botMember);

      const targetMember = guild.members.getOrCreate('123123123123123123');

      const interaction = createMockButtonInteraction({
        customId: 'md_tour_sync_roles:tour-btn-sync',
        guild,
        member: createMockMember({ isAdmin: true, guild }),
      });

      await handleTournamentButtonInteraction(interaction);
      assert.ok(interaction.isDeferred());
      const reply = interaction.getReplied();
      assert.ok(reply);
      assert.match(reply.content, /Tournament Roles Synchronized/);
      assert.match(reply.content, /buttontourney/);

      // Verify role assigned to targetMember
      const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-btn-sync'];
      assert.ok(targetMember.roles.cache.has(saved.roleId));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Role 6: handleSyncRolesCommand synchronizes roles and auto-detects context from #bot-commands', async () => {
    let mockTeams = [
      {
        id: 'team-cmd',
        team_name: 'Command Squad',
        is_eligible: true,
        linked_members: [{ discord_id: '456456456456456456', is_linked: true }],
      },
    ];

    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tournament: { id: 'tour-cmd-sync', title: 'Command Tourney' },
        teams: mockTeams,
        summary: {
          total_registered_teams: 1,
          eligible_teams_count: 1,
          ineligible_teams_count: 0,
          eligible_linked_members_count: 1,
          unlinked_members_count: 0,
        },
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // Setup tournament
      const syncResult = await syncTournamentDiscordChannels(guild, { id: 'tour-cmd-sync', title: 'Command Tourney' }, mockTeams, botMember);
      const botCommandsChannel = guild.channels.cache.get(syncResult.channelIds.botCommandsId);

      guild.members.getOrCreate('456456456456456456');

      let replyOutput = '';
      const replyFn = (msg) => {
        replyOutput = typeof msg === 'object' ? (msg.content || '') : msg;
      };

      const adminMember = createMockMember({ isAdmin: true, guild });

      // Run .sync roles inside #bot-commands without specifying ID
      await handleSyncRolesCommand(guild, adminMember, [], replyFn, botCommandsChannel);

      assert.match(replyOutput, /Tournament Roles Synchronized/);
      assert.match(replyOutput, /tour-cmd-sync/);
      assert.match(replyOutput, /commandtourney/);

      // Verify non-admin is rejected
      const regularMember = createMockMember({ isAdmin: false, guild });
      let rejectOutput = '';
      await handleSyncRolesCommand(guild, regularMember, ['tour-cmd-sync'], (msg) => { rejectOutput = msg; }, botCommandsChannel);
      assert.match(rejectOutput, /Permission Denied/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Role 7: deleteTournamentDiscordChannels deletes mapped tournament role and clears storage', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const botMember = guild.members.me;

    const tournament = { id: 'tour-del-role', title: 'Role Deletion Cup' };
    const teams = [{ id: 't1', team_name: 'Squad 1', is_eligible: true, linked_members: [] }];

    await syncTournamentDiscordChannels(guild, tournament, teams, botMember);

    const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-del-role'];
    const roleId = saved.roleId;
    assert.ok(roleId);
    assert.ok(guild.roles.cache.has(roleId));

    // Delete channels & role
    const delSummary = await deleteTournamentDiscordChannels(guild, 'tour-del-role');
    assert.equal(delSummary.roleDeleted, true);
    assert.equal(guild.roles.cache.has(roleId), false);

    // Verify stored roleId is cleared
    assert.equal(saved.roleId, null);
    assert.equal(saved.roleName, null);
  });

  // --- Automated Join Scenarios 1 through 9 ---

  test('Scenario 1: A newly joined member who is registered for a tournament receives the correct role automatically upon joining', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '100000000000000001',
        user_id: 'usr-registered-1',
        eligible_tournaments: [
          { id: 'tour-single-reg', title: 'Single Reg Cup' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // Setup tournament
      await syncTournamentDiscordChannels(guild, { id: 'tour-single-reg', title: 'Single Reg Cup' }, [], botMember);
      const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-single-reg'];
      assert.ok(saved.roleId);

      // Member joins
      const member = guild.members.getOrCreate('100000000000000001');
      member.guild = guild;

      const result = await syncMemberTournamentRoles(member);
      assert.equal(result.success, true);
      assert.equal(result.assignedCount, 1);
      assert.ok(member.roles.cache.has(saved.roleId));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 2: A newly joined member registered for multiple tournaments receives all applicable tournament roles in a single join event', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '200000000000000002',
        user_id: 'usr-multi-reg-2',
        eligible_tournaments: [
          { id: 'tour-multi-1', title: 'Grand Tourney 1' },
          { id: 'tour-multi-2', title: 'Grand Tourney 2' },
          { id: 'tour-multi-3', title: 'Grand Tourney 3' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // Setup 3 tournaments
      await syncTournamentDiscordChannels(guild, { id: 'tour-multi-1', title: 'Grand Tourney 1' }, [], botMember);
      await syncTournamentDiscordChannels(guild, { id: 'tour-multi-2', title: 'Grand Tourney 2' }, [], botMember);
      await syncTournamentDiscordChannels(guild, { id: 'tour-multi-3', title: 'Grand Tourney 3' }, [], botMember);

      const saved1 = guildSettingsCache[guild.id]?.tournaments?.['tour-multi-1'];
      const saved2 = guildSettingsCache[guild.id]?.tournaments?.['tour-multi-2'];
      const saved3 = guildSettingsCache[guild.id]?.tournaments?.['tour-multi-3'];

      const member = guild.members.getOrCreate('200000000000000002');
      member.guild = guild;

      const result = await syncMemberTournamentRoles(member);
      assert.equal(result.success, true);
      assert.equal(result.assignedCount, 3);
      assert.ok(member.roles.cache.has(saved1.roleId));
      assert.ok(member.roles.cache.has(saved2.roleId));
      assert.ok(member.roles.cache.has(saved3.roleId));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 3: A newly joined member who is not registered receives no tournament roles', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '300000000000000003',
        user_id: 'usr-unregistered-3',
        eligible_tournaments: [],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      await syncTournamentDiscordChannels(guild, { id: 'tour-existing', title: 'Existing Cup' }, [], botMember);

      const member = guild.members.getOrCreate('300000000000000003');
      member.guild = guild;

      const result = await syncMemberTournamentRoles(member);
      assert.equal(result.success, true);
      assert.equal(result.assignedCount, 0);
      assert.equal(member.roles.cache.size, 0);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 4: A newly joined member whose Discord account is not linked receives no tournament roles', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '400000000000000004',
        user_id: null,
        eligible_tournaments: [],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      await syncTournamentDiscordChannels(guild, { id: 'tour-unlinked', title: 'Unlinked Cup' }, [], botMember);

      const member = guild.members.getOrCreate('400000000000000004');
      member.guild = guild;

      const result = await syncMemberTournamentRoles(member);
      assert.equal(result.success, true);
      assert.equal(result.assignedCount, 0);
      assert.equal(member.roles.cache.size, 0);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 5: A member who already has the tournament role does not trigger redundant API assignments or errors', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '500000000000000005',
        user_id: 'usr-idempotent-5',
        eligible_tournaments: [
          { id: 'tour-idempotent', title: 'Idempotent Championship' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      await syncTournamentDiscordChannels(guild, { id: 'tour-idempotent', title: 'Idempotent Championship' }, [], botMember);
      const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-idempotent'];

      const member = guild.members.getOrCreate('500000000000000005');
      member.guild = guild;

      // First join/assignment
      const result1 = await syncMemberTournamentRoles(member);
      assert.equal(result1.success, true);
      assert.equal(result1.assignedCount, 1);
      assert.equal(member.roles.addCalls.length, 1);

      // Second sync: already has role -> skip redundant API call
      const result2 = await syncMemberTournamentRoles(member);
      assert.equal(result2.success, true);
      assert.equal(result2.assignedCount, 0);
      assert.equal(result2.alreadyAssignedCount, 1);
      assert.equal(member.roles.addCalls.length, 1); // add was not called again!
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 6: Temporary backend failures during the join event are handled gracefully and retried safely', async () => {
    let failureCount = 0;
    const mockServer = http.createServer((req, res) => {
      if (failureCount < 1) {
        failureCount++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'DATABASE_TIMEOUT' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '600000000000000006',
        user_id: 'usr-retry-6',
        eligible_tournaments: [
          { id: 'tour-retry-test', title: 'Retry Cup' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      await syncTournamentDiscordChannels(guild, { id: 'tour-retry-test', title: 'Retry Cup' }, [], botMember);
      const saved = guildSettingsCache[guild.id]?.tournaments?.['tour-retry-test'];

      const member = guild.members.getOrCreate('600000000000000006');
      member.guild = guild;

      // Join event when backend fails
      const result1 = await syncMemberTournamentRoles(member);
      assert.equal(result1.success, false);
      assert.equal(result1.queuedForRetry, true);

      // Verify member is in pendingRoleSync queue
      const queueBefore = guildSettingsCache[guild.id]?.pendingRoleSync || [];
      const queueItem = queueBefore.find((item) => item.discordId === '600000000000000006');
      assert.ok(queueItem);
      assert.equal(queueItem.attempts, 1);

      // Advance retry timestamp so queue processor picks it up
      queueItem.nextRetryTimestamp = Date.now() - 1000;

      // Run retry processor
      const retryResults = await processPendingRoleSyncQueue(guild);
      assert.equal(retryResults.processed, 1);
      assert.equal(retryResults.succeeded, 1);

      // Role is now successfully assigned
      assert.ok(member.roles.cache.has(saved.roleId));

      // Member removed from retry queue
      const queueAfter = guildSettingsCache[guild.id]?.pendingRoleSync || [];
      assert.equal(queueAfter.some((item) => item.discordId === '600000000000000006'), false);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 7: A user joining an unauthorized Discord server (different guild ID) is ignored and receives no tournament roles', async () => {
    const unauthorizedGuild = createMockGuild('unauthorized-guild-99999');
    const member = unauthorizedGuild.members.getOrCreate('700000000000000007');
    member.guild = unauthorizedGuild;

    const result = await syncMemberTournamentRoles(member);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'unauthorized_guild');
    assert.equal(member.roles.cache.size, 0);
  });

  test('Scenario 8: Event listener survives bot restarts and works consistently for subsequent joins', async () => {
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '800000000000000008',
        user_id: 'usr-restart-8',
        eligible_tournaments: [
          { id: 'tour-restart-persisted', title: 'Restart Persisted Cup' },
        ],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const botMember = guild.members.me;

      // 1. Initial tournament setup before restart
      await syncTournamentDiscordChannels(guild, { id: 'tour-restart-persisted', title: 'Restart Persisted Cup' }, [], botMember);
      const initialRole = guildSettingsCache[guild.id]?.tournaments?.['tour-restart-persisted'];
      const storedRoleId = initialRole.roleId;
      assert.ok(storedRoleId);

      // 2. Simulate bot restart by serializing & deserializing cache
      const reloadedCache = JSON.parse(JSON.stringify(guildSettingsCache));
      guildSettingsCache[guild.id] = reloadedCache[guild.id];

      // 3. Subsequent member joins after restart
      const member = guild.members.getOrCreate('800000000000000008');
      member.guild = guild;

      const result = await syncMemberTournamentRoles(member);
      assert.equal(result.success, true);
      assert.equal(result.assignedCount, 1);
      // Ensures the reloaded role ID was reused without recreating another role
      assert.ok(member.roles.cache.has(storedRoleId));
      assert.equal(guildSettingsCache[guild.id].tournaments['tour-restart-persisted'].roleId, storedRoleId);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Scenario 9: Existing tournament commands (.list tournament, .fetch teams, etc.) continue to function without regression', async () => {
    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/bot/tournaments') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          tournaments: [
            { id: 'tour-cmd-regres', title: 'Command Regression Cup', game: 'BGMI', status: 'published', registration_count: 5 },
          ],
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const guild = createMockGuild(OFFICIAL_GUILD_ID);
      const adminMember = createMockMember({ isAdmin: true, guild });

      let listOutput = null;
      await handleListTournamentCommand(guild, adminMember, [], (payload) => {
        listOutput = payload;
      });

      assert.ok(listOutput);
      const text = typeof listOutput === 'string' ? listOutput : listOutput.content;
      assert.match(text, /MatchDistrict Tournaments/);
      assert.match(text, /Command Regression Cup/);
      assert.ok(listOutput.components?.length > 0);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test('Role Security & Missing Role: Re-creates missing/deleted role with warning and respects bot hierarchy and permissions', async () => {
    const guild = createMockGuild(OFFICIAL_GUILD_ID);
    const tournament = { id: 'tour-sec-test', title: 'Security Cup' };

    // 1. Create role initially
    const role1 = await getOrCreateTournamentRole(guild, tournament);
    assert.ok(role1);
    const initialRoleId = role1.id;

    // Simulate moderator deleting the role from server
    await role1.delete();
    assert.equal(guild.roles.cache.has(initialRoleId), false);

    // 2. Safe recreation on missing role
    const role2 = await getOrCreateTournamentRole(guild, tournament);
    assert.ok(role2);
    assert.notEqual(role2.id, initialRoleId);
    assert.equal(role2.name, 'securitycup');

    // 3. Permission failure handling: Bot lacks Manage Roles permission
    const member = guild.members.getOrCreate('900000000000000009');
    member.guild = guild;

    // Temporarily disable ManageRoles permission on bot
    guild.members.me.permissions.has = () => false;

    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        discord_id: '900000000000000009',
        user_id: 'usr-sec-9',
        eligible_tournaments: [{ id: 'tour-sec-test', title: 'Security Cup' }],
      }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = mockServer.address().port;
    process.env.MATCHDISTRICT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const resPerm = await syncMemberTournamentRoles(member);
      assert.equal(resPerm.success, true);
      assert.equal(resPerm.assignedCount, 0); // skipped safely due to missing bot permission
      assert.equal(resPerm.skippedCount, 1);
      assert.equal(member.roles.cache.has(role2.id), false);

      // Restore permission but simulate lower hierarchy
      guild.members.me.permissions.has = () => true;
      guild.members.me.roles.highest.comparePositionTo = () => -1; // Lower hierarchy

      const resHier = await syncMemberTournamentRoles(member);
      assert.equal(resHier.success, true);
      assert.equal(resHier.assignedCount, 0); // skipped safely due to hierarchy
      assert.equal(resHier.skippedCount, 1);
      assert.equal(member.roles.cache.has(role2.id), false);

      // Restore normal hierarchy -> successfully assigns
      guild.members.me.roles.highest.comparePositionTo = () => 1;
      const resNormal = await syncMemberTournamentRoles(member);
      assert.equal(resNormal.success, true);
      assert.equal(resNormal.assignedCount, 1);
      assert.ok(member.roles.cache.has(role2.id));
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});
