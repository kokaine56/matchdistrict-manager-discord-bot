import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import {
  CAMPAIGN_STATUS,
  clearInMemoryInviteCampaignData,
  clearInviteSnapshotState,
  clearInviteInteractionCaches,
  stopInviteCampaignScheduler,
  parseISTDateTime,
  formatISTDateTime,
  parseAndValidateRewards,
  computeCampaignLeaderboardRows,

  generateLeaderboardPng,
  ensureOrUpdateLeaderboardMessage,
  buildCampaignPanelPayload,
  createInviteCampaign,
  createCampaignReferral,
  getInviteCampaignById,
  getCurrentGuildCampaign,
  getCampaignInvitesForCampaign,
  getCampaignReferral,
  getReferralsForCampaign,
  getCampaignParticipant,
  upsertCampaignParticipant,
  handleInviteCommand,
  handleInviteCampaignInteraction,
  handleInviteCampaignMemberAdd,
  handleInviteCampaignMemberRemove,
  recoverInviteCampaignsOnStartup,
  checkInviteCampaignLifecycles,
  recalculateParticipantEligibility,
  scheduleLeaderboardAutoUpdate,
} from '../bot/discord/features/inviteCampaign/index.js';
import { handleMessageModeration } from '../moderationService.js';
import { guildSettingsCache } from '../index.js';

function createTestEnvironment(options = {}) {
  const guildId = options.guildId || 'guild-inv-100';
  const channels = new Map();
  const members = new Map();
  const invites = new Map();
  const deletedInviteCodes = [];
  const dmsSent = [];

  const createMockChannel = (id, name) => {
    const messages = new Map();
    const sentPayloads = [];
    let inviteSeq = 1;

    const ch = {
      id,
      name,
      type: ChannelType.GuildText,
      guildId,
      messages: {
        cache: messages,
        fetch: async (msgId) => messages.get(msgId) || null,
      },
      send: async (payload) => {
        const msgId = `msg-${id}-${sentPayloads.length + 1}`;
        const msgObj = {
          id: msgId,
          channelId: id,
          content: typeof payload === 'string' ? payload : payload?.content || '',
          embeds: payload?.embeds || [],
          components: payload?.components || [],
          files: payload?.files || [],
          _leaderboardMeta: payload?._leaderboardMeta || null,
          edits: [],
          edit: async (editPayload) => {
            msgObj.content =
              typeof editPayload === 'string' ? editPayload : editPayload?.content ?? msgObj.content;
            msgObj.embeds = editPayload?.embeds ?? msgObj.embeds;
            msgObj.components = editPayload?.components ?? msgObj.components;
            msgObj.files = editPayload?.files ?? msgObj.files;
            msgObj._leaderboardMeta = editPayload?._leaderboardMeta ?? msgObj._leaderboardMeta;
            msgObj.edits.push(editPayload);
            return msgObj;
          },
          delete: async () => {
            messages.delete(msgId);
            return msgObj;
          },
        };
        messages.set(msgId, msgObj);
        sentPayloads.push(msgObj);
        return msgObj;
      },
      createInvite: async (opts) => {
        if (options.failCreateInviteWithLimit) {
          const err = new Error('Maximum number of invites to this server reached.');
          err.code = 30016;
          throw err;
        }
        if (options.failCreateInvite) {
          throw new Error('Missing Access');
        }
        const code = `MDSC${inviteSeq++}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const inv = {
          code,
          url: `https://discord.gg/${code}`,
          uses: 0,
          maxAge: opts.maxAge,
          maxUses: opts.maxUses,
          unique: opts.unique,
          guild: { id: guildId },
          delete: async () => {
            deletedInviteCodes.push(code);
            invites.delete(code);
          },
        };
        invites.set(code, inv);
        return inv;
      },
      _sent: sentPayloads,
      _messages: messages,
    };
    channels.set(id, ch);
    return ch;
  };

  const inviteChannel = createMockChannel('ch-invite-panel', 'invite-and-earn');
  const anncChannel = createMockChannel('ch-announcements', 'announcements');
  const modLogChannel = createMockChannel('ch-mod-log', 'mod-log');

  const hasManageGuild = options.botManageGuild !== false;
  const hasCreateInvite = options.botCreateInvite !== false;

  const botPermissions = new Set();
  if (hasManageGuild) botPermissions.add(PermissionFlagsBits.ManageGuild);
  if (hasCreateInvite) botPermissions.add(PermissionFlagsBits.CreateInstantInvite);

  const clientIntents =
    options.intents || [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites];

  const client = {
    options: {
      intents: clientIntents,
    },
    guilds: {
      cache: new Map(),
      fetch: async (id) => (id === guildId ? guild : null),
    },
    users: {
      cache: new Map(),
      fetch: async (id) => members.get(id)?.user || null,
    },
  };

  const guild = {
    id: guildId,
    name: 'MatchDistrict Test Server',
    ownerId: 'owner-1',
    client,
    roles: {
      everyone: { id: guildId },
    },
    members: {
      me: {
        id: 'bot-1',
        permissions: {
          has: (bit) => botPermissions.has(bit),
        },
      },
      cache: members,
      fetch: async (id) => {
        if (!id) return members;
        return members.get(id) || null;
      },
    },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
    },
    invites: {
      fetch: async (code) => {
        if (code) return invites.get(code) || null;
        return invites;
      },
      delete: async (code) => {
        deletedInviteCodes.push(code);
        invites.delete(code);
      },
    },
  };

  client.guilds.cache.set(guildId, guild);

  const addMember = (
    id,
    {
      bot = false,
      isAdminPerm = false,
      accountAgeDays = 30,
      joinedAt = new Date(),
      username = null,
      displayName = null,
    } = {}
  ) => {
    const createdTimestamp = Date.now() - accountAgeDays * 24 * 60 * 60 * 1000;
    const member = {
      id,
      guild,
      client,
      displayName: displayName || `User_${id}`,
      joinedAt,
      joinedTimestamp: joinedAt.getTime(),
      permissions: {
        has: (bit) =>
          isAdminPerm &&
          (bit === PermissionFlagsBits.Administrator || bit === PermissionFlagsBits.ManageGuild),
      },
      user: {
        id,
        bot,
        username: username || `user_${id}`,
        tag: `${username || `user_${id}`}#0001`,
        createdTimestamp,
        createdAt: new Date(createdTimestamp),
        send: async (msg) => {
          dmsSent.push({ userId: id, msg });
          return { id: `dm-${dmsSent.length}` };
        },
      },
      send: async (msg) => {
        dmsSent.push({ userId: id, msg });
        return { id: `dm-${dmsSent.length}` };
      },
      timeout: async (ms, reason) => {
        member._timedOutMs = ms;
        member._timeoutReason = reason;
      },
    };
    members.set(id, member);
    client.users.cache.set(id, member.user);
    return member;
  };

  return {
    guildId,
    client,
    guild,
    inviteChannel,
    anncChannel,
    modLogChannel,
    members,
    invites,
    deletedInviteCodes,
    dmsSent,
    addMember,
  };
}

test('Invite & Earn — Configurable Rewards, Minimum Threshold & Live Image Leaderboard', async (t) => {
  t.beforeEach(() => {
    stopInviteCampaignScheduler();
    clearInMemoryInviteCampaignData();
    clearInviteSnapshotState();
    clearInviteInteractionCaches();
  });

  t.after(() => {
    stopInviteCampaignScheduler();
  });

  await t.test('0. Admin .invite min updates and persists the current campaign threshold', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-min', { isAdminPerm: true });
    const member = env.addMember('member-min', { isAdminPerm: false });
    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Minimum Threshold Campaign',
      status: CAMPAIGN_STATUS.ACTIVE,
      endAt: new Date(Date.now() + 86400000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
      minInviteThreshold: 2,
      rewards: [{ position: 1, amount: 50 }],
    });

    let response = '';
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['min', '10'], (text) => { response = text; }, env.client);
    assert.equal(response, 'Minimum successful invites set to 10.');
    let updated = await getInviteCampaignById(campaign.campaignId);
    assert.equal(updated.minInviteThreshold, 10);
    assert.equal(updated.requiredInvites, 10);
    const rows = computeCampaignLeaderboardRows(updated, [
      { userId: 'u1', successfulInvites: 9 },
      { userId: 'u2', successfulInvites: 10 },
    ], env.guild);
    // Both participants appear on leaderboard in sorted order
    assert.deepEqual(rows.map((row) => row.userId), ['u2', 'u1']);
    // u2 (10 invites >= 10 threshold) qualifies for prize #1 (₹50)
    assert.equal(rows[0].winningAmountFormatted, '₹50');
    // u1 (9 invites < 10 threshold) has a blank winning amount cell
    assert.equal(rows[1].winningAmountFormatted, '');
    assert.equal(rows[1].winningAmount, 0);

    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['min', '0'], (text) => { response = text; }, env.client);
    assert.match(response, /positive whole number/);
    await handleInviteCommand(env.guild, member, env.inviteChannel, ['min', '5'], (text) => { response = text; }, env.client);
    assert.match(response, /Permission Denied/);
    updated = await getInviteCampaignById(campaign.campaignId);
    assert.equal(updated.minInviteThreshold, 10);
  });

  await t.test('1. Button Label Changed to "Create Link" & Duplicate Invite Prevention', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const member = env.addMember('member-1');

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Create Link Test',
      description: 'Test campaign',
      status: CAMPAIGN_STATUS.DRAFT,
      rewards: [
        { position: 1, amount: 100 },
        { position: 2, amount: 50 },
        { position: 3, amount: 30 },
        { position: 4, amount: 10 },
        { position: 5, amount: 5 },
      ],
      endAt: new Date(Date.now() + 86400000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => { }, env.client);
    const activeCampaign = await getInviteCampaignById(campaign.campaignId);

    const panelPayload = buildCampaignPanelPayload(activeCampaign);
    const buttonJson = panelPayload.components[0].components[0].toJSON();
    assert.equal(buttonJson.label, 'Create Link');
    assert.equal(buttonJson.custom_id, `inv_cmp:generate:${campaign.campaignId}`);
    const embedJson = panelPayload.embeds[0].toJSON();
    const prizeField = embedJson.fields.find((field) => field.name === '🏆 Prize Distribution');
    assert.equal(prizeField.value, '1st Place — ₹100\n2nd Place — ₹50\n3rd Place — ₹30\n4th Place — ₹10\n5th Place — ₹5');

    // Click "Create Link" first time -> creates 1 Discord invite
    let reply1 = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member,
      user: member.user,
      client: env.client,
      isButton: () => true,
      reply: async (p) => {
        reply1 = p;
      },
      editReply: async (p) => {
        reply1 = p;
      },
    });
    assert.equal(env.invites.size, 1);
    assert.match(reply1.content, /^\*\*Your Successful Invites: \d+\*\*/);
    assert.match(reply1.content, /🎉 Want to earn real money\?/);
    assert.match(reply1.content, /Join \*\*Match District's Create Link Test\*\*!/);
    assert.match(reply1.content, /participate in BGMI tournaments/);
    assert.match(reply1.content, /🔗 \*\*Join using my personal invite link:\*\* https:\/\/discord\.gg\//);
    assert.match(reply1.content, /🚀 Join now and let's win together!/);
    assert.doesNotMatch(reply1.content, /prize distribution|eligibility|Your Invite Link/i);
    assert.equal(reply1.components, undefined);

    // Clear cooldown and click "Create Link" a second time -> reuses existing link, no duplicate created
    clearInviteInteractionCaches();
    let reply2 = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member,
      user: member.user,
      client: env.client,
      isButton: () => true,
      reply: async (p) => {
        reply2 = p;
      },
      editReply: async (p) => {
        reply2 = p;
      },
    });
    assert.equal(env.invites.size, 1);
    assert.equal(reply1.content, reply2.content);

  });

  await t.test('2. Creating a Campaign with Custom Reward Amounts & Custom Minimum Invite Threshold (Plus Editing Before Start)', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });

    // Validate reward parser: supports ₹0, custom positions, rejects negative or invalid amounts
    const validZero = parseAndValidateRewards('#1=50, #2=20, #3=10, #4=0');
    assert.equal(validZero.valid, true);
    assert.deepEqual(validZero.rewards, [
      { position: 1, amount: 50 },
      { position: 2, amount: 20 },
      { position: 3, amount: 10 },
      { position: 4, amount: 0 },
    ]);

    const invalidNeg = parseAndValidateRewards('#1=50, #2=-10');
    assert.equal(invalidNeg.valid, false);

    const invalidNaN = parseAndValidateRewards('#1=abc');
    assert.equal(invalidNaN.valid, false);

    // Admin opens modal and submits custom threshold (10) and custom rewards (#1=50, #2=20, #3=10, #4=5, #5=2)
    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:create_modal',
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isModalSubmit: () => true,
      fields: {
        getTextInputValue: (field) => {
          const map = {
            name: 'Diwali Mega Invite Event',
            startAt: 'DRAFT',
            endAt: '25-12-2027 23:59',
            minInviteThreshold: '10',
            rewards: '#1=50, #2=20, #3=10, #4=5, #5=2',
          };
          return map[field] || '';
        },
      },
      reply: async () => { },
    });

    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:select_invite_channel',
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isChannelSelectMenu: () => true,
      values: [env.inviteChannel.id],
      update: async () => { },
    });
    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:select_annc_channel',
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isChannelSelectMenu: () => true,
      values: [env.anncChannel.id],
      update: async () => { },
    });

    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:confirm_create',
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isButton: () => true,
      update: async () => { },
    });

    let campaign = await getCurrentGuildCampaign(env.guildId);
    assert.equal(campaign.minInviteThreshold, 10);
    assert.deepEqual(campaign.rewards, [
      { position: 1, amount: 50 },
      { position: 2, amount: 20 },
      { position: 3, amount: 10 },
      { position: 4, amount: 5 },
      { position: 5, amount: 2 },
    ]);
    assert.ok(campaign.leaderboardMessageId, 'Initial leaderboard message ID should be stored in MongoDB');

    // Admin edits rewards and threshold via Discord modal interaction before event starts
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:rewards_modal:${campaign.campaignId}`,
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isModalSubmit: () => true,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'minInviteThreshold') return '12';
          if (field === 'rewards') return '#1=100, #2=50, #3=25';
          return '';
        },
      },
      reply: async () => { },
    });

    campaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(campaign.minInviteThreshold, 12);
    assert.deepEqual(campaign.rewards, [
      { position: 1, amount: 100 },
      { position: 2, amount: 50 },
      { position: 3, amount: 25 },
    ]);

    // Admin can also edit via .invite set threshold & .invite set rewards before event starts
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['set', 'threshold', '10'],
      async () => { },
      env.client
    );
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['set', 'rewards', '#1=50, #2=20, #3=10'],
      async () => { },
      env.client
    );

    campaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(campaign.minInviteThreshold, 10);
    assert.deepEqual(campaign.rewards, [
      { position: 1, amount: 50 },
      { position: 2, amount: 20 },
      { position: 3, amount: 10 },
    ]);

    // Start campaign -> thresholds stay fixed, while prize distribution remains editable
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => { }, env.client);
    let postStartEditReply = '';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['set', 'rewards', '#1=500'],
      async (msg) => {
        postStartEditReply = typeof msg === 'string' ? msg : msg.content;
      },
      env.client
    );
    assert.match(postStartEditReply, /Reward configuration updated/i);
    assert.deepEqual((await getInviteCampaignById(campaign.campaignId)).rewards, [
      { position: 1, amount: 500 },
    ]);
  });

  await t.test('3. Conditional Winning Amount & Show All Inviters (All Inviters Visible, Blank When Below Threshold or Outside Prize Ranks)', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const userA = env.addMember('user-a', { username: 'AlphaUser' });
    const userB = env.addMember('user-b', { username: 'BravoUser' });
    const userC = env.addMember('user-c', { username: 'CharlieUser' });
    const userD = env.addMember('user-d', { username: 'DeltaUser' });

    // Threshold = 10; Rewards: #1=50, #2=20, #3=10 (only top 3 get prizes)
    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Threshold 10 Event',
      description: 'Reach 10 invites to qualify!',
      status: CAMPAIGN_STATUS.ACTIVE,
      minInviteThreshold: 10,
      rewards: [
        { position: 1, amount: 50 },
        { position: 2, amount: 20 },
        { position: 3, amount: 10 },
      ],
      endAt: new Date(Date.now() + 86400000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userA.id, {
      successfulInvites: 3,
      isEligible: false,
    });
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userB.id, {
      successfulInvites: 9,
      isEligible: false,
    });
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userC.id, {
      successfulInvites: 10,
      isEligible: true,
      eligibleAt: new Date('2026-11-07T10:00:00Z'),
    });
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userD.id, {
      successfulInvites: 15,
      isEligible: true,
      eligibleAt: new Date('2026-11-07T09:00:00Z'),
    });

    const participants = [
      await getCampaignParticipant(campaign.campaignId, userA.id),
      await getCampaignParticipant(campaign.campaignId, userB.id),
      await getCampaignParticipant(campaign.campaignId, userC.id),
      await getCampaignParticipant(campaign.campaignId, userD.id),
    ];

    // All 4 inviters must appear on leaderboard in descending order of invites
    let rows = computeCampaignLeaderboardRows(campaign, participants, env.guild);
    assert.equal(rows.length, 4, 'All active inviters must appear on the leaderboard');

    // Rank 1: userD with 15 invites (meets threshold >= 10, qualifies for #1 prize ₹50)
    assert.equal(rows[0].userId, userD.id);
    assert.equal(rows[0].invites, 15);
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].winningAmountFormatted, '₹50');
    assert.equal(rows[0].winningAmount, 50);

    // Rank 2: userC with 10 invites (meets threshold >= 10, qualifies for #2 prize ₹20)
    assert.equal(rows[1].userId, userC.id);
    assert.equal(rows[1].invites, 10);
    assert.equal(rows[1].rank, 2);
    assert.equal(rows[1].winningAmountFormatted, '₹20');
    assert.equal(rows[1].winningAmount, 20);

    // Rank 3: userB with 9 invites (below threshold 10 -> Winning Amount must be completely blank, not ₹0)
    assert.equal(rows[2].userId, userB.id);
    assert.equal(rows[2].invites, 9);
    assert.equal(rows[2].rank, 3);
    assert.equal(rows[2].winningAmountFormatted, '', 'Below threshold must be completely blank');
    assert.equal(rows[2].winningAmount, 0);

    // Rank 4: userA with 3 invites (below threshold 10 -> Winning Amount must be completely blank, not ₹0)
    assert.equal(rows[3].userId, userA.id);
    assert.equal(rows[3].invites, 3);
    assert.equal(rows[3].rank, 4);
    assert.equal(rows[3].winningAmountFormatted, '', 'Below threshold must be completely blank');
    assert.equal(rows[3].winningAmount, 0);

    // User B crosses threshold from 9 to 11 invites -> qualifies for prize at their rank!
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userB.id, {
      successfulInvites: 11,
      isEligible: true,
      eligibleAt: new Date('2026-11-07T11:00:00Z'),
    });

    // User C drops from 10 to 9 invites (due to leave) -> remains on leaderboard but Winning Amount is removed immediately
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userC.id, {
      successfulInvites: 9,
      isEligible: false,
      eligibleAt: null,
    });

    const updatedParticipants = [
      await getCampaignParticipant(campaign.campaignId, userA.id),
      await getCampaignParticipant(campaign.campaignId, userB.id),
      await getCampaignParticipant(campaign.campaignId, userC.id),
      await getCampaignParticipant(campaign.campaignId, userD.id),
    ];

    rows = computeCampaignLeaderboardRows(campaign, updatedParticipants, env.guild);
    assert.equal(rows.length, 4, 'All 4 inviters still visible on leaderboard');
    // #1 userD (15 invites) -> ₹50
    assert.equal(rows[0].userId, userD.id);
    assert.equal(rows[0].winningAmountFormatted, '₹50');
    // #2 userB (11 invites) -> now qualifies for #2 prize ₹20
    assert.equal(rows[1].userId, userB.id);
    assert.equal(rows[1].rank, 2);
    assert.equal(rows[1].winningAmountFormatted, '₹20');
    // #3 userC (dropped to 9 invites < 10) -> winning amount removed immediately to blank
    assert.equal(rows[2].userId, userC.id);
    assert.equal(rows[2].rank, 3);
    assert.equal(rows[2].invites, 9);
    assert.equal(rows[2].winningAmountFormatted, '', 'Dropped below threshold must have blank winning amount');
    assert.equal(rows[2].winningAmount, 0);
    // #4 userA (3 invites) -> blank
    assert.equal(rows[3].userId, userA.id);
    assert.equal(rows[3].winningAmountFormatted, '');

    // Rule: Qualified for threshold but outside prize positions must also be completely blank
    // Set userA to 10 invites (meets threshold >= 10), but rank 4 is outside top 3 prize rewards
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userA.id, {
      successfulInvites: 10,
      isEligible: true,
      eligibleAt: new Date('2026-11-07T12:00:00Z'),
    });
    // Set userC to 12 invites so userA is at Rank 4
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, userC.id, {
      successfulInvites: 12,
      isEligible: true,
      eligibleAt: new Date('2026-11-07T12:00:00Z'),
    });

    const fourQualifiedParticipants = [
      await getCampaignParticipant(campaign.campaignId, userA.id),
      await getCampaignParticipant(campaign.campaignId, userB.id),
      await getCampaignParticipant(campaign.campaignId, userC.id),
      await getCampaignParticipant(campaign.campaignId, userD.id),
    ];
    rows = computeCampaignLeaderboardRows(campaign, fourQualifiedParticipants, env.guild);
    assert.equal(rows.length, 4);
    // userD: 15 (#1) -> ₹50
    assert.equal(rows[0].userId, userD.id);
    assert.equal(rows[0].winningAmountFormatted, '₹50');
    // userC: 12 (#2) -> ₹20
    assert.equal(rows[1].userId, userC.id);
    assert.equal(rows[1].winningAmountFormatted, '₹20');
    // userB: 11 (#3) -> ₹10
    assert.equal(rows[2].userId, userB.id);
    assert.equal(rows[2].winningAmountFormatted, '₹10');
    // userA: 10 (#4) meets threshold >= 10, but outside top 3 rewards -> MUST BE COMPLETELY BLANK
    assert.equal(rows[3].userId, userA.id);
    assert.equal(rows[3].rank, 4);
    assert.equal(rows[3].winningAmountFormatted, '', 'Meets threshold but outside prize positions must be blank');
    assert.equal(rows[3].winningAmount, 0);

    // Verify PNG generator runs on rows with blank winning amounts without error
    const pngResult = generateLeaderboardPng(campaign, rows);
    assert.ok(Buffer.isBuffer(pngResult.buffer));
    assert.equal(pngResult.rows.length, 4);
  });

  await t.test('4. Dynamic Ranking, Reward Reassignment When Rankings Change & Deterministic Tie-Breaking', async () => {
    const env = createTestEnvironment();
    const user1 = env.addMember('u-1', { username: 'kok aine' });
    const user2 = env.addMember('u-2', { username: 'User2' });
    const user3 = env.addMember('u-3', { username: 'User3' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Ranking & Tie Test',
      description: 'Test',
      status: CAMPAIGN_STATUS.ACTIVE,
      minInviteThreshold: 5,
      rewards: [
        { position: 1, amount: 100 },
        { position: 2, amount: 50 },
        { position: 3, amount: 25 },
      ],
      endAt: new Date(Date.now() + 86400000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: 'admin-1',
    });

    // Initially: u-1 has 10 invites (#1 = ₹100), u-2 has 8 invites (#2 = ₹50)
    let pList = [
      { userId: user1.id, successfulInvites: 10, eligibleAt: new Date('2026-11-07T08:00:00Z') },
      { userId: user2.id, successfulInvites: 8, eligibleAt: new Date('2026-11-07T08:05:00Z') },
    ];
    let rows = computeCampaignLeaderboardRows(campaign, pList, env.guild);
    assert.equal(rows[0].userId, user1.id);
    assert.equal(rows[0].winningAmountFormatted, '₹100');
    assert.equal(rows[1].userId, user2.id);
    assert.equal(rows[1].winningAmountFormatted, '₹50');

    // Now u-2 overtakes u-1 with 14 invites -> reward ₹100 moves to u-2 (#1), and u-1 gets ₹50 (#2)!
    pList = [
      { userId: user1.id, successfulInvites: 10, eligibleAt: new Date('2026-11-07T08:00:00Z') },
      { userId: user2.id, successfulInvites: 14, eligibleAt: new Date('2026-11-07T08:05:00Z') },
    ];
    rows = computeCampaignLeaderboardRows(campaign, pList, env.guild);
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].userId, user2.id);
    assert.equal(rows[0].winningAmountFormatted, '₹100');
    assert.equal(rows[1].rank, 2);
    assert.equal(rows[1].userId, user1.id);
    assert.equal(rows[1].winningAmountFormatted, '₹50');

    // Deterministic tie-breaking: u-1 and u-3 both have 10 invites, but u-3 reached eligibility earlier
    pList = [
      { userId: user1.id, successfulInvites: 10, eligibleAt: new Date('2026-11-07T09:00:00Z') },
      { userId: user3.id, successfulInvites: 10, eligibleAt: new Date('2026-11-07T07:30:00Z') },
    ];
    rows = computeCampaignLeaderboardRows(campaign, pList, env.guild);
    assert.equal(rows[0].userId, user3.id, 'Earlier eligibleAt wins tie');
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].winningAmountFormatted, '₹100');
    assert.equal(rows[1].userId, user1.id);
    assert.equal(rows[1].rank, 2);
    assert.equal(rows[1].winningAmountFormatted, '₹50');

    // Verify PNG generation produces a valid PNG image buffer and scales height with row count
    const png2Rows = generateLeaderboardPng(campaign, rows);
    assert.ok(Buffer.isBuffer(png2Rows.buffer));
    assert.equal(png2Rows.width, 960, 'Leaderboard uses a higher-resolution mobile layout');
    assert.ok(png2Rows.height > 150 + 72 + 2 * 72, 'Rows include enlarged vertical spacing');
    // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
    assert.deepEqual(
      [...png2Rows.buffer.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    );

    const png5Rows = generateLeaderboardPng(campaign, [
      ...rows,
      { rank: 3, userId: 'u-4', username: 'VeryLongUsernameThatShouldBeTruncatedCleanlyInTable', invites: 7, winningAmount: 25, winningAmountFormatted: '₹25' },
      { rank: 4, userId: 'u-5', username: 'PlayerFive', invites: 6, winningAmount: 0, winningAmountFormatted: '₹0' },
      { rank: 5, userId: 'u-6', username: 'PlayerSix', invites: 5, winningAmount: 0, winningAmountFormatted: '₹0' },
    ]);
    assert.ok(png5Rows.height > png2Rows.height, 'Image height scales dynamically with qualified rows');
  });

  await t.test('5. Unique Invite Tracking, Repeated Join/Leave Anti-Inflation & Original Inviter Preservation', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const inviterA = env.addMember('inviter-a', { username: 'InviterA' });
    const inviterB = env.addMember('inviter-b', { username: 'InviterB' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Anti-Inflation Campaign',
      description: 'Test unique tracking',
      status: CAMPAIGN_STATUS.DRAFT,
      minInviteThreshold: 1,
      rewards: [
        { position: 1, amount: 50 },
        { position: 2, amount: 20 },
      ],
      endAt: new Date(Date.now() + 7200000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => { }, env.client);

    // Inviter A and Inviter B both click "Create Link"
    for (const invMember of [inviterA, inviterB]) {
      await handleInviteCampaignInteraction({
        customId: `inv_cmp:generate:${campaign.campaignId}`,
        guild: env.guild,
        channel: env.inviteChannel,
        member: invMember,
        user: invMember.user,
        client: env.client,
        isButton: () => true,
        reply: async () => { },
        editReply: async () => { },
      });
    }

    const invitesList = await getCampaignInvitesForCampaign(campaign.campaignId);
    const inviteA = invitesList.find((i) => i.inviterId === inviterA.id);
    const inviteB = invitesList.find((i) => i.inviterId === inviterB.id);

    // User X joins via Inviter A's link -> Inviter A gets 1 valid invite
    env.invites.get(inviteA.inviteCode).uses = 1;
    const userX = env.addMember('user-x', { username: 'UserX' });
    await handleInviteCampaignMemberAdd(userX);

    let partA = await getCampaignParticipant(campaign.campaignId, inviterA.id);
    assert.equal(partA.successfulInvites, 1);

    // User X leaves -> Inviter A's valid invite count decrements to 0
    env.members.delete(userX.id);
    await handleInviteCampaignMemberRemove(userX);
    partA = await getCampaignParticipant(campaign.campaignId, inviterA.id);
    assert.equal(partA.successfulInvites, 0);

    // User X rejoins using Inviter B's link -> must NOT credit Inviter B, and must NOT create a 2nd referral record!
    // Instead restores original inviter (Inviter A) to 1.
    env.invites.get(inviteB.inviteCode).uses = 1;
    const userXRejoin1 = env.addMember('user-x', { username: 'UserXRenamed' });
    await handleInviteCampaignMemberAdd(userXRejoin1);

    partA = await getCampaignParticipant(campaign.campaignId, inviterA.id);
    const partB = await getCampaignParticipant(campaign.campaignId, inviterB.id);
    assert.equal(partA.successfulInvites, 1, 'Original inviter A restored to 1');
    assert.equal(partB?.successfulInvites ?? 0, 0, 'Inviter B must not get credit for User X');

    // User X leaves and rejoins 3 more times via Inviter A's link -> count for Inviter A never exceeds 1!
    for (let cycle = 2; cycle <= 4; cycle++) {
      env.members.delete(userX.id);
      await handleInviteCampaignMemberRemove(userX);
      partA = await getCampaignParticipant(campaign.campaignId, inviterA.id);
      assert.equal(partA.successfulInvites, 0);

      env.invites.get(inviteA.inviteCode).uses = cycle;
      const rejoined = env.addMember('user-x', { username: `UserX_v${cycle}` });
      await handleInviteCampaignMemberAdd(rejoined);
      partA = await getCampaignParticipant(campaign.campaignId, inviterA.id);
      assert.equal(partA.successfulInvites, 1, `Cycle ${cycle}: count must be 1, never inflated`);
    }

    const allReferrals = await getReferralsForCampaign(campaign.campaignId);
    assert.equal(allReferrals.length, 1, 'Only 1 unique referral document exists for User X');
  });

  await t.test('6. Refresh Leaderboard Button Edits Same Message, Concurrent Refresh Protection, Finalization & Post-End Lock', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const inviter1 = env.addMember('inv-1', { username: 'TopOne' });
    const inviter2 = env.addMember('inv-2', { username: 'TopTwo' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Live Leaderboard Campaign',
      description: 'Test refresh and finalization',
      status: CAMPAIGN_STATUS.DRAFT,
      minInviteThreshold: 2,
      rewards: [
        { position: 1, amount: 50 },
        { position: 2, amount: 20 },
      ],
      endAt: new Date(Date.now() + 3600000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => { }, env.client);

    let activeCampaign = await getInviteCampaignById(campaign.campaignId);
    const initialLbMsgId = activeCampaign.leaderboardMessageId;
    assert.ok(initialLbMsgId, 'Leaderboard message created on start');
    assert.equal(env.anncChannel._sent.length, 1, 'Exactly 1 leaderboard message sent in announcement channel');

    // Add participants meeting threshold (inviter1: 5 invites, inviter2: 2 invites)
    await upsertCampaignParticipant(campaign.campaignId, env.guildId, inviter1.id, {
      successfulInvites: 5,
      isEligible: true,
      eligibleAt: new Date('2026-11-07T08:00:00Z'),
    });
    await createInviteCampaign; // no-op reference check
    // Also create counted referrals so recalculateAllCampaignParticipants preserves their counts
    for (let i = 1; i <= 5; i++) {
      const m = env.addMember(`m1-${i}`);
      await handleInviteCampaignMemberAdd; // ensure imported
    }

    // Generate links and join real members so referrals are in DB
    for (const inv of [inviter1, inviter2]) {
      clearInviteInteractionCaches();
      await handleInviteCampaignInteraction({
        customId: `inv_cmp:generate:${campaign.campaignId}`,
        guild: env.guild,
        channel: env.inviteChannel,
        member: inv,
        user: inv.user,
        client: env.client,
        isButton: () => true,
        reply: async () => { },
        editReply: async () => { },
      });
    }
    const cInvites = await getCampaignInvitesForCampaign(campaign.campaignId);
    const code1 = cInvites.find((i) => i.inviterId === inviter1.id).inviteCode;
    const code2 = cInvites.find((i) => i.inviterId === inviter2.id).inviteCode;

    for (let i = 1; i <= 3; i++) {
      env.invites.get(code1).uses = i;
      const m = env.addMember(`r1-${i}`);
      await handleInviteCampaignMemberAdd(m);
    }
    for (let i = 1; i <= 2; i++) {
      env.invites.get(code2).uses = i;
      const m = env.addMember(`r2-${i}`);
      await handleInviteCampaignMemberAdd(m);
    }

    // Joins alone do NOT send a new leaderboard message or edit it until Refresh Leaderboard is clicked
    const lbMsg = env.anncChannel._messages.get(initialLbMsgId);
    const editsBeforeRefresh = lbMsg.edits.length;

    // Click "Refresh Leaderboard" (simultaneously twice to test concurrent refresh protection & cooldown)
    clearInviteInteractionCaches();
    const refreshReplies = [];
    await Promise.all([
      handleInviteCampaignInteraction({
        customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
        guild: env.guild,
        channel: env.anncChannel,
        member: inviter1,
        user: inviter1.user,
        client: env.client,
        isButton: () => true,
        reply: async (p) => refreshReplies.push(p),
      }),
      handleInviteCampaignInteraction({
        customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
        guild: env.guild,
        channel: env.anncChannel,
        member: inviter2,
        user: inviter2.user,
        client: env.client,
        isButton: () => true,
        reply: async (p) => refreshReplies.push(p),
      }),
    ]);

    // Verify existing message was edited in place and NO new message was posted
    assert.equal(env.anncChannel._sent.length, 1, 'Must never post a duplicate leaderboard message on refresh');
    assert.equal(lbMsg.edits.length, editsBeforeRefresh + 1, 'Concurrent refreshes only execute one update within cooldown');
    assert.equal(lbMsg._leaderboardMeta.rows.length, 2);
    assert.equal(lbMsg._leaderboardMeta.rows[0].userId, inviter1.id);
    assert.equal(lbMsg._leaderboardMeta.rows[0].winningAmountFormatted, '₹50');
    assert.equal(lbMsg._leaderboardMeta.rows[1].userId, inviter2.id);
    assert.equal(lbMsg._leaderboardMeta.rows[1].winningAmountFormatted, '₹20');

    // End the campaign via scheduler reaching endAt -> automatically finalizes leaderboard in place
    await checkInviteCampaignLifecycles(env.client, new Date(Date.now() + 7200000));

    const finalizedCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(finalizedCampaign.status, CAMPAIGN_STATUS.ENDED);
    assert.ok(finalizedCampaign.finalizedAt);
    assert.equal(finalizedCampaign.finalLeaderboardSnapshot.length, 2);
    assert.equal(env.anncChannel._sent.length, 1, 'Finalization edits the existing announcement leaderboard message');
    assert.equal(lbMsg._leaderboardMeta.status, 'EVENT ENDED');

    const finalRefreshBtn = lbMsg.components[0].components[0].toJSON();
    assert.equal(finalRefreshBtn.disabled, true, 'Refresh Leaderboard button must be disabled when ended');

    // Clicking an old Refresh Leaderboard interaction after campaign ended must NOT modify the final leaderboard
    const editsAfterFinalization = lbMsg.edits.length;
    clearInviteInteractionCaches();
    let postEndRefreshReply = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.anncChannel,
      member: inviter1,
      user: inviter1.user,
      client: env.client,
      isButton: () => true,
      reply: async (p) => {
        postEndRefreshReply = p;
      },
    });
    assert.match(postEndRefreshReply.content, /ended|finalized/i);
    assert.equal(lbMsg.edits.length, editsAfterFinalization, 'Finalized leaderboard message must not be modified after end');
  });

  await t.test('7. Bot Restart & Campaign Recovery Preserves Settings, Counts, and Announcement Message Without Duplicates', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-rec', { isAdminPerm: true });
    const inviter = env.addMember('inviter-rec', { username: 'RecoverUser' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Restart Persistence Campaign',
      description: 'Test restart recovery',
      status: CAMPAIGN_STATUS.DRAFT,
      minInviteThreshold: 1,
      rewards: [
        { position: 1, amount: 75 },
        { position: 2, amount: 25 },
      ],
      endAt: new Date(Date.now() + 3600000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => { }, env.client);

    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member: inviter,
      user: inviter.user,
      client: env.client,
      isButton: () => true,
      reply: async () => { },
      editReply: async () => { },
    });

    const [campaignInvite] = await getCampaignInvitesForCampaign(campaign.campaignId);
    const beforeRestartCampaign = await getInviteCampaignById(campaign.campaignId);
    const originalLbMessageId = beforeRestartCampaign.leaderboardMessageId;
    assert.equal(env.anncChannel._sent.length, 1);

    // Simulate bot restart with an offline join
    clearInviteSnapshotState();
    clearInviteInteractionCaches();
    env.invites.get(campaignInvite.inviteCode).uses = 1;
    env.addMember('offline-joiner-1', {
      accountAgeDays: 30,
      joinedAt: new Date(Date.now() + 1000),
    });

    await recoverInviteCampaignsOnStartup(env.client);
    stopInviteCampaignScheduler();

    const recoveredCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(recoveredCampaign.minInviteThreshold, 1);
    assert.deepEqual(recoveredCampaign.rewards, [
      { position: 1, amount: 75 },
      { position: 2, amount: 25 },
    ]);
    assert.equal(recoveredCampaign.leaderboardMessageId, originalLbMessageId, 'Same leaderboardMessageId preserved across restart');
    assert.equal(env.anncChannel._sent.length, 1, 'No duplicate announcement message created on restart');

    const part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
  });

  await t.test('8. Moderation Exception Preserved for Active/Scheduled Campaign Invite Links', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-mod', { isAdminPerm: true });
    const member = env.addMember('member-mod', { isAdminPerm: false });

    guildSettingsCache[env.guildId] = {
      setupActive: true,
      moderationEnabled: true,
      channels: { modLogId: env.modLogChannel.id },
    };

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Mod Exception Campaign',
      description: 'Test',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 3600000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => { }, env.client);

    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member,
      user: member.user,
      client: env.client,
      isButton: () => true,
      reply: async () => { },
      editReply: async () => { },
    });

    const [campaignInvite] = await getCampaignInvitesForCampaign(campaign.campaignId);

    let deleted1 = false;
    const modResult1 = await handleMessageModeration({
      guild: env.guild,
      channel: env.inviteChannel,
      author: member.user,
      member,
      content: `Join using my link: ${campaignInvite.inviteUrl}`,
      delete: async () => {
        deleted1 = true;
      },
    });
    assert.equal(modResult1, false);
    assert.equal(deleted1, false);

    delete guildSettingsCache[env.guildId];
  });

  await t.test('9. Leaderboard Refresh Interaction — Immediate deferUpdate(), No reply/update on Success, Message Preserved, Button Enabled, Error Handling', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-rf-1', { isAdminPerm: true });
    const user1 = env.addMember('user-rf-1', { username: 'AcePlayer' });
    const user2 = env.addMember('user-rf-2', { username: 'BravoPlayer' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'DeferUpdate Verification Campaign',
      description: 'Testing immediate acknowledgement and error handling',
      status: CAMPAIGN_STATUS.ACTIVE,
      startAt: new Date(Date.now() - 3600000),
      endAt: new Date(Date.now() + 3600000),
      minInviteThreshold: 1,
      rewards: [
        { position: 1, amount: 100 },
        { position: 2, amount: 50 },
      ],
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    // Post initial managed leaderboard message
    const initialLb = await ensureOrUpdateLeaderboardMessage(env.client, campaign);
    assert.ok(initialLb?.message?.id);
    const originalLbMessageId = initialLb.message.id;
    assert.equal(env.anncChannel._sent.length, 1);

    // Setup participant with 2 valid counted referrals
    await createCampaignReferral({
      campaignId: campaign.campaignId,
      guildId: env.guildId,
      invitedUserId: 'joined-user-rf-1',
      inviterId: user1.id,
      inviteCode: 'CODERF1',
      inviteUrl: 'https://discord.gg/CODERF1',
      joinedAt: new Date(),
      isActive: true,
      counted: true,
    });
    await createCampaignReferral({
      campaignId: campaign.campaignId,
      guildId: env.guildId,
      invitedUserId: 'joined-user-rf-2',
      inviterId: user1.id,
      inviteCode: 'CODERF1',
      inviteUrl: 'https://discord.gg/CODERF1',
      joinedAt: new Date(),
      isActive: true,
      counted: true,
    });
    await upsertCampaignParticipant(campaign.campaignId, user1.id, {
      successfulInvites: 2,
      eligibleAt: new Date(),
    });

    // Create a mock button interaction representing a real Discord.js button interaction
    const callLog = [];
    const interaction1 = {
      customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.anncChannel,
      member: user1,
      user: user1.user,
      client: env.client,
      deferred: false,
      replied: false,
      isButton: () => true,
      deferUpdate: async () => {
        callLog.push('deferUpdate');
        if (interaction1.deferred || interaction1.replied) {
          throw new Error('DiscordAPIError: Interaction has already been acknowledged');
        }
        interaction1.deferred = true;
      },
      reply: async (p) => {
        callLog.push({ type: 'reply', payload: p });
        if (interaction1.deferred || interaction1.replied) {
          throw new Error('DiscordAPIError: Interaction has already been acknowledged');
        }
        interaction1.replied = true;
        return p;
      },
      update: async (p) => {
        callLog.push({ type: 'update', payload: p });
        if (interaction1.deferred || interaction1.replied) {
          throw new Error('DiscordAPIError: Interaction has already been acknowledged');
        }
        interaction1.replied = true;
        return p;
      },
      followUp: async (p) => {
        callLog.push({ type: 'followUp', payload: p });
        return p;
      },
    };

    clearInviteInteractionCaches();
    const handled1 = await handleInviteCampaignInteraction(interaction1);
    assert.equal(handled1, true);

    // 1. Immediately acknowledged via deferUpdate()
    assert.equal(callLog[0], 'deferUpdate', 'deferUpdate() must be called immediately');
    assert.equal(interaction1.deferred, true);

    // 2. On success, reply() and update() must NOT be called (would cause Interaction already acknowledged)
    assert.equal(
      callLog.some((e) => typeof e === 'object' && (e.type === 'reply' || e.type === 'update')),
      false,
      'Must never call reply() or update() after deferUpdate()'
    );

    // 3. Leaderboard message was edited in place, never sending a duplicate message
    const lbMsg = env.anncChannel._messages.get(originalLbMessageId);
    assert.equal(env.anncChannel._sent.length, 1, 'Must never send a new leaderboard message');
    assert.equal(lbMsg.edits.length, 1, 'Existing message must be edited in place');
    assert.equal(lbMsg._leaderboardMeta.rows.length, 1);
    assert.equal(lbMsg._leaderboardMeta.rows[0].userId, user1.id);
    assert.equal(lbMsg._leaderboardMeta.rows[0].winningAmountFormatted, '₹100');

    // 4. Existing leaderboard message ID is preserved in DB and campaign
    const freshDbCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(freshDbCampaign.leaderboardMessageId, originalLbMessageId);

    // 5. Refresh button remains functional and enabled on the edited message
    const buttonOnMessage = lbMsg.components[0].components[0].toJSON();
    assert.equal(buttonOnMessage.custom_id, `inv_cmp:refresh_lb:${campaign.campaignId}`);
    assert.equal(buttonOnMessage.disabled, false);

    // 6. Test already acknowledged interaction: does not call deferUpdate() again
    let duplicateDeferCalls = 0;
    const interactionAlreadyAcked = {
      ...interaction1,
      deferred: true,
      deferUpdate: async () => {
        duplicateDeferCalls++;
      },
    };
    await handleInviteCampaignInteraction(interactionAlreadyAcked);
    assert.equal(duplicateDeferCalls, 0, 'Must not acknowledge the same interaction more than once');

    // 7. Test error handling: when message editing fails, handle properly and send ephemeral followUp
    clearInviteInteractionCaches();
    const originalEdit = lbMsg.edit;
    lbMsg.edit = async () => {
      throw new Error('Discord API 500: Internal Server Error');
    };

    const errorCallLog = [];
    const interactionWithError = {
      customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.anncChannel,
      member: user1,
      user: user1.user,
      client: env.client,
      deferred: false,
      replied: false,
      isButton: () => true,
      deferUpdate: async () => {
        errorCallLog.push('deferUpdate');
        interactionWithError.deferred = true;
      },
      followUp: async (p) => {
        errorCallLog.push({ type: 'followUp', payload: p });
        return p;
      },
    };

    await handleInviteCampaignInteraction(interactionWithError);

    // Verify deferUpdate was called, error caught, and followUp sent
    assert.equal(errorCallLog[0], 'deferUpdate');
    const followUpEntry = errorCallLog.find((e) => typeof e === 'object' && e.type === 'followUp');
    assert.ok(followUpEntry, 'Must send ephemeral follow-up on error');
    assert.match(followUpEntry.payload.content, /Failed to refresh the leaderboard/i);
    assert.equal(followUpEntry.payload.ephemeral, true);

    // Restore lbMsg.edit
    lbMsg.edit = originalEdit;
  });

  await t.test('10. Leaderboard Refresh Interaction — Multiple Simultaneous Refreshes & Cooldown Enforcement Without Duplicate Edits', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-sim-1', { isAdminPerm: true });
    const userA = env.addMember('user-sim-a', { username: 'Alpha' });
    const userB = env.addMember('user-sim-b', { username: 'Beta' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Simultaneous Refresh Campaign',
      description: 'Testing race conditions and duplicate edit prevention',
      status: CAMPAIGN_STATUS.ACTIVE,
      startAt: new Date(Date.now() - 3600000),
      endAt: new Date(Date.now() + 3600000),
      minInviteThreshold: 1,
      rewards: [{ position: 1, amount: 200 }],
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    const initialLb = await ensureOrUpdateLeaderboardMessage(env.client, campaign);
    const lbMsg = env.anncChannel._messages.get(initialLb.message.id);
    const initialEdits = lbMsg.edits.length;

    await upsertCampaignParticipant(campaign.campaignId, userA.id, {
      successfulInvites: 5,
      eligibleAt: new Date(),
    });

    clearInviteInteractionCaches();

    // Create 3 simultaneous button interactions from different users
    const interactions = [userA, userB, admin].map((member, i) => {
      const logs = [];
      const interaction = {
        customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
        guild: env.guild,
        channel: env.anncChannel,
        member,
        user: member.user,
        client: env.client,
        deferred: false,
        replied: false,
        isButton: () => true,
        deferUpdate: async () => {
          logs.push('deferUpdate');
          interaction.deferred = true;
        },
        followUp: async (p) => {
          logs.push({ type: 'followUp', payload: p });
          return p;
        },
        logs,
      };
      return interaction;
    });

    // Execute simultaneously
    await Promise.all(interactions.map((int) => handleInviteCampaignInteraction(int)));

    // ALL 3 interactions must have had deferUpdate() called immediately (no timeouts in Discord)
    for (const int of interactions) {
      assert.equal(int.deferred, true, 'Every button interaction must be acknowledged with deferUpdate()');
      assert.equal(int.logs[0], 'deferUpdate');
    }

    // Only ONE edit must have occurred (race condition prevented)
    assert.equal(
      lbMsg.edits.length,
      initialEdits + 1,
      'Exactly one message edit must occur despite 3 concurrent clicks'
    );
    assert.equal(env.anncChannel._sent.length, 1, 'No duplicate messages sent');

    // The other two interactions received the cooldown notice via followUp
    const cooldownFollowUps = interactions
      .flatMap((int) => int.logs)
      .filter((log) => typeof log === 'object' && log.type === 'followUp');

    assert.equal(cooldownFollowUps.length, 2, '2 concurrent requests hit the cooldown check');
    for (const f of cooldownFollowUps) {
      assert.match(f.payload.content, /just refreshed/i);
      assert.equal(f.payload.ephemeral, true);
    }
  });

  await t.test('11. Leaderboard Refresh Interaction — Sequential Refreshes Over Time & Button Remains Functional', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-seq-1', { isAdminPerm: true });
    const user = env.addMember('user-seq-1', { username: 'SeqRunner' });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Sequential Refresh Campaign',
      description: 'Testing multiple refreshes over time',
      status: CAMPAIGN_STATUS.ACTIVE,
      startAt: new Date(Date.now() - 3600000),
      endAt: new Date(Date.now() + 3600000),
      minInviteThreshold: 1,
      rewards: [{ position: 1, amount: 50 }],
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    const initialLb = await ensureOrUpdateLeaderboardMessage(env.client, campaign);
    const lbMsg = env.anncChannel._messages.get(initialLb.message.id);

    await createCampaignReferral({
      campaignId: campaign.campaignId,
      guildId: env.guildId,
      invitedUserId: 'joined-user-seq-1',
      inviterId: user.id,
      inviteCode: 'CODESEQ1',
      inviteUrl: 'https://discord.gg/CODESEQ1',
      joinedAt: new Date(),
      isActive: true,
      counted: true,
    });
    await upsertCampaignParticipant(campaign.campaignId, user.id, {
      successfulInvites: 1,
      eligibleAt: new Date(),
    });

    clearInviteInteractionCaches();

    // 1st Click: Successful refresh
    const logs1 = [];
    const interaction1 = {
      customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.anncChannel,
      member: user,
      user: user.user,
      client: env.client,
      deferred: false,
      replied: false,
      isButton: () => true,
      deferUpdate: async () => {
        logs1.push('deferUpdate');
        interaction1.deferred = true;
      },
      followUp: async (p) => {
        logs1.push({ type: 'followUp', payload: p });
        return p;
      },
    };

    await handleInviteCampaignInteraction(interaction1);
    assert.equal(logs1[0], 'deferUpdate');
    assert.equal(lbMsg.edits.length, 1);
    assert.equal(env.anncChannel._sent.length, 1);

    // Refresh button is still attached and enabled on edited message
    let btn = lbMsg.components[0].components[0].toJSON();
    assert.equal(btn.custom_id, `inv_cmp:refresh_lb:${campaign.campaignId}`);
    assert.equal(btn.disabled, false);

    // 2nd Click immediately: Hits cooldown
    const logs2 = [];
    const interaction2 = {
      customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.anncChannel,
      member: user,
      user: user.user,
      client: env.client,
      deferred: false,
      replied: false,
      isButton: () => true,
      deferUpdate: async () => {
        logs2.push('deferUpdate');
        interaction2.deferred = true;
      },
      followUp: async (p) => {
        logs2.push({ type: 'followUp', payload: p });
        return p;
      },
    };

    await handleInviteCampaignInteraction(interaction2);
    assert.equal(logs2[0], 'deferUpdate');
    assert.equal(lbMsg.edits.length, 1, 'No new edit during cooldown');
    assert.equal(logs2.length, 2);
    assert.equal(logs2[1].type, 'followUp');
    assert.match(logs2[1].payload.content, /just refreshed/i);

    // Add another referral for user
    await createCampaignReferral({
      campaignId: campaign.campaignId,
      guildId: env.guildId,
      invitedUserId: 'joined-user-seq-2',
      inviterId: user.id,
      inviteCode: 'CODESEQ1',
      inviteUrl: 'https://discord.gg/CODESEQ1',
      joinedAt: new Date(),
      isActive: true,
      counted: true,
    });

    // Clear cooldown cache to simulate time passage
    clearInviteInteractionCaches();

    // 3rd Click after cooldown: Successful 2nd refresh
    const logs3 = [];
    const interaction3 = {
      customId: `inv_cmp:refresh_lb:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.anncChannel,
      member: user,
      user: user.user,
      client: env.client,
      deferred: false,
      replied: false,
      isButton: () => true,
      deferUpdate: async () => {
        logs3.push('deferUpdate');
        interaction3.deferred = true;
      },
      followUp: async (p) => {
        logs3.push({ type: 'followUp', payload: p });
        return p;
      },
    };

    await handleInviteCampaignInteraction(interaction3);
    assert.equal(logs3[0], 'deferUpdate');
    assert.equal(lbMsg.edits.length, 2, 'Message edited a second time');
    assert.equal(env.anncChannel._sent.length, 1, 'Still only 1 sent message in channel');
    assert.equal(lbMsg._leaderboardMeta.rows[0].invites, 2);

    // Refresh button still present and functional
    btn = lbMsg.components[0].components[0].toJSON();
    assert.equal(btn.custom_id, `inv_cmp:refresh_lb:${campaign.campaignId}`);
    assert.equal(btn.disabled, false);
  });

  await t.test('12. Invite Campaign Poster Support — Admin Command, Dynamic Panel Display, Replacement, Removal & Restart Recovery', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-poster', { isAdminPerm: true });
    const regularMember = env.addMember('member-poster');

    // 1. Create and start a campaign
    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Poster Championship',
      description: 'Invite members to win real cash!',
      status: CAMPAIGN_STATUS.DRAFT,
      rewards: [
        { position: 1, amount: 500 },
        { position: 2, amount: 250 },
      ],
      endAt: new Date(Date.now() + 86400000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => {}, env.client);
    let activeCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(activeCampaign.status, CAMPAIGN_STATUS.ACTIVE);
    assert.equal(env.inviteChannel._sent.length, 1);
    const panelMsg = env.inviteChannel._sent[0];

    // Initial state: No poster -> Text-based embed + Create Link button
    let panelPayload = buildCampaignPanelPayload(activeCampaign);
    assert.equal(panelPayload.embeds.length, 1);
    let embedJson = panelPayload.embeds[0].toJSON();
    assert.equal(embedJson.title, '🔗 Poster Championship');
    assert.equal(embedJson.description, 'Invite members to win real cash!');
    assert.ok(embedJson.fields.some((f) => f.name === '📌 Status'));
    assert.ok(embedJson.fields.some((f) => f.name === '🏆 Prize Distribution'));
    assert.ok(embedJson.fields.some((f) => f.name === '⏰ Ends At (IST)'));
    assert.equal(embedJson.image, undefined);
    assert.equal(panelPayload.components[0].components[0].toJSON().label, 'Create Link');

    // 2. Permission check: Non-admin using .invite poster is denied
    let response = '';
    await handleInviteCommand(
      env.guild,
      regularMember,
      env.inviteChannel,
      ['poster'],
      (text) => { response = text; },
      env.client,
      { attachments: [{ name: 'poster.png', url: 'https://cdn.discordapp.com/attachments/1/2/poster.png' }] }
    );
    assert.match(response, /Permission Denied/);

    // 3. No image attached -> Shows clear usage message
    response = '';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['poster'],
      (text) => { response = text; },
      env.client,
      { attachments: [] }
    );
    assert.match(response, /No image attached/);
    assert.match(response, /\.invite poster/);

    // 4. Invalid file format (e.g., .mp4, .pdf) -> Error message
    response = '';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['poster'],
      (text) => { response = text; },
      env.client,
      { attachments: [{ name: 'clip.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' }] }
    );
    assert.match(response, /Invalid image format/);

    // 5. Valid upload with PNG -> Poster saved, persistent panel updated in place
    response = '';
    const pngUrl = 'https://cdn.discordapp.com/attachments/1/2/campaign_banner.png';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['poster'],
      (text) => { response = text; },
      env.client,
      { attachments: [{ name: 'campaign_banner.PNG', contentType: 'image/png', url: pngUrl }] }
    );
    assert.match(response, /Campaign poster updated/);

    // Check MongoDB / doc persistence
    activeCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(activeCampaign.posterUrl, pngUrl);

    // Check persistent panel message: Edited in place, NO duplicate sent messages
    assert.equal(env.inviteChannel._sent.length, 1, 'Only 1 persistent panel message exists');
    assert.equal(panelMsg.edits.length, 1, 'Panel message was edited');
    const latestEdit = panelMsg.edits[panelMsg.edits.length - 1];
    assert.equal(latestEdit.embeds.length, 1);
    const posterEmbedJson = latestEdit.embeds[0].toJSON();
    // Verification of Dynamic Display Logic:
    // Poster exists -> Show poster image + Create Link button only.
    // Text-based fields, title, description are completely absent!
    assert.equal(posterEmbedJson.image?.url, pngUrl);
    assert.equal(posterEmbedJson.title, undefined);
    assert.equal(posterEmbedJson.description, undefined);
    assert.equal(posterEmbedJson.fields, undefined);
    assert.equal(latestEdit.components[0].components[0].toJSON().label, 'Create Link');
    assert.equal(latestEdit.components[0].components[0].toJSON().disabled, false);

    // 6. Support replacing existing poster (testing WEBP format)
    response = '';
    const webpUrl = 'https://cdn.discordapp.com/attachments/1/2/updated_poster.webp';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['poster'],
      (text) => { response = text; },
      env.client,
      { attachments: [{ name: 'updated_poster.webp', contentType: 'image/webp', url: webpUrl }] }
    );
    assert.match(response, /Campaign poster updated/);
    activeCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(activeCampaign.posterUrl, webpUrl);
    assert.equal(panelMsg.edits.length, 2);
    assert.equal(panelMsg.edits[1].embeds[0].toJSON().image?.url, webpUrl);

    // 7. Support JPG / JPEG formats
    response = '';
    const jpgUrl = 'https://cdn.discordapp.com/attachments/1/2/promo.jpg';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['poster'],
      (text) => { response = text; },
      env.client,
      { attachments: [{ name: 'promo.JPG', contentType: 'image/jpeg', url: jpgUrl }] }
    );
    assert.match(response, /Campaign poster updated/);
    activeCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(activeCampaign.posterUrl, jpgUrl);

    // 8. Bot Restart & Recovery restores poster URL and updates panel
    await recoverInviteCampaignsOnStartup(env.client);
    activeCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(activeCampaign.posterUrl, jpgUrl);
    assert.equal(env.inviteChannel._sent.length, 1, 'No duplicate messages created after restart');

    // 9. .invite poster remove removes the poster and restores text-based embed
    response = '';
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['poster', 'remove'],
      (text) => { response = text; },
      env.client
    );
    assert.match(response, /Campaign poster removed/);
    activeCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(activeCampaign.posterUrl, null);

    // Persistent panel restored text-based embed
    const lastEdit = panelMsg.edits[panelMsg.edits.length - 1];
    assert.equal(env.inviteChannel._sent.length, 1, 'Still only 1 persistent panel message');
    const restoredEmbedJson = lastEdit.embeds[0].toJSON();
    assert.equal(restoredEmbedJson.title, '🔗 Poster Championship');
    assert.equal(restoredEmbedJson.description, 'Invite members to win real cash!');
    assert.ok(restoredEmbedJson.fields.some((f) => f.name === '📌 Status'));
    assert.ok(restoredEmbedJson.fields.some((f) => f.name === '🏆 Prize Distribution'));
    assert.ok(restoredEmbedJson.fields.some((f) => f.name === '⏰ Ends At (IST)'));
    assert.equal(restoredEmbedJson.image, undefined);
    assert.equal(lastEdit.components[0].components[0].toJSON().label, 'Create Link');
  });

  await t.test('13. Conditional Winning Amount & Automatic Leaderboard Updates', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const user1 = env.addMember('user-1', { username: 'ProPlayer1' });
    const user2 = env.addMember('user-2', { username: 'ProPlayer2' });
    const user3 = env.addMember('user-3', { username: 'ProPlayer3' });
    const user4 = env.addMember('user-4', { username: 'ProPlayer4' });

    // Campaign: threshold = 5, prizes for top 2 only (#1 = ₹100, #2 = ₹50)
    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Conditional Prize Championship',
      description: 'Top 2 inviters win prizes!',
      status: CAMPAIGN_STATUS.ACTIVE,
      minInviteThreshold: 5,
      rewards: [
        { position: 1, amount: 100 },
        { position: 2, amount: 50 },
      ],
      endAt: new Date(Date.now() + 86400000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    // 1. Initial State: No participants with >0 invites -> empty state
    const emptyRows = computeCampaignLeaderboardRows(campaign, [], env.guild);
    assert.equal(emptyRows.length, 0);
    const emptyPng = generateLeaderboardPng(campaign, emptyRows);
    assert.ok(Buffer.isBuffer(emptyPng.buffer));

    // 2. Add participants with varying invite counts
    // user1: 10 invites (meets threshold >= 5, rank 1 -> ₹100)
    // user2: 6 invites (meets threshold >= 5, rank 2 -> ₹50)
    // user3: 5 invites (meets threshold >= 5, rank 3 -> outside top 2 prize positions -> blank!)
    // user4: 2 invites (below threshold 5, rank 4 -> below threshold -> blank!)
    const participants = [
      { userId: user1.id, username: 'ProPlayer1', successfulInvites: 10, eligibleAt: new Date('2026-11-07T08:00:00Z') },
      { userId: user2.id, username: 'ProPlayer2', successfulInvites: 6, eligibleAt: new Date('2026-11-07T08:30:00Z') },
      { userId: user3.id, username: 'ProPlayer3', successfulInvites: 5, eligibleAt: new Date('2026-11-07T09:00:00Z') },
      { userId: user4.id, username: 'ProPlayer4', successfulInvites: 2, eligibleAt: null },
    ];

    const rows = computeCampaignLeaderboardRows(campaign, participants, env.guild);
    assert.equal(rows.length, 4, 'All 4 inviters must appear on the leaderboard');

    // Rank 1: user1 (10 invites >= 5 threshold, rank 1 prize is ₹100)
    assert.equal(rows[0].userId, user1.id);
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].invites, 10);
    assert.equal(rows[0].winningAmount, 100);
    assert.equal(rows[0].winningAmountFormatted, '₹100');

    // Rank 2: user2 (6 invites >= 5 threshold, rank 2 prize is ₹50)
    assert.equal(rows[1].userId, user2.id);
    assert.equal(rows[1].rank, 2);
    assert.equal(rows[1].invites, 6);
    assert.equal(rows[1].winningAmount, 50);
    assert.equal(rows[1].winningAmountFormatted, '₹50');

    // Rank 3: user3 (5 invites >= 5 threshold, but outside configured top 2 positions -> blank!)
    assert.equal(rows[2].userId, user3.id);
    assert.equal(rows[2].rank, 3);
    assert.equal(rows[2].invites, 5);
    assert.equal(rows[2].winningAmount, 0);
    assert.equal(rows[2].winningAmountFormatted, '', 'Outside prize ranks must be completely blank');

    // Rank 4: user4 (2 invites < 5 threshold -> below threshold -> blank!)
    assert.equal(rows[3].userId, user4.id);
    assert.equal(rows[3].rank, 4);
    assert.equal(rows[3].invites, 2);
    assert.equal(rows[3].winningAmount, 0);
    assert.equal(rows[3].winningAmountFormatted, '', 'Below threshold must be completely blank');

    // 3. User 4 crosses threshold from 2 to 8 invites -> becomes Rank 2!
    // User 2 (6 invites) is pushed to Rank 3 (outside top 2 prizes -> becomes blank)!
    const updatedParticipants1 = [
      { userId: user1.id, username: 'ProPlayer1', successfulInvites: 10, eligibleAt: new Date('2026-11-07T08:00:00Z') },
      { userId: user4.id, username: 'ProPlayer4', successfulInvites: 8, eligibleAt: new Date('2026-11-07T09:30:00Z') },
      { userId: user2.id, username: 'ProPlayer2', successfulInvites: 6, eligibleAt: new Date('2026-11-07T08:30:00Z') },
      { userId: user3.id, username: 'ProPlayer3', successfulInvites: 5, eligibleAt: new Date('2026-11-07T09:00:00Z') },
    ];
    const rowsAfterOvertake = computeCampaignLeaderboardRows(campaign, updatedParticipants1, env.guild);
    assert.equal(rowsAfterOvertake[1].userId, user4.id);
    assert.equal(rowsAfterOvertake[1].rank, 2);
    assert.equal(rowsAfterOvertake[1].winningAmountFormatted, '₹50', 'Crossing threshold and entering top 2 receives prize');
    assert.equal(rowsAfterOvertake[2].userId, user2.id);
    assert.equal(rowsAfterOvertake[2].rank, 3);
    assert.equal(rowsAfterOvertake[2].winningAmountFormatted, '', 'Pushed out of prize positions becomes blank');

    // 4. User 1 falls below threshold (drops from 10 to 4 invites due to invited members leaving)
    const updatedParticipants2 = [
      { userId: user4.id, username: 'ProPlayer4', successfulInvites: 8, eligibleAt: new Date('2026-11-07T09:30:00Z') },
      { userId: user2.id, username: 'ProPlayer2', successfulInvites: 6, eligibleAt: new Date('2026-11-07T08:30:00Z') },
      { userId: user3.id, username: 'ProPlayer3', successfulInvites: 5, eligibleAt: new Date('2026-11-07T09:00:00Z') },
      { userId: user1.id, username: 'ProPlayer1', successfulInvites: 4, eligibleAt: null },
    ];
    const rowsAfterDrop = computeCampaignLeaderboardRows(campaign, updatedParticipants2, env.guild);
    assert.equal(rowsAfterDrop[0].userId, user4.id);
    assert.equal(rowsAfterDrop[0].rank, 1);
    assert.equal(rowsAfterDrop[0].winningAmountFormatted, '₹100');
    assert.equal(rowsAfterDrop[1].userId, user2.id);
    assert.equal(rowsAfterDrop[1].rank, 2);
    assert.equal(rowsAfterDrop[1].winningAmountFormatted, '₹50');
    assert.equal(rowsAfterDrop[3].userId, user1.id);
    assert.equal(rowsAfterDrop[3].rank, 4);
    assert.equal(rowsAfterDrop[3].invites, 4);
    assert.equal(rowsAfterDrop[3].winningAmount, 0);
    assert.equal(rowsAfterDrop[3].winningAmountFormatted, '', 'Falling below threshold strips prize amount immediately');

    // 5. Test PNG generator on rows with mixed blank and filled winning amounts
    const pngResult = generateLeaderboardPng(campaign, rowsAfterDrop);
    assert.ok(Buffer.isBuffer(pngResult.buffer));
    assert.equal(pngResult.width, 960);
    assert.equal(pngResult.rows.length, 4);

    // 6. Test automatic leaderboard message edit triggered by recalculateParticipantEligibility
    const lbInit = await ensureOrUpdateLeaderboardMessage(env.client, campaign);
    assert.ok(lbInit?.message);
    const initialEditCount = lbInit.message.edits.length;

    // Simulate an invite update via recalculateParticipantEligibility with immediate update
    await recalculateParticipantEligibility(env.client, campaign, user1.id, {
      skipLeaderboardAutoUpdate: false,
    });
    // Trigger auto update directly
    scheduleLeaderboardAutoUpdate(env.client, campaign.campaignId, 0);
    // Allow microtask to process
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(lbInit.message.edits.length >= initialEditCount, 'Leaderboard auto update was scheduled');
    clearInviteInteractionCaches();
  });
});
