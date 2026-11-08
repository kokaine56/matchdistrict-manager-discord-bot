import {
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  ARENA_STATUS,
  ARENA_FINAL_STATUSES,
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
  deleteAllArenaData,
} from '../models/arenaModels.js';
import {
  setupArenaChannels,
  deleteArenaChannels,
  addVolunteerToMatchChannel,
  removeVolunteerFromMatchChannel,
} from '../services/arenaChannelService.js';
import {
  handleReleaseMatch,
  handleLeaveMatch,
} from '../services/arenaVolunteerService.js';
import {
  handleAdminResolveDispute,
} from '../services/arenaDisputeService.js';
import {
  transitionArenaStatus,
  cancelAllScreenshotTimers,
} from '../services/arenaMatchService.js';
import {
  refreshArenaMatchCards,
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

  // Admin permission required for all .tdm / .arena commands
  if (!isArenaAdmin(member, guild)) {
    return replyFn('❌ **Permission Denied:** Only Administrators or members with `Manage Server` permission can manage 1v1 TDM.');
  }

  const config = await getArenaConfig(guild.id);

  if (!subCmd || subCmd === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('1v1 TDM Admin Commands')
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
      .setDescription(
        '• `.tdm setup` — Create or verify all TDM categories, channels, and persistent panels.\n' +
        '• `.tdm delete` — Delete all TDM channels, categories, and database records.\n' +
        '• `.tdm active` — View open challenges and active matches.\n' +
        '• `.tdm matches [status]` — List matches filtered by status.\n' +
        '• `.tdm cancel <id> <reason>` — Cancel a match or challenge and free players.\n' +
        '• `.tdm reassign <id> @roommaker` — Reassign an active match to another Room Maker.\n' +
        '• `.tdm dispute` — List open disputes and evidence.\n' +
        '• `.tdm result <id> <A|B> <reason>` — Finalize a disputed match.\n' +
        '• `.tdm roommaker add|remove @user` — Register or deactivate a Room Maker profile.\n' +
        '• `.tdm roommaker limit <n>` — Set the active match limit per Room Maker (default 1).\n' +
        '• `.tdm suspend|unsuspend @player` — Suspend or restore player access.\n' +
        '• `.tdm resetuid @player` — Clear player BGMI details for re-registration.\n' +
        '• `.tdm stats` — View overall TDM statistics.\n' +
        '• `.tdm logs [id]` — View recent TDM audit logs.'
      )
      .setFooter({ text: 'Match District TDM Administration' });
    return replyFn({ embeds: [embed] });
  }

  // 1. .tdm setup
  if (subCmd === 'setup') {
    try {
      const res = await setupArenaChannels(guild, member);
      return replyFn(
        `✅ **1v1 TDM Setup Complete!**\n` +
        `• Category: **${res.mainCategory.name}**\n` +
        `• Information: <#${res.infoChannel.id}>\n` +
        `• Create Panel: <#${res.createChannel.id}>\n` +
        `• Available Matches: <#${res.availableChannel.id}>\n` +
        `• Room Maker Panel: <#${res.volunteerPanel.id}>\n` +
        `• Match Results: <#${res.matchResults.id}>\n` +
        `• Support: <#${res.supportChannel.id}>\n` +
        `• Evidence Archive: <#${res.evidenceChannel.id}>`
      );
    } catch (err) {
      return replyFn(`❌ Setup failed: ${err.message}`);
    }
  }

  // 2. .tdm delete
  if (subCmd === 'delete') {
    try {
      // 1. Cancel any active screenshot / interaction timers
      cancelAllScreenshotTimers();

      // 2. Delete all Discord channels and categories
      const channelStats = await deleteArenaChannels(guild, config);

      // 3. Delete all database records (config, challenges, matches, disputes, logs, players, volunteers)
      const dbStats = await deleteAllArenaData(guild.id);

      const summaryEmbed = new EmbedBuilder()
        .setTitle('🗑️ 1v1 TDM Deleted')
        .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
        .setDescription(
          'All 1v1 TDM channels, categories, and database records have been completely deleted.\n\n' +
          'You can run `.tdm setup` at any time to reinitialize TDM from scratch.'
        )
        .addFields(
          {
            name: 'Discord Channels Removed',
            value: `• Channels: **${channelStats.deletedChannels}**\n• Categories: **${channelStats.deletedCategories}**`,
            inline: true,
          },
          {
            name: 'Database Records Cleared',
            value:
              `• Matches: **${dbStats.matchesDeleted}**\n` +
              `• Challenges: **${dbStats.challengesDeleted}**\n` +
              `• Players / Profiles: **${dbStats.playersDeleted}**\n` +
              `• Disputes: **${dbStats.disputesDeleted}**`,
            inline: true,
          }
        )
        .setFooter({ text: 'Match District TDM Administration' });

      return replyFn({ embeds: [summaryEmbed] });
    } catch (err) {
      return replyFn(`❌ Failed to delete TDM: ${err.message}`);
    }
  }

  // 3. .tdm active
  if (subCmd === 'active') {
    const openChallenges = await getActiveChallenges(guild.id);
    const waiting = await getArenaMatchesByStatus(ARENA_STATUS.WAITING_FOR_VOLUNTEER, guild.id);
    const assigned = await getArenaMatchesByStatus(ARENA_STATUS.VOLUNTEER_ASSIGNED, guild.id);
    const ready = await getArenaMatchesByStatus(ARENA_STATUS.ROOM_READY, guild.id);
    const live = await getArenaMatchesByStatus(ARENA_STATUS.LIVE, guild.id);
    const review = await getArenaMatchesByStatus(ARENA_STATUS.UNDER_REVIEW, guild.id);

    const activeMatches = [...waiting, ...assigned, ...ready, ...live, ...review];

    const embed = new EmbedBuilder()
      .setTitle('TDM Active Overview')
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

  // 4. .tdm matches [status]
  if (subCmd === 'matches') {
    const filterStatus = args[1] ? args[1].toUpperCase() : null;
    const matches = await getArenaMatchesByStatus(filterStatus, guild.id);
    const title = filterStatus ? `TDM Matches [${filterStatus}]` : 'All TDM Matches';

    const embed = new EmbedBuilder()
      .setTitle(`${title} (${matches.length})`)
      .setColor(ARENA_CONSTANTS.ORANGE_COLOR);

    if (matches.length === 0) {
      embed.setDescription('*No matching matches found.*');
    } else {
      const lines = matches.slice(-10).reverse().map((m) =>
        `• \`${m.matchId}\` — ${m.playerA.displayName} vs ${m.playerB.displayName} | \`${m.status}\` | RM: ${m.volunteerId ? `<@${m.volunteerId}>` : 'None'}`
      );
      embed.setDescription(lines.join('\n'));
    }
    return replyFn({ embeds: [embed] });
  }

  // 5. .tdm cancel <id> <reason>
  if (subCmd === 'cancel') {
    const targetId = args[1]?.toUpperCase();
    const reason = args.slice(2).join(' ') || 'Cancelled by administrator';

    if (!targetId) return replyFn('❌ Usage: `.tdm cancel <matchId|challengeId> [reason]`');

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

  // 6. .tdm reassign <id> @volunteer
  if (subCmd === 'reassign') {
    const matchId = args[1]?.toUpperCase();
    const targetUserId = extractUserId(args[2]);

    if (!matchId || !targetUserId) {
      return replyFn('❌ Usage: `.tdm reassign <matchId> @roommaker`');
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

    if (targetUserId === match.playerA.discordId || targetUserId === match.playerB.discordId) {
      return replyFn('❌ Cannot reassign match to one of its players.');
    }

    const targetVol = await getArenaVolunteer(targetUserId);
    if (targetVol?.suspended) {
      return replyFn('❌ That volunteer is currently suspended.');
    }

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

    await refreshArenaMatchCards(guild, updatedMatch, { volunteerDisplayName: newVolMember.displayName });

    // Manage Room Maker channel permissions (reassign Room Maker access)
    const rmChId = match.roomMakerChannelId || match.roomChannelId;
    if (rmChId) {
      const rmCh =
        guild.channels.cache.get(rmChId) ||
        (await guild.channels.fetch(rmChId).catch(() => null));
      if (rmCh) {
        if (prevVolunteerId) {
          const { removeRoomMakerFromRoomMakerChannel, addRoomMakerToRoomMakerChannel } = await import('../services/arenaChannelService.js');
          await removeRoomMakerFromRoomMakerChannel(rmCh, prevVolunteerId);
          await addRoomMakerToRoomMakerChannel(rmCh, targetUserId);
        } else {
          const { addRoomMakerToRoomMakerChannel } = await import('../services/arenaChannelService.js');
          await addRoomMakerToRoomMakerChannel(rmCh, targetUserId);
        }
      }
    }

    // Challengers channel notice (Room Maker identity strictly hidden, NO access granted)
    if (match.matchChannelId) {
      const ch =
        guild.channels.cache.get(match.matchChannelId) ||
        (await guild.channels.fetch(match.matchChannelId).catch(() => null));
      if (ch) {
        await queueChannelSend(ch, {
          content: '🔄 **Room Maker Reassigned:** A new Room Maker has been assigned to officiate your match.',
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

  // 7. .tdm dispute
  if (subCmd === 'dispute' || subCmd === 'disputes') {
    const openDisputes = await getOpenDisputes();
    const embed = new EmbedBuilder()
      .setTitle(`Open TDM Disputes (${openDisputes.length})`)
      .setColor(0xED4245);

    if (openDisputes.length === 0) {
      embed.setDescription('✅ *No active disputes pending administrator review.*');
    } else {
      const lines = openDisputes.map((d) =>
        `• **Match \`${d.matchId}\`** — Reported by <@${d.reportedBy}>: "${d.reason}" ${d.evidence ? `([Screenshot](${d.evidence}))` : ''}`
      );
      embed.setDescription(lines.join('\n'));
      embed.setFooter({ text: 'Resolve with: .tdm result <id> <A|B> <reason>' });
    }
    return replyFn({ embeds: [embed] });
  }

  // 8. .tdm result <id> <A|B> <reason>
  if (subCmd === 'result') {
    const matchId = args[1]?.toUpperCase();
    const side = args[2]?.toUpperCase();
    const reason = args.slice(3).join(' ') || 'Admin adjudication';

    if (!matchId || !side || (side !== 'A' && side !== 'B')) {
      return replyFn('❌ Usage: `.tdm result <matchId> <A|B> <reason>`');
    }

    const res = await handleAdminResolveDispute(guild, member, matchId, side, reason);
    if (!res.ok) return replyFn(res.error || '❌ Could not resolve dispute.');

    return replyFn(
      `✅ **Dispute Finalized for Match ${matchId}!**\nWinner awarded to **${res.winner.bgmiIgn || res.winner.displayName}** (<@${res.winner.discordId}>).\nResult announced in #match-results.`
    );
  }

  // 9. .tdm roommaker / .tdm volunteer add|remove|limit
  if (subCmd === 'volunteer' || subCmd === 'roommaker') {
    const volSub = (args[1] || '').toLowerCase();

    if (volSub === 'limit') {
      const rawLimit = Number(args[2]);
      if (!Number.isInteger(rawLimit) || rawLimit < 1) {
        return replyFn('❌ Please provide a positive whole number for the Room Maker match limit (e.g. `.tdm roommaker limit 2`).');
      }
      await saveArenaConfig(guild.id, { volunteerMatchLimit: rawLimit });
      return replyFn(`✅ Room Maker active match limit set to **${rawLimit}**.`);
    }

    const targetUserId = extractUserId(args[2]);
    if (!targetUserId) {
      return replyFn('❌ Usage: `.tdm roommaker add|remove @user` or `.tdm roommaker limit <n>`');
    }

    const targetMember =
      guild.members.cache.get(targetUserId) ||
      (await guild.members.fetch(targetUserId).catch(() => null));
    if (!targetMember) return replyFn('❌ Member not found in this server.');

    const targetDisplayName = targetMember.displayName || targetMember.user?.username || 'Room Maker';

    if (volSub === 'add') {
      await upsertArenaVolunteer(targetUserId, {
        displayName: targetDisplayName,
        status: 'AVAILABLE',
        suspended: false,
      });
      return replyFn(`✅ <@${targetUserId}> has been registered as an active Room Maker.`);
    }

    if (volSub === 'remove') {
      await updateArenaVolunteer(targetUserId, { status: 'UNAVAILABLE' });
      return replyFn(`✅ Room Maker status set to \`UNAVAILABLE\` for <@${targetUserId}>.`);
    }

    return replyFn('❌ Invalid action. Use `add`, `remove`, or `limit`.');
  }

  // 10. .tdm suspend|unsuspend @player
  if (subCmd === 'suspend' || subCmd === 'unsuspend') {
    const targetUserId = extractUserId(args[1]);
    if (!targetUserId) return replyFn(`❌ Usage: \`.tdm ${subCmd} @player\``);

    const isSuspend = subCmd === 'suspend';
    await updateArenaPlayer(targetUserId, { suspended: isSuspend });

    return replyFn(
      `✅ Player <@${targetUserId}> has been **${isSuspend ? 'suspended' : 'unsuspended'}**.`
    );
  }

  // 11. .tdm resetuid @player
  if (subCmd === 'resetuid') {
    const targetUserId = extractUserId(args[1]);
    if (!targetUserId) return replyFn('❌ Usage: `.tdm resetuid @player`');

    const player = await getArenaPlayer(targetUserId);
    if (!player) return replyFn('❌ Player profile not found.');

    await updateArenaPlayer(targetUserId, {
      bgmiIgn: null,
      bgmiUid: null,
    });

    return replyFn(`✅ Cleared saved BGMI details for <@${targetUserId}>. They can now re-register.`);
  }

  // 12. .tdm stats
  if (subCmd === 'stats') {
    const allMatches = await getArenaMatchesByStatus(null, guild.id);
    const completed = allMatches.filter((m) => m.status === ARENA_STATUS.COMPLETED).length;
    const cancelled = allMatches.filter((m) => m.status === ARENA_STATUS.CANCELLED).length;
    const active = allMatches.filter((m) => !ARENA_FINAL_STATUSES.includes(m.status)).length;
    const openDisputes = (await getOpenDisputes()).length;

    const embed = new EmbedBuilder()
      .setTitle('1v1 TDM Statistics')
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

  // 13. .tdm logs [id]
  if (subCmd === 'logs') {
    const targetId = args[1]?.toUpperCase() || null;
    const logs = await getArenaLogs(targetId, 10);

    const embed = new EmbedBuilder()
      .setTitle(targetId ? `TDM Logs for ${targetId}` : 'Recent TDM Audit Logs')
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

  return replyFn('❌ Unknown TDM subcommand. Use `.tdm help` (or `.arena help`) for a list of commands.');
}

export const handleTdmCommand = handleArenaCommand;

export async function handleRoomMakerCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

  const subCmd = (args[0] || 'profile').toLowerCase();

  // .roommaker profile / .volunteer profile
  if (subCmd === 'profile' || subCmd === 'stats') {
    const vol = await upsertArenaVolunteer(member.id, {
      displayName: member.displayName || member.user?.username || 'Room Maker',
    });

    const embed = new EmbedBuilder()
      .setTitle(`Room Maker Profile: ${member.displayName || member.user?.username || 'Room Maker'}`)
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

  // .roommaker status / .volunteer status
  if (subCmd === 'status') {
    const vol = await upsertArenaVolunteer(member.id, {
      displayName: member.displayName || member.user?.username || 'Room Maker',
    });

    const newStatus = vol.status === 'AVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE';
    await updateArenaVolunteer(member.id, { status: newStatus });

    return replyFn(`✅ Your Room Maker availability status is now **\`${newStatus}\`**.`);
  }

  return replyFn('❌ Usage: `.roommaker profile` or `.roommaker status` (alias: `.volunteer`)');
}

export const handleVolunteerCommand = handleRoomMakerCommand;

export async function handleMyMatchesCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

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

export async function handleLeaveCommand(guild, member, channel, args, replyFn, client = null, message = null) {
  if (!guild) return replyFn('❌ This command can only be used inside a Discord server.');

  const matchId = args[0]?.toUpperCase();
  if (!matchId) return replyFn('❌ Usage: `.leave <matchId>` (alias: `.release <matchId>`)');

  const res = await handleLeaveMatch(guild, member, matchId);
  if (!res.ok) return replyFn(res.error || '❌ Could not leave match.');

  return replyFn(`✅ You have successfully left match **${matchId}**.`);
}

export const handleReleaseCommand = handleLeaveCommand;
