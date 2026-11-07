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
  getCampaignParticipant,
  getUnattributedJoinsForCampaign,
  handleInviteCommand,
  handleInviteCampaignInteraction,
  handleInviteCampaignMemberAdd,
  handleInviteCampaignMemberRemove,
  recoverInviteCampaignsOnStartup,
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

test('Invite & Earn Campaign System — Simplified User Interface, Real-Time Invite Counter & Recovery', async (t) => {
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
    assert.equal(parsed.date.toISOString(), '2026-11-15T13:00:00.000Z');
    assert.equal(formatISTDateTime(parsed.date), '15-11-2026 18:30 IST');

    const c1 = await createInviteCampaign({
      guildId: 'g-1',
      name: 'Campaign 1',
      description: 'Desc',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 86400000),
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
          inviteChannelId: 'ch-1',
          announcementChannelId: 'ch-2',
          createdBy: 'admin-1',
        }),
      (err) => err.code === 11000
    );
  });

  await t.test('2. Admin Create Flow (Button -> Modal -> Channel Selects -> Confirm)', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });

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
            name: 'Winter Invite Counter',
            description: 'Share your link and invite friends!',
            startAt: 'DRAFT',
            endAt: '25-12-2027 23:59',
          };
          return map[field];
        },
      },
      reply: async (payload) => {
        modalReply = payload;
      },
    });
    assert.ok(modalReply);

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
      user: admin.user,
      client: env.client,
      isChannelSelectMenu: () => true,
      values: [env.anncChannel.id],
      update: async () => {},
    });

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
    assert.equal(campaign.name, 'Winter Invite Counter');
    assert.equal(campaign.status, CAMPAIGN_STATUS.DRAFT);
    assert.ok(campaign.panelMessageId);
  });

  await t.test('3. Simplified User Response, Immediate Join Counting, Real-Time View Refresh & Leave/Rejoin', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-1', { isAdminPerm: true });
    const inviter = env.addMember('inviter-1', { isAdminPerm: false });
    const preExistingMember = env.addMember('pre-existing-1', { isAdminPerm: false });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Main Invite Campaign',
      description: 'Invite friends!',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 7200000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });

    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => {}, env.client);

    // Inviter clicks "Generate My Invite"
    let latestUserReply = null;
    const mockInteraction = {
      customId: `inv_cmp:generate:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member: inviter,
      user: inviter.user,
      client: env.client,
      isButton: () => true,
      reply: async (p) => {
        latestUserReply = p;
      },
      editReply: async (p) => {
        latestUserReply = p;
      },
    };
    await handleInviteCampaignInteraction(mockInteraction);

    const savedInvites = await getCampaignInvitesForCampaign(campaign.campaignId);
    assert.equal(savedInvites.length, 1);
    const invCode = savedInvites[0].inviteCode;
    const invUrl = savedInvites[0].inviteUrl;

    // Verify exact simplified user-facing format (no Eligible / Not Eligible status)
    assert.equal(
      latestUserReply.content,
      `Your Successful Invites: 0\nYour Invite Link: ${invUrl}`
    );
    assert.ok(!/Eligible/i.test(latestUserReply.content));
    assert.equal(latestUserReply.components.length, 1); // Refresh button

    // Member 1 joins via inviter's link (even with a 0-day-old account) -> count immediately increases to 1 & live view auto-refreshes!
    env.invites.get(invCode).uses = 1;
    const joined1 = env.addMember('invited-1', { accountAgeDays: 0 });
    await handleInviteCampaignMemberAdd(joined1);

    let part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
    assert.equal(
      latestUserReply.content,
      `Your Successful Invites: 1\nYour Invite Link: ${invUrl}`
    );

    // Member 2 joins via inviter's link -> count immediately increases to 2 & live view auto-refreshes!
    env.invites.get(invCode).uses = 2;
    const joined2 = env.addMember('invited-2', { accountAgeDays: 10 });
    await handleInviteCampaignMemberAdd(joined2);

    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 2);
    assert.equal(
      latestUserReply.content,
      `Your Successful Invites: 2\nYour Invite Link: ${invUrl}`
    );
    assert.equal(env.dmsSent.length, 0, 'No giveaway qualification DMs should be sent');

    // Member 2 leaves -> count immediately decreases by 1 to 1, referral marked inactive & preserved in history
    env.members.delete(joined2.id);
    await handleInviteCampaignMemberRemove(joined2);
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
    assert.equal(
      latestUserReply.content,
      `Your Successful Invites: 1\nYour Invite Link: ${invUrl}`
    );
    const ref2AfterLeave = await getCampaignReferral(campaign.campaignId, env.guildId, joined2.id);
    assert.equal(ref2AfterLeave.isActive, false);
    assert.ok(ref2AfterLeave.leftAt);

    // Member 2 rejoins during active campaign -> restores original inviter and counts again only once (back to 2)
    const joined2Rejoin = env.addMember('invited-2', { accountAgeDays: 10 });
    await handleInviteCampaignMemberAdd(joined2Rejoin);
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 2);
    assert.equal(
      latestUserReply.content,
      `Your Successful Invites: 2\nYour Invite Link: ${invUrl}`
    );

    // Clicking the Refresh button retrieves the latest count
    let refreshOutput = null;
    await handleInviteCampaignInteraction({
      customId: `inv_cmp:refresh:${campaign.campaignId}`,
      guild: env.guild,
      channel: env.inviteChannel,
      member: inviter,
      user: inviter.user,
      client: env.client,
      isButton: () => true,
      update: async (p) => {
        refreshOutput = p;
      },
    });
    assert.equal(
      refreshOutput.content,
      `Your Successful Invites: 2\nYour Invite Link: ${invUrl}`
    );

    // Admin commands: .invite links and .invite history
    const adminReplies = [];
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['links'],
      async (m) => adminReplies.push(m),
      env.client
    );
    await handleInviteCommand(
      env.guild,
      admin,
      env.inviteChannel,
      ['history'],
      async (m) => adminReplies.push(m),
      env.client
    );
    assert.equal(adminReplies.length, 2);
    assert.ok(adminReplies[0].embeds[0].data.description.includes(invUrl));
    assert.ok(adminReplies[1].embeds[0].data.description.includes(joined1.id));

    // End campaign -> deletes Discord invites, preserves DB records, freezes counts
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

    // Leave after Ended does not change frozen count
    env.members.delete(joined1.id);
    await handleInviteCampaignMemberRemove(joined1);
    part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 2);
  });

  await t.test('4. Moderation Exception — Allows Active/Scheduled Campaign Invite Links Only', async () => {
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

  await t.test('5. Startup Recovery & Offline Join Reconciliation', async () => {
    const env = createTestEnvironment();
    const admin = env.addMember('admin-rec', { isAdminPerm: true });
    const inviter = env.addMember('inviter-rec', { isAdminPerm: false });

    const campaign = await createInviteCampaign({
      guildId: env.guildId,
      name: 'Recovery Campaign',
      description: 'Test',
      status: CAMPAIGN_STATUS.DRAFT,
      endAt: new Date(Date.now() + 3600000),
      inviteChannelId: env.inviteChannel.id,
      announcementChannelId: env.anncChannel.id,
      createdBy: admin.id,
    });
    await handleInviteCommand(env.guild, admin, env.inviteChannel, ['start'], async () => {}, env.client);

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

    clearInviteSnapshotState();
    env.invites.get(campaignInvite.inviteCode).uses = 1;
    const offlineJoiner = env.addMember('offline-joiner-1', {
      accountAgeDays: 30,
      joinedAt: new Date(Date.now() + 1000),
    });

    await recoverInviteCampaignsOnStartup(env.client);
    stopInviteCampaignScheduler();

    const ref = await getCampaignReferral(campaign.campaignId, env.guildId, offlineJoiner.id);
    assert.ok(ref);
    assert.equal(ref.inviterId, inviter.id);
    assert.equal(ref.counted, true);

    const part = await getCampaignParticipant(campaign.campaignId, inviter.id);
    assert.equal(part.successfulInvites, 1);
  });
});
