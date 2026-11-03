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
  parseReservedSlots,
  parseTimeString,
  evaluateDailyCycleStatus,
  getCurrentTimeInTimezone,
  getNextCycleDateString,
  saveDailyCycle,
  getDailyCycle,
  getDailyCyclesForRegistration,
  archiveActiveRegistrationCycle,
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
  handleAddRegistrationButton,
  handleAddRegistrationModalSubmit,
  handleRegisterSquadButtonClick,
  handleManageSelectMenu,
  handleEditRegistrationButton,
  handleEditRegistrationModalSubmit,
  handleManageReservedButton,
  handleManageReservedModalSubmit,
  handleViewCurrentSlotChart,
  handleViewPreviousCycles,
} from '../configurableRegistrationService.js';

import {
  buildSlotChartEmbed,
  updateSlotChartMessage,
  buildSlotListText,
  buildSlotListTitle,
  getFilledSlotCounter,
  buildSlotListChunks,
  changeTeamSlot,
  removeTeamFromRegistration,
} from '../slotChartService.js';

import {
  checkRegistrationLifecycles,
  reconcileConfigurableTournaments,
  executeDailyCycleReset,
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

// ----------------------------------------------------
// 6. Simplified Registration Creation & Daily Reset System Tests
// ----------------------------------------------------

test('Add Registration Modal - Exactly 4 Settings (5 Inputs) & Channel Generation', async () => {
  const tourId = 'tour-simp-reg';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-simp',
    categoryId: 'cat-simp',
  });

  let shownModal = null;
  const mockButtonInteraction = {
    showModal: async (m) => { shownModal = m; },
  };

  // 1. Open Add Registration modal
  await handleAddRegistrationButton(mockButtonInteraction, tourId);
  assert.ok(shownModal, 'Modal was presented');

  // Verify modal asks for ONLY the specified inputs
  const components = shownModal.components;
  assert.equal(components.length, 5, 'Exactly 5 action rows in modal');

  const fields = components.map((r) => r.components[0].data);
  const customIds = fields.map((f) => f.custom_id);
  assert.deepEqual(customIds, [
    'registration_name',
    'total_slots',
    'reserved_slots',
    'daily_start_time',
    'daily_reset_time',
  ]);

  // 2. Submit Add Registration Modal
  const createdChannels = [];
  const mockGuild = {
    id: 'guild-simp',
    roles: { everyone: { id: 'everyone-role' } },
    channels: {
      create: async (opts) => {
        const chan = {
          id: `chan-${opts.name}`,
          name: opts.name,
          type: opts.type,
          parent: opts.parent,
          isTextBased: () => true,
          send: async () => ({ id: `msg-${opts.name}` }),
          messages: { fetch: async () => null },
        };
        createdChannels.push(chan);
        return chan;
      },
      fetch: async (id) => createdChannels.find((c) => c.id === id) || null,
    },
  };

  let replyPayload = null;
  const mockSubmitInteraction = {
    guild: mockGuild,
    client: { channels: mockGuild.channels },
    deferReply: async () => {},
    editReply: async (p) => { replyPayload = p; },
    fields: {
      getTextInputValue: (cid) => {
        switch (cid) {
          case 'registration_name': return 'BGIS Qualifier A';
          case 'total_slots': return '32';
          case 'reserved_slots': return '1, 4, 10';
          case 'daily_start_time': return '10:00 AM';
          case 'daily_reset_time': return '02:00 AM';
          default: return '';
        }
      },
    },
  };

  await handleAddRegistrationModalSubmit(mockSubmitInteraction, tourId);

  assert.match(replyPayload.content, /Registration Instance Created/);
  assert.equal(createdChannels.length, 2);
  assert.equal(createdChannels[0].name, 'bgis-qualifier-a-reg');
  assert.equal(createdChannels[1].name, 'bgis-qualifier-a-idp');

  // Verify stored registration document
  const regs = await getConfigurableRegistrationsForTournament(tourId);
  assert.equal(regs.length, 1);
  const reg = regs[0];
  assert.equal(reg.displayName, 'BGIS Qualifier A');
  assert.equal(reg.totalSlots, 32);
  assert.deepEqual(reg.reservedSlots, [1, 4, 10]);
  assert.equal(reg.dailyStartTime, '10:00');
  assert.equal(reg.dailyResetTime, '02:00');
  assert.ok(reg.currentCycleId);
});

test('Slot Allocation - Lowest available non-reserved slot with arbitrary locked slots (1, 4, 10)', async () => {
  const regId = 'reg-alloc-test';

  // 32 slots with arbitrary locked slots 1, 4, 10
  const totalSlots = 32;
  const reservedSlots = [1, 4, 10];

  // First allocation skips slot 1 -> should be 2
  const slot1 = await getNextAvailableSlot(regId, totalSlots, reservedSlots);
  assert.equal(slot1, 2);

  // Fill slot 2
  await saveConfigurableEntry({
    registrationId: regId,
    teamId: 'team-a',
    slotNumber: 2,
    status: 'CONFIRMED',
  });

  // Next allocation should be 3
  const slot2 = await getNextAvailableSlot(regId, totalSlots, reservedSlots);
  assert.equal(slot2, 3);

  // Fill slot 3
  await saveConfigurableEntry({
    registrationId: regId,
    teamId: 'team-b',
    slotNumber: 3,
    status: 'CONFIRMED',
  });

  // Next allocation skips slot 4 (locked) -> should be 5
  const slot3 = await getNextAvailableSlot(regId, totalSlots, reservedSlots);
  assert.equal(slot3, 5);

  // Fill slots 5 through 9
  for (let s = 5; s <= 9; s++) {
    await saveConfigurableEntry({
      registrationId: regId,
      teamId: `team-${s}`,
      slotNumber: s,
      status: 'CONFIRMED',
    });
  }

  // Next allocation skips slot 10 (locked) -> should be 11
  const slot4 = await getNextAvailableSlot(regId, totalSlots, reservedSlots);
  assert.equal(slot4, 11);
});

test('Slot List Display Format - Exact title, sequential slots, status rules, and filled counter', () => {
  const tournament = { name: 'T3' };
  const reg = {
    displayName: '10PM',
    totalSlots: 18,
    reservedSlots: [1, 2],
  };

  const entries = [
    { slotNumber: 3, teamName: 'Team guardians' },
    { slotNumber: 4, teamName: 'NEMESIS ESPORTS' },
    { slotNumber: 5, teamName: 'TEAM RAGE' },
    { slotNumber: 6, teamName: 'Arc8 Esports' },
    { slotNumber: 7, teamName: 'ETERNIX ESPORTS' },
    { slotNumber: 8, teamName: 'Elite Falcons' },
    { slotNumber: 9, teamName: 'Team demonx eSports' },
    { slotNumber: 10, teamName: 'team white rage' },
    { slotNumber: 11, teamName: 'MEGNITE' },
    { slotNumber: 12, teamName: 'Team ZEROFRAME' },
    { slotNumber: 13, teamName: 'ENDLESS TEMPEST ESPORTS' },
    { slotNumber: 14, teamName: 'TRYTAN ESPORTS' },
    { slotNumber: 15, teamName: 'Team Alpha Nemesis' },
    { slotNumber: 16, teamName: 'TEAM ASHENBORN ESPORTS' },
    { slotNumber: 17, teamName: 'Fearless Legends' },
    { slotNumber: 18, teamName: 'TNR eSports' },
  ];

  const slotListText = buildSlotListText(tournament, reg, entries);
  const lines = slotListText.split('\n');

  // Title: Tournament Name + Registration Name + Slotlist
  assert.equal(lines[0], 'T3 10PM Slotlist');

  // Locked slots
  assert.equal(lines[1], 'Slot 01 → 🔒 LOCKED');
  assert.equal(lines[2], 'Slot 02 → 🔒 LOCKED');

  // Occupied slots (preserve exact team names)
  assert.equal(lines[3], 'Slot 03 → Team guardians');
  assert.equal(lines[4], 'Slot 04 → NEMESIS ESPORTS');
  assert.equal(lines[18], 'Slot 18 → TNR eSports');

  // Counter at the bottom: 16/16 filled (green)
  assert.equal(lines[19], '🟢 16/16 filled');

  // Test counter states
  assert.equal(getFilledSlotCounter(0, 16), '⚪ 0/16 filled');
  assert.equal(getFilledSlotCounter(10, 16), '🟡 10/16 filled');
  assert.equal(getFilledSlotCounter(16, 16), '🟢 16/16 filled');

  // Available slot rendering when partially filled
  const partialEntries = [{ slotNumber: 3, teamName: 'Team guardians' }];
  const partialText = buildSlotListText(tournament, reg, partialEntries);
  assert.ok(partialText.includes('Slot 04 → AVAILABLE'));
  assert.ok(partialText.includes('🟡 1/16 filled'));
});

test('Automatic Close - Automatically closes registration when all available slots are filled', async () => {
  const tourId = 'tour-autoclose';
  const regId = 'reg-autoclose';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  // 5 total slots with 2 reserved [1, 3] -> exactly 3 available slots (2, 4, 5)
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Mini Tourney',
    totalSlots: 5,
    reservedSlots: [1, 3],
    status: 'OPEN',
    registrationChannelId: 'chan-reg-close',
    idpChannelId: 'chan-idp-close',
    currentCycleId: `${regId}:2026-11-04`,
  });

  const mockGuild = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        permissionOverwrites: { edit: async () => {} },
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
      }),
    },
  };

  const regInteraction = (uid) => ({
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: uid },
    client: { channels: mockGuild.channels },
    reply: async (p) => { regInteraction.lastReply = p; },
  });

  // Enroll 4 teams
  for (let i = 1; i <= 4; i++) {
    const leaderId = `ldr-${i}`;
    await saveConfigurableTeam({
      teamId: `tm-${i}`,
      tournamentId: tourId,
      teamName: `Team ${i}`,
      leaderDiscordId: leaderId,
      players: [{ discordId: leaderId, ign: `P${i}`, uid: `U${i}` }],
    });
  }

  // Register Team 1 (allocates slot 2)
  await handleRegisterSquadButtonClick(regInteraction('ldr-1'), regId);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#2`/);

  // Register Team 2 (allocates slot 4)
  await handleRegisterSquadButtonClick(regInteraction('ldr-2'), regId);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#4`/);

  // Register Team 3 (allocates slot 5 - last available slot!)
  await handleRegisterSquadButtonClick(regInteraction('ldr-3'), regId);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#5`/);

  // Registration should now be automatically CLOSED
  const regDoc = await getConfigurableRegistration(regId);
  assert.equal(regDoc.status, 'CLOSED', 'Registration automatically closed when capacity reached');

  // Attempting to register Team 4 should be rejected
  await handleRegisterSquadButtonClick(regInteraction('ldr-4'), regId);
  assert.match(regInteraction.lastReply.content, /Registration is currently/);
});

test('Daily Data Reset System - Safely archives cycle, clears active slots, preserves team enrollments', async () => {
  const tourId = 'tour-reset-test';
  const regId = 'reg-reset-test';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Daily Scrims',
    totalSlots: 20,
    reservedSlots: [1, 2],
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    timezone: 'Asia/Kolkata',
    currentCycleId: `${regId}:2026-11-04`,
    currentCycleDate: '2026-11-04',
    status: 'OPEN',
    registrationChannelId: 'chan-reg-reset',
    idpChannelId: 'chan-idp-reset',
  });

  // Enroll team
  const leaderId = 'leader-daily-1';
  await saveConfigurableTeam({
    teamId: 'team-daily-1',
    tournamentId: tourId,
    teamName: 'Daily Warriors',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'DailyP1', uid: 'U100' }],
  });

  // Track IDP permissions
  const idpPermissions = new Map();
  idpPermissions.set(leaderId, { ViewChannel: true });

  const mockClient = {
    guilds: {
      fetch: async () => ({
        channels: {
          fetch: async (id) => ({
            id,
            isTextBased: () => true,
            permissionOverwrites: {
              delete: async (targetId) => { idpPermissions.delete(targetId); },
              edit: async () => {},
            },
            send: async () => ({ id: 'm' }),
            messages: { fetch: async () => null },
          }),
        },
      }),
    },
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
      }),
    },
  };

  const regInteraction = {
    guild: {
      channels: {
        fetch: async () => ({
          permissionOverwrites: { edit: async () => {} },
        }),
      },
    },
    guildId: 'guild-cfg',
    user: { id: leaderId },
    client: mockClient,
    reply: async (p) => { regInteraction.lastReply = p; },
  };

  // Register team in cycle 2026-11-04
  await handleRegisterSquadButtonClick(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed/);

  const activeEntriesBefore = await getConfigurableEntriesForRegistration(regId);
  assert.equal(activeEntriesBefore.length, 1);
  assert.equal(activeEntriesBefore[0].teamName, 'Daily Warriors');

  // Trigger daily cycle reset
  const resetSuccess = await executeDailyCycleReset(mockClient, regId, true);
  assert.equal(resetSuccess, true);

  // 1. Verify previous cycle was archived
  const archivedCycles = await getDailyCyclesForRegistration(regId);
  assert.equal(archivedCycles.length, 1);
  assert.equal(archivedCycles[0].cycleDate, '2026-11-04');
  assert.equal(archivedCycles[0].entries.length, 1);
  assert.equal(archivedCycles[0].entries[0].teamName, 'Daily Warriors');
  assert.equal(archivedCycles[0].status, 'COMPLETED');

  // 2. Verify team enrollment in database is NEVER deleted
  const teamDoc = await getConfigurableTeam('team-daily-1');
  assert.ok(teamDoc, 'Team enrollment doc was preserved');
  assert.equal(teamDoc.teamName, 'Daily Warriors');

  // 3. Verify active slot allocations for completed cycle are cleared
  const activeEntriesAfter = await getConfigurableEntriesForRegistration(regId);
  assert.equal(activeEntriesAfter.length, 0, 'Active confirmed entries cleared');

  // 4. Verify leader IDP access was revoked
  assert.equal(idpPermissions.has(leaderId), false, 'Leader IDP permission cleared');

  // 5. Verify registration status and cycle update
  const updatedReg = await getConfigurableRegistration(regId);
  assert.equal(updatedReg.lastResetCycleDate, '2026-11-04');
  assert.notEqual(updatedReg.currentCycleId, `${regId}:2026-11-04`);
});

test('Re-registration in Subsequent Daily Cycle - Same squad can register again in next cycle', async () => {
  const tourId = 'tour-re-reg';
  const regId = 'reg-re-reg';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Daily Scrims 2',
    totalSlots: 10,
    reservedSlots: [],
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    timezone: 'Asia/Kolkata',
    currentCycleId: `${regId}:2026-11-04`,
    currentCycleDate: '2026-11-04',
    status: 'OPEN',
    registrationChannelId: 'chan-reg-re',
    idpChannelId: 'chan-idp-re',
  });

  const leaderId = 'leader-re-reg';
  await saveConfigurableTeam({
    teamId: 'team-re-reg',
    tournamentId: tourId,
    teamName: 'Team Evergreen',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'Evergreen', uid: 'U999' }],
  });

  const mockGuild = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        permissionOverwrites: { edit: async () => {}, delete: async () => {} },
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
      }),
    },
  };

  const regInteraction = {
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: leaderId },
    client: { channels: mockGuild.channels, guilds: { fetch: async () => mockGuild } },
    reply: async (p) => { regInteraction.lastReply = p; },
  };

  // Register in cycle 1
  await handleRegisterSquadButtonClick(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed/);

  // Reset cycle 1
  await executeDailyCycleReset(regInteraction.client, regId, true);

  // Prepare next cycle 2026-11-05 and set OPEN
  const reg = await getConfigurableRegistration(regId);
  reg.status = 'OPEN';
  reg.currentCycleId = `${regId}:2026-11-05`;
  reg.currentCycleDate = '2026-11-05';
  await saveConfigurableRegistration(reg);

  // Same team registers again in cycle 2 -> MUST succeed!
  await handleRegisterSquadButtonClick(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed/);

  const entriesCycle2 = await getConfigurableEntriesForRegistration(regId);
  assert.equal(entriesCycle2.length, 1);
  assert.equal(entriesCycle2[0].teamName, 'Team Evergreen');
  assert.equal(entriesCycle2[0].cycleId, `${regId}:2026-11-05`);
});

test('Multiple Registrations Reset Independently', async () => {
  const tourId = 'tour-multi-reg-indep';
  const regAId = 'reg-alpha';
  const regBId = 'reg-beta';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
  });

  await saveConfigurableRegistration({
    registrationId: regAId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Registration Alpha (Reset at 02:00 AM)',
    totalSlots: 20,
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    currentCycleId: `${regAId}:2026-11-04`,
    currentCycleDate: '2026-11-04',
    status: 'OPEN',
  });

  await saveConfigurableRegistration({
    registrationId: regBId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Registration Beta (Reset at 04:00 AM)',
    totalSlots: 20,
    dailyStartTime: '18:00',
    dailyResetTime: '04:00',
    currentCycleId: `${regBId}:2026-11-04`,
    currentCycleDate: '2026-11-04',
    status: 'OPEN',
  });

  // Add entry to Reg A
  await saveConfigurableEntry({
    registrationId: regAId,
    teamId: 'team-a',
    teamName: 'Alpha Squad',
    slotNumber: 1,
    status: 'CONFIRMED',
    cycleId: `${regAId}:2026-11-04`,
  });

  // Add entry to Reg B
  await saveConfigurableEntry({
    registrationId: regBId,
    teamId: 'team-b',
    teamName: 'Beta Squad',
    slotNumber: 1,
    status: 'CONFIRMED',
    cycleId: `${regBId}:2026-11-04`,
  });

  // Reset only Registration Alpha
  await executeDailyCycleReset(null, regAId, true);

  // Registration Alpha active entries cleared
  const entriesA = await getConfigurableEntriesForRegistration(regAId);
  assert.equal(entriesA.length, 0);

  // Registration Beta active entries MUST remain confirmed and unaffected
  const entriesB = await getConfigurableEntriesForRegistration(regBId);
  assert.equal(entriesB.length, 1);
  assert.equal(entriesB[0].teamName, 'Beta Squad');
});

test('Bot Restart Recovery - Catches up pending reset idempotently', async () => {
  const tourId = 'tour-reconcile-test';
  const regId = 'reg-reconcile-test';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    setupChannelId: 'chan-setup-rec',
  });

  // Registration that missed its reset
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Nightly Scrim',
    totalSlots: 20,
    reservedSlots: [],
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    currentCycleId: `${regId}:2026-11-03`,
    currentCycleDate: '2026-11-03',
    lastResetCycleDate: '2026-11-02', // Last reset was 2 days ago!
    status: 'OPEN',
    registrationChannelId: 'chan-reg-rec',
    idpChannelId: 'chan-idp-rec',
  });

  await saveConfigurableEntry({
    registrationId: regId,
    teamId: 'team-rec-1',
    teamName: 'Recovery Team',
    slotNumber: 1,
    status: 'CONFIRMED',
    cycleId: `${regId}:2026-11-03`,
  });

  const mockClient = {
    guilds: {
      fetch: async () => ({
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async () => ({ id: 'm' }),
            messages: { fetch: async () => null },
            permissionOverwrites: { delete: async () => {}, edit: async () => {} },
          }),
        },
      }),
    },
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
      }),
    },
  };

  // Bot restarts and reconciles
  await reconcileConfigurableTournaments(mockClient);

  // Missed cycle should have been archived
  const cycles = await getDailyCyclesForRegistration(regId);
  assert.equal(cycles.length, 1, 'Missed cycle was safely archived on restart');

  // Second restart reconcile should NOT produce duplicate archive
  await reconcileConfigurableTournaments(mockClient);
  const cyclesAfterSecond = await getDailyCyclesForRegistration(regId);
  assert.equal(cyclesAfterSecond.length, 1, 'Idempotent: no duplicate archived cycles created');
});

test('Management Controls - Safeguards for capacity reduction and slot reservation', async () => {
  const tourId = 'tour-safeguards';
  const regId = 'reg-safeguards';

  await saveConfigurableTournament({ tournamentId: tourId, guildId: 'guild-cfg' });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    displayName: 'Safeguard Tourney',
    totalSlots: 10,
    reservedSlots: [1],
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    status: 'OPEN',
  });

  // Add 3 registered teams (occupying slots 2, 3, 4)
  for (let i = 2; i <= 4; i++) {
    await saveConfigurableEntry({
      registrationId: regId,
      teamId: `team-${i}`,
      teamName: `Team ${i}`,
      slotNumber: i,
      status: 'CONFIRMED',
    });
  }

  // 1. Safeguard: cannot reduce capacity below currently allocated slots
  let editReply = null;
  const mockEditInteraction = {
    deferReply: async () => {},
    editReply: async (p) => { editReply = p; },
    fields: {
      getTextInputValue: (cid) => {
        switch (cid) {
          case 'registration_name': return 'Safeguard Tourney';
          case 'total_slots': return '2'; // Attempting to reduce below 3 active teams!
          case 'daily_start_time': return '10:00';
          case 'daily_reset_time': return '02:00';
          default: return '';
        }
      },
    },
  };

  await handleEditRegistrationModalSubmit(mockEditInteraction, regId);
  assert.match(editReply.content, /Capacity cannot be reduced below already allocated slots/);

  // 2. Safeguard: cannot reserve a slot that is already occupied
  let reservedReply = null;
  const mockReservedInteraction = {
    deferReply: async () => {},
    editReply: async (p) => { reservedReply = p; },
    fields: {
      getTextInputValue: (cid) => '1, 3', // Slot 3 is already occupied by Team 3!
    },
  };

  await handleManageReservedModalSubmit(mockReservedInteraction, regId);
  assert.match(reservedReply.content, /cannot be reserved because they are already occupied/);
});

test('Persistent Message In-Place Editing - Updates existing message ID without sending duplicates', async () => {
  const tourId = 'tour-persist-idp';
  const regId = 'reg-persist-idp';

  await saveConfigurableTournament({
    tournamentId: tourId,
    name: 'T3',
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    displayName: '10PM',
    totalSlots: 10,
    reservedSlots: [1],
    idpChannelId: 'chan-idp-persist',
    slotChartMessageId: null,
  });

  let sentMessages = [];
  let editedMessages = [];

  const mockChannel = {
    id: 'chan-idp-persist',
    isTextBased: () => true,
    send: async (payload) => {
      const msg = {
        id: `msg-${sentMessages.length + 1}`,
        content: payload.content,
        edit: async (newPayload) => {
          msg.content = newPayload.content;
          editedMessages.push({ id: msg.id, content: newPayload.content });
          return msg;
        },
      };
      sentMessages.push(msg);
      return msg;
    },
    messages: {
      fetch: async (id) => sentMessages.find((m) => m.id === id) || null,
    },
  };

  const mockClient = {
    channels: {
      fetch: async (id) => (id === 'chan-idp-persist' ? mockChannel : null),
    },
  };

  // 1. Initial creation of slot list message
  await updateSlotChartMessage(mockClient, regId);
  assert.equal(sentMessages.length, 1, 'Sent exactly 1 initial message');
  assert.match(sentMessages[0].content, /T3 10PM Slotlist/);
  assert.match(sentMessages[0].content, /Slot 01 → 🔒 LOCKED/);
  assert.match(sentMessages[0].content, /Slot 02 → AVAILABLE/);
  assert.match(sentMessages[0].content, /⚪ 0\/9 filled/);

  const initialMsgId = sentMessages[0].id;

  // 2. Add an entry
  await saveConfigurableEntry({
    registrationId: regId,
    teamId: 'tm-guardians',
    teamName: 'Team guardians',
    slotNumber: 2,
    status: 'CONFIRMED',
  });

  // 3. Update slot chart: must edit existing message in place!
  await updateSlotChartMessage(mockClient, regId);
  assert.equal(sentMessages.length, 1, 'Did not send a second message');
  assert.equal(editedMessages.length, 1, 'Edited existing message in place');
  assert.equal(editedMessages[0].id, initialMsgId);
  assert.match(editedMessages[0].content, /Slot 02 → Team guardians/);
  assert.match(editedMessages[0].content, /🟡 1\/9 filled/);

  // 4. Organiser changes team slot from 2 to 3
  const changeRes = await changeTeamSlot(regId, 'tm-guardians', 3, mockClient);
  assert.equal(changeRes.success, true);
  assert.equal(sentMessages.length, 1, 'Still only 1 message sent');
  assert.match(sentMessages[0].content, /Slot 02 → AVAILABLE/);
  assert.match(sentMessages[0].content, /Slot 03 → Team guardians/);

  // 5. Organiser removes team
  const removeRes = await removeTeamFromRegistration(regId, 'tm-guardians', mockClient);
  assert.equal(removeRes.success, true);
  assert.match(sentMessages[0].content, /Slot 03 → AVAILABLE/);
  assert.match(sentMessages[0].content, /⚪ 0\/9 filled/);
});

test('Discord Character Limit Chunking - Splits 100 slots cleanly without exceeding limits', () => {
  const reg = {
    displayName: 'Mega 100 Slotlist',
    totalSlots: 100,
    reservedSlots: [1, 2, 3, 4],
  };

  const entries = [];
  for (let s = 5; s <= 60; s++) {
    entries.push({ slotNumber: s, teamName: `Pro Team Long Name Esports Club ${s}` });
  }

  const chunks = buildSlotListChunks({ name: 'BGIS' }, reg, entries);
  assert.ok(chunks.length > 1, 'Chunks into multiple messages when exceeding character limit');

  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1900, `Each chunk is <= 1900 chars (actual: ${chunk.length})`);
  }

  // First chunk has title
  assert.ok(chunks[0].startsWith('BGIS Mega 100 Slotlist'));

  // Last chunk has counter at the bottom
  const lastChunk = chunks[chunks.length - 1];
  assert.ok(lastChunk.endsWith('filled'), 'Counter is at the bottom of the final chunk');
});


