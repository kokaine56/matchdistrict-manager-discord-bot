import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ChannelType, PermissionFlagsBits, ButtonStyle } from 'discord.js';

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
  findConfigurableRegistrationByMessageId,
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
  cleanUpStaleConfigurableRegistrationsAndEntries,
  getConfigurableTournamentByName,
} from '../configurableTournamentData.js';

import {
  buildDashboardEmbed,
  buildDashboardButtons,
  buildTournamentPrefix,
  toMathematicalBold,
  createTournamentChannel,
  handleSetupTournamentCommand,
  handleEnterCategoryNameButton,
  handleCreateTournamentModalSubmit,
  handleDeleteTournamentButton,
  handleDeleteTournamentCancel,
  handleDeleteTournamentConfirm,
  handleCreateStandardChannels,
  handleConfigurableChannelUpdate,
  handleConfigurableChannelDelete,
  handleTournamentSettingsButton,
  handleSetRequiredMembers,
  handleConfigurableTournamentInteraction,
  TOURNAMENT_DENIED_PERMISSIONS,
} from '../configurableTournamentService.js';

import {
  buildEnrollmentEmbed,
  buildEnrollmentComponents,
  sendOrUpdateEnrollmentMessage,
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
  buildManageDashboardPayload,
  handleAddRegistrationButton,
  handleAddRegistrationModalSubmit,
  handleRegisterSquadButtonClick,
  handleConfirmRegistrationButtonClick,
  handleCancelRegistrationButtonClick,
  handleManageSelectMenu,
  handleToggleStatus,
  handleRefreshRegistration,
  handleEditRegistrationButton,
  handleEditRegistrationModalSubmit,
  handleViewCurrentSlotChart,
  handleDeleteRegistration,
} from '../configurableRegistrationService.js';

/**
 * Simulates clicking Register Squad, followed by clicking Confirm Registration if confirmation is shown.
 */
async function registerSquadFull(interaction, registrationId) {
  let replyObj = null;
  const originalReply = interaction.reply;
  interaction.reply = async (p) => {
    replyObj = p;
    interaction.lastReply = p;
    if (typeof originalReply === 'function') {
      await originalReply(p);
    }
  };
  await handleRegisterSquadButtonClick(interaction, registrationId);
  const confirmBtn = (replyObj || interaction.lastReply)?.components?.[0]?.components?.find((b) =>
    b.data?.custom_id?.startsWith('md_cfg_reg_confirm_')
  );
  if (confirmBtn) {
    const payload = confirmBtn.data.custom_id.replace('md_cfg_reg_confirm_', '');
    const [regId, teamId] = payload.includes(':') ? payload.split(':') : payload.split('_');
    await handleConfirmRegistrationButtonClick(interaction, regId, teamId);
  }
}

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

test('Setup Command - Rejects users without Manage Server or Administrator permissions', async () => {
  let replyMessage = null;
  const mockMessage = {
    guild: { id: 'guild-123' },
    channel: { id: 'channel-123' },
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

test('Setup Command - Step 1: Executable in any channel and replies with Enter Category Name button', async () => {
  let replyPayload = null;
  const mockMessage = {
    guild: { id: 'guild-123' },
    channel: { id: 'channel-random-anywhere' }, // No category needed
    author: { id: 'user-admin' },
    member: {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator,
      },
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handleSetupTournamentCommand(mockMessage);
  assert.ok(replyPayload);
  assert.match(replyPayload.content, /Tournament Setup/);
  assert.equal(replyPayload.components.length, 1);
  const btn = replyPayload.components[0].components[0];
  assert.equal(btn.data.custom_id, 'md_cfg_btn_enter_category_name');
  assert.equal(btn.data.label, 'Enter Category Name');
});

test('Setup Command - Step 2: Modal submission creates category, setup channel, posts dashboard, and returns channel link', async () => {
  const createdChannels = [];
  const mockGuild = {
    id: 'guild-step2-test',
    roles: { everyone: { id: 'everyone-role-id' } },
    members: { me: { id: 'bot-id-123' } },
    channels: {
      create: async (spec) => {
        const chan = {
          id: `chan-${createdChannels.length + 1}`,
          name: spec.name,
          type: spec.type,
          parent: spec.parent,
          isTextBased: () => true,
          send: async (msg) => ({ id: `dash-msg-1`, ...msg }),
          messages: { fetch: async () => null },
        };
        createdChannels.push(chan);
        return chan;
      },
      fetch: async (id) => createdChannels.find((c) => c.id === id) || null,
    },
  };

  const mockClient = {
    user: { id: 'bot-id-123' },
    channels: {
      fetch: async (id) => createdChannels.find((c) => c.id === id) || null,
    },
  };

  let deferred = false;
  let replyPayload = null;
  const mockModalInteraction = {
    guild: mockGuild,
    client: mockClient,
    user: { id: 'admin-user-id' },
    member: {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator,
      },
    },
    fields: {
      getTextInputValue: (cid) => (cid === 'category_name' ? 'T3 Scrims' : ''),
    },
    deferReply: async (opts) => { deferred = true; },
    editReply: async (p) => { replyPayload = p; },
  };

  await handleCreateTournamentModalSubmit(mockModalInteraction);

  assert.ok(deferred, 'Interaction was deferred');
  assert.match(replyPayload.content, /Tournament \*\*T3 Scrims\*\* created successfully/);
  assert.match(replyPayload.content, /<#chan-2>/); // Link to setup channel

  // Verify created channels: 1st is category, 2nd is setup channel
  assert.equal(createdChannels.length, 2);
  assert.equal(createdChannels[0].name, 'T3 Scrims');
  assert.equal(createdChannels[0].type, ChannelType.GuildCategory);
  assert.equal(createdChannels[1].name, '𝐓𝟑｜setup');
  assert.equal(createdChannels[1].type, ChannelType.GuildText);
  assert.equal(createdChannels[1].parent, createdChannels[0].id);

  // Verify saved in DB
  const tour = await getConfigurableTournamentByName('guild-step2-test', 'T3 Scrims');
  assert.ok(tour, 'Tournament saved to DB');
  assert.equal(tour.name, 'T3 Scrims');
  assert.equal(tour.prefix, 'T3');
  assert.equal(tour.boldPrefix, '𝐓𝟑');
  assert.equal(tour.categoryId, createdChannels[0].id);
  assert.equal(tour.setupChannelId, createdChannels[1].id);
  assert.equal(tour.dashboardMessageId, 'dash-msg-1');
});

test('Setup Command - Refuses creation if category name already exists on server', async () => {
  await saveConfigurableTournament({
    tournamentId: 'existing-tour-id',
    guildId: 'guild-dup-check',
    name: 'Champions Trophy S01',
  });

  let replyPayload = null;
  const mockModalInteraction = {
    guild: { id: 'guild-dup-check' },
    user: { id: 'admin-user-id' },
    member: {
      permissions: {
        has: () => true,
      },
    },
    fields: {
      getTextInputValue: (cid) => (cid === 'category_name' ? 'champions trophy s01' : ''),
    },
    reply: async (p) => { replyPayload = p; },
  };

  await handleCreateTournamentModalSubmit(mockModalInteraction);
  assert.ok(replyPayload);
  assert.match(replyPayload.content, /already exists on this server/);
});

test('Prefix Font & Channel Naming - Mathematical Bold and plain retry fallback', async () => {
  // Test Prefix generation logic
  assert.equal(buildTournamentPrefix('T3 Scrims'), 'T3');
  assert.equal(buildTournamentPrefix('Champions Trophy S01'), 'CTS');
  assert.equal(buildTournamentPrefix('Apex'), 'Apex');
  assert.equal(buildTournamentPrefix('Champions Trophy 2024'), 'CT');

  // Test Unicode Mathematical Bold
  assert.equal(toMathematicalBold('T3'), '𝐓𝟑');
  assert.equal(toMathematicalBold('CTS'), '𝐂𝐓𝐒');
  assert.equal(toMathematicalBold('Apex'), '𝐀𝐩𝐞𝐱');

  // Test channel creation with retry fallback on Discord rejection
  let attempt = 0;
  const created = [];
  const mockGuild = {
    channels: {
      create: async (spec) => {
        attempt++;
        if (attempt === 1) {
          throw new Error('Discord rejected Unicode Mathematical Bold');
        }
        created.push(spec);
        return { id: 'chan-fallback', ...spec };
      },
    },
  };

  const chan = await createTournamentChannel(mockGuild, {
    boldPrefix: '𝐓𝟑',
    rawPrefix: 'T3',
    fallbackSuffix: 'setup',
  });

  assert.equal(attempt, 2, 'Retried once on rejection');
  assert.equal(chan.name, 't3-setup', 'Fell back to plain lowercase channel name');
});

test('Dashboard Layout - ActionRows, Delete Tournament button, and Embed generation', () => {
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
  assert.equal(rows.length, 3, 'Must have 3 ActionRows including Delete Tournament');
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

  const row3Buttons = rows[2].components;
  assert.equal(row3Buttons.length, 1);
  assert.equal(row3Buttons[0].data.custom_id, 'md_cfg_delete_tournament_tour-1');
  assert.equal(row3Buttons[0].data.label, 'Delete Tournament');
  assert.equal(row3Buttons[0].data.style, ButtonStyle.Danger);
});

test('Delete Tournament Button - Confirmation screen and Cancel restores dashboard', async () => {
  const tourId = 'tour-del-confirm-test';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-del',
    name: 'Apex Legends Scrims',
    categoryId: 'cat-del-1',
    setupChannelId: 'setup-del-1',
  });

  const mockGuild = {
    id: 'guild-del',
    channels: {
      cache: new Map([
        ['c1', { id: 'c1', parentId: 'cat-del-1' }],
        ['c2', { id: 'c2', parentId: 'cat-del-1' }],
        ['setup-del-1', { id: 'setup-del-1', parentId: 'cat-del-1' }],
      ]),
    },
  };

  let updatePayload = null;
  const mockBtnInteraction = {
    guild: mockGuild,
    member: {
      permissions: {
        has: () => true,
      },
    },
    update: async (p) => { updatePayload = p; },
  };

  // 1. Click Delete Tournament button
  await handleDeleteTournamentButton(mockBtnInteraction, tourId);
  assert.ok(updatePayload);
  assert.match(updatePayload.content, /Delete Apex Legends Scrims\? This permanently deletes the category and all 3 channels inside it/);
  assert.equal(updatePayload.components.length, 1);
  const confirmBtn = updatePayload.components[0].components[0];
  const cancelBtn = updatePayload.components[0].components[1];
  assert.equal(confirmBtn.data.custom_id, `md_cfg_del_tour_confirm_${tourId}`);
  assert.equal(confirmBtn.data.style, ButtonStyle.Danger);
  assert.equal(cancelBtn.data.custom_id, `md_cfg_del_tour_cancel_${tourId}`);

  // 2. Click Cancel button -> Restores dashboard
  let restorePayload = null;
  const mockCancelInteraction = {
    member: { permissions: { has: () => true } },
    update: async (p) => { restorePayload = p; },
  };
  await handleDeleteTournamentCancel(mockCancelInteraction, tourId);
  assert.ok(restorePayload);
  assert.equal(restorePayload.components.length, 3, 'Restores full dashboard rows');
});

test('Delete Tournament Button - Confirm deletes channels (setup last), deletes category, cleans MongoDB', async () => {
  const tourId = 'tour-full-delete-exec';
  const catId = 'cat-full-delete';
  const setupId = 'setup-full-delete';
  const regChanId = 'reg-chan-del';
  const idpChanId = 'idp-chan-del';
  const regId = 'reg-full-del';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-full-del',
    name: 'CTS Qualifier',
    categoryId: catId,
    setupChannelId: setupId,
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    displayName: 'CTS Reg 1',
    registrationChannelId: regChanId,
    idpChannelId: idpChanId,
    currentCycleId: `${regId}:cycle-1`,
  });

  const deletedOrder = [];
  const makeChan = (id, parentId, isCat = false) => ({
    id,
    parentId,
    type: isCat ? ChannelType.GuildCategory : ChannelType.GuildText,
    name: id,
    guild: {
      channels: {
        cache: {
          has: () => true,
        },
      },
    },
    delete: async () => {
      deletedOrder.push(id);
    },
  });

  const allChannelsMap = new Map([
    [regChanId, makeChan(regChanId, catId)],
    [idpChanId, makeChan(idpChanId, catId)],
    [setupId, makeChan(setupId, catId)],
    [catId, makeChan(catId, null, true)],
  ]);

  const mockGuild = {
    id: 'guild-full-del',
    channels: {
      cache: allChannelsMap,
      fetch: async (id) => allChannelsMap.get(id) || null,
    },
  };

  let deferred = false;
  let replyPayload = null;
  const mockConfirmInteraction = {
    guild: mockGuild,
    client: {
      channels: { fetch: async (id) => allChannelsMap.get(id) || null },
    },
    member: { permissions: { has: () => true } },
    deferReply: async () => { deferred = true; },
    editReply: async (p) => { replyPayload = p; },
  };

  await handleDeleteTournamentConfirm(mockConfirmInteraction, tourId);

  assert.ok(deferred, 'Confirm deferred reply');
  assert.match(replyPayload.content, /Tournament "CTS Qualifier" Deleted/);

  // Verify setup channel was deleted LAST among child channels before category
  const setupIndex = deletedOrder.indexOf(setupId);
  const regIndex = deletedOrder.indexOf(regChanId);
  const idpIndex = deletedOrder.indexOf(idpChanId);
  const catIndex = deletedOrder.indexOf(catId);

  assert.ok(setupIndex > regIndex, 'Setup channel deleted after reg channel');
  assert.ok(setupIndex > idpIndex, 'Setup channel deleted after idp channel');
  assert.ok(catIndex > setupIndex, 'Category deleted after setup channel');

  // Verify MongoDB cleaned
  const tourAfter = await getConfigurableTournament(tourId);
  assert.equal(tourAfter, null, 'Tournament soft-deleted and filtered out');

  const tourRaw = await getConfigurableTournament(tourId, true);
  assert.equal(tourRaw.status, 'DELETED');
  assert.equal(tourRaw.isDeleted, true);
  assert.equal(tourRaw.setupChannelId, null);
  assert.equal(tourRaw.categoryId, null);

  const regAfter = await getConfigurableRegistration(regId);
  assert.equal(regAfter, null, 'Registration soft-deleted');
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
  assert.equal(createdChannels[0].name, '𝐓𝟑｜verify');
  assert.equal(createdChannels[1].name, '𝐓𝟑｜updates');
  assert.equal(createdChannels[2].name, '𝐓𝟑｜info');

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
  await registerSquadFull(int1, 'reg-group-1');
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);

  // Register in Group 2 -> Success (Multiple Registrations allowed for same squad)
  const int2 = regInteraction('reg-group-2', leaderId);
  await registerSquadFull(int2, 'reg-group-2');
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);

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
          case 'reserved_slots': return '3'; // 3 reserved slots (slots 01, 02, 03 locked)
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
  assert.match(createdChannels[0].name, /bgis-qualifier-a-reg/);
  assert.match(createdChannels[1].name, /bgis-qualifier-a-idp/);

  // Verify stored registration document
  const regs = await getConfigurableRegistrationsForTournament(tourId);
  assert.equal(regs.length, 1);
  const reg = regs[0];
  assert.equal(reg.displayName, 'BGIS Qualifier A');
  assert.equal(reg.totalSlots, 32);
  assert.equal(reg.reservedSlots, 3);
  assert.equal(reg.dailyStartTime, '10:00');
  assert.equal(reg.dailyResetTime, '02:00');
  assert.ok(reg.currentCycleId);
});

test('Slot Allocation - Reserved slots occupy Slot 01..N, first available slot = reservedSlots + 1', async () => {
  const regId = 'reg-alloc-test';

  // 16 slots with 2 reserved slots (Slot 01 and Slot 02 locked)
  const totalSlots = 16;
  const reservedSlotsCount = 2;

  // First allocation occupies firstAvailableSlot = reservedSlots + 1 -> should be 3
  const slot1 = await getNextAvailableSlot(regId, totalSlots, reservedSlotsCount);
  assert.equal(slot1, 3);

  // Fill slot 3
  await saveConfigurableEntry({
    registrationId: regId,
    teamId: 'team-a',
    slotNumber: 3,
    status: 'CONFIRMED',
  });

  // Next allocation should be 4
  const slot2 = await getNextAvailableSlot(regId, totalSlots, reservedSlotsCount);
  assert.equal(slot2, 4);

  // Fill slot 4
  await saveConfigurableEntry({
    registrationId: regId,
    teamId: 'team-b',
    slotNumber: 4,
    status: 'CONFIRMED',
  });

  // Next allocation should be 5
  const slot3 = await getNextAvailableSlot(regId, totalSlots, reservedSlotsCount);
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

  // Next allocation should be 10
  const slot4 = await getNextAvailableSlot(regId, totalSlots, reservedSlotsCount);
  assert.equal(slot4, 10);
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

  // 5 total slots with 2 reserved (slots 01 and 02 locked) -> exactly 3 available slots (3, 4, 5)
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Mini Tourney',
    totalSlots: 5,
    reservedSlots: 2,
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

  // Register Team 1 (allocates slot 3: firstAvailableSlot = 2 + 1 = 3)
  await registerSquadFull(regInteraction('ldr-1'), regId);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#3`/);

  // Register Team 2 (allocates slot 4)
  await registerSquadFull(regInteraction('ldr-2'), regId);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#4`/);

  // Register Team 3 (allocates slot 5 - last available slot!)
  await registerSquadFull(regInteraction('ldr-3'), regId);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#5`/);

  // Registration should now be automatically CLOSED
  const regDoc = await getConfigurableRegistration(regId);
  assert.equal(regDoc.status, 'CLOSED', 'Registration automatically closed when capacity reached');

  // Attempting to register Team 4 should be rejected
  await registerSquadFull(regInteraction('ldr-4'), regId);
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
  await registerSquadFull(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);

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
  await registerSquadFull(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);

  // Reset cycle 1
  await executeDailyCycleReset(regInteraction.client, regId, true);

  // Prepare next cycle 2026-11-05 and set OPEN
  const reg = await getConfigurableRegistration(regId);
  reg.status = 'OPEN';
  reg.currentCycleId = `${regId}:2026-11-05`;
  reg.currentCycleDate = '2026-11-05';
  await saveConfigurableRegistration(reg);

  // Same team registers again in cycle 2 -> MUST succeed!
  await registerSquadFull(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);

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
          case 'reserved_slots': return '1';
          case 'daily_start_time': return '10:00';
          case 'daily_reset_time': return '02:00';
          default: return '';
        }
      },
    },
  };

  await handleEditRegistrationModalSubmit(mockEditInteraction, regId);
  assert.match(editReply.content, /Capacity cannot be reduced below already allocated slots/);

  // 2. Safeguard in Edit Settings: cannot increase reserved slots into already occupied slots (slots 2, 3, 4)
  let editReservedReply = null;
  const mockEditReservedInteraction = {
    deferReply: async () => {},
    editReply: async (p) => { editReservedReply = p; },
    fields: {
      getTextInputValue: (cid) => {
        switch (cid) {
          case 'registration_name': return 'Safeguard Tourney';
          case 'total_slots': return '10';
          case 'reserved_slots': return '3'; // Attempting to reserve 3 slots (locks 1, 2, 3), but teams occupy 2 and 3!
          case 'daily_start_time': return '10:00';
          case 'daily_reset_time': return '02:00';
          default: return '';
        }
      },
    },
  };

  await handleEditRegistrationModalSubmit(mockEditReservedInteraction, regId);
  assert.match(editReservedReply.content, /cannot be reserved because they are already occupied/);
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

test('Registration Dashboard - Exactly 1 Row of 5 Buttons and required status fields', () => {
  const reg = {
    registrationId: 'reg-dash-5btn',
    displayName: 'T3 10PM Group',
    status: 'OPEN',
    currentCycleDate: '2026-11-04',
    totalSlots: 16,
    reservedSlots: 2,
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    timezone: 'Asia/Kolkata',
    registrationChannelId: 'chan-reg-1',
    idpChannelId: 'chan-idp-1',
  };

  const payload = buildManageDashboardPayload(reg, 4);

  // Exactly 1 ActionRow
  assert.equal(payload.components.length, 1);
  const row = payload.components[0];

  // Exactly 5 Buttons
  assert.equal(row.components.length, 5);

  const customIds = row.components.map((c) => c.data.custom_id);
  assert.deepEqual(customIds, [
    'md_cfg_edit_reg_reg-dash-5btn',
    'md_cfg_toggle_status_reg-dash-5btn',
    'md_cfg_view_slotchart_reg-dash-5btn',
    'md_cfg_refresh_reg_reg-dash-5btn',
    'md_cfg_delete_reg_reg-dash-5btn',
  ]);

  // Contextual toggle button label
  assert.equal(row.components[1].data.label, 'Close Registration');

  // Verify info fields in content
  assert.match(payload.content, /• \*\*Name:\*\* T3 10PM Group/);
  assert.match(payload.content, /• \*\*Current Cycle Status:\*\* `OPEN`/);
  assert.match(payload.content, /• \*\*Total Slots:\*\* `16`/);
  assert.match(payload.content, /• \*\*Reserved Slots:\*\* `2`/);
  assert.match(payload.content, /• \*\*Registered Teams:\*\* `4\/14`/);
  assert.match(payload.content, /• \*\*Available Slots:\*\* `10`/);
  assert.match(payload.content, /• \*\*Daily Start Time:\*\* `10:00`/);
  assert.match(payload.content, /• \*\*Daily Reset Time:\*\* `02:00`/);
  assert.match(payload.content, /• \*\*Registration Channel:\*\* <#chan-reg-1>/);
  assert.match(payload.content, /• \*\*IDP Channel:\*\* <#chan-idp-1>/);

  // When CLOSED, toggle button is Open Registration
  reg.status = 'CLOSED';
  const closedPayload = buildManageDashboardPayload(reg, 0);
  assert.equal(closedPayload.components[0].components[1].data.label, 'Open Registration');
});

test('Open & Close Registration - Real-time state transitions, manual override and capacity check', async () => {
  const tourId = 'tour-toggle-test';
  const regId = 'reg-toggle-test';

  await saveConfigurableTournament({ tournamentId: tourId, guildId: 'guild-cfg' });
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    displayName: 'Toggle Test Reg',
    totalSlots: 4,
    reservedSlots: 1, // 3 available slots
    status: 'OPEN',
    registrationChannelId: 'chan-reg-tgl',
    idpChannelId: 'chan-idp-tgl',
    currentCycleId: `${regId}:2026-11-04`,
    currentCycleDate: '2026-11-04',
  });

  let updatedPayload = null;
  let followUpContent = null;
  const mockButtonInteraction = {
    isButton: () => true,
    update: async (p) => { updatedPayload = p; },
    followUp: async (p) => { followUpContent = p; },
    reply: async (p) => {},
    client: { channels: { fetch: async () => null } },
  };

  // 1. Close the registration
  await handleToggleStatus(mockButtonInteraction, regId);
  const regClosed = await getConfigurableRegistration(regId);
  assert.equal(regClosed.status, 'CLOSED');
  assert.equal(regClosed.manualOverride, 'CLOSED');
  assert.match(followUpContent.content, /Registration is now \*\*CLOSED\*\*/);

  // 2. Open the registration back
  await handleToggleStatus(mockButtonInteraction, regId);
  const regOpen = await getConfigurableRegistration(regId);
  assert.equal(regOpen.status, 'OPEN');
  assert.equal(regOpen.manualOverride, 'OPEN');
  assert.match(followUpContent.content, /Registration is now \*\*OPEN\*\*/);

  // 3. Fill all available slots (slots 2, 3, 4 - slot 1 is reserved)
  for (let s = 2; s <= 4; s++) {
    await saveConfigurableEntry({
      registrationId: regId,
      cycleId: `${regId}:2026-11-04`,
      teamId: `team-${s}`,
      teamName: `Team ${s}`,
      slotNumber: s,
      status: 'CONFIRMED',
    });
  }

  // Close it
  regOpen.status = 'CLOSED';
  regOpen.manualOverride = 'CLOSED';
  await saveConfigurableRegistration(regOpen);

  // 4. Attempting to open when all slots are full should be rejected
  let rejectReply = null;
  const mockRejectInteraction = {
    isButton: () => true,
    reply: async (p) => { rejectReply = p; },
    client: { channels: { fetch: async () => null } },
  };

  await handleToggleStatus(mockRejectInteraction, regId);
  assert.match(rejectReply.content, /Cannot open registration: all available slots are filled/);
  const stillClosed = await getConfigurableRegistration(regId);
  assert.equal(stillClosed.status, 'CLOSED');
});

test('Scheduler Precedence - Respects manualOverride during active cycle', async () => {
  const tourId = 'tour-precedence';
  const regId = 'reg-precedence';

  const tzInfo = getCurrentTimeInTimezone('Asia/Kolkata', new Date());
  const cycleEval = evaluateDailyCycleStatus('00:00', '23:59', 'Asia/Kolkata', new Date());

  await saveConfigurableTournament({ tournamentId: tourId, guildId: 'guild-cfg' });
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    displayName: 'Manual Override Reg',
    totalSlots: 16,
    reservedSlots: 2,
    dailyStartTime: '00:00', // Open all day
    dailyResetTime: '23:59',
    timezone: 'Asia/Kolkata',
    status: 'CLOSED', // Organiser manually closed it
    manualOverride: 'CLOSED',
    manualOverrideCycleDate: cycleEval.activeCycleDate,
    lastResetCycleDate: cycleEval.endedCycleDate,
    currentCycleId: `${regId}:${cycleEval.activeCycleDate}`,
    currentCycleDate: cycleEval.activeCycleDate,
    registrationChannelId: 'chan-reg-prec',
    idpChannelId: 'chan-idp-prec',
  });

  const mockClient = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: { fetch: async () => null },
        send: async () => ({ id: 'm1' }),
      }),
    },
  };

  // Run lifecycle checker
  await checkRegistrationLifecycles(mockClient);

  // Registration must NOT be automatically reopened because organiser manually closed it
  const regAfterCron = await getConfigurableRegistration(regId);
  assert.equal(regAfterCron.status, 'CLOSED', 'Scheduler respected manualOverride CLOSED and did not reopen');
});

test('Registration Name Editing & Discord Channel Renaming', async () => {
  const tourId = 'tour-rename-test';
  const regId = 'reg-rename-test';

  await saveConfigurableTournament({ tournamentId: tourId, guildId: 'guild-cfg' });
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    displayName: 'Initial Group A',
    totalSlots: 20,
    reservedSlots: 2,
    dailyStartTime: '10:00',
    dailyResetTime: '02:00',
    registrationChannelId: 'chan-reg-rename',
    idpChannelId: 'chan-idp-rename',
    currentCycleId: `${regId}:2026-11-04`,
  });

  let regChannelName = 'initial-group-a-reg';
  let idpChannelName = 'initial-group-a-idp';

  const mockGuild = {
    channels: {
      fetch: async (id) => {
        if (id === 'chan-reg-rename') {
          return {
            id: 'chan-reg-rename',
            name: regChannelName,
            isTextBased: () => true,
            messages: { fetch: async () => null },
            send: async () => ({ id: 'm-reg' }),
            setName: async (n) => { regChannelName = n; },
          };
        }
        if (id === 'chan-idp-rename') {
          return {
            id: 'chan-idp-rename',
            name: idpChannelName,
            isTextBased: () => true,
            messages: { fetch: async () => null },
            send: async () => ({ id: 'm-idp' }),
            setName: async (n) => { idpChannelName = n; },
          };
        }
        return null;
      },
    },
  };

  let editReply = null;
  const mockEditInteraction = {
    guild: mockGuild,
    deferReply: async () => {},
    editReply: async (p) => { editReply = p; },
    fields: {
      getTextInputValue: (cid) => {
        switch (cid) {
          case 'registration_name': return 'Champions League';
          case 'total_slots': return '25';
          case 'reserved_slots': return '3';
          case 'daily_start_time': return '12:00';
          case 'daily_reset_time': return '04:00';
          default: return '';
        }
      },
    },
    client: { channels: mockGuild.channels },
  };

  await handleEditRegistrationModalSubmit(mockEditInteraction, regId);

  // Verify MongoDB updated
  const updatedReg = await getConfigurableRegistration(regId);
  assert.equal(updatedReg.displayName, 'Champions League');
  assert.equal(updatedReg.totalSlots, 25);
  assert.equal(updatedReg.reservedSlots, 3);

  // Verify Discord channels were renamed
  assert.match(regChannelName, /champions-league-reg/);
  assert.match(idpChannelName, /champions-league-idp/);
  assert.match(editReply.content, /Registration Settings Updated/);

  // Test Discord API failure handling: reports warning without throwing
  const mockFailingGuild = {
    channels: {
      fetch: async () => ({
        id: 'chan-reg-rename',
        isTextBased: () => true,
        messages: { fetch: async () => null },
        send: async () => ({ id: 'm-fail' }),
        setName: async () => { throw new Error('Missing Permissions'); },
      }),
    },
  };

  let failReply = null;
  const mockFailInteraction = {
    guild: mockFailingGuild,
    deferReply: async () => {},
    editReply: async (p) => { failReply = p; },
    fields: {
      getTextInputValue: (cid) => {
        switch (cid) {
          case 'registration_name': return 'Super Cup';
          case 'total_slots': return '25';
          case 'reserved_slots': return '3';
          case 'daily_start_time': return '12:00';
          case 'daily_reset_time': return '04:00';
          default: return '';
        }
      },
    },
    client: { channels: mockFailingGuild.channels },
  };

  await handleEditRegistrationModalSubmit(mockFailInteraction, regId);
  assert.match(failReply.content, /Discord channel rename failed \(Missing Permissions\)/);
  const stillValidReg = await getConfigurableRegistration(regId);
  assert.equal(stillValidReg.displayName, 'Champions League', 'Old name is kept when Discord channel rename fails');
  assert.equal(stillValidReg.registrationChannelId, 'chan-reg-rename');
});

test('Same Team Multiple Registrations - Team can register across multiple registration channels within the same tournament', async () => {
  const tourId = 'tour-multi-reg-same-team';
  const regIdMorning = 'reg-morning';
  const regIdEvening = 'reg-evening';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  // Morning registration
  await saveConfigurableRegistration({
    registrationId: regIdMorning,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Morning 10AM',
    totalSlots: 10,
    reservedSlots: 1,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-m',
    idpChannelId: 'chan-idp-m',
    currentCycleId: `${regIdMorning}:2026-11-04`,
  });

  // Evening registration
  await saveConfigurableRegistration({
    registrationId: regIdEvening,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Evening 8PM',
    totalSlots: 10,
    reservedSlots: 1,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-e',
    idpChannelId: 'chan-idp-e',
    currentCycleId: `${regIdEvening}:2026-11-04`,
  });

  // Team Leader enrolls team
  const leaderId = 'ldr-multi-tester';
  await saveConfigurableTeam({
    teamId: 'team-multireg',
    tournamentId: tourId,
    teamName: 'Apex Predators',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'ApexLead', uid: '112233' }],
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

  const regInteraction = {
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: leaderId },
    client: { channels: mockGuild.channels },
    reply: async (p) => { regInteraction.lastReply = p; },
  };

  // 1. Team registers in Morning registration -> succeeds
  await registerSquadFull(regInteraction, regIdMorning);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#2`/);

  // 2. SAME Team registers in Evening registration in the SAME tournament -> succeeds!
  await registerSquadFull(regInteraction, regIdEvening);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#2`/);

  // 3. Attempting to register in Morning registration again in the same cycle -> rejected as already registered
  await registerSquadFull(regInteraction, regIdMorning);
  assert.match(regInteraction.lastReply.content, /already registered in this daily cycle/);
});

test('Deleted Registration Cleanup & Re-registration - Team registered in deleted channel can register in new channel without duplicate error', async () => {
  const tourId = 'tour-del-reg-bug';
  const regIdOld = 'reg-old-chan';
  const regIdNew = 'reg-new-chan';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  // Old registration channel
  await saveConfigurableRegistration({
    registrationId: regIdOld,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Old T3 10PM',
    registrationNumber: 1,
    totalSlots: 16,
    reservedSlots: 2,
    status: 'OPEN',
    registrationChannelId: 'chan-old-reg',
    idpChannelId: 'chan-old-idp',
    currentCycleId: `${regIdOld}:cycle-1`,
  });

  // Team "4Crows"
  const leaderId = 'ldr-4crows';
  await saveConfigurableTeam({
    teamId: 'team-4crows',
    tournamentId: tourId,
    teamName: 'Team Name 4Crows',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'CrowLead', uid: '998877' }],
  });

  const mockGuild = {
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        delete: async () => {},
        permissionOverwrites: {
          edit: async () => {},
          delete: async () => {},
        },
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
      }),
    },
  };

  const regInteraction = {
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: leaderId },
    client: { channels: mockGuild.channels },
    reply: async (p) => { regInteraction.lastReply = p; },
  };

  // 1. Team registers in Old registration -> assigned Slot #3 (2 reserved slots)
  await registerSquadFull(regInteraction, regIdOld);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#3`/);

  // 2. Old registration channel is deleted (via handleDeleteRegistration or handleConfigurableChannelDelete)
  const delInteraction = {
    guild: mockGuild,
    client: { channels: mockGuild.channels },
    reply: async (p) => { delInteraction.lastReply = p; },
  };
  await handleDeleteRegistration(delInteraction, regIdOld);

  // Verify old registration is marked DELETED
  const oldRegAfter = await getConfigurableRegistration(regIdOld);
  assert.equal(oldRegAfter, null, 'Deleted registration should not be returned by default');

  const oldEntries = await getConfigurableEntriesForRegistration(regIdOld);
  assert.equal(oldEntries.length, 0, 'No active confirmed entries should remain in deleted registration');

  // 3. New registration is created for the tournament
  await saveConfigurableRegistration({
    registrationId: regIdNew,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'New T3 10PM',
    registrationNumber: 2,
    totalSlots: 16,
    reservedSlots: 2,
    status: 'OPEN',
    registrationChannelId: 'chan-new-reg',
    idpChannelId: 'chan-new-idp',
    currentCycleId: `${regIdNew}:cycle-new-1`,
  });

  // 4. Team "4Crows" registers in the NEW registration channel
  // MUST NOT receive "already registered in this daily cycle" error with old channel reference!
  await registerSquadFull(regInteraction, regIdNew);
  assert.match(
    regInteraction.lastReply.content,
    /Registration Confirmed|successfully registered/,
    'Team must be allowed to register in new registration channel without being blocked by old deleted channel'
  );
  assert.match(regInteraction.lastReply.content, /Slot Number:.*`#3`/);
});

test('Discord Channel Deletion Cleanup - Events.ChannelDelete cleans up registration, archives active entries and revokes IDP access', async () => {
  const tourId = 'tour-chan-del';
  const regId = 'reg-chan-del-1';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Scrims Direct Delete',
    registrationNumber: 1,
    totalSlots: 10,
    reservedSlots: 0,
    status: 'OPEN',
    registrationChannelId: 'chan-direct-reg',
    idpChannelId: 'chan-direct-idp',
    currentCycleId: `${regId}:cycle-1`,
  });

  const leaderId = 'ldr-direct-del';
  await saveConfigurableTeam({
    teamId: 'team-direct',
    tournamentId: tourId,
    teamName: 'Direct Team',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'DirectLead', uid: '334455' }],
  });

  let deletedOverwrites = [];
  let pairedChannelDeleted = false;

  const mockClient = {
    guilds: {
      fetch: async () => ({ id: 'guild-cfg' }),
    },
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        delete: async () => { pairedChannelDeleted = true; },
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
        permissionOverwrites: {
          delete: async (targetId) => { deletedOverwrites.push(targetId); },
        },
      }),
    },
  };

  const regInteraction = {
    guild: { channels: mockClient.channels },
    guildId: 'guild-cfg',
    user: { id: leaderId },
    client: mockClient,
    reply: async (p) => { regInteraction.lastReply = p; },
  };

  // Register team
  await registerSquadFull(regInteraction, regId);
  assert.match(regInteraction.lastReply.content, /Registration Confirmed|successfully registered/);

  // Simulate Discord channel delete event for the registration channel
  const deletedChannelMock = {
    id: 'chan-direct-reg',
    name: 'scrims-direct-delete-reg',
    guild: {
      channels: {
        cache: {
          get: (id) => ({
            id,
            delete: async () => { pairedChannelDeleted = true; },
          }),
        },
      },
    },
    client: mockClient,
  };

  await handleConfigurableChannelDelete(deletedChannelMock);

  // Verify registration is soft-deleted
  const regAfter = await getConfigurableRegistration(regId);
  assert.equal(regAfter, null);

  // Verify IDP permission was revoked
  assert.ok(deletedOverwrites.includes(leaderId), 'Leader IDP permission overwrite must be revoked');
  assert.equal(pairedChannelDeleted, true, 'Paired IDP channel must be deleted');
});

test('Monotonically Increasing Registration Numbers - Deleted registration numbers are never reused', async () => {
  const tourId = 'tour-mono-nums';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
  });

  const createdChannels = [];
  const mockGuild = {
    id: 'guild-cfg',
    roles: { everyone: { id: 'role-everyone' } },
    channels: {
      create: async (opts) => {
        const ch = {
          id: `chan-${opts.name}`,
          name: opts.name,
          isTextBased: () => true,
          delete: async () => {},
          send: async () => ({ id: 'm' }),
          messages: { fetch: async () => null },
        };
        createdChannels.push(ch);
        return ch;
      },
      fetch: async (id) => createdChannels.find((c) => c.id === id) || null,
    },
  };

  const createInteraction = (name) => ({
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: 'admin-user' },
    deferReply: async () => {},
    fields: {
      getTextInputValue: (field) => {
        if (field === 'registration_name' || field === 'display_name') return name;
        if (field === 'total_slots') return '16';
        if (field === 'reserved_slots') return '2';
        if (field === 'daily_start_time') return '10:00 AM';
        if (field === 'daily_reset_time') return '02:00 AM';
        return '';
      },
    },
    editReply: async (p) => { createInteraction.lastReply = p; },
    client: { channels: mockGuild.channels },
  });

  // Create Registration 1
  await handleAddRegistrationModalSubmit(createInteraction('T3 10PM'), tourId);
  const regs1 = await getConfigurableRegistrationsForTournament(tourId, true);
  assert.equal(regs1.length, 1);
  assert.equal(regs1[0].registrationNumber, 1);

  // Delete Registration 1
  await deleteConfigurableRegistration(regs1[0].registrationId);

  // Create Registration 2
  await handleAddRegistrationModalSubmit(createInteraction('T3 11PM'), tourId);
  const regs2 = await getConfigurableRegistrationsForTournament(tourId, true);
  assert.equal(regs2.length, 2);
  const newReg = regs2.find((r) => r.status !== 'DELETED');
  assert.equal(newReg.registrationNumber, 2, 'New registration must have number 2, never reusing 1');
});

test('Startup Reconciliation Cleanup - Stale active entries belonging to deleted registrations or channels are archived', async () => {
  const tourId = 'tour-startup-cleanup';
  const regIdStale = 'reg-stale-orphaned';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
  });

  // Stale registration already marked DELETED
  await saveConfigurableRegistration({
    registrationId: regIdStale,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'Deleted Channel Reg',
    registrationNumber: 1,
    totalSlots: 16,
    status: 'DELETED',
    isDeleted: true,
  });

  // Stale active entry for "Team Name 4Crows" in that deleted registration
  await saveConfigurableEntry({
    registrationId: regIdStale,
    cycleId: `${regIdStale}:cycle-stale`,
    tournamentId: tourId,
    teamId: 'team-4crows-stale',
    teamName: 'Team Name 4Crows',
    slotNumber: 3,
    status: 'CONFIRMED',
  });

  // Verify entry is initially active
  const initialEntry = await getConfigurableEntry(regIdStale, 'team-4crows-stale', `${regIdStale}:cycle-stale`);
  assert.ok(initialEntry, 'Stale entry starts active');

  // Run startup reconciliation cleanup
  const cleanupResult = await cleanUpStaleConfigurableRegistrationsAndEntries(null);
  assert.ok(cleanupResult.cleanedEntries >= 1, 'Should have cleaned up at least 1 orphaned entry');

  // Verify entry is now ARCHIVED and no longer active
  const entryAfter = await getConfigurableEntry(regIdStale, 'team-4crows-stale', `${regIdStale}:cycle-stale`);
  assert.equal(entryAfter, null, 'Orphaned entry must be archived and no longer returned as active confirmed');
});

test('One Source of Truth - Register button and slot chart never disagree', async () => {
  const tourId = 'tour-one-source-truth';
  const regId = 'reg-t2-10pm';
  const regChanId = 'chan-t2-10pm-reg';
  const idpChanId = 'chan-t2-10pm-idp';
  const currentCycleId = `${regId}:cycle-live-10pm`;

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-cfg',
    requiredDiscordMembers: 1,
  });

  // Active registration instance with current cycle
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-cfg',
    displayName: 'T2 10PM',
    registrationNumber: 1,
    totalSlots: 16,
    reservedSlots: 0,
    status: 'OPEN',
    registrationChannelId: regChanId,
    idpChannelId: idpChanId,
    registrationMessageId: 'msg-reg-t2-10pm',
    slotChartMessageId: 'msg-idp-t2-10pm',
    currentCycleId: currentCycleId,
  });

  const leaderId = 'ldr-4crows-truth';
  await saveConfigurableTeam({
    teamId: 'team-4crows-truth',
    tournamentId: tourId,
    teamName: 'Team Name 4Crows',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'CrowLead', uid: '123456' }],
  });

  // Simulate an OLD active entry with a mismatched cycleId (e.g. from an old cycle that wasn't archived)
  await saveConfigurableEntry({
    registrationId: regId,
    cycleId: `${regId}:cycle-obsolete-yesterday`,
    tournamentId: tourId,
    teamId: 'team-4crows-truth',
    teamName: 'Team Name 4Crows',
    slotNumber: 3,
    status: 'CONFIRMED',
  });

  // 1. Slot chart reads active entries for currentCycleId
  const slotChartEntries = await getConfigurableEntriesForRegistration(regId, currentCycleId);
  assert.equal(slotChartEntries.length, 0, 'Slot chart shows 0/16 filled and all slots available');

  // 2. Run cleanup so stale entry is archived
  await cleanUpStaleConfigurableRegistrationsAndEntries(null);

  const mockGuild = {
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        delete: async () => {},
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
        permissionOverwrites: {
          edit: async () => {},
          delete: async () => {},
        },
      }),
    },
  };

  // 3. User clicks Register button in #t2-10pm-reg
  const buttonInteraction = {
    channelId: regChanId, // clicked in #t2-10pm-reg
    message: { id: 'msg-reg-t2-10pm' },
    guild: mockGuild,
    guildId: 'guild-cfg',
    user: { id: leaderId },
    client: { channels: mockGuild.channels },
    reply: async (p) => { buttonInteraction.lastReply = p; },
  };

  // Register button clicked - resolves from channel ID / message ID and checks exact same source of truth
  await registerSquadFull(buttonInteraction, 'some-wrong-or-stale-id');
  assert.match(
    buttonInteraction.lastReply.content,
    /Registration Confirmed|successfully registered/,
    'Register button must NOT claim already registered when slot chart was empty'
  );
  assert.match(buttonInteraction.lastReply.content, /Slot Number:.*`#1`/);

  // Now slot chart has exactly 1 entry: Team 4Crows
  const updatedSlotChartEntries = await getConfigurableEntriesForRegistration(regId, currentCycleId);
  assert.equal(updatedSlotChartEntries.length, 1);
  assert.equal(updatedSlotChartEntries[0].teamName, 'Team Name 4Crows');
  assert.equal(updatedSlotChartEntries[0].slotNumber, 1);
});

test('Enroll Squad Button - Immediate response with showModal on first click (<3s rule)', async () => {
  const tourId = 'tour-enroll-fast';
  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-fast',
    name: 'Fast Scrims',
  });

  let modalShown = null;
  const mockInteraction = {
    guildId: 'guild-fast',
    user: { id: 'user-enroll-fast' },
    showModal: async (modal) => {
      modalShown = modal;
    },
    reply: async () => {},
  };

  // Calling handleEnrollButtonClick must directly call showModal without delaying
  await handleEnrollButtonClick(mockInteraction, tourId);

  assert.ok(modalShown, 'Modal must be shown immediately');
  assert.equal(modalShown.data.custom_id, `md_cfg_step1_modal_${tourId}`);
  assert.equal(modalShown.data.title, 'Team Enrollment — Step 1 of 5');

  // Verify that team_name input does NOT have empty string value when no session exists
  // (Prevents Discord API error: data.components[0].components[0].value[BASE_TYPE_MIN_LENGTH]: Must be 2 or more in length)
  const teamNameComponent = modalShown.components[0].components[0];
  assert.equal(teamNameComponent.data.value, undefined, 'Empty value must not be prefilled when minLength is set');

  // When existingSession has a teamName, verify it is pre-filled properly
  let prefilledModal = null;
  const mockPrefillInteraction = {
    guildId: 'guild-fast',
    user: { id: 'user-enroll-fast' },
    showModal: async (modal) => { prefilledModal = modal; },
    reply: async () => {},
  };
  await showStep1Modal(mockPrefillInteraction, tourId, { teamName: 'Phoenix Wolves' });
  assert.equal(prefilledModal.components[0].components[0].data.value, 'Phoenix Wolves');
});

test('Manage Squad Button - Immediately calls deferReply first before database lookups', async () => {
  const tourId = 'tour-manage-defer';
  const leaderId = 'leader-manage-defer';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-defer',
    name: 'Defer Scrims',
  });

  await saveConfigurableTeam({
    teamId: 'team-defer-1',
    tournamentId: tourId,
    guildId: 'guild-defer',
    teamName: 'Squad Defer',
    leaderDiscordId: leaderId,
    players: [
      { discordId: leaderId, ign: 'LeaderP1', uid: '111' },
      { discordId: null, ign: 'P2', uid: '222' },
      { discordId: null, ign: 'P3', uid: '333' },
      { discordId: null, ign: 'P4', uid: '444' },
    ],
  });

  const callOrder = [];
  const mockInteraction = {
    guildId: 'guild-defer',
    user: { id: leaderId },
    deferred: false,
    replied: false,
    deferReply: async (opts) => {
      callOrder.push('deferReply');
      mockInteraction.deferred = true;
    },
    editReply: async (payload) => {
      callOrder.push('editReply');
      mockInteraction.lastEdit = payload;
    },
    reply: async (payload) => {
      callOrder.push('reply');
    },
  };

  await handleManageMySquadButton(mockInteraction, tourId);

  assert.equal(callOrder[0], 'deferReply', 'Must call deferReply before anything else');
  assert.equal(callOrder[1], 'editReply', 'Must edit reply with squad management info');
  assert.ok(mockInteraction.lastEdit.embeds?.length > 0, 'Embed must be displayed');
  assert.match(mockInteraction.lastEdit.embeds[0].data.title, /Squad Management — Squad Defer/);
});

test('Step 1 Submission - Directs user already leading an enrolled squad to Manage Squad', async () => {
  const tourId = 'tour-already-enrolled';
  const leaderId = 'leader-already';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-enrolled',
    name: 'Enrolled Cup',
  });

  // User already enrolled Team Alpha
  await saveConfigurableTeam({
    teamId: 'team-alpha-id',
    tournamentId: tourId,
    guildId: 'guild-enrolled',
    teamName: 'Team Alpha',
    leaderDiscordId: leaderId,
    players: [
      { discordId: leaderId, ign: 'Alpha1', uid: '111' },
      { discordId: null, ign: 'Alpha2', uid: '222' },
      { discordId: null, ign: 'Alpha3', uid: '333' },
      { discordId: null, ign: 'Alpha4', uid: '444' },
    ],
  });

  let replyPayload = null;
  const mockInteraction = {
    guildId: 'guild-enrolled',
    user: { id: leaderId },
    fields: {
      getTextInputValue: (id) => {
        if (id === 'team_name') return 'Team Beta';
        if (id === 'p1_ign') return 'Beta1';
        if (id === 'p1_uid') return '111';
        if (id === 'p2_ign') return 'Beta2';
        if (id === 'p2_uid') return '222';
        return '';
      },
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handleStep1ModalSubmit(mockInteraction, tourId);

  assert.ok(replyPayload, 'Must reply to user');
  assert.equal(replyPayload.ephemeral, true);
  assert.match(replyPayload.content, /already enrolled squad \*\*Team Alpha\*\*/);
  assert.match(replyPayload.content, /Click \*\*Manage Squad\*\*/);

  // Original team is NOT modified or duplicated
  const teams = await getConfigurableTeamsForUser(tourId, leaderId);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].teamName, 'Team Alpha');
});

test('Interaction Router - Routes legacy custom IDs (enroll_squad, md_cfg_enroll) and resolves tournament', async () => {
  const tourId = 'tour-legacy-id';
  const verifyChanId = 'chan-verify-legacy';
  const verifyMsgId = 'msg-verify-legacy';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-legacy',
    name: 'Legacy Cup',
    setupChannelId: 'chan-setup-legacy',
    standardChannels: {
      verifyChannelId: verifyChanId,
      verifyMessageId: verifyMsgId,
    },
  });

  // 1. Interaction with customId: 'enroll_squad' in verify channel
  let modalShown1 = null;
  const interaction1 = {
    customId: 'enroll_squad',
    channelId: verifyChanId,
    guildId: 'guild-legacy',
    user: { id: 'user-legacy-1' },
    showModal: async (m) => { modalShown1 = m; },
    reply: async () => {},
  };

  const handled1 = await handleConfigurableTournamentInteraction(interaction1);
  assert.equal(handled1, true);
  assert.ok(modalShown1);
  assert.equal(modalShown1.data.custom_id, `md_cfg_step1_modal_${tourId}`);

  // 2. Interaction with customId: 'md_cfg_enroll' resolving via verify message
  let modalShown2 = null;
  const interaction2 = {
    customId: 'md_cfg_enroll',
    message: { id: verifyMsgId },
    guildId: 'guild-legacy',
    user: { id: 'user-legacy-2' },
    showModal: async (m) => { modalShown2 = m; },
    reply: async () => {},
  };

  const handled2 = await handleConfigurableTournamentInteraction(interaction2);
  assert.equal(handled2, true);
  assert.ok(modalShown2);
  assert.equal(modalShown2.data.custom_id, `md_cfg_step1_modal_${tourId}`);

  // 3. Interaction with customId: 'my_squad' in verify channel
  const interaction3 = {
    customId: 'my_squad',
    channelId: verifyChanId,
    guildId: 'guild-legacy',
    user: { id: 'user-legacy-3' },
    deferred: false,
    replied: false,
    deferReply: async () => { interaction3.deferred = true; },
    editReply: async (p) => { interaction3.lastEdit = p; },
    reply: async (p) => { interaction3.lastReply = p; },
  };

  const handled3 = await handleConfigurableTournamentInteraction(interaction3);
  assert.equal(handled3, true);
  assert.equal(interaction3.deferred, true);
});

test('Enrollment Message - Startup re-editing via verifyMessageId without duplicate posting', async () => {
  const tourId = 'tour-startup-edit';
  const verifyChanId = 'chan-verify-startup';
  const existingMsgId = 'msg-existing-456';

  let editPayload = null;
  let sendCalled = false;

  const mockChannel = {
    id: verifyChanId,
    isTextBased: () => true,
    messages: {
      fetch: async (id) => {
        if (id === existingMsgId) {
          return {
            id: existingMsgId,
            edit: async (payload) => {
              editPayload = payload;
            },
          };
        }
        return null;
      },
    },
    send: async () => {
      sendCalled = true;
      return { id: 'msg-new-not-expected' };
    },
  };

  const mockClient = {
    user: { id: 'bot-1' },
    channels: {
      fetch: async (id) => (id === verifyChanId ? mockChannel : null),
    },
  };

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-startup',
    name: 'Startup Tour',
    standardChannels: {
      verifyChannelId: verifyChanId,
      verifyMessageId: existingMsgId,
    },
  });

  const updated = await sendOrUpdateEnrollmentMessage(mockClient, tourId);
  assert.equal(updated, true);
  assert.equal(sendCalled, false, 'send must NOT be called when existing message exists');
  assert.ok(editPayload, 'Existing message must be re-edited');

  // Verify buttons have the current tournamentId custom IDs
  const row = editPayload.components[0];
  const enrollBtn = row.components[0];
  const manageBtn = row.components[1];
  assert.equal(enrollBtn.data.custom_id, `md_cfg_enroll_${tourId}`);
  assert.equal(manageBtn.data.custom_id, `md_cfg_my_squad_${tourId}`);
});

test('Enrollment Error Handling - Catches unexpected errors in handlers and replies with ephemeral error', async () => {
  let replyReceived = null;
  const mockInteraction = {
    showModal: async () => {
      throw new Error('Discord socket timeout simulation');
    },
    replied: false,
    deferred: false,
    reply: async (p) => {
      mockInteraction.replied = true;
      replyReceived = p;
    },
  };

  await handleEnrollButtonClick(mockInteraction, 'any-tour');
  assert.ok(replyReceived, 'Must catch error and reply to user');
  assert.equal(replyReceived.ephemeral, true);
  assert.match(replyReceived.content, /Could not display Step 1 modal|Could not open squad enrollment form/);
  assert.match(replyReceived.content, /Discord socket timeout simulation/);
});

test('Pending Enrollment Persistence - Saves wizard progress with Date expiry', async () => {
  const tourId = 'tour-persist-wizard';
  const userId = 'user-persist-wizard';

  const session = {
    tournamentId: tourId,
    userId,
    teamName: 'Persistent Wolves',
    p1: { ign: 'Wolf1', uid: '111' },
    p2: { ign: 'Wolf2', uid: '222' },
    step: 1,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  };

  await savePendingEnrollment(session);

  const retrieved = await getPendingEnrollment(tourId, userId);
  assert.ok(retrieved);
  assert.equal(retrieved.teamName, 'Persistent Wolves');
  assert.equal(retrieved.p1.ign, 'Wolf1');
  assert.ok(retrieved.expiresAt instanceof Date || typeof retrieved.expiresAt === 'number');

  await deletePendingEnrollment(tourId, userId);
  const deleted = await getPendingEnrollment(tourId, userId);
  assert.equal(deleted, null);
});

test('Registration Confirmation - Initial click opens ephemeral confirmation with required details and does not register', async () => {
  const tourId = 'tour-confirm-init';
  const regId = 'reg-confirm-init';
  const leaderId = 'ldr-confirm-init';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-confirm',
    name: 'Champions Arena',
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-confirm',
    displayName: 'T3 10PM Qualifier',
    totalSlots: 20,
    reservedSlots: 2,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-conf',
    idpChannelId: 'chan-idp-conf',
    currentCycleId: `${regId}:cycle-conf-1`,
  });

  await saveConfigurableTeam({
    teamId: 'team-conf-1',
    tournamentId: tourId,
    teamName: 'Glory Hunters',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'Hunter1', uid: '9001' }],
  });

  let replyPayload = null;
  const mockInteraction = {
    guild: {
      channels: {
        fetch: async () => ({ isTextBased: () => true, send: async () => ({ id: 'm' }) }),
      },
    },
    guildId: 'guild-confirm',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    reply: async (p) => { replyPayload = p; },
  };

  // 1. Click Register Squad
  await handleRegisterSquadButtonClick(mockInteraction, regId);

  // Must reply ephemerally with confirmation message
  assert.ok(replyPayload);
  assert.equal(replyPayload.ephemeral, true);
  assert.ok(replyPayload.embeds?.length > 0);

  const embed = replyPayload.embeds[0].data;
  assert.equal(embed.title, 'Confirm Squad Registration');
  assert.match(embed.description, /Champions Arena/, 'Tournament name must be displayed');
  assert.match(embed.description, /T3 10PM Qualifier/, 'Registration name must be displayed');
  assert.match(embed.description, /Glory Hunters/, 'Team name must be displayed');
  assert.match(embed.description, /Total Available Slots/, 'Total available slots must be displayed');
  assert.match(embed.description, /OPEN/, 'Registration status must be displayed');

  // Verify buttons
  const buttons = replyPayload.components[0].components;
  assert.equal(buttons.length, 2);
  const confirmBtn = buttons[0];
  const cancelBtn = buttons[1];
  assert.equal(confirmBtn.data.label, 'Confirm Registration');
  assert.equal(confirmBtn.data.custom_id, `md_cfg_reg_confirm_${regId}:team-conf-1`);
  assert.equal(cancelBtn.data.label, 'Cancel');
  assert.equal(cancelBtn.data.custom_id, `md_cfg_reg_cancel_${regId}:team-conf-1`);

  // Crucial requirement: No entry in database yet!
  const entries = await getConfigurableEntriesForRegistration(regId);
  assert.equal(entries.length, 0, 'No registration entry must be created on initial click');
});

test('Registration Confirmation - Cancel button cancels registration without creating entry or IDP access', async () => {
  const regId = 'reg-cancel-test';
  let updatePayload = null;
  let idpAccessGranted = false;

  const mockInteraction = {
    isButton: () => true,
    user: { id: 'user-cancel' },
    update: async (p) => { updatePayload = p; },
    reply: async (p) => { updatePayload = p; },
  };

  await handleCancelRegistrationButtonClick(mockInteraction);

  assert.ok(updatePayload);
  assert.match(updatePayload.content, /Registration cancelled/);
  assert.equal(updatePayload.components.length, 0, 'Components must be cleared');
  assert.equal(updatePayload.embeds.length, 0, 'Embeds must be cleared');

  // Verify no entries exist
  const entries = await getConfigurableEntriesForRegistration(regId);
  assert.equal(entries.length, 0);
  assert.equal(idpAccessGranted, false);
});

test('Registration Confirmation - Confirm button allocates slot, grants IDP, updates slot chart & returns success message', async () => {
  const tourId = 'tour-confirm-success';
  const regId = 'reg-confirm-success';
  const leaderId = 'ldr-conf-success';
  const teamId = 'team-conf-success';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-conf-succ',
    name: 'National Series',
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-conf-succ',
    displayName: 'Tier 1 Scrims',
    totalSlots: 16,
    reservedSlots: 1, // Slot 1 reserved, teams start at Slot 2
    status: 'OPEN',
    registrationChannelId: 'chan-reg-succ',
    idpChannelId: 'chan-idp-succ',
    currentCycleId: `${regId}:cycle-succ-1`,
  });

  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Titan Force',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'TitanLead', uid: '5566' }],
  });

  let idpGrantedTo = null;
  const mockGuild = {
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async () => ({ id: 'm' }),
        messages: { fetch: async () => null },
        permissionOverwrites: {
          edit: async (userId, perms) => {
            if (id === 'chan-idp-succ') {
              idpGrantedTo = userId;
            }
          },
        },
      }),
    },
  };

  let replyPayload = null;
  const mockInteraction = {
    isButton: () => true,
    guild: mockGuild,
    guildId: 'guild-conf-succ',
    user: { id: leaderId },
    client: { channels: mockGuild.channels },
    update: async (p) => { replyPayload = p; },
    reply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  // 1. Verify Success confirmation message
  assert.ok(replyPayload);
  assert.match(replyPayload.content, /Your squad has been successfully registered!/);
  assert.match(replyPayload.content, /Titan Force/, 'Team name displayed');
  assert.match(replyPayload.content, /Tier 1 Scrims/, 'Registration name displayed');
  assert.match(replyPayload.content, /Slot Number:.*`#2`/, 'Allocated slot displayed');

  // 2. Verify MongoDB entry
  const entries = await getConfigurableEntriesForRegistration(regId, `${regId}:cycle-succ-1`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].teamId, teamId);
  assert.equal(entries[0].slotNumber, 2);
  assert.equal(entries[0].status, 'CONFIRMED');

  // 3. Verify IDP access granted to leader
  assert.equal(idpGrantedTo, leaderId);
});

test('Registration Confirmation - Revalidates if registration closes while confirmation was open', async () => {
  const tourId = 'tour-reval-close';
  const regId = 'reg-reval-close';
  const leaderId = 'ldr-reval-close';
  const teamId = 'team-reval-close';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-reval',
    name: 'Closing Cup',
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-reval',
    displayName: 'Evening Scrims',
    totalSlots: 10,
    status: 'CLOSED', // Closed in background before Confirm was clicked!
    registrationChannelId: 'chan-reg-rc',
    idpChannelId: 'chan-idp-rc',
    currentCycleId: `${regId}:cycle-rc-1`,
  });

  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Late Comers',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'Late1', uid: '123' }],
  });

  let replyPayload = null;
  const mockInteraction = {
    isButton: () => true,
    guildId: 'guild-reval',
    user: { id: leaderId },
    update: async (p) => { replyPayload = p; },
    reply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  assert.ok(replyPayload);
  assert.match(replyPayload.content, /Registration is no longer open/);

  // Must not create entry
  const entries = await getConfigurableEntriesForRegistration(regId);
  assert.equal(entries.length, 0);
});

test('Registration Confirmation - Revalidates capacity if another team fills last slot while confirmation was open', async () => {
  const tourId = 'tour-reval-cap';
  const regId = 'reg-reval-cap';
  const leaderId = 'ldr-reval-cap';
  const teamId = 'team-reval-cap';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-reval',
    name: 'Fast Fill Tour',
  });

  const currentCycleId = `${regId}:cycle-cap-1`;
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-reval',
    displayName: 'Rush Hour',
    totalSlots: 2,
    reservedSlots: 0,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-cap',
    idpChannelId: 'chan-idp-cap',
    currentCycleId,
  });

  // Pre-fill all 2 slots by other teams
  await saveConfigurableEntry({
    entryId: 'e1',
    registrationId: regId,
    cycleId: currentCycleId,
    teamId: 'other-1',
    teamName: 'Other 1',
    slotNumber: 1,
    status: 'CONFIRMED',
  });
  await saveConfigurableEntry({
    entryId: 'e2',
    registrationId: regId,
    cycleId: currentCycleId,
    teamId: 'other-2',
    teamName: 'Other 2',
    slotNumber: 2,
    status: 'CONFIRMED',
  });

  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Too Late Squad',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'TL1', uid: '321' }],
  });

  let replyPayload = null;
  const mockInteraction = {
    isButton: () => true,
    guildId: 'guild-reval',
    user: { id: leaderId },
    update: async (p) => { replyPayload = p; },
    reply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  assert.ok(replyPayload);
  assert.match(replyPayload.content, /all available slots for this registration instance have just been filled/);

  // Status must be automatically set to CLOSED
  const regAfter = await getConfigurableRegistration(regId);
  assert.equal(regAfter.status, 'CLOSED');
});

test('Registration Confirmation - Revalidates team leader permissions if changed before confirm', async () => {
  const tourId = 'tour-reval-ldr';
  const regId = 'reg-reval-ldr';
  const originalLeader = 'ldr-orig';
  const newLeader = 'ldr-new';
  const teamId = 'team-reval-ldr';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-reval',
    name: 'Leadership Cup',
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-reval',
    displayName: 'Reg 1',
    totalSlots: 10,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-l',
    idpChannelId: 'chan-idp-l',
    currentCycleId: `${regId}:cycle-l-1`,
  });

  // Team leader was changed to newLeader
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Mutiny Esports',
    leaderDiscordId: newLeader,
    players: [
      { discordId: newLeader, ign: 'NewBoss', uid: '111' },
      { discordId: originalLeader, ign: 'ExBoss', uid: '222' },
    ],
  });

  // originalLeader tries to confirm
  let replyPayload = null;
  const mockInteraction = {
    isButton: () => true,
    guildId: 'guild-reval',
    user: { id: originalLeader },
    update: async (p) => { replyPayload = p; },
    reply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  assert.ok(replyPayload);
  assert.match(replyPayload.content, /Only the original verified team leader can confirm registration/);
});

test('Registration Router - Global interaction router dispatches confirm and cancel button clicks', async () => {
  const tourId = 'tour-router-dispatch';
  const regId = 'reg-router-dispatch';
  const leaderId = 'ldr-router-dispatch';
  const teamId = 'team-router-dispatch';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId: 'guild-router',
    name: 'Dispatch Tour',
  });

  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId: 'guild-router',
    displayName: 'Dispatch Reg',
    totalSlots: 10,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-rd',
    idpChannelId: 'chan-idp-rd',
    currentCycleId: `${regId}:cycle-rd-1`,
  });

  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Router Runners',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'Runner1', uid: '444' }],
  });

  // 1. Confirm through handleConfigurableTournamentInteraction
  let confirmReply = null;
  const confirmInteraction = {
    customId: `md_cfg_reg_confirm_${regId}:${teamId}`,
    isButton: () => true,
    guildId: 'guild-router',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    update: async (p) => { confirmReply = p; },
    reply: async (p) => { confirmReply = p; },
  };

  const handledConfirm = await handleConfigurableTournamentInteraction(confirmInteraction);
  assert.equal(handledConfirm, true);
  assert.ok(confirmReply);
  assert.match(confirmReply.content, /Your squad has been successfully registered!/);

  // 2. Cancel through handleConfigurableTournamentInteraction
  let cancelReply = null;
  const cancelInteraction = {
    customId: `md_cfg_reg_cancel_${regId}:${teamId}`,
    isButton: () => true,
    user: { id: leaderId },
    update: async (p) => { cancelReply = p; },
    reply: async (p) => { cancelReply = p; },
  };

  const handledCancel = await handleConfigurableTournamentInteraction(cancelInteraction);
  assert.equal(handledCancel, true);
  assert.ok(cancelReply);
  assert.match(cancelReply.content, /Registration cancelled/);
});




