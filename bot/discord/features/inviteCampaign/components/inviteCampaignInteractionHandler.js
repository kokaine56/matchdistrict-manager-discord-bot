import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelSelectMenuBuilder,
} from 'discord.js';
import { enqueueDiscordAction, queueChannelSend } from '../../../../../discordQueue.js';
import {
  CAMPAIGN_STATUS,
  withCampaignLock,
  getCurrentGuildCampaign,
  getInviteCampaignById,
  createInviteCampaign,
  updateInviteCampaign,
  getCampaignInviteByUser,
  createCampaignInvite,
} from '../models/inviteCampaignModels.js';
import {
  parseISTDateTime,
  formatISTDateTime,
} from '../services/timeUtils.js';
import {
  registerCampaignInviteInCache,
  getGuildInviteSnapshot,
  refreshModerationAllowlistForGuild,
} from '../services/inviteSnapshotService.js';
import {
  recalculateParticipantEligibility,
  recalculateAllCampaignParticipants,
  setLiveUserViewRefreshHook,
} from '../services/eligibilityService.js';
import {
  ensureOrUpdateCampaignPanel,
  ensureOrUpdateLeaderboardMessage,
} from '../services/campaignPanelService.js';
import {
  parseAndValidateRewards,
  formatRewardsSummary,
} from '../services/leaderboardImageService.js';
import { endCampaign } from '../services/campaignLifecycleService.js';
import {
  evaluateAndArmCampaignTimers,
  clearCampaignTimers,
} from '../services/campaignSchedulerService.js';

export const GENERATE_BUTTON_COOLDOWN_MS = 5000;
export const LEADERBOARD_REFRESH_COOLDOWN_MS = 3000;
export const MAX_DISCORD_GUILD_INVITES = 1000;

// `${guildId}:${userId}` -> wizard draft state
const pendingCreateWizards = new Map();

// `${guildId}:${userId}` -> timestamp (ms)
const generateButtonCooldowns = new Map();

// `${campaignId}` -> timestamp (ms)
const leaderboardRefreshCooldowns = new Map();

// `${campaignId}:${userId}` -> { interaction, inviteUrl, updatedAt }
const activeUserInviteViews = new Map();

export function clearInviteInteractionCaches() {
  pendingCreateWizards.clear();
  generateButtonCooldowns.clear();
  leaderboardRefreshCooldowns.clear();
  activeUserInviteViews.clear();
}

/**
 * Formats the clean user-facing invite counter message:
 *
 * Your Successful Invites: 5
 * Your Invite Link: https://discord.gg/BT9392WMQ5
 */
export function formatUserInviteResponsePayload(campaignId, successfulInvites, inviteUrl) {
  const count = Math.max(0, Number(successfulInvites || 0));
  const content =
    `Your Successful Invites: ${count}\n` +
    `Your Invite Link: ${inviteUrl}`;

  const refreshBtn = new ButtonBuilder()
    .setCustomId(`inv_cmp:refresh:${campaignId}`)
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  return {
    content,
    components: [new ActionRowBuilder().addComponents(refreshBtn)],
  };
}

/**
 * Automatically refreshes the inviter's open ephemeral response in real time
 * whenever a member joins or leaves using their invite link.
 */
export async function refreshActiveUserInviteView(campaignId, userId, participant) {
  const key = `${campaignId}:${userId}`;
  const view = activeUserInviteViews.get(key);
  if (!view || !view.interaction || !view.inviteUrl) return;

  // Discord interaction tokens are valid for 15 minutes
  if (Date.now() - view.updatedAt > 14 * 60 * 1000) {
    activeUserInviteViews.delete(key);
    return;
  }

  const payload = formatUserInviteResponsePayload(
    campaignId,
    participant?.successfulInvites ?? 0,
    view.inviteUrl
  );

  try {
    if (typeof view.interaction.editReply === 'function') {
      await view.interaction.editReply(payload);
    }
  } catch {
    activeUserInviteViews.delete(key);
  }
}

// Register the real-time view refresh hook with eligibilityService
setLiveUserViewRefreshHook(refreshActiveUserInviteView);

/**
 * Server-side permission check: Administrator, Manage Server (ManageGuild), or Server Owner.
 */
export function hasCampaignAdminPermission(member, guild = null) {
  if (!member) return false;
  const effectiveGuild = guild || member.guild;
  if (effectiveGuild && effectiveGuild.ownerId && effectiveGuild.ownerId === member.id) {
    return true;
  }
  return Boolean(
    member.permissions?.has?.(PermissionFlagsBits.Administrator) ||
      member.permissions?.has?.(PermissionFlagsBits.ManageGuild)
  );
}

/**
 * Builds the Campaign Creation Modal (up to 5 inputs: Name, Start, End, Min Invite Threshold, Rewards).
 */
export function buildCreateCampaignModal() {
  const modal = new ModalBuilder()
    .setCustomId('inv_cmp:create_modal')
    .setTitle('Create Invite & Earn Campaign');

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Campaign Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Diwali Invite & Earn Campaign')
    .setRequired(true)
    .setMaxLength(100);

  const startInput = new TextInputBuilder()
    .setCustomId('startAt')
    .setLabel('Start Time (IST: DD-MM-YYYY HH:mm or DRAFT)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 15-11-2026 18:00 (or DRAFT for manual start)')
    .setRequired(true)
    .setMaxLength(32);

  const endInput = new TextInputBuilder()
    .setCustomId('endAt')
    .setLabel('End Time (IST: DD-MM-YYYY HH:mm)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 22-11-2026 23:59')
    .setRequired(true)
    .setMaxLength(32);

  const thresholdInput = new TextInputBuilder()
    .setCustomId('minInviteThreshold')
    .setLabel('Minimum Valid Invite Threshold')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 10 (only users >= threshold appear on leaderboard)')
    .setRequired(false)
    .setMaxLength(10);

  const rewardsInput = new TextInputBuilder()
    .setCustomId('rewards')
    .setLabel('Rewards by Rank (e.g. #1=50, #2=20, #3=10)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('#1 = ₹50\n#2 = ₹20\n#3 = ₹10\n#4 = ₹5\n#5 = ₹2')
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput),
    new ActionRowBuilder().addComponents(thresholdInput),
    new ActionRowBuilder().addComponents(rewardsInput)
  );

  return modal;
}

/**
 * Builds the Modal for editing Rewards & Minimum Invite Threshold before campaign start.
 */
export function buildRewardsConfigModal(currentThreshold = 1, currentRewards = [], campaignId = null) {
  const customId = campaignId
    ? `inv_cmp:rewards_modal:${campaignId}`
    : 'inv_cmp:rewards_modal';

  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Configure Rewards & Threshold');

  const thresholdInput = new TextInputBuilder()
    .setCustomId('minInviteThreshold')
    .setLabel('Minimum Valid Invite Threshold')
    .setStyle(TextInputStyle.Short)
    .setValue(String(Math.max(1, Number(currentThreshold || 1))))
    .setPlaceholder('e.g. 10')
    .setRequired(true)
    .setMaxLength(10);

  const defaultRewardsText =
    Array.isArray(currentRewards) && currentRewards.length > 0
      ? currentRewards.map((r) => `#${r.position}=${r.amount}`).join('\n')
      : '';

  const rewardsInput = new TextInputBuilder()
    .setCustomId('rewards')
    .setLabel('Winning Amounts by Position (₹)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('#1 = 50\n#2 = 20\n#3 = 10\n#4 = 5\n#5 = 2')
    .setRequired(false)
    .setMaxLength(500);

  if (defaultRewardsText) {
    rewardsInput.setValue(defaultRewardsText);
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(thresholdInput),
    new ActionRowBuilder().addComponents(rewardsInput)
  );

  return modal;
}

/**
 * Builds the Channel Select Menus (Invite Channel & Announcement Channel) + Edit Rewards + Confirm/Cancel buttons.
 */
function buildChannelSelectionStepPayload(wizard) {
  const now = new Date();
  const willBeScheduled = wizard.startAt && wizard.startAt.getTime() > now.getTime();
  const initialStatus = willBeScheduled ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.DRAFT;

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Configure Campaign Channels & Rewards')
    .setColor(0x3498db)
    .setDescription(
      'Select the **Invite Channel** (where the persistent Invite Panel will be posted) and the **Announcement Channel** (where the live image leaderboard will be posted), then click **Confirm**.'
    )
    .addFields(
      { name: '🏷️ Campaign Name', value: wizard.name, inline: true },
      { name: '📌 Initial Status', value: initialStatus, inline: true },
      {
        name: '🎯 Min Invite Threshold',
        value: `${wizard.minInviteThreshold ?? wizard.requiredInvites ?? 1} valid invite(s)`,
        inline: true,
      },
      {
        name: '🕒 Start (IST)',
        value: wizard.startAt ? formatISTDateTime(wizard.startAt) : 'Manual (.invite start)',
        inline: true,
      },
      { name: '⏰ End (IST)', value: formatISTDateTime(wizard.endAt), inline: true },
      {
        name: '💰 Reward Distribution',
        value: formatRewardsSummary(wizard.rewards),
        inline: false,
      },
      {
        name: '📢 Selected Channels',
        value:
          `• **Invite Panel Channel:** ${wizard.inviteChannelId ? `<#${wizard.inviteChannelId}>` : '*Not selected yet*'}\n` +
          `• **Announcement Channel:** ${wizard.announcementChannelId ? `<#${wizard.announcementChannelId}>` : '*Not selected yet*'}`,
        inline: false,
      }
    );

  const inviteChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('inv_cmp:select_invite_channel')
    .setPlaceholder('1️⃣ Select Invite Panel Channel...')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  const anncChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('inv_cmp:select_annc_channel')
    .setPlaceholder('2️⃣ Select Announcement Channel...')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  const editRewardsBtn = new ButtonBuilder()
    .setCustomId('inv_cmp:open_rewards_modal')
    .setLabel('Edit Rewards & Threshold')
    .setEmoji('💰')
    .setStyle(ButtonStyle.Primary);

  const confirmBtn = new ButtonBuilder()
    .setCustomId('inv_cmp:confirm_create')
    .setLabel('Confirm & Create Campaign')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!wizard.inviteChannelId || !wizard.announcementChannelId);

  const cancelBtn = new ButtonBuilder()
    .setCustomId('inv_cmp:cancel_create')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(inviteChannelSelect),
      new ActionRowBuilder().addComponents(anncChannelSelect),
      new ActionRowBuilder().addComponents(editRewardsBtn, confirmBtn, cancelBtn),
    ],
    ephemeral: true,
  };
}

/**
 * Handles the "Create Link" button click on the persistent Invite Panel.
 */
async function handleGenerateInviteButton(interaction, campaignId) {
  const guild = interaction.guild;
  const user = interaction.user || interaction.member?.user;
  if (!guild || !user) {
    await interaction.reply({
      content: '❌ This button can only be used inside a server.',
      ephemeral: true,
    });
    return true;
  }

  const userId = String(user.id);
  const cooldownKey = `${guild.id}:${userId}`;
  const nowMs = Date.now();
  const lastClickMs = generateButtonCooldowns.get(cooldownKey) || 0;

  if (nowMs - lastClickMs < GENERATE_BUTTON_COOLDOWN_MS) {
    const waitSec = Math.ceil((GENERATE_BUTTON_COOLDOWN_MS - (nowMs - lastClickMs)) / 1000);
    await interaction.reply({
      content: `⏳ Please wait **${waitSec}s** before clicking **Create Link** again.`,
      ephemeral: true,
    });
    return true;
  }
  generateButtonCooldowns.set(cooldownKey, nowMs);

  const campaign = await getInviteCampaignById(campaignId);
  if (!campaign || campaign.guildId !== String(guild.id)) {
    await interaction.reply({
      content: '❌ This campaign could not be found.',
      ephemeral: true,
    });
    return true;
  }

  if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
    await ensureOrUpdateCampaignPanel(interaction.client, campaign, { allowCreateIfMissing: false });
    await interaction.reply({
      content: `ℹ️ This campaign is currently **${campaign.status}** and is not accepting invite generations right now.`,
      ephemeral: true,
    });
    return true;
  }

  if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === 'function') {
    await interaction.deferReply({ ephemeral: true });
  }

  const sendEphemeral = async (payload) => {
    const body = typeof payload === 'string' ? { content: payload, ephemeral: true } : { ...payload, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(body);
    }
    return interaction.reply(body);
  };

  const lockKey = `lock:inv_cmp:gen:${campaign.campaignId}:${userId}`;

  return withCampaignLock(lockKey, async () => {
    // 1. Check if the user already has a saved CampaignInvite for this campaign (never recreate!)
    let inviteRecord = await getCampaignInviteByUser(campaign.campaignId, userId);

    if (!inviteRecord) {
      // Check Discord's 1000-invite limit per server
      const snap = await getGuildInviteSnapshot(guild.id, campaign);
      let currentInviteCount = snap.size;
      if (currentInviteCount === 0 && typeof guild.invites?.fetch === 'function') {
        const fetched = await guild.invites.fetch().catch(() => null);
        if (fetched && typeof fetched.size === 'number') {
          currentInviteCount = fetched.size;
        }
      }

      if (currentInviteCount >= MAX_DISCORD_GUILD_INVITES) {
        await notifyAdminInviteLimitReached(interaction.client, guild, campaign);
        await sendEphemeral(
          '⚠️ **Cannot create a new invite link right now:** This server has reached Discord\'s maximum limit of 1,000 active invite links. The administrators have been notified.'
        );
        return true;
      }

      // Resolve target channel to create the invite in (inviteChannelId first, fallback to current channel)
      let targetChannel =
        guild.channels?.cache?.get(campaign.inviteChannelId) ||
        (typeof guild.channels?.fetch === 'function'
          ? await guild.channels.fetch(campaign.inviteChannelId).catch(() => null)
          : null) ||
        interaction.channel;

      if (!targetChannel || typeof targetChannel.createInvite !== 'function') {
        await sendEphemeral(
          '❌ **Invite creation failed:** Could not access a valid server channel to create your invite link. Please contact an administrator.'
        );
        return true;
      }

      let createdDiscordInvite = null;
      try {
        createdDiscordInvite = await enqueueDiscordAction(
          () =>
            targetChannel.createInvite({
              maxAge: 0,
              maxUses: 0,
              unique: true,
              reason: `Invite & Earn campaign (${campaign.campaignId}) for user ${userId}`,
            }),
          'action'
        );
      } catch (err) {
        if (err?.code === 30016 || /maximum number of invites/i.test(err?.message || '')) {
          await notifyAdminInviteLimitReached(interaction.client, guild, campaign);
          await sendEphemeral(
            '⚠️ **Cannot create a new invite link right now:** This server has reached Discord\'s maximum limit of 1,000 active invite links. The administrators have been notified.'
          );
          return true;
        }

        console.warn(`[InviteCampaign] ⚠️ Failed to create Discord invite for user ${userId}:`, err.message);
        await sendEphemeral(
          '❌ **Invite creation failed:** The bot could not generate an invite link (please ask an administrator to verify the bot has `Create Invite` and `Manage Server` permissions).'
        );
        return true;
      }

      if (!createdDiscordInvite?.code) {
        await sendEphemeral(
          '❌ **Invite creation failed:** Discord did not return a valid invite code. Please try again later.'
        );
        return true;
      }

      const inviteCode = String(createdDiscordInvite.code);
      const inviteUrl = String(createdDiscordInvite.url || `https://discord.gg/${inviteCode}`);

      inviteRecord = await createCampaignInvite({
        campaignId: campaign.campaignId,
        guildId: guild.id,
        inviterId: userId,
        inviteCode,
        inviteUrl,
        lastKnownUses: Number(createdDiscordInvite.uses || 0),
        createdAt: new Date(),
      });

      registerCampaignInviteInCache(
        guild.id,
        inviteCode,
        inviteUrl,
        inviteRecord.lastKnownUses,
        userId,
        campaign.status
      );
    }

    // 2. Atomically recalculate the user's successful invite count from active referral records
    const participant = await recalculateParticipantEligibility(
      interaction.client,
      campaign,
      userId
    );

    const successful = participant?.successfulInvites ?? 0;
    const payload = formatUserInviteResponsePayload(
      campaign.campaignId,
      successful,
      inviteRecord.inviteUrl
    );

    await sendEphemeral(payload);

    // Track this ephemeral interaction so real-time joins/leaves can auto-refresh the user's count
    activeUserInviteViews.set(`${campaign.campaignId}:${userId}`, {
      interaction,
      inviteUrl: inviteRecord.inviteUrl,
      updatedAt: Date.now(),
    });

    return true;
  });
}

/**
 * Handles the "Refresh" button on a user's ephemeral invite response.
 */
async function handleRefreshInviteButton(interaction, campaignId) {
  const guild = interaction.guild;
  const user = interaction.user || interaction.member?.user;
  if (!guild || !user) return false;

  const userId = String(user.id);
  const campaign = await getInviteCampaignById(campaignId);
  if (!campaign || campaign.guildId !== String(guild.id)) {
    await interaction.reply({ content: '❌ Campaign not found.', ephemeral: true });
    return true;
  }

  const inviteRecord = await getCampaignInviteByUser(campaign.campaignId, userId);
  if (!inviteRecord) {
    return handleGenerateInviteButton(interaction, campaignId);
  }

  const participant = await recalculateParticipantEligibility(
    interaction.client,
    campaign,
    userId
  );

  const payload = formatUserInviteResponsePayload(
    campaign.campaignId,
    participant?.successfulInvites ?? 0,
    inviteRecord.inviteUrl
  );

  activeUserInviteViews.set(`${campaign.campaignId}:${userId}`, {
    interaction,
    inviteUrl: inviteRecord.inviteUrl,
    updatedAt: Date.now(),
  });

  if (typeof interaction.update === 'function') {
    await interaction.update(payload);
  } else if (typeof interaction.editReply === 'function') {
    await interaction.editReply({ ...payload, ephemeral: true });
  } else {
    await interaction.reply({ ...payload, ephemeral: true });
  }
  return true;
}

/**
 * Handles the "Refresh Leaderboard" button below the image leaderboard in the announcement channel.
 *
 * Requirements:
 * - Verifies the user has permission to refresh the leaderboard (must be a guild member, not a bot).
 * - Fetches the latest campaign data from MongoDB.
 * - Rejects refresh if campaign has already ended (never modifies finalized leaderboard).
 * - Protects against simultaneous clicks (per-campaign mutex lock) and excessive refresh spam (cooldown).
 * - Recalculates valid invite counts, applies minimum threshold, recalculates rankings & rewards,
 *   generates updated PNG image, and edits the existing announcement message in place.
 */
async function handleRefreshLeaderboardButton(interaction, campaignId) {
  const guild = interaction.guild;
  const user = interaction.user || interaction.member?.user;
  if (!guild || !user || user.bot) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: '❌ You do not have permission to refresh this leaderboard.',
        ephemeral: true,
      });
    }
    return true;
  }

  const campaign = await getInviteCampaignById(campaignId);
  if (!campaign || campaign.guildId !== String(guild.id)) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: '❌ Campaign not found.',
        ephemeral: true,
      });
    }
    return true;
  }

  // Never modify the leaderboard once the campaign has ended
  if (campaign.status === CAMPAIGN_STATUS.ENDED) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: '🏁 This campaign has ended and the leaderboard is permanently finalized.',
        ephemeral: true,
      });
    }
    return true;
  }

  // Protection against excessive refresh requests
  const nowMs = Date.now();
  const lastRefreshMs = leaderboardRefreshCooldowns.get(campaign.campaignId) || 0;
  if (nowMs - lastRefreshMs < LEADERBOARD_REFRESH_COOLDOWN_MS) {
    const waitSec = Math.ceil((LEADERBOARD_REFRESH_COOLDOWN_MS - (nowMs - lastRefreshMs)) / 1000);
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: `⏳ Leaderboard was just refreshed. Please wait **${waitSec}s** before refreshing again.`,
        ephemeral: true,
      });
    }
    return true;
  }

  const lockKey = `lock:inv_cmp:lb_refresh:${campaign.campaignId}`;

  return withCampaignLock(lockKey, async () => {
    const freshCampaign = await getInviteCampaignById(campaign.campaignId);
    if (!freshCampaign || freshCampaign.status === CAMPAIGN_STATUS.ENDED) {
      if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '🏁 This campaign has ended and the leaderboard is permanently finalized.',
          ephemeral: true,
        });
      }
      return true;
    }

    const currentMs = Date.now();
    const recentMs = leaderboardRefreshCooldowns.get(freshCampaign.campaignId) || 0;
    if (currentMs - recentMs < LEADERBOARD_REFRESH_COOLDOWN_MS) {
      const waitSec = Math.ceil((LEADERBOARD_REFRESH_COOLDOWN_MS - (currentMs - recentMs)) / 1000);
      if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `⏳ Leaderboard was just refreshed. Please wait **${waitSec}s** before refreshing again.`,
          ephemeral: true,
        });
      }
      return true;
    }

    leaderboardRefreshCooldowns.set(freshCampaign.campaignId, currentMs);

    // Recalculate all participant counts from MongoDB referral source of truth
    await recalculateAllCampaignParticipants(interaction.client, freshCampaign);

    // Regenerate PNG leaderboard and edit existing announcement message in place
    const updatedLb = await ensureOrUpdateLeaderboardMessage(interaction.client, freshCampaign, {
      allowCreateIfMissing: true,
      fromRefreshInteraction: true,
    });

    if (typeof interaction.deferUpdate === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.deferUpdate().catch(() => {});
    } else if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `✅ Leaderboard refreshed! (${updatedLb?.rows?.length ?? 0} qualified participant(s) shown)`,
        ephemeral: true,
      });
    }

    return true;
  });
}

/**
 * Notifies the admin in the announcement channel when the server hits Discord's 1000-invite limit.
 */
async function notifyAdminInviteLimitReached(client, guild, campaign) {
  if (!guild || !campaign || campaign.limitAlertSent) return;
  try {
    await updateInviteCampaign(campaign.campaignId, { limitAlertSent: true });
    campaign.limitAlertSent = true;

    const anncChannel =
      guild.channels?.cache?.get(campaign.announcementChannelId) ||
      (typeof guild.channels?.fetch === 'function'
        ? await guild.channels.fetch(campaign.announcementChannelId).catch(() => null)
        : null);

    if (anncChannel) {
      await queueChannelSend(
        anncChannel,
        `🚨 **Admin Alert — Invite Limit Reached:**\nThe server has reached Discord's maximum limit of **1,000 invites**. New personal invite links cannot be generated for **${campaign.name}** until unused server invites are cleaned up.`
      ).catch(() => {});
    }
  } catch (err) {
    console.warn('[InviteCampaign] ⚠️ Failed to send 1000-invite limit alert:', err.message);
  }
}

/**
 * Safely reads a modal text input field without throwing if the field was not included.
 */
function getOptionalModalField(interaction, fieldName) {
  try {
    const val = interaction.fields?.getTextInputValue?.(fieldName);
    return typeof val === 'string' ? val.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Main router for all `inv_cmp:` interactions (buttons, modals, channel select menus).
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} True if handled
 */
export async function handleInviteCampaignInteraction(interaction) {
  const customId = String(interaction?.customId || '');
  if (!customId.startsWith('inv_cmp:')) return false;

  const guild = interaction.guild;
  const member = interaction.member;
  const userId = String(interaction.user?.id || member?.id || '');

  // 1a. Public member button: Create Link (customId: inv_cmp:generate:<campaignId>)
  if (interaction.isButton?.() && customId.startsWith('inv_cmp:generate:')) {
    const campaignId = customId.slice('inv_cmp:generate:'.length);
    return handleGenerateInviteButton(interaction, campaignId);
  }

  // 1b. Public member button: Refresh personal invite count
  if (interaction.isButton?.() && customId.startsWith('inv_cmp:refresh:')) {
    const campaignId = customId.slice('inv_cmp:refresh:'.length);
    return handleRefreshInviteButton(interaction, campaignId);
  }

  // 1c. Public member button: Refresh Leaderboard image in announcement channel
  if (interaction.isButton?.() && customId.startsWith('inv_cmp:refresh_lb:')) {
    const campaignId = customId.slice('inv_cmp:refresh_lb:'.length);
    return handleRefreshLeaderboardButton(interaction, campaignId);
  }

  // All remaining interactions are Admin-only — enforce server-side permission check
  if (!hasCampaignAdminPermission(member, guild)) {
    await interaction.reply({
      content: '❌ **Permission Denied:** Only Administrators or members with `Manage Server` permission can perform this action.',
      ephemeral: true,
    });
    return true;
  }

  // 2. Admin button: Open Create Campaign Modal
  if (interaction.isButton?.() && customId.startsWith('inv_cmp:open_create_modal')) {
    const existing = await getCurrentGuildCampaign(guild.id);
    if (existing) {
      await interaction.reply({
        content: `❌ This server already has a **${existing.status}** campaign (**${existing.name}**). Only one Draft, Scheduled, Active, or Paused campaign is allowed per server at a time.`,
        ephemeral: true,
      });
      return true;
    }

    const modal = buildCreateCampaignModal();
    await interaction.showModal(modal);
    return true;
  }

  // 3. Admin modal submit: Create Campaign Form
  if (interaction.isModalSubmit?.() && customId === 'inv_cmp:create_modal') {
    const existing = await getCurrentGuildCampaign(guild.id);
    if (existing) {
      await interaction.reply({
        content: `❌ This server already has a **${existing.status}** campaign (**${existing.name}**).`,
        ephemeral: true,
      });
      return true;
    }

    const name = getOptionalModalField(interaction, 'name');
    const description =
      getOptionalModalField(interaction, 'description') ||
      'Click **Create Link** below to get your personal invite link and climb the leaderboard!';
    const startRaw = getOptionalModalField(interaction, 'startAt');
    const endRaw = getOptionalModalField(interaction, 'endAt');
    const thresholdRaw =
      getOptionalModalField(interaction, 'minInviteThreshold') ||
      getOptionalModalField(interaction, 'requiredInvites');
    const rewardsRaw = getOptionalModalField(interaction, 'rewards');

    if (!name) {
      await interaction.reply({
        content: '❌ Campaign name is required.',
        ephemeral: true,
      });
      return true;
    }

    let minInviteThreshold = 1;
    if (thresholdRaw !== '') {
      const parsedThresh = Number(thresholdRaw);
      if (!Number.isInteger(parsedThresh) || parsedThresh < 1) {
        await interaction.reply({
          content: '❌ **Invalid Minimum Invite Threshold:** Must be a positive whole number (>= 1).',
          ephemeral: true,
        });
        return true;
      }
      minInviteThreshold = parsedThresh;
    }

    const parsedRewards = parseAndValidateRewards(rewardsRaw);
    if (!parsedRewards.valid) {
      await interaction.reply({
        content: `❌ **Invalid Reward Configuration:** ${parsedRewards.error}`,
        ephemeral: true,
      });
      return true;
    }

    let startAt = null;
    if (startRaw && !/^(draft|now|-)$/i.test(startRaw)) {
      const parsedStart = parseISTDateTime(startRaw);
      if (!parsedStart.valid) {
        await interaction.reply({
          content: `❌ **Invalid Start Time:** ${parsedStart.error}`,
          ephemeral: true,
        });
        return true;
      }
      startAt = parsedStart.date;
    }

    const parsedEnd = parseISTDateTime(endRaw);
    if (!parsedEnd.valid || !parsedEnd.date) {
      await interaction.reply({
        content: `❌ **Invalid End Time:** ${parsedEnd.error}`,
        ephemeral: true,
      });
      return true;
    }
    const endAt = parsedEnd.date;
    const now = new Date();

    if (endAt.getTime() <= now.getTime()) {
      await interaction.reply({
        content: '❌ **Invalid End Time:** The campaign end time must be in the future (IST).',
        ephemeral: true,
      });
      return true;
    }

    if (startAt && endAt.getTime() <= startAt.getTime()) {
      await interaction.reply({
        content: '❌ **Invalid Schedule:** The campaign end time must be after the start time.',
        ephemeral: true,
      });
      return true;
    }

    const wizardKey = `${guild.id}:${userId}`;
    const wizard = {
      guildId: guild.id,
      createdBy: userId,
      name,
      description,
      startAt,
      endAt,
      requiredInvites: minInviteThreshold,
      minInviteThreshold,
      rewards: parsedRewards.rewards,
      inviteChannelId: null,
      announcementChannelId: null,
    };
    pendingCreateWizards.set(wizardKey, wizard);

    await interaction.reply(buildChannelSelectionStepPayload(wizard));
    return true;
  }

  // 3b. Admin button: Open Rewards & Threshold Modal during wizard OR for existing Draft/Scheduled campaign
  if (
    interaction.isButton?.() &&
    (customId === 'inv_cmp:open_rewards_modal' || customId.startsWith('inv_cmp:edit_campaign_rewards:'))
  ) {
    if (customId.startsWith('inv_cmp:edit_campaign_rewards:')) {
      const campaignId = customId.slice('inv_cmp:edit_campaign_rewards:'.length);
      const campaign = await getInviteCampaignById(campaignId);
      if (!campaign || campaign.guildId !== String(guild.id)) {
        await interaction.reply({ content: '❌ Campaign not found.', ephemeral: true });
        return true;
      }
      if (
        campaign.status !== CAMPAIGN_STATUS.DRAFT &&
        campaign.status !== CAMPAIGN_STATUS.SCHEDULED
      ) {
        await interaction.reply({
          content: `❌ Rewards and threshold can only be edited before the campaign starts (current status: **${campaign.status}**).`,
          ephemeral: true,
        });
        return true;
      }

      const modal = buildRewardsConfigModal(
        campaign.minInviteThreshold ?? campaign.requiredInvites ?? 1,
        campaign.rewards || [],
        campaign.campaignId
      );
      await interaction.showModal(modal);
      return true;
    }

    const wizardKey = `${guild.id}:${userId}`;
    const wizard = pendingCreateWizards.get(wizardKey);
    if (!wizard) {
      await interaction.reply({
        content: '⚠️ Your campaign creation session expired. Please run `.invite create` again.',
        ephemeral: true,
      });
      return true;
    }

    const modal = buildRewardsConfigModal(
      wizard.minInviteThreshold ?? 1,
      wizard.rewards || [],
      null
    );
    await interaction.showModal(modal);
    return true;
  }

  // 3c. Admin modal submit: Rewards & Threshold Config Modal
  if (
    interaction.isModalSubmit?.() &&
    (customId === 'inv_cmp:rewards_modal' || customId.startsWith('inv_cmp:rewards_modal:'))
  ) {
    const thresholdRaw = getOptionalModalField(interaction, 'minInviteThreshold');
    const rewardsRaw = getOptionalModalField(interaction, 'rewards');

    const parsedThresh = thresholdRaw === '' ? 1 : Number(thresholdRaw);
    if (!Number.isInteger(parsedThresh) || parsedThresh < 1) {
      await interaction.reply({
        content: '❌ **Invalid Minimum Invite Threshold:** Must be a positive integer (>= 1).',
        ephemeral: true,
      });
      return true;
    }

    const parsedRewards = parseAndValidateRewards(rewardsRaw);
    if (!parsedRewards.valid) {
      await interaction.reply({
        content: `❌ **Invalid Reward Configuration:** ${parsedRewards.error}`,
        ephemeral: true,
      });
      return true;
    }

    if (customId.startsWith('inv_cmp:rewards_modal:')) {
      const campaignId = customId.slice('inv_cmp:rewards_modal:'.length);
      const campaign = await getInviteCampaignById(campaignId);
      if (!campaign || campaign.guildId !== String(guild.id)) {
        await interaction.reply({ content: '❌ Campaign not found.', ephemeral: true });
        return true;
      }
      if (
        campaign.status !== CAMPAIGN_STATUS.DRAFT &&
        campaign.status !== CAMPAIGN_STATUS.SCHEDULED
      ) {
        await interaction.reply({
          content: `❌ Cannot modify rewards or threshold once the campaign is **${campaign.status}**.`,
          ephemeral: true,
        });
        return true;
      }

      const updated = await updateInviteCampaign(campaign.campaignId, {
        minInviteThreshold: parsedThresh,
        requiredInvites: parsedThresh,
        rewards: parsedRewards.rewards,
      });

      if (interaction.client && updated.leaderboardMessageId) {
        await ensureOrUpdateLeaderboardMessage(interaction.client, updated, {
          allowCreateIfMissing: false,
        });
      }

      await interaction.reply({
        content:
          `✅ **Updated Rewards & Threshold for "${updated.name}":**\n` +
          `• **Min Invite Threshold:** ${updated.minInviteThreshold}\n` +
          `• **Rewards:** ${formatRewardsSummary(updated.rewards)}`,
        ephemeral: true,
      });
      return true;
    }

    const wizardKey = `${guild.id}:${userId}`;
    const wizard = pendingCreateWizards.get(wizardKey);
    if (!wizard) {
      await interaction.reply({
        content: '⚠️ Your campaign creation session expired. Please run `.invite create` again.',
        ephemeral: true,
      });
      return true;
    }

    wizard.minInviteThreshold = parsedThresh;
    wizard.requiredInvites = parsedThresh;
    wizard.rewards = parsedRewards.rewards;
    pendingCreateWizards.set(wizardKey, wizard);

    const payload = buildChannelSelectionStepPayload(wizard);
    if (typeof interaction.update === 'function') {
      delete payload.ephemeral;
      await interaction.update(payload);
    } else {
      await interaction.reply(payload);
    }
    return true;
  }

  // 4. Admin Channel Select Menus (Invite Channel & Announcement Channel)
  if (
    interaction.isChannelSelectMenu?.() &&
    (customId === 'inv_cmp:select_invite_channel' || customId === 'inv_cmp:select_annc_channel')
  ) {
    const wizardKey = `${guild.id}:${userId}`;
    const wizard = pendingCreateWizards.get(wizardKey);
    if (!wizard) {
      await interaction.reply({
        content: '⚠️ Your campaign creation session expired. Please run `.invite create` again.',
        ephemeral: true,
      });
      return true;
    }

    const selectedChannelId = interaction.values?.[0] || null;
    if (customId === 'inv_cmp:select_invite_channel') {
      wizard.inviteChannelId = selectedChannelId;
    } else {
      wizard.announcementChannelId = selectedChannelId;
    }
    pendingCreateWizards.set(wizardKey, wizard);

    const payload = buildChannelSelectionStepPayload(wizard);
    delete payload.ephemeral;
    await interaction.update(payload);
    return true;
  }

  // 5. Admin Cancel Create button
  if (interaction.isButton?.() && customId === 'inv_cmp:cancel_create') {
    const wizardKey = `${guild.id}:${userId}`;
    pendingCreateWizards.delete(wizardKey);
    await interaction.update({
      content: '🚫 Campaign creation cancelled.',
      embeds: [],
      components: [],
    });
    return true;
  }

  // 6. Admin Confirm Create button
  if (interaction.isButton?.() && customId === 'inv_cmp:confirm_create') {
    const wizardKey = `${guild.id}:${userId}`;
    const wizard = pendingCreateWizards.get(wizardKey);
    if (!wizard) {
      await interaction.reply({
        content: '⚠️ Your campaign creation session expired. Please run `.invite create` again.',
        ephemeral: true,
      });
      return true;
    }

    if (!wizard.inviteChannelId || !wizard.announcementChannelId) {
      await interaction.reply({
        content: '❌ Please select both the **Invite Channel** and the **Announcement Channel** before confirming.',
        ephemeral: true,
      });
      return true;
    }

    const now = new Date();
    const initialStatus =
      wizard.startAt && wizard.startAt.getTime() > now.getTime()
        ? CAMPAIGN_STATUS.SCHEDULED
        : CAMPAIGN_STATUS.DRAFT;

    try {
      const campaign = await createInviteCampaign({
        guildId: guild.id,
        name: wizard.name,
        description: wizard.description,
        status: initialStatus,
        startAt: wizard.startAt || null,
        endAt: wizard.endAt,
        requiredInvites: wizard.minInviteThreshold || wizard.requiredInvites || 1,
        minInviteThreshold: wizard.minInviteThreshold || wizard.requiredInvites || 1,
        rewards: wizard.rewards || [],
        stayHours: 0,
        minAccountAgeDays: 0,
        inviteChannelId: wizard.inviteChannelId,
        announcementChannelId: wizard.announcementChannelId,
        panelMessageId: null,
        leaderboardMessageId: null,
        createdBy: userId,
        createdAt: now,
        endedAt: null,
      });

      pendingCreateWizards.delete(wizardKey);

      await refreshModerationAllowlistForGuild(guild.id, campaign);
      await ensureOrUpdateCampaignPanel(interaction.client, campaign);
      await ensureOrUpdateLeaderboardMessage(interaction.client, campaign);
      await evaluateAndArmCampaignTimers(interaction.client, campaign, now);

      await interaction.update({
        content:
          `✅ **Campaign "${campaign.name}" created as \`${campaign.status}\`!**\n` +
          `• **Invite Panel Posted In:** <#${campaign.inviteChannelId}>\n` +
          `• **Live Image Leaderboard Posted In:** <#${campaign.announcementChannelId}>\n` +
          `• **Minimum Invite Threshold:** ${campaign.minInviteThreshold} valid invite(s)\n` +
          `• **Rewards:** ${formatRewardsSummary(campaign.rewards)}\n` +
          `• **Start Time (IST):** ${campaign.startAt ? formatISTDateTime(campaign.startAt) : 'Manual (`.invite start`)'}\n` +
          `• **End Time (IST):** ${formatISTDateTime(campaign.endAt)}\n\n` +
          (campaign.status === CAMPAIGN_STATUS.DRAFT
            ? `*Run \`.invite start\` to activate the campaign!*`
            : `*The campaign will activate automatically at ${formatISTDateTime(campaign.startAt)} (or run \`.invite start\` to start immediately).*`),
        embeds: [],
        components: [],
      });
    } catch (err) {
      if (err?.code === 11000) {
        await interaction.update({
          content: '❌ Another Draft, Scheduled, Active, or Paused campaign already exists in this server.',
          embeds: [],
          components: [],
        });
      } else {
        await interaction.reply({
          content: `❌ **Failed to create campaign:** ${err.message}`,
          ephemeral: true,
        });
      }
    }
    return true;
  }

  // 7. Admin Confirm End Campaign button
  if (interaction.isButton?.() && customId.startsWith('inv_cmp:confirm_end:')) {
    const campaignId = customId.slice('inv_cmp:confirm_end:'.length);
    clearCampaignTimers(campaignId);
    const res = await endCampaign(interaction.client, guild, campaignId, new Date());
    if (!res.ok) {
      await interaction.update({
        content: `❌ **Could not end campaign:** ${res.error}`,
        embeds: [],
        components: [],
      });
      return true;
    }

    await interaction.update({
      content: `🏁 **Campaign "${res.campaign.name}" has been ended.** Final counts have been frozen, campaign invite links have been deleted from Discord, the panel button is disabled, and the final leaderboard image was updated in <#${res.campaign.announcementChannelId}>.`,
      embeds: [],
      components: [],
    });
    return true;
  }

  // 8. Admin Cancel End Campaign button
  if (interaction.isButton?.() && customId.startsWith('inv_cmp:cancel_end:')) {
    await interaction.update({
      content: 'ℹ️ Campaign end cancelled. The campaign remains unchanged.',
      embeds: [],
      components: [],
    });
    return true;
  }

  return false;
}
