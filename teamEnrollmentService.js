import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import crypto from 'node:crypto';
import {
  getConfigurableTournament,
  getConfigurableTeam,
  getConfigurableTeamByName,
  getConfigurableTeamsForUser,
  saveConfigurableTeam,
  deleteConfigurableTeam,
  saveConfigurableTournament,
  getConfigurableEntriesForTeam,
  deleteConfigurableEntry,
  saveConfigurableEntry,
  getConfigurableRegistration,
  savePendingEnrollment,
  getPendingEnrollment,
  deletePendingEnrollment,
} from './configurableTournamentData.js';
import { updateSlotChartMessage } from './slotChartService.js';
import { updateRegistrationMessage } from './configurableRegistrationService.js';
import { refreshDashboard, TOURNAMENT_DENIED_PERMISSIONS } from './configurableTournamentService.js';

/**
 * Builds the persistent enrollment embed for the verify channel.
 * @param {object} tournament
 * @returns {EmbedBuilder}
 */
export function buildEnrollmentEmbed(tournament) {
  const reqMembers = tournament?.requiredDiscordMembers ?? 4;

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🛡️ Squad Enrollment — ${tournament?.name || 'Tournament'}`)
    .setDescription(
      `Welcome to **${tournament?.name || 'Tournament'}**!\n\n` +
      `**How to Enroll Your Squad:**\n` +
      `1️⃣ Click **Enroll Squad** below to open the team information form.\n` +
      `2️⃣ Enter your Team Name and each player's **In-Game Name (IGN) & BGMI UID**.\n` +
      `3️⃣ Add optional substitutes or skip to review your team summary.\n` +
      `4️⃣ Mention the **${reqMembers}** Discord member${reqMembers > 1 ? 's' : ''} from your squad.\n\n` +
      `📌 *Already enrolled? Click **Manage Squad** to view, edit, or delete your squad.*`
    )
    .setFooter({ text: 'Match District Tournament System' })
    .setTimestamp();
}

/**
 * Builds the enrollment action buttons for the verify channel.
 * @param {string} tournamentId
 * @returns {ActionRowBuilder}
 */
export function buildEnrollmentComponents(tournamentId) {
  const enrollBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_enroll_${tournamentId}`)
    .setLabel('Enroll Squad')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary);

  const manageBtn = new ButtonBuilder()
    .setCustomId(`md_cfg_my_squad_${tournamentId}`)
    .setLabel('Manage Squad')
    .setEmoji('👥')
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(enrollBtn, manageBtn);
}

/**
 * Posts or refreshes the persistent squad enrollment message in the verify channel.
 * On startup or channel creation, re-edits the stored message using verifyMessageId
 * so its buttons carry the current custom IDs, without posting duplicate messages.
 * @param {import('discord.js').Client} client
 * @param {object|string} tournament
 * @returns {Promise<boolean>}
 */
export async function sendOrUpdateEnrollmentMessage(client, tournament) {
  let tour = tournament;
  if (typeof tournament === 'string') {
    tour = await getConfigurableTournament(tournament);
  }
  if (!tour || !tour.standardChannels?.verifyChannelId) return false;

  const channel = await client.channels.fetch(tour.standardChannels.verifyChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = buildEnrollmentEmbed(tour);
  const row = buildEnrollmentComponents(tour.tournamentId);

  // 1. If stored verifyMessageId exists, re-edit that message
  if (tour.standardChannels.verifyMessageId) {
    try {
      const existing = await channel.messages.fetch(tour.standardChannels.verifyMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed], components: [row] });
        return true;
      }
    } catch (err) {
      console.warn(`[TeamEnrollment] ⚠️ Could not fetch stored verify message ${tour.standardChannels.verifyMessageId}:`, err.message);
    }
  }

  // 2. Fallback: check recent channel messages before sending to prevent duplicates
  try {
    const recentMessages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    if (recentMessages) {
      const botMsg = recentMessages.find(
        (m) =>
          m.author.id === client.user.id &&
          (m.embeds?.[0]?.title?.includes('Squad Enrollment') ||
            m.components?.some((r) => r.components?.some((b) => b.customId?.includes('enroll'))))
      );
      if (botMsg) {
        await botMsg.edit({ embeds: [embed], components: [row] });
        tour.standardChannels.verifyMessageId = botMsg.id;
        await saveConfigurableTournament(tour);
        return true;
      }
    }
  } catch {}

  // 3. Only if no existing message exists at all, post a new one
  const msg = await channel.send({ embeds: [embed], components: [row] });
  tour.standardChannels.verifyMessageId = msg.id;
  await saveConfigurableTournament(tour);
  return true;
}

// ---------------------------------------------------------------------------
// MULTI-STEP ENROLLMENT WIZARD
// ---------------------------------------------------------------------------

/**
 * Initiates enrollment (Step 1 Modal).
 * Responds immediately (< 3 seconds) with showModal as the first action.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleEnrollButtonClick(interaction, tournamentId) {
  try {
    if (!tournamentId) {
      return interaction.reply({
        content: '❌ Tournament configuration not found.',
        ephemeral: true,
      });
    }

    // Call showModal immediately on the first click (< 3 seconds)
    // Database lookups and duplicate team checks run upon Step 1 modal submission
    await showStep1Modal(interaction, tournamentId, null);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error opening enrollment modal:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ Could not open squad enrollment form: ${err.message || err}`,
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

/**
 * Displays Step 1 Modal (Team Name + Player 1 & Player 2 details).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 * @param {object|null} existingSession
 */
export async function showStep1Modal(interaction, tournamentId, existingSession = null) {
  try {
    const modal = new ModalBuilder()
      .setCustomId(`md_cfg_step1_modal_${tournamentId}`)
      .setTitle('Team Enrollment — Step 1 of 5');

    const teamNameInput = new TextInputBuilder()
      .setCustomId('team_name')
      .setLabel('Team Name')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Phoenix Esports')
      .setValue(existingSession?.teamName || '')
      .setMinLength(2)
      .setMaxLength(32)
      .setRequired(true);

    const p1Ign = new TextInputBuilder()
      .setCustomId('p1_ign')
      .setLabel('Player 1 — In-Game Name (IGN)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. PhoenixKing')
      .setValue(existingSession?.p1?.ign || '')
      .setRequired(true);

    const p1Uid = new TextInputBuilder()
      .setCustomId('p1_uid')
      .setLabel('Player 1 — BGMI UID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 512345678')
      .setValue(existingSession?.p1?.uid || '')
      .setRequired(true);

    const p2Ign = new TextInputBuilder()
      .setCustomId('p2_ign')
      .setLabel('Player 2 — In-Game Name (IGN)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. SniperPro')
      .setValue(existingSession?.p2?.ign || '')
      .setRequired(true);

    const p2Uid = new TextInputBuilder()
      .setCustomId('p2_uid')
      .setLabel('Player 2 — BGMI UID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 512345679')
      .setValue(existingSession?.p2?.uid || '')
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(teamNameInput),
      new ActionRowBuilder().addComponents(p1Ign),
      new ActionRowBuilder().addComponents(p1Uid),
      new ActionRowBuilder().addComponents(p2Ign),
      new ActionRowBuilder().addComponents(p2Uid)
    );

    await interaction.showModal(modal);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in showStep1Modal:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ Could not display Step 1 modal: ${err.message || err}`,
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

/**
 * Handles Step 1 Modal submission and offers navigation to Step 2.
 * Validates that user does not already lead an enrolled team, validates name uniqueness,
 * and saves session to MongoDB.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleStep1ModalSubmit(interaction, tournamentId) {
  try {
    const teamName = interaction.fields?.getTextInputValue?.('team_name')?.trim();
    const p1Ign = interaction.fields?.getTextInputValue?.('p1_ign')?.trim();
    const p1Uid = interaction.fields?.getTextInputValue?.('p1_uid')?.trim();
    const p2Ign = interaction.fields?.getTextInputValue?.('p2_ign')?.trim();
    const p2Uid = interaction.fields?.getTextInputValue?.('p2_uid')?.trim();

    if (!teamName || !p1Ign || !p1Uid || !p2Ign || !p2Uid) {
      return interaction.reply({
        content: '❌ All fields in Step 1 are required.',
        ephemeral: true,
      });
    }

    // 1. Check if user already leads an enrolled team in this tournament
    const userTeams = await getConfigurableTeamsForUser(tournamentId, interaction.user.id);
    const leadingTeam = userTeams.find((t) => t.leaderDiscordId === interaction.user.id);
    const currentSession = (await getPendingEnrollment(tournamentId, interaction.user.id)) || {};

    if (leadingTeam && (!currentSession.isEdit || leadingTeam.teamId !== currentSession.teamId)) {
      return interaction.reply({
        content:
          `ℹ️ You have already enrolled squad **${leadingTeam.teamName}** in this tournament.\n` +
          `Click **Manage Squad** in the verification channel to view, edit, or delete your squad.`,
        ephemeral: true,
      });
    }

    // 2. Validate team name uniqueness
    const existingTeam = await getConfigurableTeamByName(tournamentId, teamName);
    if (existingTeam && (!currentSession.isEdit || existingTeam.teamId !== currentSession.teamId)) {
      return interaction.reply({
        content: `❌ A squad named **${teamName}** is already enrolled in this tournament. Please choose a different name.`,
        ephemeral: true,
      });
    }

    const session = {
      ...currentSession,
      tournamentId,
      userId: interaction.user.id,
      teamName,
      p1: { ign: p1Ign, uid: p1Uid },
      p2: { ign: p2Ign, uid: p2Uid },
      step: 1,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };

    await savePendingEnrollment(session);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Team Enrollment — Step 1 Completed')
      .setDescription(
        `**Team Name:** **${teamName}**\n\n` +
        `**Player 1:** ${p1Ign} (UID: \`${p1Uid}\`)\n` +
        `**Player 2:** ${p2Ign} (UID: \`${p2Uid}\`)\n\n` +
        `Click **Next** to enter details for Player 3 and Player 4.`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_cfg_goto_step2_${tournamentId}`)
        .setLabel('Next: Step 2 (Players 3 & 4)')
        .setEmoji('➡️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`md_cfg_cancel_enroll_${tournamentId}`)
        .setLabel('Cancel')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Secondary)
    );

    return await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleStep1ModalSubmit:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ An error occurred during Step 1 submission: ${err.message || err}`,
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

/**
 * Displays Step 2 Modal (Player 3 & Player 4 details).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function showStep2Modal(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please click "Enroll Squad" again.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`md_cfg_step2_modal_${tournamentId}`)
      .setTitle('Team Enrollment — Step 2 of 5');

    const p3Ign = new TextInputBuilder()
      .setCustomId('p3_ign')
      .setLabel('Player 3 — In-Game Name (IGN)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Rusher007')
      .setValue(session.p3?.ign || '')
      .setRequired(true);

    const p3Uid = new TextInputBuilder()
      .setCustomId('p3_uid')
      .setLabel('Player 3 — BGMI UID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 512345680')
      .setValue(session.p3?.uid || '')
      .setRequired(true);

    const p4Ign = new TextInputBuilder()
      .setCustomId('p4_ign')
      .setLabel('Player 4 — In-Game Name (IGN)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. SupportGod')
      .setValue(session.p4?.ign || '')
      .setRequired(true);

    const p4Uid = new TextInputBuilder()
      .setCustomId('p4_uid')
      .setLabel('Player 4 — BGMI UID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 512345681')
      .setValue(session.p4?.uid || '')
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(p3Ign),
      new ActionRowBuilder().addComponents(p3Uid),
      new ActionRowBuilder().addComponents(p4Ign),
      new ActionRowBuilder().addComponents(p4Uid)
    );

    await interaction.showModal(modal);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in showStep2Modal:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Could not display Step 2 form: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles Step 2 Modal submission and offers options for Step 3 (Substitutes).
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleStep2ModalSubmit(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please restart enrollment.', ephemeral: true });
    }

    session.p3 = {
      ign: interaction.fields.getTextInputValue('p3_ign').trim(),
      uid: interaction.fields.getTextInputValue('p3_uid').trim(),
    };
    session.p4 = {
      ign: interaction.fields.getTextInputValue('p4_ign').trim(),
      uid: interaction.fields.getTextInputValue('p4_uid').trim(),
    };
    session.step = 2;
    session.expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await savePendingEnrollment(session);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Team Enrollment — Step 3 of 5 (Substitute Players)')
      .setDescription(
        `Main roster players recorded!\n\n` +
        `**Would you like to add substitute players?**\n` +
        `You can add up to 2 optional substitutes, or skip this step.`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_cfg_back_to_step1_${tournamentId}`)
        .setLabel('Back to Step 1')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`md_cfg_goto_step3_${tournamentId}`)
        .setLabel('Add Substitutes')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`md_cfg_skip_step3_${tournamentId}`)
        .setLabel('Skip Substitutes')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleStep2ModalSubmit:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ An error occurred during Step 2 submission: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Displays Step 3 Modal (Optional Substitute 1 & Substitute 2).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function showStep3Modal(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please restart enrollment.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`md_cfg_step3_modal_${tournamentId}`)
      .setTitle('Team Enrollment — Step 3 of 5 (Substitutes)');

    const sub1Ign = new TextInputBuilder()
      .setCustomId('sub1_ign')
      .setLabel('Substitute 1 — In-Game Name (Optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave blank if none')
      .setValue(session.substitutes?.[0]?.ign || '')
      .setRequired(false);

    const sub1Uid = new TextInputBuilder()
      .setCustomId('sub1_uid')
      .setLabel('Substitute 1 — BGMI UID (Optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave blank if none')
      .setValue(session.substitutes?.[0]?.uid || '')
      .setRequired(false);

    const sub2Ign = new TextInputBuilder()
      .setCustomId('sub2_ign')
      .setLabel('Substitute 2 — In-Game Name (Optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave blank if none')
      .setValue(session.substitutes?.[1]?.ign || '')
      .setRequired(false);

    const sub2Uid = new TextInputBuilder()
      .setCustomId('sub2_uid')
      .setLabel('Substitute 2 — BGMI UID (Optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave blank if none')
      .setValue(session.substitutes?.[1]?.uid || '')
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(sub1Ign),
      new ActionRowBuilder().addComponents(sub1Uid),
      new ActionRowBuilder().addComponents(sub2Ign),
      new ActionRowBuilder().addComponents(sub2Uid)
    );

    await interaction.showModal(modal);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in showStep3Modal:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Could not display Step 3 form: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles Step 3 Modal submission and proceeds to Step 4 (Confirmation).
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleStep3ModalSubmit(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please restart enrollment.', ephemeral: true });
    }

    const sub1Ign = interaction.fields.getTextInputValue('sub1_ign')?.trim();
    const sub1Uid = interaction.fields.getTextInputValue('sub1_uid')?.trim();
    const sub2Ign = interaction.fields.getTextInputValue('sub2_ign')?.trim();
    const sub2Uid = interaction.fields.getTextInputValue('sub2_uid')?.trim();

    const substitutes = [];
    if (sub1Ign) substitutes.push({ ign: sub1Ign, uid: sub1Uid || 'N/A' });
    if (sub2Ign) substitutes.push({ ign: sub2Ign, uid: sub2Uid || 'N/A' });

    session.substitutes = substitutes;
    session.step = 3;
    session.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await savePendingEnrollment(session);

    await showStep4Confirmation(interaction, tournamentId, session);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleStep3ModalSubmit:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ An error occurred during Step 3 submission: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles Skip Substitutes action and proceeds to Step 4 (Confirmation).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleSkipSubstitutes(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please restart enrollment.', ephemeral: true });
    }

    session.substitutes = [];
    session.step = 3;
    session.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await savePendingEnrollment(session);

    await showStep4Confirmation(interaction, tournamentId, session);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleSkipSubstitutes:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ An error occurred: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Renders Step 4 Confirmation summary.
 * @param {import('discord.js').Interaction} interaction
 * @param {string} tournamentId
 * @param {object} session
 */
export async function showStep4Confirmation(interaction, tournamentId, session) {
  try {
    const subText =
      session.substitutes && session.substitutes.length > 0
        ? session.substitutes.map((s, i) => `• Substitute ${i + 1}: **${s.ign}** (UID: \`${s.uid}\`)`).join('\n')
        : '*None*';

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Team Enrollment — Step 4 of 5 (Confirmation)')
      .setDescription(
        `Please review your squad details before proceeding to Discord member selection:\n\n` +
        `**Team Name:** **${session.teamName}**\n\n` +
        `**Main Roster:**\n` +
        `• Player 1: **${session.p1.ign}** (UID: \`${session.p1.uid}\`)\n` +
        `• Player 2: **${session.p2.ign}** (UID: \`${session.p2.uid}\`)\n` +
        `• Player 3: **${session.p3.ign}** (UID: \`${session.p3.uid}\`)\n` +
        `• Player 4: **${session.p4.ign}** (UID: \`${session.p4.uid}\`)\n\n` +
        `**Substitutes:**\n${subText}`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_cfg_back_to_step2_${tournamentId}`)
        .setLabel('Back to Step 2')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`md_cfg_goto_step5_${tournamentId}`)
        .setLabel('Confirm & Select Discord Members')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
    );

    if (typeof interaction.update === 'function' && interaction.isButton?.()) {
      await interaction.update({ embeds: [embed], components: [row] });
    } else {
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in showStep4Confirmation:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ An error occurred displaying confirmation: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Displays Step 5 (Discord Member Mentions).
 * Shows clean, dynamic prompt without any "Leader + Teammates" terminology.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function showStep5DiscordSelection(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please restart enrollment.', ephemeral: true });
    }

    const tournament = await getConfigurableTournament(tournamentId);
    const reqMembers = tournament?.requiredDiscordMembers ?? 4;

    const select = new UserSelectMenuBuilder()
      .setCustomId(`md_cfg_step5_users_${tournamentId}`)
      .setPlaceholder(`Select ${reqMembers} Discord member${reqMembers > 1 ? 's' : ''}...`)
      .setMinValues(reqMembers)
      .setMaxValues(reqMembers);

    const row = new ActionRowBuilder().addComponents(select);

    await interaction.update({
      embeds: [],
      content:
        `📋 **Team Enrollment — Step 5 of 5: Select Discord Members**\n\n` +
        `Please mention the required number of members from your squad.\n` +
        `📌 **Please select ${reqMembers} Discord member${reqMembers > 1 ? 's' : ''}.**\n\n` +
        `*(Ensure you include your own Discord account in the selection)*`,
      components: [row],
    });
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in showStep5DiscordSelection:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Could not display member selection: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles Step 5 UserSelectMenu submission, validates members, and saves the team.
 * @param {import('discord.js').UserSelectMenuInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleStep5UserSelect(interaction, tournamentId) {
  try {
    const session = await getPendingEnrollment(tournamentId, interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired. Please restart enrollment.', ephemeral: true });
    }

    const tournament = await getConfigurableTournament(tournamentId);
    const reqMembers = tournament?.requiredDiscordMembers ?? 4;
    const selectedUsers = interaction.values; // Array of selected user IDs

    // 1. Exact count validation
    if (!selectedUsers || selectedUsers.length !== reqMembers) {
      return interaction.reply({
        content: `❌ You must select exactly ${reqMembers} Discord member${reqMembers > 1 ? 's' : ''}.`,
        ephemeral: true,
      });
    }

    // 2. Submitting user must be included
    if (!selectedUsers.includes(interaction.user.id)) {
      return interaction.reply({
        content: `❌ You must include your own Discord account in the selected members.`,
        ephemeral: true,
      });
    }

    // 3. No duplicates
    const uniqueUsers = new Set(selectedUsers);
    if (uniqueUsers.size !== reqMembers) {
      return interaction.reply({
        content: `❌ Duplicate member selections are not allowed. All selected accounts must be distinct.`,
        ephemeral: true,
      });
    }

    // 4. Server membership validation
    if (interaction.guild) {
      for (const uid of selectedUsers) {
        let isMember = false;
        if (interaction.guild.members?.cache?.has?.(uid)) {
          isMember = true;
        } else if (typeof interaction.guild.members?.fetch === 'function') {
          const fetched = await interaction.guild.members.fetch(uid).catch(() => null);
          if (fetched) isMember = true;
        } else {
          isMember = true;
        }
        if (!isMember) {
          return interaction.reply({
            content: `❌ User <@${uid}> is not a member of this Discord server.`,
            ephemeral: true,
          });
        }
      }
    }

    // 5. Re-check team name duplicate
    const existingTeam = await getConfigurableTeamByName(tournamentId, session.teamName);
    if (existingTeam && (!session.isEdit || existingTeam.teamId !== session.teamId)) {
      await deletePendingEnrollment(tournamentId, interaction.user.id);
      return interaction.reply({
        content: `❌ A squad named **${session.teamName}** has already been registered.`,
        ephemeral: true,
      });
    }

    // Submitting user is automatically identified and stored as team leader
    const otherUsers = selectedUsers.filter((id) => id !== interaction.user.id);
    const orderedUserIds = [interaction.user.id, ...otherUsers];

    const players = [
      {
        discordId: orderedUserIds[0] || null,
        ign: session.p1.ign,
        uid: session.p1.uid,
      },
      {
        discordId: orderedUserIds[1] || null,
        ign: session.p2.ign,
        uid: session.p2.uid,
      },
      {
        discordId: orderedUserIds[2] || null,
        ign: session.p3.ign,
        uid: session.p3.uid,
      },
      {
        discordId: orderedUserIds[3] || null,
        ign: session.p4.ign,
        uid: session.p4.uid,
      },
    ];

    const substitutes = (session.substitutes || []).map((s) => ({
      ign: s.ign,
      uid: s.uid,
    }));

    if (session.isEdit) {
      // ----------------------------------------------------
      // EDIT SQUAD
      // ----------------------------------------------------
      const existingTeamDoc = await getConfigurableTeam(session.teamId);
      if (!existingTeamDoc) {
        return interaction.reply({ content: '❌ Team record not found.', ephemeral: true });
      }

      const updatedTeamDoc = {
        ...existingTeamDoc,
        teamName: session.teamName,
        leaderDiscordId: interaction.user.id,
        players,
        substitutes,
        updatedAt: new Date(),
      };

      await saveConfigurableTeam(updatedTeamDoc);

      // If team name changed, update existing registration entries and slot charts in place
      if (existingTeamDoc.teamName !== session.teamName) {
        const entries = await getConfigurableEntriesForTeam(session.teamId);
        for (const entry of entries) {
          entry.teamName = session.teamName;
          await saveConfigurableEntry(entry);
          await updateSlotChartMessage(interaction.client, entry.registrationId);
        }
      }

      await deletePendingEnrollment(tournamentId, interaction.user.id);

      const playerList = players
        .map((p, i) => `${i === 0 ? '👑' : '🎮'} ${p.discordId ? `<@${p.discordId}>` : '*(Teammate)*'} (IGN: **${p.ign}** | UID: \`${p.uid}\`)`)
        .join('\n');

      await interaction.update({
        content:
          `✅ **Your squad has been successfully updated.**\n\n` +
          `**Team:** **${updatedTeamDoc.teamName}**\n` +
          `**Leader:** <@${updatedTeamDoc.leaderDiscordId}>\n\n` +
          `**Roster:**\n${playerList}\n\n` +
          `🎉 All existing registrations and slot allocations have been preserved.`,
        components: [],
      });
    } else {
      // ----------------------------------------------------
      // NEW ENROLLMENT
      // ----------------------------------------------------
      const teamDoc = {
        teamId: crypto.randomUUID(),
        tournamentId,
        guildId: interaction.guildId,
        teamName: session.teamName,
        leaderDiscordId: interaction.user.id,
        players,
        substitutes,
        enrolledAt: new Date(),
      };

      await saveConfigurableTeam(teamDoc);
      await deletePendingEnrollment(tournamentId, interaction.user.id);
      await refreshDashboard(interaction.client, tournamentId);

      const playerList = players
        .map((p, i) => `${i === 0 ? '👑' : '🎮'} ${p.discordId ? `<@${p.discordId}>` : '*(Teammate)*'} (IGN: **${p.ign}** | UID: \`${p.uid}\`)`)
        .join('\n');

      await interaction.update({
        content:
          `✅ **Your squad has been successfully enrolled.**\n\n` +
          `**Team:** **${teamDoc.teamName}**\n` +
          `**Leader:** <@${teamDoc.leaderDiscordId}>\n\n` +
          `**Roster:**\n${playerList}\n\n` +
          `🎉 You can now register for tournament slots in the registration channels!`,
        components: [],
      });
    }
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleStep5UserSelect:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ An error occurred finalizing squad enrollment: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// SQUAD MANAGEMENT (View, Edit, Delete)
// ---------------------------------------------------------------------------

/**
 * Handles the "Manage Squad" button click in the verification channel.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleManageMySquadButton(interaction, tournamentId) {
  try {
    // Acknowledge immediately (< 3 seconds) for non-modal interaction
    if (!interaction.deferred && !interaction.replied) {
      if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ ephemeral: true });
      }
    }

    if (!tournamentId) {
      const errorMsg = '❌ Tournament configuration not found.';
      if (interaction.deferred) return await interaction.editReply({ content: errorMsg });
      return await interaction.reply({ content: errorMsg, ephemeral: true });
    }

    const userTeams = await getConfigurableTeamsForUser(tournamentId, interaction.user.id);
    const team = userTeams.find((t) => t.leaderDiscordId === interaction.user.id);

    if (!team) {
      const noTeamMsg = `❌ You do not currently lead an enrolled squad in this tournament. Click **Enroll Squad** to get started.`;
      if (interaction.deferred) return await interaction.editReply({ content: noTeamMsg });
      return await interaction.reply({ content: noTeamMsg, ephemeral: true });
    }

    const entries = await getConfigurableEntriesForTeam(team.teamId);

    const playerLines = (team.players || [])
      .map((p, i) => `• Player ${i + 1}: **${p.ign}** (UID: \`${p.uid}\`) ${p.discordId ? `— <@${p.discordId}>` : ''}`)
      .join('\n');

    const subLines =
      team.substitutes && team.substitutes.length > 0
        ? team.substitutes.map((s, i) => `• Sub ${i + 1}: **${s.ign}** (UID: \`${s.uid}\`)`).join('\n')
        : '*None*';

    const regLines =
      entries.length > 0
        ? entries.map((e) => `• Instance: \`${e.registrationId}\` (Slot #${e.slotNumber})`).join('\n')
        : '*No active registrations.*';

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🛡️ Squad Management — ${team.teamName}`)
      .setDescription(
        `**Leader:** <@${team.leaderDiscordId}>\n\n` +
        `**Main Roster:**\n${playerLines}\n\n` +
        `**Substitutes:**\n${subLines}\n\n` +
        `**Active Registrations:**\n${regLines}`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_cfg_edit_squad_btn_${team.teamId}`)
        .setLabel('Edit Squad')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`md_cfg_del_squad_prompt_${team.teamId}`)
        .setLabel('Delete Squad')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    if (interaction.deferred) {
      return await interaction.editReply({ embeds: [embed], components: [row] });
    }
    return await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleManageMySquadButton:`, err);
    const msg = `❌ Failed to open squad management: ${err.message || err}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg }).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Initiates the Edit Squad multi-step flow.
 * Only the original team leader can edit the squad.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} teamId
 */
export async function handleEditSquadButtonClick(interaction, teamId) {
  try {
    const team = await getConfigurableTeam(teamId);
    if (!team) {
      return interaction.reply({ content: '❌ Team not found.', ephemeral: true });
    }

    if (team.leaderDiscordId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Only the original team leader can edit this squad.', ephemeral: true });
    }

    // Pre-populate session with existing squad details
    const session = {
      tournamentId: team.tournamentId,
      userId: interaction.user.id,
      isEdit: true,
      teamId: team.teamId,
      teamName: team.teamName,
      p1: team.players[0] || { ign: '', uid: '' },
      p2: team.players[1] || { ign: '', uid: '' },
      p3: team.players[2] || { ign: '', uid: '' },
      p4: team.players[3] || { ign: '', uid: '' },
      substitutes: team.substitutes || [],
      step: 1,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };

    await savePendingEnrollment(session);

    await showStep1Modal(interaction, team.tournamentId, session);
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleEditSquadButtonClick:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Could not open edit form: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Displays Delete Squad confirmation prompt.
 * Only the original team leader can delete the squad.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} teamId
 */
export async function handleDeleteSquadPrompt(interaction, teamId) {
  try {
    const team = await getConfigurableTeam(teamId);
    if (!team) {
      return interaction.reply({ content: '❌ Team not found.', ephemeral: true });
    }

    if (team.leaderDiscordId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Only the original team leader can delete this squad.', ephemeral: true });
    }

    // Check if squad is currently in a live / locked match instance
    const entries = await getConfigurableEntriesForTeam(teamId);
    for (const entry of entries) {
      const reg = await getConfigurableRegistration(entry.registrationId);
      if (reg && (reg.status === 'CLOSED' || reg.status === 'LIVE')) {
        return interaction.reply({
          content: `❌ **Cannot Delete Squad:** Your squad is currently entered in an active or locked match instance (**${reg.displayName}**). Please contact tournament organisers to request withdrawal.`,
          ephemeral: true,
        });
      }
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`md_cfg_del_squad_confirm_${teamId}`)
        .setLabel('Confirm Delete')
        .setEmoji('⚠️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`md_cfg_del_squad_cancel_${teamId}`)
        .setLabel('Cancel')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content:
        `⚠️ **Are you sure you want to delete this squad? This action will affect its existing tournament registrations.**\n\n` +
        `• **Squad:** **${team.teamName}**\n` +
        `• **Active Registrations to be Withdrawn:** **${entries.length}**\n` +
        `• All allocated slots will be released, and IDP channel access will be revoked.\n\n` +
        `This action cannot be undone.`,
      components: [row],
      ephemeral: true,
    });
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleDeleteSquadPrompt:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Could not open delete prompt: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Finalizes squad deletion with slot releasing and IDP permission revocation.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} teamId
 */
export async function handleDeleteSquadConfirm(interaction, teamId) {
  try {
    const team = await getConfigurableTeam(teamId);
    if (!team) {
      return interaction.update({ content: '❌ Team not found or already deleted.', components: [] });
    }

    if (team.leaderDiscordId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Only the original team leader can delete this squad.', ephemeral: true });
    }

    // Live match check
    const entries = await getConfigurableEntriesForTeam(teamId);
    for (const entry of entries) {
      const reg = await getConfigurableRegistration(entry.registrationId);
      if (reg && (reg.status === 'CLOSED' || reg.status === 'LIVE')) {
        return interaction.update({
          content: `❌ **Cannot Delete Squad:** Your squad is entered in locked instance (**${reg.displayName}**). Contact an organiser.`,
          components: [],
        });
      }
    }

    // Release all allocated slots, update slot charts, update registration messages, and revoke leader IDP permissions
    for (const entry of entries) {
      await deleteConfigurableEntry(entry.registrationId, teamId);
      await updateSlotChartMessage(interaction.client, entry.registrationId);
      await updateRegistrationMessage(interaction.client, entry.registrationId);

      // Revoke leader IDP channel access
      const reg = await getConfigurableRegistration(entry.registrationId);
      if (reg?.idpChannelId && interaction.guild) {
        try {
          const idpChan = await interaction.guild.channels.fetch(reg.idpChannelId).catch(() => null);
          if (idpChan && typeof idpChan.permissionOverwrites?.delete === 'function') {
            await idpChan.permissionOverwrites.delete(interaction.user.id).catch(() => {});
          }
        } catch (err) {
          console.warn(`[ConfigurableTournament] ⚠️ Error revoking IDP overwrite for deleted squad:`, err.message);
        }
      }
    }

    // Delete team record
    await deleteConfigurableTeam(teamId);

    // Refresh dashboard in setup channel
    await refreshDashboard(interaction.client, team.tournamentId);

    await interaction.update({
      content: `🗑️ **Squad Deleted.** Squad **${team.teamName}** and all associated registrations have been removed.`,
      components: [],
    });
  } catch (err) {
    console.error(`[TeamEnrollment] ❌ Error in handleDeleteSquadConfirm:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Error deleting squad: ${err.message || err}`, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Cancels squad deletion.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleDeleteSquadCancel(interaction) {
  await interaction.update({
    content: '❌ Deletion cancelled. Your squad remains active.',
    components: [],
  });
}

// Backward-compatibility aliases
export const handleEnrollModalSubmit = handleStep1ModalSubmit;
export const handleEnrollUserSelect = handleStep5UserSelect;
