import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  getArenaPlayer,
  getArenaPlayerByUid,
  upsertArenaPlayer,
  getArenaMatch,
  ARENA_STATUS,
} from '../models/arenaModels.js';
import {
  handleCreateChallenge,
  handleCancelChallenge,
  handleAcceptChallenge,
  validatePlayerForAction,
} from '../services/arenaChallengeService.js';
import {
  handleClaimMatch,
  handleLeaveMatch,
  handleReleaseMatch,
} from '../services/arenaVolunteerService.js';
import {
  submitRoomDetails,
  startMatch,
  initiateWinnerSubmission,
  handleReportRoomCredentials,
} from '../services/arenaMatchService.js';
import {
  handlePlayerConfirmation,
} from '../services/arenaResultService.js';
import {
  handleFileDispute,
} from '../services/arenaDisputeService.js';

export async function handleArenaInteraction(interaction) {
  if (!interaction || !interaction.customId?.startsWith('arena:')) return false;

  const customId = interaction.customId;

  try {
    // 1. Button: Create Challenge
    if (interaction.isButton() && customId === 'arena:create_challenge') {
      const player = await getArenaPlayer(interaction.user.id);
      if (!player || !player.bgmiIgn || !player.bgmiUid) {
        return showBgmiRegistrationModal(interaction, 'create', 'none');
      }

      await interaction.deferReply({ ephemeral: true });
      const res = await handleCreateChallenge(interaction.guild, interaction.member);
      if (!res.valid || !res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not create challenge.' });
      }
      return interaction.editReply({
        content: `⚔️ **Challenge Created!** Your open challenge **${res.challenge.challengeId}** is now listed in <#${res.challenge.discordChannelId}>.`,
      });
    }

    // 2. Button: Update BGMI Details
    if (interaction.isButton() && customId === 'arena:update_bgmi') {
      const player = await getArenaPlayer(interaction.user.id);
      if (player?.activeMatchId) {
        return interaction.reply({
          content: '❌ **Action Prohibited:** You cannot update your BGMI details while participating in an active match.',
          ephemeral: true,
        });
      }
      return showBgmiRegistrationModal(interaction, 'update', 'none', player);
    }

    // 3. Modal Submit: BGMI Registration / Update
    if (interaction.isModalSubmit() && customId.startsWith('arena:modal_bgmi:')) {
      const [, , action, payload] = customId.split(':');
      const ign = interaction.fields.getTextInputValue('bgmi_ign')?.trim();
      const rawUid = interaction.fields.getTextInputValue('bgmi_uid')?.trim();

      if (!ign || !rawUid) {
        return interaction.reply({
          content: '❌ Both In-Game Name and Numeric UID are required.',
          ephemeral: true,
        });
      }

      if (!/^\d+$/.test(rawUid)) {
        return interaction.reply({
          content: '❌ **Invalid UID:** BGMI UID must contain digits only.',
          ephemeral: true,
        });
      }

      // Check unique UID constraint
      const existing = await getArenaPlayerByUid(rawUid);
      if (existing && existing.discordId !== interaction.user.id) {
        return interaction.reply({
          content:
            '❌ **UID Already Registered:** This BGMI UID is already registered to another Discord account.\n' +
            'If this is an error or your account was previously linked elsewhere, please contact support in **#challenge-support**.',
          ephemeral: true,
        });
      }

      await upsertArenaPlayer(interaction.user.id, {
        displayName: interaction.member?.displayName || interaction.user.username,
        bgmiIgn: ign,
        bgmiUid: rawUid,
      });

      if (action === 'create') {
        await interaction.deferReply({ ephemeral: true });
        const res = await handleCreateChallenge(interaction.guild, interaction.member);
        if (!res.valid || !res.ok) {
          return interaction.editReply({ content: res.error || '❌ Could not create challenge.' });
        }
        return interaction.editReply({
          content: `✅ **Details Saved!** Your open challenge **${res.challenge.challengeId}** has been created in <#${res.challenge.discordChannelId}>.`,
        });
      }

      if (action === 'accept' && payload && payload !== 'none') {
        await interaction.deferReply({ ephemeral: true });
        const res = await handleAcceptChallenge(interaction.guild, interaction.member, payload, interaction.client);
        if (!res.ok) {
          return interaction.editReply({ content: res.error || '❌ Could not accept challenge.' });
        }
        return interaction.editReply({
          content: `✅ **Details Saved & Challenge Accepted!** Your match **${res.match.matchId}** is ready in <#${res.match.matchChannelId}>.`,
        });
      }

      return interaction.reply({
        content: `✅ **BGMI Details Saved:** In-Game Name set to **${ign}**, UID set to \`${rawUid}\`.`,
        ephemeral: true,
      });
    }

    // 4. Button: Accept Challenge
    if (interaction.isButton() && customId.startsWith('arena:accept_challenge:')) {
      const challengeId = customId.split(':')[2];
      const player = await getArenaPlayer(interaction.user.id);
      if (!player || !player.bgmiIgn || !player.bgmiUid) {
        return showBgmiRegistrationModal(interaction, 'accept', challengeId);
      }

      await interaction.deferReply({ ephemeral: true });
      const res = await handleAcceptChallenge(interaction.guild, interaction.member, challengeId, interaction.client);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not accept challenge.' });
      }
      return interaction.editReply({
        content: `⚔️ **Challenge Accepted!** Match **${res.match.matchId}** has been created. Please proceed to <#${res.match.matchChannelId}>.`,
      });
    }

    // 5. Button: Cancel Challenge
    if (interaction.isButton() && customId.startsWith('arena:cancel_challenge:')) {
      const challengeId = customId.split(':')[2];
      await interaction.deferReply({ ephemeral: true });
      const res = await handleCancelChallenge(interaction.guild, interaction.member, challengeId);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not cancel challenge.' });
      }
      return interaction.editReply({
        content: `🗑️ **Challenge Cancelled:** Your challenge **${challengeId}** has been cancelled.`,
      });
    }

    // 6. Button: Volunteer Claim Match
    if (interaction.isButton() && customId.startsWith('arena:claim_match:')) {
      const matchId = customId.split(':')[2];
      await interaction.deferReply({ ephemeral: true });
      const res = await handleClaimMatch(interaction.guild, interaction.member, matchId);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not claim match.' });
      }
      return interaction.editReply({
        content: `📋 **Match Claimed!** You are now officiating match **${matchId}**. Proceed to <#${res.match.matchChannelId}> to submit room credentials.`,
      });
    }

    // 7. Button: Room Maker Leave Match (with Confirmation)
    if (interaction.isButton() && customId.startsWith('arena:leave_match:')) {
      const matchId = customId.split(':')[2];
      const match = await getArenaMatch(matchId);
      if (!match) return interaction.reply({ content: '❌ Match not found.', ephemeral: true });
      if (match.volunteerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ You are not the assigned Room Maker for this match.', ephemeral: true });
      }
      if (match.status === ARENA_STATUS.LIVE) {
        return interaction.reply({
          content: '❌ Cannot leave a match that is already LIVE. Contact an administrator to reassign live matches.',
          ephemeral: true,
        });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`arena:confirm_leave:${matchId}`)
          .setLabel('Confirm Leave Match')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`arena:cancel_leave:${matchId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      return interaction.reply({
        content:
          `⚠️ **Leave Match Confirmation:** Are you sure you want to leave match **${matchId}**?\n` +
          `• Your channel access will be revoked.\n` +
          `• Any submitted room credentials will be cleared.\n` +
          `• The match will be returned to the Room Maker queue.`,
        components: [row],
        ephemeral: true,
      });
    }

    if (interaction.isButton() && customId.startsWith('arena:confirm_leave:')) {
      const matchId = customId.split(':')[2];
      await interaction.deferReply({ ephemeral: true });
      const res = await handleLeaveMatch(interaction.guild, interaction.member, matchId);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not leave match.' });
      }
      return interaction.editReply({
        content: `✅ **Match Left:** You have left match **${matchId}**. It has been returned to the Room Maker queue.`,
      });
    }

    if (interaction.isButton() && customId.startsWith('arena:cancel_leave:')) {
      return interaction.update({
        content: 'Action cancelled. You remain the assigned Room Maker.',
        components: [],
      });
    }

    // Legacy Button: Volunteer Release Match
    if (interaction.isButton() && customId.startsWith('arena:release_match:')) {
      const matchId = customId.split(':')[2];
      await interaction.deferReply({ ephemeral: true });
      const res = await handleLeaveMatch(interaction.guild, interaction.member, matchId);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not release match.' });
      }
      return interaction.editReply({
        content: `ℹ️ **Match Left:** Match **${matchId}** has been returned to the Room Maker queue.`,
      });
    }

    // 7b. Button: Report Incorrect Room ID/Password
    if (interaction.isButton() && customId.startsWith('arena:report_room_issue:')) {
      const matchId = customId.split(':')[2];
      const match = await getArenaMatch(matchId);
      if (!match) return interaction.reply({ content: '❌ Match not found.', ephemeral: true });

      const isPlayerA = match.playerA.discordId === interaction.user.id;
      const isPlayerB = match.playerB.discordId === interaction.user.id;
      if (!isPlayerA && !isPlayerB) {
        return interaction.reply({
          content: '❌ Only Player A or Player B can report incorrect room credentials.',
          ephemeral: true,
        });
      }

      if (match.status === ARENA_STATUS.LIVE) {
        return interaction.reply({
          content: '❌ Match is already LIVE. Cannot report credentials after start.',
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`arena:modal_report_room:${matchId}`)
        .setTitle(`Report Room Credentials Issue`);

      const issueInput = new TextInputBuilder()
        .setCustomId('issue_type')
        .setLabel("Issue: 'ROOM_ID', 'PASSWORD', or 'BOTH'")
        .setStyle(TextInputStyle.Short)
        .setValue('BOTH')
        .setMaxLength(20)
        .setRequired(true);

      const notesInput = new TextInputBuilder()
        .setCustomId('issue_notes')
        .setLabel('Problem Details (Optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe what happened when attempting to join with these credentials...')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(issueInput),
        new ActionRowBuilder().addComponents(notesInput)
      );

      return interaction.showModal(modal);
    }

    // 7c. Modal Submit: Report Room Issue
    if (interaction.isModalSubmit() && customId.startsWith('arena:modal_report_room:')) {
      const matchId = customId.split(':')[2];
      const rawType = (interaction.fields.getTextInputValue('issue_type') || '').trim().toUpperCase();
      let issueType = 'BOTH';
      if (rawType.includes('ID') || rawType === 'ROOM_ID') issueType = 'ROOM_ID';
      else if (rawType.includes('PASS') || rawType === 'PASSWORD') issueType = 'PASSWORD';

      await interaction.deferReply({ ephemeral: true });
      const res = await handleReportRoomCredentials(interaction.guild, interaction.member, matchId, issueType);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not report credential issue.' });
      }
      return interaction.editReply({
        content: `⚠️ **Report Submitted:** You reported that the **${issueType}** is incorrect. The Room Maker has been notified to provide corrected credentials.`,
      });
    }

    // 8. Button: Submit Room Details
    if (interaction.isButton() && customId.startsWith('arena:submit_room:')) {
      const matchId = customId.split(':')[2];
      const match = await getArenaMatch(matchId);
      if (!match) {
        return interaction.reply({ content: '❌ Match not found.', ephemeral: true });
      }
      if (match.volunteerId !== interaction.user.id) {
        return interaction.reply({
          content: '❌ Only the assigned volunteer can submit room credentials.',
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`arena:modal_room:${matchId}`)
        .setTitle(`Room Details: ${matchId}`);

      const roomIdInput = new TextInputBuilder()
        .setCustomId('room_id')
        .setLabel('BGMI Room ID')
        .setStyle(TextInputStyle.Short)
        .setValue(match.roomId || '')
        .setRequired(true);

      const roomPasswordInput = new TextInputBuilder()
        .setCustomId('room_password')
        .setLabel('Room Password')
        .setStyle(TextInputStyle.Short)
        .setValue(match.roomPassword || '')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(roomIdInput),
        new ActionRowBuilder().addComponents(roomPasswordInput)
      );

      return interaction.showModal(modal);
    }

    // 9. Modal Submit: Room Details
    if (interaction.isModalSubmit() && customId.startsWith('arena:modal_room:')) {
      const matchId = customId.split(':')[2];
      const roomId = interaction.fields.getTextInputValue('room_id')?.trim();
      const roomPassword = interaction.fields.getTextInputValue('room_password')?.trim();

      await interaction.deferReply({ ephemeral: true });
      const res = await submitRoomDetails(interaction.guild, interaction.member, matchId, roomId, roomPassword);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Failed to submit room details.' });
      }
      return interaction.editReply({
        content: `🔐 **Room Credentials Published!** Both players have been notified in the match channel.`,
      });
    }

    // 10. Button: Start Match
    if (interaction.isButton() && customId.startsWith('arena:start_match:')) {
      const matchId = customId.split(':')[2];
      await interaction.deferReply({ ephemeral: true });
      const res = await startMatch(interaction.guild, interaction.member, matchId);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not start match.' });
      }
      return interaction.editReply({
        content: `⚔️ **Match Started!** Match is now marked as LIVE.`,
      });
    }

    // 11. Button: Submit Winner
    if (interaction.isButton() && customId.startsWith('arena:submit_winner:')) {
      const matchId = customId.split(':')[2];
      const match = await getArenaMatch(matchId);
      if (!match) {
        return interaction.reply({ content: '❌ Match not found.', ephemeral: true });
      }
      if (match.volunteerId !== interaction.user.id) {
        return interaction.reply({
          content: '❌ Only the assigned volunteer can submit the winner.',
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`arena:modal_winner:${matchId}`)
        .setTitle(`Submit Winner: ${matchId}`);

      const winnerInput = new TextInputBuilder()
        .setCustomId('winner_side')
        .setLabel("Winner: Enter 'A' or 'B'")
        .setPlaceholder(`A: ${match.playerA.displayName} | B: ${match.playerB.displayName}`.slice(0, 100))
        .setMaxLength(1)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(winnerInput));
      return interaction.showModal(modal);
    }

    // 12. Modal Submit: Winner Submission
    if (interaction.isModalSubmit() && customId.startsWith('arena:modal_winner:')) {
      const matchId = customId.split(':')[2];
      const rawSide = interaction.fields.getTextInputValue('winner_side')?.trim().toUpperCase();

      if (rawSide !== 'A' && rawSide !== 'B') {
        return interaction.reply({
          content: '❌ Please enter either `A` or `B` to designate the winner.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const res = await initiateWinnerSubmission(interaction.guild, interaction.member, matchId, rawSide);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Failed to process winner selection.' });
      }
      return interaction.editReply({
        content: `📸 **Winner Selection Recorded (${res.pendingWinner.displayName}).** Now upload the end-game screenshot as a message attachment in the match channel within 5 minutes.`,
      });
    }

    // 13. Button: Confirm Result
    if (interaction.isButton() && customId.startsWith('arena:confirm_result:')) {
      const matchId = customId.split(':')[2];
      await interaction.deferReply({ ephemeral: true });
      const res = await handlePlayerConfirmation(interaction.guild, interaction.member, matchId);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Confirmation failed.' });
      }
      if (res.waitingForOpponent) {
        return interaction.editReply({ content: res.message });
      }
      return interaction.editReply({
        content: `🏁 **Result Verified!** Both players confirmed. The match has been completed.`,
      });
    }

    // 14. Button: Dispute Result
    if (interaction.isButton() && customId.startsWith('arena:dispute_result:')) {
      const matchId = customId.split(':')[2];
      const modal = new ModalBuilder()
        .setCustomId(`arena:modal_dispute:${matchId}`)
        .setTitle(`Dispute Match: ${matchId}`);

      const reasonInput = new TextInputBuilder()
        .setCustomId('dispute_reason')
        .setLabel('Reason for Dispute')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe the issue (e.g. incorrect score, player disconnected, rule violation)...')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal);
    }

    // 15. Modal Submit: Dispute Reason
    if (interaction.isModalSubmit() && customId.startsWith('arena:modal_dispute:')) {
      const matchId = customId.split(':')[2];
      const reason = interaction.fields.getTextInputValue('dispute_reason')?.trim();

      await interaction.deferReply({ ephemeral: true });
      const res = await handleFileDispute(interaction.guild, interaction.member, matchId, reason);
      if (!res.ok) {
        return interaction.editReply({ content: res.error || '❌ Could not file dispute.' });
      }
      return interaction.editReply({
        content: `⚠️ **Dispute Filed:** Match **${matchId}** has been flagged for administrator review in #arena-evidence.`,
      });
    }

    return false;
  } catch (err) {
    console.error(`[Arena] ⚠️ Error handling interaction ${customId}:`, err);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: `❌ **An unexpected error occurred:** ${err.message}`,
        ephemeral: true,
      }).catch(() => {});
    } else {
      await interaction.editReply({
        content: `❌ **An unexpected error occurred:** ${err.message}`,
      }).catch(() => {});
    }
    return true;
  }
}

function showBgmiRegistrationModal(interaction, action = 'create', payload = 'none', player = null) {
  const modal = new ModalBuilder()
    .setCustomId(`arena:modal_bgmi:${action}:${payload}`)
    .setTitle('Register BGMI Details');

  const ignInput = new TextInputBuilder()
    .setCustomId('bgmi_ign')
    .setLabel('BGMI In-Game Name (IGN)')
    .setStyle(TextInputStyle.Short)
    .setValue(player?.bgmiIgn || '')
    .setPlaceholder('Enter your exact BGMI IGN')
    .setRequired(true);

  const uidInput = new TextInputBuilder()
    .setCustomId('bgmi_uid')
    .setLabel('BGMI UID (Numeric Only)')
    .setStyle(TextInputStyle.Short)
    .setValue(player?.bgmiUid || '')
    .setPlaceholder('e.g. 5123456789 (digits only)')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ignInput),
    new ActionRowBuilder().addComponents(uidInput)
  );

  return interaction.showModal(modal);
}
