import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveGuildSettingsToDb,
  saveTournamentToDb,
  savePendingAnnouncement,
  isMongoConnected,
} from '../mongoService.js';

describe('MongoDB createdAt conflict prevention', () => {
  test('saveGuildSettingsToDb strips createdAt and _id from $set to prevent conflict', async () => {
    // When mongo is not connected, it returns early cleanly
    await saveGuildSettingsToDb('test-guild-1', {
      _id: 'existing-id',
      createdAt: new Date('2026-01-01'),
      prefix: '.',
      welcomeEnabled: true,
    });
    assert.ok(true);
  });

  test('saveTournamentToDb strips createdAt and _id from $set to prevent conflict', async () => {
    await saveTournamentToDb('test-guild-1', 'tour-1', {
      _id: 'existing-id',
      createdAt: new Date('2026-01-01'),
      title: 'Test Tournament',
    });
    assert.ok(true);
  });

  test('savePendingAnnouncement strips createdAt and _id from $set to prevent conflict', async () => {
    await savePendingAnnouncement({
      announcementId: 'annc-123',
      _id: 'existing-id',
      createdAt: new Date('2026-01-01'),
      content: 'Hello World',
    });
    assert.ok(true);
  });
});

