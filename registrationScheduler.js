import {
  getAllActiveConfigurableRegistrations,
  getAllConfigurableTournaments,
  getConfigurableRegistrationsForTournament,
  getConfigurableEntriesForRegistration,
  saveConfigurableRegistration,
} from './configurableTournamentData.js';
import { updateRegistrationMessage } from './configurableRegistrationService.js';
import { updateSlotChartMessage } from './slotChartService.js';
import { refreshDashboard } from './configurableTournamentService.js';
import { sendOrUpdateEnrollmentMessage } from './teamEnrollmentService.js';

let schedulerInterval = null;

/**
 * Checks active registrations against current time and transitions status if needed.
 * @param {import('discord.js').Client} client
 */
export async function checkRegistrationLifecycles(client) {
  try {
    const activeRegs = await getAllActiveConfigurableRegistrations();
    const now = new Date();

    for (const reg of activeRegs) {
      let stateChanged = false;

      // Check UPCOMING -> OPEN
      if (reg.status === 'UPCOMING' && reg.startsAt) {
        const startTime = new Date(reg.startsAt);
        if (startTime <= now) {
          reg.status = 'OPEN';
          stateChanged = true;
          console.log(`[RegistrationScheduler] 🟢 Registration "${reg.displayName}" (${reg.registrationId}) transitioned to OPEN.`);
        }
      }

      // Check OPEN -> CLOSED
      if (reg.status === 'OPEN' && reg.endsAt) {
        const endTime = new Date(reg.endsAt);
        if (endTime <= now) {
          reg.status = 'CLOSED';
          stateChanged = true;
          console.log(`[RegistrationScheduler] 🔴 Registration "${reg.displayName}" (${reg.registrationId}) transitioned to CLOSED.`);
        }
      }

      if (stateChanged) {
        await saveConfigurableRegistration(reg);
        await updateRegistrationMessage(client, reg.registrationId);
        await updateSlotChartMessage(client, reg.registrationId);
        await refreshDashboard(client, reg.tournamentId);
      }
    }
  } catch (err) {
    console.error('[RegistrationScheduler] ❌ Error in lifecycle check:', err.message);
  }
}

/**
 * Reconciles tournaments on bot restart.
 * Restores dashboard messages, registration messages, slot charts, and IDP leader permissions.
 * @param {import('discord.js').Client} client
 */
export async function reconcileConfigurableTournaments(client) {
  console.log('[ConfigurableTournament] 🔄 Reconciling configurable tournaments and permissions...');
  try {
    const tournaments = await getAllConfigurableTournaments();

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
        if (reg.idpChannelId) {
          try {
            const guild = await client.guilds.fetch(reg.guildId).catch(() => null);
            const idpChannel = guild ? await guild.channels.fetch(reg.idpChannelId).catch(() => null) : null;
            if (idpChannel) {
              const entries = await getConfigurableEntriesForRegistration(reg.registrationId);
              for (const entry of entries) {
                if (entry.leaderDiscordId) {
                  await idpChannel.permissionOverwrites
                    .edit(entry.leaderDiscordId, {
                      ViewChannel: true,
                      ReadMessageHistory: true,
                      SendMessages: true,
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

