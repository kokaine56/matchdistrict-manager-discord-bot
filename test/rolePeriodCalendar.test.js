import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMilestoneDate,
  evaluateMemberStageCalendar,
  formatDurationText,
  formatTimeRemaining,
  auditIncorrectRoleAssignments,
  executeProgressionSyncAndReconfigure,
  handleRolePeriodInteraction,
  rolePeriodSessions,
  ROLE_PERIOD_PREFIX,
  processMemberProgression,
  getMemberEffectiveJoinTimestamp,
  getDiscordMemberJoinTimestamp,
  formatMembershipDuration,
  recordMemberJoinTimestamp,
  buildMemberProgressionCheckEmbed,
} from '../rolePeriodService.js';

test('1. Calendar-based Milestone Calculation (Leap year and month-end dates)', () => {
  // Base join date: Jan 17, 2024 (Leap year) at 12:00:00 UTC
  const joinDate = new Date(Date.UTC(2024, 0, 17, 12, 0, 0)); // 2024-01-17

  // Stage 1: Immediately (0 days)
  const ms0 = calculateMilestoneDate(joinDate.getTime(), 0, 'days');
  assert.strictEqual(ms0.toISOString(), joinDate.toISOString());

  // Stage 2: 15 days -> Feb 1, 2024 (Jan has 31 days: 17 + 15 = 32 -> Feb 1)
  const ms15d = calculateMilestoneDate(joinDate.getTime(), 15, 'days');
  const expected15d = new Date(Date.UTC(2024, 1, 1, 12, 0, 0));
  assert.strictEqual(ms15d.toISOString(), expected15d.toISOString());

  // Stage 3: 3 calendar months -> April 17, 2024
  const ms3m = calculateMilestoneDate(joinDate.getTime(), 3, 'months');
  const expected3m = new Date(Date.UTC(2024, 3, 17, 12, 0, 0));
  assert.strictEqual(ms3m.toISOString(), expected3m.toISOString());

  // Stage 4: 6 calendar months -> July 17, 2024
  const ms6m = calculateMilestoneDate(joinDate.getTime(), 6, 'months');
  const expected6m = new Date(Date.UTC(2024, 6, 17, 12, 0, 0));
  assert.strictEqual(ms6m.toISOString(), expected6m.toISOString());

  // Month-end test: Jan 31 -> 1 month -> Feb 29 (in 2024 leap year)
  const jan31Leap = new Date(Date.UTC(2024, 0, 31, 12, 0, 0));
  const febLeap = calculateMilestoneDate(jan31Leap.getTime(), 1, 'months');
  assert.strictEqual(febLeap.getUTCFullYear(), 2024);
  assert.strictEqual(febLeap.getUTCMonth(), 1); // February
  assert.strictEqual(febLeap.getUTCDate(), 29); // 29th in leap year

  // Month-end test: Jan 31 -> 1 month -> Feb 28 (in 2023 non-leap year)
  const jan31NonLeap = new Date(Date.UTC(2023, 0, 31, 12, 0, 0));
  const febNonLeap = calculateMilestoneDate(jan31NonLeap.getTime(), 1, 'months');
  assert.strictEqual(febNonLeap.getUTCFullYear(), 2023);
  assert.strictEqual(febNonLeap.getUTCMonth(), 1); // February
  assert.strictEqual(febNonLeap.getUTCDate(), 28); // 28th in non-leap year

  // Month-end test: Aug 31 -> 1 month -> Sept 30
  const aug31 = new Date(Date.UTC(2024, 7, 31, 12, 0, 0));
  const sept = calculateMilestoneDate(aug31.getTime(), 1, 'months');
  assert.strictEqual(sept.getUTCMonth(), 8); // September
  assert.strictEqual(sept.getUTCDate(), 30);
});

test('2. Required Test Cases Matrix (5d, 14d, 15d, 2mo, 3mo, 5mo, 6mo)', () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];

  // Base join date: Jan 17, 2024 at 00:00:00 UTC
  const joinTs = Date.UTC(2024, 0, 17, 0, 0, 0);

  // Helper to check role at reference date
  function getExpectedRole(checkDate) {
    const { currentStage } = evaluateMemberStageCalendar(stages, joinTs, checkDate.getTime());
    return currentStage ? currentStage.roleName : null;
  }

  // Case 1: 5 days (Jan 22, 2024) -> Newbie
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 0, 22, 0, 0, 0))), 'Newbie');

  // Case 2: 14 days (Jan 31, 2024) -> Newbie
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 0, 31, 0, 0, 0))), 'Newbie');

  // Case 3: 15 days (Feb 1, 2024) -> Regular
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 1, 1, 0, 0, 0))), 'Regular');

  // Case 4: 2 months (March 17, 2024) -> Regular
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 2, 17, 0, 0, 0))), 'Regular');

  // Case 5: 3 months (April 17, 2024) -> Veteran
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 3, 17, 0, 0, 0))), 'Veteran');

  // Case 6: 5 months (June 17, 2024) -> Veteran
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 5, 17, 0, 0, 0))), 'Veteran');

  // Case 7: 6 months (July 17, 2024) -> OG Member
  assert.strictEqual(getExpectedRole(new Date(Date.UTC(2024, 6, 17, 0, 0, 0))), 'OG Member');

  // Negative edge test: 1 second before 6 months -> Veteran (NEVER prematurely OG Member!)
  const oneSecondBefore6Mo = new Date(Date.UTC(2024, 6, 17, 0, 0, 0) - 1000);
  assert.strictEqual(getExpectedRole(oneSecondBefore6Mo), 'Veteran');
});

test('3. Diagnostic Audit Check for Premature Progression Roles', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  // Member 1 joined 10 days ago, but erroneously holds 'role-og' (premature!)
  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  // Member 2 joined 7 months ago and holds 'role-og' (legitimate!)
  const sevenMonthsAgo = Date.now() - 7 * 30 * 24 * 60 * 60 * 1000;

  const fakeGuild = {
    id: 'test-guild-audit',
    members: {
      cache: new Map([
        ['user-premature', {
          id: 'user-premature',
          user: { tag: 'Speedy#1111', bot: false },
          joinedTimestamp: tenDaysAgo,
          roles: {
            cache: new Map([
              ['role-og', { id: 'role-og', name: 'OG Member' }],
            ]),
          },
        }],
        ['user-legit', {
          id: 'user-legit',
          user: { tag: 'OldTimer#2222', bot: false },
          joinedTimestamp: sevenMonthsAgo,
          roles: {
            cache: new Map([
              ['role-og', { id: 'role-og', name: 'OG Member' }],
            ]),
          },
        }],
      ]),
    },
  };

  const discrepancies = await auditIncorrectRoleAssignments(fakeGuild, config);
  assert.strictEqual(discrepancies.length, 1);
  assert.strictEqual(discrepancies[0].memberId, 'user-premature');
  assert.strictEqual(discrepancies[0].heldRoleName, 'OG Member');
  assert.strictEqual(discrepancies[0].expectedRoleName, 'Newbie');
});

test('4. executeProgressionSyncAndReconfigure (Full recalculation & summary statistics)', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  // Member A: Joined 10 days ago, has Newbie -> already correct
  const mATs = Date.now() - 10 * 24 * 60 * 60 * 1000;
  // Member B: Joined 20 days ago, has Newbie -> needs upgrade to Regular
  const mBTs = Date.now() - 20 * 24 * 60 * 60 * 1000;
  // Member C: Joined 10 days ago, but erroneously holds OG Member -> needs downgrade to Newbie
  const mCTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
  // Member D: Joined 7 months ago, has OG Member -> already correct
  const mDTs = Date.now() - 7 * 30 * 24 * 60 * 60 * 1000;

  const membersMap = new Map([
    ['user-a', {
      id: 'user-a',
      guild: null,
      joinedTimestamp: mATs,
      roles: { cache: new Map([['role-newbie', { id: 'role-newbie' }]]), add: async () => {}, remove: async () => {} },
    }],
    ['user-b', {
      id: 'user-b',
      guild: null,
      joinedTimestamp: mBTs,
      roles: { cache: new Map([['role-newbie', { id: 'role-newbie' }]]), add: async () => {}, remove: async () => {} },
    }],
    ['user-c', {
      id: 'user-c',
      guild: null,
      joinedTimestamp: mCTs,
      roles: { cache: new Map([['role-og', { id: 'role-og' }]]), add: async () => {}, remove: async () => {} },
    }],
    ['user-d', {
      id: 'user-d',
      guild: null,
      joinedTimestamp: mDTs,
      roles: { cache: new Map([['role-og', { id: 'role-og' }]]), add: async () => {}, remove: async () => {} },
    }],
    ['user-bot', {
      id: 'user-bot',
      guild: null,
      user: { bot: true },
      roles: { cache: new Map() },
    }],
  ]);

  const fakeGuild = {
    id: 'test-guild-sync-run',
    members: {
      cache: membersMap,
      fetch: async () => membersMap,
    },
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
        ['role-veteran', { id: 'role-veteran', name: 'Veteran' }],
        ['role-og', { id: 'role-og', name: 'OG Member' }],
      ]),
    },
  };

  for (const m of membersMap.values()) {
    m.guild = fakeGuild;
  }

  const stats = await executeProgressionSyncAndReconfigure(fakeGuild, config);

  assert.strictEqual(stats.totalMembers, 4, 'Excluded bot, checked 4 members');
  assert.strictEqual(stats.rolesCorrected, 2, '2 members corrected (user-b and user-c)');
  assert.strictEqual(stats.alreadyCorrect, 2, '2 members already correct (user-a and user-d)');
  assert.strictEqual(stats.rolesRemoved, 2, '2 outdated/premature roles removed');
  assert.strictEqual(stats.rolesAssigned, 2, '2 correct roles assigned');
  assert.strictEqual(stats.errors, 0, '0 errors');
});

test('5. Sync & Reconfigure Interaction Flow (Prompt, Confirm, Return)', async () => {
  const sessionId = 'test-sync-interaction';
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
  ];
  rolePeriodSessions.set(sessionId, {
    sessionId,
    guildId: 'test-sync-guild',
    userId: 'admin-sync-user',
    stages,
  });

  let repliedPayload = null;
  let updatedPayload = null;

  const fakeGuild = {
    id: 'test-sync-guild',
    name: 'Sync Test Guild',
    members: {
      cache: new Map(),
      fetch: async () => new Map(),
    },
    roles: { cache: new Map() },
  };

  const client = { guilds: { cache: new Map([['test-sync-guild', fakeGuild]]) } };

  // Step 1: Prompt Sync
  const promptInteraction = {
    customId: `${ROLE_PERIOD_PREFIX}sync_prompt:${sessionId}`,
    user: { id: 'admin-sync-user' },
    guild: fakeGuild,
    update: async (p) => { updatedPayload = p; return p; },
    reply: async (p) => { repliedPayload = p; return p; },
  };

  const handledPrompt = await handleRolePeriodInteraction(promptInteraction, client);
  assert.strictEqual(handledPrompt, true);
  assert.ok(updatedPayload?.embeds?.[0]?.data?.title?.includes('Confirm Synchronization'));
  assert.ok(updatedPayload?.components?.[0]?.components?.some((c) => c.data.custom_id.includes('sync_confirm')));

  // Step 2: Confirm Sync
  let messageEditPayload = null;
  const confirmInteraction = {
    customId: `${ROLE_PERIOD_PREFIX}sync_confirm:${sessionId}`,
    user: { id: 'admin-sync-user' },
    guild: fakeGuild,
    message: { edit: async (p) => { messageEditPayload = p; return p; } },
    update: async (p) => { updatedPayload = p; return p; },
    reply: async (p) => { repliedPayload = p; return p; },
  };

  const handledConfirm = await handleRolePeriodInteraction(confirmInteraction, client);
  assert.strictEqual(handledConfirm, true);
  assert.ok(messageEditPayload?.embeds?.[0]?.data?.title?.includes('Synchronization Complete'));
  assert.ok(messageEditPayload?.components?.[0]?.components?.some((c) => c.data.custom_id.includes('back_to_setup')));
});

test('6. Server Join Date vs Account Creation Date: Never grants premature roles based on old Discord accounts', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  // Member created their Discord account 4 years ago, but joined this server only 5 days ago!
  const accountCreatedTs = Date.now() - 4 * 365 * 24 * 60 * 60 * 1000;
  const serverJoinedTs = Date.now() - 5 * 24 * 60 * 60 * 1000;

  let assignedRole = null;
  const removedRoles = [];

  const fakeGuild = {
    id: 'test-guild-account-age',
    name: 'New Server',
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
        ['role-veteran', { id: 'role-veteran', name: 'Veteran' }],
        ['role-og', { id: 'role-og', name: 'OG Member' }],
      ]),
    },
  };

  const member = {
    id: 'veteran-discord-user',
    user: {
      tag: 'OldAccount#9999',
      bot: false,
      createdTimestamp: accountCreatedTs,
      createdAt: new Date(accountCreatedTs),
    },
    guild: fakeGuild,
    joinedTimestamp: serverJoinedTs,
    joinedAt: new Date(serverJoinedTs),
    roles: {
      cache: new Map(),
      add: async (rId) => { assignedRole = rId; },
      remove: async (rId) => { removedRoles.push(rId); },
    },
  };

  // 1. Effective join timestamp MUST match serverJoinedTs, NOT accountCreatedTs
  const effectiveJoin = await getMemberEffectiveJoinTimestamp(fakeGuild.id, member.id, member);
  assert.strictEqual(effectiveJoin, serverJoinedTs, 'Must use server join timestamp');
  assert.notStrictEqual(effectiveJoin, accountCreatedTs, 'Must NEVER use account creation timestamp');

  // 2. Process progression: member must receive Newbie (Stage 1), NOT OG Member (Stage 4)
  const result = await processMemberProgression(member, config);
  assert.strictEqual(result.assignedRole, 'role-newbie', 'Must only assign Newbie role');
  assert.notStrictEqual(result.assignedRole, 'role-og', 'Must NEVER assign OG Member to 5-day old server member');
  assert.notStrictEqual(result.assignedRole, 'role-veteran', 'Must NEVER assign Veteran');

  // 3. Diagnostic metadata must clearly report account creation vs server join
  assert.ok(result.diagnostic);
  assert.strictEqual(result.diagnostic.memberId, 'veteran-discord-user');
  assert.strictEqual(result.diagnostic.accountCreatedDate, new Date(accountCreatedTs).toISOString());
  assert.strictEqual(result.diagnostic.serverJoinDate, new Date(serverJoinedTs).toISOString());
  assert.strictEqual(result.diagnostic.eligibleRole, 'Newbie');
});

test('7. Stale/Corrupted MongoDB Timestamp Overwrite & Premature Role Removal', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  // Member joined 10 days ago, but somehow held premature OG Member and unrelated VIP role
  const realServerJoin = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const removedRoles = [];
  let addedRole = null;

  const fakeGuild = {
    id: 'test-guild-sync-fix',
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
        ['role-veteran', { id: 'role-veteran', name: 'Veteran' }],
        ['role-og', { id: 'role-og', name: 'OG Member' }],
        ['role-vip', { id: 'role-vip', name: 'VIP Supporter' }],
      ]),
    },
  };

  const memberWithPrematureOg = {
    id: 'user-with-premature-og',
    guild: fakeGuild,
    user: {
      tag: 'LuckyGuy#0001',
      bot: false,
      createdTimestamp: Date.now() - 500 * 24 * 60 * 60 * 1000,
    },
    joinedTimestamp: realServerJoin,
    roles: {
      cache: new Map([
        ['role-og', { id: 'role-og', name: 'OG Member' }],
        ['role-vip', { id: 'role-vip', name: 'VIP Supporter' }],
      ]),
      add: async (rId) => { addedRole = rId; },
      remove: async (rId) => { removedRoles.push(rId); },
    },
  };

  fakeGuild.members = {
    cache: new Map([[memberWithPrematureOg.id, memberWithPrematureOg]]),
    fetch: async () => fakeGuild.members.cache,
  };

  const syncStats = await executeProgressionSyncAndReconfigure(fakeGuild, config);

  assert.strictEqual(syncStats.totalMembers, 1);
  assert.strictEqual(syncStats.rolesCorrected, 1);
  assert.strictEqual(syncStats.rolesRemoved, 1);
  assert.strictEqual(syncStats.rolesAssigned, 1);

  // Premature OG Member must be removed
  assert.ok(removedRoles.includes('role-og'), 'Must remove premature OG Member role');

  // Unrelated VIP role must NEVER be removed
  assert.ok(!removedRoles.includes('role-vip'), 'Must NEVER remove unrelated roles (e.g. VIP)');

  // Correct eligible role (Newbie) must be assigned
  assert.strictEqual(addedRole, 'role-newbie', 'Must assign eligible role (Newbie)');
});

test('8. Diagnostic Logging and Validation Guard blocks premature assignment', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
  ];
  const config = { stages, enabled: true };

  // Base join date: exactly 10 days ago (requires 15 days for Regular)
  const joinTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Calendar evaluation must indicate stage 1 (Newbie), next stage Regular
  const evalRes = evaluateMemberStageCalendar(stages, joinTs, now);
  assert.strictEqual(evalRes.currentStage.roleName, 'Newbie');
  assert.strictEqual(evalRes.nextStage.roleName, 'Regular');

  // Verification that targetMember embed includes Server Join Date & Account Created
  const dummyMember = {
    id: 'user-check-1',
    displayName: 'UserCheck',
    joinedTimestamp: joinTs,
    user: {
      tag: 'UserCheck#1234',
      createdTimestamp: Date.now() - 100 * 24 * 60 * 60 * 1000,
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    },
    guild: {
      roles: {
        cache: new Map([
          ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
          ['role-regular', { id: 'role-regular', name: 'Regular' }],
        ]),
      },
    },
  };

  const embed = buildMemberProgressionCheckEmbed(dummyMember, config, joinTs);
  assert.ok(embed.data.fields.some((f) => f.name.includes('Server Join Date')));
  assert.ok(embed.data.fields.some((f) => f.name.includes('Account Created')));
  assert.ok(embed.data.fields.some((f) => f.name.includes('Current Stage')));
});

test('9. Required Verification Matrix: 5 Specific Test Cases from User Specification', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  // Reference test timestamp (July 17, 2024 at 12:00:00 UTC)
  const refNow = new Date(Date.UTC(2024, 6, 17, 12, 0, 0)).getTime();

  // Test Case Matrix from User Prompt:
  // Case 1: Account age: 5 years | Server membership: 2 days  -> Expected: Newbie
  // Case 2: Account age: 3 years | Server membership: 15 days -> Expected: Regular
  // Case 3: Account age: 1 day   | Server membership: 3 months -> Expected: Veteran
  // Case 4: Account age: 2 days  | Server membership: 6 months -> Expected: OG Member
  // Case 5: Account age: 4 years | Server membership: 10 days -> Expected: Newbie

  const testMatrix = [
    {
      caseName: 'Case 1: 5 yr account age, 2 days server membership',
      accountAgeMs: 5 * 365 * 24 * 60 * 60 * 1000,
      serverJoinMs: refNow - 2 * 24 * 60 * 60 * 1000,
      expectedRoleName: 'Newbie',
      expectedRoleId: 'role-newbie',
    },
    {
      caseName: 'Case 2: 3 yr account age, 15 days server membership',
      accountAgeMs: 3 * 365 * 24 * 60 * 60 * 1000,
      serverJoinMs: refNow - 15 * 24 * 60 * 60 * 1000,
      expectedRoleName: 'Regular',
      expectedRoleId: 'role-regular',
    },
    {
      caseName: 'Case 3: 1 day account age, 3 months server membership',
      accountAgeMs: 1 * 24 * 60 * 60 * 1000,
      // 3 calendar months before July 17, 2024 is April 17, 2024
      serverJoinMs: new Date(Date.UTC(2024, 3, 17, 12, 0, 0)).getTime(),
      expectedRoleName: 'Veteran',
      expectedRoleId: 'role-veteran',
    },
    {
      caseName: 'Case 4: 2 days account age, 6 months server membership',
      accountAgeMs: 2 * 24 * 60 * 60 * 1000,
      // 6 calendar months before July 17, 2024 is January 17, 2024
      serverJoinMs: new Date(Date.UTC(2024, 0, 17, 12, 0, 0)).getTime(),
      expectedRoleName: 'OG Member',
      expectedRoleId: 'role-og',
    },
    {
      caseName: 'Case 5: 4 yr account age, 10 days server membership',
      accountAgeMs: 4 * 365 * 24 * 60 * 60 * 1000,
      serverJoinMs: refNow - 10 * 24 * 60 * 60 * 1000,
      expectedRoleName: 'Newbie',
      expectedRoleId: 'role-newbie',
    },
  ];

  const fakeGuild = {
    id: 'guild-matrix-test',
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
        ['role-veteran', { id: 'role-veteran', name: 'Veteran' }],
        ['role-og', { id: 'role-og', name: 'OG Member' }],
      ]),
    },
  };

  for (const c of testMatrix) {
    let addedRole = null;
    const removedRoles = [];

    const member = {
      id: `member-${c.caseName.replace(/\s+/g, '-')}`,
      user: {
        tag: `User-${c.expectedRoleName}`,
        bot: false,
        createdTimestamp: refNow - c.accountAgeMs,
        createdAt: new Date(refNow - c.accountAgeMs),
      },
      guild: fakeGuild,
      joinedTimestamp: c.serverJoinMs,
      joinedAt: new Date(c.serverJoinMs),
      roles: {
        cache: new Map(),
        add: async (rId) => { addedRole = rId; },
        remove: async (rId) => { removedRoles.push(rId); },
      },
    };

    // 1. Authoritative Discord Guild Member join timestamp check
    const joinTs = getDiscordMemberJoinTimestamp(member);
    assert.strictEqual(joinTs, c.serverJoinMs, `${c.caseName}: must match serverJoinMs`);

    // 2. Process Member Progression with options.now = refNow
    const result = await processMemberProgression(member, config, { now: refNow });

    assert.strictEqual(
      result.assignedRole,
      c.expectedRoleId,
      `${c.caseName}: Expected role [${c.expectedRoleName}] (${c.expectedRoleId}), got [${result.assignedRole}]`
    );

    // 3. Verify diagnostic log metadata was constructed properly
    assert.ok(result.diagnostic, `${c.caseName}: must include diagnostic payload`);
    assert.strictEqual(result.diagnostic.eligibleRole, c.expectedRoleName);
    assert.ok(result.diagnostic.actionTaken.includes(c.expectedRoleName));
  }
});

test('10. Unverified Server Join Date Safeguard (Missing or Invalid Discord Join Timestamp)', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
  ];
  const config = { stages, enabled: true };

  const fakeGuild = {
    id: 'guild-unverified-test',
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
      ]),
    },
  };

  // Member with missing joinedTimestamp and missing joinedAt (cannot be verified)
  const unverifiedMember = {
    id: 'unverified-member-1',
    user: {
      tag: 'Ghost#0000',
      bot: false,
      createdTimestamp: Date.now() - 5 * 365 * 24 * 60 * 60 * 1000, // 5 yr account age
    },
    guild: fakeGuild,
    joinedTimestamp: null,
    joinedAt: null,
    roles: {
      cache: new Map(),
      add: async () => { assert.fail('Should never assign role to unverified member'); },
      remove: async () => {},
    },
  };

  // 1. getDiscordMemberJoinTimestamp must return null
  const joinTs = getDiscordMemberJoinTimestamp(unverifiedMember);
  assert.strictEqual(joinTs, null, 'Must return null when Discord join date is missing');

  // 2. processMemberProgression must refuse progression and return error
  const result = await processMemberProgression(unverifiedMember, config);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.error, true);
  assert.strictEqual(result.reason, 'UNVERIFIED_SERVER_JOIN_DATE');
  assert.strictEqual(result.assignedRole, null);
});

test('11. Full Server Synchronization: Corrects Premature Roles and Preserves Unrelated Roles', async () => {
  const stages = [
    { stageNumber: 1, roleId: 'role-newbie', roleName: 'Newbie', durationValue: 0, durationUnit: 'days' },
    { stageNumber: 2, roleId: 'role-regular', roleName: 'Regular', durationValue: 15, durationUnit: 'days' },
    { stageNumber: 3, roleId: 'role-veteran', roleName: 'Veteran', durationValue: 3, durationUnit: 'months' },
    { stageNumber: 4, roleId: 'role-og', roleName: 'OG Member', durationValue: 6, durationUnit: 'months' },
  ];
  const config = { stages, enabled: true };

  const now = Date.now();
  // Member 1: Joined 2 days ago (Account 5 yrs) -> Should get Newbie
  const m1Join = now - 2 * 24 * 60 * 60 * 1000;
  // Member 2: Joined 16 days ago (Account 3 yrs) -> Should get Regular
  const m2Join = now - 16 * 24 * 60 * 60 * 1000;
  // Member 3: Joined 3 days ago, but erroneously holds OG Member + unrelated 'role-mod' -> Should lose OG Member, gain Newbie, keep 'role-mod'
  const m3Join = now - 3 * 24 * 60 * 60 * 1000;
  // Member 4: Missing join date -> Skipped
  // Member 5: Bot account -> Skipped

  const member3Removed = [];
  let member3Added = null;

  const fakeGuild = {
    id: 'guild-full-sync-test',
    name: 'Match District Esports',
    roles: {
      cache: new Map([
        ['role-newbie', { id: 'role-newbie', name: 'Newbie' }],
        ['role-regular', { id: 'role-regular', name: 'Regular' }],
        ['role-veteran', { id: 'role-veteran', name: 'Veteran' }],
        ['role-og', { id: 'role-og', name: 'OG Member' }],
        ['role-mod', { id: 'role-mod', name: 'Moderator' }],
      ]),
    },
    members: {
      cache: new Map(),
      fetch: async () => fakeGuild.members.cache,
    },
  };

  const members = [
    {
      id: 'm1',
      guild: fakeGuild,
      user: { tag: 'User1', bot: false, createdTimestamp: now - 5 * 365 * 24 * 60 * 60 * 1000 },
      joinedTimestamp: m1Join,
      joinedAt: new Date(m1Join),
      roles: { cache: new Map(), add: async () => {}, remove: async () => {} },
    },
    {
      id: 'm2',
      guild: fakeGuild,
      user: { tag: 'User2', bot: false, createdTimestamp: now - 3 * 365 * 24 * 60 * 60 * 1000 },
      joinedTimestamp: m2Join,
      joinedAt: new Date(m2Join),
      roles: { cache: new Map([['role-newbie', { id: 'role-newbie', name: 'Newbie' }]]), add: async () => {}, remove: async () => {} },
    },
    {
      id: 'm3-premature',
      guild: fakeGuild,
      user: { tag: 'User3', bot: false, createdTimestamp: now - 4 * 365 * 24 * 60 * 60 * 1000 },
      joinedTimestamp: m3Join,
      joinedAt: new Date(m3Join),
      roles: {
        cache: new Map([
          ['role-og', { id: 'role-og', name: 'OG Member' }],
          ['role-mod', { id: 'role-mod', name: 'Moderator' }],
        ]),
        add: async (rId) => { member3Added = rId; },
        remove: async (rId) => { member3Removed.push(rId); },
      },
    },
    {
      id: 'm4-unverified',
      guild: fakeGuild,
      user: { tag: 'User4', bot: false, createdTimestamp: now - 100 * 24 * 60 * 60 * 1000 },
      joinedTimestamp: null,
      joinedAt: null,
      roles: { cache: new Map(), add: async () => {}, remove: async () => {} },
    },
    {
      id: 'bot-1',
      guild: fakeGuild,
      user: { tag: 'Bot1', bot: true },
      roles: { cache: new Map() },
    },
  ];

  for (const m of members) {
    fakeGuild.members.cache.set(m.id, m);
  }

  const stats = await executeProgressionSyncAndReconfigure(fakeGuild, config);

  assert.strictEqual(stats.totalMembers, 4, 'Excluded bot member');
  assert.strictEqual(stats.skippedUnverified, 1, 'Skipped m4 with missing join date');
  assert.strictEqual(stats.errors, 1, '1 error from skipped unverified member');
  assert.strictEqual(stats.rolesCorrected, 3, 'Roles corrected for m1 (assigned newbie), m2 (upgraded regular), m3 (downgraded newbie)');

  // Member 3 checks:
  assert.ok(member3Removed.includes('role-og'), 'Premature OG Member removed from 3-day server member');
  assert.ok(!member3Removed.includes('role-mod'), 'Unrelated Moderator role was strictly preserved');
  assert.strictEqual(member3Added, 'role-newbie', 'Assigned correct eligible Newbie role to Member 3');
});
