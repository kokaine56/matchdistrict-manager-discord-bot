import {
  getAllActiveConfigurableRegistrations,
  getAllConfigurableTournaments,
  getConfigurableRegistrationsForTournament,
  getConfigurableEntriesForRegistration,
  getConfigurableRegistration,
  saveConfigurableRegistration,
  archiveActiveRegistrationCycle,
  evaluateDailyCycleStatus,
  getCurrentTimeInTimezone,
  computeNextScheduleTimestamps,
  parseReservedSlots,
  getLockedSlotNumbers,
  syncRegistrationSlotStates,
  cleanUpStaleConfigurableRegistrationsAndEntries,
} from './configurableTournamentData.js';
import {
  updateRegistrationMessage,
  updateManageDashboardMessage,
  reconcileRegistrationScheduleMessage,
} from './configurableRegistrationService.js';
import { updateSlotChartMessage, syncRegistrationSlotList } from './slotChartService.js';
import { refreshDashboard, reorderTournamentCategoryChannels } from './configurableTournamentService.js';
import { sendOrUpdateEnrollmentMessage } from './teamEnrollmentService.js';
import { acquireLock, releaseLock } from './mongoService.js';

export const SAFETY_CHECK_INTERVAL_MS = 5 * 1000;
export const MAX_TIMER_CHUNK_MS = 10 * 60 * 1000;
export const PRE_WAKEUP_BUFFER_MS = 500;

let schedulerInterval = null;
let activeSchedulerClient = null;

// Per-registration armed timers: registrationId -> { timerId, registrationId, targetTimeMs, nextStartAt, nextResetAt, nextDueAt, action }
const registrationTimers = new Map();

// High-priority scheduled job queue (runs ahead of background tasks)
const priorityJobQueue = [];
const backgroundJobQueue = [];
let isProcessingQueue = false;

/**
 * Runs a scheduled start/reset job with high priority ahead of any queued background work.
 * @param {() => Promise<any>} jobFn
 * @returns {Promise<any>}
 */
export function enqueuePriorityScheduledJob(jobFn) {
  return new Promise((resolve, reject) => {
    priorityJobQueue.push({ jobFn, resolve, reject });
    drainJobQueues();
  });
}

/**
 * Enqueues non-urgent follow-up work behind priority scheduled jobs.
 * @param {() => Promise<any>} jobFn
 * @returns {Promise<any>}
 */
export function enqueueBackgroundJob(jobFn) {
  return new Promise((resolve, reject) => {
    backgroundJobQueue.push({ jobFn, resolve, reject });
    drainJobQueues();
  });
}

async function drainJobQueues() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (priorityJobQueue.length > 0 || backgroundJobQueue.length > 0) {
      const nextItem = priorityJobQueue.length > 0
        ? priorityJobQueue.shift()
        : backgroundJobQueue.shift();
      if (!nextItem) break;
      try {
        const result = await nextItem.jobFn();
        nextItem.resolve(result);
      } catch (err) {
        nextItem.reject(err);
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Cancels and removes an armed timer for a specific registration.
 * @param {string} registrationId
 */
export function clearRegistrationTimer(registrationId) {
  if (!registrationId) return;
  const existing = registrationTimers.get(registrationId);
  if (existing?.timerId) {
    clearTimeout(existing.timerId);
  }
  registrationTimers.delete(registrationId);
}

/**
 * Clears all armed registration timers.
 */
export function clearAllRegistrationTimers() {
  for (const entry of registrationTimers.values()) {
    if (entry?.timerId) {
      clearTimeout(entry.timerId);
    }
  }
  registrationTimers.clear();
}

/**
 * Returns the currently armed timer metadata for a registration (useful for diagnostics and tests).
 * @param {string} registrationId
 */
export function getArmedRegistrationTimer(registrationId) {
  return registrationTimers.get(registrationId) || null;
}

/**
 * Computes the next due time (start and reset) in the registration's timezone, stores it in MongoDB,
 * and arms a timer for that exact moment (split into chunks for long waits and recomputed at the end
 * of each chunk to correct drift).
 *
 * @param {import('discord.js').Client} client
 * @param {object} registration
 * @param {Date} [customNow]
 * @returns {Promise<object|null>}
 */
export async function armRegistrationTimer(client, registration, customNow = null) {
  if (!registration || !registration.registrationId) return null;
  if (registration.status === 'DELETED' || registration.isDeleted) {
    clearRegistrationTimer(registration.registrationId);
    return null;
  }

  const effectiveClient = client || activeSchedulerClient;
  const now = customNow instanceof Date ? customNow : new Date();
  const timezone = registration.timezone || 'Asia/Kolkata';

  let nextStartAt = null;
  let nextResetAt = null;
  let nextDueAt = null;
  let nextDueAction = null;

  if (registration.dailyStartTime || registration.dailyResetTime) {
    const computed = computeNextScheduleTimestamps(
      registration.dailyStartTime,
      registration.dailyResetTime,
      timezone,
      now
    );
    nextStartAt = computed.nextStartAt;
    nextResetAt = computed.nextResetAt;
    nextDueAt = computed.nextDueAt;
    nextDueAction = computed.nextDueAction;
  } else if (registration.status === 'UPCOMING' && registration.startsAt) {
    const startTime = new Date(registration.startsAt);
    if (!isNaN(startTime.getTime()) && startTime > now) {
      nextStartAt = startTime;
      nextDueAt = startTime;
      nextDueAction = 'START';
    }
  } else if (registration.status === 'OPEN' && registration.endsAt) {
    const endTime = new Date(registration.endsAt);
    if (!isNaN(endTime.getTime()) && endTime > now) {
      nextResetAt = endTime;
      nextDueAt = endTime;
      nextDueAction = 'END';
    }
  }

  // Store computed next due timestamps in MongoDB
  registration.nextStartAt = nextStartAt;
  registration.nextResetAt = nextResetAt;
  registration.nextDueAt = nextDueAt;
  registration.nextDueAction = nextDueAction;
  registration._scheduleBaseNow = now;
  await saveConfigurableRegistration(registration);

  clearRegistrationTimer(registration.registrationId);

  if (!nextDueAt || !(nextDueAt instanceof Date) || isNaN(nextDueAt.getTime())) {
    return null;
  }

  const targetTimeMs = nextDueAt.getTime();
  const registrationId = registration.registrationId;

  const scheduleChunk = () => {
    const currentNowMs = Date.now();
    const remainingMs = targetTimeMs - currentNowMs;

    if (remainingMs <= 0) {
      registrationTimers.delete(registrationId);
      enqueuePriorityScheduledJob(async () => {
        await executeExactDueTransition(effectiveClient, registrationId, new Date(Math.max(currentNowMs, targetTimeMs)));
      }).catch((err) => {
        console.error(`[RegistrationScheduler] ❌ Error executing scheduled transition for ${registrationId}:`, err.message);
      });
      return;
    }

    // Split long waits into chunks and wake up 500ms before target to recompute exact sub-second delay
    let delayMs;
    if (remainingMs > MAX_TIMER_CHUNK_MS) {
      delayMs = MAX_TIMER_CHUNK_MS;
    } else if (remainingMs > 2000) {
      delayMs = remainingMs - PRE_WAKEUP_BUFFER_MS;
    } else {
      delayMs = remainingMs;
    }

    const timerId = setTimeout(scheduleChunk, Math.max(1, delayMs));
    if (typeof timerId?.unref === 'function') {
      timerId.unref();
    }

    registrationTimers.set(registrationId, {
      timerId,
      registrationId,
      targetTimeMs,
      nextStartAt,
      nextResetAt,
      nextDueAt,
      action: nextDueAction,
      chunkDelayMs: delayMs,
    });
  };

  scheduleChunk();
  return registrationTimers.get(registrationId) || {
    registrationId,
    targetTimeMs,
    nextStartAt,
    nextResetAt,
    nextDueAt,
    action: nextDueAction,
  };
}

/**
 * Loads a registration by ID from MongoDB and arms its exact timer.
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @param {Date} [customNow]
 */
export async function armRegistrationTimerById(client, registrationId, customNow = null) {
  if (!registrationId) return null;
  const reg = await getConfigurableRegistration(registrationId);
  if (!reg) {
    clearRegistrationTimer(registrationId);
    return null;
  }
  return armRegistrationTimer(client, reg, customNow);
}

/**
 * Re-arms exact timers for all active registrations in MongoDB.
 * @param {import('discord.js').Client} client
 * @param {Date} [customNow]
 */
export async function armAllRegistrationTimers(client, customNow = null) {
  const allRegs = await getAllActiveConfigurableRegistrations();
  for (const reg of allRegs) {
    await armRegistrationTimer(client, reg, customNow).catch((err) => {
      console.warn(`[RegistrationScheduler] ⚠️ Could not arm timer for ${reg.registrationId}:`, err.message);
    });
  }
}

/**
 * Executes an automated daily cycle reset for a registration instance.
 * Critical step first:
 * 1. Saves the cleared cycle and new status on the registration document in MongoDB.
 * 2. Immediately edits the persistent registration message in Discord.
 * Slower work after:
 * 3. Safely archives active slot allocations to discord_daily_registration_cycles and marks entries ARCHIVED.
 * 4. Refreshes the slot chart to clean state.
 * 5. Clears leader IDP channel permissions.
 * 6. Refreshes dashboards and re-arms the next scheduled timer.
 *
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @param {boolean} [force]
 * @param {Date} [customNow]
 * @returns {Promise<boolean>}
 */
export async function executeDailyCycleReset(client, registrationId, force = false, customNow = null) {
  const lockKey = `lock:reg_confirm:${registrationId}`;
  await acquireLock(lockKey, 10, 3000);
  try {
    const reg = await getConfigurableRegistration(registrationId);
    if (!reg) return false;

    const timezone = reg.timezone || 'Asia/Kolkata';
    const now = customNow instanceof Date ? customNow : new Date();
    const cycleEval = evaluateDailyCycleStatus(reg.dailyStartTime, reg.dailyResetTime, timezone, now);
    const cycleDateToArchive = force
      ? (reg.currentCycleDate || cycleEval.endedCycleDate || getCurrentTimeInTimezone(timezone, now).dateString)
      : (cycleEval.endedCycleDate || reg.currentCycleDate || getCurrentTimeInTimezone(timezone, now).dateString);

    if (!force) {
      if (reg.lastResetCycleDate && reg.lastResetCycleDate === cycleDateToArchive) {
        return false;
      }
      if (reg.currentCycleDate && cycleEval.endedCycleDate && reg.currentCycleDate > cycleEval.endedCycleDate) {
        // The current active cycle has not ended yet; align lastResetCycleDate without resetting active entries
        if (reg.lastResetCycleDate !== cycleEval.endedCycleDate) {
          reg.lastResetCycleDate = cycleEval.endedCycleDate;
          await saveConfigurableRegistration(reg);
        }
        return false;
      }
    }

    console.log(`[RegistrationScheduler] 🔄 Executing daily cycle reset for "${reg.displayName}" (${reg.registrationId}) [archiving cycle: ${cycleDateToArchive}]...`);

    // Capture old cycle metadata and active entries before rolling over the registration document
    const oldCycleId = reg.currentCycleId || `${registrationId}:${cycleDateToArchive}`;
    const oldStartedAt = reg.currentCycleStartedAt || null;
    const activeEntries = await getConfigurableEntriesForRegistration(registrationId, oldCycleId);

    // Determine next cycle and status
    let nextCycleDate = cycleEval.activeCycleDate || cycleEval.cycleDate;
    if (force && nextCycleDate === cycleDateToArchive) {
      const { getNextCycleDateString } = await import('./configurableTournamentData.js');
      nextCycleDate = getNextCycleDateString(timezone, now);
    }

    reg.lastResetAt = now;
    reg.lastResetCycleDate = force ? cycleDateToArchive : (cycleEval.endedCycleDate || cycleDateToArchive);
    reg.currentCycleDate = nextCycleDate;
    reg.currentCycleId = `${registrationId}:${nextCycleDate}`;
    reg.status = cycleEval.isOpen ? 'OPEN' : cycleEval.status;
    reg.beforeStart = cycleEval.beforeStart || false;
    reg.currentCycleStartedAt = cycleEval.isOpen ? now : null;
    // Clear manual override when scheduled reset rolls over to next cycle
    reg.manualOverride = null;
    reg.manualOverrideCycleDate = null;
    reg.manualOverrideAt = null;
    reg._scheduleBaseNow = now;

    // =========================================================================
    // CRITICAL STEP FIRST: Save cleared cycle & new status in MongoDB and edit
    // the registration message right away so status updates within 1 second.
    // =========================================================================
    const savedReg = await saveConfigurableRegistration(reg);
    if (client) {
      await updateRegistrationMessage(client, registrationId, {
        registration: savedReg,
        filledCount: 0,
      }).catch(() => {});
    }

    // =========================================================================
    // SLOWER WORK AFTER: Archive entries, clear IDP permissions, refresh slot
    // chart and dashboards, and re-arm the next due timer.
    // =========================================================================
    await archiveActiveRegistrationCycle(registrationId, {
      cycleDate: cycleDateToArchive,
      cycleId: oldCycleId,
      startedAt: oldStartedAt,
      entries: activeEntries,
      reason: 'SCHEDULED_DAILY_RESET',
    });

    await syncRegistrationSlotStates(registrationId, savedReg.currentCycleId, savedReg).catch(() => {});

    if (client) {
      await syncRegistrationSlotList(registrationId, savedReg.currentCycleId, client).catch(() => {});

      if (savedReg.idpChannelId) {
        try {
          const guild = await client.guilds.fetch(savedReg.guildId).catch(() => null);
          const idpChannel = guild ? await guild.channels.fetch(savedReg.idpChannelId).catch(() => null) : null;
          if (idpChannel && typeof idpChannel.permissionOverwrites?.delete === 'function') {
            for (const entry of activeEntries) {
              if (entry.leaderDiscordId) {
                await idpChannel.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
              }
            }
          }
        } catch (err) {
          console.warn(`[RegistrationScheduler] ⚠️ Error resetting IDP overwrites:`, err.message);
        }
      }

      if (savedReg.tournamentId) {
        await refreshDashboard(client, savedReg.tournamentId).catch(() => {});
      }
      await updateManageDashboardMessage(client, registrationId).catch(() => {});
    }

    await armRegistrationTimer(client, savedReg, now).catch(() => {});

    console.log(`[RegistrationScheduler] ✅ Reset completed for "${savedReg.displayName}". Status: ${savedReg.status}, Next Cycle: ${nextCycleDate}.`);
    return true;
  } finally {
    await releaseLock(lockKey);
  }
}

/**
 * Evaluates and executes any due start/reset transition for a single registration.
 * Performs the critical step (saving new status in MongoDB + editing registration message) first,
 * followed by slower work (channel overwrites, slot chart, dashboards).
 *
 * @param {import('discord.js').Client} client
 * @param {object|string} regOrId
 * @param {Date} [customNow]
 * @returns {Promise<boolean>}
 */
export async function executeExactDueTransition(client, regOrId, customNow = null) {
  const reg = typeof regOrId === 'string'
    ? await getConfigurableRegistration(regOrId)
    : regOrId;
  if (!reg || reg.status === 'DELETED' || reg.isDeleted) return false;

  const now = customNow instanceof Date ? customNow : new Date();
  let stateChanged = false;
  let filledCountForMessage = null;
  const timezone = reg.timezone || 'Asia/Kolkata';

  // A. Recurring Daily Schedule Evaluation
  if (reg.dailyStartTime && reg.dailyResetTime) {
    const cycleEval = evaluateDailyCycleStatus(reg.dailyStartTime, reg.dailyResetTime, timezone, now);

    // 1. Check if Reset is due
    const resetDue = Boolean(
      cycleEval.endedCycleDate &&
      reg.lastResetCycleDate !== cycleEval.endedCycleDate &&
      (!reg.currentCycleDate || reg.currentCycleDate <= cycleEval.endedCycleDate)
    );

    if (resetDue) {
      return await executeDailyCycleReset(client, reg.registrationId, false, now);
    }

    // Align lastResetCycleDate if already in active cycle
    if (
      cycleEval.endedCycleDate &&
      reg.currentCycleDate &&
      reg.currentCycleDate > cycleEval.endedCycleDate &&
      reg.lastResetCycleDate !== cycleEval.endedCycleDate
    ) {
      reg.lastResetCycleDate = cycleEval.endedCycleDate;
      reg._scheduleBaseNow = now;
      await saveConfigurableRegistration(reg);
    }

    // 2. Check if Daily Start is due (transition CLOSED / NOT OPENED YET / UPCOMING -> OPEN when in active window)
    if (cycleEval.isOpen && (reg.status === 'CLOSED' || reg.status === 'NOT OPENED YET' || reg.status === 'UPCOMING')) {
      const activeCycle = cycleEval.activeCycleDate || cycleEval.cycleDate;
      if (reg.manualOverride === 'CLOSED' && reg.manualOverrideCycleDate === activeCycle) {
        // Respect manual close action
      } else {
        const entries = await getConfigurableEntriesForRegistration(reg.registrationId, reg.currentCycleId);
        const reservedCount = getLockedSlotNumbers(reg, reg.totalSlots).length;
        const maxAvailable = reg.totalSlots - reservedCount;

        if (entries.length < maxAvailable) {
          reg.status = 'OPEN';
          reg.beforeStart = false;
          if (reg.currentCycleDate !== activeCycle || !reg.currentCycleId) {
            reg.currentCycleDate = activeCycle;
            reg.currentCycleId = `${reg.registrationId}:${activeCycle}`;
          }
          if (!reg.currentCycleStartedAt) reg.currentCycleStartedAt = now;
          filledCountForMessage = entries.length;
          stateChanged = true;
          console.log(`[RegistrationScheduler] 🟢 Daily cycle opened for "${reg.displayName}" (${reg.registrationId}).`);
        }
      }
    } else if (!cycleEval.isOpen && cycleEval.cycleEnded && reg.status === 'OPEN' && reg.manualOverride !== 'OPEN') {
      reg.status = 'CLOSED';
      reg.beforeStart = false;
      stateChanged = true;
    }
  }

  // B. Fallback Legacy One-Time Start/End Check (if configured)
  if (reg.status === 'UPCOMING' && reg.startsAt) {
    const startTime = new Date(reg.startsAt);
    if (startTime <= now) {
      reg.status = 'OPEN';
      stateChanged = true;
      console.log(`[RegistrationScheduler] 🟢 Registration "${reg.displayName}" transitioned to OPEN.`);
    }
  }

  if (reg.status === 'OPEN' && reg.endsAt) {
    const endTime = new Date(reg.endsAt);
    if (endTime <= now) {
      reg.status = 'CLOSED';
      stateChanged = true;
      console.log(`[RegistrationScheduler] 🔴 Registration "${reg.displayName}" transitioned to CLOSED.`);
    }
  }

  if (stateChanged) {
    reg._scheduleBaseNow = now;
    // =========================================================================
    // CRITICAL STEP FIRST: Save new status in MongoDB and edit registration
    // message immediately so users see OPEN / CLOSED at the exact second.
    // =========================================================================
    const savedReg = await saveConfigurableRegistration(reg);
    if (client) {
      await updateRegistrationMessage(client, savedReg.registrationId, {
        registration: savedReg,
        ...(typeof filledCountForMessage === 'number' ? { filledCount: filledCountForMessage } : {}),
      }).catch(() => {});
    }

    // =========================================================================
    // SLOWER WORK AFTER: Channel overwrites, slot chart, and dashboards.
    // =========================================================================
    if (client) {
      try {
        const regChan = savedReg.registrationChannelId
          ? await client.channels.fetch(savedReg.registrationChannelId).catch(() => null)
          : null;
        if (regChan && regChan.guild) {
          if (savedReg.status === 'OPEN') {
            await regChan.permissionOverwrites.edit(regChan.guild.roles.everyone.id, {
              ViewChannel: true,
              ReadMessageHistory: true,
              SendMessages: true,
            }).catch(() => {});
          } else if (savedReg.status === 'CLOSED') {
            await regChan.permissionOverwrites.edit(regChan.guild.roles.everyone.id, {
              SendMessages: false,
            }).catch(() => {});
          }
        }
      } catch {}

      await updateSlotChartMessage(client, savedReg.registrationId).catch(() => {});
      await updateManageDashboardMessage(client, savedReg.registrationId).catch(() => {});
      await refreshDashboard(client, savedReg.tournamentId).catch(() => {});
    }
  }

  await armRegistrationTimer(client, reg, now).catch(() => {});
  return stateChanged;
}

/**
 * Checks active registrations against current time, transitions status if needed,
 * and ensures exact timers are armed.
 * @param {import('discord.js').Client} client
 * @param {Date} [customNow]
 */
export async function checkRegistrationLifecycles(client, customNow = null) {
  try {
    const allRegs = await getAllActiveConfigurableRegistrations();
    const now = customNow instanceof Date ? customNow : new Date();

    for (const reg of allRegs) {
      await executeExactDueTransition(client, reg, now);
    }
  } catch (err) {
    console.error('[RegistrationScheduler] ❌ Error in lifecycle check:', err.message);
  }
}

/**
 * Reconciles tournaments on bot restart.
 * Restores dashboard messages, registration messages, slot charts, catches up missed resets,
 * and re-arms exact timers from MongoDB.
 * @param {import('discord.js').Client} client
 */
export async function reconcileConfigurableTournaments(client) {
  console.log('[ConfigurableTournament] 🔄 Reconciling configurable tournaments, daily cycles and permissions...');
  if (client) {
    activeSchedulerClient = client;
  }
  try {
    // 0. Clean up stale or orphaned registrations/entries on startup
    await cleanUpStaleConfigurableRegistrationsAndEntries(client);

    const tournaments = await getAllConfigurableTournaments();

    // Catch up any lifecycle transitions/resets that occurred while bot was offline & arm timers
    await checkRegistrationLifecycles(client);

    for (const tour of tournaments) {
      // 0b. Enforce tournament category channel order (SETUP -> INFO -> UPDATES -> VERIFY -> ALL REGS -> ALL IDPS)
      await reorderTournamentCategoryChannels(client, tour).catch(() => {});

      // 1. Refresh dashboard in setup channel
      await refreshDashboard(client, tour.tournamentId).catch(() => {});

      // 2. Refresh enrollment message in verify channel
      if (tour.standardChannels?.verifyChannelId) {
        await sendOrUpdateEnrollmentMessage(client, tour).catch(() => {});
      }

      // 3. Reconcile registration instances, timers, and IDP permissions
      const registrations = await getConfigurableRegistrationsForTournament(tour.tournamentId);
      for (const reg of registrations) {
        await syncRegistrationSlotStates(reg.registrationId, reg.currentCycleId, reg).catch(() => {});
        await armRegistrationTimer(client, reg).catch(() => {});
        await updateRegistrationMessage(client, reg.registrationId).catch(() => {});
        await reconcileRegistrationScheduleMessage(client, reg).catch(() => {});
        await updateSlotChartMessage(client, reg.registrationId).catch(() => {});

        // Reconcile IDP channel permission overwrites for leaders
        if (reg.idpChannelId && client) {
          try {
            const guild = await client.guilds.fetch(reg.guildId).catch(() => null);
            const idpChannel = guild ? await guild.channels.fetch(reg.idpChannelId).catch(() => null) : null;
            if (idpChannel) {
              if (typeof idpChannel.permissionOverwrites?.edit === 'function' && guild.roles?.everyone?.id) {
                await idpChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
                  ViewChannel: false,
                  CreatePublicThreads: false,
                  CreatePrivateThreads: false,
                  SendMessagesInThreads: false,
                  ManageThreads: false,
                  ManageChannels: false,
                  ManageRoles: false,
                }).catch(() => {});
              }
              const entries = await getConfigurableEntriesForRegistration(reg.registrationId);
              const activeLeaderIds = new Set(entries.map((e) => e.leaderDiscordId).filter(Boolean));
              for (const entry of entries) {
                if (entry.leaderDiscordId) {
                  await idpChannel.permissionOverwrites
                    .edit(entry.leaderDiscordId, {
                      ViewChannel: true,
                      ReadMessageHistory: true,
                      SendMessages: true,
                      CreatePublicThreads: false,
                      CreatePrivateThreads: false,
                      SendMessagesInThreads: false,
                      ManageThreads: false,
                      ManageChannels: false,
                      ManageRoles: false,
                    })
                    .catch(() => {});
                }
              }

              if (Array.isArray(reg.pendingIdpRevocations) && reg.pendingIdpRevocations.length > 0 && typeof idpChannel.permissionOverwrites?.delete === 'function') {
                const stillPending = [];
                for (const revokedLeaderId of reg.pendingIdpRevocations) {
                  if (activeLeaderIds.has(revokedLeaderId)) continue;
                  try {
                    await idpChannel.permissionOverwrites.delete(revokedLeaderId);
                  } catch {
                    stillPending.push(revokedLeaderId);
                  }
                }
                reg.pendingIdpRevocations = stillPending;
                await saveConfigurableRegistration(reg).catch(() => {});
              }
            }
          } catch (err) {
            console.warn(`[ConfigurableTournament] ⚠️ IDP permission reconciliation warning:`, err.message);
          }
        }
      }
    }
    console.log(`[ConfigurableTournament] ✅ Reconciled ${tournaments.length} tournament(s) successfully.`);
  } catch (err) {
    console.error('[ConfigurableTournament] ❌ Error during restart reconciliation:', err);
  }
}

/**
 * Starts the registration scheduler:
 * - Immediately reconciles due transitions and arms exact due-time timers for all active registrations.
 * - Runs a lightweight safety check every 5 seconds only to catch missed jobs.
 * @param {import('discord.js').Client} client
 */
export function startRegistrationScheduler(client) {
  activeSchedulerClient = client;
  if (schedulerInterval) return;

  checkRegistrationLifecycles(client).catch(() => {});
  schedulerInterval = setInterval(() => {
    checkRegistrationLifecycles(client).catch(() => {});
  }, SAFETY_CHECK_INTERVAL_MS);
  if (typeof schedulerInterval?.unref === 'function') {
    schedulerInterval.unref();
  }
}

/**
 * Stops the registration scheduler and clears all armed timers.
 */
export function stopRegistrationScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  clearAllRegistrationTimers();
}

