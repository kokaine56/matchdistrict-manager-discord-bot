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
  createInviteCampaign,
  getInviteCampaignById,
  getCurrentGuildCampaign,
  getCampaignInvitesForCampaign,
  getCampaignReferral,
  getReferralsForCampaign,
  getCampaignParticipant,
  getEligibleParticipantsForCampaign,
  getUnattributedJoinsForCampaign,
  handleInviteCommand,
  handleInviteCampaignInteraction,
  handleInviteCampaignMemberAdd,
  handleInviteCampaignMemberRemove,
  handleInviteCampaignInviteCreate,
  handleInviteCampaignInviteDelete,
  evaluateAndArmCampaignTimers,
  evaluateDueReferral,
  recoverInviteCampaignsOnStartup,
  GENERATE_BUTTON_COOLDOWN_MS,
} from '../bot/discord/features/inviteCampaign/index.js';
import {
  handleMessageModeration,
  handleMessageUpdateModeration,
} from '../moderationService.js';
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
          edits: [],
          edit: async (editPayload) => {
            msgObj.content =
              typeof editPayload === 'string' ? editPayload : editPayload?.content ?? msgObj.content;
            msgObj.embeds = editPayload?.embeds ?? msgObj.embeds;
            msgObj.components = editPayload?.components ?? msgObj.components;
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

  const addMember = (id, { bot = false, isAdminPerm = false, accountAgeDays = 30, joinedAt = new Date() } = {}) => {
    const createdTimestamp = Date.now() - accountAgeDays * 24 * 60 * 60 * 1000;
    const member = {
      id,
      guild,
      client,
      displayName: `User_${id}`,
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
        username: `user_${id}`,
        tag: `user_${id}#0001`,
        createdTimestamp,
        createdAt: new Date(createdTimestamp),
        send: async (msg) => {
          dmsSent.push({ userId: id, msg });
          return { id: `dm-${dmsSent.length}` };
        },
      },
      send: async (msg) => {
        if (options.closedDmsFor?.includes(id)) {
          const err = new Error('Cannot send messages to this user');
          err.code = 50007;
          throw err;
        }
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

test('Invite & Earn Campaign System — Full Lifecycle, Tracking, Counting, Moderation & Recovery', async (t) => {
  t.beforeEach(() => {
    stopInviteCampaignScheduler();
    clearInMemoryInviteCampaignData();
    clearInviteSnapshotState();
    clearInviteInteractionCaches();
  });

  t.after(() => {
    stopInviteCampaignScheduler();
  });

  await t.test('1. IST Date Parsing & Formatting and Single Active Campaign Constraint', async () => {
    const parsed = parseISTDateTime('15-11-2026 18:30');
    assert.equal(parsed.valid, true);
    // 18:30 IST is 13:00 UTC
    assert.equal(parsed.date.toISOString(), '2026-11-15T13:00:00.000Z');
    assert.equal(formatISTDateTime(parsed.date), '15-11-2026 18:30 IST');

    const badDate = parseISTDateTime('31-02-2026 12:00');
    assert.equal(badDate.valid, false);

    // Partial unique constraint: only one Draft/Scheduled/Active/Paused campaign per guild
    const c1 = await createInviteCampaign({
      guildId: 'g-1',
      name: 'Campaign 1',
      description: 'Desc',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 86400000),
      requiredInvites: 5,
      inviteChannelId: 'ch-1',
      announcementChannelId: 'ch-2',
      createdBy: 'admin-1',
    });
    assert.ok(c1.campaignId);

    await assert.rejects(
      () =>
        createInviteCampaign({
          guildId: 'g-1',
          name: 'Campaign 2',
          description: 'Desc',
          status: CAMPAIGN_STATUS.SCHEDULED,
          endAt: new Date(Date.now() + 86400000),
          requiredInvites: 5,
          inviteChannelId: 'ch-1',
          announcementChannelId: 'ch-2',
          createdBy: 'admin-1',
        }),
      (err) => err.code === 11000
    );
  });

  await t.test('2. Admin Create Flow (Button -> Modal -> Channel Selects -> Confirm) & Settings Commands', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const regularUser = env.addMember('user-regular', { isAdminPerm: false });

    // Non-admin cannot run .invite create
    const nonAdminReplies = [];
    await handleInviteCommand(
      env.guild,
      regularUser,
      env.inviteChannel,
      ['create'],
      async (msg) => nonAdminReplies.push(msg),
      env.client
    );
    assert.match(String(nonAdminReplies[0]), /Permission Denied/i);

    // Admin runs .invite create -> gets button to open modal
    const adminReplies = [];
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['create'],
      async (msg) => adminReplies.push(msg),
      env.client
    );
    assert.equal(adminReplies.length, 1);
    assert.ok(adminReplies[0].components);

    // Click open modal button
    let shownModal = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:open_create_modal:${admin.id}`,
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isButton: () => true,
      showModal: async (modal) => {
        shownModal = modal;
      },
    });
    assert.ok(shownModal);

    // Submit modal with Draft start time ("DRAFT") and future end time
    let modalReply = null;
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
            name: 'Winter Giveaway',
            description: 'Invite 3 friends to win!',
            startAt: 'DRAFT',
            endAt: '25-12-2027 23:59',
            requiredInvites: '3',
          };
          return map[field];
        },
      },
      reply: async (payload) => {
        modalReply = payload;
      },
    });
    assert.ok(modalReply);
    assert.equal(modalReply.components.length, 3);

    // Select Invite Channel and Announcement Channel
    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:select_invite_channel',
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isChannelSelectMenu: () => true,
      values: [env.inviteChannel.id],
      update: async () => {},
    });
    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:select_annc_channel',
      guild: env.guild,
      member: admin,
      user: env.client,
      user: admin.user,
      client: env.client,
      isChannelSelectMenu: () => true,
      values: [env.anncChannel.id],
      update: async () => {},
    });

    // Confirm campaign creation
    let confirmUpdate = null;
    await handleInviteCampaignInteraction({
      customId: 'inv_cmp:confirm_create',
      guild: env.guild,
      member: admin,
      user: admin.user,
      client: env.client,
      isButton: () => true,
      update: async (payload) => {
        confirmUpdate = payload;
      },
    });
    assert.match(confirmUpdate.content, /created as `Draft`/i);

    const campaign = await getCurrentGuildCampaign(env.guildId);
    assert.equal(campaign.name, 'Winter Giveaway');
    assert.equal(campaign.status, CAMPAIGN_STATUS.DRAFT);
    assert.equal(campaign.requiredInvites, 3);
    assert.equal(campaign.stayHours, 24);
    assert.equal(campaign.minAccountAgeDays, 7);
    assert.ok(campaign.panelMessageId);

    // Panel button is disabled while Draft
    const panelMsg = env.inviteChannel._messages.get(campaign.panelMessageId);
    assert.ok(panelMsg);
    const panelBtn = panelMsg.components[0].components[0].data;
    assert.equal(panelBtn.disabled, true);

    // Configure stay and accountage while Draft
    const setReplies = [];
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['set', 'stay', '0'],
      async (m) => setReplies.push(m),
      env.client
    );
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['set', 'accountage', '5'],
      async (m) => setReplies.push(m),
      env.client
    );
    const updatedCampaign = await getCurrentGuildCampaign(env.guildId);
    assert.equal(updatedCampaign.stayHours, 0);
    assert.equal(updatedCampaign.minAccountAgeDays, 5);
  });

  await t.test('3. Missing Intents/Permissions Check, Unique Invites, Tracking, Counting, Leave/Rejoin & Eligibility', async () => {
    // Verify missing permissions prevent starting
    const badEnv = createTestEnvironment({ botManageGuild: false });
    const badAdmin = badEnv.addMember('admin-bad', { isAdminPerm: true });
    await createInviteCampaign({
      guildId: badEnv.guildId,
      name: 'Perm Check Campaign',
      description: 'Test',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 3600000),
      requiredInvites: 2,
      inviteChannelId: badEnv.inviteChannel.id,
      announcementChannelId: badEnv.anncChannel.id,
      createdBy: badAdmin.id,
    });
    const badStartReplies = [];
    await handleInviteCommand(
      badEnv.guild,
      badAdmin,
      badEnv.inviteChannel,
      ['start'],
      async (m) => badStartReplies.push(m),
      badEnv.client
    );
    assert.match(String(badStartReplies[0]), /Manage Server/i);

    // Now test full happy path & edge cases with valid permissions
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const inviter = env.addMember('inviter-1', { isAdminPerm: false });
    const preExistingMember = env.addMember('pre-existing-1', { isAdminPerm: false });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Main Invite Campaign',
      description: 'Bring 2 members!',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 7200000),
      requiredInvites: 2,
      stayHours: 1, // 1 hour stay period
      minAccountAgeDays: 7,
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    // Start campaign
    const startReplies = [];
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['start'],
      async (m) => startReplies.push(m),
      env.client
    );
    assert.match(String(startReplies[0]), /is now `Active`/i);

    // Inviter clicks "Generate My Invite"
    let genReply1 = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member: inviter,
      user: inviter.user,
      client: env.client,
      isButton: () => true,
      reply: async (p) => {
        genReply1 = p;
      },
      editReply: async (p) => {
        genReply1 = p;
      },
    });
    assert.match(genReply1.content, /Your Progress: 0 \/ 2 successful invites/);
    assert.match(genReply1.content, /Your Invite Link: https:\/\/discord\.gg\//);
    assert.match(genReply1.content, /Status: Not Eligible/);

    const savedInvites = await getCampaignInvitesForCampaign(campaign.campaignId);
    assert.equal(savedInvites.length, 1);
    const invCode = savedInvites[0].inviteCode;

    // Clicking again after cooldown returns the exact same link without creating a second invite
    await new Promise((r) => setTimeout(r, 10));
    clearInviteInteractionCaches(); // reset button cooldown for immediate test click
    let genReply2 = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member: inviter,
      user: inviter.user,
      client: env.client,
      isButton: () => true,
      reply: async (p) => {
        genReply2 = p;
      },
      editReply: async (p) => {
        genReply2 = p;
      },
    });
    assert.equal((await getCampaignInvitesForCampaign(campaign.campaignId)).length, 1);
    assert.ok(genReply2.content.includes(invCode));

    // Member 1 joins via inviter's link (valid account age 30 days)
    env.invites.get(invCode).uses = 1;
    const joined1 = env.addMember('invited-1', { accountAgeDays: 30 });
    await handleInviteCampaignMemberAdd(joined1);

    // Referral is pending until 1-hour stay period completes
    let ref1 = await getCampaignReferral(campaign.campaignId, env.guildId, joined1.id);
    assert.equal(ref1.isActive, true);
    assert.equal(ref1.counted, false);
    let part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 0);
    assert.equal(part.pendingInvites, 1);

    // Fast-forward 1 hour and evaluate due referral
    const futureNow = new Date(Date.now() + 2 * 3600 * 1000);
    await evaluateDueReferral(env.client, await getInviteCampaignById(campaign.campaignId), ref1, futureNow);

    ref1 = await getCampaignReferral(campaign.campaignId, env.guildId, joined1.id);
    assert.equal(ref1.counted, true);
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
    assert.equal(part.pendingInvites, 0);
    assert.equal(part.isEligible, false);

    // Pre-existing member leaves and rejoins via inviter's link -> NEVER counts
    env.invites.get(invCode).uses = 2;
    await handleInviteCampaignMemberAdd(preExistingMember);
    const preRef = await getCampaignReferral(campaign.campaignId, env.guildId, preExistingMember.id);
    assert.equal(preRef.disqualified, true);
    assert.equal(preRef.counted, false);

    // Bot joins -> NEVER counts
    env.invites.get(invCode).uses = 3;
    const botMember = env.addMember('bot-joiner', { bot: true });
    await handleInviteCampaignMemberAdd(botMember);
    assert.equal(await getCampaignReferral(campaign.campaignId, env.guildId, botMember.id), null);

    // Member 2 joins via inviter's link and completes stay period -> Inviter reaches target (2/2) -> Eligible!
    env.invites.get(invCode).uses = 4;
    const joined2 = env.addMember('invited-2', { accountAgeDays: 20 });
    await handleInviteCampaignMemberAdd(joined2);
    const ref2 = await getCampaignReferral(campaign.campaignId, env.guildId, joined2.id);
    await evaluateDueReferral(env.client, await getInviteCampaignById(campaign.campaignId), ref2, futureNow);

    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 2);
    assert.equal(part.isEligible, true);
    assert.equal(part.notified, true);
    assert.equal(env.dmsSent.length, 1); // Congratulation DM sent once

    // Member 2 leaves before campaign ends -> count drops to 1, eligibility is removed!
    env.members.delete(joined2.id);
    await handleInviteCampaignMemberRemove(joined2);
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
    assert.equal(part.isEligible, false);

    // Member 2 rejoins during active campaign (even if another invite changed) -> restores original inviter and restarts stay period
    const joined2Rejoin = env.addMember('invited-2', { accountAgeDays: 20 });
    await handleInviteCampaignMemberAdd(joined2Rejoin);
    const ref2Restored = await getCampaignReferral(campaign.campaignId, env.guildId, joined2.id);
    assert.equal(ref2Restored.inviterId, inviter.id);
    assert.equal(ref2Restored.isActive, true);
    assert.equal(ref2Restored.counted, false); // Pending again until stay period finishes

    // Complete stay period again -> Eligible restored, but NO duplicate congratulation DM sent!
    await evaluateDueReferral(
      env.client,
      await getInviteCampaignById(campaign.campaignId),
      ref2Restored,
      new Date(Date.now() + 3 * 3600 * 1000)
    );
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 2);
    assert.equal(part.isEligible, true);
    assert.equal(env.dmsSent.length, 1); // Still 1 (no duplicate DM)

    // Ambiguous join (no invite usage delta) -> recorded in UnattributedJoin for .invite review
    const mysteryJoiner = env.addMember('mystery-user', { accountAgeDays: 30 });
    await handleInviteCampaignMemberAdd(mysteryJoiner);
    const unattributed = await getUnattributedJoinsForCampaign(campaign.campaignId);
    assert.equal(unattributed.length, 1);
    assert.equal(unattributed[0].userId, mysteryJoiner.id);

    // Pause stops new joins from being counted
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['pause'], async () => {}, env.client);
    env.invites.get(invCode).uses = 5;
    const pausedJoiner = env.addMember('paused-joiner', { accountAgeDays: 30 });
    await handleInviteCampaignMemberAdd(pausedJoiner);
    assert.equal(await getCampaignReferral(campaign.campaignId, env.guildId, pausedJoiner.id), null);

    // Resume campaign
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['resume'], async () => {}, env.client);

    // Disqualify a single referral by invited user -> drops inviter count
    const dqReplies = [];
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['disqualify', `<@${joined1.id}>`, 'Alt account'],
      async (m) => dqReplies.push(m),
      env.client
    );
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
    assert.equal(part.isEligible, false);

    // End campaign -> deletes campaign invites from Discord, keeps DB records, freezes counts
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['end', 'confirm'],
      async () => {},
      env.client
    );
    const endedCampaign = await getInviteCampaignById(campaign.campaignId);
    assert.equal(endedCampaign.status, CAMPAIGN_STATUS.ENDED);
    assert.ok(env.deletedInviteCodes.includes(invCode));
    assert.equal((await getCampaignInvitesForCampaign(campaign.campaignId)).length, 1);

    // Later leave after Ended must NOT change counts
    env.members.delete(joined2.id);
    await handleInviteCampaignMemberRemove(joined2);
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
  });

  await t.test('4. Moderation Exception — Allows Active/Scheduled Campaign Invite Links Only', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-mod', { isAdminPerm: true });
    const member = env.addMember('member-mod', { isAdminPerm: false });

    // Enable moderation for this test guild
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
      requiredInvites: 5,
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => {}, env.client);

    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member,
      user: member.user,
      client: env.client,
      isButton: () => true,
      reply: async () => {},
      editReply: async () => {},
    });

    const [campaignInvite] = await getCampaignInvitesForCampaign(campaign.campaignId);
    assert.ok(campaignInvite);

    // 1. Posting the active campaign invite link is NOT blocked by moderation
    let deleted1 = false;
    const msgWithAllowedInvite = {
      guild: env.guild,
      channel: env.inviteChannel,
      author: member.user,
      member,
      content: `Join our server with my campaign link: ${campaignInvite.inviteUrl}`,
      delete: async () => {
        deleted1 = true;
      },
    };
    const modResult1 = await handleMessageModeration(msgWithAllowedInvite);
    assert.equal(modResult1, false);
    assert.equal(deleted1, false);

    // 2. Posting a campaign invite link + an external link IS blocked
    let deleted2 = false;
    const msgWithMixedLinks = {
      guild: env.guild,
      channel: env.inviteChannel,
      author: member.user,
      member,
      content: `${campaignInvite.inviteUrl} and also check https://evil-phishing.xyz`,
      delete: async () => {
        deleted2 = true;
      },
    };
    const modResult2 = await handleMessageModeration(msgWithMixedLinks);
    assert.equal(modResult2, true);
    assert.equal(deleted2, true);

    // 3. After campaign ends, posting the old campaign invite link IS blocked
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['end', 'confirm'], async () => {}, env.client);
    let deleted3 = false;
    const msgAfterEnd = {
      guild: env.guild,
      channel: env.inviteChannel,
      author: member.user,
      member,
      content: `Old link: ${campaignInvite.inviteUrl}`,
      delete: async () => {
        deleted3 = true;
      },
    };
    const modResult3 = await handleMessageModeration(msgAfterEnd);
    assert.equal(modResult3, true);
    assert.equal(deleted3, true);

    delete guildSettingsCache[env.guildId];
  });

  await t.test('5. Startup Recovery & Offline Join Reconciliation (Exact vs Ambiguous)', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-rec', { isAdminPerm: true });
    const inviter = env.addMember('inviter-rec', { isAdminPerm: false });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Recovery Campaign',
      description: 'Test',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 3600000),
      requiredInvites: 1,
      stayHours: 0,
      minAccountAgeDays: 7,
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => {}, env.client);
    await ensurePanelForTest(env, campaign.campaignId);

    await handleInviteCampaignInteraction({
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member: inviter,
      user: inviter.user,
      client: env.client,
      isButton: () => true,
      reply: async () => {},
      editReply: async () => {},
    });

    const [campaignInvite] = await getCampaignInvitesForCampaign(campaign.campaignId);

    // Simulate bot offline: 1 new member joins and campaignInvite.uses increases by 1
    clearInviteSnapshotState();
    env.invites.get(campaignInvite.inviteCode).uses = 1;
    const offlineJoiner = env.addMember('offline-joiner-1', {
      accountAgeDays: 30,
      joinedAt: new Date(Date.now() + 1000),
    });

    await recoverInviteCampaignsOnStartup(env.client);
    stopInviteCampaignScheduler();

    const ref = await getCampaignReferral(campaign.campaignId, env.guildId, offlineJoiner.id);
    assert.ok(ref, 'Certain offline join (1 invite +1, 1 new member) must be attributed');
    assert.equal(ref.inviterId, inviter.id);
    assert.equal(ref.counted, true);
  });
});

async function ensurePanelForTest(env, campaignId) {
  const c = await getInviteCampaignById(campaignId);
  return c;
}

