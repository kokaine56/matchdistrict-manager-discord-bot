import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { extractUserId } from '../../../../../moderationService.js';
import {
  CAMPAIGN_STATUS,
  getCurrentGuildCampaign,
  getLatestGuildCampaign,
  updateInviteCampaign,
  getCampaignInvitesForCampaign,
  getCampaignInviteByUser,
  getReferralsForCampaign,
  getReferralsByInviter,
  getCampaignReferral,
  updateCampaignReferral,
  getCampaignParticipant,
  upsertCampaignParticipant,
  getParticipantsForCampaign,
  getUnattributedJoinsForCampaign,
  markUnattributedJoinReviewed,
} from '../models/inviteCampaignModels.js';
import { formatISTDateTime } from '../services/timeUtils.js';
import {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  endCampaign,
} from '../services/campaignLifecycleService.js';
import {
  evaluateAndArmCampaignTimers,
  clearCampaignTimers,
  clearReferralTimer,
} from '../services/campaignSchedulerService.js';
import { ensureOrUpdateCampaignPanel } from '../services/campaignPanelService.js';
import { recalculateParticipantEligibility } from '../services/eligibilityService.js';
import { hasCampaignAdminPermission } from '../components/inviteCampaignInteractionHandler.js';

/**
 * Handles all `.invite` admin commands.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string[]} args
 * @param {(payload: string|object, opts?: object) => Promise<any>} replyFn
 * @param {import('discord.js').Client} [client]
 */
export async function handleInviteCommand(guild, member, channel, args, replyFn, client = null) {
  if (!guild) {
    return replyFn('❌ This command can only be used inside a Discord server.');
  }

  // Server-side permission check: Administrators or Manage Server only
  if (!hasCampaignAdminPermission(member, guild)) {
    return replyFn(
      '❌ **Permission Denied:** Only Administrators or members with `Manage Server` permission can use `.invite` commands.'
    );
  }

  const effectiveClient = client || guild.client || member?.client || null;
  const subCmd = (args[0] || '').toLowerCase();

  if (!subCmd || subCmd === 'help') {
    return replyFn(
      `🔗 **Invite Tracker Campaign Commands (Admin Only):**\n` +
        `• \`.invite create\` — Open the interactive campaign creation form & channel selector\n` +
        `• \`.invite start\` — Activate a Draft or Scheduled campaign\n` +
        `• \`.invite pause\` — Pause an Active campaign (joins during pause are not counted)\n` +
        `• \`.invite resume\` — Resume a Paused campaign\n` +
        `• \`.invite end\` — End the current campaign (with confirmation step)\n` +
        `• \`.invite status\` — View campaign status, total campaign joins, and summary statistics\n` +
        `• \`.invite leaderboard\` — View total successful joins per user\n` +
        `• \`.invite links [@user]\` — View individual member invite links and join counts\n` +
        `• \`.invite history [@user]\` — View historical referral records (active, left, disqualified)\n` +
        `• \`.invite disqualify <@user> [reason]\` — Exclude a user or a single referral from counts\n` +
        `• \`.invite review\` — View joins that could not be attributed with certainty`
    );
  }

  // 1. .invite create
  if (subCmd === 'create') {
    const existing = await getCurrentGuildCampaign(guild.id);
    if (existing) {
      return replyFn(
        `❌ **Active Campaign Exists:** This server already has a **${existing.status}** campaign (**${existing.name}**).\nOnly one Draft, Scheduled, Active, or Paused campaign can exist per server at a time. End it first with \`.invite end\`.`
      );
    }

    const openBtn = new ButtonBuilder()
      .setCustomId(`inv_cmp:open_create_modal:${member.id}`)
      .setLabel('Open Campaign Setup Form')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary);

    return replyFn({
      content:
        '🔗 **Create Invite Campaign**\nClick the button below to enter the campaign name, description, and start & end times (in IST: `DD-MM-YYYY HH:mm`).',
      components: [new ActionRowBuilder().addComponents(openBtn)],
    });
  }

  // 2. .invite start
  if (subCmd === 'start') {
    const campaign = await getCurrentGuildCampaign(guild.id);
    if (!campaign) {
      return replyFn('❌ No Draft or Scheduled campaign found in this server. Use `.invite create` first.');
    }

    const res = await startCampaign(effectiveClient, guild, campaign.campaignId, new Date());
    if (!res.ok) {
      return replyFn(res.error);
    }

    await evaluateAndArmCampaignTimers(effectiveClient, res.campaign, new Date());
    return replyFn(
      `🟢 **Campaign "${res.campaign.name}" is now \`Active\`!**\n` +
        `• **Invite Panel:** <#${res.campaign.inviteChannelId}> (Generate button enabled)\n` +
        `• **Ends At (IST):** ${formatISTDateTime(res.campaign.endAt)}`
    );
  }

  // 3. .invite pause
  if (subCmd === 'pause') {
    const campaign = await getCurrentGuildCampaign(guild.id);
    if (!campaign) {
      return replyFn('❌ No active campaign found in this server.');
    }

    const res = await pauseCampaign(effectiveClient, guild, campaign.campaignId);
    if (!res.ok) {
      return replyFn(`❌ ${res.error}`);
    }

    return replyFn(
      `⏸️ **Campaign "${res.campaign.name}" is now \`Paused\`.**\nNew joins while paused will not be counted, and the Generate button on the panel has been disabled. Use \`.invite resume\` to resume tracking.`
    );
  }

  // 4. .invite resume
  if (subCmd === 'resume') {
    const campaign = await getCurrentGuildCampaign(guild.id);
    if (!campaign) {
      return replyFn('❌ No paused campaign found in this server.');
    }

    const res = await resumeCampaign(effectiveClient, guild, campaign.campaignId);
    if (!res.ok) {
      return replyFn(res.error);
    }

    await evaluateAndArmCampaignTimers(effectiveClient, res.campaign, new Date());
    return replyFn(
      `▶️ **Campaign "${res.campaign.name}" has been \`Resumed\` (\`Active\`)!**\nInvite tracking is active again and the panel button is re-enabled.`
    );
  }

  // 5. .invite end (with confirmation step)
  if (subCmd === 'end') {
    const campaign = await getCurrentGuildCampaign(guild.id);
    if (!campaign) {
      return replyFn('❌ There is no active, scheduled, paused, or draft campaign to end.');
    }

    if ((args[1] || '').toLowerCase() === 'confirm') {
      clearCampaignTimers(campaign.campaignId);
      const res = await endCampaign(effectiveClient, guild, campaign.campaignId, new Date());
      if (!res.ok) return replyFn(`❌ ${res.error}`);
      return replyFn(
        `🏁 **Campaign "${res.campaign.name}" has been ended.** Final counts have been frozen, all campaign invite links have been deleted from Discord, and final results were posted in <#${res.campaign.announcementChannelId}>.`
      );
    }

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`inv_cmp:confirm_end:${campaign.campaignId}`)
      .setLabel('Confirm End Campaign')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`inv_cmp:cancel_end:${campaign.campaignId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    return replyFn({
      content:
        `⚠️ **Confirm Ending Campaign "${campaign.name}"**\n` +
        `Ending the campaign will permanently:\n` +
        `• Freeze all final invite counts\n` +
        `• Delete all campaign invite links from Discord (while keeping database history)\n` +
        `• Disable the Invite Panel button and post final results in <#${campaign.announcementChannelId}>\n\n` +
        `Are you sure you want to end this campaign now?`,
      components: [new ActionRowBuilder().addComponents(confirmBtn, cancelBtn)],
    });
  }

  // 6. .invite set stay <hours> | .invite set accountage <days>
  if (subCmd === 'set') {
    const campaign = await getCurrentGuildCampaign(guild.id);
    if (!campaign) {
      return replyFn('❌ No Draft or Scheduled campaign found. Create a campaign first with `.invite create`.');
    }

    if (
      campaign.status !== CAMPAIGN_STATUS.DRAFT &&
      campaign.status !== CAMPAIGN_STATUS.SCHEDULED
    ) {
      return replyFn(
        `❌ Campaign settings can only be modified while the campaign is **Draft** or **Scheduled** (current status: **${campaign.status}**).`
      );
    }

    const prop = (args[1] || '').toLowerCase();
    const rawVal = args[2];

    if (prop === 'stay') {
      const hours = rawVal !== undefined && rawVal !== '' ? Number(rawVal) : NaN;
      if (Number.isNaN(hours) || hours < 0 || !Number.isFinite(hours)) {
        return replyFn('❌ **Usage:** `.invite set stay <hours>` (must be a valid number >= 0).');
      }

      const updated = await updateInviteCampaign(campaign.campaignId, { stayHours: hours });
      if (effectiveClient) {
        await ensureOrUpdateCampaignPanel(effectiveClient, updated, { allowCreateIfMissing: false });
      }
      return replyFn(`✅ **Stay setting updated:** \`${hours}\` hour(s).`);
    }

    if (prop === 'accountage' || prop === 'account-age' || prop === 'age') {
      const days = rawVal !== undefined && rawVal !== '' ? Number(rawVal) : NaN;
      if (Number.isNaN(days) || days < 0 || !Number.isFinite(days)) {
        return replyFn('❌ **Usage:** `.invite set accountage <days>` (must be a valid number >= 0).');
      }

      const updated = await updateInviteCampaign(campaign.campaignId, { minAccountAgeDays: days });
      if (effectiveClient) {
        await ensureOrUpdateCampaignPanel(effectiveClient, updated, { allowCreateIfMissing: false });
      }
      return replyFn(`✅ **Account age setting updated:** \`${days}\` day(s).`);
    }

    return replyFn('ℹ️ **Usage:** `.invite set stay <hours>` or `.invite set accountage <days>`');
  }

  // 7. .invite status | .invite stats
  if (subCmd === 'status' || subCmd === 'stats') {
    const campaign = await getLatestGuildCampaign(guild.id);
    if (!campaign) {
      return replyFn('ℹ️ No Invite campaign has been created in this server yet.');
    }

    const [invites, referrals, unattributed] = await Promise.all([
      getCampaignInvitesForCampaign(campaign.campaignId),
      getReferralsForCampaign(campaign.campaignId),
      getUnattributedJoinsForCampaign(campaign.campaignId),
    ]);

    const countedCount = referrals.filter((r) => r.isActive && r.counted && !r.disqualified).length;
    const leftCount = referrals.filter((r) => !r.isActive).length;
    const disqCount = referrals.filter((r) => r.disqualified).length;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Invite Campaign Status — ${campaign.name}`)
      .setColor(campaign.status === CAMPAIGN_STATUS.ACTIVE ? 0x2ecc71 : 0x3498db)
      .setDescription(campaign.description || 'No description')
      .addFields(
        { name: '📌 Status', value: `**${campaign.status}**`, inline: true },
        {
          name: '🕒 Start (IST)',
          value: campaign.startAt ? formatISTDateTime(campaign.startAt) : 'Not started',
          inline: true,
        },
        {
          name: '⏰ End (IST)',
          value: formatISTDateTime(campaign.endAt),
          inline: true,
        },
        {
          name: '🏁 Ended At (IST)',
          value: campaign.endedAt ? formatISTDateTime(campaign.endedAt) : '—',
          inline: true,
        },
        {
          name: '📍 Channels',
          value: `Panel: <#${campaign.inviteChannelId}> | Announcements: <#${campaign.announcementChannelId}>`,
          inline: true,
        },
        {
          name: '📈 Campaign Statistics',
          value:
            `• **Total Successful Campaign Joins:** ${countedCount}\n` +
            `• **Unique Invite Links Generated:** ${invites.length}\n` +
            `• **Total Historical Referral Records:** ${referrals.length} *(Active: ${countedCount}, Left: ${leftCount}, Excluded: ${disqCount})*\n` +
            `• **Unattributed Joins (Review):** ${unattributed.length}`,
          inline: false,
        }
      )
      .setFooter({ text: `Campaign ID: ${campaign.campaignId}` })
      .setTimestamp(new Date());

    return replyFn({ embeds: [embed] });
  }

  // 8. .invite leaderboard (and .invite eligible as admin alias for top inviters)
  if (subCmd === 'leaderboard' || subCmd === 'lb' || subCmd === 'eligible') {
    const campaign = (await getCurrentGuildCampaign(guild.id)) || (await getLatestGuildCampaign(guild.id));
    if (!campaign) {
      return replyFn('ℹ️ No Invite campaign found in this server.');
    }

    const participants = (await getParticipantsForCampaign(campaign.campaignId)).filter(
      (p) => !p.disqualified && p.successfulInvites > 0
    );

    if (participants.length === 0) {
      return replyFn(`📊 **Invite Leaderboard — ${campaign.name}**\nNo successful joins recorded yet for this campaign.`);
    }

    const rows = [];
    for (let i = 0; i < Math.min(participants.length, 25); i++) {
      const p = participants[i];
      const cachedMember = guild.members?.cache?.get?.(p.userId);
      const username =
        cachedMember?.user?.username ||
        cachedMember?.displayName ||
        `User#${String(p.userId).slice(-4)}`;

      rows.push(
        `**#${i + 1}** • **${username}** (<@${p.userId}>) — **${p.successfulInvites}** successful invite${p.successfulInvites === 1 ? '' : 's'}`
      );
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 Invite Leaderboard — ${campaign.name}`)
      .setColor(0xf1c40f)
      .setDescription(rows.join('\n'))
      .setFooter({
        text: `Campaign Status: ${campaign.status}`,
      })
      .setTimestamp(new Date());

    return replyFn({ embeds: [embed] });
  }

  // 9. .invite links [@user] — Admin view of individual invite links & counts
  if (subCmd === 'links' || subCmd === 'link') {
    const campaign = (await getCurrentGuildCampaign(guild.id)) || (await getLatestGuildCampaign(guild.id));
    if (!campaign) {
      return replyFn('ℹ️ No Invite campaign found in this server.');
    }

    const targetId = args[1] ? extractUserId(args[1]) : null;
    if (targetId) {
      const [inv, part] = await Promise.all([
        getCampaignInviteByUser(campaign.campaignId, targetId),
        getCampaignParticipant(campaign.campaignId, targetId),
      ]);
      if (!inv) {
        return replyFn(`ℹ️ <@${targetId}> has not generated an invite link for **${campaign.name}**.`);
      }
      return replyFn(
        `🔗 **Invite Link Details for <@${targetId}>:**\n` +
          `• **Invite Link:** ${inv.inviteUrl} (\`${inv.inviteCode}\`)\n` +
          `• **Successful Joins:** **${part?.successfulInvites ?? 0}**\n` +
          `• **Discord Raw Uses:** ${inv.lastKnownUses ?? 0}`
      );
    }

    const [invites, participants] = await Promise.all([
      getCampaignInvitesForCampaign(campaign.campaignId),
      getParticipantsForCampaign(campaign.campaignId),
    ]);
    if (invites.length === 0) {
      return replyFn(`ℹ️ No invite links have been generated yet for **${campaign.name}**.`);
    }

    const countByUser = new Map(participants.map((p) => [String(p.userId), p.successfulInvites || 0]));
    const lines = invites.slice(0, 30).map((inv, idx) => {
      const joins = countByUser.get(String(inv.inviterId)) ?? 0;
      return `**${idx + 1}.** <@${inv.inviterId}> — \`${inv.inviteUrl}\` • **${joins}** successful join(s)`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`🔗 Campaign Invite Links — ${campaign.name}`)
      .setColor(0x3498db)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Total Links: ${invites.length}` })
      .setTimestamp(new Date());

    return replyFn({ embeds: [embed] });
  }

  // 10. .invite history [@user] | .invite referrals [@user] — Admin view of historical referral records
  if (subCmd === 'history' || subCmd === 'referrals') {
    const campaign = (await getCurrentGuildCampaign(guild.id)) || (await getLatestGuildCampaign(guild.id));
    if (!campaign) {
      return replyFn('ℹ️ No Invite campaign found in this server.');
    }

    const targetId = args[1] ? extractUserId(args[1]) : null;
    const referrals = targetId
      ? await getReferralsByInviter(campaign.campaignId, guild.id, targetId)
      : await getReferralsForCampaign(campaign.campaignId);

    if (referrals.length === 0) {
      return replyFn(
        targetId
          ? `ℹ️ No referral records found for <@${targetId}> in **${campaign.name}**.`
          : `ℹ️ No referral records found yet in **${campaign.name}**.`
      );
    }

    const lines = referrals.slice(0, 30).map((r, idx) => {
      const stateLabel = r.disqualified
        ? `🚫 Excluded (${r.disqualifyReason || 'Disqualified'})`
        : r.isActive && r.counted
          ? '🟢 Active (Counted)'
          : !r.isActive
            ? `🔴 Left (${formatISTDateTime(r.leftAt)})`
            : '⏳ Inactive';
      return `**${idx + 1}.** Invited: <@${r.invitedUserId}> ← by <@${r.inviterId}> (\`${r.inviteCode}\`) • ${stateLabel}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`📜 Referral History — ${campaign.name}`)
      .setColor(0x9b59b6)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Total Historical Records: ${referrals.length}` })
      .setTimestamp(new Date());

    return replyFn({ embeds: [embed] });
  }

  // 11. .invite disqualify @user [reason]
  if (subCmd === 'disqualify' || subCmd === 'dq') {
    const campaign = (await getCurrentGuildCampaign(guild.id)) || (await getLatestGuildCampaign(guild.id));
    if (!campaign) {
      return replyFn('❌ No campaign found in this server.');
    }
    if (campaign.status === CAMPAIGN_STATUS.ENDED) {
      return replyFn('❌ Cannot modify disqualifications on an already Ended campaign.');
    }

    let mode = 'auto';
    let targetArgIndex = 1;
    const firstArgLower = (args[1] || '').toLowerCase();
    if (firstArgLower === 'referral' || firstArgLower === 'invited') {
      mode = 'referral';
      targetArgIndex = 2;
    } else if (firstArgLower === 'user' || firstArgLower === 'participant' || firstArgLower === 'inviter') {
      mode = 'user';
      targetArgIndex = 2;
    }

    const targetId = extractUserId(args[targetArgIndex]);
    if (!targetId) {
      return replyFn(
        'ℹ️ **Usage:** `.invite disqualify <@user|userId> [reason]` *(or `.invite disqualify referral <@invitedUser> [reason]`)*'
      );
    }

    const reason = args.slice(targetArgIndex + 1).join(' ').trim() || 'Disqualified by administrator';

    const referralAsInvited = await getCampaignReferral(campaign.campaignId, guild.id, targetId);
    const participantRecord = await getCampaignParticipant(campaign.campaignId, targetId);

    const actionsTaken = [];

    const shouldDisqualifyReferral =
      mode === 'referral' ||
      (mode === 'auto' &&
        referralAsInvited &&
        (!participantRecord ||
          (participantRecord.successfulInvites === 0 && participantRecord.pendingInvites === 0)));

    const shouldDisqualifyParticipant =
      mode === 'user' ||
      (mode === 'auto' && (!referralAsInvited || Boolean(participantRecord)));

    if (shouldDisqualifyReferral && referralAsInvited) {
      clearReferralTimer(campaign.campaignId, targetId);
      await updateCampaignReferral(campaign.campaignId, guild.id, targetId, {
        disqualified: true,
        disqualifyReason: reason,
        counted: false,
        dueAt: null,
      });
      await recalculateParticipantEligibility(effectiveClient, campaign, referralAsInvited.inviterId);
      actionsTaken.push(
        `Referral of <@${targetId}> (invited by <@${referralAsInvited.inviterId}>) was excluded from <@${referralAsInvited.inviterId}>'s count.`
      );
    } else if (mode === 'referral' && !referralAsInvited) {
      return replyFn(`❌ No referral record found for invited user <@${targetId}> (\`${targetId}\`) in this campaign.`);
    }

    if (shouldDisqualifyParticipant && !shouldDisqualifyReferral) {
      await upsertCampaignParticipant(campaign.campaignId, guild.id, targetId, {
        disqualified: true,
        disqualifyReason: reason,
        isEligible: false,
        eligibleAt: null,
      });
      await recalculateParticipantEligibility(effectiveClient, campaign, targetId);
      actionsTaken.push(
        `Participant <@${targetId}> (\`${targetId}\`) has been excluded from campaign counts.`
      );
    }

    return replyFn(
      `🚫 **Disqualification Recorded:**\n${actionsTaken.map((a) => `• ${a}`).join('\n')}\n• **Reason:** ${reason}`
    );
  }

  // 12. .invite review
  if (subCmd === 'review') {
    const campaign = (await getCurrentGuildCampaign(guild.id)) || (await getLatestGuildCampaign(guild.id));
    if (!campaign) {
      return replyFn('ℹ️ No Invite campaign found in this server.');
    }

    const reviewSub = (args[1] || '').toLowerCase();
    if (reviewSub === 'mark' || reviewSub === 'clear') {
      const targetUser = args[2] && args[2].toLowerCase() !== 'all' ? extractUserId(args[2]) : null;
      const markedCount = await markUnattributedJoinReviewed(campaign.campaignId, targetUser);
      return replyFn(`✅ Marked **${markedCount}** unattributed join record(s) as reviewed.`);
    }

    const unattributed = await getUnattributedJoinsForCampaign(campaign.campaignId, false);
    if (unattributed.length === 0) {
      return replyFn(`✅ **Unattributed Joins Review — ${campaign.name}**\nNo ambiguous or unattributed joins recorded.`);
    }

    const lines = unattributed.slice(0, 25).map((u, idx) => {
      const badge = u.reviewed ? '✅ Reviewed' : '⚠️ Needs Review';
      return `**${idx + 1}.** <@${u.userId}> (\`${u.userId}\`) • \`${formatISTDateTime(u.joinedAt)}\`\n   ↳ *Reason:* ${u.reason} [${badge}]`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`🔍 Unattributed Joins Review — ${campaign.name}`)
      .setColor(0xe67e22)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({
        text: `Total Unattributed Joins: ${unattributed.length} • Use ".invite review mark all" to mark as reviewed`,
      })
      .setTimestamp(new Date());

    return replyFn({ embeds: [embed] });
  }

  return replyFn(
    `❓ Unknown subcommand \`${subCmd}\`. Run \`.invite help\` for available Invite commands.`
  );
}
