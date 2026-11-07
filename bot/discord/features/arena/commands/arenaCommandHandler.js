import {
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  ARENA_STATUS,
  ARENA_CONSTANTS,
  getArenaConfig,
  saveArenaConfig,
  getArenaPlayer,
  updateArenaPlayer,
  getArenaVolunteer,
  upsertArenaVolunteer,
  updateArenaVolunteer,
  getArenaMatch,
  updateArenaMatch,
  getArenaMatchesByStatus,
  getActiveChallenges,
  getArenaChallenge,
  updateArenaChallenge,
  getOpenDisputes,
  getArenaLogs,
  atomicReleasePlayerMatch,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  setupArenaChannels,
  addVolunteerToMatchChannel,
  removeVolunteerFromMatchChannel,
} from '../services/arenaChannelService.js';
import {
  handleReleaseMatch,
  hasVolunteerRole,
} from '../services/arenaVolunteerService.js';
import {
  handleAdminResolveDispute,
} from '../services/arenaDisputeService.js';
import {
  transitionArenaStatus,
} from '../services/arenaMatchService.js';
import {
  buildVolunteerPanelEmbed,
  buildMatchChannelEmbed,
} from '../services/arenaNotificationService.js';
import { queueMessageEdit, queueChannelSend } from '../../../../../discordQueue.js';
import { extractUserId } from '../../../../../moderationService.js';

export function isArenaAdmin(member, guild = null) {
  if (!member) return false;
  const effectiveGuild = guild || member.guild;
  if (effectiveGuild?.ownerId === member.id) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (typeof member.permissions?.has === 'function') {
    if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) return true;
  }
  return false;
}

export async function handleArenaCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

  const subCmd = (args[0] || '').toLowerCase();

  // Admin permission required for all .arena commands
  if (!isArenaAdmin(member, guild)) {
    return replyFn('❌ **Permission Denied:** Only Administrators or members with `Manage Server` permission can manage the Arena.');
  }

  const config = await getArenaConfig(guild.id);

  if (!subCmd || subCmd === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('1v1 Challenge Arena Admin Commands')
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
      .setDescription(
        '• `.arena setup` — Create or verify all arena categories, channels, and persistent panels.\n' +
        '• `.arena active` — View open challenges and active matches.\n' +
        '• `.arena matches [status]` — List matches filtered by status.\n' +
        '• `.arena cancel <id> <reason>` — Cancel a match or challenge and free players.\n' +
        '• `.arena reassign <id> @volunteer` — Reassign an active match to another volunteer.\n' +
        '• `.arena dispute` — List open disputes and evidence.\n' +
        '• `.arena result <id> <A|B> <reason>` — Finalize a disputed match.\n' +
        '• `.arena volunteer add|remove @user` — Manage the Volunteer role.\n' +
        '• `.arena volunteer limit <n>` — Set the active match limit per volunteer (default 1).\n' +
        '• `.arena suspend|unsuspend @player` — Suspend or restore player access.\n' +
        '• `.arena resetuid @player` — Clear player BGMI details for re-registration.\n' +
        '• `.arena stats` — View overall arena statistics.\n' +
        '• `.arena logs [id]` — View recent arena audit logs.'
      )
      .setFooter({ text: 'Match District Arena Administration' });
    return replyFn({ embeds: [embed] });
  }

  // 1. .arena setup
  if (subCmd === 'setup') {
    try {
      const res = await setupArenaChannels(guild, member);
      return replyFn(
        `✅ **1v1 Challenge Arena Setup Complete!**\n` +
        `• Category: **${res.mainCategory.name}**\n` +
        `• Create Panel: <#${res.createChannel.id}>\n` +
        `• Available Challenges: <#${res.availableChannel.id}>\n` +
        `• Volunteer Queue: <#${res.volunteerPanel.id}>\n` +
        `• Match Results: <#${res.matchResults.id}>\n` +
        `• Support: <#${res.supportChannel.id}>\n` +
        `• Evidence Archive: <#${res.evidenceChannel.id}>\n` +
        `• Volunteer Role: <@&${res.volunteerRole.id}>`
      );
    } catch (err) {
      return replyFn(`❌ Setup failed: ${err.message}`);
    }
  }

  // 2. .arena active
  if (subCmd === 'active') {
    const openChallenges = await getActiveChallenges(guild.id);
    const waiting = await getArenaMatchesByStatus(ARENA_STATUS.WAITING_FOR_VOLUNTEER, guild.id);
    const assigned = await getArenaMatchesByStatus(ARENA_STATUS.VOLUNTEER_ASSIGNED, guild.id);
    const ready = await getArenaMatchesByStatus(ARENA_STATUS.ROOM_READY, guild.id);
    const live = await getArenaMatchesByStatus(ARENA_STATUS.LIVE, guild.id);
    const review = await getArenaMatchesByStatus(ARENA_STATUS.UNDER_REVIEW, guild.id);

    const activeMatches = [...waiting, ...assigned, ...ready, ...live, ...review];

    const embed = new EmbedBuilder()
      .setTitle('Arena Active Overview')
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
      .addFields(
        {
          name: `Open Challenges (${openChallenges.length})`,
          value: openChallenges.length
            ? openChallenges.slice(0, 5).map((c) => `• \`${c.challengeId}\` by <@${c.creatorId}>`).join('\n')
            : '*None*',
          inline: false,
        },
        {
          name: `Active Matches (${activeMatches.length})`,
          value: activeMatches.length
            ? activeMatches.slice(0, 5).map((m) => `• \`${m.matchId}\`: ${m.playerA.displayName} vs ${m.playerB.displayName} [\`${m.status}\`]`).join('\n')
            : '*None*',
          inline: false,
        }
      );
    return replyFn({ embeds: [embed] });
  }

  // 3. .arena matches [status]
  if (subCmd === 'matches') {
    const filterStatus = args[1] ? args[1].toUpperCase() : null;
    const matches = await getArenaMatchesByStatus(filterStatus, guild.id);
    const title = filterStatus ? `Arena Matches [${filterStatus}]` : 'All Arena Matches';

    const embed = new EmbedBuilder()
      .setTitle(`${title} (${matches.length})`)
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR);

    if (matches.length === 0) {
      embed.setDescription('*No matching matches found.*');
    } else {
      const lines = matches.slice(-10).reverse().map((m) =>
        `• \`${m.matchId}\` — ${m.playerA.displayName} vs ${m.playerB.displayName} | \`${m.status}\` | Vol: ${m.volunteerId ? `<@${m.volunteerId}>` : 'None'}`
      );
      embed.setDescription(lines.join('\n'));
    }
    return replyFn({ embeds: [embed] });
  }

  // 4. .arena cancel <id> <reason>
  if (subCmd === 'cancel') {
    const targetId = args[1]?.toUpperCase();
    const reason = args.slice(2).join(' ') || 'Cancelled by administrator';

    if (!targetId) return replyFn('❌ Usage: `.arena cancel <matchId|challengeId> [reason]`');

    // Check challenge first
    const challenge = await getArenaChallenge(targetId);
    if (challenge && challenge.status === ARENA_STATUS.OPEN) {
      await updateArenaChallenge(targetId, { status: ARENA_STATUS.CANCELLED });
      return replyFn(`✅ Open challenge **${targetId}** has been cancelled.`);
    }

    // Check match
    const match = await getArenaMatch(targetId);
    if (!match) {
      return replyFn(`❌ No match or challenge found with ID \`${targetId}\`.`);
    }

    if (match.status === ARENA_STATUS.COMPLETED) {
      return replyFn('❌ Completed matches cannot be cancelled.');
    }

    await transitionArenaStatus(targetId, ARENA_STATUS.CANCELLED, {
      performedBy: member.id,
      metadata: { reason },
      additionalUpdates: {
        roomPassword: null,
      },
    });

    // Free both players
    await atomicReleasePlayerMatch(match.playerA.discordId, match.matchId);
    await atomicReleasePlayerMatch(match.playerB.discordId, match.matchId);

    // Free volunteer if assigned
    if (match.volunteerId) {
      const vol = await getArenaVolunteer(match.volunteerId);
      if (vol) {
        await updateArenaVolunteer(match.volunteerId, {
          activeMatches: Math.max(0, vol.activeMatches - 1),
        });
      }
    }

    return replyFn(`✅ Match **${targetId}** has been cancelled. Players and volunteer have been released.`);
  }

  // 5. .arena reassign <id> @volunteer
  if (subCmd === 'reassign') {
    const matchId = args[1]?.toUpperCase();
    const targetUserId = extractUserId(args[2]);

    if (!matchId || !targetUserId) {
      return replyFn('❌ Usage: `.arena reassign <matchId> @volunteer`');
    }

    const match = await getArenaMatch(matchId);
    if (!match) return replyFn('❌ Match not found.');

    if (match.status === ARENA_STATUS.COMPLETED || match.status === ARENA_STATUS.CANCELLED) {
      return replyFn(`❌ Cannot reassign a match with status \`${match.status}\`.`);
    }

    const newVolMember =
      guild.members.cache.get(targetUserId) ||
      (await guild.members.fetch(targetUserId).catch(() => null));
    if (!newVolMember) return replyFn('❌ Volunteer member not found in server.');

    const isVol = await hasVolunteerRole(newVolMember, config);
    if (!isVol) return replyFn('❌ Target member does not have the `Volunteer` role.');

    const prevVolunteerId = match.volunteerId;

    // Decrement previous volunteer
    if (prevVolunteerId) {
      const prevVol = await getArenaVolunteer(prevVolunteerId);
      if (prevVol) {
        await updateArenaVolunteer(prevVolunteerId, {
          activeMatches: Math.max(0, prevVol.activeMatches - 1),
        });
      }
      if (match.matchChannelId) {
        const ch = guild.channels.cache.get(match.matchChannelId);
        if (ch) await removeVolunteerFromMatchChannel(ch, prevVolunteerId);
      }
    }

    // Increment new volunteer
    const newVol = await upsertArenaVolunteer(targetUserId);
    await updateArenaVolunteer(targetUserId, {
      activeMatches: (newVol.activeMatches || 0) + 1,
    });

    const updatedMatch = await updateArenaMatch(matchId, {
      volunteerId: targetUserId,
      assignedAt: new Date(),
    });

    // Add new volunteer to channel
    if (match.matchChannelId) {
      const ch =
        guild.channels.cache.get(match.matchChannelId) ||
        (await guild.channels.fetch(match.matchChannelId).catch(() => null));
      if (ch) {
        await addVolunteerToMatchChannel(ch, targetUserId);
        await queueChannelSend(ch, {
          content: `🔄 **Volunteer Reassigned:** <@${targetUserId}> has been assigned to officiate this match by an administrator.`,
        });
      }
    }

    await logArenaAction({
      action: 'MATCH_REASSIGNED',
      matchId,
      performedBy: member.id,
      metadata: { previousVolunteerId: prevVolunteerId, newVolunteerId: targetUserId },
    });

    return replyFn(`✅ Match **${matchId}** has been reassigned to <@${targetUserId}>.`);
  }

  // 6. .arena dispute
  if (subCmd === 'dispute' || subCmd === 'disputes') {
    const openDisputes = await getOpenDisputes();
    const embed = new EmbedBuilder()
      .setTitle(`Open Arena Disputes (${openDisputes.length})`)
      .setColor(0xED4245);

    if (openDisputes.length === 0) {
      embed.setDescription('✅ *No active disputes pending administrator review.*');
    } else {
      const lines = openDisputes.map((d) =>
        `• **Match \`${d.matchId}\`** — Reported by <@${d.reportedBy}>: "${d.reason}" ${d.evidence ? `([Screenshot](${d.evidence}))` : ''}`
      );
      embed.setDescription(lines.join('\n'));
      embed.setFooter({ text: 'Resolve with: .arena result <id> <A|B> <reason>' });
    }
    return replyFn({ embeds: [embed] });
  }

  // 7. .arena result <id> <A|B> <reason>
  if (subCmd === 'result') {
    const matchId = args[1]?.toUpperCase();
    const side = args[2]?.toUpperCase();
    const reason = args.slice(3).join(' ') || 'Admin adjudication';

    if (!matchId || !side || (side !== 'A' && side !== 'B')) {
      return replyFn('❌ Usage: `.arena result <matchId> <A|B> <reason>`');
    }

    const res = await handleAdminResolveDispute(guild, member, matchId, side, reason);
    if (!res.ok) return replyFn(res.error || '❌ Could not resolve dispute.');

    return replyFn(
      `✅ **Dispute Finalized for Match ${matchId}!**\nWinner awarded to **${res.winner.displayName}** (<@${res.winner.discordId}>).\nResult announced in #match-results.`
    );
  }

  // 8. .arena volunteer add|remove|limit
  if (subCmd === 'volunteer') {
    const volSub = (args[1] || '').toLowerCase();

    if (volSub === 'limit') {
      const rawLimit = Number(args[2]);
      if (!Number.isInteger(rawLimit) || rawLimit < 1) {
        return replyFn('❌ Please provide a positive whole number for the volunteer match limit (e.g. `.arena volunteer limit 2`).');
      }
      await saveArenaConfig(guild.id, { volunteerMatchLimit: rawLimit });
      return replyFn(`✅ Volunteer active match limit set to **${rawLimit}**.`);
    }

    const targetUserId = extractUserId(args[2]);
    if (!targetUserId) {
      return replyFn('❌ Usage: `.arena volunteer add|remove @user` or `.arena volunteer limit <n>`');
    }

    const targetMember =
      guild.members.cache.get(targetUserId) ||
      (await guild.members.fetch(targetUserId).catch(() => null));
    if (!targetMember) return replyFn('❌ Member not found in this server.');

    const volunteerRole =
      guild.roles.cache.get(config?.volunteerRoleId) ||
      guild.roles.cache.find((r) => r.name.toLowerCase() === 'volunteer');

    if (volSub === 'add') {
      if (volunteerRole) {
        await targetMember.roles.add(volunteerRole).catch(() => {});
      }
      await upsertArenaVolunteer(targetUserId, { status: 'AVAILABLE', suspended: false });
      return replyFn(`✅ <@${targetUserId}> has been granted the Volunteer role and registered in the arena.`);
    }

    if (volSub === 'remove') {
      if (volunteerRole) {
        await targetMember.roles.remove(volunteerRole).catch(() => {});
      }
      await updateArenaVolunteer(targetUserId, { status: 'UNAVAILABLE' });
      return replyFn(`✅ Volunteer role removed from <@${targetUserId}>.`);
    }

    return replyFn('❌ Invalid action. Use `add`, `remove`, or `limit`.');
  }

  // 9. .arena suspend|unsuspend @player
  if (subCmd === 'suspend' || subCmd === 'unsuspend') {
    const targetUserId = extractUserId(args[1]);
    if (!targetUserId) return replyFn(`❌ Usage: \`.arena ${subCmd} @player\``);

    const isSuspend = subCmd === 'suspend';
    await updateArenaPlayer(targetUserId, { suspended: isSuspend });

    return replyFn(
      `✅ Player <@${targetUserId}> has been **${isSuspend ? 'suspended' : 'unsuspended'}**.`
    );
  }

  // 10. .arena resetuid @player
  if (subCmd === 'resetuid') {
    const targetUserId = extractUserId(args[1]);
    if (!targetUserId) return replyFn('❌ Usage: `.arena resetuid @player`');

    const player = await getArenaPlayer(targetUserId);
    if (!player) return replyFn('❌ Player profile not found.');

    await updateArenaPlayer(targetUserId, {
      bgmiIgn: null,
      bgmiUid: null,
    });

    return replyFn(`✅ Cleared saved BGMI details for <@${targetUserId}>. They can now re-register.`);
  }

  // 11. .arena stats
  if (subCmd === 'stats') {
    const allMatches = await getArenaMatchesByStatus(null, guild.id);
    const completed = allMatches.filter((m) => m.status === ARENA_STATUS.COMPLETED).length;
    const cancelled = allMatches.filter((m) => m.status === ARENA_STATUS.CANCELLED).length;
    const active = allMatches.filter((m) => !ARENA_FINAL_STATUSES.includes(m.status)).length;
    const openDisputes = (await getOpenDisputes()).length;

    const embed = new EmbedBuilder()
      .setTitle('1v1 Challenge Arena Statistics')
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
      .addFields(
        { name: 'Total Matches', value: String(allMatches.length), inline: true },
        { name: 'Active In-Progress', value: String(active), inline: true },
        { name: 'Completed & Verified', value: String(completed), inline: true },
        { name: 'Cancelled / Expired', value: String(cancelled), inline: true },
        { name: 'Pending Disputes', value: String(openDisputes), inline: true }
      );
    return replyFn({ embeds: [embed] });
  }

  // 12. .arena logs [id]
  if (subCmd === 'logs') {
    const targetId = args[1]?.toUpperCase() || null;
    const logs = await getArenaLogs(targetId, 10);

    const embed = new EmbedBuilder()
      .setTitle(targetId ? `Arena Logs for ${targetId}` : 'Recent Arena Audit Logs')
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR);

    if (logs.length === 0) {
      embed.setDescription('*No audit logs recorded yet.*');
    } else {
      const lines = logs.map((l) =>
        `• \`${l.action}\` by <@${l.performedBy}> [${l.matchId || l.challengeId || 'System'}] <t:${Math.floor(new Date(l.timestamp).getTime() / 1000)}:R>`
      );
      embed.setDescription(lines.join('\n'));
    }
    return replyFn({ embeds: [embed] });
  }

  return replyFn('❌ Unknown arena subcommand. Use `.arena help` for a list of commands.');
}

export async function handleVolunteerCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

  const config = await getArenaConfig(guild.id);
  const isVol = await hasVolunteerRole(member, config);
  if (!isVol && !isArenaAdmin(member, guild)) {
    return replyFn('❌ **Permission Denied:** You must have the `Volunteer` role to use `.volunteer` commands.');
  }

  const subCmd = (args[0] || 'profile').toLowerCase();

  // .volunteer profile
  if (subCmd === 'profile' || subCmd === 'stats') {
    let vol = await getArenaVolunteer(member.id);
    if (!vol) {
      vol = await upsertArenaVolunteer(member.id);
    }

    const embed = new EmbedBuilder()
      .setTitle(`Volunteer Profile: ${member.displayName}`)
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
      .addFields(
        { name: 'Status', value: vol.status === 'AVAILABLE' ? '🟢 `AVAILABLE`' : '🔴 `UNAVAILABLE`', inline: true },
        { name: 'Active Matches', value: String(vol.activeMatches || 0), inline: true },
        { name: 'Completed Matches', value: String(vol.completedMatches || 0), inline: true },
        { name: 'Disputed Matches', value: String(vol.disputedMatches || 0), inline: true },
        { name: 'Total Handled', value: String(vol.totalMatches || 0), inline: true }
      );
    return replyFn({ embeds: [embed] });
  }

  // .volunteer status
  if (subCmd === 'status') {
    let vol = await getArenaVolunteer(member.id);
    if (!vol) vol = await upsertArenaVolunteer(member.id);

    const newStatus = vol.status === 'AVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE';
    await updateArenaVolunteer(member.id, { status: newStatus });

    return replyFn(`✅ Your volunteer availability status is now **\`${newStatus}\`**.`);
  }

  return replyFn('❌ Usage: `.volunteer profile` or `.volunteer status`');
}

export async function handleMyMatchesCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

  const config = await getArenaConfig(guild.id);
  const isVol = await hasVolunteerRole(member, config);
  if (!isVol && !isArenaAdmin(member, guild)) {
    return replyFn('❌ **Permission Denied:** You must have the `Volunteer` role to use `.mymatches`.');
  }

  const allMatches = await getArenaMatchesByStatus(null, guild.id);
  const myActive = allMatches.filter(
    (m) => m.volunteerId === member.id && !ARENA_FINAL_STATUSES.includes(m.status)
  );

  const embed = new EmbedBuilder()
    .setTitle(`Your Active Matches (${myActive.length})`)
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR);

  if (myActive.length === 0) {
    embed.setDescription('*You have no active assigned matches.*');
  } else {
    const lines = myActive.map((m) =>
      `• **\`${m.matchId}\`** — ${m.playerA.displayName} vs ${m.playerB.displayName} | Status: \`${m.status}\` | Channel: <#${m.matchChannelId}>`
    );
    embed.setDescription(lines.join('\n'));
  }

  return replyFn({ embeds: [embed] });
}

export async function handleReleaseCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

  const matchId = args[0]?.toUpperCase();
  if (!matchId) return replyFn('❌ Usage: `.release <matchId>`');

  const res = await handleReleaseMatch(guild, member, matchId);
  if (!res.ok) return replyFn(res.error || '❌ Could not release match.');

  return replyFn(`✅ You have successfully released match **${matchId}**.`);
}
