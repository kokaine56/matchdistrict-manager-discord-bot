import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertToMs,
  formatDurationText,
  formatTimeRemaining,
  canMemberManageRolePeriod,
  canBotManageRoles,
  getAssignableProgressionRoles,
  normalizeProgressionConfig,
  evaluateMemberStage,
  processMemberProgression,
  buildSetupPanelPayload,
  buildAddStageRoleSelectPayload,
  buildDurationModal,
  buildRemoveStagePayload,
  buildEditStageSelectPayload,
  buildProgressionViewEmbed,
  buildMemberProgressionCheckEmbed,
  handleRolePeriodCommand,
  handleRolePeriodInteraction,
  handleRolePeriodMemberJoin,
  rolePeriodConfigCache,
  rolePeriodSessions,
  ROLE_PERIOD_PREFIX,
} from '../rolePeriodService.js';
import { PermissionFlagsBits } from 'discord.js';

test('1. Time Conversion and Duration Formatting', () => {
  assert.strictEqual(convertToMs(0, 'days'), 0);
  assert.strictEqual(convertToMs(5, 'days'), 5 * 24 * 60 * 60 * 1000);
  assert.strictEqual(convertToMs(2, 'weeks'), 2 * 7 * 24 * 60 * 60 * 1000);
  assert.strictEqual(convertToMs(3, 'months'), 3 * 30 * 24 * 60 * 60 * 1000);

  assert.strictEqual(formatDurationText(0, 0, 'days'), 'Immediately (0 days)');
  assert.strictEqual(formatDurationText(convertToMs(3, 'months'), 3, 'months'), '3 months');
  assert.strictEqual(formatDurationText(convertToMs(1, 'month'), 1, 'months'), '1 month');
  assert.strictEqual(formatDurationText(convertToMs(2, 'weeks'), 2, 'weeks'), '2 weeks');
  assert.strictEqual(formatDurationText(convertToMs(10, 'days'), 10, 'days'), '10 days');

  assert.strictEqual(formatTimeRemaining(0), 'Eligible now');
  assert.strictEqual(formatTimeRemaining(-5000), 'Eligible now');
  // 2 days, 3 hours, 4 minutes
  const testMs = (2 * 24 * 3600 + 3 * 3600 + 4 * 60) * 1000;
  assert.strictEqual(formatTimeRemaining(testMs), '2d 3h 4m');
});

test('2. Permission Guards & Hierarchy Checks', () => {
  const fakeAdmin = {
    id: 'admin-1',
    permissions: { has: (perm) => perm === PermissionFlagsBits.Administrator },
    guild: { ownerId: 'owner-1' },
  };
  const fakeManageGuild = {
    id: 'mod-1',
    permissions: { has: (perm) => perm === PermissionFlagsBits.ManageGuild },
    guild: { ownerId: 'owner-1' },
  };
  const fakeRegular = {
    id: 'reg-1',
    permissions: { has: () => false },
    guild: { ownerId: 'owner-1' },
  };
  const fakeOwner = {
    id: 'owner-1',
    permissions: { has: () => false },
    guild: { ownerId: 'owner-1' },
  };

  assert.strictEqual(canMemberManageRolePeriod(fakeAdmin), true);
  assert.strictEqual(canMemberManageRolePeriod(fakeManageGuild), true);
  assert.strictEqual(canMemberManageRolePeriod(fakeRegular), false);
  assert.strictEqual(canMemberManageRolePeriod(fakeOwner), true);

  const fakeGuildWithManageRoles = {
    members: {
      me: {
        permissions: { has: (perm) => perm === PermissionFlagsBits.ManageRoles },
      },
    },
  };
  const fakeGuildWithoutManageRoles = {
    members: {
      me: {
        permissions: { has: () => false },
      },
    },
  };

  assert.strictEqual(canBotManageRoles(fakeGuildWithManageRoles), true);
  assert.strictEqual(canBotManageRoles(fakeGuildWithoutManageRoles), false);

  // Hierarchy filter test
  const rolesMap = new Map([
    ['guild-id', { id: 'guild-id', name: '@everyone', position: 0, managed: false }],
    ['bot-role', { id: 'bot-role', name: 'Bot', position: 10, managed: false }],
    ['high-role', { id: 'high-role', name: 'Admin Role', position: 12, managed: false }],
    ['managed-role', { id: 'managed-role', name: 'Integration', position: 5, managed: true }],
    ['prog-role-1', { id: 'prog-role-1', name: 'Newbie', position: 3, managed: false }],
    ['prog-role-2', { id: 'prog-role-2', name: 'Veteran', position: 6, managed: false }],
  ]);

  const fakeGuildRoles = {
    id: 'guild-id',
    roles: { cache: rolesMap },
    members: {
      me: {
        roles: { highest: { position: 10 } },
      },
    },
  };

  const assignable = getAssignableProgressionRoles(fakeGuildRoles);
  const ids = assignable.map((r) => r.id);
  assert.deepStrictEqual(ids, ['prog-role-2', 'prog-role-1']);
});

test('3. Stage Evaluation Engine (Ascending milestones & time remaining)', () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 6, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 12, durationUnit: 'months' },
  ];

  // Base join date: Jan 17, 2024 at 12:00:00 UTC
  const joinTs = Date.UTC(2024, 0, 17, 12, 0, 0);

  // 1. Immediately on joining (0 ms) -> Stage 1 (Newbie), Next Stage 2 (Regular)
  const evalImmediate = evaluateMemberStage(stages, joinTs, joinTs);
  assert.strictEqual(evalImmediate.currentStage?.roleId, 'role-newbie');
  assert.strictEqual(evalImmediate.nextStage?.roleId, 'role-regular');
  const expectedMsUntilReg = Date.UTC(2024, 3, 17, 12, 0, 0) - joinTs;
  assert.strictEqual(evalImmediate.msUntilNext, expectedMsUntilReg);

  // 2. After 3 months (April 17, 2024) -> Stage 2 (Regular), Next Stage 3 (Veteran)
  const ts3Mo = Date.UTC(2024, 3, 17, 12, 0, 0);
  const eval3Mo = evaluateMemberStage(stages, joinTs, ts3Mo);
  assert.strictEqual(eval3Mo.currentStage?.roleId, 'role-regular');
  assert.strictEqual(eval3Mo.nextStage?.roleId, 'role-veteran');
  const expectedMsUntilVet = Date.UTC(2024, 6, 17, 12, 0, 0) - ts3Mo;
  assert.strictEqual(eval3Mo.msUntilNext, expectedMsUntilVet);

  // 3. After 8 months (Sept 17, 2024) -> Stage 3 (Veteran), Next Stage 4 (OG Member)
  const ts8Mo = Date.UTC(2024, 8, 17, 12, 0, 0);
  const eval8Mo = evaluateMemberStage(stages, joinTs, ts8Mo);
  assert.strictEqual(eval8Mo.currentStage?.roleId, 'role-veteran');
  assert.strictEqual(eval8Mo.nextStage?.roleId, 'role-og');
  const expectedMsUntilOg = Date.UTC(2025, 0, 17, 12, 0, 0) - ts8Mo;
  assert.strictEqual(eval8Mo.msUntilNext, expectedMsUntilOg);

  // 4. After 15 months (April 17, 2025) -> Stage 4 (OG Member), Max milestone reached (null next)
  const ts15Mo = Date.UTC(2025, 3, 17, 12, 0, 0);
  const eval15Mo = evaluateMemberStage(stages, joinTs, ts15Mo);
  assert.strictEqual(eval15Mo.currentStage?.roleId, 'role-og');
  assert.strictEqual(eval15Mo.nextStage, null);
  assert.strictEqual(eval15Mo.msUntilNext, 0);
});

test('4. Automatic Role Upgrade & Previous Stage Role Removal (Preserving Unrelated Roles)', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  // Member joined 4 months ago (eligible for Stage 2: Regular, since 4 months >= 3 months and < 6 months)
  // Member currently holds: 'unrelated-vip', 'role-newbie'
  const fourMonthsAgo = Date.now() - 4 * 30 * 24 * 60 * 60 * 1000;
  const addedRoles = [];
  const removedRoles = [];

  const fakeMember = {
    id: 'user-prog-1',
    guild: { id: 'test-guild' },
    joinedTimestamp: fourMonthsAgo,
    roles: {
      cache: new Map([
        ['unrelated-vip', { id: 'unrelated-vip', name: 'VIP Sponsor' }],
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
      ]),
      add: async (roleId) => { addedRoles.push(roleId); },
      remove: async (roleId) => { removedRoles.push(roleId); },
    },
  };

  const result = await processMemberProgression(fakeMember, config);

  assert.strictEqual(result.changed, true);
  // 'role-newbie' should be removed because member graduated to 'role-regular'
  assert.deepStrictEqual(result.removedRoles, ['role-newbie']);
  // 'role-regular' should be assigned
  assert.strictEqual(result.assignedRole, 'role-regular');
  // 'unrelated-vip' must NEVER be removed
  assert.ok(!result.removedRoles.includes('unrelated-vip'));
});

test('5. Duplicate Role Prevention: Does not reassign if member already has current role', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationMs: 0 },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationMs: convertToMs(3, 'months') },
  ];
  const config = { stages, enabled: true };

  // Member joined 4 months ago and ALREADY has role-regular, no old roles
  const fourMonthsAgo = Date.now() - convertToMs(4, 'months');
  const fakeMember = {
    id: 'user-prog-2',
    guild: { id: 'test-guild' },
    joinedTimestamp: fourMonthsAgo,
    roles: {
      cache: new Map([
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
      ]),
      add: async () => {},
      remove: async () => {},
    },
  };

  const result = await processMemberProgression(fakeMember, config);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.assignedRole, null);
  assert.deepStrictEqual(result.removedRoles, []);
});

test('6. Setup Panel & Interactive Wizard Flow', async () => {
  const session = {
    sessionId: 'test-session-123',
    guildId: 'test-guild',
    userId: 'admin-1',
    stages: [
      { stageNumber: 1, roleId: 'role-1', roleName: 'Newbie', durationMs: 0, durationValue: 0, durationUnit: 'days' },
    ],
  };
  const guild = {
    name: 'MatchDistrict Server',
    roles: {
      cache: new Map([
        ['role-1', { id: 'role-1', name: 'Newbie', position: 2, managed: false }],
        ['role-2', { id: 'role-2', name: 'Regular', position: 3, managed: false }],
      ]),
    },
    members: { me: { roles: { highest: { position: 10 } } } },
  };

  // 1. Setup Panel
  const panel = buildSetupPanelPayload(session, guild);
  assert.strictEqual(panel.embeds.length, 1);
  assert.strictEqual(panel.components.length, 2);

  // 2. Add Stage Role Select
  const addStagePayload = buildAddStageRoleSelectPayload(session, guild, 0);
  assert.strictEqual(addStagePayload.embeds.length, 1);
  assert.strictEqual(addStagePayload.components.length, 2);

  // 3. Modal Builder
  const modal = buildDurationModal('test-session-123', 'role-2', 3, 'months');
  assert.strictEqual(modal.data.title, 'Set Stage Duration');

  // 4. Remove Stage Payload
  const removePayload = buildRemoveStagePayload(session);
  assert.strictEqual(removePayload.components.length, 2);

  // 5. Edit Stage Payload
  const editPayload = buildEditStageSelectPayload(session);
  assert.strictEqual(editPayload.components.length, 2);
});

test('7. View & Member Check Embeds', () => {
  const guild = {
    name: 'MatchDistrict Server',
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
      ]),
    },
  };
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationMs: 0, durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationMs: convertToMs(3, 'months'), durationValue: 3, durationUnit: 'months' },
  ];
  const config = { guildId: 'guild-1', stages, enabled: true };

  // View Embed
  const viewEmbed = buildProgressionViewEmbed(guild, config);
  assert.ok(viewEmbed.data.description.includes('Stage 1'));
  assert.ok(viewEmbed.data.description.includes('Stage 2'));

  // Member Check Embed
  const joinTs = Date.now() - convertToMs(1, 'month');
  const targetMember = {
    id: 'user-target-1',
    user: { tag: 'GamerGuy#1234', displayName: 'GamerGuy', displayAvatarURL: () => 'https://example.com/avatar.png' },
    guild,
    joinedTimestamp: joinTs,
  };
  const checkEmbed = buildMemberProgressionCheckEmbed(targetMember, config, joinTs);
  assert.ok(checkEmbed.data.fields.some((f) => f.name.includes('Server Join Date')));
  assert.ok(checkEmbed.data.fields.some((f) => f.name.includes('Current Stage')));
  assert.ok(checkEmbed.data.fields.some((f) => f.name.includes('Next Progression Milestone')));
});

test('8. Command Routing (.role period, view, check, remove)', async () => {
  const guild = {
    id: 'guild-routing-test',
    name: 'Test Guild',
    ownerId: 'owner-1',
    roles: { cache: new Map() },
    members: {
      me: {
        permissions: { has: () => true },
        roles: { highest: { position: 10 } },
      },
    },
  };
  const adminMember = {
    id: 'owner-1',
    guild,
    permissions: { has: () => true },
  };

  let repliedPayload = null;
  const replyFn = (p) => { repliedPayload = p; return Promise.resolve(p); };

  // 1. .role period view
  await handleRolePeriodCommand(guild, adminMember, null, ['view'], replyFn, null);
  assert.ok(repliedPayload?.embeds?.[0]);

  // 2. .role period check @user
  await handleRolePeriodCommand(guild, adminMember, null, ['check'], replyFn, null);
  assert.ok(repliedPayload?.embeds?.[0]);

  // 3. .role period (opens setup panel)
  await handleRolePeriodCommand(guild, adminMember, null, [], replyFn, null);
  assert.ok(repliedPayload?.embeds?.[0]);
  assert.strictEqual(repliedPayload?.components?.length, 2);

  // 4. .role period remove (prompts confirmation)
  // First set cache so remove sees something
  rolePeriodConfigCache.set('guild-routing-test', {
    guildId: 'guild-routing-test',
    stages: [{ stageNumber: 1, roleId: 'r1', durationMs: 0 }],
    enabled: true,
  });
  await handleRolePeriodCommand(guild, adminMember, null, ['remove'], replyFn, null);
  assert.ok(repliedPayload?.embeds?.[0]?.data?.title?.includes('Remove Role Progression Configuration'));
});

test('9. Interaction Workflow (Cancel, Save, Confirm Remove All)', async () => {
  const sessionId = 'test-interact-session';
  rolePeriodSessions.set(sessionId, {
    sessionId,
    guildId: 'guild-interact-test',
    userId: 'user-interact-admin',
    stages: [
      { stageNumber: 1, roleId: 'role-stage-1', roleName: 'Stage 1 Role', durationMs: 0, durationValue: 0, durationUnit: 'days' },
    ],
  });

  let updatedPayload = null;
  const fakeInteraction = {
    customId: `${ROLE_PERIOD_PREFIX}save:${sessionId}`,
    user: { id: 'user-interact-admin' },
    guild: { id: 'guild-interact-test', name: 'Interact Guild' },
    update: async (p) => { updatedPayload = p; return p; },
    reply: async (p) => { updatedPayload = p; return p; },
  };

  const client = { guilds: { cache: new Map() } };
  const handled = await handleRolePeriodInteraction(fakeInteraction, client);
  assert.strictEqual(handled, true);
  assert.ok(updatedPayload?.embeds?.[0]?.data?.title?.includes('Role Progression System Saved'));

  // Ensure config was saved in memory cache
  const cached = rolePeriodConfigCache.get('guild-interact-test');
  assert.ok(cached);
  assert.strictEqual(cached.stages.length, 1);

  // Test confirm_remove_all
  const rmSessionId = 'rm-session-test';
  rolePeriodSessions.set(rmSessionId, {
    sessionId: rmSessionId,
    guildId: 'guild-interact-test',
    userId: 'user-interact-admin',
  });
  const fakeRmInteraction = {
    customId: `${ROLE_PERIOD_PREFIX}confirm_remove_all:${rmSessionId}`,
    user: { id: 'user-interact-admin' },
    guild: { id: 'guild-interact-test', name: 'Interact Guild' },
    update: async (p) => { updatedPayload = p; return p; },
  };
  await handleRolePeriodInteraction(fakeRmInteraction, client);
  assert.ok(updatedPayload?.content?.includes('completely removed'));
  assert.strictEqual(rolePeriodConfigCache.has('guild-interact-test'), false);
});

test('10. Empty Progression Setup & Custom Role Progression Lifecycle (No Hardcoded/Preloaded Roles)', async () => {
  const guild = {
    id: 'guild-empty-custom-test',
    name: 'Custom Progression Guild',
    roles: {
      cache: new Map([
        ['role-bronze', { id: 'role-bronze', name: 'Bronze Member', position: 2, managed: false }],
        ['role-silver', { id: 'role-silver', name: 'Silver Member', position: 3, managed: false }],
        ['role-gold', { id: 'role-gold', name: 'Gold Member', position: 4, managed: false }],
        ['role-admin', { id: 'role-admin', name: 'Administrator', position: 10, managed: false }],
      ]),
    },
    members: { me: { roles: { highest: { position: 8 } } } },
  };

  // 1. Initial setup session starts completely EMPTY (0 stages)
  const emptySession = {
    sessionId: 'session-empty-test',
    guildId: guild.id,
    userId: 'admin-custom-user',
    stages: [],
  };

  const emptyPanel = buildSetupPanelPayload(emptySession, guild);
  const embed = emptyPanel.embeds[0];

  // Verify setup panel shows Configured Stages (0) and no hardcoded default roles
  assert.ok(embed.data.fields.some((f) => f.name.includes('Configured Stages (0)')));
  assert.ok(embed.data.fields.some((f) => f.value.includes('No progression stages configured yet')));
  assert.ok(!embed.data.fields.some((f) => f.value.includes('Newbie')));
  assert.ok(!embed.data.fields.some((f) => f.value.includes('Regular')));
  assert.ok(!embed.data.fields.some((f) => f.value.includes('Veteran')));
  assert.ok(!embed.data.fields.some((f) => f.value.includes('OG Member')));

  // Verify Action Buttons: Edit, Remove, Sync, Save are disabled when empty
  const row1Buttons = emptyPanel.components[0].components;
  const row2Buttons = emptyPanel.components[1].components;

  const addBtn = row1Buttons.find((b) => b.data.custom_id.includes('add_stage'));
  const editBtn = row1Buttons.find((b) => b.data.custom_id.includes('edit_stage'));
  const removeBtn = row1Buttons.find((b) => b.data.custom_id.includes('remove_stage'));
  const syncBtn = row2Buttons.find((b) => b.data.custom_id.includes('sync_prompt'));
  const saveBtn = row2Buttons.find((b) => b.data.custom_id.includes('save'));

  assert.strictEqual(addBtn.data.disabled, false, 'Add Stage must be enabled');
  assert.strictEqual(editBtn.data.disabled, true, 'Edit Stage must be disabled when empty');
  assert.strictEqual(removeBtn.data.disabled, true, 'Remove Stage must be disabled when empty');
  assert.strictEqual(syncBtn.data.disabled, true, 'Sync must be disabled when empty');
  assert.strictEqual(saveBtn.data.disabled, true, 'Save must be disabled when empty');

  // 2. Admin manually selects server roles from existing roles dropdown
  const assignableRoles = getAssignableProgressionRoles(guild);
  assert.strictEqual(assignableRoles.length, 3, 'Returns 3 assignable roles below bot (excludes role-admin)');
  assert.ok(assignableRoles.some((r) => r.id === 'role-bronze'));
  assert.ok(assignableRoles.some((r) => r.id === 'role-silver'));
  assert.ok(assignableRoles.some((r) => r.id === 'role-gold'));

  // 3. Admin adds Stage 1: Bronze Member (0 days - immediate)
  emptySession.stages.push({
    stageNumber: 1,
    roleId: 'role-bronze',
    roleName: 'Bronze Member',
    durationValue: 0,
    durationUnit: 'days',
    durationMs: 0,
  });

  // 4. Admin adds Stage 2: Silver Member (30 days)
  emptySession.stages.push({
    stageNumber: 2,
    roleId: 'role-silver',
    roleName: 'Silver Member',
    durationValue: 30,
    durationUnit: 'days',
    durationMs: convertToMs(30, 'days'),
  });

  // 5. Admin adds Stage 3: Gold Member (6 months)
  emptySession.stages.push({
    stageNumber: 3,
    roleId: 'role-gold',
    roleName: 'Gold Member',
    durationValue: 6,
    durationUnit: 'months',
    durationMs: convertToMs(6, 'months'),
  });

  const populatedPanel = buildSetupPanelPayload(emptySession, guild);
  assert.ok(populatedPanel.embeds[0].data.fields.some((f) => f.name.includes('Configured Stages (3)')));
  assert.ok(populatedPanel.embeds[0].data.fields.some((f) => f.value.includes('role-bronze')));
  assert.ok(populatedPanel.embeds[0].data.fields.some((f) => f.value.includes('role-silver')));
  assert.ok(populatedPanel.embeds[0].data.fields.some((f) => f.value.includes('role-gold')));

  // 6. When NO stages are configured, processMemberProgression must NOT assign any roles
  const emptyConfig = { guildId: guild.id, stages: [], enabled: false };
  const testMember = {
    id: 'test-mem-empty',
    guild,
    joinedTimestamp: Date.now() - 365 * 24 * 60 * 60 * 1000,
    roles: { cache: new Map(), add: async () => assert.fail('Should not assign role when stages empty') },
  };
  const emptyResult = await processMemberProgression(testMember, emptyConfig);
  assert.strictEqual(emptyResult.changed, false);
  assert.strictEqual(emptyResult.assignedRole, null);
  assert.deepStrictEqual(emptyResult.removedRoles, []);
});
