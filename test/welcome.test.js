import test from 'node:test';
import assert from 'node:assert';
import {
  buildDynamicWelcomeMessage,
  resolveDynamicWelcomeMessage,
  resolveActiveInviteEvents,
  resolveOpenTournaments,
  resolveImportantChannels,
} from '../welcomeService.js';
import {
  handleGuildMemberAdd,
  setWelcomeEnabled,
} from '../index.js';
import {
  createInviteCampaign,
  clearInMemoryInviteCampaignData,
  CAMPAIGN_STATUS,
} from '../bot/discord/features/inviteCampaign/models/inviteCampaignModels.js';
import {
  saveConfigurableTournament,
  saveConfigurableRegistration,
  clearInMemoryData as clearTournamentData,
} from '../configurableTournamentData.js';

// Helper to create mock guild
function createMockGuild(overrides = {}) {
  const channelMap = new Map();
  const guild = {
    id: overrides.id || 'guild-test-welcome',
    name: overrides.name || 'MatchDistrict Test Guild',
    rulesChannelId: overrides.rulesChannelId || null,
    channels: {
      cache: channelMap,
      fetch: async (id) => channelMap.get(id) || null,
    },
    ...overrides,
  };

  function addChannel(ch) {
    const fullCh = {
      id: ch.id,
      name: ch.name,
      type: ch.type ?? 0,
      guild,
      ...ch,
    };
    channelMap.set(ch.id, fullCh);
    return fullCh;
  }

  return { guild, channels: channelMap, addChannel };
}

// Helper to create mock member
function createMockMember(overrides = {}) {
  const sentMessages = [];
  const member = {
    id: overrides.id || 'user-test-123',
    displayName: overrides.displayName || 'TestGamer',
    user: {
      id: overrides.id || 'user-test-123',
      username: overrides.username || 'TestGamer',
      tag: overrides.tag || 'TestGamer#1234',
      bot: Boolean(overrides.isBot),
      createdTimestamp: Date.now() - 30 * 86400 * 1000,
    },
    guild: overrides.guild || null,
    send: async (msg) => {
      if (overrides.dmError) {
        throw overrides.dmError;
      }
      sentMessages.push(msg);
      return { id: 'msg-' + Date.now(), content: msg };
    },
    _sentMessages: sentMessages,
    ...overrides,
  };
  return member;
}

test('1. buildDynamicWelcomeMessage: Both active invite event and open tournament', () => {
  const member = createMockMember({ displayName: 'AlphaGamer' });
  const activeEvents = [
    { id: 'camp-1', name: 'Mega Invite Giveaway', channelId: '111111111111111111' },
  ];
  const openTournaments = [
    { id: 'tour-1', name: 'BGIS Community Cup', channelId: '222222222222222222' },
  ];
  const importantChannels = {
    rules: '333333333333333333',
    findTeam: '444444444444444444',
    generalChat: '555555555555555555',
  };

  const message = buildDynamicWelcomeMessage({
    member,
    activeEvents,
    openTournaments,
    importantChannels,
  });

  // Verify structure
  assert.ok(message.includes('WELCOME TO MATCH DISTRICT!'));
  assert.ok(message.includes('Welcome AlphaGamer!'));
  assert.ok(message.includes('Explore our latest activities:'));

  // Invite Event section present
  assert.ok(message.includes('🎁 **Active Invite Event**'));
  assert.ok(message.includes('Join the event: <#111111111111111111>'));
  assert.ok(message.includes('Mega Invite Giveaway'));

  // Tournament Registrations section present
  assert.ok(message.includes('🏆 **Tournament Registrations**'));
  assert.ok(message.includes('Tournament registrations are currently open!'));
  assert.ok(message.includes('Register here: <#222222222222222222>'));
  assert.ok(message.includes('BGIS Community Cup – <#222222222222222222>'));

  // Important Channels present with clickable IDs
  assert.ok(message.includes('Rules: <#333333333333333333>'));
  assert.ok(message.includes('Find a Team: <#444444444444444444>'));
  assert.ok(message.includes('General Chat: <#555555555555555555>'));

  // Footer present
  assert.ok(message.includes('Managed by Match District'));
});

test('2. buildDynamicWelcomeMessage: Active invite event only (omits tournament section)', () => {
  const member = createMockMember({ displayName: 'BetaGamer' });
  const activeEvents = [
    { id: 'camp-2', name: 'Weekend Invite Bash', channelId: '101010101010101010' },
  ];
  const openTournaments = [];
  const importantChannels = {
    rules: '202020202020202020',
    findTeam: '303030303030303030',
    generalChat: '404040404040404040',
  };

  const message = buildDynamicWelcomeMessage({
    member,
    activeEvents,
    openTournaments,
    importantChannels,
  });

  assert.ok(message.includes('🎁 **Active Invite Event**'));
  assert.ok(message.includes('Join the event: <#101010101010101010>'));

  // Tournaments section must NOT be present
  assert.ok(!message.includes('🏆 **Tournament Registrations**'));
  assert.ok(!message.includes('Tournament registrations are currently open!'));
  assert.ok(!message.includes('Register here:'));

  // Important channels and footer present
  assert.ok(message.includes('Rules: <#202020202020202020>'));
  assert.ok(message.includes('Managed by Match District'));
});

test('3. buildDynamicWelcomeMessage: Open tournament only (omits invite event section)', () => {
  const member = createMockMember({ displayName: 'DeltaGamer' });
  const activeEvents = [];
  const openTournaments = [
    { id: 'tour-2', name: 'TDM Championship', channelId: '777777777777777777' },
  ];
  const importantChannels = {
    rules: '888888888888888888',
    findTeam: null,
    generalChat: '999999999999999999',
  };

  const message = buildDynamicWelcomeMessage({
    member,
    activeEvents,
    openTournaments,
    importantChannels,
  });

  // Invite section must NOT be present
  assert.ok(!message.includes('🎁 **Active Invite Event**'));
  assert.ok(!message.includes('Join the event:'));

  // Tournament section must be present
  assert.ok(message.includes('🏆 **Tournament Registrations**'));
  assert.ok(message.includes('Register here: <#777777777777777777>'));
  assert.ok(message.includes('TDM Championship – <#777777777777777777>'));

  // Fallback for missing findTeam channel
  assert.ok(message.includes('Rules: <#888888888888888888>'));
  assert.ok(message.includes('Find a Team: #find-a-team'));
  assert.ok(message.includes('General Chat: <#999999999999999999>'));
});

test('4. buildDynamicWelcomeMessage: Neither active (standard welcome message with channels)', () => {
  const member = createMockMember({ displayName: 'OmegaGamer' });
  const activeEvents = [];
  const openTournaments = [];
  const importantChannels = {
    rules: null,
    findTeam: null,
    generalChat: null,
  };

  const message = buildDynamicWelcomeMessage({
    member,
    activeEvents,
    openTournaments,
    importantChannels,
  });

  // No activities lead-in
  assert.ok(!message.includes('Explore our latest activities:'));
  assert.ok(!message.includes('🎁 **Active Invite Event**'));
  assert.ok(!message.includes('🏆 **Tournament Registrations**'));

  // Standard platform description is included
  assert.ok(message.includes('Match District is an esports platform'));

  // Fallback channels
  assert.ok(message.includes('Rules: #rules'));
  assert.ok(message.includes('Find a Team: #find-a-team'));
  assert.ok(message.includes('General Chat: #general-chat'));
  assert.ok(message.includes('Managed by Match District'));
});

test('5. buildDynamicWelcomeMessage: Multiple open tournaments supported', () => {
  const member = createMockMember({ displayName: 'SquadLeader' });
  const openTournaments = [
    { id: 'tour-1', name: 'BGIS Community Cup', channelId: '111111' },
    { id: 'tour-2', name: 'TDM Championship', channelId: '222222' },
  ];

  const message = buildDynamicWelcomeMessage({
    member,
    openTournaments,
  });

  assert.ok(message.includes('🏆 **Tournament Registrations**'));
  assert.ok(message.includes('• BGIS Community Cup – <#111111>'));
  assert.ok(message.includes('• TDM Championship – <#222222>'));
});

test('6. resolveActiveInviteEvents: detects genuinely active campaign and skips missing channels', async () => {
  clearInMemoryInviteCampaignData();
  const { guild, addChannel } = createMockGuild({ id: 'guild-active-invite-test' });

  // Add the Discord channel to guild
  const inviteCh = addChannel({ id: 'invite-chan-999', name: 'invite-rewards' });

  // Create an active campaign with this channel
  await createInviteCampaign({
    campaignId: 'camp-active-1',
    guildId: guild.id,
    name: 'Diwali Gaming Giveaway',
    status: CAMPAIGN_STATUS.ACTIVE,
    inviteChannelId: inviteCh.id,
    announcementChannelId: inviteCh.id,
    createdBy: 'admin-1',
  });

  const activeEvents = await resolveActiveInviteEvents(guild);
  assert.strictEqual(activeEvents.length, 1);
  assert.strictEqual(activeEvents[0].id, 'camp-active-1');
  assert.strictEqual(activeEvents[0].name, 'Diwali Gaming Giveaway');
  assert.strictEqual(activeEvents[0].channelId, 'invite-chan-999');

  // Now create a campaign with a non-existent channel
  clearInMemoryInviteCampaignData();
  await createInviteCampaign({
    campaignId: 'camp-deleted-chan',
    guildId: guild.id,
    name: 'Ghost Event',
    status: CAMPAIGN_STATUS.ACTIVE,
    inviteChannelId: 'non-existent-channel-id',
    announcementChannelId: 'non-existent-channel-id',
    createdBy: 'admin-1',
  });

  const missingChanEvents = await resolveActiveInviteEvents(guild);
  assert.strictEqual(missingChanEvents.length, 0, 'Must omit campaigns whose channel is missing from Discord');

  clearInMemoryInviteCampaignData();
});

test('7. resolveOpenTournaments: detects OPEN configurable tournaments and excludes closed/unpublished/deleted', async () => {
  clearTournamentData();
  const { guild, addChannel } = createMockGuild({ id: 'guild-tour-test' });

  const regCh1 = addChannel({ id: 'reg-ch-001', name: 'bgis-register' });
  const regCh2 = addChannel({ id: 'reg-ch-002', name: 'closed-register' });

  // 1. Valid OPEN published tournament
  await saveConfigurableTournament({
    tournamentId: 'tour-open-pub',
    guildId: guild.id,
    name: 'BGIS Open 2026',
    status: 'ACTIVE',
    isPublished: true,
  });
  await saveConfigurableRegistration({
    registrationId: 'reg-001',
    tournamentId: 'tour-open-pub',
    displayName: 'Slot 1',
    status: 'OPEN',
    registrationChannelId: regCh1.id,
  });

  // 2. CLOSED registration
  await saveConfigurableTournament({
    tournamentId: 'tour-closed',
    guildId: guild.id,
    name: 'Closed Tour',
    status: 'ACTIVE',
    isPublished: true,
  });
  await saveConfigurableRegistration({
    registrationId: 'reg-002',
    tournamentId: 'tour-closed',
    status: 'CLOSED',
    registrationChannelId: regCh2.id,
  });

  // 3. Unpublished tournament (even if registration says OPEN)
  await saveConfigurableTournament({
    tournamentId: 'tour-unpub',
    guildId: guild.id,
    name: 'Unpublished Tour',
    status: 'ACTIVE',
    isPublished: false,
  });
  await saveConfigurableRegistration({
    registrationId: 'reg-003',
    tournamentId: 'tour-unpub',
    status: 'OPEN',
    registrationChannelId: 'some-unpub-ch',
  });

  // 4. Deleting tournament
  await saveConfigurableTournament({
    tournamentId: 'tour-deleting',
    guildId: guild.id,
    name: 'Deleting Tour',
    status: 'ACTIVE',
    setupStatus: 'deleting',
    isPublished: true,
  });
  await saveConfigurableRegistration({
    registrationId: 'reg-004',
    tournamentId: 'tour-deleting',
    status: 'OPEN',
    registrationChannelId: 'some-deleting-ch',
  });

  const openList = await resolveOpenTournaments(guild);
  assert.strictEqual(openList.length, 1);
  assert.strictEqual(openList[0].name, 'BGIS Open 2026');
  assert.strictEqual(openList[0].channelId, 'reg-ch-001');

  clearTournamentData();
});

test('8. resolveImportantChannels: resolves rules, findTeam, and general channels', () => {
  const { guild, addChannel } = createMockGuild({ id: 'guild-channels-test' });

  const rulesCh = addChannel({ id: 'ch-rules-10', name: 'server-rules' });
  const findTeamCh = addChannel({ id: 'ch-team-20', name: 'find-a-team' });
  const generalCh = addChannel({ id: 'ch-gen-30', name: 'general-chat' });

  const resolved = resolveImportantChannels(guild);
  assert.strictEqual(resolved.rules, 'ch-rules-10');
  assert.strictEqual(resolved.findTeam, 'ch-team-20');
  assert.strictEqual(resolved.generalChat, 'ch-gen-30');
});

test('9. handleGuildMemberAdd integration: sends dynamic welcome DM on join', async () => {
  clearInMemoryInviteCampaignData();
  clearTournamentData();

  const { guild, addChannel } = createMockGuild({ id: 'guild-join-integration' });
  setWelcomeEnabled(guild.id, true);

  const inviteCh = addChannel({ id: 'inv-ch-join', name: 'invites' });
  const regCh = addChannel({ id: 'reg-ch-join', name: 'register-now' });
  addChannel({ id: 'rules-join', name: 'rules' });
  addChannel({ id: 'general-join', name: 'general' });

  // Add active campaign
  await createInviteCampaign({
    campaignId: 'camp-join-test',
    guildId: guild.id,
    name: 'Spring Giveaway',
    status: CAMPAIGN_STATUS.ACTIVE,
    inviteChannelId: inviteCh.id,
    announcementChannelId: inviteCh.id,
    createdBy: 'admin-1',
  });

  // Add open tournament
  await saveConfigurableTournament({
    tournamentId: 'tour-join-test',
    guildId: guild.id,
    name: 'Pro Scrims',
    status: 'ACTIVE',
    isPublished: true,
  });
  await saveConfigurableRegistration({
    registrationId: 'reg-join-test',
    tournamentId: 'tour-join-test',
    status: 'OPEN',
    registrationChannelId: regCh.id,
  });

  const joiningMember = createMockMember({
    id: 'user-join-dynamic',
    displayName: 'NewChampion',
    guild,
  });

  await handleGuildMemberAdd(joiningMember);

  assert.strictEqual(joiningMember._sentMessages.length, 1);
  const sent = joiningMember._sentMessages[0];

  assert.ok(sent.includes('Welcome NewChampion!'));
  assert.ok(sent.includes('🎁 **Active Invite Event**'));
  assert.ok(sent.includes('Join the event: <#inv-ch-join>'));
  assert.ok(sent.includes('Spring Giveaway'));
  assert.ok(sent.includes('🏆 **Tournament Registrations**'));
  assert.ok(sent.includes('Register here: <#reg-ch-join>'));
  assert.ok(sent.includes('Pro Scrims'));
  assert.ok(sent.includes('Rules: <#rules-join>'));
  assert.ok(sent.includes('General Chat: <#general-join>'));
  assert.ok(sent.includes('Managed by Match District'));

  // Test deduplication: immediate second join for same user does not send another DM
  await handleGuildMemberAdd(joiningMember);
  assert.strictEqual(joiningMember._sentMessages.length, 1, 'Duplicate join within 60s must be ignored');

  clearInMemoryInviteCampaignData();
  clearTournamentData();
});

test('10. handleGuildMemberAdd: ignores bot accounts', async () => {
  const { guild } = createMockGuild({ id: 'guild-bot-ignore' });
  setWelcomeEnabled(guild.id, true);

  const botMember = createMockMember({
    id: 'another-bot-id',
    isBot: true,
    guild,
  });

  await handleGuildMemberAdd(botMember);
  assert.strictEqual(botMember._sentMessages.length, 0);
});

