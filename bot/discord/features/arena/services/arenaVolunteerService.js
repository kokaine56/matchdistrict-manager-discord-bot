import {
  ARENA_STATUS,
  getArenaMatch,
  updateArenaMatch,
  getArenaVolunteer,
  upsertArenaVolunteer,
  updateArenaVolunteer,
  getArenaConfig,
  getArenaPlayer,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  addVolunteerToMatchChannel,
  removeVolunteerFromMatchChannel,
} from './arenaChannelService.js';
import {
  buildVolunteerPanelEmbed,
  buildMatchChannelEmbed,
} from './arenaNotificationService.js';
import { queueMessageEdit, queueChannelSend } from '../../../../../discordQueue.js';

export async function hasVolunteerRole(member, config) {
  if (!member) return false;
  if (config?.volunteerRoleId && member.roles?.cache?.has?.(config.volunteerRoleId)) {
    return true;
  }
  const rolesArray = typeof member.roles?.cache?.values === 'function'
    ? Array.from(member.roles.cache.values())
    : Array.isArray(member.roles?.cache) ? member.roles.cache : [];
  return rolesArray.some((r) => r.name?.toLowerCase() === 'volunteer');
}

export async function handleClaimMatch(guild, member, matchId) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const config = await getArenaConfig(guild.id);
  const isVol = await hasVolunteerRole(member, config);
  if (!isVol) {
    return {
      ok: false,
      error: '❌ **Permission Denied:** You must have the `Volunteer` role to officiate arena matches.',
    };
  }

  // Get or initialize volunteer record
  let volunteer = await getArenaVolunteer(member.id);
  if (!volunteer) {
    volunteer = await upsertArenaVolunteer(member.id, {
      status: 'AVAILABLE',
      activeMatches: 0,
      totalMatches: 0,
    });
  }

  if (volunteer.suspended) {
    return {
      ok: false,
      error: '❌ **Volunteer Suspended:** Your volunteer privileges are currently suspended.',
    };
  }

  if (volunteer.status === 'UNAVAILABLE') {
    return {
      ok: false,
      error: '❌ **Currently Unavailable:** You are marked as unavailable. Use `.volunteer status` to toggle your availability.',
    };
  }

  // Enforce active match limit
  const limit = Math.max(1, Number(config?.volunteerMatchLimit || 1));
  if (volunteer.activeMatches >= limit) {
    return {
      ok: false,
      error: `❌ **Match Limit Reached:** You already have **${volunteer.activeMatches}** active match (limit: ${limit}). Complete or release it before claiming another.`,
    };
  }

  const match = await getArenaMatch(matchId);
  if (!match) {
    return { ok: false, error: '❌ Match not found.' };
  }

  if (match.status !== ARENA_STATUS.WAITING_FOR_VOLUNTEER || match.volunteerId) {
    return {
      ok: false,
      error: '❌ This match has already been claimed by another volunteer or is no longer waiting.',
    };
  }

  // Prevent players from claiming their own match
  if (match.playerA.discordId === member.id || match.playerB.discordId === member.id) {
    return {
      ok: false,
      error: '❌ **Self-Officiation Prohibited:** You cannot officiate a match you are playing in.',
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
        error: '❌ **Conflict of Interest:** Your registered BGMI UID matches one of the players in this match.',
      };
    }
  }

  // Atomic claim
  const now = new Date();
  const updatedMatch = await updateArenaMatch(matchId, {
    status: ARENA_STATUS.VOLUNTEER_ASSIGNED,
    volunteerId: member.id,
    assignedAt: now,
  });

  await updateArenaVolunteer(member.id, {
    activeMatches: volunteer.activeMatches + 1,
  });

  const volunteerName = member.displayName || member.user?.username || 'Volunteer';

  // 1. Grant volunteer access to match channel
  if (match.matchChannelId) {
    const matchChannel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (matchChannel) {
      await addVolunteerToMatchChannel(matchChannel, member.id);

      // Edit main match embed in channel
      if (match.matchEmbedMessageId) {
        const embedMsg =
          matchChannel.messages?.cache?.get(match.matchEmbedMessageId) ||
          (await matchChannel.messages?.fetch?.(match.matchEmbedMessageId).catch(() => null));
        if (embedMsg) {
          const payload = buildMatchChannelEmbed(updatedMatch, volunteerName);
          await queueMessageEdit(embedMsg, payload).catch(() => {});
        }
      }

      // Send assignment announcement in channel
      await queueChannelSend(matchChannel, {
        content: `📋 <@${member.id}> has claimed this match as the volunteer.\nPlease submit the room credentials when ready using **Submit Room Details**.`,
      });
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
        const payload = buildVolunteerPanelEmbed(updatedMatch, volunteerName);
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

export async function handleReleaseMatch(guild, member, matchId, isAdminAction = false) {
  if (!guild || !member || !matchId) throw new Error('Missing arguments');

  const match = await getArenaMatch(matchId);
  if (!match) {
    return { ok: false, error: '❌ Match not found.' };
  }

  if (!isAdminAction && match.volunteerId !== member.id) {
    return { ok: false, error: '❌ You are not the assigned volunteer for this match.' };
  }

  // Release only permitted until LIVE
  if (
    match.status !== ARENA_STATUS.VOLUNTEER_ASSIGNED &&
    match.status !== ARENA_STATUS.ROOM_READY
  ) {
    return {
      ok: false,
      error: `❌ Match cannot be released once it is ${match.status}. Only administrators can reassign live matches.`,
    };
  }

  const prevVolunteerId = match.volunteerId;

  // Revert match status
  const updatedMatch = await updateArenaMatch(matchId, {
    status: ARENA_STATUS.WAITING_FOR_VOLUNTEER,
    volunteerId: null,
    assignedAt: null,
    roomId: null,
    roomPassword: null,
  });

  // Decrement previous volunteer active matches
  if (prevVolunteerId) {
    const vol = await getArenaVolunteer(prevVolunteerId);
    if (vol) {
      await updateArenaVolunteer(prevVolunteerId, {
        activeMatches: Math.max(0, vol.activeMatches - 1),
      });
    }
  }

  const config = await getArenaConfig(guild.id);

  // 1. Remove volunteer permissions from match channel
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
          const payload = buildMatchChannelEmbed(updatedMatch);
          await queueMessageEdit(embedMsg, payload).catch(() => {});
        }
      }

      await queueChannelSend(matchChannel, {
        content: `⚠️ The volunteer has released this match. Waiting for a new volunteer to claim...`,
      });
    }
  }

  // 2. Re-enable #volunteer-panel message with Accept Match button
  if (config?.volunteerPanelId && match.panelMessageId) {
    const volPanel =
      guild.channels.cache.get(config.volunteerPanelId) ||
      (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
    if (volPanel) {
      const volMsg =
        volPanel.messages?.cache?.get(match.panelMessageId) ||
        (await volPanel.messages?.fetch?.(match.panelMessageId).catch(() => null));
      if (volMsg) {
        const payload = buildVolunteerPanelEmbed(updatedMatch);
        await queueMessageEdit(volMsg, payload).catch(() => {});
      }
    }
  }

  await logArenaAction({
    action: 'MATCH_RELEASED',
    matchId,
    performedBy: member.id,
    metadata: { previousVolunteerId: prevVolunteerId, isAdminAction },
  });

  return { ok: true, match: updatedMatch };
}
