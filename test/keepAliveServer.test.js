import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHealthServer, getHealthMetrics, gracefulShutdown } from '../index.js';

// Helper to make HTTP requests to the test server
function makeRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

test('Keep-Alive Web Server - Suite', async (t) => {
  // Start the server on a dynamic port (0) for testing
  const server = startHealthServer(0);
  assert.ok(server, 'Server should be initialized');

  // Wait for the server to be listening
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }

  const port = server.address().port;
  assert.ok(port > 0, 'Server should have an assigned port');

  await t.test('GET / returns HTML status page with all required metadata', async () => {
    const res = await makeRequest(port, '/');

    assert.equal(res.statusCode, 200, 'HTTP status must be 200');
    assert.equal(res.headers['cache-control'], 'no-store', 'Cache-Control must be no-store');
    assert.ok(res.headers['content-type'].includes('text/html'), 'Content-Type must be text/html');

    // Required content checks
    assert.ok(res.body.includes('<meta http-equiv="refresh" content="30">'), 'Page must have meta refresh of 30 seconds');
    assert.ok(res.body.includes('Online'), 'Page must show Online status');
    assert.ok(res.body.includes('Discord Client'), 'Page must indicate Discord client readiness');
    assert.ok(res.body.includes('Uptime'), 'Page must show uptime');
    assert.ok(res.body.includes('Last Ping'), 'Page must show last ping info');
    assert.ok(res.body.includes('IST'), 'Last ping time must display in IST');
    assert.ok(res.body.includes('ago)'), 'Last ping time must show relative time with "x minutes ago"');
    assert.ok(res.body.includes('Total Pings'), 'Page must display total pings counter');
    assert.ok(res.body.includes('matchdistrict-manager-discord-bot'), 'Page must include the bot name');

    // Safety checks: no secrets, tokens or private data
    assert.equal(res.body.includes(process.env.DISCORD_BOT_TOKEN || 'MTU2NDY'), false, 'Never leak bot tokens');
    assert.equal(res.body.includes(process.env.MATCHDISTRICT_BOT_SECRET || '897def'), false, 'Never leak bot secret');
    assert.equal(res.body.includes(process.env.MONGODB_URI || 'mongodb+srv'), false, 'Never leak MongoDB URI');
  });

  await t.test('GET / with Accept: application/json returns structured JSON', async () => {
    const res = await makeRequest(port, '/', {
      headers: { 'Accept': 'application/json' }
    });

    assert.equal(res.statusCode, 200, 'HTTP status must be 200');
    assert.equal(res.headers['cache-control'], 'no-store', 'Cache-Control must be no-store');
    assert.ok(res.headers['content-type'].includes('application/json'), 'Content-Type must be application/json');

    const json = JSON.parse(res.body);
    assert.equal(json.status, 'ok', 'Status must be ok');
    assert.equal(json.service, 'matchdistrict-manager-discord-bot', 'Service name must match');
    assert.equal(typeof json.discordReady, 'boolean', 'discordReady must be boolean');
    assert.equal(typeof json.uptimeSeconds, 'number', 'uptimeSeconds must be number');
    assert.ok(json.uptimeSeconds >= 0, 'uptimeSeconds must be non-negative');
    assert.ok(!isNaN(Date.parse(json.lastPing)), 'lastPing must be a valid ISO timestamp');
  });

  await t.test('HEAD / returns 200 with headers and no body', async () => {
    const res = await makeRequest(port, '/', { method: 'HEAD' });

    assert.equal(res.statusCode, 200, 'HEAD must return 200');
    assert.equal(res.headers['cache-control'], 'no-store', 'Cache-Control must be no-store');
    assert.equal(res.body, '', 'HEAD must not return a body');
  });

  await t.test('POST / returns 405 Method Not Allowed', async () => {
    const res = await makeRequest(port, '/', { method: 'POST' });

    assert.equal(res.statusCode, 405, 'POST to / should return 405');
    assert.equal(res.headers['cache-control'], 'no-store', 'Cache-Control must be no-store');
  });

  await t.test('/ping accepts GET, HEAD, POST, OPTIONS and returns 200', async () => {
    // GET /ping
    const getRes = await makeRequest(port, '/ping');
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.body, 'pong', '/ping should return pong');
    assert.equal(getRes.headers['cache-control'], 'no-store');

    // GET /ping with Accept: application/json
    const jsonRes = await makeRequest(port, '/ping', {
      headers: { 'Accept': 'application/json' }
    });
    assert.equal(jsonRes.statusCode, 200);
    const parsed = JSON.parse(jsonRes.body);
    assert.equal(parsed.status, 'ok');

    // POST /ping
    const postRes = await makeRequest(port, '/ping', { method: 'POST' });
    assert.equal(postRes.statusCode, 200);
    assert.equal(postRes.body, 'pong');

    // HEAD /ping
    const headRes = await makeRequest(port, '/ping', { method: 'HEAD' });
    assert.equal(headRes.statusCode, 200);
    assert.equal(headRes.body, '');

    // OPTIONS /ping
    const optRes = await makeRequest(port, '/ping', { method: 'OPTIONS' });
    assert.equal(optRes.statusCode, 200);
    assert.ok(optRes.headers['allow']?.includes('GET'));
  });

  await t.test('/health accepts GET, HEAD, POST, OPTIONS and returns JSON', async () => {
    // GET /health
    const getRes = await makeRequest(port, '/health');
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.headers['cache-control'], 'no-store');
    const getJson = JSON.parse(getRes.body);
    assert.equal(getJson.status, 'ok');
    assert.equal(getJson.service, 'matchdistrict-manager-discord-bot');

    // POST /health
    const postRes = await makeRequest(port, '/health', { method: 'POST' });
    assert.equal(postRes.statusCode, 200);
    const postJson = JSON.parse(postRes.body);
    assert.equal(postJson.status, 'ok');

    // HEAD /health
    const headRes = await makeRequest(port, '/health', { method: 'HEAD' });
    assert.equal(headRes.statusCode, 200);
    assert.equal(headRes.body, '');

    // OPTIONS /health
    const optRes = await makeRequest(port, '/health', { method: 'OPTIONS' });
    assert.equal(optRes.statusCode, 200);
  });

  await t.test('Ping counter and lastPing update in memory on every request', async () => {
    const before = getHealthMetrics();
    const countBefore = before.pingCount;

    await makeRequest(port, '/ping');
    await makeRequest(port, '/health');
    await makeRequest(port, '/');

    const after = getHealthMetrics();
    assert.equal(after.pingCount, countBefore + 3, 'Ping counter must increment by 3');
    assert.ok(after.lastPingTime > 0, 'lastPingTime must be recorded');
  });

  await t.test('Unknown routes return a normal 404', async () => {
    const res = await makeRequest(port, '/nonexistent-route-xyz');
    assert.equal(res.statusCode, 404, 'Unknown routes must return 404');
    assert.equal(res.headers['cache-control'], 'no-store');
    const json = JSON.parse(res.body);
    assert.equal(json.error, 'NOT_FOUND');
  });

  await t.test('Rate limiting permits Render user-agent and handles excessive pings', async () => {
    // Render health check probe should always pass
    const renderRes = await makeRequest(port, '/health', {
      headers: { 'User-Agent': 'Render/1.0 (healthcheck)' }
    });
    assert.equal(renderRes.statusCode, 200);

    // External IP rate limit verification
    const spoofedIp = '198.51.100.42';
    let blocked = false;

    // Send 125 requests from this simulated IP
    for (let i = 0; i < 125; i++) {
      const res = await makeRequest(port, '/ping', {
        headers: { 'x-forwarded-for': spoofedIp }
      });
      if (res.statusCode === 429) {
        blocked = true;
        assert.equal(res.headers['retry-after'], '60');
        assert.equal(res.headers['cache-control'], 'no-store');
        break;
      }
    }

    assert.ok(blocked, 'Requests exceeding 120 per minute from same IP must be rate limited to 429');
  });

  await t.test('Idempotency: Repeated calls to startHealthServer return the same instance and prevent EADDRINUSE', () => {
    const s1 = startHealthServer(0);
    const s2 = startHealthServer(0);
    assert.strictEqual(s1, s2, 'Repeated calls must return the identical server instance without attempting to bind port twice');
  });

  // Clean up server
  await new Promise(resolve => server.close(resolve));
});

