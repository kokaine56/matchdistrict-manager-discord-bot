import test from 'node:test';
import assert from 'node:assert/strict';

test('Discord Bot - Organiser command argument parsing (.organiser, .organiser setup, .organiser link)', () => {
  const parseOrganiserCommand = (args) => {
    const firstArg = (args[0] || '').trim();
    const sub = firstArg.toLowerCase();
    const argStr = args.join(' ').trim();

    let codeCandidate = null;
    if ((sub === 'link' || sub === 'setup') && args[1]) {
      codeCandidate = args.slice(1).join(' ').trim();
    } else if (firstArg && (firstArg.toUpperCase().startsWith('MD-ORG-') || /^MD-ORG/i.test(firstArg))) {
      codeCandidate = firstArg;
    } else if (argStr && /^MD-ORG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(argStr)) {
      codeCandidate = argStr;
    } else if (firstArg && firstArg.length >= 10 && firstArg.includes('-') && !['unlink', 'status', 'help', 'setup'].includes(sub)) {
      codeCandidate = firstArg;
    }

    return { sub, codeCandidate };
  };

  // Direct code
  assert.equal(parseOrganiserCommand(['MD-ORG-ABCD-EFGH-1234']).codeCandidate, 'MD-ORG-ABCD-EFGH-1234');
  // .organiser setup <CODE>
  assert.equal(parseOrganiserCommand(['setup', 'MD-ORG-ABCD-EFGH-1234']).codeCandidate, 'MD-ORG-ABCD-EFGH-1234');
  // .organiser link <CODE>
  assert.equal(parseOrganiserCommand(['link', 'MD-ORG-ABCD-EFGH-1234']).codeCandidate, 'MD-ORG-ABCD-EFGH-1234');
  // .organiser setup (no code)
  assert.equal(parseOrganiserCommand(['setup']).codeCandidate, null);
  assert.equal(parseOrganiserCommand(['setup']).sub, 'setup');
  // .organiser unlink
  assert.equal(parseOrganiserCommand(['unlink']).sub, 'unlink');
  assert.equal(parseOrganiserCommand(['unlink']).codeCandidate, null);
  // .organiser status
  assert.equal(parseOrganiserCommand(['status']).sub, 'status');
  assert.equal(parseOrganiserCommand(['status']).codeCandidate, null);
});

test('Discord Bot - In-memory cache invalidation on previous guild replacement', () => {
  const guildSettingsCache = {
    '111111111111111111': {
      organiserLink: {
        guildId: '111111111111111111',
        organiserId: 'org_test_1',
        status: 'linked',
      },
    },
    '222222222222222222': {},
  };

  // Simulate new guild verification response with previousGuildId
  const newGuildId = '222222222222222222';
  const previousGuildId = '111111111111111111';

  // Apply replacement logic
  if (previousGuildId && guildSettingsCache[previousGuildId]) {
    delete guildSettingsCache[previousGuildId].organiserLink;
  }
  guildSettingsCache[newGuildId].organiserLink = {
    guildId: newGuildId,
    organiserId: 'org_test_1',
    status: 'linked',
  };

  assert.equal(guildSettingsCache['111111111111111111'].organiserLink, undefined);
  assert.ok(guildSettingsCache['222222222222222222'].organiserLink);
  assert.equal(guildSettingsCache['222222222222222222'].organiserLink.status, 'linked');
});

test('Discord Bot - MongoDB atomicity simulation for 1-to-1 active link', async () => {
  const mockDbLinks = [
    { guildId: 'g_1', organiserId: 'org_1', status: 'linked' },
  ];

  const saveMockOrganiserLink = async (guildId, orgId) => {
    // 1. Atomically disconnect previous server for this organiser
    for (const doc of mockDbLinks) {
      if (doc.organiserId === orgId && doc.status === 'linked' && doc.guildId !== guildId) {
        doc.status = 'replaced';
      }
    }

    // 2. Upsert new server
    const existing = mockDbLinks.find(d => d.guildId === guildId);
    if (existing) {
      existing.organiserId = orgId;
      existing.status = 'linked';
    } else {
      mockDbLinks.push({ guildId, organiserId: orgId, status: 'linked' });
    }
  };

  // Org 1 links g_2
  await saveMockOrganiserLink('g_2', 'org_1');

  // Check g_1 is replaced
  const g1 = mockDbLinks.find(d => d.guildId === 'g_1');
  assert.equal(g1.status, 'replaced');

  // Check g_2 is linked
  const g2 = mockDbLinks.find(d => d.guildId === 'g_2');
  assert.equal(g2.status, 'linked');

  // Active links for org_1 is strictly 1
  const activeLinks = mockDbLinks.filter(d => d.organiserId === 'org_1' && d.status === 'linked');
  assert.equal(activeLinks.length, 1);
});

