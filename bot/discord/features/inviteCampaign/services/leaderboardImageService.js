import zlib from 'node:zlib';

/**
 * Parses and normalizes reward configuration input into a sorted array of
 * `{ position: number, amount: number }` objects.
 *
 * Accepts:
 * - Array of `{ position, amount }` objects: `[{ position: 1, amount: 50 }, ...]`
 * - Array of numbers: `[50, 20, 10, 5, 2]`
 * - Object map: `{ 1: 50, 2: 20, 3: 10 }` or `{ '#1': '₹50', '#2': '₹20' }`
 * - String: `"50, 20, 10, 5, 2"` or `"#1=50, #2=20, #3=10"` or multi-line `"#1 = ₹50\n#2 = ₹20"`
 *
 * @param {any} input
 * @returns {{ valid: boolean, rewards: Array<{ position: number, amount: number }>, error?: string }}
 */
export function parseAndValidateRewards(input) {
  if (input === undefined || input === null || input === '') {
    return { valid: true, rewards: [] };
  }

  const byPosition = new Map();

  const setPosAmount = (posRaw, amtRaw) => {
    const pos = Number(String(posRaw).replace(/^#/, '').trim());
    if (!Number.isInteger(pos) || pos < 1 || pos > 100) {
      return `Invalid reward position "${posRaw}". Position must be an integer between 1 and 100.`;
    }
    const cleanedAmt = String(amtRaw ?? '')
      .replace(/₹|rs\.?|inr|,/gi, '')
      .trim();
    if (cleanedAmt === '' || !/^-?\d+(\.\d+)?$/.test(cleanedAmt)) {
      return `Invalid reward amount "${amtRaw}" for position #${pos}.`;
    }
    const amount = Number(cleanedAmt);
    if (!Number.isFinite(amount) || amount < 0) {
      return `Reward amount for position #${pos} cannot be negative (received ${amtRaw}).`;
    }
    byPosition.set(pos, Math.round(amount * 100) / 100);
    return null;
  };

  if (Array.isArray(input)) {
    for (let idx = 0; idx < input.length; idx++) {
      const item = input[idx];
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const err = setPosAmount(item.position ?? item.rank ?? idx + 1, item.amount ?? item.reward ?? 0);
        if (err) return { valid: false, rewards: [], error: err };
      } else {
        const err = setPosAmount(idx + 1, item);
        if (err) return { valid: false, rewards: [], error: err };
      }
    }
  } else if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      const err = setPosAmount(k, v);
      if (err) return { valid: false, rewards: [], error: err };
    }
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed || /^(none|0|-)$/i.test(trimmed)) {
      return { valid: true, rewards: [] };
    }

    // Split by newline, comma, or semicolon
    const tokens = trimmed
      .split(/[\n,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const kvMatch = token.match(/^#?(\d+)\s*(?:=|:|-|->)\s*(.+)$/);
      if (kvMatch) {
        const err = setPosAmount(kvMatch[1], kvMatch[2]);
        if (err) return { valid: false, rewards: [], error: err };
      } else {
        const err = setPosAmount(i + 1, token);
        if (err) return { valid: false, rewards: [], error: err };
      }
    }
  } else {
    return { valid: false, rewards: [], error: 'Unsupported reward configuration format.' };
  }

  const rewards = [...byPosition.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, amount]) => ({ position, amount }));

  return { valid: true, rewards };
}

/**
 * Formats a numeric winning amount with the Indian Rupee symbol (e.g. `₹50`).
 *
 * @param {number|null|undefined} amount
 * @returns {string}
 */
export function formatRupeeAmount(amount) {
  const num = Number(amount ?? 0);
  if (!Number.isFinite(num) || num <= 0) return '₹0';
  return Number.isInteger(num) ? `₹${num}` : `₹${num.toFixed(2)}`;
}

/**
 * Looks up the configured winning amount for a 1-based leaderboard rank.
 *
 * @param {Array<{ position: number, amount: number }>} rewards
 * @param {number} rank
 * @returns {number}
 */
export function getRewardAmountForRank(rewards, rank) {
  if (!Array.isArray(rewards) || rewards.length === 0) return 0;
  const match = rewards.find((r) => Number(r.position) === Number(rank));
  if (!match) return 0;
  return Math.max(0, Number(match.amount || 0));
}

/**
 * Formats a human-readable summary of a campaign's reward distribution (e.g. `#1 = ₹50, #2 = ₹20, #3 = ₹10`).
 *
 * @param {Array<{ position: number, amount: number }>} rewards
 * @returns {string}
 */
export function formatRewardsSummary(rewards) {
  if (!Array.isArray(rewards) || rewards.length === 0) {
    return 'None configured (₹0)';
  }
  return rewards
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((r) => `#${r.position} = ${formatRupeeAmount(r.amount)}`)
    .join(', ');
}

/**
 * Computes the sorted, threshold-filtered leaderboard rows for a campaign.
 *
 * Deterministic Tie-Breaking Rule:
 * 1. Higher valid invite count (`successfulInvites`) ranks first.
 * 2. Earlier timestamp of reaching threshold / latest valid invite (`eligibleAt` ascending) ranks first.
 * 3. Lexical comparison of Discord `userId` (`String(a.userId).localeCompare(String(b.userId))`) breaks any remaining tie.
 *
 * @param {object} campaign
 * @param {Array<object>} participants
 * @param {import('discord.js').Guild|null} [guild]
 * @returns {Array<{
 *   rank: number,
 *   userId: string,
 *   username: string,
 *   invites: number,
 *   winningAmount: number,
 *   winningAmountFormatted: string
 * }>}
 */
export function computeCampaignLeaderboardRows(campaign, participants, guild = null) {
  if (!campaign || !Array.isArray(participants)) return [];

  const threshold = Math.max(
    1,
    Number(campaign.minInviteThreshold ?? campaign.requiredInvites ?? 1)
  );
  const rewards = Array.isArray(campaign.rewards) ? campaign.rewards : [];

  const qualified = participants.filter((p) => {
    if (!p || p.disqualified || p.inviterLeftServer) return false;
    const count = Number(p.successfulInvites || 0);
    return count >= threshold;
  });

  qualified.sort((a, b) => {
    const countDiff = Number(b.successfulInvites || 0) - Number(a.successfulInvites || 0);
    if (countDiff !== 0) return countDiff;

    const aTime = a.eligibleAt ? new Date(a.eligibleAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.eligibleAt ? new Date(b.eligibleAt).getTime() : Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;

    return String(a.userId || '').localeCompare(String(b.userId || ''));
  });

  return qualified.map((p, index) => {
    const rank = index + 1;
    const uid = String(p.userId);
    const cachedMember = guild?.members?.cache?.get?.(uid);
    const rawName =
      p.username ||
      cachedMember?.displayName ||
      cachedMember?.user?.globalName ||
      cachedMember?.user?.username ||
      `User#${uid.slice(-4)}`;

    const winningAmount = getRewardAmountForRank(rewards, rank);

    return {
      rank,
      userId: uid,
      username: String(rawName),
      invites: Number(p.successfulInvites || 0),
      winningAmount,
      winningAmountFormatted: formatRupeeAmount(winningAmount),
    };
  });
}

// ============================================================================
// Pure Node.js PNG Table Renderer (Zero External Dependencies)
// ============================================================================

// 5x7 pixel bitmap font for uppercase/lowercase/digits/punctuation + custom 5x7 Indian Rupee '₹' glyph
const GLYPHS_5X7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x00, 0x00, 0x04],
  '"': [0x0a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00],
  '#': [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
  '$': [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  "'": [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '*': [0x00, 0x04, 0x15, 0x0e, 0x15, 0x04, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ';': [0x00, 0x04, 0x00, 0x00, 0x04, 0x04, 0x08],
  '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  '@': [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '₹': [0x1f, 0x02, 0x1f, 0x06, 0x08, 0x04, 0x03],
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);

  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

/**
 * Encodes an RGBA pixel buffer into a standard PNG image Buffer.
 */
function encodePngRgba(width, height, rgba) {
  const stride = width * 4;
  const rawData = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    rawData[rowStart] = 0; // Filter type 0 (None)
    rgba.copy(rawData, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(rawData, { level: 6 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth 8
  ihdr[9] = 6; // Color type 6 (RGBA)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function decodeAvatarPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || ![2, 6].includes(colorType) || data[12] !== 0) return null;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : 3;
  if (!width || !height || width > 512 || height > 512 || !idat.length) return null;
  const stride = width * channels;
  const packed = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[sourceOffset++];
    for (let x = 0; x < stride; x++) {
      const value = packed[sourceOffset++];
      const left = x >= channels ? raw[y * stride + x - channels] : 0;
      const above = y ? raw[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? raw[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      } else if (filter !== 0) return null;
      raw[y * stride + x] = (value + predictor) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
    rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
  }
  return { width, height, rgba };
}

function drawCircularAvatar(rgba, width, height, avatar, x, y, size) {
  const decoded = decodeAvatarPng(avatar);
  if (!decoded) return;
  const radius = size / 2;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const ox = dx + 0.5 - radius, oy = dy + 0.5 - radius;
      if (ox * ox + oy * oy > radius * radius) continue;
      const sx = Math.min(decoded.width - 1, Math.floor((dx / size) * decoded.width));
      const sy = Math.min(decoded.height - 1, Math.floor((dy / size) * decoded.height));
      const si = (sy * decoded.width + sx) * 4;
      const di = ((y + dy) * width + x + dx) * 4;
      rgba[di] = decoded.rgba[si]; rgba[di + 1] = decoded.rgba[si + 1];
      rgba[di + 2] = decoded.rgba[si + 2]; rgba[di + 3] = decoded.rgba[si + 3];
    }
  }
}

function fillRect(rgba, width, height, x, y, w, h, color) {
  const [r, g, b, a = 255] = color;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.floor(x + w));
  const y1 = Math.min(height, Math.floor(y + h));

  for (let py = y0; py < y1; py++) {
    let idx = (py * width + x0) * 4;
    for (let px = x0; px < x1; px++) {
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = a;
      idx += 4;
    }
  }
}

function drawText(rgba, width, height, text, x, y, scale, color, align = 'left') {
  const str = String(text ?? '');
  if (!str) return;
  const charWidth = 5 * scale;
  const spacing = 1 * scale;
  const totalWidth = str.length * (charWidth + spacing) - spacing;

  let startX = Math.floor(x);
  if (align === 'center') {
    startX = Math.floor(x - totalWidth / 2);
  } else if (align === 'right') {
    startX = Math.floor(x - totalWidth);
  }
  const startY = Math.floor(y);

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const upper = ch === '₹' ? '₹' : ch.toUpperCase();
    const glyph = GLYPHS_5X7[upper] || GLYPHS_5X7['?'];
    const cx = startX + i * (charWidth + spacing);

    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          fillRect(
            rgba,
            width,
            height,
            cx + col * scale,
            startY + row * scale,
            scale,
            scale,
            color
          );
        }
      }
    }
  }
}

function truncateText(text, maxChars) {
  const clean = String(text ?? '')
    .replace(/[^\x20-\x7E₹]/g, '')
    .trim() || 'User';
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, Math.max(1, maxChars - 3)) + '...';
}

/**
 * Generates a clean, mobile-friendly PNG image containing the campaign leaderboard table:
 * Columns: Rank | Username | Invites | Winning Amount
 *
 * Automatically scales image height according to the number of qualified users.
 *
 * @param {object} campaign
 * @param {Array<object>} rows - Output of computeCampaignLeaderboardRows
 * @returns {{
 *   buffer: Buffer,
 *   fileName: string,
 *   width: number,
 *   height: number,
 *   rows: Array<object>,
 *   title: string,
 *   statusText: string,
 *   minInviteThreshold: number
 * }}
 */
export function generateLeaderboardPng(campaign, rows = [], avatars = new Map()) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const width = 960;
  const headerHeight = 150;
  const tableHeaderHeight = 72;
  const rowHeight = 72;
  const footerHeight = 50;
  const displayRowCount = Math.max(1, safeRows.length);
  const height = headerHeight + tableHeaderHeight + displayRowCount * rowHeight + footerHeight;

  const rgba = Buffer.alloc(width * height * 4);

  // Colors
  const bgDark = [13, 19, 33, 255];
  const headerBg = [21, 31, 52, 255];
  const tableHeaderBg = [30, 41, 69, 255];
  const rowEvenBg = [18, 26, 44, 255];
  const rowOddBg = [24, 35, 58, 255];
  const borderColor = [45, 62, 95, 255];
  const whiteText = [241, 245, 249, 255];
  const mutedText = [148, 163, 184, 255];
  const greenMoney = [46, 204, 113, 255];

  // Top 3 highlight accents
  const goldAccent = [245, 158, 11, 255];
  const silverAccent = [148, 163, 184, 255];
  const bronzeAccent = [217, 119, 6, 255];

  // 1. Background fill
  fillRect(rgba, width, height, 0, 0, width, height, bgDark);

  // 2. Top Header Banner
  fillRect(rgba, width, height, 16, 14, width - 32, headerHeight - 20, headerBg);
  fillRect(rgba, width, height, 16, 14, width - 32, 3, [56, 189, 248, 255]);

  const title = truncateText(campaign?.name || 'INVITE & EARN LEADERBOARD', 23);
  drawText(rgba, width, height, title, 34, 36, 4, whiteText, 'left');

  const rawStatus = String(campaign?.status || 'Active');
  const isEnded = rawStatus.toLowerCase() === 'ended';
  const statusText = isEnded ? 'EVENT ENDED' : rawStatus.toUpperCase();
  const minInviteThreshold = Math.max(
    1,
    Number(campaign?.minInviteThreshold ?? campaign?.requiredInvites ?? 1)
  );

  drawText(
    rgba,
    width,
    height,
    `MIN INVITES: ${minInviteThreshold}`,
    34,
    100,
    3,
    mutedText,
    'left'
  );

  // Status badge on top right
  const badgeColor = isEnded
    ? [237, 66, 69, 255]
    : rawStatus.toLowerCase() === 'active'
      ? [46, 204, 113, 255]
      : [243, 156, 18, 255];
  const badgeWidth = Math.max(144, statusText.length * 18 + 36);
  fillRect(rgba, width, height, width - 32 - badgeWidth, 52, badgeWidth, 46, badgeColor);
  drawText(
    rgba,
    width,
    height,
    statusText,
    width - 32 - badgeWidth / 2,
    69,
    3,
    [15, 23, 42, 255],
    'center'
  );

  // 3. Table Header Row
  const tableX = 16;
  const tableW = width - 32;
  const tableY = headerHeight;
  fillRect(rgba, width, height, tableX, tableY, tableW, tableHeaderHeight, tableHeaderBg);
  fillRect(rgba, width, height, tableX, tableY + tableHeaderHeight - 2, tableW, 2, borderColor);

  // Column X positions:
  // Col 1: Rank (16..145)
  // Col 2: Username and avatar (145..570)
  // Col 3: Invites (570..730)
  // Col 4: Winning Amount (730..944)
  const colRankX = 80;
  const colInvitesX = 650;
  const colAmountX = 930;

  drawText(rgba, width, height, 'RANK', colRankX, tableY + 27, 3, mutedText, 'center');
  drawText(rgba, width, height, 'USERNAME', 220, tableY + 27, 3, mutedText, 'left');
  drawText(rgba, width, height, 'INVITES', colInvitesX, tableY + 27, 3, mutedText, 'center');
  drawText(rgba, width, height, 'WINNING', colAmountX, tableY + 16, 3, mutedText, 'right');
  drawText(rgba, width, height, 'AMOUNT', colAmountX, tableY + 43, 3, mutedText, 'right');

  // Column vertical dividers in header
  fillRect(rgba, width, height, 145, tableY, 1, tableHeaderHeight + displayRowCount * rowHeight, borderColor);
  fillRect(rgba, width, height, 570, tableY, 1, tableHeaderHeight + displayRowCount * rowHeight, borderColor);
  fillRect(rgba, width, height, 730, tableY, 1, tableHeaderHeight + displayRowCount * rowHeight, borderColor);

  // 4. Table Body Rows
  if (safeRows.length === 0) {
    const ry = tableY + tableHeaderHeight;
    fillRect(rgba, width, height, tableX, ry, tableW, rowHeight, rowEvenBg);
    drawText(
      rgba,
      width,
      height,
      `NO PARTICIPANTS WITH ${minInviteThreshold}+ INVITES YET`,
      width / 2,
      ry + 25,
      3,
      mutedText,
      'center'
    );
  } else {
    for (let i = 0; i < safeRows.length; i++) {
      const row = safeRows[i];
      const ry = tableY + tableHeaderHeight + i * rowHeight;
      const bg = i % 2 === 0 ? rowEvenBg : rowOddBg;
      fillRect(rgba, width, height, tableX, ry, tableW, rowHeight, bg);

      // Bottom row border
      fillRect(rgba, width, height, tableX, ry + rowHeight - 1, tableW, 1, borderColor);

      // Highlight top 3 positions with left accent bar and colored rank text
      let rankColor = whiteText;
      if (row.rank === 1) {
        fillRect(rgba, width, height, tableX, ry, 5, rowHeight - 1, goldAccent);
        rankColor = goldAccent;
      } else if (row.rank === 2) {
        fillRect(rgba, width, height, tableX, ry, 5, rowHeight - 1, silverAccent);
        rankColor = silverAccent;
      } else if (row.rank === 3) {
        fillRect(rgba, width, height, tableX, ry, 5, rowHeight - 1, bronzeAccent);
        rankColor = bronzeAccent;
      }

      drawText(rgba, width, height, `#${row.rank}`, colRankX, ry + 22, 4, rankColor, 'center');
      const avatarSize = 56;
      const avatarX = 155;
      const avatarY = ry + Math.floor((rowHeight - avatarSize) / 2);
      const avatarBuffer = avatars instanceof Map ? avatars.get(String(row.userId)) : avatars?.[String(row.userId)];
      if (avatarBuffer) drawCircularAvatar(rgba, width, height, avatarBuffer, avatarX, avatarY, avatarSize);
      drawText(
        rgba,
        width,
        height,
        truncateText(row.username, 14),
        220,
        ry + 22,
        4,
        whiteText,
        'left'
      );
      drawText(
        rgba,
        width,
        height,
        String(row.invites),
        colInvitesX,
        ry + 22,
        4,
        whiteText,
        'center'
      );
      drawText(
        rgba,
        width,
        height,
        row.winningAmountFormatted || formatRupeeAmount(row.winningAmount),
        colAmountX,
        ry + 25,
        3,
        row.winningAmount > 0 ? greenMoney : mutedText,
        'right'
      );
    }
  }

  // Outer table border
  const totalTableH = tableHeaderHeight + displayRowCount * rowHeight;
  fillRect(rgba, width, height, tableX, tableY, tableW, 1, borderColor);
  fillRect(rgba, width, height, tableX, tableY + totalTableH, tableW, 1, borderColor);
  fillRect(rgba, width, height, tableX, tableY, 1, totalTableH, borderColor);
  fillRect(rgba, width, height, tableX + tableW - 1, tableY, 1, totalTableH, borderColor);

  // Footer
  drawText(
    rgba,
    width,
    height,
    'MATCH DISTRICT INVITE & EARN LEADERBOARD',
    width / 2,
    height - 30,
    2,
    mutedText,
    'center'
  );

  const buffer = encodePngRgba(width, height, rgba);

  return {
    buffer,
    fileName: 'leaderboard.png',
    width,
    height,
    rows: safeRows,
    title,
    statusText,
    minInviteThreshold,
  };
}
