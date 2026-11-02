import test from 'node:test';
import assert from 'node:assert/strict';

test('Verification Channel - Message pattern validation', () => {
  const isVerificationCode = (content) => /^[A-Za-z0-9]{8}$/.test((content || '').trim());

  // Strictly 8 characters alphanumeric
  assert.equal(isVerificationCode('ABCD2345'), true);
  assert.equal(isVerificationCode('7XYZ9999'), true);
  assert.equal(isVerificationCode('   ABCD2345   '), true); // trims whitespace
  
  // Invalid formats
  assert.equal(isVerificationCode('ABCD234'), false); // 7 chars
  assert.equal(isVerificationCode('ABCD23459'), false); // 9 chars
  assert.equal(isVerificationCode('ABCD-234'), false); // contains hyphen
  assert.equal(isVerificationCode('Hello bot'), false); // chat message
  assert.equal(isVerificationCode(''), false);
  assert.equal(isVerificationCode(null), false);
});

test('Verification Rate Limiting - 5 attempts per user per 10 minutes', () => {
  const verificationFailedAttempts = new Map();
  const checkRateLimit = (guildId, userId) => {
    const rateKey = `${guildId}:${userId}`;
    const now = Date.now();
    const tenMinutesAgo = now - 10 * 60 * 1000;
    const attempts = (verificationFailedAttempts.get(rateKey) || []).filter(t => t > tenMinutesAgo);
    if (attempts.length >= 5) {
      return { allowed: false, attemptsCount: attempts.length };
    }
    attempts.push(now);
    verificationFailedAttempts.set(rateKey, attempts);
    return { allowed: true, attemptsCount: attempts.length };
  };

  const guildId = 'guild-test';
  const userId = 'user-test';

  // 1 to 5 attempts should succeed
  for (let i = 1; i <= 5; i++) {
    const result = checkRateLimit(guildId, userId);
    assert.equal(result.allowed, true, `Attempt ${i} should be allowed`);
  }

  // 6th attempt onwards should be rejected
  const sixth = checkRateLimit(guildId, userId);
  assert.equal(sixth.allowed, false, '6th attempt must be rejected');
  assert.equal(sixth.attemptsCount, 5);

  // Different user should still be allowed
  const otherUser = checkRateLimit(guildId, 'user-other');
  assert.equal(otherUser.allowed, true, 'Different user should not be throttled');
});

test('Teammates Needed Calculation - Squad, Duo, Solo', () => {
  const getTeammatesNeeded = (matchType) => {
    const fmt = (matchType || 'squad').toLowerCase();
    let teamSize = 4;
    if (fmt.includes('duo') || fmt === '2') teamSize = 2;
    else if (fmt.includes('solo') || fmt === '1') teamSize = 1;
    else teamSize = 4;
    return Math.max(0, teamSize - 1);
  };

  assert.equal(getTeammatesNeeded('squad'), 3);
  assert.equal(getTeammatesNeeded('duo'), 1);
  assert.equal(getTeammatesNeeded('solo'), 0);
  assert.equal(getTeammatesNeeded('1'), 0);
  assert.equal(getTeammatesNeeded('2'), 1);
  assert.equal(getTeammatesNeeded('4'), 3);
});

test('Teammate Selection Validation Rules', () => {
  const validateTeammates = (captainId, selectedIds, neededCount, memberLookup) => {
    if (selectedIds.length !== neededCount) {
      return { valid: false, error: `Must select exactly ${neededCount} teammates` };
    }
    if (selectedIds.includes(captainId)) {
      return { valid: false, error: 'Cannot select self' };
    }
    for (const uid of selectedIds) {
      const member = memberLookup[uid];
      if (!member) {
        return { valid: false, error: `User ${uid} not in server` };
      }
      if (member.isBot) {
        return { valid: false, error: `User ${uid} is a bot` };
      }
    }
    return { valid: true };
  };

  const members = {
    'tm-1': { isBot: false },
    'tm-2': { isBot: false },
    'tm-3': { isBot: false },
    'bot-1': { isBot: true },
  };

  // Valid Squad selection
  assert.deepEqual(validateTeammates('capt-1', ['tm-1', 'tm-2', 'tm-3'], 3, members), { valid: true });

  // Self selected
  assert.deepEqual(validateTeammates('capt-1', ['capt-1', 'tm-2', 'tm-3'], 3, members), {
    valid: false,
    error: 'Cannot select self'
  });

  // Bot selected
  assert.deepEqual(validateTeammates('capt-1', ['tm-1', 'bot-1', 'tm-3'], 3, members), {
    valid: false,
    error: 'User bot-1 is a bot'
  });

  // Missing member
  assert.deepEqual(validateTeammates('capt-1', ['tm-1', 'nonexistent', 'tm-3'], 3, members), {
    valid: false,
    error: 'User nonexistent not in server'
  });

  // Incorrect count
  assert.deepEqual(validateTeammates('capt-1', ['tm-1', 'tm-2'], 3, members), {
    valid: false,
    error: 'Must select exactly 3 teammates'
  });
});

