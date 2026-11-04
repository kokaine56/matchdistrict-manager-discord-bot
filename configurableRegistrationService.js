import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js';
import crypto from 'node:crypto';
import {
  getConfigurableTournament,
  getConfigurableRegistration,
  getConfigurableRegistrationsForTournament,
  findConfigurableRegistrationByChannelId,
  findConfigurableRegistrationByMessageId,
  saveConfigurableRegistration,
  deleteConfigurableRegistration,
  getConfigurableTeamsForUser,
  getConfigurableTeam,
  getConfigurableEntry,
  getConfigurableEntriesForRegistration,
  getRegistrationEntriesCount,
  getNextAvailableSlot,
  saveConfigurableEntry,
  deleteConfigurableEntry,
  parseReservedSlots,
  parseTimeString,
  getCurrentTimeInTimezone,
  evaluateDailyCycleStatus,
  getDailyCyclesForRegistration,
} from './configurableTournamentData.js';
import { acquireLock, releaseLock } from './mongoService.js';
import {
  updateSlotChartMessage,
  updateRegistrationSlotList,
  buildSlotChartEmbed,
  buildSlotListText,
} from './slotChartService.js';
import {
  TOURNAMENT_DENIED_PERMISSIONS,
  refreshDashboard,
  buildTournamentPrefix,
  toMathematicalBold,
  createTournamentChannel,
} from './configurableTournamentService.js';

/**
 * Builds the Embed for a public Registration Channel.
 * @param {object} registration
 * @param {number} filledCount
 * @returns {EmbedBuilder}
 */
export function buildRegistrationEmbed(registration, filledCount = 0) {
  const totalSlots = registration.totalSlots || 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);
  const availableSlots = Math.max(0, maxAvailable - filledCount);
  const isOpen = registration.status === 'OPEN';

  const reservedSummary = reservedCount > 0
    ? `${reservedCount} (01-${String(reservedCount).padStart(2, '0')})`
    : 'None';
  const scheduleLine = (registration.dailyStartTime || registration.dailyResetTime)
    ? `\n**Daily Schedule:** Opens at \`${registration.dailyStartTime || 'N/A'}\` | Resets at \`${registration.dailyResetTime || 'N/A'}\``
    : '';

  return new EmbedBuilder()
    .setColor(isOpen ? 0x22c55e : registration.status === 'CLOSED' ? 0xef4444 : 0x3b82f6)
    .setTitle(`🎟️ Registration — ${registration.displayName}`)
    .setDescription(
      `**Status:** \`${registration.status || 'OPEN'}\`\n` +
      `**Total Capacity:** \`${totalSlots}\` slots\n` +
      `**Reserved / Locked:** \`${reservedSummary}\`\n` +
      `**Slots Filled:** \`${filledCount}/${maxAvailable}\`\n` +
      `**Remaining Slots:** \`${availableSlots}\`${scheduleLine}\n\n` +
      `📌 *Only verified **Team Leaders** can register their squad.*\n` +
      `📌 *Upon successful registration, the Team Leader will automatically receive access to the private IDP channel!*`
    )
    .setFooter({ text: 'Match District Tournament System' })
    .setTimestamp();
}

/**
 * Builds the register button component row.
 * @param {object} registration
 * @returns {ActionRowBuilder}
 */
export function buildRegistrationComponents(registration) {
  const isOpen = registration.status === 'OPEN';
  const button = new ButtonBuilder()
    .setCustomId(`md_cfg_reg_btn_${registration.registrationId}`)
    .setLabel(isOpen ? 'Register Squad' : `Registration ${registration.status || 'Closed'}`)
    .setEmoji(isOpen ? '⚡' : '🔒')
    .setStyle(isOpen ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!isOpen);

  return new ActionRowBuilder().addComponents(button);
}

/**
 * Updates or posts the persistent registration message in the registration channel.
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @returns {Promise<boolean>}
 */
export async function updateRegistrationMessage(client, registrationId) {
  try {
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.registrationChannelId) return false;

    const channel = await client.channels.fetch(registration.registrationChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const currentCycleId = registration.currentCycleId || null;
    const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
    const embed = buildRegistrationEmbed(registration, filledCount);
    const row = buildRegistrationComponents(registration);

    if (registration.registrationMessageId) {
      try {
        const existing = await channel.messages.fetch(registration.registrationMessageId).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed], components: [row] });
          return true;
        }
      } catch {
        // Fall through to send new
      }
    }

    const msg = await channel.send({ embeds: [embed], components: [row] });
    registration.registrationMessageId = msg.id;
    await saveConfigurableRegistration(registration);
    return true;
  } catch (err) {
    console.error(`[ConfigurableRegistration] ❌ Error updating registration message ${registrationId}:`, err);
    return false;
  }
}

/**
 * Displays the modal for adding a new registration instance asking for ONLY the 4 settings (5 inputs):
 * 1. Registration Name
 * 2. Slots (positive integer capacity)
 * 3. Reserved Slots (specific slot numbers locked)
 * 4. Daily Start Time (clock time in timezone)
 * 5. Daily Data Clear / Reset Time (clock time in timezone)
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleAddRegistrationButton(interaction, tournamentId) {
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_add_reg_modal_${tournamentId}`)
    .setTitle('Create Registration');

  const nameInput = new TextInputBuilder()
    .setCustomId('registration_name')
    .setLabel('Registration Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. T3 Registration 1, BGIS Qualifier A')
    .setMinLength(2)
    .setMaxLength(50)
    .setRequired(true);

  const capacityInput = new TextInputBuilder()
    .setCustomId('total_slots')
    .setLabel('Total Slots')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 16, 25, 32, 64, 100')
    .setRequired(true);

  const reservedInput = new TextInputBuilder()
    .setCustomId('reserved_slots')
    .setLabel('Reserved Slots (Count from Slot 01)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 2 (locks Slot 01 and Slot 02, or 0 for none)')
    .setRequired(false);

  const startInput = new TextInputBuilder()
    .setCustomId('daily_start_time')
    .setLabel('Daily Start Time (Timezone: IST)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 10:00 AM or 18:00')
    .setRequired(true);

  const resetInput = new TextInputBuilder()
    .setCustomId('daily_reset_time')
    .setLabel('Daily Reset Time (Timezone: IST)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 02:00 AM or 04:00')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(capacityInput),
    new ActionRowBuilder().addComponents(reservedInput),
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(resetInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handles submission of the Add Registration modal.
 * Validates inputs, creates registration & IDP channels, sets up daily schedule, and saves data.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleAddRegistrationModalSubmit(interaction, tournamentId) {
  await interaction.deferReply({ ephemeral: true });

  const tournament = await getConfigurableTournament(tournamentId);
  if (!tournament) {
    return interaction.editReply({ content: '❌ Tournament configuration not found.' });
  }

  // Support both new 'registration_name' and fallback 'display_name'
  const displayName = (
    interaction.fields.getTextInputValue('registration_name') ||
    interaction.fields.getTextInputValue('display_name') ||
    ''
  ).trim();

  if (!displayName || displayName.length < 2) {
    return interaction.editReply({ content: '❌ Registration Name must be at least 2 characters long.' });
  }

  const rawTotal = parseInt(interaction.fields.getTextInputValue('total_slots')?.trim(), 10);
  if (isNaN(rawTotal) || rawTotal <= 0) {
    return interaction.editReply({ content: '❌ Total Slots must be a positive integer (e.g. 16, 25, 32, 64).' });
  }
  const totalSlots = rawTotal;

  const rawReserved = interaction.fields.getTextInputValue('reserved_slots')?.trim() || '';
  const reservedSlots = parseReservedSlots(rawReserved, totalSlots);

  if (reservedSlots >= totalSlots) {
    return interaction.editReply({ content: '❌ Reserved slots count cannot equal or exceed total capacity.' });
  }

  // Daily Start Time (or fallback starts_at)
  const rawStart = (
    interaction.fields.getTextInputValue('daily_start_time') ||
    interaction.fields.getTextInputValue('starts_at') ||
    '10:00 AM'
  ).trim();
  const parsedStart = parseTimeString(rawStart);
  if (!parsedStart) {
    return interaction.editReply({
      content: `❌ Invalid Daily Start Time "${rawStart}". Please use a valid clock time such as "10:00 AM" or "18:00".`,
    });
  }

  // Daily Reset Time (or fallback ends_at)
  const rawReset = (
    interaction.fields.getTextInputValue('daily_reset_time') ||
    interaction.fields.getTextInputValue('ends_at') ||
    '02:00 AM'
  ).trim();
  const parsedReset = parseTimeString(rawReset);
  if (!parsedReset) {
    return interaction.editReply({
      content: `❌ Invalid Daily Reset Time "${rawReset}". Please use a valid clock time such as "02:00 AM" or "04:00".`,
    });
  }

  const timezone = tournament.timezone || 'Asia/Kolkata';
  const now = new Date();
  const cycleEval = evaluateDailyCycleStatus(parsedStart.formatted, parsedReset.formatted, timezone, now);
  const status = cycleEval.status;
  const currentCycleDate = cycleEval.cycleDate;

  // Monotonically increment registration number across all registrations (including deleted)
  // Never reuse the registration number of a deleted registration
  const allRegs = await getConfigurableRegistrationsForTournament(tournamentId, true);
  const highestRegNumber = allRegs.reduce((max, r) => Math.max(max, r.registrationNumber || 0), 0);
  const regNumber = highestRegNumber + 1;

  // Generate channel slugs
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || `group-${regNumber}`;

  const rawPrefix = tournament.prefix || (tournament.name ? buildTournamentPrefix(tournament.name) : 'md');
  const boldPrefix = tournament.boldPrefix || toMathematicalBold(rawPrefix);

  const guild = interaction.guild;
  const categoryId = tournament.categoryId;

  try {
    // 1. Create Public Registration Channel (Viewable by everyone, SendMessages disabled)
    const regChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: `${slug}-reg`,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages, ...TOURNAMENT_DENIED_PERMISSIONS],
        },
      ],
    });

    // 2. Create Private IDP Channel (Hidden from everyone by default)
    const idpChannel = await createTournamentChannel(guild, {
      boldPrefix,
      rawPrefix,
      fallbackSuffix: `${slug}-idp`,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel, ...TOURNAMENT_DENIED_PERMISSIONS],
        },
      ],
    });

    const registrationId = crypto.randomUUID();
    const currentCycleId = `${registrationId}:cycle-${crypto.randomUUID()}`;
    const registrationDoc = {
      registrationId,
      tournamentId,
      guildId: guild.id,
      registrationNumber: regNumber,
      displayName,
      registrationChannelId: regChannel.id,
      registrationMessageId: null,
      idpChannelId: idpChannel.id,
      slotChartMessageId: null,
      totalSlots,
      reservedSlots, // integer count (e.g. 2)
      dailyStartTime: parsedStart.formatted,
      rawDailyStartTime: rawStart,
      dailyResetTime: parsedReset.formatted,
      rawDailyResetTime: rawReset,
      timezone,
      currentCycleId,
      currentCycleDate,
      currentCycleStartedAt: cycleEval.isOpen ? now : null,
      lastResetAt: null,
      lastResetCycleDate: null,
      status,
      createdAt: now,
    };

    await saveConfigurableRegistration(registrationDoc);

    // 3. Post Persistent Registration Message
    await updateRegistrationMessage(interaction.client, registrationId);

    // 4. Post Persistent Slot Chart Message in IDP channel
    await updateSlotChartMessage(interaction.client, registrationId);

    // 5. Refresh Setup Dashboard
    if (interaction.client) {
      await refreshDashboard(interaction.client, tournamentId).catch(() => {});
    }

    const reservedDisplay = reservedSlots > 0 ? `${reservedSlots} (01-${String(reservedSlots).padStart(2, '0')})` : 'None';

    await interaction.editReply({
      content:
        `✅ **Registration Instance Created!**\n\n` +
        `**Name:** ${displayName}\n` +
        `**Status:** \`${status}\` (Cycle: \`${currentCycleDate}\`)\n` +
        `**Total Slots:** ${totalSlots} (Reserved: ${reservedDisplay})\n` +
        `**Daily Schedule:** Opens at \`${parsedStart.formatted}\` | Resets at \`${parsedReset.formatted}\` (${timezone})\n` +
        `**Registration Channel:** <#${regChannel.id}>\n` +
        `**Private IDP Channel:** <#${idpChannel.id}>`,
    });
  } catch (err) {
    console.error('[ConfigurableRegistration] ❌ Failed to create registration channels:', err);
    await interaction.editReply({
      content: `❌ Error creating registration channels: ${err.message}`,
    });
  }
}

/**
 * Helper to reply, edit, or update confirmation interactions uniformly.
 * @param {import('discord.js').Interaction} interaction
 * @param {object} payload
 */
async function respondToConfirmationInteraction(interaction, payload) {
  try {
    if (interaction.deferred) {
      if (typeof interaction.editReply === 'function') {
        return await interaction.editReply(payload);
      }
      if (typeof interaction.update === 'function') {
        return await interaction.update(payload);
      }
      if (typeof interaction.reply === 'function') {
        return await interaction.reply(payload);
      }
    }
    if (typeof interaction.update === 'function' && interaction.isButton?.()) {
      return await interaction.update(payload);
    }
    if (!interaction.replied && typeof interaction.reply === 'function') {
      return await interaction.reply({ ...payload, ephemeral: true });
    }
    if (typeof interaction.editReply === 'function') {
      return await interaction.editReply(payload);
    }
    if (typeof interaction.followUp === 'function') {
      return await interaction.followUp({ ...payload, ephemeral: true });
    }
  } catch (err) {
    if (err?.code === 40060) return null;
    console.error(`[ConfigurableRegistration] ❌ Error in respondToConfirmationInteraction:`, err.message);
  }
}

const inFlightConfirmations = new Set();

/**
 * Handles the "Register Squad" button click in a registration channel.
 * Opens an ephemeral confirmation message with squad details, available slots,
 * and Confirm / Cancel buttons. Does NOT immediately register the team.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleRegisterSquadButtonClick(interaction, registrationId) {
  // Resolve the registration from the channel ID or message ID where the button was clicked
  let registration = null;
  if (interaction?.channelId) {
    registration = await findConfigurableRegistrationByChannelId(interaction.channelId);
  }
  if (!registration && interaction?.message?.id) {
    registration = await findConfigurableRegistrationByMessageId(interaction.message.id);
  }
  if (!registration && registrationId) {
    registration = await getConfigurableRegistration(registrationId);
  }

  if (!registration || registration.status === 'DELETED' || registration.isDeleted) {
    return interaction.reply({
      content: '❌ Registration instance not found or has been deleted.',
      ephemeral: true,
    });
  }

  registrationId = registration.registrationId;

  if (registration.status !== 'OPEN') {
    return interaction.reply({
      content:
        `❌ Registration is currently **${registration.status || 'CLOSED'}**.\n` +
        `Daily Schedule: Opens at \`${registration.dailyStartTime || 'N/A'}\` | Resets at \`${registration.dailyResetTime || 'N/A'}\`.`,
      ephemeral: true,
    });
  }

  // 1. Check if user is an enrolled Team Leader for this tournament
  const userTeams = await getConfigurableTeamsForUser(registration.tournamentId, interaction.user.id);
  const leaderTeams = userTeams.filter((t) => t.leaderDiscordId === interaction.user.id);

  if (leaderTeams.length === 0) {
    return interaction.reply({
      content:
        `❌ **Enrollment Required:** You are not a verified Team Leader for this tournament.\n` +
        `Please enroll your squad first in the tournament verification channel.`,
      ephemeral: true,
    });
  }

  const team = leaderTeams[0]; // Leader's enrolled team
  if (!registration.currentCycleId) {
    registration.currentCycleId = `${registrationId}:cycle-${crypto.randomUUID()}`;
    await saveConfigurableRegistration(registration);
  }
  const currentCycleId = registration.currentCycleId;

  // 2. Fetch active entries of THIS registrationId and currentCycleId to check duplicate
  const activeEntries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);
  const existingEntry = activeEntries.find((e) => e.teamId === team.teamId);
  if (existingEntry && existingEntry.registrationId === registrationId) {
    return interaction.reply({
      content:
        `❌ Your team **${team.teamName}** is already registered in this daily cycle!\n` +
        `Assigned to **Slot #${existingEntry.slotNumber}** in <#${registration.idpChannelId}>.`,
      ephemeral: true,
    });
  }

  // 3. Check capacity against non-reserved slots using activeEntries
  const filledCount = activeEntries.length;
  const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const maxAvailable = Math.max(0, registration.totalSlots - reservedCount);

  if (filledCount >= maxAvailable) {
    if (registration.status === 'OPEN') {
      registration.status = 'CLOSED';
      await saveConfigurableRegistration(registration);
      await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
      await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
      if (interaction.client) {
        await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
      }
    }
    return interaction.reply({
      content: '❌ Sorry, all available slots for this registration instance are currently full!',
      ephemeral: true,
    });
  }

  // 4. Retrieve tournament name for confirmation embed
  const tournament = await getConfigurableTournament(registration.tournamentId);

  // 5. Build compact, mobile-friendly Confirmation Message
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Confirm Squad Registration')
    .setDescription(
      `You are about to register your enrolled squad for this registration.\n` +
      `Please confirm that you want to proceed.\n\n` +
      `🏆 **Tournament:** **${tournament?.name || 'Tournament'}**\n` +
      `📝 **Registration:** **${registration.displayName || registration.name}**\n` +
      `🛡️ **Team:** **${team.teamName}**\n` +
      `📊 **Total Available Slots:** **${maxAvailable}**\n` +
      `🟢 **Status:** **${registration.status}**`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`md_cfg_reg_confirm_${registrationId}:${team.teamId}`)
      .setLabel('Confirm Registration')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`md_cfg_reg_cancel_${registrationId}:${team.teamId}`)
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true,
  });
}

/**
 * Handles the "Cancel" button on the registration confirmation message.
 * Immediately acknowledges interaction and terminates pending confirmation.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} [registrationId]
 * @param {string} [teamId]
 */
export async function handleCancelRegistrationButtonClick(interaction, registrationId = null, teamId = null) {
  const interactionId = interaction?.id || 'unknown';
  console.log(`[ConfigurableRegistration] 📥 Cancel button clicked [interactionId: ${interactionId}, regId: ${registrationId || 'N/A'}, teamId: ${teamId || 'N/A'}, user: ${interaction?.user?.id}]`);

  // Immediately acknowledge the interaction
  if (typeof interaction.deferUpdate === 'function' && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
      interaction.deferred = true;
      console.log(`[ConfigurableRegistration] ⏱️ Cancel interaction acknowledged via deferUpdate [interactionId: ${interactionId}]`);
    } catch (err) {
      if (err?.code !== 40060) {
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to deferUpdate cancel [interactionId: ${interactionId}]:`, err.message);
      }
    }
  }

  try {
    // If teamId is supplied, verify only the original user/leader can cancel
    if (teamId && interaction?.user?.id) {
      const team = await getConfigurableTeam(teamId);
      if (team && team.leaderDiscordId && team.leaderDiscordId !== interaction.user.id) {
        console.warn(`[ConfigurableRegistration] ❌ Cancel rejected: non-leader [interactionId: ${interactionId}, user: ${interaction.user.id}, leader: ${team.leaderDiscordId}]`);
        return respondToConfirmationInteraction(interaction, {
          content: '❌ Only the original verified team leader can cancel this registration.',
          embeds: [],
          components: [],
        });
      }
    }

    const payload = {
      content: '❌ Registration cancelled.',
      embeds: [],
      components: [],
    };
    await respondToConfirmationInteraction(interaction, payload);
    console.log(`[ConfigurableRegistration] ⏱️ Cancel interaction completed successfully [interactionId: ${interactionId}]`);
    return true;
  } catch (err) {
    console.error(`[ConfigurableRegistration] ❌ Error in handleCancelRegistrationButtonClick [interactionId: ${interactionId}]:`, err);
    return respondToConfirmationInteraction(interaction, {
      content: '❌ An error occurred while cancelling registration.',
      embeds: [],
      components: [],
    });
  }
}

/**
 * Handles the "Confirm Registration" button click.
 * Sequence:
 * 1. User clicks Confirm Registration.
 * 2. Immediately acknowledge interaction using deferReply (<3s deadline).
 * 3. Disable/mark confirmation buttons as processing.
 * 4. Verify interaction belongs to the correct user.
 * 5. Retrieve team and registration from MongoDB.
 * 6. Verify user is the team leader.
 * 7. Verify team is enrolled.
 * 8. Verify registration is OPEN.
 * 9. Verify current daily cycle.
 * 10. Check duplicate registration.
 * 11. Atomically allocate an available unlocked slot.
 * 12. Create registration entry.
 * 13. Grant leader access to corresponding IDP channel.
 * 14. Update existing slot chart.
 * 15. Update registration message and dashboard.
 * 16. Edit deferred ephemeral reply with result via editReply.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 * @param {string} teamId
 */
export async function handleConfirmRegistrationButtonClick(interaction, registrationId, teamId) {
  const interactionId = interaction?.id || 'unknown';
  console.log(`[ConfigurableRegistration] 📥 Confirmation button clicked [interactionId: ${interactionId}, regId: ${registrationId}, teamId: ${teamId}, user: ${interaction?.user?.id}]`);

  // Step 2: Immediately acknowledge the interaction using deferUpdate (<3s deadline)
  // deferUpdate keeps the interaction tied to the existing ephemeral confirmation message,
  // allowing editReply to update it in-place and remove its buttons.
  if (!interaction.deferred && !interaction.replied) {
    if (typeof interaction.deferUpdate === 'function') {
      try {
        await interaction.deferUpdate();
        interaction.deferred = true;
        console.log(`[ConfigurableRegistration] ⏱️ Interaction acknowledged via deferUpdate [interactionId: ${interactionId}, regId: ${registrationId}]`);
      } catch (err) {
        if (err?.code === 40060) {
          console.warn(`[ConfigurableRegistration] ⚠️ Interaction already acknowledged [interactionId: ${interactionId}]:`, err.message);
          return;
        }
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to deferUpdate [interactionId: ${interactionId}]:`, err.message);
      }
    } else if (typeof interaction.deferReply === 'function') {
      try {
        await interaction.deferReply({ ephemeral: true });
        interaction.deferred = true;
        console.log(`[ConfigurableRegistration] ⏱️ Interaction acknowledged via deferReply [interactionId: ${interactionId}, regId: ${registrationId}]`);
      } catch (err) {
        if (err?.code === 40060) {
          console.warn(`[ConfigurableRegistration] ⚠️ Interaction already acknowledged [interactionId: ${interactionId}]:`, err.message);
          return;
        }
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to deferReply [interactionId: ${interactionId}]:`, err.message);
      }
    }
  }

  // Step 3: Disable or mark the confirmation buttons as processing
  if (interaction?.message && typeof interaction.message.edit === 'function') {
    interaction.message.edit({
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`processing_confirm_${registrationId}`)
            .setLabel('Confirming...')
            .setEmoji('⏳')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`processing_cancel_${registrationId}`)
            .setLabel('Cancel')
            .setEmoji('✖️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        ),
      ],
    }).catch(() => {});
  }

  // Idempotency: Prevent concurrent/repeated button clicks
  const idempotencyKey = `${registrationId}:${teamId}`;
  if (inFlightConfirmations.has(idempotencyKey)) {
    console.warn(`[ConfigurableRegistration] ⚠️ Registration already in flight [interactionId: ${interactionId}, key: ${idempotencyKey}]`);
    return respondToConfirmationInteraction(interaction, {
      content: '⏳ Registration is already being processed. Please wait...',
      embeds: [],
      components: [],
    });
  }

  inFlightConfirmations.add(idempotencyKey);
  const lockKey = `lock:reg_confirm:${registrationId}`;
  await acquireLock(lockKey, 10, 3000);

  try {
    // Step 5 & 7: Retrieve the team from MongoDB & verify enrollment
    const team = await getConfigurableTeam(teamId);
    if (!team) {
      console.warn(`[ConfigurableRegistration] ❌ Team record not found [interactionId: ${interactionId}, teamId: ${teamId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Team record not found. Squad is not enrolled.',
        embeds: [],
        components: [],
      });
    }

    console.log(`[ConfigurableRegistration] 🛡️ Team validation [interactionId: ${interactionId}, teamId: ${teamId}, teamName: ${team.teamName}, leader: ${team.leaderDiscordId}]`);

    // Step 4 & 6: Verify interaction belongs to the correct user (user is the team leader)
    if (interaction?.user?.id && team.leaderDiscordId !== interaction.user.id) {
      console.warn(`[ConfigurableRegistration] ❌ Non-leader confirmation attempt [interactionId: ${interactionId}, user: ${interaction.user.id}, leader: ${team.leaderDiscordId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Only the original verified team leader can confirm registration for this squad.',
        embeds: [],
        components: [],
      });
    }

    // Step 5: Retrieve registration from MongoDB
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || registration.status === 'DELETED' || registration.isDeleted) {
      console.warn(`[ConfigurableRegistration] ❌ Registration not found or deleted [interactionId: ${interactionId}, regId: ${registrationId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Registration instance not found or has been deleted.',
        embeds: [],
        components: [],
      });
    }

    // Verify team belongs to tournament of this registration
    if (team.tournamentId !== registration.tournamentId) {
      console.warn(`[ConfigurableRegistration] ❌ Team tournament mismatch [interactionId: ${interactionId}, teamTour: ${team.tournamentId}, regTour: ${registration.tournamentId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Team is not enrolled in this tournament.',
        embeds: [],
        components: [],
      });
    }

    // Step 8: Verify registration is OPEN
    if (registration.status !== 'OPEN') {
      console.warn(`[ConfigurableRegistration] ❌ Registration closed [interactionId: ${interactionId}, regId: ${registrationId}, status: ${registration.status}]`);
      return respondToConfirmationInteraction(interaction, {
        content: `❌ This registration is currently closed. Registration is no longer open (Current status: **${registration.status || 'CLOSED'}**).`,
        embeds: [],
        components: [],
      });
    }

    // Step 9: Verify the current daily cycle
    if (!registration.currentCycleId) {
      registration.currentCycleId = `${registrationId}:cycle-${crypto.randomUUID()}`;
      await saveConfigurableRegistration(registration);
    }
    const currentCycleId = registration.currentCycleId;

    console.log(`[ConfigurableRegistration] 📋 Registration validation [interactionId: ${interactionId}, regId: ${registrationId}, status: ${registration.status}, cycleId: ${currentCycleId}]`);

    // Step 10: Check duplicate registration (only for this registration instance + currentCycleId + team)
    const activeEntries = await getConfigurableEntriesForRegistration(registrationId, currentCycleId);
    const existingEntry = activeEntries.find((e) => e.teamId === team.teamId);
    if (existingEntry) {
      console.warn(`[ConfigurableRegistration] ❌ Team already registered [interactionId: ${interactionId}, teamId: ${team.teamId}, slot: ${existingEntry.slotNumber}]`);
      return respondToConfirmationInteraction(interaction, {
        content:
          `❌ Your team **${team.teamName}** is already registered in this daily cycle!\n` +
          `Assigned to **Slot #${existingEntry.slotNumber}** in <#${registration.idpChannelId}>.`,
        embeds: [],
        components: [],
      });
    }

    // Verify capacity against non-reserved slots
    const filledCount = activeEntries.length;
    const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
    const maxAvailable = Math.max(0, registration.totalSlots - reservedCount);

    if (filledCount >= maxAvailable) {
      console.warn(`[ConfigurableRegistration] ❌ Capacity reached [interactionId: ${interactionId}, filled: ${filledCount}, max: ${maxAvailable}]`);
      if (registration.status === 'OPEN') {
        registration.status = 'CLOSED';
        await saveConfigurableRegistration(registration);
        if (interaction.client?.channels) {
          await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
          await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
          await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
        }
      }
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Sorry, all available slots have been filled. (all available slots for this registration instance have just been filled!)',
        embeds: [],
        components: [],
      });
    }

    // Step 11: Atomically allocate an available unlocked slot
    const slotNumber = await getNextAvailableSlot(registrationId, registration.totalSlots, reservedCount, currentCycleId);
    if (!slotNumber) {
      console.warn(`[ConfigurableRegistration] ❌ Slot allocation failed: none available [interactionId: ${interactionId}, regId: ${registrationId}]`);
      return respondToConfirmationInteraction(interaction, {
        content: '❌ Sorry, all available slots have been filled. No available slot number could be allocated.',
        embeds: [],
        components: [],
      });
    }

    console.log(`[ConfigurableRegistration] 🎯 Slot allocated [interactionId: ${interactionId}, regId: ${registrationId}, slot: ${slotNumber}]`);

    // Step 12: Create registration entry in MongoDB
    const now = new Date();
    const entryDoc = {
      entryId: crypto.randomUUID(),
      registrationId,
      cycleId: currentCycleId,
      cycleDate: registration.currentCycleDate || getCurrentTimeInTimezone(registration.timezone || 'Asia/Kolkata', now).dateString,
      tournamentId: registration.tournamentId,
      guildId: interaction.guildId || registration.guildId,
      teamId: team.teamId,
      teamName: team.teamName,
      leaderDiscordId: interaction.user.id,
      slotNumber,
      status: 'CONFIRMED',
      registeredAt: now,
    };

    await saveConfigurableEntry(entryDoc);
    console.log(`[ConfigurableRegistration] 💾 Registration entry created [interactionId: ${interactionId}, entryId: ${entryDoc.entryId}, slot: ${slotNumber}]`);

    // Auto-close if this was the last slot
    if (filledCount + 1 >= maxAvailable) {
      registration.status = 'CLOSED';
      await saveConfigurableRegistration(registration);

      try {
        const regChannel = interaction.guild ? await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null) : null;
        if (regChannel) {
          await regChannel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
            SendMessages: false,
          }).catch(() => {});
          await regChannel.send('🔒 **Registration is now closed (All available slots are filled).**').catch(() => {});
        }
      } catch {}

      await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
      if (interaction.client) {
        await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
      }
    }

    // Step 13: Grant leader access to corresponding IDP channel
    let idpPermissionGranted = false;
    if (registration.idpChannelId && interaction.guild) {
      try {
        const idpChannel = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
        if (idpChannel && typeof idpChannel.permissionOverwrites?.edit === 'function') {
          await idpChannel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
            ManageThreads: false,
            ManageChannels: false,
            ManageRoles: false,
          });
          idpPermissionGranted = true;
          console.log(`[ConfigurableRegistration] 🔐 IDP permission update successful [interactionId: ${interactionId}, idpChannelId: ${registration.idpChannelId}, leader: ${interaction.user.id}]`);
        }
      } catch (err) {
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to update IDP overwrite for leader ${interaction.user.id} [interactionId: ${interactionId}]: ${err.message}. Registration preserved; permission queued for reconciliation.`);
      }
    }

    if (!idpPermissionGranted && registration.idpChannelId) {
      entryDoc.permissionPending = true;
      await saveConfigurableEntry(entryDoc).catch(() => {});
    }

    // Step 14 & 15: Update existing slot chart, registration message & dashboard
    try {
      await updateRegistrationSlotList(registrationId, currentCycleId, interaction.client);
      console.log(`[ConfigurableRegistration] 📊 Slot list updated in real-time [interactionId: ${interactionId}, regId: ${registrationId}]`);
    } catch (err) {
      console.warn(`[ConfigurableRegistration] ⚠️ Error updating slot list [interactionId: ${interactionId}]:`, err.message);
    }

    if (interaction.client) {
      await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
      await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
      await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
    }

    // Step 16: Edit deferred ephemeral confirmation message to show Registration Successful with buttons REMOVED
    const tournament = registration.tournamentId
      ? await getConfigurableTournament(registration.tournamentId)
      : null;
    const tournamentName = tournament?.name || 'Tournament';
    const regName = registration.displayName || registration.name;
    const successPayload = {
      content:
        `🎉 **Registration Successful**\n` +
        `Your squad has been successfully registered!\n\n` +
        `🏆 **Tournament:** **${tournamentName}**\n` +
        `📝 **Registration:** **${regName}**\n` +
        `🛡️ **Team:** **${team.teamName}**\n` +
        `🎯 **Allocated Slot Number:** \`#${slotNumber}\`\n` +
        (registration.idpChannelId ? `🔒 **IDP Channel:** <#${registration.idpChannelId}>\n\n*(You have been granted access to the private IDP channel above. Room ID and Password will be posted there!)*` : ''),
      embeds: [],
      components: [],
    };

    const res = await respondToConfirmationInteraction(interaction, successPayload);
    console.log(`[ConfigurableRegistration] ✅ Final response sent via editReply [interactionId: ${interactionId}, regId: ${registrationId}, teamId: ${teamId}]`);
    return res;
  } catch (err) {
    console.error(`[ConfigurableRegistration] ❌ Error in handleConfirmRegistrationButtonClick [interactionId: ${interactionId}, regId: ${registrationId}, teamId: ${teamId}]:`, err);
    return respondToConfirmationInteraction(interaction, {
      content: `❌ Registration could not be completed. Please try again. (${err.message || 'Unknown error'})`,
      embeds: [],
      components: [],
    });
  } finally {
    inFlightConfirmations.delete(idempotencyKey);
    await releaseLock(lockKey);
  }
}

/**
 * Handles the "Manage Registrations" button from the dashboard.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleManageRegistrationsButton(interaction, tournamentId) {
  const registrations = await getConfigurableRegistrationsForTournament(tournamentId);

  if (registrations.length === 0) {
    return interaction.reply({
      content: 'ℹ️ No registration instances have been created yet. Click **Add Registration** to create one.',
      ephemeral: true,
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`md_cfg_manage_reg_select_${tournamentId}`)
    .setPlaceholder('Select a registration instance to manage...')
    .addOptions(
      registrations.map((r) => ({
        label: `${r.displayName} (${r.status})`,
        description: `Capacity: ${r.totalSlots} slots | #${r.registrationNumber}`,
        value: r.registrationId,
      }))
    );

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.reply({
    content: '⚙️ **Select a registration instance to configure or manage:**',
    components: [row],
    ephemeral: true,
  });
}

/**
 * Builds the compact 1-row management dashboard payload for a registration instance.
 * Exactly 1 ActionRow with 5 buttons:
 * 1. Edit Settings
 * 2. Open / Close Registration
 * 3. View Current Slot Chart
 * 4. Refresh
 * 5. Delete Registration
 *
 * @param {object} registration
 * @param {number} filledCount
 * @returns {{ content: string, components: ActionRowBuilder[] }}
 */
export function buildManageDashboardPayload(registration, filledCount = 0) {
  const totalSlots = registration.totalSlots || 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);
  const availableSlots = Math.max(0, maxAvailable - filledCount);
  const isOpen = registration.status === 'OPEN';

  const editSettingsBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_edit_reg_${registration.registrationId}`)
    .setLabel('Edit Settings')
    .setEmoji('✏️')
    .setStyle(ButtonStyle.Primary);

  const toggleStatusBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_toggle_status_${registration.registrationId}`)
    .setLabel(isOpen ? 'Close Registration' : 'Open Registration')
    .setEmoji(isOpen ? '🔒' : '🔓')
    .setStyle(isOpen ? ButtonStyle.Danger : ButtonStyle.Success);

  const viewSlotChartBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_view_slotchart_${registration.registrationId}`)
    .setLabel('View Current Slot Chart')
    .setEmoji('📋')
    .setStyle(ButtonStyle.Secondary);

  const refreshBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_refresh_reg_${registration.registrationId}`)
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  const deleteBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_delete_reg_${registration.registrationId}`)
    .setLabel('Delete Registration')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(
    editSettingsBtn,
    toggleStatusBtn,
    viewSlotChartBtn,
    refreshBtn,
    deleteBtn
  );

  const content =
    `🛠️ **Managing: ${registration.displayName}**\n\n` +
    `• **Name:** ${registration.displayName}\n` +
    `• **Current Cycle Status:** \`${registration.status}\` (Cycle: \`${registration.currentCycleDate || 'N/A'}\`)\n` +
    `• **Total Slots:** \`${totalSlots}\`\n` +
    `• **Reserved Slots:** \`${reservedCount}\`\n` +
    `• **Registered Teams:** \`${filledCount}/${maxAvailable}\`\n` +
    `• **Available Slots:** \`${availableSlots}\`\n` +
    `• **Daily Start Time:** \`${registration.dailyStartTime || 'N/A'}\` (${registration.timezone || 'IST'})\n` +
    `• **Daily Reset Time:** \`${registration.dailyResetTime || 'N/A'}\` (${registration.timezone || 'IST'})\n` +
    `• **Registration Channel:** <#${registration.registrationChannelId}>\n` +
    `• **IDP Channel:** <#${registration.idpChannelId}>\n`;

  return { content, components: [row] };
}

/**
 * Updates the persistent manage dashboard message in place from MongoDB.
 * Reads latest state from MongoDB and re-renders the current screen without pressing Refresh.
 * @param {import('discord.js').Client} client
 * @param {string} registrationId
 * @returns {Promise<boolean>}
 */
export async function updateManageDashboardMessage(client, registrationId) {
  try {
    if (!client || !registrationId) return false;
    const registration = await getConfigurableRegistration(registrationId);
    if (!registration || !registration.manageChannelId || !registration.manageMessageId) return false;

    const channel = await client.channels.fetch(registration.manageChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const message = await channel.messages.fetch(registration.manageMessageId).catch(() => null);
    if (!message) return false;

    const currentCycleId = registration.currentCycleId || null;
    const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
    const payload = buildManageDashboardPayload(registration, filledCount);

    await message.edit(payload).catch(() => null);
    return true;
  } catch (err) {
    console.warn(`[ConfigurableRegistration] ⚠️ Could not update manage dashboard message for ${registrationId}:`, err.message);
    return false;
  }
}

/**
 * Handles selecting an instance from the manage registrations select menu.
 * Displays Name, Total Slots, Reserved Slots count, Registered Count, Available Slots,
 * Daily Start Time, Daily Reset Time, Current Cycle Status, and compact 5-button controls.
 *
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleManageSelectMenu(interaction, tournamentId) {
  const registrationId = interaction.values[0];
  const registration = await getConfigurableRegistration(registrationId);

  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  // Record manage channel and message IDs in MongoDB to enable in-place live updates
  if (interaction.channelId && interaction.message?.id) {
    registration.manageChannelId = interaction.channelId;
    registration.manageMessageId = interaction.message.id;
    await saveConfigurableRegistration(registration);
  }

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
  const payload = buildManageDashboardPayload(registration, filledCount);

  if (interaction.update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, ephemeral: true });
  }
}

/**
 * Refreshes the registration management dashboard in place.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleRefreshRegistration(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);

  if (interaction.client) {
    await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
    await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
  }

  const payload = buildManageDashboardPayload(registration, filledCount);
  if (interaction.isButton && interaction.isButton()) {
    await interaction.update(payload);
  } else if (interaction.update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, ephemeral: true });
  }
}

/**
 * Toggles a registration instance between OPEN and CLOSED in real time.
 * - Clicking Open Registration: Immediately starts registration (channel created/unlocked to accept registrations)
 *   and dashboard message re-renders right away: status shows "Open" and button becomes "Close Registration".
 * - Clicking Close Registration: Immediately stops registration (channel locked for sending, closing message posted)
 *   and dashboard re-renders right away: status shows "Closed" and button becomes "Open Registration".
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleToggleStatus(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const currentCycleId = registration.currentCycleId || null;
  const filledCount = await getRegistrationEntriesCount(registrationId, currentCycleId);
  const totalSlots = registration.totalSlots || 20;
  const reservedCount = parseReservedSlots(registration.reservedSlots, totalSlots);
  const maxAvailable = Math.max(0, totalSlots - reservedCount);

  const isOpening = registration.status !== 'OPEN';
  const guild = interaction.guild;

  if (isOpening) {
    if (filledCount >= maxAvailable) {
      return interaction.reply({
        content: `❌ Cannot open registration: all available slots are filled (${filledCount}/${maxAvailable}).`,
        ephemeral: true,
      });
    }

    // Ensure registration channel exists or recreate it
    let regChannel = null;
    if (registration.registrationChannelId && guild) {
      regChannel = await guild.channels.fetch(registration.registrationChannelId).catch(() => null);
    }
    if (!regChannel && guild) {
      const tournament = await getConfigurableTournament(registration.tournamentId);
      const rawPrefix = tournament?.prefix || (tournament?.name ? buildTournamentPrefix(tournament.name) : 'md');
      const boldPrefix = tournament?.boldPrefix || toMathematicalBold(rawPrefix);
      const slug = (registration.displayName || 'reg')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20) || `group-${registration.registrationNumber || 1}`;
      regChannel = await createTournamentChannel(guild, {
        boldPrefix,
        rawPrefix,
        fallbackSuffix: `${slug}-reg`,
        type: ChannelType.GuildText,
        parent: tournament?.categoryId || null,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
            deny: TOURNAMENT_DENIED_PERMISSIONS,
          },
        ],
      });
      registration.registrationChannelId = regChannel.id;
    } else if (regChannel) {
      // Unlock registration channel for sending
      await regChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      }).catch(() => {});
    }

    registration.status = 'OPEN';
    registration.manualOverride = 'OPEN';
    registration.manualOverrideCycleDate = registration.currentCycleDate;
  } else {
    // Lock registration channel for sending and post closing message
    if (registration.registrationChannelId && guild) {
      const regChannel = await guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      if (regChannel) {
        await regChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
          SendMessages: false,
        }).catch(() => {});
        await regChannel.send('🔒 **Registration is now closed.**').catch(() => {});
      }
    }

    registration.status = 'CLOSED';
    registration.manualOverride = 'CLOSED';
    registration.manualOverrideCycleDate = registration.currentCycleDate;
  }

  // Preserve manage channel and message IDs for live in-place updating
  if (interaction.channelId && interaction.message?.id) {
    registration.manageChannelId = interaction.channelId;
    registration.manageMessageId = interaction.message.id;
  }

  await saveConfigurableRegistration(registration);

  if (interaction.client) {
    await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
    await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
    await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
  }

  // Re-render the dashboard message right away
  const payload = buildManageDashboardPayload(registration, filledCount);
  if (interaction.isButton && interaction.isButton()) {
    await interaction.update(payload);
    if (interaction.followUp) {
      await interaction.followUp({
        content: `✅ Registration is now **${registration.status}**.`,
        ephemeral: true,
      }).catch(() => {});
    }
  } else if (interaction.update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({
      content: `✅ Registration status updated to **${registration.status}**.`,
      ephemeral: true,
    });
  }
}

/**
 * Opens modal to edit registration settings (Name, Total Slots, Reserved Slots, Daily Start Time, Daily Reset Time).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleEditRegistrationButton(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const reservedCount = parseReservedSlots(registration.reservedSlots, registration.totalSlots);
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_edit_reg_modal_${registrationId}`)
    .setTitle(`Edit ${registration.displayName}`.slice(0, 45));

  const nameInput = new TextInputBuilder()
    .setCustomId('registration_name')
    .setLabel('Registration Name')
    .setStyle(TextInputStyle.Short)
    .setValue(registration.displayName || '')
    .setRequired(true);

  const capacityInput = new TextInputBuilder()
    .setCustomId('total_slots')
    .setLabel('Total Slots')
    .setStyle(TextInputStyle.Short)
    .setValue(String(registration.totalSlots || 20))
    .setRequired(true);

  const reservedInput = new TextInputBuilder()
    .setCustomId('reserved_slots')
    .setLabel('Reserved Slots (Count from Slot 01)')
    .setStyle(TextInputStyle.Short)
    .setValue(String(reservedCount))
    .setPlaceholder('e.g. 2 (locks Slot 01 and Slot 02)')
    .setRequired(false);

  const startInput = new TextInputBuilder()
    .setCustomId('daily_start_time')
    .setLabel('Daily Start Time')
    .setStyle(TextInputStyle.Short)
    .setValue(registration.dailyStartTime || registration.rawDailyStartTime || '10:00')
    .setRequired(true);

  const resetInput = new TextInputBuilder()
    .setCustomId('daily_reset_time')
    .setLabel('Daily Reset Time')
    .setStyle(TextInputStyle.Short)
    .setValue(registration.dailyResetTime || registration.rawDailyResetTime || '02:00')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(capacityInput),
    new ActionRowBuilder().addComponents(reservedInput),
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(resetInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handles submission of Edit Registration Settings modal.
 * Enforces capacity and reserved slot occupancy safeguards, updates MongoDB,
 * renames Discord channels, and updates persistent messages and dashboards.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} registrationId
 */
export async function handleEditRegistrationModalSubmit(interaction, registrationId) {
  await interaction.deferReply({ ephemeral: true });

  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.editReply({ content: '❌ Registration instance not found.' });
  }

  const newName = interaction.fields.getTextInputValue('registration_name').trim();
  const rawSlots = parseInt(interaction.fields.getTextInputValue('total_slots').trim(), 10);
  const rawReserved = interaction.fields.getTextInputValue('reserved_slots')?.trim() || '0';
  const rawStart = interaction.fields.getTextInputValue('daily_start_time').trim();
  const rawReset = interaction.fields.getTextInputValue('daily_reset_time').trim();

  if (isNaN(rawSlots) || rawSlots <= 0) {
    return interaction.editReply({ content: '❌ Total slots must be a positive integer.' });
  }

  const newReservedCount = parseReservedSlots(rawReserved, rawSlots);
  if (newReservedCount >= rawSlots) {
    return interaction.editReply({
      content: '❌ Reserved slots count cannot equal or exceed total capacity.',
    });
  }

  // Check allocated slots and check if newly reserved slots overlap with occupied slots
  const entries = await getConfigurableEntriesForRegistration(registrationId, registration.currentCycleId);
  const filledCount = entries.length;

  if (rawSlots < filledCount) {
    return interaction.editReply({
      content: `❌ Capacity cannot be reduced below already allocated slots (${filledCount} teams currently registered).`,
    });
  }

  // Safeguard: newly reserved slots occupy 1..newReservedCount.
  // Check if any existing team is assigned to slotNumber <= newReservedCount
  const conflictingEntries = entries.filter((e) => e.slotNumber <= newReservedCount);
  if (conflictingEntries.length > 0) {
    return interaction.editReply({
      content: `❌ Slot(s) ${conflictingEntries.map((e) => `#${e.slotNumber}`).join(', ')} cannot be reserved because they are already occupied by registered teams (${conflictingEntries.map((e) => e.teamName).join(', ')}).`,
    });
  }

  const parsedStart = parseTimeString(rawStart);
  if (!parsedStart) {
    return interaction.editReply({ content: `❌ Invalid daily start time "${rawStart}". Use format like "10:00 AM" or "18:00".` });
  }

  const parsedReset = parseTimeString(rawReset);
  if (!parsedReset) {
    return interaction.editReply({ content: `❌ Invalid daily reset time "${rawReset}". Use format like "02:00 AM" or "04:00".` });
  }

  // Rename Discord channels if registration name changed
  if (newName !== registration.displayName) {
    const slug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || `group-${registration.registrationNumber || 1}`;

    const tournament = await getConfigurableTournament(registration.tournamentId);
    const rawPrefix = tournament?.prefix || (tournament?.name ? buildTournamentPrefix(tournament.name) : 'md');
    const boldPrefix = tournament?.boldPrefix || toMathematicalBold(rawPrefix);

    const primaryRegName = `${boldPrefix}\uFF5C${slug}-reg`;
    const fallbackRegName = `${rawPrefix.toLowerCase()}-${slug}-reg`;
    const primaryIdpName = `${boldPrefix}\uFF5C${slug}-idp`;
    const fallbackIdpName = `${rawPrefix.toLowerCase()}-${slug}-idp`;

    const renameChannelSafely = async (chan, primaryName, fallbackName) => {
      if (!chan || typeof chan.setName !== 'function') return;
      try {
        await chan.setName(primaryName, 'Registration name updated');
      } catch (err) {
        console.warn(`[ConfigurableRegistration] ⚠️ Failed to rename channel to ${primaryName}: ${err.message}. Retrying with ${fallbackName}...`);
        await chan.setName(fallbackName, 'Registration name updated');
      }
    };

    try {
      if (registration.registrationChannelId && interaction.guild) {
        const regChan = await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null);
        if (regChan && regChan.name !== primaryRegName && regChan.name !== fallbackRegName) {
          await renameChannelSafely(regChan, primaryRegName, fallbackRegName);
        }
      }
      if (registration.idpChannelId && interaction.guild) {
        const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
        if (idpChan && idpChan.name !== primaryIdpName && idpChan.name !== fallbackIdpName) {
          await renameChannelSafely(idpChan, primaryIdpName, fallbackIdpName);
        }
      }
    } catch (renameErr) {
      console.error(`[ConfigurableRegistration] ❌ Channel rename failed:`, renameErr);
      // Keep old name in MongoDB and show real error to admin
      return interaction.editReply({
        content: `❌ Could not rename registration: Discord channel rename failed (${renameErr.message || renameErr}). The old name "${registration.displayName}" was kept.`,
      });
    }

    registration.displayName = newName;
  }

  registration.totalSlots = rawSlots;
  registration.reservedSlots = newReservedCount;
  registration.dailyStartTime = parsedStart.formatted;
  registration.dailyResetTime = parsedReset.formatted;

  await saveConfigurableRegistration(registration);

  if (interaction.client) {
    await updateRegistrationMessage(interaction.client, registrationId).catch(() => {});
    await updateSlotChartMessage(interaction.client, registrationId).catch(() => {});
    await updateManageDashboardMessage(interaction.client, registrationId).catch(() => {});
    await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
  }

  const responseText =
    `✅ **Registration Settings Updated!**\n\n` +
    `• **Name:** ${registration.displayName}\n` +
    `• **Total Slots:** ${rawSlots}\n` +
    `• **Reserved Slots:** ${newReservedCount > 0 ? `${newReservedCount} (01-${String(newReservedCount).padStart(2, '0')})` : 'None'}\n` +
    `• **Daily Start:** ${parsedStart.formatted}\n` +
    `• **Daily Reset:** ${parsedReset.formatted}`;

  await interaction.editReply({ content: responseText });
}

/**
 * Shows the current slot chart embed to the organiser.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleViewCurrentSlotChart(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  const tournament = registration.tournamentId ? await getConfigurableTournament(registration.tournamentId) : null;
  const entries = await getConfigurableEntriesForRegistration(registrationId, registration.currentCycleId);
  const text = buildSlotListText(tournament, registration, entries);

  await interaction.reply({ content: text, ephemeral: true });
}

/**
 * Manually deletes a registration instance, its channels, and its entries.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} registrationId
 */
export async function handleDeleteRegistration(interaction, registrationId) {
  const registration = await getConfigurableRegistration(registrationId);
  if (!registration) {
    return interaction.reply({ content: '❌ Registration instance not found.', ephemeral: true });
  }

  // Revoke IDP access for active leaders before deleting channels
  const activeEntries = await getConfigurableEntriesForRegistration(registrationId);
  if (registration.idpChannelId && interaction.guild) {
    try {
      const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
      if (idpChan && idpChan.permissionOverwrites) {
        for (const entry of activeEntries) {
          if (entry.leaderDiscordId) {
            await idpChan.permissionOverwrites.delete(entry.leaderDiscordId).catch(() => {});
          }
        }
      }
    } catch {}
  }

  try {
    if (registration.registrationChannelId) {
      const regChan = await interaction.guild.channels.fetch(registration.registrationChannelId).catch(() => null);
      if (regChan) await regChan.delete().catch(() => null);
    }
    if (registration.idpChannelId) {
      const idpChan = await interaction.guild.channels.fetch(registration.idpChannelId).catch(() => null);
      if (idpChan) await idpChan.delete().catch(() => null);
    }
  } catch (err) {
    console.warn(`[ConfigurableRegistration] ⚠️ Error cleaning up channels:`, err.message);
  }

  await deleteConfigurableRegistration(registrationId, interaction.client);

  if (interaction.client) {
    await refreshDashboard(interaction.client, registration.tournamentId).catch(() => {});
  }

  await interaction.reply({
    content: `✅ Registration instance **${registration.displayName}** and its associated channels have been deleted.`,
    ephemeral: true,
  });
}
