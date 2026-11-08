import {
  ARENA_STATUS,
  getArenaMatch,
  updateArenaMatch,
  getArenaVolunteer,
  upsertArenaVolunteer,
  updateArenaVolunteer,
  getArenaConfig,
  getArenaPlayer,
  atomicClaimArenaMatch,
  atomicLeaveArenaMatch,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  addVolunteerToMatchChannel,
  removeVolunteerFromMatchChannel,
  addRoomMakerToRoomMakerChannel,
  removeRoomMakerFromRoomMakerChannel,
} from './arenaChannelService.js';
import {
  buildVolunteerPanelEmbed,
  buildMatchChannelEmbed,
  buildArenaStatusEmbed,
  purgeStandaloneRoomMakerMessages,
  sendRoomMakerNeededNotification,
  deleteRoomMakerNotification,
} from './arenaNotificationService.js';
import { fetchMatchAvatars } from './arenaImageService.js';
import { queueMessageEdit, queueChannelSend } from '../../../../../discordQueue.js';

export async function handleClaimMatch(guild, member, matchId) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const config = await getArenaConfig(guild.id);
  const limit = Math.max(1, Number(config?.volunteerMatchLimit || 1));

  // Auto-create or refresh volunteer record with current Discord display name
  const currentDisplayName = member.displayName || member.user?.username || 'Volunteer';
  const volunteer = await upsertArenaVolunteer(member.id, {
    displayName: currentDisplayName,
  });

  // Pre-checks
  if (volunteer.suspended) {
    return {
      ok: false,
      error: '❌ You are suspended from volunteering.',
    };
  }

  if (volunteer.status === 'UNAVAILABLE') {
    return {
      ok: false,
      error: '❌ You are marked as unavailable. Use `.volunteer status` to toggle your availability.',
    };
  }

  if (volunteer.activeMatches >= limit) {
    return {
      ok: false,
      error: `❌ You have reached your active match limit of ${limit}. Complete or release your active match first.`,
    };
  }

  const match = await getArenaMatch(matchId);
  if (!match) {
    return { ok: false, error: '❌ Match not found.' };
  }

  if (match.status !== ARENA_STATUS.WAITING_FOR_VOLUNTEER || match.volunteerId) {
    return {
      ok: false,
      error: 'This match has already been claimed by another volunteer.',
    };
  }

  // Prevent players from volunteering for their own match
  if (match.playerA.discordId === member.id || match.playerB.discordId === member.id) {
    return {
      ok: false,
      error: '❌ You cannot volunteer for your own match.',
    };
  }

  // Check if already assigned to this match
  if (match.volunteerId === member.id) {
    return {
      ok: false,
      error: 'You are already assigned to this match.',
    };
  }

  // Check volunteer's saved BGMI UID against both players' UIDs
  const volunteerPlayer = await getArenaPlayer(member.id);
  if (volunteerPlayer?.bgmiUid) {
    if (
      volunteerPlayer.bgmiUid === match.playerA.bgmiUid ||
      volunteerPlayer.bgmiUid === match.playerB.bgmiUid
    ) {
      return {
        ok: false,
        error: '❌ Conflict of Interest: Your registered BGMI UID matches one of the players in this match.',
      };
    }
  }

  // Atomic conditional claim
  const claimRes = await atomicClaimArenaMatch(matchId, member.id, limit);
  if (!claimRes.ok) {
    return claimRes;
  }

  const updatedMatch = claimRes.match;
  const volunteerName = member.displayName || member.user?.username || 'Volunteer';

  const avatars = await fetchMatchAvatars(guild.client, updatedMatch);

  // 1. Grant Room Maker access to their private Room Maker channel (roommaker-0001)
  const rmChannelId = match.roomMakerChannelId || match.roomChannelId;
  if (rmChannelId) {
    const rmChannel =
      guild.channels.cache.get(rmChannelId) ||
      (await guild.channels.fetch(rmChannelId).catch(() => null));
    if (rmChannel) {
      await addRoomMakerToRoomMakerChannel(rmChannel, member.id);

      // Post Room Maker match card with management controls (dashboard only)
      const rmPayload = await buildMatchChannelEmbed(updatedMatch, volunteerName, {
        avatars,
        guild,
        client: guild.client,
        surface: 'roomMakerChannel',
      });
      const rmMsg = await queueChannelSend(rmChannel, rmPayload);
      if (rmMsg?.id) {
        await updateArenaMatch(matchId, { roomMakerMessageId: rmMsg.id });
      }
      await purgeStandaloneRoomMakerMessages(rmChannel, rmMsg?.id);
    }
  }

  // 2. Update challengers' match channel (match-0001) - Room Maker identity STRICTLY hidden
  if (match.matchChannelId) {
    const matchChannel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));

    if (matchChannel) {
      // Edit main match embed in channel (shows ROOM MAKER ASSIGNED, no Room Maker name)
      if (match.matchEmbedMessageId) {
        const embedMsg =
          matchChannel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await matchChannel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (embedMsg) {
          const payload = await buildMatchChannelEmbed(updatedMatch, null, { avatars, guild, client: guild.client });
          await queueMessageEdit(embedMsg, payload).catch(() => {});
        }
      }

      // Clean embed notice for challengers - Bot speaks on behalf of the Room Maker
      const assignedNotice = buildArenaStatusEmbed({
        title: '📋 Room Maker Assigned',
        description:
          'A Room Maker has been assigned to your match.\n' +
          'They are currently preparing the BGMI custom room credentials. Room details will appear here as soon as they are ready.',
      });
      await queueChannelSend(matchChannel, { embeds: [assignedNotice] });
    }
  }

  // 3. Update #room-maker-panel message (assigned, no button)
  if (config?.volunteerPanelId && match.panelMessageId) {
    const volPanel =
      guild.channels.cache.get(config.volunteerPanelId) ||
      (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
    if (volPanel) {
      const volMsg =
        volPanel.messages?.cache?.get(match.panelMessageId) ||
        (await volPanel.messages?.fetch?.(match.panelMessageId).catch(() => null));
      if (volMsg) {
        const avatars = await fetchMatchAvatars(guild.client, updatedMatch);
        const payload = await buildVolunteerPanelEmbed(updatedMatch, volunteerName, { avatars, guild, client: guild.client });
        await queueMessageEdit(volMsg, payload).catch(() => {});
      }
    }
  }

  // Delete Room Maker availability notification once claimed
  await deleteRoomMakerNotification(guild, match);

  await logArenaAction({
    action: 'MATCH_CLAIMED',
    matchId,
    performedBy: member.id,
    metadata: { volunteerDisplayName: volunteerName },
  });

  return { ok: true, match: updatedMatch };
}

export async function handleLeaveMatch(guild, member, matchId, isAdminAction = false) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) {
    return { ok: false, error: '❌ Match not found.' };
  }

  if (!isAdminAction) {
    if (match.volunteerId !== member.id) {
      return { ok: false, error: '❌ You are not the assigned Room Maker for this match.' };
    }
    if (match.roomId || match.status !== ARENA_STATUS.VOLUNTEER_ASSIGNED) {
      return {
        ok: false,
        error: '❌ You cannot leave the match after submitting room credentials. Only an administrator can reassign this match.',
      };
    }
  }

  // Atomically leave match (guaranteed concurrency & double-click protection)
  const leaveRes = await atomicLeaveArenaMatch(matchId, isAdminAction ? null : member.id);
  if (!leaveRes.ok) {
    return leaveRes;
  }

  const updatedMatch = leaveRes.match;
  const prevVolunteerId = leaveRes.previousRoomMakerId;
  const config = await getArenaConfig(guild.id);
  const avatars = await fetchMatchAvatars(guild.client, updatedMatch);

  // Delete previous Room Maker availability notification before sending a fresh one
  await deleteRoomMakerNotification(guild, match);

  // 1. Remove Room Maker access from their private channel (roommaker-0001)
  const rmChannelId = match.roomMakerChannelId || match.roomChannelId;
  if (rmChannelId) {
    const rmChannel =
      guild.channels.cache.get(rmChannelId) ||
      (await guild.channels.fetch(rmChannelId).catch(() => null));
    if (rmChannel) {
      if (prevVolunteerId) {
        await removeRoomMakerFromRoomMakerChannel(rmChannel, prevVolunteerId);
      }
      if (match.roomMakerMessageId) {
        const rmMsg =
          rmChannel.messages?.cache?.get(match.roomMakerMessageId) ||
          (await rmChannel.messages?.fetch?.(match.roomMakerMessageId).catch(() => null));
        if (rmMsg) {
          await rmMsg.delete().catch(() => {});
        }
      }
      await purgeStandaloneRoomMakerMessages(rmChannel, null);
    }
  }

  // 2. Clear credentials from challengers channel & update match card
  if (match.matchChannelId) {
    const matchChannel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (matchChannel) {
      if (prevVolunteerId) {
        await removeVolunteerFromMatchChannel(matchChannel, prevVolunteerId);
      }

      if (match.roomMessageId) {
        const roomMsg =
          matchChannel.messages?.cache?.get(match.roomMessageId) ||
          (await matchChannel.messages?.fetch?.(match.roomMessageId).catch(() => null));
        if (roomMsg) {
          await roomMsg.delete().catch(() => {});
        }
      }

      if (match.matchEmbedMessageId) {
        const embedMsg =
          matchChannel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await matchChannel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (embedMsg) {
          const payload = await buildMatchChannelEmbed(updatedMatch, null, { avatars, guild, client: guild.client });
          await queueMessageEdit(embedMsg, payload).catch(() => {});
        }
      }

      const pNotice = buildArenaStatusEmbed({
        title: '⚠️ Room Maker Left',
        description:
          'The assigned Room Maker has left this match. Credentials have been cleared.\n' +
          'Waiting for a new Room Maker to claim this match from #room-maker-panel...',
      });
      await queueChannelSend(matchChannel, { embeds: [pNotice] });
    }
  }

  // 3. Re-enable #room-maker-panel message with Accept Match button
  if (config?.volunteerPanelId && match.panelMessageId) {
    const volPanel =
      guild.channels.cache.get(config.volunteerPanelId) ||
      (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
    if (volPanel) {
      const volMsg =
        volPanel.messages?.cache?.get(match.panelMessageId) ||
        (await volPanel.messages?.fetch?.(match.panelMessageId).catch(() => null));
      if (volMsg) {
        const payload = await buildVolunteerPanelEmbed(updatedMatch, null, { avatars, guild, client: guild.client });
        await queueMessageEdit(volMsg, payload).catch(() => {});
      }
      // Send @here notification since match is waiting for a Room Maker again
      await sendRoomMakerNeededNotification(guild, updatedMatch, volPanel);
    }
  }

  await logArenaAction({
    action: 'MATCH_LEFT',
    matchId,
    performedBy: member.id,
    metadata: { previousVolunteerId: prevVolunteerId, isAdminAction },
  });

  return { ok: true, match: updatedMatch };
}

export const handleReleaseMatch = handleLeaveMatch;
