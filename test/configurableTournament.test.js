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
  getLockedSlotNumbers,
  saveRegistrationSlotState,
  syncRegistrationSlotStates,
  getRegistrationSlotStates,
  lockRegistrationSlots,
  unlockRegistrationSlots,
  getTournamentPlayerMemberships,
  checkTournamentPlayerExclusivity,
  saveConfigurableTeamWithExclusivity,
  releaseTeamPlayerMemberships,
  recordConfigurableAuditLog,
  getConfigurableAuditLogs,
  markConfigurableEntryRemoved,
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
  computeNextScheduleTimestamps,
  getExactTimeInTimezone,
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
  sortTournamentRegistrations,
  buildExpectedTournamentChannelOrder,
  reorderTournamentCategoryChannels,
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
  buildRegistrationDescriptionText,
  buildRegistrationMessageText,
  resolveRegistrationStatus,
  evaluateEffectiveRegistrationOpenState,
  formatRegistrationStartTime,
  formatRegistrationHeaderLine,
  getTournamentVerifyChannelMention,
  updateRegistrationMessage,
  buildRegistrationComponents,
  buildManageDashboardPayload,
  buildConfirmationCustomId,
  parseConfirmationCustomId,
  handleAddRegistrationButton,
  handleAddRegistrationModalSubmit,
  handleRegisterSquadButtonClick,
  handleSelectRegistrationTeam,
  handleConfirmRegistrationButtonClick,
  handleCancelRegistrationButtonClick,
  handleManageSelectMenu,
  handleToggleStatus,
  handleRefreshRegistration,
  handleEditRegistrationButton,
  handleEditRegistrationModalSubmit,
  handleViewCurrentSlotChart,
  handleRefreshSlotChartView,
  handleBackToManageRegistration,
  buildManageReservedSlotsPayload,
  handleManageReservedSlotsButton,
  handleLockSlotsSelect,
  handleUnlockSlotsSelect,
  handleOccupiedSlotReassignAndLock,
  handleOccupiedSlotRemoveAndLock,
  buildRemoveTeamMenuPayload,
  handleRemoveTeamMenuButton,
  buildRemoveTeamConfirmPayload,
  handleRemoveTeamSelect,
  handleConfirmRemoveTeamFromRegistration,
  handleCancelRemoveTeamFromRegistration,
  handleDeleteRegistration,
  clearPendingScheduleUploads,
  buildScheduleManagementPayload,
  validateScheduleImageAttachment,
  handleScheduleButton,
  handleUploadScheduleButton,
  handleCancelUploadScheduleButton,
  handleScheduleImageUploadMessage,
  publishRegistrationScheduleImage,
  handleViewScheduleButton,
  handleRemoveSchedulePromptButton,
  handleConfirmRemoveScheduleButton,
  handleCancelRemoveScheduleButton,
  reconcileRegistrationScheduleMessage,
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
    const { registrationId: regId, cycleId, teamId } = parseConfirmationCustomId(confirmBtn.data.custom_id);
    await handleConfirmRegistrationButtonClick(interaction, regId, teamId, cycleId);
  }
}

import {
  buildSlotChartEmbed,
  updateSlotChartMessage,
  updateRegistrationSlotList,
  syncRegistrationSlotList,
  retrySlotListSync,
  buildSlotListText,
  buildSlotListTitle,
  formatSlotListCodeBlock,
  getFilledSlotCounter,
  buildSlotListChunks,
  changeTeamSlot,
  removeTeamFromRegistration,
} from '../slotChartService.js';

import {
  checkRegistrationLifecycles,
  reconcileConfigurableTournaments,
  executeDailyCycleReset,
  armRegistrationTimer,
  clearAllRegistrationTimers,
  getArmedRegistrationTimer,
} from '../registrationScheduler.js';

test.beforeEach(() => {
  clearAllRegistrationTimers();
  clearPendingScheduleUploads();
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
  assert.equal(createdChannels[0].name, '𝐓𝟑｜info');
  assert.equal(createdChannels[1].name, '𝐓𝟑｜updates');
  assert.equal(createdChannels[2].name, '𝐓𝟑｜verify');

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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #/);

  // Register in Group 2 -> Success (Multiple Registrations allowed for same squad)
  const int2 = regInteraction('reg-group-2', leaderId);
  await registerSquadFull(int2, 'reg-group-2');
  assert.match(regInteraction.lastReply.content, /Registered! Slot #/);

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
  assert.match(regInteraction.lastReply.content, /Slot #3/);

  // Register Team 2 (allocates slot 4)
  await registerSquadFull(regInteraction('ldr-2'), regId);
  assert.match(regInteraction.lastReply.content, /Slot #4/);

  // Register Team 3 (allocates slot 5 - last available slot!)
  await registerSquadFull(regInteraction('ldr-3'), regId);
  assert.match(regInteraction.lastReply.content, /Slot #5/);

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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #/);

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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #/);

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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #/);

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

  // Row 1 (5 primary buttons) + Row 2 (📅 Schedule button)
  assert.equal(payload.components.length, 2);
  const row = payload.components[0];
  const scheduleRow = payload.components[1];

  // Exactly 5 Buttons in Row 1
  assert.equal(row.components.length, 5);
  assert.equal(scheduleRow.components.length, 1);
  assert.equal(scheduleRow.components[0].data.custom_id, 'md_cfg_schedule_reg-dash-5btn');
  assert.equal(scheduleRow.components[0].data.label, 'Schedule');
  assert.equal(scheduleRow.components[0].data.emoji.name, '📅');

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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #2/);

  // 2. SAME Team registers in Evening registration in the SAME tournament -> succeeds!
  await registerSquadFull(regInteraction, regIdEvening);
  assert.match(regInteraction.lastReply.content, /Registered! Slot #2/);

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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #3/);

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
    /Registered! Slot #3/,
    'Team must be allowed to register in new registration channel without being blocked by old deleted channel'
  );
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
  assert.match(regInteraction.lastReply.content, /Registered! Slot #/);

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
    /Registered! Slot #1/,
    'Register button must NOT claim already registered when slot chart was empty'
  );

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
  assert.equal(
    replyPayload.content,
    `Register **Glory Hunters** in **T3 10PM Qualifier**?\nTotal slots: 18`,
    'Message text must show Register **<Team Name>** in **<Registration Name>**? and Total slots: <usable slots>'
  );
  assert.ok(replyPayload.embeds?.length > 0);

  const embed = replyPayload.embeds[0].data;
  assert.equal(embed.title, 'Confirm Squad Registration');
  assert.equal(
    embed.description,
    [
      'Register **Glory Hunters** in **T3 10PM Qualifier**?',
      '• Tournament: Champions Arena',
      '• Registration: T3 10PM Qualifier',
      '• Team: Glory Hunters',
      '• Available Slots: 18',
      '• Status: OPEN',
    ].join('\n'),
    'Embed description must match exact confirmation layout'
  );
  assert.doesNotMatch(embed.description, /Total Available Slots/, 'Old Free Slots / Total Available Slots wording must be removed');

  // Verify buttons
  const buttons = replyPayload.components[0].components;
  assert.equal(buttons.length, 2);
  const confirmBtn = buttons[0];
  const cancelBtn = buttons[1];
  assert.equal(confirmBtn.data.label, 'Confirm');
  assert.equal(confirmBtn.data.custom_id, `md_cfg_reg_confirm_${regId}:cycle-conf-1:team-conf-1`);
  assert.equal(cancelBtn.data.label, 'Cancel');
  assert.equal(cancelBtn.data.custom_id, `md_cfg_reg_cancel_${regId}:cycle-conf-1:team-conf-1`);

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
  assert.equal(replyPayload.content, 'Registered! Slot #2, your IDP channel is <#chan-idp-succ>.');

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
  assert.match(confirmReply.content, /Registered! Slot #/);

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

// ---------------------------------------------------------------------------
// TIMEOUT BUG FIX & CONFIRMATION INTERACTION TEST SUITE
// ---------------------------------------------------------------------------

test('Confirmation Timeout Fix - Normal confirmation immediately defers reply and edits reply', async () => {
  const tourId = 'tour-to-norm';
  const regId = 'reg-to-norm';
  const teamId = 'team-to-norm';
  const leaderId = 'ldr-to-norm';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Timeout Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Timeout Reg',
    totalSlots: 10,
    reservedSlots: 0,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-norm',
    idpChannelId: 'chan-idp-norm',
    currentCycleId: `${regId}:cycle-norm`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Norm',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'LeaderN', uid: '111' }],
  });

  let deferred = false;
  let deferredEphemeral = false;
  let finalPayload = null;
  const mockInteraction = {
    id: 'int-norm-1',
    isButton: () => true,
    guildId: 'guild-norm',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    deferReply: async (opts) => {
      deferred = true;
      deferredEphemeral = opts?.ephemeral === true;
      mockInteraction.deferred = true;
    },
    editReply: async (payload) => {
      finalPayload = payload;
    },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  // 1. Interaction was deferred immediately with ephemeral: true
  assert.equal(deferred, true);
  assert.equal(deferredEphemeral, true);
  // 2. Final response was delivered via editReply
  assert.ok(finalPayload);
  assert.equal(finalPayload.content, 'Registered! Slot #1, your IDP channel is <#chan-idp-norm>.');
});

test('Confirmation Timeout Fix - Cancellation acknowledges immediately and creates no entry', async () => {
  const tourId = 'tour-to-cancel';
  const regId = 'reg-to-cancel';
  const teamId = 'team-to-cancel';
  const leaderId = 'ldr-to-cancel';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Cancel Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    status: 'OPEN',
    currentCycleId: `${regId}:cycle-cancel`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Cancel',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'LeaderC', uid: '222' }],
  });

  let updateDeferred = false;
  let finalReply = null;
  const mockInteraction = {
    id: 'int-cancel-1',
    isButton: () => true,
    user: { id: leaderId },
    deferUpdate: async () => {
      updateDeferred = true;
      mockInteraction.deferred = true;
    },
    editReply: async (p) => { finalReply = p; },
    update: async (p) => { finalReply = p; },
  };

  await handleCancelRegistrationButtonClick(mockInteraction, regId, teamId);

  assert.equal(updateDeferred, true);
  assert.ok(finalReply);
  assert.match(finalReply.content, /Registration cancelled/);

  // Verify no entries were created
  const entries = await getConfigurableEntriesForRegistration(regId, `${regId}:cycle-cancel`);
  assert.equal(entries.length, 0);
});

test('Confirmation Timeout Fix - Slow MongoDB response does not block immediate deferReply', async () => {
  const tourId = 'tour-to-slow-db';
  const regId = 'reg-to-slow-db';
  const teamId = 'team-to-slow-db';
  const leaderId = 'ldr-to-slow-db';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Slow DB Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Slow DB Reg',
    totalSlots: 10,
    reservedSlots: 0,
    status: 'OPEN',
    currentCycleId: `${regId}:cycle-slow-db`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Slow DB',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'LeaderSlow', uid: '333' }],
  });

  const timeline = [];
  const mockInteraction = {
    id: 'int-slow-db',
    isButton: () => true,
    guildId: 'guild-slow',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    deferReply: async () => {
      timeline.push('deferReply');
      mockInteraction.deferred = true;
    },
    editReply: async () => {
      timeline.push('editReply');
    },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  // deferReply must happen as the very first action
  assert.equal(timeline[0], 'deferReply');
  assert.equal(timeline[timeline.length - 1], 'editReply');
});

test('Confirmation Timeout Fix - Slow Discord permission update completes safely after deferReply', async () => {
  const tourId = 'tour-to-slow-perm';
  const regId = 'reg-to-slow-perm';
  const teamId = 'team-to-slow-perm';
  const leaderId = 'ldr-to-slow-perm';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Slow Perm Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Slow Perm Reg',
    totalSlots: 10,
    reservedSlots: 0,
    status: 'OPEN',
    idpChannelId: 'chan-idp-slow',
    currentCycleId: `${regId}:cycle-slow-perm`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Slow Perm',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'LeaderP', uid: '444' }],
  });

  let permissionEdited = false;
  let replyDeferred = false;
  const mockGuild = {
    channels: {
      fetch: async (chanId) => {
        if (chanId === 'chan-idp-slow') {
          return {
            permissionOverwrites: {
              edit: async () => {
                // Simulating delayed network call to Discord API
                await new Promise((r) => setTimeout(r, 50));
                permissionEdited = true;
              },
            },
          };
        }
        return null;
      },
    },
  };

  const mockInteraction = {
    id: 'int-slow-perm',
    isButton: () => true,
    guild: mockGuild,
    guildId: 'guild-slow-perm',
    user: { id: leaderId },
    client: { channels: mockGuild.channels },
    deferReply: async () => {
      replyDeferred = true;
      mockInteraction.deferred = true;
    },
    editReply: async () => {},
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  assert.equal(replyDeferred, true, 'Interaction deferred before permission update');
  assert.equal(permissionEdited, true, 'Permission update succeeded');
});

test('Confirmation Timeout Fix - Simultaneous confirmation clicks handled via idempotency', async () => {
  const tourId = 'tour-to-simul';
  const regId = 'reg-to-simul';
  const teamId = 'team-to-simul';
  const leaderId = 'ldr-to-simul';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Simul Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Simul Reg',
    totalSlots: 16,
    reservedSlots: 0,
    status: 'OPEN',
    currentCycleId: `${regId}:cycle-simul`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Simul',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'LeaderS', uid: '555' }],
  });

  const replies = [];
  const makeInteraction = (id) => ({
    id,
    isButton: () => true,
    guildId: 'guild-simul',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    deferReply: async () => {},
    editReply: async (p) => { replies.push(p); },
  });

  // Launch two confirmations simultaneously for the same team and registration
  const p1 = handleConfirmRegistrationButtonClick(makeInteraction('int-sim-1'), regId, teamId);
  const p2 = handleConfirmRegistrationButtonClick(makeInteraction('int-sim-2'), regId, teamId);

  await Promise.all([p1, p2]);

  // Exactly one registration entry exists in MongoDB
  const entries = await getConfigurableEntriesForRegistration(regId, `${regId}:cycle-simul`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].teamId, teamId);
});

test('Confirmation Timeout Fix - Last available slot claimed by another team returns slots filled', async () => {
  const tourId = 'tour-to-race-last';
  const regId = 'reg-to-race-last';
  const leaderId = 'ldr-to-race-last';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Race Last Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Race Last Reg',
    totalSlots: 1, // Only 1 total slot
    reservedSlots: 0,
    status: 'OPEN',
    currentCycleId: `${regId}:cycle-race-last`,
  });

  // Another team already claimed the only slot
  await saveConfigurableEntry({
    entryId: 'entry-claimed-already',
    registrationId: regId,
    cycleId: `${regId}:cycle-race-last`,
    teamId: 'other-team',
    slotNumber: 1,
    status: 'CONFIRMED',
  });

  await saveConfigurableTeam({
    teamId: 'team-late',
    tournamentId: tourId,
    teamName: 'Team Late',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'LateLdr', uid: '666' }],
  });

  let replyPayload = null;
  const mockInteraction = {
    id: 'int-late',
    isButton: () => true,
    guildId: 'guild-late',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    deferReply: async () => { mockInteraction.deferred = true; },
    editReply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, 'team-late');

  assert.ok(replyPayload);
  assert.match(replyPayload.content, /all available slots have been filled/);
});

test('Confirmation Timeout Fix - Registration closing during confirmation returns currently closed', async () => {
  const tourId = 'tour-to-closed';
  const regId = 'reg-to-closed';
  const teamId = 'team-to-closed';
  const leaderId = 'ldr-to-closed';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Closed Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Closed Reg',
    totalSlots: 10,
    reservedSlots: 0,
    status: 'CLOSED', // Closed in background
    currentCycleId: `${regId}:cycle-closed`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Closed',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'ClosedLdr', uid: '777' }],
  });

  let replyPayload = null;
  const mockInteraction = {
    id: 'int-closed',
    isButton: () => true,
    guildId: 'guild-closed',
    user: { id: leaderId },
    client: { channels: { fetch: async () => null } },
    deferReply: async () => { mockInteraction.deferred = true; },
    editReply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  assert.ok(replyPayload);
  assert.match(replyPayload.content, /This registration is currently closed/);
});

test('Confirmation Timeout Fix - Failed IDP permission assignment preserves valid registration', async () => {
  const tourId = 'tour-to-fail-idp';
  const regId = 'reg-to-fail-idp';
  const teamId = 'team-to-fail-idp';
  const leaderId = 'ldr-to-fail-idp';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Fail IDP Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Fail IDP Reg',
    totalSlots: 10,
    reservedSlots: 0,
    status: 'OPEN',
    idpChannelId: 'chan-idp-error',
    currentCycleId: `${regId}:cycle-fail-idp`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Fail IDP',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'FailIdpLdr', uid: '888' }],
  });

  // Mock IDP channel that throws when editing permissions
  const mockGuild = {
    channels: {
      fetch: async (chanId) => {
        if (chanId === 'chan-idp-error') {
          return {
            permissionOverwrites: {
              edit: async () => {
                throw new Error('Discord API 50035: Invalid Form Body / Network timeout');
              },
            },
          };
        }
        return null;
      },
    },
  };

  let replyPayload = null;
  const mockInteraction = {
    id: 'int-fail-idp',
    isButton: () => true,
    guild: mockGuild,
    guildId: 'guild-fail-idp',
    user: { id: leaderId },
    client: { channels: mockGuild.channels },
    deferReply: async () => { mockInteraction.deferred = true; },
    editReply: async (p) => { replyPayload = p; },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction, regId, teamId);

  // 1. Success message is still shown to the user
  assert.ok(replyPayload);
  assert.match(replyPayload.content, /Registered! Slot #/);

  // 2. Registration is preserved in MongoDB
  const entries = await getConfigurableEntriesForRegistration(regId, `${regId}:cycle-fail-idp`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].teamId, teamId);
  assert.equal(entries[0].permissionPending, true, 'Permission queued for reconciliation');
});

test('Confirmation Timeout Fix - Repeated confirmation attempts after successful registration returns duplicate warning', async () => {
  const tourId = 'tour-to-repeat';
  const regId = 'reg-to-repeat';
  const teamId = 'team-to-repeat';
  const leaderId = 'ldr-to-repeat';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Repeat Tour' });
  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: 'Repeat Reg',
    totalSlots: 10,
    reservedSlots: 0,
    status: 'OPEN',
    idpChannelId: 'chan-idp-repeat',
    currentCycleId: `${regId}:cycle-repeat`,
  });
  await saveConfigurableTeam({
    teamId,
    tournamentId: tourId,
    teamName: 'Team Repeat',
    leaderDiscordId: leaderId,
    players: [{ discordId: leaderId, ign: 'RepeatLdr', uid: '999' }],
  });

  const makeInteraction = (id) => {
    let payload = null;
    return {
      id,
      isButton: () => true,
      guildId: 'guild-repeat',
      user: { id: leaderId },
      client: { channels: { fetch: async () => null } },
      deferReply: async function () { this.deferred = true; },
      editReply: async (p) => { payload = p; },
      getPayload: () => payload,
    };
  };

  // First confirmation
  const int1 = makeInteraction('int-rep-1');
  await handleConfirmRegistrationButtonClick(int1, regId, teamId);
  assert.match(int1.getPayload().content, /Registered! Slot #/);

  // Repeated confirmation
  const int2 = makeInteraction('int-rep-2');
  await handleConfirmRegistrationButtonClick(int2, regId, teamId);
  assert.match(int2.getPayload().content, /already registered in this daily cycle/);
});

// ---------------------------------------------------------------------------
// REAL-TIME SLOT LIST & CONFIRMATION WORKFLOW TESTS
// ---------------------------------------------------------------------------

test('Real-Time Slot List & Confirmation - Complete Lifecycle & In-Place Message Sync', async () => {
  const tourId = 'tour-rt-sync';
  const regId = 'reg-rt-sync';
  const team1Id = 'team-rt-1';
  const team2Id = 'team-rt-2';
  const leader1Id = 'ldr-rt-1';
  const leader2Id = 'ldr-rt-2';

  await saveConfigurableTournament({
    tournamentId: tourId,
    name: 'T3 Scrims',
  });

  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: regId,
    displayName: '10PM',
    totalSlots: 6,
    reservedSlots: 2, // Slot 01 and Slot 02 are LOCKED
    status: 'OPEN',
    idpChannelId: 'chan-idp-rt',
    registrationChannelId: 'chan-reg-rt',
    currentCycleId: `${regId}:cycle-rt`,
  });

  await saveConfigurableTeam({
    teamId: team1Id,
    tournamentId: tourId,
    teamName: 'Team Alpha',
    leaderDiscordId: leader1Id,
    players: [{ discordId: leader1Id, ign: 'AlphaLead', uid: '111' }],
  });

  await saveConfigurableTeam({
    teamId: team2Id,
    tournamentId: tourId,
    teamName: 'Team Bravo',
    leaderDiscordId: leader2Id,
    players: [{ discordId: leader2Id, ign: 'BravoLead', uid: '222' }],
  });

  let idpMessages = [];
  const mockIdpChannel = {
    id: 'chan-idp-rt',
    isTextBased: () => true,
    send: async (payload) => {
      const msg = {
        id: `idp-msg-${idpMessages.length + 1}`,
        content: payload.content,
        edit: async (newP) => {
          msg.content = newP.content;
          return msg;
        },
      };
      idpMessages.push(msg);
      return msg;
    },
    messages: {
      fetch: async (id) => idpMessages.find((m) => m.id === id) || null,
    },
  };

  const mockClient = {
    channels: {
      fetch: async (id) => (id === 'chan-idp-rt' ? mockIdpChannel : null),
    },
  };

  // 1. Initial slot list generation
  await updateRegistrationSlotList(regId, `${regId}:cycle-rt`, mockClient);
  assert.equal(idpMessages.length, 1, 'Initial message created');
  const initialContent = idpMessages[0].content;
  assert.match(initialContent, /T3 Scrims 10PM Slotlist/);
  assert.match(initialContent, /Slot 01 → 🔒 LOCKED/);
  assert.match(initialContent, /Slot 02 → 🔒 LOCKED/);
  assert.match(initialContent, /Slot 03 → AVAILABLE/);
  assert.match(initialContent, /Slot 04 → AVAILABLE/);
  assert.match(initialContent, /Slot 05 → AVAILABLE/);
  assert.match(initialContent, /Slot 06 → AVAILABLE/);
  assert.match(initialContent, /⚪ 0\/4 filled/);

  // 2. First squad registers: Team Alpha
  let interaction1Payload = null;
  let interaction1DeferredUpdate = false;
  const mockInteraction1 = {
    id: 'int-confirm-1',
    isButton: () => true,
    guildId: 'guild-rt',
    user: { id: leader1Id },
    client: mockClient,
    deferUpdate: async () => {
      interaction1DeferredUpdate = true;
      mockInteraction1.deferred = true;
    },
    editReply: async (p) => {
      interaction1Payload = p;
    },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction1, regId, team1Id);

  // Verification of ephemeral confirmation response
  assert.equal(interaction1DeferredUpdate, true, 'Acknowledged immediately with deferUpdate');
  assert.ok(interaction1Payload, 'Returned Registration Successful payload');
  assert.equal(interaction1Payload.content, 'Registered! Slot #3, your IDP channel is <#chan-idp-rt>.');
  assert.deepEqual(interaction1Payload.components, [], 'Confirm and Cancel buttons are completely removed');

  // Verification of real-time slot list update
  assert.equal(idpMessages.length, 1, 'Did not duplicate IDP message; edited in-place');
  const updatedContent1 = idpMessages[0].content;
  assert.match(updatedContent1, /Slot 01 → 🔒 LOCKED/);
  assert.match(updatedContent1, /Slot 02 → 🔒 LOCKED/);
  assert.match(updatedContent1, /Slot 03 → Team Alpha/);
  assert.match(updatedContent1, /Slot 04 → AVAILABLE/);
  assert.match(updatedContent1, /🟡 1\/4 filled/);

  // 3. Second squad registers: Team Bravo
  let interaction2Payload = null;
  const mockInteraction2 = {
    id: 'int-confirm-2',
    isButton: () => true,
    guildId: 'guild-rt',
    user: { id: leader2Id },
    client: mockClient,
    deferUpdate: async () => {
      mockInteraction2.deferred = true;
    },
    editReply: async (p) => {
      interaction2Payload = p;
    },
  };

  await handleConfirmRegistrationButtonClick(mockInteraction2, regId, team2Id);

  assert.ok(interaction2Payload);
  assert.equal(interaction2Payload.content, 'Registered! Slot #4, your IDP channel is <#chan-idp-rt>.');
  assert.deepEqual(interaction2Payload.components, [], 'Buttons removed');

  // Verification of real-time slot list update
  assert.equal(idpMessages.length, 1, 'Still exactly 1 persistent IDP message');
  const updatedContent2 = idpMessages[0].content;
  assert.match(updatedContent2, /Slot 03 → Team Alpha/);
  assert.match(updatedContent2, /Slot 04 → Team Bravo/);
  assert.match(updatedContent2, /Slot 05 → AVAILABLE/);
  assert.match(updatedContent2, /🟡 2\/4 filled/);

  // 4. Cancellation test
  let cancelPayload = null;
  let cancelDeferred = false;
  const mockCancelInteraction = {
    id: 'int-cancel-rt',
    isButton: () => true,
    user: { id: leader1Id },
    deferUpdate: async () => {
      cancelDeferred = true;
      mockCancelInteraction.deferred = true;
    },
    editReply: async (p) => {
      cancelPayload = p;
    },
    update: async (p) => {
      cancelPayload = p;
    },
  };

  await handleCancelRegistrationButtonClick(mockCancelInteraction, regId, team1Id);
  assert.equal(cancelDeferred, true);
  assert.ok(cancelPayload);
  assert.match(cancelPayload.content, /Registration cancelled/);
  assert.deepEqual(cancelPayload.components, [], 'Cancel buttons removed');
});

test('Real-Time Slot List - Multiple registrations remain strictly independent', async () => {
  const tourId = 'tour-indep-slot';
  const reg1Id = 'reg-indep-1';
  const reg2Id = 'reg-indep-2';

  await saveConfigurableTournament({ tournamentId: tourId, name: 'Independent Tour' });

  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: reg1Id,
    displayName: '10 PM',
    totalSlots: 4,
    reservedSlots: 1,
    status: 'OPEN',
    idpChannelId: 'chan-idp-indep-1',
    currentCycleId: `${reg1Id}:cycle-1`,
  });

  await saveConfigurableRegistration({
    tournamentId: tourId,
    registrationId: reg2Id,
    displayName: '11 PM',
    totalSlots: 4,
    reservedSlots: 0,
    status: 'OPEN',
    idpChannelId: 'chan-idp-indep-2',
    currentCycleId: `${reg2Id}:cycle-2`,
  });

  // Register Team Phoenix only in reg1
  await saveConfigurableEntry({
    entryId: 'ent-indep-1',
    registrationId: reg1Id,
    cycleId: `${reg1Id}:cycle-1`,
    teamId: 'tm-phoenix',
    teamName: 'Team Phoenix',
    slotNumber: 2,
    status: 'CONFIRMED',
  });

  let msg1 = null;
  let msg2 = null;

  const client = {
    channels: {
      fetch: async (chanId) => {
        if (chanId === 'chan-idp-indep-1') {
          return {
            id: chanId,
            isTextBased: () => true,
            send: async (p) => { msg1 = p.content; return { id: 'm1', content: p.content, edit: async (np) => { msg1 = np.content; } }; },
            messages: { fetch: async () => null },
          };
        }
        if (chanId === 'chan-idp-indep-2') {
          return {
            id: chanId,
            isTextBased: () => true,
            send: async (p) => { msg2 = p.content; return { id: 'm2', content: p.content, edit: async (np) => { msg2 = np.content; } }; },
            messages: { fetch: async () => null },
          };
        }
        return null;
      },
    },
  };

  await updateRegistrationSlotList(reg1Id, `${reg1Id}:cycle-1`, client);
  await updateRegistrationSlotList(reg2Id, `${reg2Id}:cycle-2`, client);

  // Reg 1 contains Team Phoenix on slot 2 and slot 1 locked
  assert.match(msg1, /Slot 01 → 🔒 LOCKED/);
  assert.match(msg1, /Slot 02 → Team Phoenix/);
  assert.match(msg1, /Slot 03 → AVAILABLE/);

  // Reg 2 does NOT contain Team Phoenix; slot 1 is available
  assert.match(msg2, /Slot 01 → AVAILABLE/);
  assert.doesNotMatch(msg2, /Team Phoenix/);
});

test('Mandatory Verification Suite (Tests 1-6) - End-to-End Registration to IDP Slot List Synchronization', async () => {
  const guildId = 'guild-mandatory-suite';
  const tourId = 'tour-t3-scrims';
  const reg12pmId = 'reg-12pm-mandatory';
  const reg3pmId = 'reg-3pm-mandatory';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId,
    name: 'T3 Scrims',
    categoryId: 'cat-mandatory',
    enrollTeamChannelId: 'chan-enroll-mandatory',
    status: 'ACTIVE',
  });

  // Enroll 3 teams: Team Alpha, Team Bravo, Team Phoenix
  const teamAlphaId = 'team-alpha-mand';
  const teamBravoId = 'team-bravo-mand';
  const teamPhoenixId = 'team-phoenix-mand';
  const leaderAlpha = 'leader-alpha-mand';
  const leaderBravo = 'leader-bravo-mand';
  const leaderPhoenix = 'leader-phoenix-mand';

  await saveConfigurableTeam({
    teamId: teamAlphaId,
    tournamentId: tourId,
    teamName: 'Team Alpha',
    leaderDiscordId: leaderAlpha,
    players: [{ discordId: leaderAlpha, ign: 'AlphaLead', uid: '101' }],
  });
  await saveConfigurableTeam({
    teamId: teamBravoId,
    tournamentId: tourId,
    teamName: 'Team Bravo',
    leaderDiscordId: leaderBravo,
    players: [{ discordId: leaderBravo, ign: 'BravoLead', uid: '102' }],
  });
  await saveConfigurableTeam({
    teamId: teamPhoenixId,
    tournamentId: tourId,
    teamName: 'Team Phoenix',
    leaderDiscordId: leaderPhoenix,
    players: [{ discordId: leaderPhoenix, ign: 'PhoenixLead', uid: '103' }],
  });

  const activeEval = evaluateDailyCycleStatus('00:01', '23:59', 'Asia/Kolkata', new Date());
  const activeCycleDate = activeEval.cycleDate;
  const endedCycleDate = activeEval.endedCycleDate;
  const cycle12pm = `${reg12pmId}:${activeCycleDate}`;
  const cycle3pm = `${reg3pmId}:${activeCycleDate}`;

  // Mock Discord channels and persistent messages
  const channelStore = {
    'cat-mandatory': { id: 'cat-mandatory', messages: new Map(), permissions: new Map() },
    'chan-enroll-mandatory': { id: 'chan-enroll-mandatory', messages: new Map(), permissions: new Map() },
    'chan-reg-12pm': { id: 'chan-reg-12pm', messages: new Map(), permissions: new Map() },
    'chan-idp-12pm': { id: 'chan-idp-12pm', messages: new Map(), permissions: new Map() },
    'chan-reg-3pm': { id: 'chan-reg-3pm', messages: new Map(), permissions: new Map() },
    'chan-idp-3pm': { id: 'chan-idp-3pm', messages: new Map(), permissions: new Map() },
  };

  const makeChannelObj = (chanId) => {
    const store = channelStore[chanId];
    if (!store) return null;
    return {
      id: chanId,
      isTextBased: () => true,
      permissionOverwrites: {
        edit: async (targetId, perms) => {
          store.permissions.set(targetId, perms);
        },
        delete: async (targetId) => {
          store.permissions.delete(targetId);
        },
      },
      send: async (payload) => {
        const msgId = `msg-${chanId}-${store.messages.size + 1}`;
        const msgObj = {
          id: msgId,
          content: payload.content || '',
          embeds: payload.embeds || [],
          components: payload.components || [],
          edit: async (editPayload) => {
            if (editPayload.content !== undefined) msgObj.content = editPayload.content;
            if (editPayload.embeds !== undefined) msgObj.embeds = editPayload.embeds;
            if (editPayload.components !== undefined) msgObj.components = editPayload.components;
            return msgObj;
          },
          delete: async () => {
            store.messages.delete(msgId);
          },
        };
        store.messages.set(msgId, msgObj);
        return msgObj;
      },
      messages: {
        fetch: async (msgId) => {
          if (typeof msgId === 'string') {
            const found = store.messages.get(msgId);
            if (!found) {
              const err = new Error('Unknown Message');
              err.code = 10008;
              throw err;
            }
            return found;
          }
          return store.messages;
        },
      },
    };
  };

  const mockGuild = {
    id: guildId,
    roles: { everyone: { id: guildId } },
    channels: {
      cache: {
        get: (id) => makeChannelObj(id),
      },
      fetch: async (id) => makeChannelObj(id),
    },
  };

  const mockClient = {
    guilds: {
      cache: new Map([[guildId, mockGuild]]),
      fetch: async (id) => (id === guildId ? mockGuild : null),
    },
    channels: {
      cache: {
        get: (id) => makeChannelObj(id),
      },
      fetch: async (id) => makeChannelObj(id),
    },
  };

  // Seed initial persistent IDP messages
  const initialIdp12pmMsg = await makeChannelObj('chan-idp-12pm').send({ content: 'Initial 12PM slotlist' });
  const initialIdp3pmMsg = await makeChannelObj('chan-idp-3pm').send({ content: 'Initial 3PM slotlist' });
  const initialReg12pmMsg = await makeChannelObj('chan-reg-12pm').send({ content: 'Initial 12PM reg' });
  const initialReg3pmMsg = await makeChannelObj('chan-reg-3pm').send({ content: 'Initial 3PM reg' });

  await saveConfigurableRegistration({
    registrationId: reg12pmId,
    tournamentId: tourId,
    guildId,
    displayName: '12PM',
    totalSlots: 18,
    reservedSlots: 2,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-12pm',
    registrationMessageId: initialReg12pmMsg.id,
    idpChannelId: 'chan-idp-12pm',
    slotChartMessageId: initialIdp12pmMsg.id,
    idpRoleId: null,
    scheduleMode: 'DAILY_RECURRING',
    dailyStartTime: '00:01',
    dailyEndTime: '23:55',
    dailyResetTime: '23:59',
    timezone: 'Asia/Kolkata',
    currentCycleDate: activeCycleDate,
    currentCycleId: cycle12pm,
    lastResetCycleDate: endedCycleDate,
  });

  await saveConfigurableRegistration({
    registrationId: reg3pmId,
    tournamentId: tourId,
    guildId,
    displayName: '3PM',
    totalSlots: 18,
    reservedSlots: 2,
    status: 'OPEN',
    registrationChannelId: 'chan-reg-3pm',
    registrationMessageId: initialReg3pmMsg.id,
    idpChannelId: 'chan-idp-3pm',
    slotChartMessageId: initialIdp3pmMsg.id,
    idpRoleId: null,
    scheduleMode: 'DAILY_RECURRING',
    dailyStartTime: '00:01',
    dailyEndTime: '23:55',
    dailyResetTime: '23:59',
    timezone: 'Asia/Kolkata',
    currentCycleDate: activeCycleDate,
    currentCycleId: cycle3pm,
    lastResetCycleDate: endedCycleDate,
  });

  await syncRegistrationSlotList(reg12pmId, cycle12pm, mockClient);
  await syncRegistrationSlotList(reg3pmId, cycle3pm, mockClient);
  assert.match(initialIdp12pmMsg.content, /⚪ 0\/16 filled/);
  assert.match(initialIdp3pmMsg.content, /⚪ 0\/16 filled/);

  // =========================================================================
  // TEST 1: Register Team Alpha in 12PM (totalSlots: 18, reservedSlots: 2)
  // Expected: Slot 03 -> Team Alpha, Counter: 🟢 1/16 filled, buttons removed
  // =========================================================================
  let confirmAlphaReply = null;
  const alphaConfirmInteraction = {
    id: 'int-mand-alpha',
    isButton: () => true,
    guildId,
    user: { id: leaderAlpha },
    client: mockClient,
    deferUpdate: async () => { alphaConfirmInteraction.deferred = true; },
    editReply: async (p) => { confirmAlphaReply = p; },
  };

  await handleConfirmRegistrationButtonClick(alphaConfirmInteraction, reg12pmId, teamAlphaId);

  assert.ok(confirmAlphaReply, 'TEST 1: Registration confirmation reply exists');
  assert.equal(confirmAlphaReply.content, 'Registered! Slot #3, your IDP channel is <#chan-idp-12pm>.');
  assert.deepEqual(confirmAlphaReply.components, [], 'TEST 1: Confirm & Cancel buttons removed');

  // Verify duplicate confirmation is blocked
  let duplicateReply = null;
  const alphaDuplicateInteraction = {
    id: 'int-mand-alpha-dup',
    isButton: () => true,
    guildId,
    user: { id: leaderAlpha },
    client: mockClient,
    deferUpdate: async () => { alphaDuplicateInteraction.deferred = true; },
    editReply: async (p) => { duplicateReply = p; },
  };
  await handleConfirmRegistrationButtonClick(alphaDuplicateInteraction, reg12pmId, teamAlphaId);
  assert.match(duplicateReply.content, /already registered/);
  assert.deepEqual(duplicateReply.components, []);

  // Verify IDP 12PM slot list for TEST 1
  assert.equal(channelStore['chan-idp-12pm'].messages.size, 1, 'TEST 1: Edited existing IDP message in-place');
  assert.match(initialIdp12pmMsg.content, /T3 Scrims 12PM Slotlist/);
  assert.match(initialIdp12pmMsg.content, /Slot 01 → 🔒 LOCKED/);
  assert.match(initialIdp12pmMsg.content, /Slot 02 → 🔒 LOCKED/);
  assert.match(initialIdp12pmMsg.content, /Slot 03 → Team Alpha/);
  assert.match(initialIdp12pmMsg.content, /Slot 04 → AVAILABLE/);
  assert.match(initialIdp12pmMsg.content, /Slot 18 → AVAILABLE/);
  assert.match(initialIdp12pmMsg.content, /🟡 1\/16 filled/);

  // =========================================================================
  // TEST 2: Register Team Bravo in 12PM
  // Expected: Slot 03 -> Team Alpha, Slot 04 -> Team Bravo, Counter: 🟡 2/16 filled
  // =========================================================================
  let confirmBravoReply = null;
  const bravoConfirmInteraction = {
    id: 'int-mand-bravo',
    isButton: () => true,
    guildId,
    user: { id: leaderBravo },
    client: mockClient,
    deferUpdate: async () => { bravoConfirmInteraction.deferred = true; },
    editReply: async (p) => { confirmBravoReply = p; },
  };

  await handleConfirmRegistrationButtonClick(bravoConfirmInteraction, reg12pmId, teamBravoId);
  assert.equal(confirmBravoReply.content, 'Registered! Slot #4, your IDP channel is <#chan-idp-12pm>.');
  assert.deepEqual(confirmBravoReply.components, []);

  assert.equal(channelStore['chan-idp-12pm'].messages.size, 1, 'TEST 2: Still 1 persistent message');
  assert.match(initialIdp12pmMsg.content, /Slot 03 → Team Alpha/);
  assert.match(initialIdp12pmMsg.content, /Slot 04 → Team Bravo/);
  assert.match(initialIdp12pmMsg.content, /Slot 05 → AVAILABLE/);
  assert.match(initialIdp12pmMsg.content, /🟡 2\/16 filled/);

  // =========================================================================
  // TEST 3: Register Team Phoenix in another registration instance (3PM)
  // Expected: Only 3PM slot list changes; 12PM remains untouched
  // =========================================================================
  const snapshot12pmBeforeTest3 = initialIdp12pmMsg.content;
  let confirmPhoenixReply = null;
  const phoenixConfirmInteraction = {
    id: 'int-mand-phoenix',
    isButton: () => true,
    guildId,
    user: { id: leaderPhoenix },
    client: mockClient,
    deferUpdate: async () => { phoenixConfirmInteraction.deferred = true; },
    editReply: async (p) => { confirmPhoenixReply = p; },
  };

  await handleConfirmRegistrationButtonClick(phoenixConfirmInteraction, reg3pmId, teamPhoenixId);
  assert.equal(confirmPhoenixReply.content, 'Registered! Slot #3, your IDP channel is <#chan-idp-3pm>.');

  assert.equal(initialIdp12pmMsg.content, snapshot12pmBeforeTest3, 'TEST 3: 12PM slot list unaffected');
  assert.match(initialIdp3pmMsg.content, /T3 Scrims 3PM Slotlist/);
  assert.match(initialIdp3pmMsg.content, /Slot 03 → Team Phoenix/);
  assert.match(initialIdp3pmMsg.content, /🟡 1\/16 filled/);
  assert.doesNotMatch(initialIdp3pmMsg.content, /Team Alpha/);

  // =========================================================================
  // TEST 4: Restart the Discord bot (reconcileConfigurableTournaments + scheduler ticks)
  // Expected: All slot lists retain their correct team names and counters
  // =========================================================================
  const fixedNowDuringOpenWindow = new Date('2026-11-04T06:30:00.000Z'); // 12:00 IST on 2026-11-04
  await reconcileConfigurableTournaments(mockClient);
  await checkRegistrationLifecycles(mockClient, fixedNowDuringOpenWindow);
  await checkRegistrationLifecycles(mockClient, new Date(fixedNowDuringOpenWindow.getTime() + 30000));

  assert.match(initialIdp12pmMsg.content, /Slot 03 → Team Alpha/, 'TEST 4: 12PM retained Team Alpha after restart & scheduler ticks');
  assert.match(initialIdp12pmMsg.content, /Slot 04 → Team Bravo/, 'TEST 4: 12PM retained Team Bravo after restart & scheduler ticks');
  assert.match(initialIdp12pmMsg.content, /🟡 2\/16 filled/, 'TEST 4: 12PM retained 2/16 counter');
  assert.match(initialIdp3pmMsg.content, /Slot 03 → Team Phoenix/, 'TEST 4: 3PM retained Team Phoenix');
  assert.match(initialIdp3pmMsg.content, /🟡 1\/16 filled/, 'TEST 4: 3PM retained 1/16 counter');

  // =========================================================================
  // TEST 5: Cancel or remove a registration through an authorised management action
  // Expected: The corresponding slot list updates correctly
  // =========================================================================
  const removeRes = await removeTeamFromRegistration(reg12pmId, teamAlphaId, mockClient);
  assert.equal(removeRes.success, true, 'TEST 5: Authorised removal succeeded');
  assert.match(initialIdp12pmMsg.content, /Slot 03 → AVAILABLE/, 'TEST 5: Slot 03 freed');
  assert.match(initialIdp12pmMsg.content, /Slot 04 → Team Bravo/, 'TEST 5: Slot 04 still Team Bravo');
  assert.match(initialIdp12pmMsg.content, /🟡 1\/16 filled/, 'TEST 5: Counter updated to 1/16 filled');

  // =========================================================================
  // TEST 6: Register a team, then trigger Refresh
  // Expected: The same accurate slot list remains. No data disappears or duplicates.
  // =========================================================================
  await handleConfirmRegistrationButtonClick(alphaConfirmInteraction, reg12pmId, teamAlphaId);
  assert.match(initialIdp12pmMsg.content, /Slot 03 → Team Alpha/);
  assert.match(initialIdp12pmMsg.content, /Slot 04 → Team Bravo/);
  assert.match(initialIdp12pmMsg.content, /🟡 2\/16 filled/);

  let refreshReply = null;
  const refreshInteraction = {
    id: 'int-mand-refresh',
    isButton: () => true,
    guildId,
    user: { id: 'admin-mand' },
    client: mockClient,
    deferReply: async () => { refreshInteraction.deferred = true; },
    editReply: async (p) => { refreshReply = p; },
    update: async (p) => { refreshReply = p; },
  };
  await handleRefreshRegistration(refreshInteraction, reg12pmId);

  assert.equal(channelStore['chan-idp-12pm'].messages.size, 1, 'TEST 6: Still 1 message after Refresh');
  assert.match(initialIdp12pmMsg.content, /Slot 03 → Team Alpha/, 'TEST 6: Team Alpha preserved after Refresh');
  assert.match(initialIdp12pmMsg.content, /Slot 04 → Team Bravo/, 'TEST 6: Team Bravo preserved after Refresh');
  assert.match(initialIdp12pmMsg.content, /🟡 2\/16 filled/, 'TEST 6: Counter 2/16 preserved after Refresh');
});

test('Registration Message Design & Team Verification Check - Complete End-to-End Suite (Section 7)', async () => {
  const { checkRegistrationLifecycles, reconcileConfigurableTournaments } = await import('../registrationScheduler.js');
  const { removeTeamFromRegistration } = await import('../slotChartService.js');

  const guildId = 'guild-verif-suite';
  const tourId = 'tour-verif-1';
  const otherTourId = 'tour-verif-2';
  const verifyChanId = '998877665544332211';
  const otherVerifyChanId = '112233445566778899';
  const regId = 'reg-t3-verif';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId,
    name: 'T3 Scrims',
    categoryId: 'cat-verif-1',
    enrollTeamChannelId: verifyChanId,
    timezone: 'Asia/Kolkata',
    status: 'ACTIVE',
  });

  await saveConfigurableTournament({
    tournamentId: otherTourId,
    guildId,
    name: 'Other Tournament',
    categoryId: 'cat-verif-2',
    enrollTeamChannelId: otherVerifyChanId,
    timezone: 'Asia/Kolkata',
    status: 'ACTIVE',
  });

  // Mock channels & persistent messages
  const channelStore = {
    'cat-verif-1': { id: 'cat-verif-1', messages: new Map(), permissions: new Map() },
    [verifyChanId]: { id: verifyChanId, messages: new Map(), permissions: new Map() },
    'chan-reg-t3': { id: 'chan-reg-t3', messages: new Map(), permissions: new Map() },
    'chan-idp-t3': { id: 'chan-idp-t3', messages: new Map(), permissions: new Map() },
  };

  const makeChannelObj = (chanId) => {
    const store = channelStore[chanId];
    if (!store) return null;
    return {
      id: chanId,
      guild: { id: guildId, roles: { everyone: { id: guildId } } },
      isTextBased: () => true,
      permissionOverwrites: {
        edit: async (targetId, perms) => {
          store.permissions.set(targetId, { ...(store.permissions.get(targetId) || {}), ...perms });
        },
        delete: async (targetId) => {
          store.permissions.delete(targetId);
        },
      },
      send: async (payload) => {
        const msgId = `msg-${chanId}-${store.messages.size + 1}`;
        const msg = {
          id: msgId,
          content: payload?.content || '',
          embeds: payload?.embeds || [],
          components: payload?.components || [],
          editCount: 0,
          edit: async (editPayload) => {
            if (editPayload.content !== undefined) msg.content = editPayload.content;
            if (editPayload.embeds !== undefined) msg.embeds = editPayload.embeds;
            if (editPayload.components !== undefined) msg.components = editPayload.components;
            msg.editCount += 1;
            return msg;
          },
        };
        store.messages.set(msgId, msg);
        return msg;
      },
      messages: {
        fetch: async (msgId) => {
          if (typeof msgId === 'string') {
            const found = store.messages.get(msgId);
            if (!found) {
              const err = new Error('Unknown Message');
              err.code = 10008;
              throw err;
            }
            return found;
          }
          return store.messages;
        },
      },
    };
  };

  const mockGuild = {
    id: guildId,
    roles: { everyone: { id: guildId } },
    channels: {
      cache: { get: (id) => makeChannelObj(id) },
      fetch: async (id) => makeChannelObj(id),
    },
  };

  const mockClient = {
    guilds: {
      cache: new Map([[guildId, mockGuild]]),
      fetch: async (id) => (id === guildId ? mockGuild : null),
    },
    channels: {
      cache: { get: (id) => makeChannelObj(id) },
      fetch: async (id) => makeChannelObj(id),
    },
  };

  const activeEval = evaluateDailyCycleStatus('09:08', '23:59', 'Asia/Kolkata', new Date());
  const cycleDate = activeEval.cycleDate;
  const cycleId = `${regId}:${cycleDate}`;

  // Seed registration before daily start time (Status: CLOSED, totalSlots: 18, reservedSlots: 16 -> Slots: 2, Matches: 1 default)
  await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId,
    displayName: 'T3 10PM',
    totalSlots: 18,
    reservedSlots: 16, // 2 unlocked slots (Slot 17 and Slot 18)
    dailyStartTime: '09:08',
    rawDailyStartTime: '9:08 AM',
    dailyResetTime: '23:59',
    timezone: 'Asia/Kolkata',
    status: 'NOT OPENED YET',
    beforeStart: true,
    registrationChannelId: 'chan-reg-t3',
    registrationMessageId: null,
    idpChannelId: 'chan-idp-t3',
    slotChartMessageId: null,
    currentCycleDate: cycleDate,
    currentCycleId: cycleId,
    lastResetCycleDate: activeEval.endedCycleDate,
  });

  // 1. Verify exact Registration Message format & persistent single-message creation
  // <bold prefix> <registration name> (𝐓𝟑 10PM)
  // Time: 9:08 AM
  // Status: CLOSED
  // Slots: 2 (totalSlots 18 - reservedSlots 16)
  // Matches: 1 (default)
  await updateRegistrationMessage(mockClient, regId);
  assert.equal(channelStore['chan-reg-t3'].messages.size, 1, 'Should create exactly 1 persistent registration message');
  const regDocAfterInit = await getConfigurableRegistration(regId);
  const regMsg = channelStore['chan-reg-t3'].messages.get(regDocAfterInit.registrationMessageId);
  assert.ok(regMsg, 'Persistent registration message stored in MongoDB');

  const expectedInitialDescription =
    `Time: 9:08 AM\n` +
    `Status: CLOSED\n` +
    `Slots: 2\n` +
    `Matches: 1`;
  assert.equal(regMsg.content, '', 'Persistent registration message should use an embed instead of plain text content');
  assert.equal(regMsg.embeds.length, 1, 'Registration message should have 1 embed');
  assert.equal(regMsg.embeds[0].data.title, '𝐓𝟑 10PM', 'Embed title must be <bold prefix> <registration name>');
  assert.equal(regMsg.embeds[0].data.description, expectedInitialDescription, 'Embed description must match exact 4-line design');
  assert.equal(regMsg.components.length, 1, 'Registration message must include Register Squad button row');
  assert.equal(regMsg.components[0].components[0].data.label, 'Register Squad');
  assert.equal(regMsg.components[0].components[0].data.disabled, true, 'Register Squad button must be disabled when not open');

  // Verify initial slot chart in IDP channel is inside triple-backtick code block and deduplicates short code ("T3 Scrims 10PM Slotlist")
  await syncRegistrationSlotList(regId, cycleId, mockClient);
  assert.equal(channelStore['chan-idp-t3'].messages.size, 1, 'Should create 1 slot chart message');
  const regWithSlotMsg = await getConfigurableRegistration(regId);
  const idpMsg = channelStore['chan-idp-t3'].messages.get(regWithSlotMsg.slotChartMessageId);
  assert.ok(idpMsg.content.startsWith('```\nT3 Scrims 10PM Slotlist\n'), 'Slot chart is wrapped in code block and does not repeat T3 prefix');
  assert.ok(idpMsg.content.endsWith('⚪ 0/2 filled\n```'), 'Slot chart ends with ⚪ 0/2 filled inside code block');
  assert.equal(idpMsg.embeds.length, 0, 'Slot chart has no embed');

  // Enroll teams:
  await saveConfigurableTeam({
    teamId: 'team-verif-1',
    tournamentId: tourId,
    teamName: 'Verified Squad Alpha',
    leaderDiscordId: 'leader-verified-1',
    verified: true,
    players: [
      { discordId: 'leader-verified-1', ign: 'AlphaLead', uid: '111' },
      { discordId: 'member-nonleader-1', ign: 'AlphaMember', uid: '112' },
    ],
  });

  await saveConfigurableTeam({
    teamId: 'team-verif-2',
    tournamentId: tourId,
    teamName: 'Verified Squad Bravo',
    leaderDiscordId: 'leader-verified-2',
    verified: true,
    players: [{ discordId: 'leader-verified-2', ign: 'BravoLead', uid: '221' }],
  });

  await saveConfigurableTeam({
    teamId: 'team-verif-3',
    tournamentId: tourId,
    teamName: 'Verified Squad Charlie',
    leaderDiscordId: 'leader-verified-3',
    verified: true,
    players: [{ discordId: 'leader-verified-3', ign: 'CharlieLead', uid: '331' }],
  });

  await saveConfigurableTeam({
    teamId: 'team-other-tour',
    tournamentId: otherTourId,
    teamName: 'Other Tour Squad',
    leaderDiscordId: 'leader-other-tour',
    verified: true,
    players: [{ discordId: 'leader-other-tour', ign: 'OtherLead', uid: '991' }],
  });

  const makeButtonClickInteraction = (userId, nowOverride = null) => {
    const obj = {
      id: `int-btn-${userId}-${Date.now()}`,
      channelId: 'chan-reg-t3',
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: userId },
      now: nowOverride,
      lastReply: null,
      reply: async (payload) => {
        obj.lastReply = payload;
        return payload;
      },
    };
    return obj;
  };

  // =========================================================================
  // 1. "NOT OPENED YET" MESSAGE (no reset time shown in registration channel)
  // =========================================================================
  const [y, m, d] = cycleDate.split('-').map(Number);
  const beforeStartUtc = new Date(Date.UTC(y, m - 1, d, 3, 0, 0)); // 08:30 AM IST (before 09:08 AM)
  const notOpenedInt = makeButtonClickInteraction('leader-verified-1', beforeStartUtc);
  await handleRegisterSquadButtonClick(notOpenedInt, regId);
  assert.equal(notOpenedInt.lastReply.ephemeral, true);
  assert.equal(
    notOpenedInt.lastReply.content,
    `Registration is currently NOT OPENED YET.\nDaily Schedule: Opens at 9:08 AM`,
    'Must show exact NOT OPENED YET message with 12-hour start time and NO reset time'
  );
  assert.doesNotMatch(notOpenedInt.lastReply.content, /Resets at/i, 'Must never show reset time to users in registration channel');

  // Verify organiser dashboard STILL shows reset time
  const dashPayload = buildManageDashboardPayload(await getConfigurableRegistration(regId), 0);
  assert.match(dashPayload.content, /Daily Reset Time:\*\* `23:59`/, 'Organiser dashboard keeps showing reset time');

  // =========================================================================
  // Open registration via scheduler and test Unverified / Non-leader checks
  // =========================================================================
  const afterStartUtc = new Date(Date.UTC(y, m - 1, d, 6, 30, 0));
  await checkRegistrationLifecycles(mockClient, afterStartUtc);

  assert.equal(channelStore['chan-reg-t3'].messages.size, 1, 'Must edit existing persistent registration message');
  assert.equal(regMsg.content, '');
  assert.equal(regMsg.embeds[0].data.title, '𝐓𝟑 10PM');
  assert.equal(
    regMsg.embeds[0].data.description,
    `Time: 9:08 AM\nStatus: OPEN\nSlots: 2\nMatches: 1`,
    'Registration message embed updates Status to OPEN'
  );
  assert.equal(regMsg.components[0].components[0].data.disabled, false, 'Register Squad button enabled when OPEN');

  const unverifiedInt = makeButtonClickInteraction('unverified-user-999', afterStartUtc);
  await handleRegisterSquadButtonClick(unverifiedInt, regId);
  assert.equal(
    unverifiedInt.lastReply.content,
    `First verify your squad here <#${verifyChanId}> channel`
  );

  const nonLeaderInt = makeButtonClickInteraction('member-nonleader-1', afterStartUtc);
  await handleRegisterSquadButtonClick(nonLeaderInt, regId);
  assert.match(nonLeaderInt.lastReply.content, /Only the verified \*\*Team Leader\*\*/);

  // =========================================================================
  // 5. CONFIRMATION BEFORE REGISTERING (Single Team & Multi-Team Select Menu)
  // =========================================================================
  const leader1ClickInt = makeButtonClickInteraction('leader-verified-1', afterStartUtc);
  await handleRegisterSquadButtonClick(leader1ClickInt, regId);
  assert.equal(
    leader1ClickInt.lastReply.content,
    `Register **Verified Squad Alpha** in **T3 10PM**?\nTotal slots: 2`,
    'Shows private confirmation prompt text with bold team/registration name and Total slots'
  );
  assert.equal(leader1ClickInt.lastReply.embeds[0].data.title, 'Confirm Squad Registration');
  assert.equal(
    leader1ClickInt.lastReply.embeds[0].data.description,
    [
      'Register **Verified Squad Alpha** in **T3 10PM**?',
      '• Tournament: T3 Scrims',
      '• Registration: T3 10PM',
      '• Team: Verified Squad Alpha',
      '• Available Slots: 2',
      '• Status: OPEN',
    ].join('\n'),
    'Shows Confirm Squad Registration embed with exact bullet points'
  );
  const confirmBtn1 = leader1ClickInt.lastReply.components[0].components[0];
  const cancelBtn1 = leader1ClickInt.lastReply.components[0].components[1];
  assert.equal(confirmBtn1.data.label, 'Confirm');
  assert.equal(cancelBtn1.data.label, 'Cancel');
  assert.equal(
    confirmBtn1.data.custom_id,
    `md_cfg_reg_confirm_${regId}:${cycleDate}:team-verif-1`,
    'Custom ID carries registration ID, cycle ID, and team ID'
  );

  // Multi-team leader test: give leader-verified-1 a second eligible team and verify select menu is shown
  await saveConfigurableTeam({
    teamId: 'team-verif-1b',
    tournamentId: tourId,
    teamName: 'Verified Squad Alpha II',
    leaderDiscordId: 'leader-verified-1',
    verified: true,
    players: [{ discordId: 'leader-verified-1', ign: 'AlphaLead', uid: '111' }],
  });
  const multiTeamInt = makeButtonClickInteraction('leader-verified-1', afterStartUtc);
  await handleRegisterSquadButtonClick(multiTeamInt, regId);
  assert.equal(
    multiTeamInt.lastReply.components[0].components[0].data.custom_id,
    `md_cfg_reg_select_team_${regId}:${cycleDate}`,
    'Shows select menu when leader has multiple eligible teams'
  );
  // Select team-verif-1 via global interaction handler
  let selectMenuUpdated = null;
  const selectMenuInt = {
    customId: `md_cfg_reg_select_team_${regId}:${cycleDate}`,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    isUserSelectMenu: () => false,
    values: ['team-verif-1'],
    user: { id: 'leader-verified-1' },
    guild: mockGuild,
    guildId,
    client: mockClient,
    now: afterStartUtc,
    reply: async (p) => { selectMenuUpdated = p; return p; },
  };
  await handleConfigurableTournamentInteraction(selectMenuInt);
  assert.equal(selectMenuUpdated.content, `Register **Verified Squad Alpha** in **T3 10PM**?\nTotal slots: 2`);
  await deleteConfigurableTeam('team-verif-1b');

  // Complete registration for team-verif-1 via global interaction router & verify buttons are disabled immediately on click
  const disabledSnapshots = [];
  let confirm1SuccessReply = null;
  const confirm1SuccessInt = {
    id: 'int-confirm-ok-1',
    customId: confirmBtn1.data.custom_id,
    isButton: () => true,
    user: { id: 'leader-verified-1' },
    guild: mockGuild,
    guildId,
    client: mockClient,
    now: afterStartUtc,
    message: {
      components: leader1ClickInt.lastReply.components,
      edit: async (p) => {
        disabledSnapshots.push(p);
        return p;
      },
    },
    deferUpdate: async () => {
      confirm1SuccessInt.deferred = true;
    },
    editReply: async (p) => { confirm1SuccessReply = p; return p; },
  };
  await handleConfigurableTournamentInteraction(confirm1SuccessInt);
  assert.equal(disabledSnapshots.length, 1, 'Buttons were disabled immediately on the message');
  assert.equal(
    disabledSnapshots[0].components[0].components.every((b) => b.data.disabled === true),
    true,
    'Both Confirm and Cancel buttons disabled immediately upon click'
  );
  assert.equal(
    confirm1SuccessReply.content,
    `Registered! Slot #17, your IDP channel is <#chan-idp-t3>.`,
    'Confirm replies privately with exact Registered! Slot #<N>, your IDP channel is <#channel>.'
  );

  // Verify slot chart updated to partly filled (🟡 1/2 filled) inside code block
  assert.match(idpMsg.content, /Slot 17 → Verified Squad Alpha/);
  assert.match(idpMsg.content, /🟡 1\/2 filled\n```$/);

  // =========================================================================
  // 2. "ALREADY REGISTERED" MESSAGE
  // =========================================================================
  const dupClickInt = makeButtonClickInteraction('leader-verified-1', afterStartUtc);
  await handleRegisterSquadButtonClick(dupClickInt, regId);
  assert.equal(
    dupClickInt.lastReply.content,
    `Your team **Verified Squad Alpha** is already registered in this daily cycle! Assigned to **Slot #17** and get IDP in <#chan-idp-t3>.`,
    'Shows exact ALREADY REGISTERED message with team name, slot number, and IDP channel mention'
  );

  // Register team-verif-2 to fill the 2nd (and final) unlocked slot (#18)
  let confirm2SuccessReply = null;
  const confirm2SuccessInt = {
    id: 'int-confirm-ok-2',
    isButton: () => true,
    user: { id: 'leader-verified-2' },
    guild: mockGuild,
    client: mockClient,
    now: afterStartUtc,
    deferUpdate: async () => { confirm2SuccessInt.deferred = true; },
    editReply: async (p) => { confirm2SuccessReply = p; return p; },
  };
  await handleConfirmRegistrationButtonClick(confirm2SuccessInt, regId, 'team-verif-2', cycleId);
  assert.equal(
    confirm2SuccessReply.content,
    `Registered! Slot #18, your IDP channel is <#chan-idp-t3>.`
  );
  assert.match(idpMsg.content, /🟢 2\/2 filled\n```$/, 'All filled shows 🟢 2/2 filled');

  // =========================================================================
  // Registration becomes FULL -> persistent message updates to Status: FULL & button disabled
  // =========================================================================
  assert.equal(channelStore['chan-reg-t3'].messages.size, 1, 'Still 1 persistent registration message');
  assert.equal(regMsg.embeds[0].data.title, '𝐓𝟑 10PM');
  assert.equal(
    regMsg.embeds[0].data.description,
    `Time: 9:08 AM\nStatus: FULL\nSlots: 2\nMatches: 1`,
    'Registration message embed automatically updates to Status: FULL'
  );
  assert.equal(regMsg.components[0].components[0].data.disabled, true, 'Button disabled when FULL');

  const leader3FullInt = makeButtonClickInteraction('leader-verified-3', afterStartUtc);
  await handleRegisterSquadButtonClick(leader3FullInt, regId);
  assert.match(leader3FullInt.lastReply.content, /Registration is currently \*\*FULL\*\*/);

  // =========================================================================
  // Real-time update when settings change (including Matches & Slots)
  // =========================================================================
  let shownEditModal = null;
  await handleEditRegistrationButton(
    {
      showModal: async (m) => { shownEditModal = m; },
    },
    regId
  );
  assert.ok(shownEditModal, 'Edit Registration modal opens');
  const modalCustomIds = shownEditModal.components.map((r) => r.components[0].data.custom_id);
  assert.ok(modalCustomIds.includes('matches'), 'Edit Registration modal includes matches configuration input');

  let editModalReply = null;
  const editModalSubmitInt = {
    guildId,
    guild: mockGuild,
    client: mockClient,
    deferReply: async () => {},
    editReply: async (p) => { editModalReply = p; return p; },
    fields: {
      getTextInputValue: (id) => {
        const map = {
          registration_name: 'T3 10PM',
          total_slots: '20',
          reserved_slots: '4',
          matches: '3',
          daily_start_time: '9:13 AM | 02:00 AM',
        };
        return map[id] || '';
      },
    },
  };
  await handleEditRegistrationModalSubmit(editModalSubmitInt, regId);
  assert.match(editModalReply.content, /Registration Settings Updated/);

  // Manually open registration after expanding slots from 18 -> 20 (reserved 4 -> 16 available slots)
  const toggleOpenInt = {
    isButton: () => true,
    channelId: 'chan-reg-t3',
    message: { id: 'msg-manage' },
    guild: mockGuild,
    client: mockClient,
    update: async () => {},
    followUp: async () => {},
  };
  await handleToggleStatus(toggleOpenInt, regId);

  assert.equal(regMsg.embeds[0].data.title, '𝐓𝟑 10PM');
  assert.equal(
    regMsg.embeds[0].data.description,
    `Time: 9:13 AM\nStatus: OPEN\nSlots: 16\nMatches: 3`,
    'Registration message embed updates in-place with updated Time (9:13 AM), Slots (20 - 4 = 16), Matches (3), and Status (OPEN)'
  );

  // Manually close registration -> Status: CLOSED
  await handleToggleStatus(toggleOpenInt, regId);
  assert.equal(regMsg.embeds[0].data.title, '𝐓𝟑 10PM');
  assert.equal(
    regMsg.embeds[0].data.description,
    `Time: 9:13 AM\nStatus: CLOSED\nSlots: 16\nMatches: 3`,
    'Registration message embed updates in-place to Status: CLOSED when manually closed'
  );
  assert.equal(regMsg.components[0].components[0].data.disabled, true, 'Button disabled when CLOSED');

  // =========================================================================
  // Bot restarts and persistent registration messages remain correct
  // =========================================================================
  const editCountBeforeRestart = regMsg.editCount;
  await reconcileConfigurableTournaments(mockClient);
  assert.equal(channelStore['chan-reg-t3'].messages.size, 1, 'No duplicate registration messages created on bot restart');
  assert.ok(regMsg.editCount > editCountBeforeRestart, 'Existing persistent registration message reconciled on restart');
  assert.equal(regMsg.embeds[0].data.title, '𝐓𝟑 10PM');
  assert.equal(
    regMsg.embeds[0].data.description,
    `Time: 9:13 AM\nStatus: CLOSED\nSlots: 16\nMatches: 3`,
    'Persistent registration message embed retains exact configuration and status across bot restart'
  );
});

test('Exact Timing & Schedule Evaluation - Next due time persisted in MongoDB, exact timer fires within 1s with critical step first, and click compares time with schedule', async () => {
  const guildId = 'guild-exact-timing';
  const tourId = 'tour-exact-1';
  const regId = 'reg-exact-1';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId,
    categoryId: 'cat-exact',
    categoryName: 'T3 Scrims',
    setupChannelId: 'chan-setup-exact',
    dashboardMessageId: 'msg-dash-exact',
    createdChannels: [{ id: 'chan-verify-exact', name: 'T3 Verification' }],
  });

  await saveConfigurableTeam({
    teamId: 'team-exact-1',
    tournamentId: tourId,
    teamName: 'Exact Second Squad',
    leaderDiscordId: 'leader-exact-1',
    verified: true,
    players: [{ discordId: 'leader-exact-1', ign: 'ExactLead', uid: '101' }],
  });

  const actionLog = [];
  const regChannelMessages = new Map();
  const idpChannelMessages = new Map();

  const makeMockChan = (id, msgMap, label) => ({
    id,
    guild: { id: guildId },
    isTextBased: () => true,
    permissionOverwrites: {
      cache: new Map(),
      edit: async () => {},
      delete: async () => { actionLog.push('idp_overwrite_delete'); },
    },
    send: async (payload) => {
      actionLog.push(`${label}_send`);
      const mId = `msg-${label}-${msgMap.size + 1}`;
      const msg = {
        id: mId,
        content: payload.content ?? '',
        embeds: payload.embeds || [],
        components: payload.components || [],
        edit: async (next) => {
          actionLog.push(`${label}_edit:${next.embeds?.[0]?.data?.description?.match(/Status: (\w+)/)?.[1] || 'slot'}`);
          if (next.content !== undefined) msg.content = next.content;
          if (next.embeds !== undefined) msg.embeds = next.embeds;
          if (next.components !== undefined) msg.components = next.components;
          return msg;
        },
      };
      msgMap.set(mId, msg);
      return msg;
    },
    messages: {
      fetch: async (mId) => {
        if (typeof mId === 'string') {
          const found = msgMap.get(mId);
          if (!found) {
            const err = new Error('Unknown Message');
            err.code = 10008;
            throw err;
          }
          return found;
        }
        return msgMap;
      },
    },
  });

  const regChan = makeMockChan('chan-reg-exact', regChannelMessages, 'reg');
  const idpChan = makeMockChan('chan-idp-exact', idpChannelMessages, 'idp');
  const mockGuild = {
    id: guildId,
    roles: { everyone: { id: guildId } },
    channels: {
      cache: { get: (id) => (id === 'chan-reg-exact' ? regChan : id === 'chan-idp-exact' ? idpChan : null) },
      fetch: async (id) => (id === 'chan-reg-exact' ? regChan : id === 'chan-idp-exact' ? idpChan : null),
    },
  };
  const mockClient = {
    guilds: { cache: new Map([[guildId, mockGuild]]), fetch: async () => mockGuild },
    channels: {
      cache: { get: (id) => (id === 'chan-reg-exact' ? regChan : id === 'chan-idp-exact' ? idpChan : null) },
      fetch: async (id) => (id === 'chan-reg-exact' ? regChan : id === 'chan-idp-exact' ? idpChan : null),
    },
  };

  // 1. Verify nextStartAt, nextResetAt, nextDueAt, nextDueAction are computed and stored in MongoDB
  const activeEval = evaluateDailyCycleStatus('10:00', '23:59', 'Asia/Kolkata', new Date());
  const cycleDate = activeEval.cycleDate;
  const [y, m, d] = cycleDate.split('-').map(Number);

  const savedReg = await saveConfigurableRegistration({
    registrationId: regId,
    tournamentId: tourId,
    guildId,
    displayName: 'T3 11PM',
    totalSlots: 18,
    reservedSlots: 2,
    matches: 2,
    dailyStartTime: '10:00',
    rawDailyStartTime: '10:00 AM',
    dailyResetTime: '23:59',
    timezone: 'Asia/Kolkata',
    status: 'NOT OPENED YET',
    beforeStart: true,
    registrationChannelId: 'chan-reg-exact',
    idpChannelId: 'chan-idp-exact',
    currentCycleDate: cycleDate,
    currentCycleId: `${regId}:${cycleDate}`,
    lastResetCycleDate: activeEval.endedCycleDate,
  });

  assert.ok(savedReg.nextStartAt instanceof Date, 'nextStartAt stored as Date in MongoDB');
  assert.ok(savedReg.nextResetAt instanceof Date, 'nextResetAt stored as Date in MongoDB');
  assert.ok(savedReg.nextDueAt instanceof Date, 'nextDueAt stored as Date in MongoDB');
  assert.ok(savedReg.nextDueAction === 'START' || savedReg.nextDueAction === 'RESET', 'nextDueAction stored in MongoDB');

  await updateRegistrationMessage(mockClient, regId);
  await syncRegistrationSlotList(regId, `${regId}:${cycleDate}`, mockClient);
  actionLog.length = 0;

  // 2. Test clicking Register at the exact scheduled opening second BEFORE the scheduler flag flips
  // At 10:00:00 AM IST (04:30:00 UTC), status in DB is still 'NOT OPENED YET' & beforeStart=true,
  // but user click compares current time with schedule and immediately allows registration!
  const exactOpenUtc = getExactTimeInTimezone(y, m, d, 10, 0, 'Asia/Kolkata');
  let clickReply = null;
  const clickAtOpenInt = {
    id: 'int-click-at-open',
    channelId: 'chan-reg-exact',
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: 'leader-exact-1' },
    now: exactOpenUtc,
    reply: async (p) => { clickReply = p; return p; },
  };
  await handleRegisterSquadButtonClick(clickAtOpenInt, regId);
  assert.ok(clickReply, 'Click at exact start time succeeds without waiting for scheduler poll');
  assert.equal(
    clickReply.content,
    `Register **Exact Second Squad** in **T3 11PM**?\nTotal slots: 16`,
    'Click at exact start time immediately opens confirmation prompt'
  );
  const regAfterClickOpen = await getConfigurableRegistration(regId);
  assert.equal(regAfterClickOpen.status, 'OPEN', 'Click at exact start time persists OPEN status');

  // 3. Verify manual Close override still takes precedence over schedule even during scheduled open window
  await saveConfigurableRegistration({
    ...regAfterClickOpen,
    status: 'CLOSED',
    beforeStart: false,
    manualStatusOverride: 'CLOSED',
    manualOverrideCycleDate: cycleDate,
  });
  let closedReply = null;
  await handleRegisterSquadButtonClick(
    {
      ...clickAtOpenInt,
      id: 'int-click-manual-closed',
      reply: async (p) => { closedReply = p; return p; },
    },
    regId
  );
  assert.match(closedReply.content, /Registration is currently NOT OPENED YET/, 'Manual Close keeps precedence over schedule');

  // 4. Verify critical-step-first execution order on scheduled open:
  // Registration message status is edited to OPEN BEFORE slot chart sync runs
  await saveConfigurableRegistration({
    ...regAfterClickOpen,
    status: 'NOT OPENED YET',
    beforeStart: true,
    manualStatusOverride: null,
    manualOverrideCycleDate: null,
  });
  actionLog.length = 0;
  await checkRegistrationLifecycles(mockClient, exactOpenUtc);
  const regEditIdx = actionLog.findIndex((entry) => entry === 'reg_edit:OPEN');
  const idpEditIdx = actionLog.findIndex((entry) => entry.startsWith('idp_'));
  assert.ok(regEditIdx !== -1, 'Registration message updated to OPEN');
  assert.ok(idpEditIdx !== -1, 'Slot chart updated after registration message');
  assert.ok(regEditIdx < idpEditIdx, 'Critical step (registration message update to OPEN) happens BEFORE slower slot chart work');
  clearAllRegistrationTimers();
});



test('Tournament Discord Channel Order - Enforces SETUP -> INFO -> UPDATES -> VERIFY -> ALL REGS -> ALL IDPS across creation, 5 registrations, rename, deletion, restart, and rate limits', async () => {
  const guildId = 'guild-order-suite';
  const otherCategoryId = 'cat-unrelated-999';
  const channelCache = new Map();
  const setPositionsCalls = [];

  // Seed unrelated category and channels to verify they are never touched
  const unrelatedChan1 = {
    id: 'chan-other-1',
    name: 'general-chat',
    type: ChannelType.GuildText,
    parentId: otherCategoryId,
    position: 0,
    permissionOverwrites: [{ id: guildId, allow: [PermissionFlagsBits.ViewChannel] }],
  };
  const unrelatedChan2 = {
    id: 'chan-other-2',
    name: 'staff-chat',
    type: ChannelType.GuildText,
    parentId: otherCategoryId,
    position: 1,
    permissionOverwrites: [{ id: guildId, deny: [PermissionFlagsBits.ViewChannel] }],
  };
  channelCache.set(unrelatedChan1.id, unrelatedChan1);
  channelCache.set(unrelatedChan2.id, unrelatedChan2);

  let nextChanSeq = 1;
  const makeTextChan = (spec) => {
    const id = `chan-ord-${nextChanSeq++}`;
    const messages = new Map();
    const chan = {
      id,
      name: spec.name,
      type: spec.type,
      parent: spec.parent || null,
      parentId: spec.parent || null,
      position: typeof spec.position === 'number' ? spec.position : channelCache.size,
      permissionOverwrites: {
        raw: spec.permissionOverwrites || [],
        cache: new Map(),
        edit: async () => {},
        delete: async () => {},
      },
      isTextBased: () => spec.type !== ChannelType.GuildCategory,
      setName: async (newName) => {
        chan.name = newName;
        return chan;
      },
      setPosition: async (newPos) => {
        chan.position = newPos;
        return chan;
      },
      delete: async () => {
        chan.deleted = true;
        channelCache.delete(id);
      },
      send: async (payload) => {
        const msgId = `msg-${id}-${messages.size + 1}`;
        const msg = {
          id: msgId,
          content: payload.content ?? '',
          embeds: payload.embeds || [],
          components: payload.components || [],
          edit: async (next) => {
            if (next.content !== undefined) msg.content = next.content;
            if (next.embeds !== undefined) msg.embeds = next.embeds;
            if (next.components !== undefined) msg.components = next.components;
            return msg;
          },
        };
        messages.set(msgId, msg);
        return msg;
      },
      messages: {
        fetch: async (mId) => (typeof mId === 'string' ? messages.get(mId) || null : messages),
      },
    };
    channelCache.set(id, chan);
    return chan;
  };

  let simulateRateLimitOnce = false;
  const mockGuild = {
    id: guildId,
    roles: { everyone: { id: guildId } },
    members: { me: { id: 'bot-order-1' } },
    channels: {
      cache: channelCache,
      create: async (spec) => makeTextChan(spec),
      fetch: async (id) => channelCache.get(id) || null,
      setPositions: async (positions) => {
        if (simulateRateLimitOnce) {
          simulateRateLimitOnce = false;
          const err = new Error('You are being rate limited.');
          err.status = 429;
          err.retryAfter = 0.01;
          throw err;
        }
        setPositionsCalls.push(positions);
        for (const entry of positions) {
          const c = channelCache.get(entry.channel);
          if (c) {
            c.position = entry.position;
            if (entry.parent) c.parentId = entry.parent;
          }
        }
      },
    },
  };

  const mockClient = {
    user: { id: 'bot-order-1' },
    guilds: {
      cache: new Map([[guildId, mockGuild]]),
      fetch: async (id) => (id === guildId ? mockGuild : null),
    },
    channels: {
      cache: channelCache,
      fetch: async (id) => channelCache.get(id) || null,
    },
  };

  // 1. Create tournament category ("T3 Scrims") and Setup channel
  await handleCreateTournamentModalSubmit({
    guild: mockGuild,
    client: mockClient,
    user: { id: 'admin-ord-1' },
    member: { permissions: { has: () => true } },
    fields: { getTextInputValue: (cid) => (cid === 'category_name' ? 'T3 Scrims' : '') },
    deferReply: async () => {},
    editReply: async () => {},
  });

  const tour = await getConfigurableTournamentByName(guildId, 'T3 Scrims');
  assert.ok(tour, 'Tournament created');
  const categoryId = tour.categoryId;

  // 2. Create Standard Channels (Info, Updates, Verify)
  await handleCreateStandardChannels(
    {
      guild: mockGuild,
      client: mockClient,
      deferReply: async () => {},
      editReply: async () => {},
    },
    tour.tournamentId
  );

  const getCategoryChannelsByPosition = () =>
    Array.from(channelCache.values())
      .filter((c) => c.parentId === categoryId && c.type === ChannelType.GuildText && !c.deleted)
      .sort((a, b) => a.position - b.position);

  const tourWithStd = await getConfigurableTournament(tour.tournamentId);
  const stdOrder = getCategoryChannelsByPosition();
  assert.deepEqual(
    stdOrder.map((c) => c.id),
    [
      tourWithStd.setupChannelId,
      tourWithStd.standardChannels.infoChannelId,
      tourWithStd.standardChannels.updatesChannelId,
      tourWithStd.standardChannels.verifyChannelId,
    ],
    'Standard channels must be ordered: Setup (0) -> Info (1) -> Updates (2) -> Verify (3)'
  );
  assert.deepEqual(
    stdOrder.map((c) => c.name),
    ['𝐓𝟑｜setup', '𝐓𝟑｜info', '𝐓𝟑｜updates', '𝐓𝟑｜verify']
  );

  // 3. Dynamically add 5 registrations (10pm, 11pm, 12am, 1am, 2am)
  const regSpecs = [
    { name: '10pm', start: '10:00 AM', reset: '11:59 PM' },
    { name: '11pm', start: '11:00 AM', reset: '11:59 PM' },
    { name: '12am', start: '12:00 PM', reset: '11:59 PM' },
    { name: '1am', start: '01:00 PM', reset: '11:59 PM' },
    { name: '2am', start: '02:00 PM', reset: '11:59 PM' },
  ];

  for (const spec of regSpecs) {
    await handleAddRegistrationModalSubmit(
      {
        guild: mockGuild,
        client: mockClient,
        deferReply: async () => {},
        editReply: async () => {},
        fields: {
          getTextInputValue: (f) => {
            if (f === 'registration_name') return spec.name;
            if (f === 'total_slots') return '18';
            if (f === 'reserved_slots') return '2';
            if (f === 'daily_start_time') return spec.start;
            if (f === 'daily_reset_time') return spec.reset;
            return '';
          },
        },
      },
      tour.tournamentId
    );
  }

  const fiveRegs = await getConfigurableRegistrationsForTournament(tour.tournamentId);
  assert.equal(fiveRegs.length, 5, '5 registrations created');

  const orderedWith5 = getCategoryChannelsByPosition();
  assert.deepEqual(
    orderedWith5.map((c) => c.id),
    [
      tourWithStd.setupChannelId,
      tourWithStd.standardChannels.infoChannelId,
      tourWithStd.standardChannels.updatesChannelId,
      tourWithStd.standardChannels.verifyChannelId,
      ...fiveRegs.map((r) => r.registrationChannelId),
      ...fiveRegs.map((r) => r.idpChannelId),
    ],
    'With 5 registrations: Setup -> Info -> Updates -> Verify -> Reg 1..5 -> IDP 1..5'
  );
  assert.deepEqual(
    orderedWith5.map((c) => c.name),
    [
      '𝐓𝟑｜setup',
      '𝐓𝟑｜info',
      '𝐓𝟑｜updates',
      '𝐓𝟑｜verify',
      '𝐓𝟑｜10pm-reg',
      '𝐓𝟑｜11pm-reg',
      '𝐓𝟑｜12am-reg',
      '𝐓𝟑｜1am-reg',
      '𝐓𝟑｜2am-reg',
      '𝐓𝟑｜10pm-idp',
      '𝐓𝟑｜11pm-idp',
      '𝐓𝟑｜12am-idp',
      '𝐓𝟑｜1am-idp',
      '𝐓𝟑｜2am-idp',
    ],
    'Channel names in category match exact example layout'
  );
  assert.deepEqual(
    orderedWith5.map((c) => c.position),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    'Positions are contiguous 0..13'
  );

  // 4. Verify no-op call makes 0 unnecessary Discord API calls when already ordered
  const callsBeforeNoop = setPositionsCalls.length;
  const noopResult = await reorderTournamentCategoryChannels(mockGuild, tour.tournamentId);
  assert.equal(noopResult.updated, false, 'Already ordered category does not trigger update');
  assert.equal(noopResult.apiCalls, 0, 'Already ordered category makes 0 API calls');
  assert.equal(setPositionsCalls.length, callsBeforeNoop, 'setPositions not called when already ordered');

  // 5. Rename Registration 2 ("11pm" -> "1130pm") via Edit Settings and verify position is preserved without recreating channel
  const reg2 = fiveRegs[1];
  const reg2ChanIdBefore = reg2.registrationChannelId;
  const idp2ChanIdBefore = reg2.idpChannelId;

  await handleEditRegistrationModalSubmit(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      deferReply: async () => {},
      editReply: async () => {},
      fields: {
        getTextInputValue: (f) => {
          if (f === 'registration_name') return '1130pm';
          if (f === 'total_slots') return '18';
          if (f === 'reserved_slots') return '2';
          if (f === 'matches') return '2';
          if (f === 'daily_start_time') return '11:30 AM | 11:59 PM';
          return '';
        },
      },
    },
    reg2.registrationId
  );

  const orderedAfterRename = getCategoryChannelsByPosition();
  assert.equal(orderedAfterRename[5].id, reg2ChanIdBefore, 'Reg 2 channel ID unchanged (not recreated) and stays at index 5');
  assert.equal(orderedAfterRename[5].name, '𝐓𝟑｜1130pm-reg', 'Reg 2 channel renamed in place');
  assert.equal(orderedAfterRename[10].id, idp2ChanIdBefore, 'IDP 2 channel ID unchanged (not recreated) and stays at index 10');
  assert.equal(orderedAfterRename[10].name, '𝐓𝟑｜1130pm-idp', 'IDP 2 channel renamed in place');

  // 6. Delete Registration 2 and Registration 4, verify remaining channels (1, 3, 5) reorganize cleanly
  await handleDeleteRegistration(
    {
      guild: mockGuild,
      client: mockClient,
      reply: async () => {},
    },
    reg2.registrationId
  );

  // Also test direct Discord channel deletion on Registration 4
  const reg4Chan = channelCache.get(fiveRegs[3].registrationChannelId);
  reg4Chan.client = mockClient;
  reg4Chan.guild = mockGuild;
  await handleConfigurableChannelDelete(reg4Chan);

  const remainingRegs = await getConfigurableRegistrationsForTournament(tour.tournamentId);
  assert.equal(remainingRegs.length, 3, '3 registrations remain (Reg 1, Reg 3, Reg 5)');
  assert.deepEqual(
    remainingRegs.map((r) => r.displayName),
    ['10pm', '12am', '2am']
  );

  const orderedAfterDeletes = getCategoryChannelsByPosition();
  assert.deepEqual(
    orderedAfterDeletes.map((c) => c.name),
    [
      '𝐓𝟑｜setup',
      '𝐓𝟑｜info',
      '𝐓𝟑｜updates',
      '𝐓𝟑｜verify',
      '𝐓𝟑｜10pm-reg',
      '𝐓𝟑｜12am-reg',
      '𝐓𝟑｜2am-reg',
      '𝐓𝟑｜10pm-idp',
      '𝐓𝟑｜12am-idp',
      '𝐓𝟑｜2am-idp',
    ],
    'After deleting Reg 2 and Reg 4, remaining channels reorganize into Setup -> Info -> Updates -> Verify -> Reg 1,3,5 -> IDP 1,3,5'
  );
  assert.deepEqual(
    orderedAfterDeletes.map((c) => c.position),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    'Positions compacted to 0..9'
  );

  // 7. Scramble channel positions & simulate 429 rate-limit on bot restart reconciliation
  for (let i = 0; i < orderedAfterDeletes.length; i++) {
    orderedAfterDeletes[i].position = 99 - i;
  }
  simulateRateLimitOnce = true;

  await reconcileConfigurableTournaments(mockClient);

  const orderedAfterRestart = getCategoryChannelsByPosition();
  assert.deepEqual(
    orderedAfterRestart.map((c) => c.name),
    [
      '𝐓𝟑｜setup',
      '𝐓𝟑｜info',
      '𝐓𝟑｜updates',
      '𝐓𝟑｜verify',
      '𝐓𝟑｜10pm-reg',
      '𝐓𝟑｜12am-reg',
      '𝐓𝟑｜2am-reg',
      '𝐓𝟑｜10pm-idp',
      '𝐓𝟑｜12am-idp',
      '𝐓𝟑｜2am-idp',
    ],
    'Bot restart reconciliation restores exact SETUP -> INFO -> UPDATES -> VERIFY -> ALL REGS -> ALL IDPS order'
  );
  assert.deepEqual(
    orderedAfterRestart.map((c) => c.position),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  );

  // 8. Verify unrelated category channels were never reordered or modified
  assert.equal(unrelatedChan1.parentId, otherCategoryId);
  assert.equal(unrelatedChan1.position, 0);
  assert.equal(unrelatedChan2.parentId, otherCategoryId);
  assert.equal(unrelatedChan2.position, 1);
  for (const call of setPositionsCalls) {
    assert.equal(
      call.some((entry) => entry.channel === unrelatedChan1.id || entry.channel === unrelatedChan2.id),
      false,
      'Channels belonging to other categories must never be included in setPositions'
    );
    assert.equal(
      call.every((entry) => entry.lockPermissions === false),
      true,
      'lockPermissions must always be false to preserve channel permission overwrites'
    );
  }

  clearAllRegistrationTimers();
});

// -----------------------------------------------------------------------------------------
// FEATURE — REGISTRATION-SPECIFIC SCHEDULE IMAGE MANAGEMENT
// -----------------------------------------------------------------------------------------

test('Registration Schedule Management - Separate per-registration schedule upload, replacement, view, remove, permissions & restart persistence', async () => {
  const guildId = 'guild-sched-test';
  const tourId = 'tour-sched-1';
  const organizerId = 'org-user-1';
  const normalUserId = 'participant-user-1';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId,
    name: 'T3 Scrims',
    prefix: 'T3',
    createdBy: organizerId,
    setupChannelId: 'chan-setup-sched',
    verifyChannelId: 'chan-verify-sched',
  });

  const reg1 = await saveConfigurableRegistration({
    registrationId: 'reg-sched-1',
    tournamentId: tourId,
    guildId,
    displayName: 'T3 Registration 1',
    registrationChannelId: 'chan-reg-1',
    idpChannelId: 'chan-idp-1',
    registrationMessageId: 'msg-reg-1',
    status: 'OPEN',
  });

  const reg2 = await saveConfigurableRegistration({
    registrationId: 'reg-sched-2',
    tournamentId: tourId,
    guildId,
    displayName: 'T3 Registration 2',
    registrationChannelId: 'chan-reg-2',
    idpChannelId: 'chan-idp-2',
    registrationMessageId: 'msg-reg-2',
    status: 'OPEN',
  });

  // Set up mock Discord channels and message stores
  const channelMessages = new Map([
    ['chan-reg-1', new Map([
      ['msg-reg-1', { id: 'msg-reg-1', author: { id: 'bot-1' }, content: 'Persistent Reg 1 Msg', deleted: false, edit: async () => {} }],
      ['msg-unrelated-1', { id: 'msg-unrelated-1', author: { id: 'user-99' }, content: 'Unrelated Chat Msg', deleted: false, edit: async () => {} }],
    ])],
    ['chan-idp-1', new Map()],
    ['chan-reg-2', new Map([
      ['msg-reg-2', { id: 'msg-reg-2', author: { id: 'bot-1' }, content: 'Persistent Reg 2 Msg', deleted: false, edit: async () => {} }],
    ])],
    ['chan-idp-2', new Map()],
  ]);

  let msgCounter = 100;
  const makeChannelMock = (channelId) => {
    const store = channelMessages.get(channelId);
    return {
      id: channelId,
      guildId,
      isTextBased: () => true,
      send: async (payload) => {
        const id = `sched-msg-${++msgCounter}`;
        const msgObj = {
          id,
          channelId,
          author: { id: 'bot-1' },
          content: payload.content || '',
          files: payload.files || [],
          attachments: new Map(
            (payload.files || []).map((f, idx) => [
              `att-${id}-${idx}`,
              {
                id: `att-${id}-${idx}`,
                url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${f.name || 'schedule.png'}`,
                name: f.name || 'schedule.png',
                contentType: 'image/png',
              },
            ])
          ),
          deleted: false,
          edit: async (editPayload) => {
            if (editPayload.files) {
              msgObj.files = editPayload.files;
              msgObj.attachments = new Map(
                editPayload.files.map((f, idx) => [
                  `att-${id}-edit-${idx}`,
                  {
                    id: `att-${id}-edit-${idx}`,
                    url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${f.name || 'schedule-updated.png'}`,
                    name: f.name || 'schedule-updated.png',
                    contentType: 'image/png',
                  },
                ])
              );
            }
            return msgObj;
          },
          delete: async () => {
            msgObj.deleted = true;
            store.delete(id);
          },
        };
        store.set(id, msgObj);
        return msgObj;
      },
      messages: {
        fetch: async (target) => {
          if (typeof target === 'string') {
            const found = store.get(target);
            if (!found || found.deleted) {
              const err = new Error('Unknown Message');
              err.code = 10008;
              throw err;
            }
            return found;
          }
          return store;
        },
      },
    };
  };

  const channelsMap = new Map([
    ['chan-reg-1', makeChannelMock('chan-reg-1')],
    ['chan-idp-1', makeChannelMock('chan-idp-1')],
    ['chan-reg-2', makeChannelMock('chan-reg-2')],
    ['chan-idp-2', makeChannelMock('chan-idp-2')],
  ]);

  const mockGuild = {
    id: guildId,
    channels: {
      cache: channelsMap,
      fetch: async (id) => channelsMap.get(id) || null,
    },
  };

  const mockClient = {
    user: { id: 'bot-1' },
    channels: {
      fetch: async (id) => channelsMap.get(id) || null,
    },
  };

  // 1. Permission Check: Reject ordinary participant from opening Schedule Management
  let participantReply = null;
  await handleScheduleButton(
    {
      guildId,
      guild: mockGuild,
      user: { id: normalUserId },
      member: { permissions: { has: () => false } },
      reply: async (p) => { participantReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(participantReply);
  assert.equal(participantReply.ephemeral, true);
  assert.match(participantReply.content, /only authorised tournament organisers/i);

  // 2. Organiser opens Schedule Management for Registration 1
  let schedMenuReply = null;
  await handleScheduleButton(
    {
      guildId,
      guild: mockGuild,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async (p) => { schedMenuReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(schedMenuReply);
  assert.equal(schedMenuReply.ephemeral, true);
  assert.match(schedMenuReply.content, /Schedule Management/);
  assert.match(
    schedMenuReply.content,
    /Upload the match schedule image for this registration\. The bot will publish it in the corresponding registration channel\./
  );
  const schedMenuBtnIds = schedMenuReply.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(schedMenuBtnIds, [
    'md_cfg_sched_upload_reg-sched-1',
    'md_cfg_sched_view_reg-sched-1',
    'md_cfg_sched_remove_reg-sched-1',
  ]);
  const schedMenuBtnLabels = schedMenuReply.components[0].components.map((b) => b.data.label);
  assert.deepEqual(schedMenuBtnLabels, [
    'Upload Schedule',
    'View Current Schedule',
    'Remove Schedule',
  ]);

  // 3. Organiser clicks Upload Schedule for Registration 1
  let uploadPromptReply = null;
  await handleUploadScheduleButton(
    {
      guildId,
      guild: mockGuild,
      channelId: 'chan-setup-sched',
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async (p) => { uploadPromptReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(uploadPromptReply);
  assert.match(uploadPromptReply.content, /upload or attach/i);

  // 4. Reject invalid (non-image) attachment while upload session is active
  let invalidUploadReply = null;
  const handledInvalid = await handleScheduleImageUploadMessage({
    author: { id: organizerId, bot: false },
    guildId,
    guild: mockGuild,
    channelId: 'chan-setup-sched',
    client: mockClient,
    attachments: new Map([
      ['att-bad', { name: 'document.pdf', contentType: 'application/pdf', size: 1024, url: 'https://example.com/document.pdf' }],
    ]),
    reply: async (p) => { invalidUploadReply = typeof p === 'string' ? { content: p } : p; },
  });
  assert.equal(handledInvalid, true);
  assert.ok(invalidUploadReply);
  assert.match(invalidUploadReply.content, /Invalid file type/i);

  // 5. Ordinary user posting an image does NOT trigger or hijack the organiser's schedule upload
  const handledNormalUser = await handleScheduleImageUploadMessage({
    author: { id: normalUserId, bot: false },
    guildId,
    guild: mockGuild,
    channelId: 'chan-setup-sched',
    client: mockClient,
    attachments: new Map([
      ['att-usr', { name: 'hack.png', contentType: 'image/png', size: 2048, url: 'https://example.com/hack.png' }],
    ]),
    reply: async () => {},
  });
  assert.equal(handledNormalUser, false);

  // 6. Organiser uploads valid PNG image for Registration 1
  let reg1UploadSuccessReply = null;
  const handledReg1Upload = await handleScheduleImageUploadMessage({
    author: { id: organizerId, bot: false },
    guildId,
    guild: mockGuild,
    channelId: 'chan-setup-sched',
    client: mockClient,
    attachments: new Map([
      [
        'att-reg1-png',
        {
          name: 't3_reg1_schedule.png',
          contentType: 'image/png',
          size: 4096,
          url: 'https://cdn.discordapp.com/ephemeral/t3_reg1_schedule.png',
        },
      ],
    ]),
    reply: async (p) => { reg1UploadSuccessReply = typeof p === 'string' ? { content: p } : p; },
    delete: async () => {},
  });
  assert.equal(handledReg1Upload, true);
  assert.ok(reg1UploadSuccessReply);
  assert.match(reg1UploadSuccessReply.content, /published in <#chan-reg-1>/);

  const updatedReg1 = await getConfigurableRegistration('reg-sched-1');
  assert.ok(updatedReg1.scheduleMessageId, 'scheduleMessageId saved in DB for Reg 1');
  assert.equal(updatedReg1.scheduleChannelId, 'chan-reg-1', 'scheduleChannelId matches Reg 1 channel');
  assert.equal(updatedReg1.uploadedBy, organizerId, 'uploadedBy saved');
  assert.ok(updatedReg1.uploadedAt, 'uploadedAt timestamp saved');
  assert.ok(updatedReg1.updatedAt, 'updatedAt timestamp saved');
  assert.match(updatedReg1.scheduleImageUrl, /t3_reg1_schedule\.png/);

  const reg1FirstScheduleMsgId = updatedReg1.scheduleMessageId;
  // Verify published in Registration 1 channel, NOT in IDP 1 and NOT in Registration 2
  assert.equal(channelMessages.get('chan-reg-1').has(reg1FirstScheduleMsgId), true);
  assert.equal(channelMessages.get('chan-idp-1').size, 0, 'IDP 1 channel must receive 0 schedule messages');
  assert.equal(channelMessages.get('chan-reg-2').size, 1, 'Reg 2 channel still only has its persistent registration message');

  // 7. Upload a DIFFERENT schedule to Registration 2 -> verify published only in Reg 2 channel
  await handleUploadScheduleButton(
    {
      guildId,
      guild: mockGuild,
      channelId: 'chan-setup-sched',
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async () => {},
    },
    reg2.registrationId
  );

  let reg2UploadSuccessReply = null;
  await handleScheduleImageUploadMessage({
    author: { id: organizerId, bot: false },
    guildId,
    guild: mockGuild,
    channelId: 'chan-setup-sched',
    client: mockClient,
    attachments: new Map([
      [
        'att-reg2-jpg',
        {
          name: 't3_reg2_schedule.jpg',
          contentType: 'image/jpeg',
          size: 5120,
          url: 'https://cdn.discordapp.com/ephemeral/t3_reg2_schedule.jpg',
        },
      ],
    ]),
    reply: async (p) => { reg2UploadSuccessReply = typeof p === 'string' ? { content: p } : p; },
    delete: async () => {},
  });
  assert.ok(reg2UploadSuccessReply);
  assert.match(reg2UploadSuccessReply.content, /published in <#chan-reg-2>/);

  const updatedReg2 = await getConfigurableRegistration('reg-sched-2');
  assert.ok(updatedReg2.scheduleMessageId);
  assert.notEqual(updatedReg2.scheduleMessageId, updatedReg1.scheduleMessageId);
  assert.equal(updatedReg2.scheduleChannelId, 'chan-reg-2');
  assert.match(updatedReg2.scheduleImageUrl, /t3_reg2_schedule\.jpg/);
  assert.equal(channelMessages.get('chan-reg-2').has(updatedReg2.scheduleMessageId), true);
  assert.equal(channelMessages.get('chan-idp-2').size, 0, 'IDP 2 channel untouched');

  // 8. Replace Registration 1's schedule -> must update without duplicate schedule announcements or deleting unrelated messages
  const reg1MsgCountBeforeReplace = channelMessages.get('chan-reg-1').size;
  await handleUploadScheduleButton(
    {
      guildId,
      guild: mockGuild,
      channelId: 'chan-setup-sched',
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async () => {},
    },
    reg1.registrationId
  );

  let reg1ReplaceReply = null;
  await handleScheduleImageUploadMessage({
    author: { id: organizerId, bot: false },
    guildId,
    guild: mockGuild,
    channelId: 'chan-setup-sched',
    client: mockClient,
    attachments: new Map([
      [
        'att-reg1-replace',
        {
          name: 't3_reg1_schedule_v2.jpeg',
          contentType: 'image/jpeg',
          size: 6144,
          url: 'https://cdn.discordapp.com/ephemeral/t3_reg1_schedule_v2.jpeg',
        },
      ],
    ]),
    reply: async (p) => { reg1ReplaceReply = typeof p === 'string' ? { content: p } : p; },
    delete: async () => {},
  });
  assert.ok(reg1ReplaceReply);
  assert.match(reg1ReplaceReply.content, /updated/);

  const replacedReg1 = await getConfigurableRegistration('reg-sched-1');
  assert.equal(replacedReg1.scheduleMessageId, reg1FirstScheduleMsgId, 'Edited existing schedule message in place');
  assert.match(replacedReg1.scheduleImageUrl, /t3_reg1_schedule_v2\.jpeg/);
  assert.equal(channelMessages.get('chan-reg-1').size, reg1MsgCountBeforeReplace, 'No duplicate schedule messages created');
  assert.equal(channelMessages.get('chan-reg-1').has('msg-reg-1'), true, 'Persistent registration message preserved');
  assert.equal(channelMessages.get('chan-reg-1').has('msg-unrelated-1'), true, 'Unrelated message preserved');

  // 9. View Current Schedule for Registration 1
  let viewScheduleReply = null;
  await handleViewScheduleButton(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async (p) => { viewScheduleReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(viewScheduleReply);
  assert.equal(viewScheduleReply.ephemeral, true);
  assert.match(viewScheduleReply.content, /Current Schedule — T3 Registration 1/);
  assert.match(viewScheduleReply.content, /t3_reg1_schedule_v2\.jpeg/);
  assert.equal(viewScheduleReply.files.length, 1);

  // 10. Bot restart reconciliation preserves and recovers schedule state (including if message was externally deleted)
  channelMessages.get('chan-reg-2').delete(updatedReg2.scheduleMessageId);
  await reconcileConfigurableTournaments(mockClient);
  const reg1AfterRestart = await getConfigurableRegistration('reg-sched-1');
  assert.equal(reg1AfterRestart.scheduleMessageId, reg1FirstScheduleMsgId);
  assert.match(reg1AfterRestart.scheduleImageUrl, /t3_reg1_schedule_v2\.jpeg/);
  const reg2AfterRestart = await getConfigurableRegistration('reg-sched-2');
  assert.ok(reg2AfterRestart.scheduleMessageId, 'Reconciled and re-published missing schedule message on restart');
  assert.notEqual(reg2AfterRestart.scheduleMessageId, updatedReg2.scheduleMessageId, 'New message ID stored after recovery');
  assert.equal(channelMessages.get('chan-reg-2').has(reg2AfterRestart.scheduleMessageId), true);

  // 11. Remove Schedule with confirmation for Registration 1
  let removePromptReply = null;
  await handleRemoveSchedulePromptButton(
    {
      guildId,
      guild: mockGuild,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async (p) => { removePromptReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(removePromptReply);
  assert.match(removePromptReply.content, /Are you sure you want to remove the schedule image/);
  const removeConfirmBtnIds = removePromptReply.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(removeConfirmBtnIds, [
    'md_cfg_sched_remove_confirm_reg-sched-1',
    'md_cfg_sched_remove_cancel_reg-sched-1',
  ]);

  let confirmRemoveReply = null;
  await handleConfirmRemoveScheduleButton(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async (p) => { confirmRemoveReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(confirmRemoveReply);
  assert.match(confirmRemoveReply.content, /Schedule image for \*\*T3 Registration 1\*\* has been removed/);

  const clearedReg1 = await getConfigurableRegistration('reg-sched-1');
  assert.equal(clearedReg1.scheduleMessageId, null);
  assert.equal(clearedReg1.scheduleImageUrl, null);
  assert.equal(clearedReg1.scheduleChannelId, null);
  assert.equal(channelMessages.get('chan-reg-1').has(reg1FirstScheduleMsgId), false, 'Bot-managed schedule message deleted from Discord');
  assert.equal(channelMessages.get('chan-reg-1').has('msg-reg-1'), true, 'Registration embed message untouched');
  assert.equal(channelMessages.get('chan-reg-1').has('msg-unrelated-1'), true, 'Unrelated messages untouched');

  // Verify Registration 2's schedule is still intact after Registration 1's schedule was removed
  const reg2StillIntact = await getConfigurableRegistration('reg-sched-2');
  assert.ok(reg2StillIntact.scheduleMessageId);
  assert.equal(channelMessages.get('chan-reg-2').has(reg2StillIntact.scheduleMessageId), true);

  clearAllRegistrationTimers();
});

test('FEATURE: Individual Slot Reservation & Lock Management — non-contiguous locking, allocation, occupied protection, persistence & daily reset', async () => {
  clearInMemoryData();
  clearAllRegistrationTimers();

  const guildId = 'guild-slot-lock';
  const tourId = 'tour-slot-lock';
  const organizerId = 'org-slot-lock-1';
  const randomUserId = 'user-unauth-999';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId,
    name: 'T3 Scrims',
    categoryId: 'cat-slot-lock',
    setupChannelId: 'chan-setup-lock',
    standardChannels: {
      infoChannelId: 'chan-info-lock',
      updatesChannelId: 'chan-updates-lock',
      verifyChannelId: 'chan-verify-lock',
    },
    createdBy: organizerId,
    requiredDiscordMembers: 4,
  });

  const channelMessages = new Map();
  const ensureChannelMap = (chanId) => {
    if (!channelMessages.has(chanId)) channelMessages.set(chanId, new Map());
    return channelMessages.get(chanId);
  };

  let msgSeq = 1;
  const buildMockChannel = (chanId) => ({
    id: chanId,
    isTextBased: () => true,
    permissionOverwrites: {
      edit: async () => {},
      delete: async () => {},
    },
    messages: {
      fetch: async (msgId) => {
        const map = ensureChannelMap(chanId);
        if (!map.has(msgId)) throw new Error('Unknown Message');
        return map.get(msgId);
      },
    },
    send: async (payload) => {
      const id = `msg-lock-${chanId}-${msgSeq++}`;
      const record = {
        id,
        channelId: chanId,
        content: payload.content || '',
        embeds: payload.embeds || [],
        components: payload.components || [],
        edit: async (nextPayload) => {
          if (nextPayload.content !== undefined) record.content = nextPayload.content;
          if (nextPayload.embeds !== undefined) record.embeds = nextPayload.embeds;
          if (nextPayload.components !== undefined) record.components = nextPayload.components;
          return record;
        },
        delete: async () => {
          ensureChannelMap(chanId).delete(id);
        },
      };
      ensureChannelMap(chanId).set(id, record);
      return record;
    },
  });

  const mockGuild = {
    id: guildId,
    roles: { everyone: { id: guildId } },
    channels: {
      fetch: async (id) => buildMockChannel(id),
    },
  };

  const mockClient = {
    user: { id: 'bot-slot-lock' },
    guilds: {
      fetch: async (id) => (id === guildId ? mockGuild : null),
    },
    channels: {
      fetch: async (id) => buildMockChannel(id),
    },
  };

  // Seed initial persistent registration and slot chart messages
  const reg1Msg = await buildMockChannel('chan-reg-lock-1').send({ content: 'Initial reg 1' });
  const idp1Msg = await buildMockChannel('chan-idp-lock-1').send({ content: 'Initial slotchart 1' });
  const reg2Msg = await buildMockChannel('chan-reg-lock-2').send({ content: 'Initial reg 2' });
  const idp2Msg = await buildMockChannel('chan-idp-lock-2').send({ content: 'Initial slotchart 2' });

  const reg1 = await saveConfigurableRegistration({
    registrationId: 'reg-lock-1',
    tournamentId: tourId,
    guildId,
    displayName: '12PM',
    totalSlots: 18,
    reservedSlots: 0,
    lockedSlots: [],
    matches: 2,
    status: 'OPEN',
    manualOverride: 'OPEN',
    dailyStartTime: '11:00',
    dailyResetTime: '23:00',
    currentCycleDate: '2026-11-05',
    currentCycleId: 'reg-lock-1:2026-11-05',
    registrationChannelId: 'chan-reg-lock-1',
    registrationMessageId: reg1Msg.id,
    idpChannelId: 'chan-idp-lock-1',
    slotChartMessageId: idp1Msg.id,
  });

  const reg2 = await saveConfigurableRegistration({
    registrationId: 'reg-lock-2',
    tournamentId: tourId,
    guildId,
    displayName: '3PM',
    totalSlots: 18,
    reservedSlots: 0,
    lockedSlots: [],
    matches: 2,
    status: 'OPEN',
    manualOverride: 'OPEN',
    dailyStartTime: '14:00',
    dailyResetTime: '23:00',
    currentCycleDate: '2026-11-05',
    currentCycleId: 'reg-lock-2:2026-11-05',
    registrationChannelId: 'chan-reg-lock-2',
    registrationMessageId: reg2Msg.id,
    idpChannelId: 'chan-idp-lock-2',
    slotChartMessageId: idp2Msg.id,
  });

  // 1. Accessing Slot Management via View Current Slot Chart
  // Verify main registration dashboard does not have a duplicate Manage Reserved Slots button
  const mainDashPayload = buildManageDashboardPayload(reg1, 0);
  const mainDashButtonIds = mainDashPayload.components.flatMap((row) =>
    row.components.map((c) => c.data.custom_id)
  );
  assert.equal(
    mainDashButtonIds.some((id) => id.startsWith('md_cfg_manage_slots_')),
    false,
    'Main registration dashboard must not have a separate Manage Reserved Slots button'
  );
  assert.equal(
    mainDashButtonIds.includes(`md_cfg_view_slotchart_${reg1.registrationId}`),
    true,
    'Main registration dashboard has View Current Slot Chart button'
  );

  // Unauthorised user cannot open View Current Slot Chart or Manage Reserved Slots
  let unauthReply = null;
  await handleViewCurrentSlotChart(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: randomUserId },
      member: { permissions: { has: () => false } },
      reply: async (p) => { unauthReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(unauthReply);
  assert.match(unauthReply.content, /only authorised tournament organisers/i);

  // Authorised organiser clicks View Current Slot Chart
  let slotChartViewReply = null;
  await handleViewCurrentSlotChart(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      reply: async (p) => { slotChartViewReply = p; },
    },
    reg1.registrationId
  );
  assert.ok(slotChartViewReply);
  assert.match(slotChartViewReply.content, /Slot 01 → AVAILABLE/);
  assert.match(slotChartViewReply.content, /⚪ 0\/18 filled/);
  const viewControlsIds = slotChartViewReply.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(viewControlsIds, [
    `md_cfg_manage_slots_${reg1.registrationId}`,
    `md_cfg_refresh_slotchart_${reg1.registrationId}`,
    `md_cfg_back_to_manage_${reg1.registrationId}`,
  ]);
  const viewControlsLabels = slotChartViewReply.components[0].components.map((b) => b.data.label);
  assert.deepEqual(viewControlsLabels, [
    'Manage Reserved Slots',
    'Refresh Slot Chart',
    'Back',
  ]);

  // 2. Click Manage Reserved Slots -> verify Lock Slot and Unlock Slot menus
  let manageSlotsUpdate = null;
  await handleConfigurableTournamentInteraction({
    customId: `md_cfg_manage_slots_${reg1.registrationId}`,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: organizerId },
    member: { permissions: { has: () => true } },
    update: async (p) => { manageSlotsUpdate = p; },
    reply: async (p) => { manageSlotsUpdate = p; },
  });
  assert.ok(manageSlotsUpdate);
  const selectMenuIds = manageSlotsUpdate.components
    .map((r) => r.components[0]?.data?.custom_id)
    .filter(Boolean);
  assert.equal(selectMenuIds.includes(`md_cfg_lock_slots_select_${reg1.registrationId}:0`), true);

  // 3. Test 1 & Test 2: Lock Slots 01 & 02 AND Lock Slots 17 & 18 (non-contiguous ends)
  let lockEndsUpdate = null;
  await handleConfigurableTournamentInteraction({
    customId: `md_cfg_lock_slots_select_${reg1.registrationId}:0`,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    values: ['1', '2', '17', '18'],
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: organizerId },
    member: { permissions: { has: () => true } },
    update: async (p) => { lockEndsUpdate = p; },
    reply: async (p) => { lockEndsUpdate = p; },
  });
  assert.ok(lockEndsUpdate);

  // Verify IDP channel slot chart updated in place without duplicate message
  assert.equal(ensureChannelMap('chan-idp-lock-1').size, 1, 'Existing IDP slot chart edited in place');
  assert.match(idp1Msg.content, /Slot 01 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 02 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 03 → AVAILABLE/);
  assert.match(idp1Msg.content, /Slot 16 → AVAILABLE/);
  assert.match(idp1Msg.content, /Slot 17 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 18 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /⚪ 0\/14 filled/);

  // Enroll 6 verified teams
  const teamNames = ['Team Alpha', 'Team Bravo', 'Team Charlie', 'Team Delta', 'Team Echo', 'Team Foxtrot'];
  for (let i = 0; i < teamNames.length; i++) {
    await saveConfigurableTeam({
      teamId: `team-lock-${i + 1}`,
      tournamentId: tourId,
      guildId,
      teamName: teamNames[i],
      leaderDiscordId: `leader-lock-${i + 1}`,
      leaderInGameName: `Leader${i + 1}`,
      leaderInGameUid: `50000${i + 1}`,
      VerificationStatus: 'VERIFIED',
      players: [
        { discordId: `leader-lock-${i + 1}`, ign: `P1_${i}`, uid: `1001_${i}` },
        { discordId: `p2-lock-${i + 1}`, ign: `P2_${i}`, uid: `1002_${i}` },
        { discordId: `p3-lock-${i + 1}`, ign: `P3_${i}`, uid: `1003_${i}` },
        { discordId: `p4-lock-${i + 1}`, ign: `P4_${i}`, uid: `1004_${i}` },
      ],
    });
  }

  // Register first 4 teams -> should get Slots 03, 04, 05, 06 (skipping 01 & 02)
  const expectedFirstFourSlots = [3, 4, 5, 6];
  for (let i = 0; i < 4; i++) {
    const leaderId = `leader-lock-${i + 1}`;
    const interaction = {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: leaderId },
      reply: async () => {},
    };
    await registerSquadFull(interaction, reg1.registrationId);
    const finalReply = interaction.lastReply;
    assert.ok(finalReply);
    assert.match(finalReply.content, new RegExp(`Slot #${expectedFirstFourSlots[i]}`));
  }

  // 4. Test 3: Lock a middle slot (Slot 07) and verify subsequent registrations skip Slot 07
  let lockMiddleUpdate = null;
  await handleLockSlotsSelect(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      values: ['7'],
      update: async (p) => { lockMiddleUpdate = p; },
      reply: async (p) => { lockMiddleUpdate = p; },
    },
    reg1.registrationId,
    ['7']
  );
  assert.ok(lockMiddleUpdate);
  assert.match(idp1Msg.content, /Slot 07 → 🔒 LOCKED/);
  // 4 occupied out of (18 - 5 locked = 13 usable)
  assert.match(idp1Msg.content, /🟡 4\/13 filled/);

  // Register Team Echo (5th team) and Team Foxtrot (6th team) -> must skip Slot 07 and allocate Slots 08 & 09
  const expectedNextTwoSlots = [8, 9];
  for (let i = 4; i < 6; i++) {
    const leaderId = `leader-lock-${i + 1}`;
    const interaction = {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: leaderId },
      reply: async () => {},
    };
    await registerSquadFull(interaction, reg1.registrationId);
    const finalReply = interaction.lastReply;
    assert.ok(finalReply);
    assert.match(finalReply.content, new RegExp(`Slot #${expectedNextTwoSlots[i - 4]}`));
  }

  // Verify IDP Slot Chart matches exact expected layout and counter (6/13 filled)
  assert.match(idp1Msg.content, /Slot 01 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 02 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 03 → Team Alpha/);
  assert.match(idp1Msg.content, /Slot 04 → Team Bravo/);
  assert.match(idp1Msg.content, /Slot 05 → Team Charlie/);
  assert.match(idp1Msg.content, /Slot 06 → Team Delta/);
  assert.match(idp1Msg.content, /Slot 07 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 08 → Team Echo/);
  assert.match(idp1Msg.content, /Slot 09 → Team Foxtrot/);
  assert.match(idp1Msg.content, /Slot 10 → AVAILABLE/);
  assert.match(idp1Msg.content, /Slot 17 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 18 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /🟡 6\/13 filled/);

  // 5. Test 4: Unlock Slot 07 and verify it immediately becomes AVAILABLE and is allocated to next team
  let unlockMiddleUpdate = null;
  await handleUnlockSlotsSelect(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      values: ['7'],
      update: async (p) => { unlockMiddleUpdate = p; },
      reply: async (p) => { unlockMiddleUpdate = p; },
    },
    reg1.registrationId,
    ['7']
  );
  assert.ok(unlockMiddleUpdate);
  assert.match(idp1Msg.content, /Slot 07 → AVAILABLE/);
  assert.match(idp1Msg.content, /🟡 6\/14 filled/);

  // Enroll and register a 7th team (Team Golf) -> must receive newly unlocked Slot 07 (lowest available unlocked slot)
  await saveConfigurableTeam({
    teamId: 'team-lock-7',
    tournamentId: tourId,
    guildId,
    teamName: 'Team Golf',
    leaderDiscordId: 'leader-lock-7',
    leaderInGameName: 'Leader7',
    leaderInGameUid: '500007',
    VerificationStatus: 'VERIFIED',
    players: [
      { discordId: 'leader-lock-7', ign: 'P1_7', uid: '1001_7' },
      { discordId: 'p2-lock-7', ign: 'P2_7', uid: '1002_7' },
      { discordId: 'p3-lock-7', ign: 'P3_7', uid: '1003_7' },
      { discordId: 'p4-lock-7', ign: 'P4_7', uid: '1004_7' },
    ],
  });
  const golfInteraction = {
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: 'leader-lock-7' },
    reply: async () => {},
  };
  await registerSquadFull(golfInteraction, reg1.registrationId);
  const golfReply = golfInteraction.lastReply;
  assert.match(golfReply.content, /Slot #7/);
  assert.match(idp1Msg.content, /Slot 07 → Team Golf/);
  assert.match(idp1Msg.content, /🟡 7\/14 filled/);

  // 6. Test 5: Occupied Slot Protection — Attempt to lock occupied Slot 03 (assigned to Team Alpha)
  let occupiedLockPrompt = null;
  await handleLockSlotsSelect(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      values: ['3'],
      update: async (p) => { occupiedLockPrompt = p; },
      reply: async (p) => { occupiedLockPrompt = p; },
    },
    reg1.registrationId,
    ['3']
  );
  assert.ok(occupiedLockPrompt);
  assert.match(
    occupiedLockPrompt.content,
    /This slot is currently assigned to Team Alpha\. Remove or reassign the team before locking this slot\./
  );

  // Verify Slot 03 is STILL occupied by Team Alpha (not silently deleted or moved)
  const entriesBeforeConfirm = await getConfigurableEntriesForRegistration(reg1.registrationId, reg1.currentCycleId);
  const alphaBefore = entriesBeforeConfirm.find((e) => e.teamId === 'team-lock-1');
  assert.equal(alphaBefore.slotNumber, 3);

  // Organiser explicitly confirms Reassign Team Alpha to next available slot (Slot 10) and Lock Slot 03
  let reassignConfirmReply = null;
  await handleConfigurableTournamentInteraction({
    customId: `md_cfg_slot_occ_reassign_${reg1.registrationId}_3_team-lock-1`,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: organizerId },
    member: { permissions: { has: () => true } },
    update: async (p) => { reassignConfirmReply = p; },
    reply: async (p) => { reassignConfirmReply = p; },
  });
  assert.ok(reassignConfirmReply);
  assert.match(idp1Msg.content, /Slot 03 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 10 → Team Alpha/);
  assert.match(idp1Msg.content, /🟡 7\/13 filled/);

  // 7. Test 6: Persistence in MongoDB / slot state records & Bot Restart reconciliation
  const slotStates = await getRegistrationSlotStates(reg1.registrationId, reg1.currentCycleId);
  assert.equal(slotStates.length, 18);
  const slotStateByNum = new Map(slotStates.map((s) => [s.slotNumber, s]));
  assert.equal(slotStateByNum.get(1).status, 'LOCKED');
  assert.equal(slotStateByNum.get(2).status, 'LOCKED');
  assert.equal(slotStateByNum.get(3).status, 'LOCKED');
  assert.equal(slotStateByNum.get(4).status, 'OCCUPIED');
  assert.equal(slotStateByNum.get(4).teamId, 'team-lock-2');
  assert.equal(slotStateByNum.get(10).status, 'OCCUPIED');
  assert.equal(slotStateByNum.get(10).teamId, 'team-lock-1');
  assert.equal(slotStateByNum.get(11).status, 'AVAILABLE');
  assert.equal(slotStateByNum.get(17).status, 'LOCKED');
  assert.equal(slotStateByNum.get(18).status, 'LOCKED');

  await reconcileConfigurableTournaments(mockClient);
  const reg1AfterRestart = await getConfigurableRegistration(reg1.registrationId);
  assert.deepEqual(getLockedSlotNumbers(reg1AfterRestart, 18), [1, 2, 3, 17, 18]);

  // 8. Test 8: Verify other registration instances (reg2) remain completely unaffected
  const reg2State = await getConfigurableRegistration(reg2.registrationId);
  assert.deepEqual(getLockedSlotNumbers(reg2State, 18), []);

  // 9. Test 7: Start a new daily cycle and verify locked slots remain LOCKED while occupied slots reset to AVAILABLE
  await executeDailyCycleReset(mockClient, reg1.registrationId, true, new Date('2026-11-05T23:05:00+05:30'));
  const reg1NextCycle = await getConfigurableRegistration(reg1.registrationId);
  assert.deepEqual(getLockedSlotNumbers(reg1NextCycle, 18), [1, 2, 3, 17, 18]);

  const nextCycleSlotStates = await getRegistrationSlotStates(reg1.registrationId, reg1NextCycle.currentCycleId);
  const nextStateByNum = new Map(nextCycleSlotStates.map((s) => [s.slotNumber, s]));
  assert.equal(nextStateByNum.get(1).status, 'LOCKED');
  assert.equal(nextStateByNum.get(2).status, 'LOCKED');
  assert.equal(nextStateByNum.get(3).status, 'LOCKED');
  assert.equal(nextStateByNum.get(4).status, 'AVAILABLE');
  assert.equal(nextStateByNum.get(10).status, 'AVAILABLE');
  assert.equal(nextStateByNum.get(17).status, 'LOCKED');
  assert.equal(nextStateByNum.get(18).status, 'LOCKED');

  assert.match(idp1Msg.content, /Slot 01 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 02 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 03 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 04 → AVAILABLE/);
  assert.match(idp1Msg.content, /Slot 17 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 18 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /⚪ 0\/13 filled/);

  clearAllRegistrationTimers();
});

test('FEATURE: Registration-Level Team Removal — slot release without shifting, IDP access revocation, audit log & enrollment preservation', async () => {
  clearInMemoryData();
  clearAllRegistrationTimers();

  const guildId = 'guild-rem-team';
  const tourId = 'tour-rem-team';
  const organizerId = 'org-rem-1';

  await saveConfigurableTournament({
    tournamentId: tourId,
    guildId,
    name: 'T3 Scrims',
    categoryId: 'cat-rem-team',
    setupChannelId: 'chan-setup-rem',
    standardChannels: {
      infoChannelId: 'chan-info-rem',
      updatesChannelId: 'chan-updates-rem',
      verifyChannelId: 'chan-verify-rem',
    },
    createdBy: organizerId,
    requiredDiscordMembers: 4,
  });

  const channelMessages = new Map();
  const idpPermissionOverwrites = new Map(); // chanId -> Set of userIds with access
  const failRevokeForChannels = new Set();

  const ensureChannelMap = (chanId) => {
    if (!channelMessages.has(chanId)) channelMessages.set(chanId, new Map());
    return channelMessages.get(chanId);
  };
  const ensureOverwriteSet = (chanId) => {
    if (!idpPermissionOverwrites.has(chanId)) idpPermissionOverwrites.set(chanId, new Set());
    return idpPermissionOverwrites.get(chanId);
  };

  let msgSeq = 1;
  const buildMockChannel = (chanId) => ({
    id: chanId,
    isTextBased: () => true,
    permissionOverwrites: {
      edit: async (targetId, perms) => {
        if (perms?.ViewChannel === true) {
          ensureOverwriteSet(chanId).add(targetId);
        }
      },
      delete: async (targetId) => {
        if (failRevokeForChannels.has(chanId)) {
          throw new Error('Discord API 500: Permission overwrite delete failed');
        }
        ensureOverwriteSet(chanId).delete(targetId);
      },
    },
    messages: {
      fetch: async (msgId) => {
        const map = ensureChannelMap(chanId);
        if (!map.has(msgId)) throw new Error('Unknown Message');
        return map.get(msgId);
      },
    },
    send: async (payload) => {
      const id = `msg-rem-${chanId}-${msgSeq++}`;
      const record = {
        id,
        channelId: chanId,
        content: payload.content || '',
        embeds: payload.embeds || [],
        components: payload.components || [],
        edit: async (nextPayload) => {
          if (nextPayload.content !== undefined) record.content = nextPayload.content;
          if (nextPayload.embeds !== undefined) record.embeds = nextPayload.embeds;
          if (nextPayload.components !== undefined) record.components = nextPayload.components;
          return record;
        },
        delete: async () => {
          ensureChannelMap(chanId).delete(id);
        },
      };
      ensureChannelMap(chanId).set(id, record);
      return record;
    },
  });

  const mockGuild = {
    id: guildId,
    roles: { everyone: { id: guildId } },
    channels: {
      fetch: async (id) => buildMockChannel(id),
    },
  };

  const mockClient = {
    user: { id: 'bot-rem' },
    guilds: {
      fetch: async (id) => (id === guildId ? mockGuild : null),
    },
    channels: {
      fetch: async (id) => buildMockChannel(id),
    },
  };

  const reg1Msg = await buildMockChannel('chan-reg-rem-1').send({ content: 'Initial reg 1' });
  const idp1Msg = await buildMockChannel('chan-idp-rem-1').send({ content: 'Initial slotchart 1' });
  const reg2Msg = await buildMockChannel('chan-reg-rem-2').send({ content: 'Initial reg 2' });
  const idp2Msg = await buildMockChannel('chan-idp-rem-2').send({ content: 'Initial slotchart 2' });

  const reg1 = await saveConfigurableRegistration({
    registrationId: 'reg-rem-1',
    tournamentId: tourId,
    guildId,
    displayName: '10PM',
    totalSlots: 6,
    reservedSlots: 2,
    lockedSlots: [1, 2],
    matches: 2,
    status: 'OPEN',
    manualOverride: 'OPEN',
    dailyStartTime: '09:00',
    dailyResetTime: '23:00',
    currentCycleDate: '2026-11-05',
    currentCycleId: 'reg-rem-1:2026-11-05',
    registrationChannelId: 'chan-reg-rem-1',
    registrationMessageId: reg1Msg.id,
    idpChannelId: 'chan-idp-rem-1',
    slotChartMessageId: idp1Msg.id,
  });

  const reg2 = await saveConfigurableRegistration({
    registrationId: 'reg-rem-2',
    tournamentId: tourId,
    guildId,
    displayName: '11PM',
    totalSlots: 6,
    reservedSlots: 2,
    lockedSlots: [1, 2],
    matches: 2,
    status: 'OPEN',
    manualOverride: 'OPEN',
    dailyStartTime: '10:00',
    dailyResetTime: '23:00',
    currentCycleDate: '2026-11-05',
    currentCycleId: 'reg-rem-2:2026-11-05',
    registrationChannelId: 'chan-reg-rem-2',
    registrationMessageId: reg2Msg.id,
    idpChannelId: 'chan-idp-rem-2',
    slotChartMessageId: idp2Msg.id,
  });

  // Enroll 4 teams in the tournament
  const teamsData = [
    { id: 'team-rem-alpha', name: 'Team Alpha', leader: 'leader-rem-alpha', members: ['leader-rem-alpha', 'p2-alpha', 'p3-alpha', 'p4-alpha'] },
    { id: 'team-rem-bravo', name: 'Team Bravo', leader: 'leader-rem-bravo', members: ['leader-rem-bravo', 'p2-bravo', 'p3-bravo', 'p4-bravo'] },
    { id: 'team-rem-phoenix', name: 'Team Phoenix', leader: 'leader-rem-phoenix', members: ['leader-rem-phoenix', 'p2-phoenix', 'p3-phoenix', 'p4-phoenix'] },
    { id: 'team-rem-delta', name: 'Team Delta', leader: 'leader-rem-delta', members: ['leader-rem-delta', 'p2-delta', 'p3-delta', 'p4-delta'] },
  ];

  for (const t of teamsData) {
    await saveConfigurableTeam({
      teamId: t.id,
      tournamentId: tourId,
      guildId,
      teamName: t.name,
      leaderDiscordId: t.leader,
      VerificationStatus: 'VERIFIED',
      players: t.members.map((m, idx) => ({ discordId: m, ign: `${t.name}_P${idx + 1}`, uid: `800${idx}` })),
    });
  }

  // Register Team Alpha, Team Bravo, Team Phoenix in Registration 1 -> Slots 03, 04, 05
  for (const t of teamsData.slice(0, 3)) {
    const interaction = {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: t.leader },
      reply: async () => {},
    };
    await registerSquadFull(interaction, reg1.registrationId);
  }

  // Also register Team Alpha in Registration 2 -> Slot 03
  const alphaReg2Int = {
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: 'leader-rem-alpha' },
    reply: async () => {},
  };
  await registerSquadFull(alphaReg2Int, reg2.registrationId);

  // Verify initial state before removal
  assert.equal(ensureOverwriteSet('chan-idp-rem-1').has('leader-rem-alpha'), true);
  assert.equal(ensureOverwriteSet('chan-idp-rem-2').has('leader-rem-alpha'), true);
  assert.match(idp1Msg.content, /Slot 01 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 02 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 03 → Team Alpha/);
  assert.match(idp1Msg.content, /Slot 04 → Team Bravo/);
  assert.match(idp1Msg.content, /Slot 05 → Team Phoenix/);
  assert.match(idp1Msg.content, /Slot 06 → AVAILABLE/);

  // 1. Organiser opens Remove Team menu
  let removeMenuReply = null;
  await handleConfigurableTournamentInteraction({
    customId: `md_cfg_remove_team_btn_${reg1.registrationId}`,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: organizerId },
    member: { permissions: { has: () => true } },
    reply: async (p) => { removeMenuReply = p; },
  });
  assert.ok(removeMenuReply);
  assert.match(removeMenuReply.content, /T3 Scrims — 10PM Registration/);
  assert.match(removeMenuReply.content, /Team Alpha — Slot 03/);
  assert.match(removeMenuReply.content, /Team Bravo — Slot 04/);
  assert.match(removeMenuReply.content, /Team Phoenix — Slot 05/);

  // 2. Organiser selects Team Alpha -> Confirmation prompt shown
  let confirmPromptReply = null;
  await handleConfigurableTournamentInteraction({
    customId: `md_cfg_remove_team_select_${reg1.registrationId}`,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    values: ['team-rem-alpha'],
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: organizerId },
    member: { permissions: { has: () => true } },
    update: async (p) => { confirmPromptReply = p; },
    reply: async (p) => { confirmPromptReply = p; },
  });
  assert.ok(confirmPromptReply);
  assert.match(confirmPromptReply.content, /Remove Team from Registration\?/);
  assert.match(
    confirmPromptReply.content,
    /Are you sure you want to remove Team Alpha from this registration\? The team will lose access to this registration's private IDP channel\./
  );
  const confirmRowBtns = confirmPromptReply.components[0].components.map((b) => b.data.label);
  assert.deepEqual(confirmRowBtns, ['Confirm Removal', 'Cancel']);

  // 3. Organiser clicks Confirm Removal for Team Alpha in Registration 1
  let removalResultReply = null;
  await handleConfigurableTournamentInteraction({
    customId: `md_cfg_remove_team_confirm_${reg1.registrationId}_team-rem-alpha`,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: organizerId },
    member: { permissions: { has: () => true } },
    update: async (p) => { removalResultReply = p; },
    reply: async (p) => { removalResultReply = p; },
  });
  assert.ok(removalResultReply);
  assert.match(removalResultReply.content, /Removed \*\*Team Alpha\*\*/);
  assert.match(removalResultReply.content, /Slot 03/);

  // Verify slot chart updated immediately WITHOUT shifting Team Bravo (Slot 04) or Team Phoenix (Slot 05)
  assert.match(idp1Msg.content, /Slot 01 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 02 → 🔒 LOCKED/);
  assert.match(idp1Msg.content, /Slot 03 → AVAILABLE/);
  assert.match(idp1Msg.content, /Slot 04 → Team Bravo/);
  assert.match(idp1Msg.content, /Slot 05 → Team Phoenix/);
  assert.match(idp1Msg.content, /Slot 06 → AVAILABLE/);
  assert.match(idp1Msg.content, /🟡 2\/4 filled/);

  // Verify leader lost access to IDP 1, but kept access to IDP 2
  assert.equal(ensureOverwriteSet('chan-idp-rem-1').has('leader-rem-alpha'), false, 'Leader lost access to Registration 1 IDP');
  assert.equal(ensureOverwriteSet('chan-idp-rem-2').has('leader-rem-alpha'), true, 'Leader kept access to Registration 2 IDP');

  // Verify Team Alpha remains enrolled in tournament and its player memberships are NOT released
  const alphaTeamStillEnrolled = await getConfigurableTeam('team-rem-alpha');
  assert.ok(alphaTeamStillEnrolled, 'Team Alpha remains enrolled in the tournament');
  const tourMemberships = await getTournamentPlayerMemberships(tourId);
  const alphaMemberships = tourMemberships.filter((m) => m.teamId === 'team-rem-alpha');
  assert.equal(alphaMemberships.length, 4, 'Removing from a registration must not free player memberships');

  // Verify audit log recorded the removal
  const auditLogs = await getConfigurableAuditLogs({
    tournamentId: tourId,
    registrationId: reg1.registrationId,
    teamId: 'team-rem-alpha',
    action: 'REGISTRATION_TEAM_REMOVED',
  });
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].releasedSlot, 3);
  assert.equal(auditLogs[0].idpAccessRevoked, true);

  // Verify duplicate removal request is handled gracefully
  let duplicateRemovalReply = null;
  await handleConfirmRemoveTeamFromRegistration(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      update: async (p) => { duplicateRemovalReply = p; },
      reply: async (p) => { duplicateRemovalReply = p; },
    },
    reg1.registrationId,
    'team-rem-alpha'
  );
  assert.ok(duplicateRemovalReply);
  assert.match(duplicateRemovalReply.content, /not found or already removed/i);

  // 4. Register another team (Team Delta) into Registration 1 -> must receive newly released Slot #3
  const deltaInt = {
    guildId,
    guild: mockGuild,
    client: mockClient,
    user: { id: 'leader-rem-delta' },
    reply: async () => {},
  };
  await registerSquadFull(deltaInt, reg1.registrationId);
  assert.match(deltaInt.lastReply.content, /Slot #3/);
  assert.match(idp1Msg.content, /Slot 03 → Team Delta/);

  // 5. Test Discord permission revocation failure handling (never silently report access revoked; retry on reconciliation)
  failRevokeForChannels.add('chan-idp-rem-1');
  let failedPermReply = null;
  await handleConfirmRemoveTeamFromRegistration(
    {
      guildId,
      guild: mockGuild,
      client: mockClient,
      user: { id: organizerId },
      member: { permissions: { has: () => true } },
      update: async (p) => { failedPermReply = p; },
      reply: async (p) => { failedPermReply = p; },
    },
    reg1.registrationId,
    'team-rem-bravo'
  );
  assert.ok(failedPermReply);
  assert.match(failedPermReply.content, /revoking Discord access.*failed/i);
  assert.match(failedPermReply.content, /reconciliation has been queued/i);
  assert.match(idp1Msg.content, /Slot 04 → AVAILABLE/);

  // Now restore Discord API and run reconciliation -> Bravo's leader access to IDP 1 is revoked
  failRevokeForChannels.delete('chan-idp-rem-1');
  await reconcileConfigurableTournaments(mockClient);
  assert.equal(ensureOverwriteSet('chan-idp-rem-1').has('leader-rem-bravo'), false, 'Reconciliation revoked pending IDP access');

  clearAllRegistrationTimers();
});

test('FEATURE: Player Exclusivity During Team Verification — main players, substitutes, cross-tournament, edit squad, delete squad & concurrency', async () => {
  clearInMemoryData();
  clearAllRegistrationTimers();

  const guildId = 'guild-player-excl';
  const tour1Id = 'tour-excl-1';
  const tour2Id = 'tour-excl-2';

  await saveConfigurableTournament({
    tournamentId: tour1Id,
    guildId,
    name: 'T1 Pro League',
    requiredDiscordMembers: 4,
  });

  await saveConfigurableTournament({
    tournamentId: tour2Id,
    guildId,
    name: 'T2 Challenger Cup',
    requiredDiscordMembers: 4,
  });

  const allTestMembers = [
    'player-a', 'player-b', 'player-c', 'player-d',
    'player-e', 'player-f', 'player-g', 'player-h',
    'player-i', 'player-j', 'player-k', 'player-l',
    'sub-a', 'sub-b',
  ];

  const makeStep5Interaction = (tournamentId, leaderId, values, substituteValues = []) => {
    let output = null;
    return {
      guildId,
      guild: {
        id: guildId,
        members: {
          cache: new Map(allTestMembers.map((id) => [id, { id }])),
          fetch: async (id) => (allTestMembers.includes(id) ? { id } : null),
        },
      },
      client: { channels: { fetch: async () => null } },
      user: { id: leaderId },
      values,
      substituteValues,
      reply: async (p) => { output = p; return p; },
      update: async (p) => { output = p; return p; },
      getReply: () => output,
    };
  };

  // 1. Enroll Team Alpha in Tournament 1 with 4 main players (player-a..d) and 1 substitute (sub-a)
  await handleStep1ModalSubmit(createMockStep1Interaction(tour1Id, 'player-a', 'Team Alpha', 'Alpha1', '101', 'Alpha2', '102'), tour1Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour1Id, 'player-a', 'Alpha3', '103', 'Alpha4', '104'), tour1Id);
  await handleStep3ModalSubmit(
    createMockStep3Interaction(tour1Id, 'player-a', [{ ign: 'AlphaSub1', uid: '105' }]),
    tour1Id
  );

  const alphaStep5 = makeStep5Interaction(
    tour1Id,
    'player-a',
    ['player-a', 'player-b', 'player-c', 'player-d'],
    ['sub-a']
  );
  await handleStep5UserSelect(alphaStep5, tour1Id);
  assert.match(alphaStep5.getReply().content, /Your squad has been successfully enrolled/);

  const teamAlpha = await getConfigurableTeamByName(tour1Id, 'Team Alpha');
  assert.ok(teamAlpha);

  // 2. Attempt to enroll Team Bravo in Tournament 1 using one of Team Alpha's main players ('player-b')
  await handleStep1ModalSubmit(createMockStep1Interaction(tour1Id, 'player-e', 'Team Bravo', 'Bravo1', '201', 'Bravo2', '202'), tour1Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour1Id, 'player-e', 'Bravo3', '203', 'Bravo4', '204'), tour1Id);
  await handleSkipSubstitutes(createMockButtonInteraction(tour1Id, 'player-e'), tour1Id);

  const bravoConflictMain = makeStep5Interaction(
    tour1Id,
    'player-e',
    ['player-e', 'player-b', 'player-f', 'player-g']
  );
  await handleStep5UserSelect(bravoConflictMain, tour1Id);
  assert.match(
    bravoConflictMain.getReply().content,
    /One or more selected members are already assigned to another squad in this tournament\./
  );
  const bravoNotCreatedYet = await getConfigurableTeamByName(tour1Id, 'Team Bravo');
  assert.equal(bravoNotCreatedYet, null, 'Team Bravo must not be created when conflicting player is selected');

  // 3. Attempt to enroll Team Bravo in Tournament 1 using Team Alpha's substitute ('sub-a') as a main player
  const bravoConflictSubAsMain = makeStep5Interaction(
    tour1Id,
    'player-e',
    ['player-e', 'sub-a', 'player-f', 'player-g']
  );
  await handleStep5UserSelect(bravoConflictSubAsMain, tour1Id);
  assert.match(
    bravoConflictSubAsMain.getReply().content,
    /One or more selected members are already assigned to another squad in this tournament\./
  );

  // 4. Attempt to enroll Team Bravo in Tournament 1 using Team Alpha's main player ('player-c') as a substitute
  await handleStep3ModalSubmit(
    createMockStep3Interaction(tour1Id, 'player-e', [{ ign: 'BravoSub', uid: '299' }]),
    tour1Id
  );
  const bravoConflictMainAsSub = makeStep5Interaction(
    tour1Id,
    'player-e',
    ['player-e', 'player-f', 'player-g', 'player-h'],
    ['player-c']
  );
  await handleStep5UserSelect(bravoConflictMainAsSub, tour1Id);
  assert.match(
    bravoConflictMainAsSub.getReply().content,
    /One or more selected members are already assigned to another squad in this tournament\./
  );

  // 5. Try using Team Alpha's players ('player-b', 'sub-a') in ANOTHER tournament (Tournament 2) -> ALLOWED!
  await handleStep1ModalSubmit(createMockStep1Interaction(tour2Id, 'player-b', 'Other Tour Squad', 'OT1', '301', 'OT2', '302'), tour2Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour2Id, 'player-b', 'OT3', '303', 'OT4', '304'), tour2Id);
  await handleSkipSubstitutes(createMockButtonInteraction(tour2Id, 'player-b'), tour2Id);

  const tour2Step5 = makeStep5Interaction(
    tour2Id,
    'player-b',
    ['player-b', 'sub-a', 'player-c', 'player-d']
  );
  await handleStep5UserSelect(tour2Step5, tour2Id);
  assert.match(tour2Step5.getReply().content, /Your squad has been successfully enrolled/);

  // 6. Edit Team Alpha in Tournament 1 and replace 'player-d' with 'player-i' (and remove substitute 'sub-a')
  await handleEditSquadButtonClick(
    {
      user: { id: 'player-a' },
      showModal: async () => {},
      reply: async () => {},
    },
    teamAlpha.teamId
  );
  await handleStep1ModalSubmit(createMockStep1Interaction(tour1Id, 'player-a', 'Team Alpha', 'Alpha1', '101', 'Alpha2', '102'), tour1Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour1Id, 'player-a', 'Alpha3', '103', 'Alpha4New', '109'), tour1Id);
  await handleSkipSubstitutes(createMockButtonInteraction(tour1Id, 'player-a'), tour1Id);

  const editAlphaStep5 = makeStep5Interaction(
    tour1Id,
    'player-a',
    ['player-a', 'player-b', 'player-c', 'player-i']
  );
  await handleStep5UserSelect(editAlphaStep5, tour1Id);
  assert.match(editAlphaStep5.getReply().content, /Your squad has been successfully updated/);

  // Verify 'player-d' and 'sub-a' were released after successful edit, and 'player-i' is now assigned to Team Alpha
  const membershipsAfterEdit = await getTournamentPlayerMemberships(tour1Id);
  const memberIdsAfterEdit = new Set(membershipsAfterEdit.map((m) => m.discordUserId));
  assert.equal(memberIdsAfterEdit.has('player-i'), true, 'New player assigned to Team Alpha');
  assert.equal(memberIdsAfterEdit.has('player-d'), false, 'Old replaced main player released');
  assert.equal(memberIdsAfterEdit.has('sub-a'), false, 'Old removed substitute released');

  // Now Team Bravo CAN enroll using the released 'player-d' and 'sub-a'!
  await handleStep1ModalSubmit(createMockStep1Interaction(tour1Id, 'player-e', 'Team Bravo', 'Bravo1', '201', 'Bravo2', '202'), tour1Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour1Id, 'player-e', 'Bravo3', '203', 'Bravo4', '204'), tour1Id);
  await handleStep3ModalSubmit(
    createMockStep3Interaction(tour1Id, 'player-e', [{ ign: 'BravoSub', uid: '299' }]),
    tour1Id
  );
  const bravoSuccessStep5 = makeStep5Interaction(
    tour1Id,
    'player-e',
    ['player-e', 'player-d', 'player-f', 'player-g'],
    ['sub-a']
  );
  await handleStep5UserSelect(bravoSuccessStep5, tour1Id);
  assert.match(bravoSuccessStep5.getReply().content, /Your squad has been successfully enrolled/);

  // 7. Delete Team Bravo -> verify its players ('player-e', 'player-d', 'player-f', 'player-g', 'sub-a') are released
  const teamBravo = await getConfigurableTeamByName(tour1Id, 'Team Bravo');
  assert.ok(teamBravo);
  let deleteBravoOut = null;
  await handleDeleteSquadConfirm(
    {
      guildId,
      user: { id: 'player-e' },
      client: { channels: { fetch: async () => null } },
      update: async (p) => { deleteBravoOut = p; },
      reply: async (p) => { deleteBravoOut = p; },
    },
    teamBravo.teamId
  );
  assert.match(deleteBravoOut.content, /Squad Deleted/);
  const membershipsAfterDelete = await getTournamentPlayerMemberships(tour1Id);
  const memberIdsAfterDelete = new Set(membershipsAfterDelete.map((m) => m.discordUserId));
  assert.equal(memberIdsAfterDelete.has('player-e'), false);
  assert.equal(memberIdsAfterDelete.has('player-d'), false);
  assert.equal(memberIdsAfterDelete.has('sub-a'), false);

  // 8. Concurrency test: Two simultaneous enrollment sessions selecting the same Discord player ('player-h')
  await handleStep1ModalSubmit(createMockStep1Interaction(tour1Id, 'player-e', 'Concurrent One', 'C1', '401', 'C2', '402'), tour1Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour1Id, 'player-e', 'C3', '403', 'C4', '404'), tour1Id);
  await handleSkipSubstitutes(createMockButtonInteraction(tour1Id, 'player-e'), tour1Id);

  await handleStep1ModalSubmit(createMockStep1Interaction(tour1Id, 'player-j', 'Concurrent Two', 'D1', '501', 'D2', '502'), tour1Id);
  await handleStep2ModalSubmit(createMockStep2Interaction(tour1Id, 'player-j', 'D3', '503', 'D4', '504'), tour1Id);
  await handleSkipSubstitutes(createMockButtonInteraction(tour1Id, 'player-j'), tour1Id);

  // Both select 'player-h' and submit simultaneously
  const concurrentInt1 = makeStep5Interaction(tour1Id, 'player-e', ['player-e', 'player-f', 'player-g', 'player-h']);
  const concurrentInt2 = makeStep5Interaction(tour1Id, 'player-j', ['player-j', 'player-k', 'player-l', 'player-h']);

  await Promise.all([
    handleStep5UserSelect(concurrentInt1, tour1Id),
    handleStep5UserSelect(concurrentInt2, tour1Id),
  ]);

  const reply1 = concurrentInt1.getReply()?.content || '';
  const reply2 = concurrentInt2.getReply()?.content || '';
  const successes = [reply1, reply2].filter((r) => r.includes('successfully enrolled'));
  const rejections = [reply1, reply2].filter((r) =>
    r.includes('One or more selected members are already assigned to another squad in this tournament.')
  );

  assert.equal(successes.length, 1, 'Exactly one concurrent enrollment must succeed');
  assert.equal(rejections.length, 1, 'The conflicting concurrent enrollment must be rejected');

  const finalTour1Memberships = await getTournamentPlayerMemberships(tour1Id);
  const playerHRecords = finalTour1Memberships.filter((m) => m.discordUserId === 'player-h');
  assert.equal(playerHRecords.length, 1, 'No duplicate membership records exist for the contested player');

  clearAllRegistrationTimers();
});













