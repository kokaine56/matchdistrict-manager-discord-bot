import crypto from 'node:crypto';
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
  parseTimeString,
  parseReservedSlots,
  cleanUpStaleConfigurableRegistrationsAndEntries,
} from './configurableTournamentData.js';
import { updateRegistrationMessage } from './configurableRegistrationService.js';
import { updateSlotChartMessage, syncRegistrationSlotList } from './slotChartService.js';
import { refreshDashboard } from './configurableTournamentService.js';
import { sendOrUpdateEnrollmentMessage } from './teamEnrollmentService.js';
import { updateManageDashboardMessage } from './configurableRegistrationService.js';
import { acquireLock, releaseLock } from './mongoService.js';

let schedulerInterval = null;

/**
 * Executes an automated daily cycle reset for a registration instance.
 * - Safely archives active slot allocations to discord_daily_registration_cycles
 * - Marks active entries as ARCHIVED so teams can re-register in subsequent cycles
 * - Clears leader IDP channel permissions
 * - Resets slot chart to clean state
 * - NEVER deletes team enrollments, player info, or settings
 *
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @param {boolean} [force]
 * @returns {Promise<boolean>}
 */
export async function executeDailyCycleReset(client, registrationId, force = false) {
  const lockKey = `lock:reg_confirm:${registrationId}`;
  await acquireLock(lockKey, 10, 3000);
  try {
    const reg = await getConfigurableRegistration(registrationId);
    if (!reg) return false;

    const timezone = reg.timezone || 'Asia/Kolkata';
    const now = new Date();
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

    // 1. Fetch active entries before archiving
    const activeEntries = await getConfigurableEntriesForRegistration(registrationId);

    // 2. Archive to discord_daily_registration_cycles and mark entries ARCHIVED
    await archiveActiveRegistrationCycle(registrationId, {
      cycleDate: cycleDateToArchive,
      cycleId: reg.currentCycleId || `${registrationId}:${cycleDateToArchive}`,
      reason: 'SCHEDULED_DAILY_RESET',
    });

    // 3. Clear leader IDP permissions for archived entries
    if (reg.idpChannelId && client) {
      try {
        const guild = await client.guilds.fetch(reg.guildId).catch(() => null);
        const idpChannel = guild ? await guild.channels.fetch(reg.idpChannelId).catch(() => null) : null;
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

    // 4. Determine status and next cycle
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

    await saveConfigurableRegistration(reg);

    // 5. Update messages and dashboard
    if (client) {
      await updateRegistrationMessage(client, registrationId).catch(() => {});
      await syncRegistrationSlotList(registrationId, reg.currentCycleId, client).catch(() => {});
      if (reg.tournamentId) {
        await refreshDashboard(client, reg.tournamentId).catch(() => {});
      }
      await updateManageDashboardMessage(client, registrationId).catch(() => {});
    }

    console.log(`[RegistrationScheduler] ✅ Reset completed for "${reg.displayName}". Status: ${reg.status}, Next Cycle: ${nextCycleDate}.`);
    return true;
  } finally {
    await releaseLock(lockKey);
  }
}

/**
 * Checks active registrations against current time and transitions status if needed.
 * @param {import('discord.js').Client} client
 * @param {Date} [customNow]
 */
export async function checkRegistrationLifecycles(client, customNow = null) {
  try {
    const allRegs = await getAllActiveConfigurableRegistrations();
    const now = customNow instanceof Date ? customNow : new Date();

    for (const reg of allRegs) {
      let stateChanged = false;
      const timezone = reg.timezone || 'Asia/Kolkata';

      // A. Recurring Daily Schedule Evaluation
      if (reg.dailyStartTime && reg.dailyResetTime) {
        const cycleEval = evaluateDailyCycleStatus(reg.dailyStartTime, reg.dailyResetTime, timezone, now);

        // 1. Check if Reset is due:
        // Only reset when the registration's currentCycleDate has actually ended (currentCycleDate <= endedCycleDate)
        // and that ended cycle has not yet been reset.
        const resetDue = Boolean(
          cycleEval.endedCycleDate &&
          reg.lastResetCycleDate !== cycleEval.endedCycleDate &&
          (!reg.currentCycleDate || reg.currentCycleDate <= cycleEval.endedCycleDate)
        );

        if (resetDue) {
          await executeDailyCycleReset(client, reg.registrationId);
          continue;
        }

        // If registration is already in the active cycle (> endedCycleDate) and lastResetCycleDate was unset/misaligned, align it
        if (
          cycleEval.endedCycleDate &&
          reg.currentCycleDate &&
          reg.currentCycleDate > cycleEval.endedCycleDate &&
          reg.lastResetCycleDate !== cycleEval.endedCycleDate
        ) {
          reg.lastResetCycleDate = cycleEval.endedCycleDate;
          await saveConfigurableRegistration(reg);
        }

        // 2. Check if Daily Start is due (transition CLOSED / NOT OPENED YET / UPCOMING -> OPEN when in active window)
        if (cycleEval.isOpen && (reg.status === 'CLOSED' || reg.status === 'NOT OPENED YET' || reg.status === 'UPCOMING')) {
          const activeCycle = cycleEval.activeCycleDate || cycleEval.cycleDate;
          // Precedence: If organiser explicitly manually closed for this cycle, do not auto-reopen!
          if (reg.manualOverride === 'CLOSED' && reg.manualOverrideCycleDate === activeCycle) {
            // Respect manual close action
          } else {
            // Check if not full
            const entries = await getConfigurableEntriesForRegistration(reg.registrationId, reg.currentCycleId);
            const reservedCount = parseReservedSlots(reg.reservedSlots, reg.totalSlots);
            const maxAvailable = reg.totalSlots - reservedCount;

            if (entries.length < maxAvailable) {
              reg.status = 'OPEN';
              reg.beforeStart = false;
              if (reg.currentCycleDate !== activeCycle || !reg.currentCycleId) {
                reg.currentCycleDate = activeCycle;
                reg.currentCycleId = `${reg.registrationId}:${activeCycle}`;
              }
              if (!reg.currentCycleStartedAt) reg.currentCycleStartedAt = now;
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
        await saveConfigurableRegistration(reg);
        if (client) {
          // Sync channel permissions and closing message
          try {
            const regChan = reg.registrationChannelId ? await client.channels.fetch(reg.registrationChannelId).catch(() => null) : null;
            if (regChan && regChan.guild) {
              if (reg.status === 'OPEN') {
                await regChan.permissionOverwrites.edit(regChan.guild.roles.everyone.id, {
                  ViewChannel: true,
                  ReadMessageHistory: true,
                  SendMessages: true,
                }).catch(() => {});
              } else if (reg.status === 'CLOSED') {
                await regChan.permissionOverwrites.edit(regChan.guild.roles.everyone.id, {
                  SendMessages: false,
                }).catch(() => {});
              }
            }
          } catch {}

          await updateRegistrationMessage(client, reg.registrationId).catch(() => {});
          await updateSlotChartMessage(client, reg.registrationId).catch(() => {});
          await updateManageDashboardMessage(client, reg.registrationId).catch(() => {});
          await refreshDashboard(client, reg.tournamentId).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[RegistrationScheduler] ❌ Error in lifecycle check:', err.message);
  }
}

/**
 * Reconciles tournaments on bot restart.
 * Restores dashboard messages, registration messages, slot charts, and catches up missed resets.
 * @param {import('discord.js').Client} client
 */
export async function reconcileConfigurableTournaments(client) {
  console.log('[ConfigurableTournament] 🔄 Reconciling configurable tournaments, daily cycles and permissions...');
  try {
    // 0. Clean up stale or orphaned registrations/entries on startup
    await cleanUpStaleConfigurableRegistrationsAndEntries(client);

    const tournaments = await getAllConfigurableTournaments();

    // Catch up any lifecycle transitions/resets that occurred while bot was offline
    await checkRegistrationLifecycles(client);

    for (const tour of tournaments) {
      // 1. Refresh dashboard in setup channel
      await refreshDashboard(client, tour.tournamentId).catch(() => {});

      // 2. Refresh enrollment message in verify channel
      if (tour.standardChannels?.verifyChannelId) {
        await sendOrUpdateEnrollmentMessage(client, tour).catch(() => {});
      }

      // 3. Reconcile registration instances and IDP permissions
      const registrations = await getConfigurableRegistrationsForTournament(tour.tournamentId);
      for (const reg of registrations) {
        await updateRegistrationMessage(client, reg.registrationId).catch(() => {});
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
 * Starts the periodic registration scheduler (runs every 30 seconds).
 * @param {import('discord.js').Client} client
 */
export function startRegistrationScheduler(client) {
  if (schedulerInterval) return;
  // Run once immediately, then every 30 seconds
  checkRegistrationLifecycles(client).catch(() => {});
  schedulerInterval = setInterval(() => {
    checkRegistrationLifecycles(client).catch(() => {});
  }, 30 * 1000);
}

/**
 * Stops the registration scheduler.
 */
export function stopRegistrationScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

