import {
  ARENA_STATUS,
  ARENA_FINAL_STATUSES,
  getActiveChallenges,
  getArenaMatchesByStatus,
  updateArenaChallenge,
  updateArenaMatch,
  getArenaConfig,
  atomicReleasePlayerMatch,
  logArenaAction,
} from '../models/arenaModels.js';
import {
  buildVolunteerPanelEmbed,
  refreshArenaChallengeCard,
  refreshArenaMatchCards,
} from './arenaNotificationService.js';
import {
  deleteMatchChannel,
  createMatchChannel,
  setupArenaChannels,
  formatMatchChannelName,
  formatRoomMakerChannelName,
} from './arenaChannelService.js';
import { transitionArenaStatus, handleScreenshotTimeout } from './arenaMatchService.js';
import { handleFileDispute } from './arenaDisputeService.js';
import { queueMessageEdit, queueChannelSend } from '../../../../../discordQueue.js';

let schedulerInterval = null;
let activeClient = null;

export function stopArenaScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

export function startArenaScheduler(client) {
  if (client) activeClient = client;
  if (schedulerInterval) return;

  // Run safety check every 30 seconds
  schedulerInterval = setInterval(() => {
    checkArenaLifecycles(activeClient).catch((err) => {
      console.warn('[Arena] ⚠️ Error in scheduler loop:', err.message);
    });
  }, 30 * 1000);

  if (typeof schedulerInterval?.unref === 'function') {
    schedulerInterval.unref();
  }

  // Also trigger initial pass
  checkArenaLifecycles(activeClient).catch(() => {});
}

export async function checkArenaLifecycles(client) {
  if (!client) return;
  const now = new Date();

  // 1. Check Expired Challenges
  const openChallenges = await getActiveChallenges();
  for (const c of openChallenges) {
    if (c.expiresAt && now >= new Date(c.expiresAt)) {
      await expireChallenge(client, c);
    }
  }

  // 2. Check Waiting Matches (Volunteer Warning & Timeout)
  const waitingMatches = await getArenaMatchesByStatus(ARENA_STATUS.WAITING_FOR_VOLUNTEER);
  for (const m of waitingMatches) {
    // 2a. Warning at 15m
    if (!m.volunteerWarningSent && m.volunteerWarningDueAt && now >= new Date(m.volunteerWarningDueAt)) {
      await sendVolunteerWarning(client, m);
    }
    // 2b. Timeout at 45m
    if (m.volunteerTimeoutDueAt && now >= new Date(m.volunteerTimeoutDueAt)) {
      await expireWaitingMatch(client, m);
    }
  }

  // 3. Check Result Confirmation Timeouts (15m in RESULT_PENDING)
  const pendingMatches = await getArenaMatchesByStatus(ARENA_STATUS.RESULT_PENDING);
  for (const m of pendingMatches) {
    if (m.resultTimeoutDueAt && now >= new Date(m.resultTimeoutDueAt)) {
      await handleResultTimeout(client, m);
    }
  }

  // 4. Check Scheduled Channel Cleanups (60m post completion/cancellation)
  const completedMatches = await getArenaMatchesByStatus(ARENA_STATUS.COMPLETED);
  const cancelledMatches = await getArenaMatchesByStatus(ARENA_STATUS.CANCELLED);
  const cleanupCandidates = [...completedMatches, ...cancelledMatches];

  for (const m of cleanupCandidates) {
    if (m.deleteChannelAt && now >= new Date(m.deleteChannelAt) && m.matchChannelId) {
      await cleanupMatchChannel(client, m);
    }
  }

  // 5. Check Screenshot Upload Timeouts (5m in LIVE with pendingWinnerId)
  const liveMatches = await getArenaMatchesByStatus(ARENA_STATUS.LIVE);
  for (const m of liveMatches) {
    if (m.screenshotRequestedAt && m.pendingWinnerId && m.volunteerId) {
      const elapsedMs = now.getTime() - new Date(m.screenshotRequestedAt).getTime();
      if (elapsedMs >= 5 * 60 * 1000) {
        const guild = client.guilds?.cache?.get(m.guildId);
        await handleScreenshotTimeout(guild, m.matchId, m.volunteerId);
      }
    }
  }
}

async function expireChallenge(client, challenge) {
  const updated = await updateArenaChallenge(challenge.challengeId, {
    status: ARENA_STATUS.EXPIRED,
  });

  const guild = client.guilds?.cache?.get(challenge.guildId);
  if (guild) await refreshArenaChallengeCard(guild, updated, { client });

  await logArenaAction({
    action: 'CHALLENGE_EXPIRED',
    challengeId: challenge.challengeId,
    performedBy: 'arena_scheduler',
  });
}

async function sendVolunteerWarning(client, match) {
  await updateArenaMatch(match.matchId, { volunteerWarningSent: true });

  const guild = client.guilds?.cache?.get(match.guildId);
  if (!guild) return;

  const config = await getArenaConfig(guild.id);

  // Announce in public #volunteer-panel (Room Maker Panel)
  if (config?.volunteerPanelId) {
    const volPanel =
      guild.channels.cache.get(config.volunteerPanelId) ||
      (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
    if (volPanel) {
      await queueChannelSend(volPanel, {
        content: `⚠️ **Match ${match.matchId}** has been waiting for a Room Maker for **15 minutes**! Any member can click **Accept Match** to officiate.`,
      });
    }
  }

  // Notify players in match channel
  if (match.matchChannelId) {
    const channel =
      guild.channels.cache.get(match.matchChannelId) ||
      (await guild.channels.fetch(match.matchChannelId).catch(() => null));
    if (channel) {
      await queueChannelSend(channel, {
        content: `⏳ A reminder has been posted in the Room Maker panel. Thank you for your patience while a member claims your match.`,
      });
    }
  }
}

async function expireWaitingMatch(client, match) {
  // Transition status to EXPIRED
  await transitionArenaStatus(match.matchId, ARENA_STATUS.EXPIRED, {
    performedBy: 'arena_scheduler',
    metadata: { reason: 'Room Maker claim timeout (45 minutes)' },
  });

  // Free both players
  await atomicReleasePlayerMatch(match.playerA.discordId, match.matchId);
  await atomicReleasePlayerMatch(match.playerB.discordId, match.matchId);

  const guild = client.guilds?.cache?.get(match.guildId);
  if (guild) {
    const config = await getArenaConfig(guild.id);

    // Update Room Maker panel message (remove button)
    if (config?.volunteerPanelId && match.panelMessageId) {
      const volPanel =
        guild.channels.cache.get(config.volunteerPanelId) ||
        (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
      if (volPanel) {
        const msg =
          volPanel.messages?.cache?.get(match.panelMessageId) ||
          (await volPanel.messages?.fetch?.(match.panelMessageId).catch(() => null));
        if (msg) {
          const payload = await buildVolunteerPanelEmbed({ ...match, status: ARENA_STATUS.EXPIRED }, null, { guild, client });
          await queueMessageEdit(msg, payload).catch(() => {});
        }
      }
    }

    // Delete match channel and room maker channel
    if (match.matchChannelId) {
      await deleteMatchChannel(guild, match.matchChannelId);
    }
    const rmChanId = match.roomMakerChannelId || match.roomChannelId;
    if (rmChanId) {
      await deleteMatchChannel(guild, rmChanId);
    }
  }

  await logArenaAction({
    action: 'MATCH_EXPIRED',
    matchId: match.matchId,
    performedBy: 'arena_scheduler',
  });
}

async function handleResultTimeout(client, match) {
  const guild = client.guilds?.cache?.get(match.guildId);
  if (!guild) return;

  await handleFileDispute(
    guild,
    { id: 'system', displayName: 'System Scheduler' },
    match.matchId,
    'Automatic review triggered: 15-minute player confirmation timeout expired.'
  );
}

async function cleanupMatchChannel(client, match) {
  const guild = client.guilds?.cache?.get(match.guildId);
  if (guild) {
    if (match.matchChannelId) {
      await deleteMatchChannel(guild, match.matchChannelId);
    }
    const rmChanId = match.roomMakerChannelId || match.roomChannelId;
    if (rmChanId) {
      await deleteMatchChannel(guild, rmChanId);
    }
    await updateArenaMatch(match.matchId, {
      matchChannelId: null,
      roomMakerChannelId: null,
      roomChannelId: null,
      deleteChannelAt: null,
    });
  }
}

/**
 * Startup recovery: restores persistent panel message, reconciles active matches, and re-arms timers.
 */
export async function recoverArenaOnStartup(client) {
  if (!client) return;
  activeClient = client;

  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getArenaConfig(guild.id);
      if (!config) continue;

      // 1. Restore persistent panel message in #create-challenge in place
      if (config.createChannelId) {
        await setupArenaChannels(guild, null).catch((err) => {
          console.warn(`[Arena] ⚠️ Error restoring persistent panel in ${guild.id}:`, err.message);
        });
      }

      // Rebuild open challenge cards in place from current MongoDB player profiles.
      for (const challenge of await getActiveChallenges(guild.id)) {
        if (!challenge.discordChannelId && config.availableChannelId) {
          challenge.discordChannelId = config.availableChannelId;
          await updateArenaChallenge(challenge.challengeId, { discordChannelId: config.availableChannelId });
        }
        if (challenge.discordChannelId) {
          await refreshArenaChallengeCard(guild, challenge, { client, allowCreateIfMissing: true });
        }
      }

      // 2. Reconcile active matches with Discord
      const activeMatches = [
        ...(await getArenaMatchesByStatus(ARENA_STATUS.WAITING_FOR_VOLUNTEER, guild.id)),
        ...(await getArenaMatchesByStatus(ARENA_STATUS.VOLUNTEER_ASSIGNED, guild.id)),
        ...(await getArenaMatchesByStatus(ARENA_STATUS.ROOM_READY, guild.id)),
        ...(await getArenaMatchesByStatus(ARENA_STATUS.LIVE, guild.id)),
        ...(await getArenaMatchesByStatus(ARENA_STATUS.RESULT_PENDING, guild.id)),
        ...(await getArenaMatchesByStatus(ARENA_STATUS.UNDER_REVIEW, guild.id)),
      ];

      for (const m of activeMatches) {
        if (!m.matchChannelId) {
          // Channel was missing or deleted, recreate it
          const recreated = await createMatchChannel(guild, m, config).catch(() => null);
          if (recreated) {
            await updateArenaMatch(m.matchId, { matchChannelId: recreated.id });
            m.matchChannelId = recreated.id;
            m.matchEmbedMessageId = null;
          }
        } else {
          // Verify channel still exists
          const existingCh =
            guild.channels.cache.get(m.matchChannelId) ||
            (await guild.channels.fetch(m.matchChannelId).catch(() => null));
          if (!existingCh) {
            const recreated = await createMatchChannel(guild, m, config).catch(() => null);
            if (recreated) {
              await updateArenaMatch(m.matchId, { matchChannelId: recreated.id });
              m.matchChannelId = recreated.id;
              m.matchEmbedMessageId = null;
            }
          } else {
            const expectedName = formatMatchChannelName(m.matchId);
            if (existingCh.name !== expectedName && typeof existingCh.setName === 'function') {
              await existingCh.setName(expectedName).catch(() => {});
              existingCh.name = expectedName;
            }
          }
        }

        const rmChId = m.roomMakerChannelId || m.roomChannelId;
        if (rmChId) {
          const rmCh =
            guild.channels.cache.get(rmChId) ||
            (await guild.channels.fetch(rmChId).catch(() => null));
          if (rmCh) {
            const expectedRmName = formatRoomMakerChannelName(m.matchId);
            if (rmCh.name !== expectedRmName && typeof rmCh.setName === 'function') {
              await rmCh.setName(expectedRmName).catch(() => {});
              rmCh.name = expectedRmName;
            }
          }
        }
        await refreshArenaMatchCards(guild, m, { client, allowCreateIfMissing: true });
      }

      // 2b. Cleanup completed / terminal matches from Room Maker panel if lingering
      if (config.volunteerPanelId) {
        const panel =
          guild.channels.cache.get(config.volunteerPanelId) ||
          (await guild.channels.fetch(config.volunteerPanelId).catch(() => null));
        if (panel) {
          const finalMatches = [
            ...(await getArenaMatchesByStatus(ARENA_STATUS.COMPLETED, guild.id)),
            ...(await getArenaMatchesByStatus(ARENA_STATUS.CANCELLED, guild.id)),
            ...(await getArenaMatchesByStatus(ARENA_STATUS.EXPIRED, guild.id)),
          ];
          for (const fm of finalMatches) {
            if (fm.panelMessageId) {
              const msg =
                panel.messages?.cache?.get(fm.panelMessageId) ||
                (await panel.messages?.fetch?.(fm.panelMessageId).catch(() => null));
              if (msg) {
                await msg.delete().catch(() => {});
              }
              await updateArenaMatch(fm.matchId, { panelMessageId: null });
            }
          }
        }
      }
    } catch (guildErr) {
      console.warn(`[Arena] ⚠️ Error reconciling guild ${guild.id}:`, guildErr.message);
    }
  }

  // Trigger initial pass on all timers
  await checkArenaLifecycles(client);
}

