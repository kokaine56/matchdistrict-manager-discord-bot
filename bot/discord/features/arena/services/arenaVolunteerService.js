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
  addRoomMakerToRoomChannel,
  removeRoomMakerFromRoomChannel,
} from './arenaChannelService.js';
import {
  buildVolunteerPanelEmbed,
  buildMatchChannelEmbed,
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

  // 1. Grant volunteer access to private match channel
  if (match.matchChannelId) {
    const matchChannel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    const avatars = await fetchMatchAvatars(guild.client, updatedMatch);

    if (matchChannel) {
      await addVolunteerToMatchChannel(matchChannel, member.id);

      // Edit main match embed in channel
      if (match.matchEmbedMessageId) {
        const embedMsg =
          matchChannel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await matchChannel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (embedMsg) {
          const payload = await buildMatchChannelEmbed(updatedMatch, volunteerName, { avatars, guild, client: guild.client });
          await queueMessageEdit(embedMsg, payload).catch(() => {});
        }
      }

      await queueChannelSend(matchChannel, {
        content: `📋 <@${member.id}> has volunteered as Room Maker to officiate this match.\nPlease submit the room credentials when ready using **Submit Room Details**.`,
      });
    }
  }

  // Also grant Room Maker access to room channel if it exists
  if (match.roomChannelId) {
    const roomChannel =
      guild.channels.cache.get(match.roomChannelId) ||
      (await guild.channels.fetch(match.roomChannelId).catch(() => null));
    if (roomChannel) {
      await addRoomMakerToRoomChannel(roomChannel, member.id);
    }
  }

  // 2. Update #volunteer-panel message (assigned, no button)
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

  if (!isAdminAction && match.volunteerId !== member.id) {
    return { ok: false, error: '❌ You are not the assigned Room Maker for this match.' };
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

  // 1. Remove Room Maker permissions from match channel
  if (match.matchChannelId) {
    const matchChannel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (matchChannel) {
      if (prevVolunteerId) {
        await removeVolunteerFromMatchChannel(matchChannel, prevVolunteerId);
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

      await queueChannelSend(matchChannel, {
        content: `⚠️ The assigned Room Maker has left this match. Waiting for a new Room Maker to claim...`,
      });
    }
  }

  // 2. Remove Room Maker permissions from room channel & clear room message
  if (match.roomChannelId) {
    const roomChannel =
      guild.channels.cache.get(match.roomChannelId) ||
      (await guild.channels.fetch(match.roomChannelId).catch(() => null));
    if (roomChannel) {
      if (prevVolunteerId) {
        await removeRoomMakerFromRoomChannel(roomChannel, prevVolunteerId);
      }
      if (match.roomMessageId) {
        const roomMsg =
          roomChannel.messages?.cache?.get(match.roomMessageId) ||
          (await roomChannel.messages?.fetch?.(match.roomMessageId).catch(() => null));
        if (roomMsg) {
          await queueMessageEdit(roomMsg, {
            content: `⚠️ The previous Room Maker has left the match. Room credentials have been cleared. Waiting for a new Room Maker to claim and submit credentials.`,
            components: [],
          }).catch(() => {});
        }
      }
    }
  }

  // 3. Re-enable #volunteer-panel message with Accept Match button
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
