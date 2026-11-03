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
  getConfigurableEntriesForTeam,
  getRegistrationEntriesCount,
  getNextAvailableSlot,
  deleteConfigurableEntry,
  savePendingEnrollment,
  getPendingEnrollment,
  deletePendingEnrollment,
} from '../configurableTournamentData.js';

import {
  buildDashboardEmbed,
  buildDashboardButtons,
  handleSetupTournamentCommand,
  handleCreateStandardChannels,
  handleConfigurableChannelUpdate,
  handleTournamentSettingsButton,
  handleSetRequiredMembers,
  TOURNAMENT_DENIED_PERMISSIONS,
} from '../configurableTournamentService.js';

import {
  buildEnrollmentEmbed,
  buildEnrollmentComponents,
  handleEnrollButtonClick,
  showStep1Modal,
  handleStep1ModalSubmit,
  showStep2Modal,
  handleStep2ModalSubmit,
  showStep3Modal,
  handleStep3ModalSubmit,
  handleSkipSubstitutes,
  showStep4Confirmation,
  showStep5DiscordSelection,
  handleStep5UserSelect,
  handleManageMySquadButton,
  handleEditSquadButtonClick,
  handleDeleteSquadPrompt,
  handleDeleteSquadConfirm,
  handleDeleteSquadCancel,
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
    channel: { id: 'channel-123', parent: null },
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
  let categoryOverwrites = null;

  const mockCategory = {
    id: categoryId,
    name: 'T3 Daily Scrims',
    type: ChannelType.GuildCategory,
    permissionOverwrites: {
      edit: async (roleId, perms) => {
        categoryOverwrites = { roleId, perms };
      },
    },
  };

  const mockChannel = {
    id: setupChannelId,
    parent: mockCategory,
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
    guild: { id: 'guild-123', roles: { everyone: { id: 'role-everyone' } } },
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
  assert.ok(categoryOverwrites, 'Category permissions must be edited');
  assert.equal(categoryOverwrites.perms.CreatePublicThreads, false);
});

test('Dashboard Layout - ActionRows and Embed generation', () => {
  const tour = {
    tournamentId: 'tour-1',
    name: 'T3 Scrims',
    categoryId: 'cat-1',
    setupChannelId: 'setup-1',
    requiredDiscordMembers: 4,
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
  assert.ok(json.description.includes('**Required Discord Members:** `4 Members`'));
  assert.match(json.description, /<#v-1>/);

  const rows = buildDashboardButtons('tour-1');
  assert.equal(rows.length, 2);
  const row1Buttons = rows[0].components;
  assert.equal(row1Buttons.length, 3);
  assert.equal(row1Buttons[0].data.custom_id, 'md_cfg_create_channels_tour-1');
  assert.equal(row1Buttons[1].data.custom_id, 'md_cfg_view_channels_tour-1');
  assert.equal(row1Buttons[2].data.custom_id, 'md_cfg_refresh_dash_tour-1');

  const row2Buttons = rows[1].components;
  assert.equal(row2Buttons.length, 3);
  assert.equal(row2Buttons[0].data.custom_id, 'md_cfg_add_reg_tour-1');
  assert.equal(row2Buttons[1].data.custom_id, 'md_cfg_manage_regs_tour-1');
  assert.equal(row2Buttons[2].data.custom_id, 'md_cfg_settings_tour-1');
});

// ----------------------------------------------------
// 2. Standard Channels Creation & Permissions
// ----------------------------------------------------

test('Standard Channels - Creates T3-Verify, T3-Updates, T3-Info with threads disabled', async () => {
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

  // Verify threads are explicitly denied on standard channels
  for (const chan of createdChannels) {
    const everyoneOverwrite = chan.permissionOverwrites[0];
    assert.ok(everyoneOverwrite.deny.includes(PermissionFlagsBits.CreatePublicThreads));
    assert.ok(everyoneOverwrite.deny.includes(PermissionFlagsBits.CreatePrivateThreads));
    assert.ok(everyoneOverwrite.deny.includes(PermissionFlagsBits.SendMessagesInThreads));
  }
});

// ----------------------------------------------------
// 3. Multi-Step Enrollment Wizard Helpers & Tests
// ----------------------------------------------------

function createMockStep1Interaction(tournamentId, userId, teamName, p1Ign = 'PhoenixKing', p1Uid = '111', p2Ign = 'SniperPro', p2Uid = '222') {
  let replyPayload = null;
  return {
    id: `step1-${Date.now()}-${Math.random()}`,
    guildId: 'guild-cfg',
    user: { id: userId },
    fields: {
      getTextInputValue: (field) => {
        if (field === 'team_name') return teamName;
        if (field === 'p1_ign') return p1Ign;
        if (field === 'p1_uid') return p1Uid;
        if (field === 'p2_ign') return p2Ign;
        if (field === 'p2_uid') return p2Uid;
        return '';
      },
    },
    reply: async (p) => { replyPayload = p; return p; },
    getReply: () => replyPayload,
  };
}

function createMockStep2Interaction(tournamentId, userId, p3Ign = 'Rusher007', p3Uid = '333', p4Ign = 'SupportGod', p4Uid = '444') {
  let replyPayload = null;
  return {
    id: `step2-${Date.now()}-${Math.random()}`,
    guildId: 'guild-cfg',
    user: { id: userId },
    fields: {
      getTextInputValue: (field) => {
        if (field === 'p3_ign') return p3Ign;
        if (field === 'p3_uid') return p3Uid;
        if (field === 'p4_ign') return p4Ign;
        if (field === 'p4_uid') return p4Uid;
        return '';
      },
    },
    reply: async (p) => { replyPayload = p; return p; },
    getReply: () => replyPayload,
  };
}

function createMockStep3Interaction(tournamentId, userId, substitutes = []) {
  let replyPayload = null;
  return {
    id: `step3-${Date.now()}-${Math.random()}`,
    guildId: 'guild-cfg',
    user: { id: userId },
    fields: {
      getTextInputValue: (field) => {
        if (field === 'sub1_ign') return substitutes[0]?.ign || '';
        if (field === 'sub1_uid') return substitutes[0]?.uid || '';
        if (field === 'sub2_ign') return substitutes[1]?.ign || '';
        if (field === 'sub2_uid') return substitutes[1]?.uid || '';
        return '';
      },
    },
    reply: async (p) => { replyPayload = p; return p; },
    getReply: () => replyPayload,
  };
}

function createMockButtonInteraction(tournamentId, userId) {
  let replyPayload = null;
  let updatePayload = null;
  let modalShown = null;
  return {
    id: `btn-${Date.now()}-${Math.random()}`,
    guildId: 'guild-cfg',
    user: { id: userId },
    isButton: () => true,
    client: { channels: { fetch: async () => null } },
    reply: async (p) => { replyPayload = p; return p; },
    update: async (p) => { updatePayload = p; return p; },
    showModal: async (m) => { modalShown = m; return m; },
    getReply: () => replyPayload || updatePayload,
    getModal: () => modalShown,
  };
}

function createMockStep5SelectInteraction(tournamentId, userId, values, isServerMember = true) {
  let replyPayload = null;
  let updatePayload = null;
  return {
    id: `select-${Date.now()}-${Math.random()}`,
    guildId: 'guild-cfg',
    guild: {
      id: 'guild-cfg',
      members: {
        cache: new Map([
          [userId, { id: userId }],
          ['tm-1', { id: 'tm-1' }],
          ['tm-2', { id: 'tm-2' }],
          ['tm-3', { id: 'tm-3' }],
          ['tm-4', { id: 'tm-4' }],
        ]),
        fetch: async (id) => {
          if (!isServerMember && id === 'non-member-999') return null;
          const known = ['tm-1', 'tm-2', 'tm-3', 'tm-4', userId];
          return known.includes(id) ? { id } : null;
        },
      },
    },
    client: { channels: { fetch: async () => null } },
    user: { id: userId },
    values,
    reply: async (p) => { replyPayload = p; return p; },
    update: async (p) => { updatePayload = p; return p; },
    getReply: () => replyPayload || updatePayload,
  };
}

test('Multi-Step Enrollment - Complete all 5 steps with substitutes', async () => {
  const tourId = 'tour-5steps-complete';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    name: 'Champion Cup',
    requiredDiscordMembers: 4,
  });

  const leaderId = 'leader-complete';

  // Step 1: Submit basic team info
  const step1Int = createMockStep1Interaction(tourId, leaderId, 'Team Complete');
  await handleStep1ModalSubmit(step1Int, tourId);
  assert.ok(step1Int.getReply().embeds[0].data.title.includes('Step 1 Completed'));

  // Step 2: Submit remaining players
  const step2Int = createMockStep2Interaction(tourId, leaderId);
  await handleStep2ModalSubmit(step2Int, tourId);
  assert.ok(step2Int.getReply().embeds[0].data.title.includes('Step 3 of 5 (Substitute Players)'));

  // Step 3: Add 2 substitutes
  const step3Int = createMockStep3Interaction(tourId, leaderId, [
    { ign: 'SubOne', uid: '901' },
    { ign: 'SubTwo', uid: '902' },
  ]);
  await handleStep3ModalSubmit(step3Int, tourId);

  // Step 4: Confirmation screen
  assert.ok(step3Int.getReply().embeds[0].data.title.includes('Confirmation'));
  assert.ok(step3Int.getReply().embeds[0].data.description.includes('SubOne'));

  // Step 5: Discord selection prompt
  const step5Btn = createMockButtonInteraction(tourId, leaderId);
  await showStep5DiscordSelection(step5Btn, tourId);
  assert.ok(step5Btn.getReply().content.includes('Please select 4 Discord members'));
  // Ensure NO leader-plus-teammates terminology appears
  assert.ok(!step5Btn.getReply().content.includes('Leader +'));
  assert.ok(!step5Btn.getReply().content.includes('remaining teammates'));

  // Step 5 submit with 4 members including leader
  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1', 'tm-2', 'tm-3']);
  await handleStep5UserSelect(step5Select, tourId);
  assert.match(step5Select.getReply().content, /Your squad has been successfully enrolled/);

  // Verify team in DB
  const team = await getConfigurableTeamByName(tourId, 'Team Complete');
  assert.ok(team);
  assert.equal(team.leaderDiscordId, leaderId);
  assert.equal(team.players.length, 4);
  assert.equal(team.substitutes.length, 2);
  assert.equal(team.substitutes[0].ign, 'SubOne');
});

test('Multi-Step Enrollment - Navigate backwards without losing data', async () => {
  const tourId = 'tour-back-nav';
  const leaderId = 'leader-back';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 4,
  });

  // Step 1
  const step1Int = createMockStep1Interaction(tourId, leaderId, 'Team Reversible', 'LeadA', '10', 'LeadB', '20');
  await handleStep1ModalSubmit(step1Int, tourId);

  // Step 2
  const step2Int = createMockStep2Interaction(tourId, leaderId, 'PlayC', '30', 'PlayD', '40');
  await handleStep2ModalSubmit(step2Int, tourId);

  // Back to Step 1
  const back1Btn = createMockButtonInteraction(tourId, leaderId);
  const session = await getPendingEnrollment(tourId, leaderId);
  await showStep1Modal(back1Btn, tourId, session);

  const modal = back1Btn.getModal();
  assert.ok(modal);
  // Verify preserved inputs
  const teamNameField = modal.components[0].components[0];
  assert.equal(teamNameField.data.value, 'Team Reversible');
});

test('Multi-Step Enrollment - Skip substitutes', async () => {
  const tourId = 'tour-skip-subs';
  const leaderId = 'leader-skip';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 4,
  });

  // Steps 1 & 2
  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team No Subs'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);

  // Skip substitutes
  const skipBtn = createMockButtonInteraction(tourId, leaderId);
  await handleSkipSubstitutes(skipBtn, tourId);

  const session = await getPendingEnrollment(tourId, leaderId);
  assert.equal(session.substitutes.length, 0);

  // Step 5
  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1', 'tm-2', 'tm-3']);
  await handleStep5UserSelect(step5Select, tourId);

  const team = await getConfigurableTeamByName(tourId, 'Team No Subs');
  assert.equal(team.substitutes.length, 0);
});

// ----------------------------------------------------
// 4. Configurable Discord Members Settings (1, 2, 3, 4)
// ----------------------------------------------------

test('Configurable Members - Setting = 1 (1 Discord member selected)', async () => {
  const tourId = 'tour-cfg-1';
  const leaderId = 'leader-1';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team One'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  // Step 5 select: 1 member (the submitting user)
  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId]);
  await handleStep5UserSelect(step5Select, tourId);

  assert.match(step5Select.getReply().content, /Your squad has been successfully enrolled/);
  const team = await getConfigurableTeamByName(tourId, 'Team One');
  assert.equal(team.leaderDiscordId, leaderId);
  assert.equal(team.players[0].discordId, leaderId);
  assert.equal(team.players[1].discordId, null);
});

test('Configurable Members - Setting = 2 (2 Discord members selected)', async () => {
  const tourId = 'tour-cfg-2';
  const leaderId = 'leader-2';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 2,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team Two'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1']);
  await handleStep5UserSelect(step5Select, tourId);

  assert.match(step5Select.getReply().content, /Your squad has been successfully enrolled/);
  const team = await getConfigurableTeamByName(tourId, 'Team Two');
  assert.equal(team.players[0].discordId, leaderId);
  assert.equal(team.players[1].discordId, 'tm-1');
  assert.equal(team.players[2].discordId, null);
});

test('Configurable Members - Setting = 3 (3 Discord members selected)', async () => {
  const tourId = 'tour-cfg-3';
  const leaderId = 'leader-3';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 3,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team Three'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1', 'tm-2']);
  await handleStep5UserSelect(step5Select, tourId);

  const team = await getConfigurableTeamByName(tourId, 'Team Three');
  assert.equal(team.players[0].discordId, leaderId);
  assert.equal(team.players[1].discordId, 'tm-1');
  assert.equal(team.players[2].discordId, 'tm-2');
  assert.equal(team.players[3].discordId, null);
});

test('Configurable Members - Setting = 4 (4 Discord members selected - Default)', async () => {
  const tourId = 'tour-cfg-4';
  const leaderId = 'leader-4';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    // default 4
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team Four'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1', 'tm-2', 'tm-3']);
  await handleStep5UserSelect(step5Select, tourId);

  const team = await getConfigurableTeamByName(tourId, 'Team Four');
  assert.equal(team.players[0].discordId, leaderId);
  assert.equal(team.players[1].discordId, 'tm-1');
  assert.equal(team.players[2].discordId, 'tm-2');
  assert.equal(team.players[3].discordId, 'tm-3');
});

// ----------------------------------------------------
// 5. Discord Mention Validations
// ----------------------------------------------------

test('Validation - Submitting user must be included in selected members', async () => {
  const tourId = 'tour-val-submitting';
  const leaderId = 'leader-sub';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 2,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team No Self'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  // Leader selects 2 other members, omitting themselves
  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, ['tm-1', 'tm-2']);
  await handleStep5UserSelect(step5Select, tourId);

  assert.match(step5Select.getReply().content, /include your own Discord account/);
});

test('Validation - Duplicate member selections are rejected', async () => {
  const tourId = 'tour-val-dup';
  const leaderId = 'leader-dup';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 3,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team Dup'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1', 'tm-1']);
  await handleStep5UserSelect(step5Select, tourId);

  assert.match(step5Select.getReply().content, /Duplicate member selections/);
});

test('Validation - Non-server members are rejected', async () => {
  const tourId = 'tour-val-non-server';
  const leaderId = 'leader-ext';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 2,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team Ext'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);

  const step5Select = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'non-member-999'], false);
  await handleStep5UserSelect(step5Select, tourId);

  assert.match(step5Select.getReply().content, /not a member of this Discord server/);
});

// ----------------------------------------------------
// 6. Squad Management (Edit & Delete Squad)
// ----------------------------------------------------

test('Squad Management - Edit Squad updates name, players, and preserves registrations', async () => {
  const tourId = 'tour-edit-test';
  const leaderId = 'leader-editor';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 2,
  });

  // Enroll team initially
  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Initial Name'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);
  await handleStep5UserSelect(createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1']), tourId);

  const initialTeam = await getConfigurableTeamByName(tourId, 'Initial Name');
  assert.ok(initialTeam);

  // Register in an instance
  await saveConfigurableRegistration({
    registrationId: 'reg-edit-check',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Match 1',
    totalSlots: 10,
    status: 'OPEN',
    registrationChannelId: 'c-reg',
    idpChannelId: 'c-idp',
  });

  await saveConfigurableEntry({
    registrationId: 'reg-edit-check',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    teamId: initialTeam.teamId,
    teamName: initialTeam.teamName,
    leaderDiscordId: leaderId,
    slotNumber: 1,
    status: 'CONFIRMED',
  });

  // Non-leader attempting to edit -> blocked
  const unauthorizedBtn = createMockButtonInteraction(tourId, 'imposter-user');
  await handleEditSquadButtonClick(unauthorizedBtn, initialTeam.teamId);
  assert.match(unauthorizedBtn.getReply().content, /Only the original team leader can edit/);

  // Leader edits squad
  const editBtn = createMockButtonInteraction(tourId, leaderId);
  await handleEditSquadButtonClick(editBtn, initialTeam.teamId);

  // Proceed with updated Step 1 (new name)
  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Updated Name', 'NewP1', '999'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);
  const finishEditSelect = createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-2']);
  await handleStep5UserSelect(finishEditSelect, tourId);

  assert.match(finishEditSelect.getReply().content, /Your squad has been successfully updated/);

  // Verify same team ID preserved
  const updatedTeam = await getConfigurableTeam(initialTeam.teamId);
  assert.equal(updatedTeam.teamName, 'Updated Name');
  assert.equal(updatedTeam.players[0].ign, 'NewP1');
  assert.equal(updatedTeam.players[1].discordId, 'tm-2');

  // Verify registration entry team name updated and slot preserved
  const entry = await getConfigurableEntry('reg-edit-check', initialTeam.teamId);
  assert.equal(entry.teamName, 'Updated Name');
  assert.equal(entry.slotNumber, 1);
});

test('Squad Management - Delete Squad with confirmation releases slots and IDP access', async () => {
  const tourId = 'tour-del-test';
  const leaderId = 'leader-delete';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    setupChannelId: 'setup-chan',
    requiredDiscordMembers: 2,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Delete Me'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);
  await handleStep5UserSelect(createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1']), tourId);

  const team = await getConfigurableTeamByName(tourId, 'Delete Me');

  await saveConfigurableRegistration({
    registrationId: 'reg-del-check',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Match 1',
    totalSlots: 10,
    status: 'OPEN',
    registrationChannelId: 'c-reg',
    idpChannelId: 'c-idp',
  });

  await saveConfigurableEntry({
    registrationId: 'reg-del-check',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    teamId: team.teamId,
    teamName: team.teamName,
    leaderDiscordId: leaderId,
    slotNumber: 5,
    status: 'CONFIRMED',
  });

  // 1. Non-leader blocked
  const imposterBtn = createMockButtonInteraction(tourId, 'stranger');
  await handleDeleteSquadPrompt(imposterBtn, team.teamId);
  assert.match(imposterBtn.getReply().content, /Only the original team leader/);

  // 2. Leader prompts deletion
  const promptBtn = createMockButtonInteraction(tourId, leaderId);
  await handleDeleteSquadPrompt(promptBtn, team.teamId);
  assert.ok(promptBtn.getReply().content.includes('Are you sure you want to delete this squad?'));

  // 3. Leader confirms deletion
  let overwriteDeleted = false;
  const mockIdpChannel = {
    permissionOverwrites: {
      delete: async (uid) => {
        if (uid === leaderId) overwriteDeleted = true;
      },
    },
  };

  const confirmBtn = {
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    guild: {
      channels: {
        fetch: async () => mockIdpChannel,
      },
    },
    update: async (p) => { confirmBtn.reply = p; },
  };

  await handleDeleteSquadConfirm(confirmBtn, team.teamId);
  assert.match(confirmBtn.reply.content, /Squad Deleted/);

  // Check team deleted from DB
  const teamAfter = await getConfigurableTeam(team.teamId);
  assert.equal(teamAfter, null);

  // Check registration entry deleted and slot freed
  const entryAfter = await getConfigurableEntry('reg-del-check', team.teamId);
  assert.equal(entryAfter, null);
  assert.equal(overwriteDeleted, true, 'Leader IDP overwrite must be revoked');
});

test('Squad Management - Cannot delete squad participating in locked/closed match', async () => {
  const tourId = 'tour-locked-match';
  const leaderId = 'leader-locked';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 2,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Live Squad'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);
  await handleStep5UserSelect(createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1']), tourId);

  const team = await getConfigurableTeamByName(tourId, 'Live Squad');

  // Closed/Live registration
  await saveConfigurableRegistration({
    registrationId: 'reg-live',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Grand Finals',
    totalSlots: 10,
    status: 'CLOSED', // locked
    registrationChannelId: 'c-reg',
    idpChannelId: 'c-idp',
  });

  await saveConfigurableEntry({
    registrationId: 'reg-live',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    teamId: team.teamId,
    teamName: team.teamName,
    leaderDiscordId: leaderId,
    slotNumber: 1,
    status: 'CONFIRMED',
  });

  const promptBtn = createMockButtonInteraction(tourId, leaderId);
  await handleDeleteSquadPrompt(promptBtn, team.teamId);
  assert.match(promptBtn.getReply().content, /Cannot Delete Squad/);
});

// ----------------------------------------------------
// 7. Multiple Registrations & Strict Leader-Only IDP Permissions
// ----------------------------------------------------

test('Multiple Independent Registrations & Leader-only IDP Access', async () => {
  const tourId = 'tour-multi-reg-suite';
  const leaderId = 'leader-multi-x';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 2,
  });

  await handleStep1ModalSubmit(createMockStep1Interaction(tourId, leaderId, 'Team Multi X'), tourId);
  await handleStep2ModalSubmit(createMockStep2Interaction(tourId, leaderId), tourId);
  await handleSkipSubstitutes(createMockButtonInteraction(tourId, leaderId), tourId);
  await handleStep5UserSelect(createMockStep5SelectInteraction(tourId, leaderId, [leaderId, 'tm-1']), tourId);

  const team = await getConfigurableTeamByName(tourId, 'Team Multi X');

  await saveConfigurableRegistration({
    registrationId: 'reg-group-1',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Group 1',
    totalSlots: 10,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-1',
    idpChannelId: 'chan-idp-1',
  });

  await saveConfigurableRegistration({
    registrationId: 'reg-group-2',
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Group 2',
    totalSlots: 10,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-2',
    idpChannelId: 'chan-idp-2',
  });

  const idpOverwrites = new Map();
  const mockGuild = {
    channels: {
      fetch: async (id) => ({
        id,
        permissionOverwrites: {
          edit: async (userId, perms) => {
            idpOverwrites.set(`${id}:${userId}`, perms);
          },
        },
      }),
    },
  };

  const regInteraction = (regId, uid) => ({
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: uid },
    client: { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => ({ id: 'm' }), messages: { fetch: async () => null } }) } },
    reply: async (p) => { regInteraction.lastReply = p; },
  });

  // Register in Group 1 -> Success
  const int1 = regInteraction('reg-group-1', leaderId);
  await handleRegisterSquadButtonClick(int1, 'reg-group-1');
  assert.match(regInteraction.lastReply.content, /Registration Confirmed/);

  // Register in Group 2 -> Success (Multiple Registrations allowed for same squad)
  const int2 = regInteraction('reg-group-2', leaderId);
  await handleRegisterSquadButtonClick(int2, 'reg-group-2');
  assert.match(regInteraction.lastReply.content, /Registration Confirmed/);

  // Verify only leader received IDP overwrites with threads disabled
  assert.equal(idpOverwrites.has('chan-idp-1:leader-multi-x'), true);
  assert.equal(idpOverwrites.has('chan-idp-1:tm-1'), false);
  const leaderPerms = idpOverwrites.get('chan-idp-1:leader-multi-x');
  assert.equal(leaderPerms.ViewChannel, true);
  assert.equal(leaderPerms.CreatePublicThreads, false);
});
