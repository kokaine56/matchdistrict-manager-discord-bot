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
  getConfigurableTeamByName,
  getConfigurableTeamsForUser,
  saveConfigurableTeam,
  saveConfigurableTournament,
} from './configurableTournamentData.js';

// Temporary cache for multi-step modal -> user-select workflow
// Key: `${tournamentId}:${userId}` -> { teamName, playerDetails, expiresAt }
const pendingEnrollments = new Map();

/**
 * Builds the persistent enrollment embed for the verify channel.
 * @param {object} tournament
 * @returns {EmbedBuilder}
 */
export function buildEnrollmentEmbed(tournament) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🛡️ Squad Enrollment — ${tournament.name || 'Tournament'}`)
    .setDescription(
      `Welcome to **${tournament.name || 'Tournament'}**!\n\n` +
      `**How to Register Your Team:**\n` +
      `1️⃣ Click the **Enroll Squad** button below.\n` +
      `2️⃣ Enter your Team Name and each player's **IGN & UID**.\n` +
      `3️⃣ Select the 4 Discord members of your squad.\n\n` +
      `📌 *The user who submits the enrollment becomes the **Team Leader**.*\n` +
      `📌 *Once enrolled, your leader can register your squad in any active tournament instance!*`
    )
    .setFooter({ text: 'Match District Tournament System' })
    .setTimestamp();
}

/**
 * Builds the enrollment button row.
 * @param {string} tournamentId
 * @returns {ActionRowBuilder}
 */
export function buildEnrollmentComponents(tournamentId) {
  const button = new ButtonBuilder()
    .setCustomId(`md_cfg_enroll_${tournamentId}`)
    .setLabel('Enroll Squad')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder().addComponents(button);
}

/**
 * Posts or refreshes the persistent squad enrollment message in the verify channel.
 * @param {import('discord.js').Client} client
 * @param {object} tournament
 * @returns {Promise<boolean>}
 */
export async function sendOrUpdateEnrollmentMessage(client, tournament) {
  if (!tournament || !tournament.standardChannels?.verifyChannelId) return false;

  const channel = await client.channels.fetch(tournament.standardChannels.verifyChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = buildEnrollmentEmbed(tournament);
  const row = buildEnrollmentComponents(tournament.tournamentId);

  if (tournament.standardChannels.verifyMessageId) {
    try {
      const existing = await channel.messages.fetch(tournament.standardChannels.verifyMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed], components: [row] });
        return true;
      }
    } catch {
      // Fall through to send new
    }
  }

  const msg = await channel.send({ embeds: [embed], components: [row] });
  tournament.standardChannels.verifyMessageId = msg.id;
  await saveConfigurableTournament(tournament);
  return true;
}

/**
 * Handles the Enroll Squad button click by displaying a modal.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleEnrollButtonClick(interaction, tournamentId) {
  const modal = new ModalBuilder()
    .setCustomId(`md_cfg_enroll_modal_${tournamentId}`)
    .setTitle('Squad Enrollment Details');

  const teamNameInput = new TextInputBuilder()
    .setCustomId('team_name')
    .setLabel('Team Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Phoenix Esports')
    .setMinLength(2)
    .setMaxLength(32)
    .setRequired(true);

  const p1Input = new TextInputBuilder()
    .setCustomId('player_1')
    .setLabel('Player 1 (Leader) - IGN & In-Game UID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. PhoenixKing / 512345678')
    .setRequired(true);

  const p2Input = new TextInputBuilder()
    .setCustomId('player_2')
    .setLabel('Player 2 - IGN & In-Game UID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. SniperPro / 512345679')
    .setRequired(true);

  const p3Input = new TextInputBuilder()
    .setCustomId('player_3')
    .setLabel('Player 3 - IGN & In-Game UID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Rusher007 / 512345680')
    .setRequired(true);

  const p4Input = new TextInputBuilder()
    .setCustomId('player_4')
    .setLabel('Player 4 - IGN & In-Game UID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. SupportGod / 512345681')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(teamNameInput),
    new ActionRowBuilder().addComponents(p1Input),
    new ActionRowBuilder().addComponents(p2Input),
    new ActionRowBuilder().addComponents(p3Input),
    new ActionRowBuilder().addComponents(p4Input)
  );

  await interaction.showModal(modal);
}

/**
 * Parses "IGN / UID" or "IGN - UID" or "IGN UID" string.
 * @param {string} raw
 * @returns {{ ign: string, uid: string }}
 */
function parsePlayerInfo(raw) {
  if (!raw) return { ign: 'Player', uid: 'N/A' };
  const parts = raw.split(/[/|-]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { ign: parts[0], uid: parts.slice(1).join(' ') };
  }
  const spaceParts = raw.trim().split(/\s+/);
  if (spaceParts.length >= 2) {
    return { ign: spaceParts[0], uid: spaceParts.slice(1).join(' ') };
  }
  return { ign: raw.trim(), uid: 'N/A' };
}

/**
 * Handles the submission of the Squad Enrollment Modal.
 * Prompts user with a UserSelectMenu for the 4 Discord squad members.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleEnrollModalSubmit(interaction, tournamentId) {
  const teamName = interaction.fields.getTextInputValue('team_name').trim();
  const p1Raw = interaction.fields.getTextInputValue('player_1').trim();
  const p2Raw = interaction.fields.getTextInputValue('player_2').trim();
  const p3Raw = interaction.fields.getTextInputValue('player_3').trim();
  const p4Raw = interaction.fields.getTextInputValue('player_4').trim();

  // Validate team name uniqueness in this tournament
  const existingTeam = await getConfigurableTeamByName(tournamentId, teamName);
  if (existingTeam) {
    return interaction.reply({
      content: `❌ A squad named **${teamName}** is already enrolled in this tournament. Please choose a different name.`,
      ephemeral: true,
    });
  }

  // Cache pending details for 5 minutes
  const cacheKey = `${tournamentId}:${interaction.user.id}`;
  pendingEnrollments.set(cacheKey, {
    tournamentId,
    guildId: interaction.guildId,
    teamName,
    leaderDiscordId: interaction.user.id,
    playerDetails: [
      parsePlayerInfo(p1Raw),
      parsePlayerInfo(p2Raw),
      parsePlayerInfo(p3Raw),
      parsePlayerInfo(p4Raw),
    ],
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(`md_cfg_enroll_users_${tournamentId}`)
    .setPlaceholder('Select the 4 Discord members of your squad (including yourself)...')
    .setMinValues(4)
    .setMaxValues(4);

  const row = new ActionRowBuilder().addComponents(userSelect);

  await interaction.reply({
    content:
      `📋 **Step 2: Tag Squad Members for "${teamName}"**\n` +
      `Please select **all 4 Discord members** for your squad below.\n` +
      `⚠️ **Requirement:** You (<@${interaction.user.id}>) must be one of the 4 selected members as the Team Leader.`,
    components: [row],
    ephemeral: true,
  });
}

/**
 * Handles the UserSelect menu interaction and finalizes team enrollment.
 * @param {import('discord.js').UserSelectMenuInteraction} interaction
 * @param {string} tournamentId
 */
export async function handleEnrollUserSelect(interaction, tournamentId) {
  const cacheKey = `${tournamentId}:${interaction.user.id}`;
  const pending = pendingEnrollments.get(cacheKey);

  if (!pending || pending.expiresAt < Date.now()) {
    pendingEnrollments.delete(cacheKey);
    return interaction.reply({
      content: '❌ Enrollment session timed out. Please click "Enroll Squad" again.',
      ephemeral: true,
    });
  }

  const selectedUsers = interaction.values; // Array of 4 user IDs
  if (!selectedUsers || selectedUsers.length !== 4) {
    return interaction.reply({
      content: '❌ You must select exactly 4 Discord members.',
      ephemeral: true,
    });
  }

  // Ensure submitter is in the list
  if (!selectedUsers.includes(interaction.user.id)) {
    return interaction.reply({
      content: `❌ You must include yourself (<@${interaction.user.id}>) in the squad selection to act as Team Leader.`,
      ephemeral: true,
    });
  }

  // Check unique member IDs
  const uniqueUsers = new Set(selectedUsers);
  if (uniqueUsers.size !== 4) {
    return interaction.reply({
      content: '❌ All 4 squad members must be distinct users.',
      ephemeral: true,
    });
  }

  // Re-check team name duplicate
  const existingTeam = await getConfigurableTeamByName(tournamentId, pending.teamName);
  if (existingTeam) {
    pendingEnrollments.delete(cacheKey);
    return interaction.reply({
      content: `❌ A squad named **${pending.teamName}** has already been registered.`,
      ephemeral: true,
    });
  }

  // Put leader first, then the other 3 members
  const otherUsers = selectedUsers.filter((id) => id !== interaction.user.id);
  const orderedUserIds = [interaction.user.id, ...otherUsers];

  const players = orderedUserIds.map((userId, index) => {
    const detail = pending.playerDetails[index] || { ign: `Player ${index + 1}`, uid: 'N/A' };
    return {
      discordId: userId,
      ign: detail.ign,
      uid: detail.uid,
    };
  });

  const teamDoc = {
    teamId: crypto.randomUUID(),
    tournamentId,
    guildId: interaction.guildId,
    teamName: pending.teamName,
    leaderDiscordId: interaction.user.id,
    players,
    substitutes: [],
    enrolledAt: new Date(),
  };

  await saveConfigurableTeam(teamDoc);
  pendingEnrollments.delete(cacheKey);

  const playerList = players
    .map((p, i) => `${i === 0 ? '👑' : '🎮'} <@${p.discordId}> (IGN: **${p.ign}** | UID: \`${p.uid}\`)`)
    .join('\n');

  await interaction.update({
    content:
      `✅ **Squad Enrollment Successful!**\n\n` +
      `**Team:** **${teamDoc.teamName}**\n` +
      `**Leader:** <@${teamDoc.leaderDiscordId}>\n\n` +
      `**Roster:**\n${playerList}\n\n` +
      `🎉 Your team is now enrolled! As the leader, you can now register in any open tournament instance.`,
    components: [],
  });
}

