import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import {
  clearInMemoryData,
  saveConfigurableTournament,
  getConfigurableTournament,
  getConfigurableTournamentByCategory,
  getConfigurableTournamentBySetupChannel,
  getAllConfigurableTournaments,
  deleteConfigurableTournament,
  saveConfigurableRegistration,
  getConfigurableRegistration,
  getConfigurableRegistrationsForTournament,
  findConfigurableRegistrationByChannelId,
  getAllActiveConfigurableRegistrations,
  deleteConfigurableRegistration,
  saveConfigurableTeam,
  getConfigurableTeam,
  getConfigurableTeamByName,
  getConfigurableTeamsForUser,
  getEnrolledTeamsCount,
  deleteConfigurableTeam,
  saveConfigurableEntry,
  getConfigurableEntry,
  getConfigurableEntriesForRegistration,
  getRegistrationEntriesCount,
  getNextAvailableSlot,
  deleteConfigurableEntry,
} from '../configurableTournamentData.js';

import {
  buildDashboardEmbed,
  buildDashboardButtons,
  handleSetupTournamentCommand,
  handleCreateStandardChannels,
  handleConfigurableChannelUpdate,
} from '../configurableTournamentService.js';

import {
  buildEnrollmentEmbed,
  buildEnrollmentComponents,
} from '../teamEnrollmentService.js';

import {
  buildRegistrationEmbed,
  buildRegistrationComponents,
  handleRegisterSquadButtonClick,
} from '../configurableRegistrationService.js';

import {
  buildSlotChartEmbed,
} from '../slotChartService.js';

import {
  checkRegistrationLifecycles,
  reconcileConfigurableTournaments,
} from '../registrationScheduler.js';

test.beforeEach(() => {
  clearInMemoryData();
});

// ----------------------------------------------------
// 1. Initial Setup Command & Dashboard Tests
// ----------------------------------------------------

test('Setup Command - Rejects execution outside of a Discord Category', async () => {
  let replyMessage = null;
  const mockMessage = {
    guild: { id: 'guild-123' },
    channel: { id: 'channel-123', parent: null }, // No category parent
    author: { id: 'user-admin' },
    member: {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator,
      },
    },
    reply: async (msg) => {
      replyMessage = typeof msg === 'string' ? msg : msg.content;
    },
  };

  await handleSetupTournamentCommand(mockMessage);
  assert.match(replyMessage, /Invalid Location/);
});

test('Setup Command - Rejects users without Manage Server or Administrator permissions', async () => {
  let replyMessage = null;
  const mockMessage = {
    guild: { id: 'guild-123' },
    channel: {
      id: 'channel-123',
      parent: { id: 'cat-123', type: ChannelType.GuildCategory },
    },
    author: { id: 'user-normal' },
    member: {
      permissions: {
        has: () => false,
      },
    },
    reply: async (msg) => {
      replyMessage = typeof msg === 'string' ? msg : msg.content;
    },
  };

  await handleSetupTournamentCommand(mockMessage);
  assert.match(replyMessage, /You need `Manage Server` or `Administrator`/);
});

test('Setup Command - Auto-detects category and generates persistent dashboard', async () => {
  const categoryId = 'cat-scrims-999';
  const setupChannelId = 'setup-chan-111';
  let sentMessage = null;

  const mockChannel = {
    id: setupChannelId,
    parent: { id: categoryId, name: 'T3 Daily Scrims', type: ChannelType.GuildCategory },
    isTextBased: () => true,
    send: async (payload) => {
      sentMessage = { id: 'dash-msg-1', ...payload };
      return sentMessage;
    },
    messages: {
      fetch: async () => null,
    },
  };

  const mockClient = {
    channels: {
      fetch: async (id) => (id === setupChannelId ? mockChannel : null),
    },
  };

  const mockMessage = {
    guild: { id: 'guild-123' },
    channel: mockChannel,
    author: { id: 'user-admin' },
    client: mockClient,
    member: {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator,
      },
    },
    delete: async () => {},
  };

  await handleSetupTournamentCommand(mockMessage);

  const tour = await getConfigurableTournamentByCategory('guild-123', categoryId);
  assert.ok(tour, 'Tournament should be created in database');
  assert.equal(tour.categoryId, categoryId);
  assert.equal(tour.setupChannelId, setupChannelId);
  assert.equal(tour.name, 'T3 Daily Scrims');
  assert.equal(tour.dashboardMessageId, 'dash-msg-1');
  assert.ok(sentMessage, 'Dashboard message must be sent');
});

test('Dashboard Layout - ActionRows and Embed generation', () => {
  const tour = {
    tournamentId: 'tour-1',
    name: 'T3 Scrims',
    categoryId: 'cat-1',
    setupChannelId: 'setup-1',
    standardChannels: {
      verifyChannelId: 'v-1',
      updatesChannelId: 'u-1',
      infoChannelId: 'i-1',
    },
  };

  const regs = [
    {
      displayName: 'Group A',
      status: 'OPEN',
      totalSlots: 20,
      registrationChannelId: 'reg-1',
      idpChannelId: 'idp-1',
    },
  ];

  const embed = buildDashboardEmbed(tour, regs, 5);
  const json = embed.toJSON();

  assert.equal(json.title, '🏆 Tournament Management Dashboard');
  assert.ok(json.description.includes('**Enrolled Squads:** `5`'));
  assert.ok(json.description.includes('**Active Registrations:** `1`'));
  assert.match(json.description, /<#v-1>/);

  const rows = buildDashboardButtons('tour-1');
  assert.equal(rows.length, 2);
  const row1Buttons = rows[0].components;
  assert.equal(row1Buttons.length, 3);
  assert.equal(row1Buttons[0].data.custom_id, 'md_cfg_create_channels_tour-1');
  assert.equal(row1Buttons[1].data.custom_id, 'md_cfg_view_channels_tour-1');
  assert.equal(row1Buttons[2].data.custom_id, 'md_cfg_refresh_dash_tour-1');

  const row2Buttons = rows[1].components;
  assert.equal(row2Buttons.length, 2);
  assert.equal(row2Buttons[0].data.custom_id, 'md_cfg_add_reg_tour-1');
  assert.equal(row2Buttons[1].data.custom_id, 'md_cfg_manage_regs_tour-1');
});

// ----------------------------------------------------
// 2. Standard Channels Creation & Idempotency
// ----------------------------------------------------

test('Standard Channels - Creates T3-Verify, T3-Updates, T3-Info idempotently', async () => {
  const tour = await saveConfigurableTournament({
    tournamentId: 'tour-test-std',
    guildId: 'guild-1',
    categoryId: 'cat-1',
    setupChannelId: 'setup-1',
    name: 'T3 Scrims',
  });

  const createdChannels = [];
  const mockGuild = {
    id: 'guild-1',
    roles: { everyone: { id: 'role-everyone' } },
    channels: {
      create: async (spec) => {
        const chan = { id: `mock-${spec.name}`, ...spec, isTextBased: () => true, send: async () => ({ id: 'msg-1' }) };
        createdChannels.push(chan);
        return chan;
      },
      fetch: async (id) => createdChannels.find((c) => c.id === id) || null,
    },
  };

  let deferred = false;
  let replyText = '';
  const mockInteraction = {
    guild: mockGuild,
    client: {
      channels: {
        fetch: async (id) => createdChannels.find((c) => c.id === id) || null,
      },
    },
    deferReply: async () => { deferred = true; },
    editReply: async (payload) => { replyText = payload.content; },
  };

  await handleCreateStandardChannels(mockInteraction, 'tour-test-std');

  assert.ok(deferred);
  assert.match(replyText, /Standard channels created successfully/);
  assert.equal(createdChannels.length, 3);
  assert.equal(createdChannels[0].name, 'T3-verify');
  assert.equal(createdChannels[1].name, 'T3-updates');
  assert.equal(createdChannels[2].name, 'T3-info');

  const updatedTour = await getConfigurableTournament('tour-test-std');
  assert.equal(updatedTour.standardChannels.verifyChannelId, 'mock-T3-verify');
  assert.equal(updatedTour.standardChannels.updatesChannelId, 'mock-T3-updates');
  assert.equal(updatedTour.standardChannels.infoChannelId, 'mock-T3-info');

  // Second invocation should detect channels already exist
  let secondReplyText = '';
  const secondInteraction = {
    guild: mockGuild,
    deferReply: async () => {},
    editReply: async (payload) => { secondReplyText = payload.content; },
  };

  await handleCreateStandardChannels(secondInteraction, 'tour-test-std');
  assert.match(secondReplyText, /already exist for this tournament/);
  // Still exactly 3 channels
  assert.equal(createdChannels.length, 3);
});

// ----------------------------------------------------
// 3. Shared Team Enrollment Tests
// ----------------------------------------------------

test('Team Enrollment - Renders Squad Enrollment embed and button', () => {
  const tour = { tournamentId: 'tour-100', name: 'Summer Cup' };
  const embed = buildEnrollmentEmbed(tour);
  assert.match(embed.toJSON().title, /Squad Enrollment — Summer Cup/);

  const row = buildEnrollmentComponents('tour-100');
  assert.equal(row.components[0].data.custom_id, 'md_cfg_enroll_tour-100');
});

test('Team Enrollment - Saves team with 4 distinct players and leader', async () => {
  const tournamentId = 'tour-enroll-test';
  const teamDoc = {
    teamId: 'team-alpha',
    tournamentId,
    guildId: 'guild-1',
    teamName: 'Phoenix Esports',
    leaderDiscordId: 'leader-1',
    players: [
      { discordId: 'leader-1', ign: 'PhoenixKing', uid: '11111' },
      { discordId: 'player-2', ign: 'SniperPro', uid: '22222' },
      { discordId: 'player-3', ign: 'Rusher007', uid: '33333' },
      { discordId: 'player-4', ign: 'SupportGod', uid: '44444' },
    ],
    substitutes: [],
    enrolledAt: new Date(),
  };

  await saveConfigurableTeam(teamDoc);

  // Retrieve by name case-insensitive
  const retrieved = await getConfigurableTeamByName(tournamentId, 'phoenix esports');
  assert.ok(retrieved);
  assert.equal(retrieved.teamId, 'team-alpha');
  assert.equal(retrieved.leaderDiscordId, 'leader-1');
  assert.equal(retrieved.players.length, 4);

  // Count enrolled teams
  const count = await getEnrolledTeamsCount(tournamentId);
  assert.equal(count, 1);

  // Find teams for user (leader and teammate)
  const leaderTeams = await getConfigurableTeamsForUser(tournamentId, 'leader-1');
  assert.equal(leaderTeams.length, 1);
  const playerTeams = await getConfigurableTeamsForUser(tournamentId, 'player-3');
  assert.equal(playerTeams.length, 1);
  const outsiderTeams = await getConfigurableTeamsForUser(tournamentId, 'stranger-9');
  assert.equal(outsiderTeams.length, 0);
});

// ----------------------------------------------------
// 4. Multiple Independent Registrations & Eligibility
// ----------------------------------------------------

test('Multiple Independent Registrations - Same enrolled team can register in multiple instances', async () => {
  const tournamentId = 'tour-multi-reg';
  const leaderId = 'leader-multi';

  // 1. Enrolled team
  await saveConfigurableTeam({
    teamId: 'team-multi',
    tournamentId,
    guildId: 'guild-1',
    teamName: 'Team Multi',
    leaderDiscordId: leaderId,
    players: [
      { discordId: leaderId, ign: 'M1', uid: '101' },
      { discordId: 'm2', ign: 'M2', uid: '102' },
      { discordId: 'm3', ign: 'M3', uid: '103' },
      { discordId: 'm4', ign: 'M4', uid: '104' },
    ],
  });

  // 2. Create Instance 1: Group A
  const regA = await saveConfigurableRegistration({
    registrationId: 'reg-a',
    tournamentId,
    guildId: 'guild-1',
    registrationNumber: 1,
    displayName: 'Group A',
    totalSlots: 16,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-a',
    idpChannelId: 'chan-idp-a',
  });

  // 3. Create Instance 2: Group B
  const regB = await saveConfigurableRegistration({
    registrationId: 'reg-b',
    tournamentId,
    guildId: 'guild-1',
    registrationNumber: 2,
    displayName: 'Group B',
    totalSlots: 16,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-b',
    idpChannelId: 'chan-idp-b',
  });

  // Mock IDP channel overwrite edit tracking
  const idpPermissionsGranted = [];
  const mockGuild = {
    channels: {
      fetch: async (id) => ({
        id,
        permissionOverwrites: {
          edit: async (userId, perms) => {
            idpPermissionsGranted.push({ channelId: id, userId, perms });
          },
        },
      }),
    },
  };

  const createMockRegisterInteraction = (regId, userId) => {
    let replyPayload = null;
    return {
      guild: mockGuild,
      guildId: 'guild-1',
      user: { id: userId },
      client: {
        channels: { fetch: async () => ({ isTextBased: () => true, send: async () => ({ id: 'msg' }), messages: { fetch: async () => null } }) },
      },
      reply: async (payload) => {
        replyPayload = payload;
      },
      getReply: () => replyPayload,
    };
  };

  // 4. Team Leader registers in Group A -> SUCCESS
  const intA = createMockRegisterInteraction('reg-a', leaderId);
  await handleRegisterSquadButtonClick(intA, 'reg-a');
  assert.match(intA.getReply().content, /Registration Confirmed/);
  assert.ok(intA.getReply().content.includes('**Slot Number:** `#1`'));

  // 5. Team Leader attempts to register in Group A AGAIN -> REJECTED
  const intA2 = createMockRegisterInteraction('reg-a', leaderId);
  await handleRegisterSquadButtonClick(intA2, 'reg-a');
  assert.match(intA2.getReply().content, /already registered in this instance/);

  // 6. Team Leader registers in Group B -> SUCCESS (Multiple Registration Eligibility)
  const intB = createMockRegisterInteraction('reg-b', leaderId);
  await handleRegisterSquadButtonClick(intB, 'reg-b');
  assert.match(intB.getReply().content, /Registration Confirmed/);
  assert.ok(intB.getReply().content.includes('**Slot Number:** `#1`'));

  // Verify Entries in Database
  const entriesA = await getConfigurableEntriesForRegistration('reg-a');
  const entriesB = await getConfigurableEntriesForRegistration('reg-b');
  assert.equal(entriesA.length, 1);
  assert.equal(entriesB.length, 1);
  assert.equal(entriesA[0].teamId, 'team-multi');
  assert.equal(entriesB[0].teamId, 'team-multi');
});

// ----------------------------------------------------
// 5. Strict IDP Permissions Tests
// ----------------------------------------------------

test('Strict IDP Permissions - ONLY the Team Leader receives access to the IDP channel', async () => {
  const tournamentId = 'tour-strict-idp';
  const leaderId = 'leader-strict-123';
  const teammateId = 'teammate-456';

  await saveConfigurableTeam({
    teamId: 'team-strict',
    tournamentId,
    guildId: 'guild-strict',
    teamName: 'Alpha Clan',
    leaderDiscordId: leaderId,
    players: [
      { discordId: leaderId, ign: 'LeaderX', uid: '1001' },
      { discordId: teammateId, ign: 'MateY', uid: '1002' },
      { discordId: 'mate-3', ign: 'MateZ', uid: '1003' },
      { discordId: 'mate-4', ign: 'MateW', uid: '1004' },
    ],
  });

  await saveConfigurableRegistration({
    registrationId: 'reg-strict',
    tournamentId,
    guildId: 'guild-strict',
    displayName: 'Finals Group',
    totalSlots: 20,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-strict',
    idpChannelId: 'chan-idp-strict',
  });

  const permissionOverwritesMap = new Map();
  const mockGuild = {
    channels: {
      fetch: async (id) => ({
        id,
        permissionOverwrites: {
          edit: async (targetUserId, perms) => {
            permissionOverwritesMap.set(targetUserId, perms);
          },
        },
      }),
    },
  };

  // Case A: Teammate (not leader) attempts to click register -> REJECTED
  let teammateReply = null;
  const teammateInteraction = {
    guild: mockGuild,
    guildId: 'guild-strict',
    user: { id: teammateId },
    client: { channels: { fetch: async () => null } },
    reply: async (p) => { teammateReply = p; },
  };

  await handleRegisterSquadButtonClick(teammateInteraction, 'reg-strict');
  assert.match(teammateReply.content, /You are not a verified Team Leader/);
  assert.equal(permissionOverwritesMap.has(teammateId), false, 'Teammate must NOT get permission overwrite');

  // Case B: Leader clicks register -> SUCCEEDS & gets IDP channel access
  let leaderReply = null;
  const leaderInteraction = {
    guild: mockGuild,
    guildId: 'guild-strict',
    user: { id: leaderId },
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => ({ id: 'msg-idp' }),
          messages: { fetch: async () => null },
        }),
      },
    },
    reply: async (p) => { leaderReply = p; },
  };

  await handleRegisterSquadButtonClick(leaderInteraction, 'reg-strict');
  assert.match(leaderReply.content, /Registration Confirmed/);

  // Verify strictly leader received ViewChannel
  assert.equal(permissionOverwritesMap.has(leaderId), true, 'Leader MUST receive overwrite');
  const leaderPerms = permissionOverwritesMap.get(leaderId);
  assert.equal(leaderPerms.ViewChannel, true);
  assert.equal(leaderPerms.ReadMessageHistory, true);
  assert.equal(permissionOverwritesMap.has(teammateId), false, 'Teammate must NEVER receive overwrite');
});

// ----------------------------------------------------
// 6. Automatic Slot Chart System
// ----------------------------------------------------

test('Slot Chart - Renders filled and available slots cleanly', () => {
  const registration = {
    displayName: 'Grand Finals',
    status: 'OPEN',
    totalSlots: 12,
  };

  const entries = [
    { slotNumber: 1, teamName: 'Team Solo', leaderDiscordId: 'user-1' },
    { slotNumber: 3, teamName: 'Team Duo', leaderDiscordId: 'user-3' },
  ];

  const embed = buildSlotChartEmbed(registration, entries);
  const json = embed.toJSON();

  assert.equal(json.title, '📋 Slot Chart — Grand Finals');
  assert.ok(json.description.includes('**Filled:** `2/12`'));
  assert.ok(json.description.includes('**Available:** `10`'));

  // Field verification
  const field1 = json.fields[0];
  assert.match(field1.value, /`\[#01\]` \*\*Team Solo\*\* \(<@user-1>\)/);
  assert.match(field1.value, /`\[#02\]` \*\[Available\]\*/);
  assert.match(field1.value, /`\[#03\]` \*\*Team Duo\*\* \(<@user-3>\)/);
});

test('Slot Allocation - getNextAvailableSlot assigns lowest available slot', async () => {
  const regId = 'reg-slot-test';
  await saveConfigurableEntry({ registrationId: regId, teamId: 't1', slotNumber: 1, status: 'CONFIRMED' });
  await saveConfigurableEntry({ registrationId: regId, teamId: 't2', slotNumber: 2, status: 'CONFIRMED' });
  await saveConfigurableEntry({ registrationId: regId, teamId: 't4', slotNumber: 4, status: 'CONFIRMED' });

  // Slot 3 is missing, so it should allocate slot 3
  const nextSlot = await getNextAvailableSlot(regId, 10);
  assert.equal(nextSlot, 3);

  // Fill slot 3
  await saveConfigurableEntry({ registrationId: regId, teamId: 't3', slotNumber: 3, status: 'CONFIRMED' });
  const nextSlotAfter3 = await getNextAvailableSlot(regId, 10);
  assert.equal(nextSlotAfter3, 5);
});

// ----------------------------------------------------
// 7. Channel Renaming Synchronization
// ----------------------------------------------------

test('Channel Renaming - Renaming registration channel automatically renames linked IDP channel', async () => {
  await saveConfigurableRegistration({
    registrationId: 'reg-rename-test',
    tournamentId: 'tour-1',
    displayName: 'Group A',
    registrationChannelId: 'chan-reg-123',
    idpChannelId: 'chan-idp-456',
  });

  let renamedTarget = null;
  const mockGuild = {
    channels: {
      fetch: async (id) => {
        if (id === 'chan-idp-456') {
          return {
            id: 'chan-idp-456',
            name: 'group-a-idp',
            setName: async (newName) => {
              renamedTarget = newName;
            },
          };
        }
        return null;
      },
    },
  };

  const oldChannel = { id: 'chan-reg-123', name: 'group-a-reg', guild: mockGuild };
  const newChannel = { id: 'chan-reg-123', name: 'finals-reg', guild: mockGuild };

  await handleConfigurableChannelUpdate(oldChannel, newChannel);

  assert.equal(renamedTarget, 'finals-idp', 'Linked IDP channel must be renamed to match registration channel');
});

test('Channel Renaming - Renaming IDP channel does NOT trigger rename of registration channel (no loop)', async () => {
  await saveConfigurableRegistration({
    registrationId: 'reg-no-loop',
    tournamentId: 'tour-1',
    displayName: 'Group A',
    registrationChannelId: 'chan-reg-123',
    idpChannelId: 'chan-idp-456',
  });

  let renameCalled = false;
  const mockGuild = {
    channels: {
      fetch: async () => ({
        setName: async () => { renameCalled = true; },
      }),
    },
  };

  const oldIdpChannel = { id: 'chan-idp-456', name: 'group-a-idp', guild: mockGuild };
  const newIdpChannel = { id: 'chan-idp-456', name: 'custom-idp', guild: mockGuild };

  await handleConfigurableChannelUpdate(oldIdpChannel, newIdpChannel);
  assert.equal(renameCalled, false, 'Renaming IDP channel must never trigger a rename cascade');
});

// ----------------------------------------------------
// 8. Lifecycle Management & Background Scheduler
// ----------------------------------------------------

test('Lifecycle Scheduler - Transitions UPCOMING to OPEN and OPEN to CLOSED based on time', async () => {
  const now = Date.now();
  const pastTime = new Date(now - 10000).toISOString();
  const futureTime = new Date(now + 60000).toISOString();

  // Registration 1: Was UPCOMING, start time is now past -> should become OPEN
  await saveConfigurableRegistration({
    registrationId: 'reg-sched-1',
    tournamentId: 'tour-1',
    displayName: 'Auto Open Test',
    status: 'UPCOMING',
    startsAt: pastTime,
    registrationChannelId: 'reg-c1',
    idpChannelId: 'idp-c1',
  });

  // Registration 2: Was OPEN, end time is now past -> should become CLOSED
  await saveConfigurableRegistration({
    registrationId: 'reg-sched-2',
    tournamentId: 'tour-1',
    displayName: 'Auto Close Test',
    status: 'OPEN',
    endsAt: pastTime,
    registrationChannelId: 'reg-c2',
    idpChannelId: 'idp-c2',
  });

  const mockClient = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: { fetch: async () => null },
        send: async () => ({ id: 'msg-dummy' }),
      }),
    },
  };

  await checkRegistrationLifecycles(mockClient);

  const updated1 = await getConfigurableRegistration('reg-sched-1');
  const updated2 = await getConfigurableRegistration('reg-sched-2');

  assert.equal(updated1.status, 'OPEN', 'UPCOMING registration past start time must become OPEN');
  assert.equal(updated2.status, 'CLOSED', 'OPEN registration past end time must become CLOSED');
});

// ----------------------------------------------------
// 9. Startup Reconciliation & Restart Recovery
// ----------------------------------------------------

test('Startup Reconciliation - Restores IDP permissions and messages on restart', async () => {
  const tour = await saveConfigurableTournament({
    tournamentId: 'tour-restart',
    guildId: 'guild-restart',
    setupChannelId: 'setup-restart',
    name: 'Restart Tour',
    standardChannels: {
      verifyChannelId: 'verify-restart',
      updatesChannelId: 'updates-restart',
      infoChannelId: 'info-restart',
    },
  });

  await saveConfigurableRegistration({
    registrationId: 'reg-restart',
    tournamentId: 'tour-restart',
    guildId: 'guild-restart',
    displayName: 'Restart Reg',
    totalSlots: 20,
    status: 'OPEN',
    registrationChannelId: 'reg-chan-restart',
    idpChannelId: 'idp-chan-restart',
  });

  await saveConfigurableEntry({
    registrationId: 'reg-restart',
    tournamentId: 'tour-restart',
    guildId: 'guild-restart',
    teamId: 'team-res',
    teamName: 'Team Resilient',
    leaderDiscordId: 'leader-res-99',
    slotNumber: 1,
    status: 'CONFIRMED',
  });

  const restoredOverwrites = [];
  const mockIdpChannel = {
    id: 'idp-chan-restart',
    isTextBased: () => true,
    messages: { fetch: async () => null },
    send: async () => ({ id: 'slotchart-msg' }),
    permissionOverwrites: {
      edit: async (userId, perms) => {
        restoredOverwrites.push({ userId, perms });
      },
    },
  };

  const mockClient = {
    channels: {
      fetch: async (id) => {
        if (id === 'idp-chan-restart') return mockIdpChannel;
        return {
          id,
          isTextBased: () => true,
          messages: { fetch: async () => null },
          send: async () => ({ id: 'dummy-msg' }),
        };
      },
    },
    guilds: {
      fetch: async () => ({
        channels: {
          fetch: async (id) => (id === 'idp-chan-restart' ? mockIdpChannel : null),
        },
      }),
    },
  };

  await reconcileConfigurableTournaments(mockClient);

  assert.equal(restoredOverwrites.length, 1);
  assert.equal(restoredOverwrites[0].userId, 'leader-res-99');
  assert.equal(restoredOverwrites[0].perms.ViewChannel, true);
});
