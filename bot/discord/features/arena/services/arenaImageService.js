import zlib from 'node:zlib';
import {
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ARENA_STATUS, ARENA_CONSTANTS } from '../models/arenaModels.js';

// ============================================================================
// Bitmap Font (5x7) & Drawing Helpers
// ============================================================================

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
  '[': [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  ']': [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '•': [0x00, 0x00, 0x04, 0x0e, 0x04, 0x00, 0x00],
  '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
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

export function encodePngRgba(width, height, rgba) {
  const stride = width * 4;
  const rawData = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    rawData[rowStart] = 0; // Filter type 0
    rgba.copy(rawData, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(rawData, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
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

export function decodeAvatarPng(buffer) {
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

function strokeRect(rgba, width, height, x, y, w, h, color, lineWidth = 1) {
  fillRect(rgba, width, height, x, y, w, lineWidth, color);
  fillRect(rgba, width, height, x, y + h - lineWidth, w, lineWidth, color);
  fillRect(rgba, width, height, x, y, lineWidth, h, color);
  fillRect(rgba, width, height, x + w - lineWidth, y, lineWidth, h, color);
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
    const ch = str[i].toUpperCase();
    const glyph = GLYPHS_5X7[ch] || GLYPHS_5X7['?'] || [0, 0, 0, 0, 0, 0, 0];
    const cx = startX + i * (charWidth + spacing);

    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          fillRect(rgba, width, height, cx + col * scale, startY + row * scale, scale, scale, color);
        }
      }
    }
  }
}

function drawCircularAvatar(rgba, width, height, avatar, x, y, size, borderColor = [249, 115, 22, 255]) {
  const decoded = decodeAvatarPng(avatar);
  const radius = size / 2;
  const strokeWidth = 2;

  if (decoded) {
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const ox = dx + 0.5 - radius, oy = dy + 0.5 - radius;
        const distSq = ox * ox + oy * oy;
        if (distSq > radius * radius) continue;

        const di = ((y + dy) * width + x + dx) * 4;
        // Border ring
        if (distSq >= (radius - strokeWidth) * (radius - strokeWidth)) {
          rgba[di] = borderColor[0];
          rgba[di + 1] = borderColor[1];
          rgba[di + 2] = borderColor[2];
          rgba[di + 3] = borderColor[3];
          continue;
        }

        const sx = Math.min(decoded.width - 1, Math.floor((dx / size) * decoded.width));
        const sy = Math.min(decoded.height - 1, Math.floor((dy / size) * decoded.height));
        const si = (sy * decoded.width + sx) * 4;

        rgba[di] = decoded.rgba[si];
        rgba[di + 1] = decoded.rgba[si + 1];
        rgba[di + 2] = decoded.rgba[si + 2];
        rgba[di + 3] = decoded.rgba[si + 3];
      }
    }
  }
}

function drawProceduralAvatar(rgba, width, height, name, x, y, size, borderColor = [249, 115, 22, 255]) {
  const radius = size / 2;
  const strokeWidth = 2;
  const bgCol = [26, 34, 52, 255]; // Deep slate
  const textCol = [255, 255, 255, 255];

  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const ox = dx + 0.5 - radius, oy = dy + 0.5 - radius;
      const distSq = ox * ox + oy * oy;
      if (distSq > radius * radius) continue;

      const di = ((y + dy) * width + x + dx) * 4;
      if (distSq >= (radius - strokeWidth) * (radius - strokeWidth)) {
        rgba[di] = borderColor[0];
        rgba[di + 1] = borderColor[1];
        rgba[di + 2] = borderColor[2];
        rgba[di + 3] = borderColor[3];
      } else {
        rgba[di] = bgCol[0];
        rgba[di + 1] = bgCol[1];
        rgba[di + 2] = bgCol[2];
        rgba[di + 3] = bgCol[3];
      }
    }
  }

  // Draw initials
  const initials = String(name || 'P')
    .trim()
    .slice(0, 2)
    .toUpperCase();
  drawText(rgba, width, height, initials, x + radius, y + radius - 7, 2, textCol, 'center');
}

// In-memory avatar cache with 15m TTL
const avatarCache = new Map();

export async function fetchDiscordAvatarBytes(client, userId) {
  if (!userId) return null;
  const cached = avatarCache.get(userId);
  if (cached && Date.now() - cached.ts < 15 * 60 * 1000) {
    return cached.buffer;
  }

  try {
    let user = client?.users?.cache?.get(userId);
    if (!user && typeof client?.users?.fetch === 'function') {
      user = await client.users.fetch(userId).catch(() => null);
    }
    if (!user) return null;

    const avatarUrl =
      typeof user.displayAvatarURL === 'function'
        ? user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true })
        : user.avatarURL;

    if (!avatarUrl || typeof fetch !== 'function') return null;

    const res = await fetch(avatarUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 0 && buffer.length <= 1024 * 1024) {
      avatarCache.set(userId, { buffer, ts: Date.now() });
      return buffer;
    }
  } catch {
    // Graceful fallback to procedural avatar
  }

  return null;
}

// ============================================================================
// Match Card PNG Generator
// ============================================================================

export function generateMatchCardPng(match, { volunteerDisplayName = null, avatars = new Map() } = {}) {
  const width = 800;
  const height = 420;
  const rgba = Buffer.alloc(width * height * 4);

  // Palettes
  const bgMain = [11, 15, 25, 255];        // #0B0F19 (Deep Charcoal)
  const panelBg = [17, 24, 39, 255];       // #111827 (Card Background)
  const panelBorder = [31, 41, 55, 255];   // #1F2937 (1px Border)
  const accentOrange = [249, 115, 22, 255];// #F97316 (Match District Orange)
  const whiteText = [255, 255, 255, 255];  // Primary
  const slateText = [148, 163, 184, 255];  // Secondary
  const mutedText = [100, 116, 139, 255];  // Tertiary
  const badgeBg = [30, 41, 59, 255];       // #1E293B

  // 1. Base Background
  fillRect(rgba, width, height, 0, 0, width, height, bgMain);

  // 2. Top Header Accent Strip
  fillRect(rgba, width, height, 0, 0, width, 4, accentOrange);

  // Outer border
  strokeRect(rgba, width, height, 0, 0, width, height, panelBorder, 1);

  // 3. Header Section (y: 20-75)
  drawText(rgba, width, height, 'MATCH DISTRICT', 35, 22, 3, accentOrange, 'left');
  drawText(rgba, width, height, '1V1 ARENA', 35, 48, 2, slateText, 'left');

  // Match ID Header Badge
  const matchIdStr = String(match.matchId || '1V1 MATCH');
  fillRect(rgba, width, height, width - 210, 22, 175, 34, badgeBg);
  strokeRect(rgba, width, height, width - 210, 22, 175, 34, panelBorder, 1);
  drawText(rgba, width, height, matchIdStr, width - 122, 30, 3, whiteText, 'center');

  // Separator below header
  fillRect(rgba, width, height, 35, 76, width - 70, 1, panelBorder);

  // 4. Center VS Indicator (x: 355 to 445, y: 135 to 275)
  const vsX = 355;
  const vsY = 145;
  const vsW = 90;
  const vsH = 115;
  fillRect(rgba, width, height, vsX, vsY, vsW, vsH, badgeBg);
  strokeRect(rgba, width, height, vsX, vsY, vsW, vsH, accentOrange, 2);

  drawText(rgba, width, height, 'VS', vsX + vsW / 2, vsY + 22, 6, accentOrange, 'center');
  drawText(rgba, width, height, 'BGMI', vsX + vsW / 2, vsY + 72, 2, whiteText, 'center');
  drawText(rgba, width, height, 'TDM 1V1', vsX + vsW / 2, vsY + 90, 2, slateText, 'center');

  // 5. Player A Panel (Left)
  const leftX = 35;
  const cardY = 95;
  const cardW = 300;
  const cardH = 225;

  fillRect(rgba, width, height, leftX, cardY, cardW, cardH, panelBg);
  strokeRect(rgba, width, height, leftX, cardY, cardW, cardH, panelBorder, 1);
  fillRect(rgba, width, height, leftX, cardY, 4, cardH, accentOrange); // Left accent bar

  drawText(rgba, width, height, 'PLAYER A', leftX + 20, cardY + 16, 2, slateText, 'left');

  // Player A Avatar
  const avSize = 72;
  const pAAvX = leftX + 20;
  const pAAvY = cardY + 45;
  const pAAvBuf = avatars.get(String(match.playerA.discordId));
  if (pAAvBuf) {
    drawCircularAvatar(rgba, width, height, pAAvBuf, pAAvX, pAAvY, avSize, accentOrange);
  } else {
    drawProceduralAvatar(rgba, width, height, match.playerA.displayName, pAAvX, pAAvY, avSize, accentOrange);
  }

  // Player A Names
  const pAName = String(match.playerA.displayName || 'Player A').slice(0, 15);
  const pAIgn = String(match.playerA.bgmiIgn || 'Unknown').slice(0, 15);
  drawText(rgba, width, height, pAName, leftX + 105, cardY + 55, 3, whiteText, 'left');
  drawText(rgba, width, height, 'IGN:', leftX + 105, cardY + 84, 2, mutedText, 'left');
  drawText(rgba, width, height, pAIgn, leftX + 145, cardY + 84, 2, accentOrange, 'left');

  // Sub-badge: Challenger
  fillRect(rgba, width, height, leftX + 20, cardY + 145, cardW - 40, 32, badgeBg);
  strokeRect(rgba, width, height, leftX + 20, cardY + 145, cardW - 40, 32, panelBorder, 1);
  drawText(rgba, width, height, 'CHALLENGER', leftX + cardW / 2, cardY + 154, 2, slateText, 'center');

  // 6. Player B Panel (Right)
  const rightX = 465;
  fillRect(rgba, width, height, rightX, cardY, cardW, cardH, panelBg);
  strokeRect(rgba, width, height, rightX, cardY, cardW, cardH, panelBorder, 1);
  fillRect(rgba, width, height, rightX + cardW - 4, cardY, 4, cardH, accentOrange); // Right accent bar

  drawText(rgba, width, height, 'PLAYER B', rightX + cardW - 20, cardY + 16, 2, slateText, 'right');

  // Player B Avatar
  const pBAvX = rightX + cardW - 20 - avSize;
  const pBAvY = cardY + 45;
  const pBAvBuf = avatars.get(String(match.playerB.discordId));
  if (pBAvBuf) {
    drawCircularAvatar(rgba, width, height, pBAvBuf, pBAvX, pBAvY, avSize, accentOrange);
  } else {
    drawProceduralAvatar(rgba, width, height, match.playerB.displayName, pBAvX, pBAvY, avSize, accentOrange);
  }

  // Player B Names
  const pBName = String(match.playerB.displayName || 'Player B').slice(0, 15);
  const pBIgn = String(match.playerB.bgmiIgn || 'Unknown').slice(0, 15);
  drawText(rgba, width, height, pBName, rightX + cardW - 105, cardY + 55, 3, whiteText, 'right');
  drawText(rgba, width, height, pBIgn, rightX + cardW - 105, cardY + 84, 2, accentOrange, 'right');
  drawText(rgba, width, height, 'IGN:', rightX + cardW - 145 - pBIgn.length * 12, cardY + 84, 2, mutedText, 'right');

  // Sub-badge: Opponent
  fillRect(rgba, width, height, rightX + 20, cardY + 145, cardW - 40, 32, badgeBg);
  strokeRect(rgba, width, height, rightX + 20, cardY + 145, cardW - 40, 32, panelBorder, 1);
  drawText(rgba, width, height, 'OPPONENT', rightX + cardW / 2, cardY + 154, 2, slateText, 'center');

  // 7. Footer Bar (y: 345 to 405)
  const footerY = 345;
  fillRect(rgba, width, height, 0, footerY, width, height - footerY, [14, 20, 34, 255]);
  fillRect(rgba, width, height, 0, footerY, width, 1, panelBorder);

  // Status color mapping
  let statusColor = accentOrange;
  if (match.status === ARENA_STATUS.LIVE) statusColor = [34, 197, 94, 255]; // Green
  else if (match.status === ARENA_STATUS.COMPLETED) statusColor = [16, 185, 129, 255]; // Emerald
  else if (match.status === ARENA_STATUS.UNDER_REVIEW) statusColor = [239, 68, 68, 255]; // Red
  else if (match.status === ARENA_STATUS.RESULT_PENDING) statusColor = [234, 179, 8, 255]; // Yellow
  else if (match.status === ARENA_STATUS.ROOM_READY) statusColor = [168, 85, 247, 255]; // Purple

  drawText(rgba, width, height, 'STATUS:', 35, footerY + 22, 2, mutedText, 'left');
  drawText(rgba, width, height, String(match.status || 'ACTIVE'), 100, footerY + 22, 2, statusColor, 'left');

  // Volunteer on Right
  const volLabel = match.volunteerId
    ? volunteerDisplayName || `VOLUNTEER ASSIGNED`
    : 'AWAITING VOLUNTEER';
  drawText(rgba, width, height, 'OFFICIAL:', width - 280, footerY + 22, 2, mutedText, 'left');
  drawText(rgba, width, height, String(volLabel).slice(0, 20), width - 35, footerY + 22, 2, whiteText, 'right');

  return encodePngRgba(width, height, rgba);
}

// ============================================================================
// Challenge Card PNG Generator (for #available-challenges)
// ============================================================================

export function generateChallengeCardPng(challenge, { creatorDisplayName = null, creatorIgn = null, avatars = new Map(), acceptedOpponent = null } = {}) {
  const width = 800;
  const height = 420;
  const rgba = Buffer.alloc(width * height * 4);

  // Palettes
  const bgMain = [11, 15, 25, 255];
  const panelBg = [17, 24, 39, 255];
  const panelBorder = [31, 41, 55, 255];
  const accentOrange = [249, 115, 22, 255];
  const whiteText = [255, 255, 255, 255];
  const slateText = [148, 163, 184, 255];
  const mutedText = [100, 116, 139, 255];
  const badgeBg = [30, 41, 59, 255];

  // 1. Base
  fillRect(rgba, width, height, 0, 0, width, height, bgMain);
  fillRect(rgba, width, height, 0, 0, width, 4, accentOrange);
  strokeRect(rgba, width, height, 0, 0, width, height, panelBorder, 1);

  // 2. Header
  drawText(rgba, width, height, 'MATCH DISTRICT', 35, 22, 3, accentOrange, 'left');
  drawText(rgba, width, height, 'OPEN 1V1 CHALLENGE', 35, 48, 2, slateText, 'left');

  const cId = String(challenge.challengeId || 'CHALLENGE');
  fillRect(rgba, width, height, width - 210, 22, 175, 34, badgeBg);
  strokeRect(rgba, width, height, width - 210, 22, 175, 34, panelBorder, 1);
  drawText(rgba, width, height, cId, width - 122, 30, 3, whiteText, 'center');

  fillRect(rgba, width, height, 35, 76, width - 70, 1, panelBorder);

  // 3. Center VS
  const vsX = 355;
  const vsY = 145;
  const vsW = 90;
  const vsH = 115;
  fillRect(rgba, width, height, vsX, vsY, vsW, vsH, badgeBg);
  strokeRect(rgba, width, height, vsX, vsY, vsW, vsH, accentOrange, 2);
  drawText(rgba, width, height, 'VS', vsX + vsW / 2, vsY + 22, 6, accentOrange, 'center');
  drawText(rgba, width, height, 'BGMI', vsX + vsW / 2, vsY + 72, 2, whiteText, 'center');
  drawText(rgba, width, height, 'TDM 1V1', vsX + vsW / 2, vsY + 90, 2, slateText, 'center');

  // 4. Challenger Panel (Left)
  const leftX = 35;
  const cardY = 95;
  const cardW = 300;
  const cardH = 225;

  fillRect(rgba, width, height, leftX, cardY, cardW, cardH, panelBg);
  strokeRect(rgba, width, height, leftX, cardY, cardW, cardH, panelBorder, 1);
  fillRect(rgba, width, height, leftX, cardY, 4, cardH, accentOrange);

  drawText(rgba, width, height, 'CHALLENGER', leftX + 20, cardY + 16, 2, slateText, 'left');

  const avSize = 72;
  const cAvX = leftX + 20;
  const cAvY = cardY + 45;
  const cAvBuf = avatars.get(String(challenge.creatorId));
  const cName = String(creatorDisplayName || `User#${challenge.creatorId?.slice?.(-4) || '1'}`).slice(0, 15);
  const cIgnStr = String(creatorIgn || 'BGMI PLAYER').slice(0, 15);

  if (cAvBuf) {
    drawCircularAvatar(rgba, width, height, cAvBuf, cAvX, cAvY, avSize, accentOrange);
  } else {
    drawProceduralAvatar(rgba, width, height, cName, cAvX, cAvY, avSize, accentOrange);
  }

  drawText(rgba, width, height, cName, leftX + 105, cardY + 55, 3, whiteText, 'left');
  drawText(rgba, width, height, 'IGN:', leftX + 105, cardY + 84, 2, mutedText, 'left');
  drawText(rgba, width, height, cIgnStr, leftX + 145, cardY + 84, 2, accentOrange, 'left');

  fillRect(rgba, width, height, leftX + 20, cardY + 145, cardW - 40, 32, badgeBg);
  strokeRect(rgba, width, height, leftX + 20, cardY + 145, cardW - 40, 32, panelBorder, 1);
  drawText(rgba, width, height, 'READY TO FIGHT', leftX + cardW / 2, cardY + 154, 2, slateText, 'center');

  // 5. Right Panel: Opponent or Open Slot
  const rightX = 465;
  fillRect(rgba, width, height, rightX, cardY, cardW, cardH, panelBg);
  strokeRect(rgba, width, height, rightX, cardY, cardW, cardH, panelBorder, 1);

  if (acceptedOpponent) {
    // Show accepted opponent
    fillRect(rgba, width, height, rightX + cardW - 4, cardY, 4, cardH, accentOrange);
    drawText(rgba, width, height, 'OPPONENT', rightX + cardW - 20, cardY + 16, 2, slateText, 'right');

    const opAvX = rightX + cardW - 20 - avSize;
    const opAvY = cardY + 45;
    const opAvBuf = avatars.get(String(acceptedOpponent.discordId));
    const opName = String(acceptedOpponent.displayName || 'Opponent').slice(0, 15);
    const opIgn = String(acceptedOpponent.bgmiIgn || 'Unknown').slice(0, 15);

    if (opAvBuf) {
      drawCircularAvatar(rgba, width, height, opAvBuf, opAvX, opAvY, avSize, accentOrange);
    } else {
      drawProceduralAvatar(rgba, width, height, opName, opAvX, opAvY, avSize, accentOrange);
    }

    drawText(rgba, width, height, opName, rightX + cardW - 105, cardY + 55, 3, whiteText, 'right');
    drawText(rgba, width, height, opIgn, rightX + cardW - 105, cardY + 84, 2, accentOrange, 'right');

    fillRect(rgba, width, height, rightX + 20, cardY + 145, cardW - 40, 32, badgeBg);
    strokeRect(rgba, width, height, rightX + 20, cardY + 145, cardW - 40, 32, panelBorder, 1);
    drawText(rgba, width, height, 'CHALLENGE ACCEPTED', rightX + cardW / 2, cardY + 154, 2, slateText, 'center');
  } else {
    // Open Challenge Slot
    drawText(rgba, width, height, 'SLOT OPEN', rightX + cardW - 20, cardY + 16, 2, mutedText, 'right');

    // Dashed placeholder box
    strokeRect(rgba, width, height, rightX + 30, cardY + 50, cardW - 60, 80, mutedText, 1);
    drawText(rgba, width, height, 'AWAITING OPPONENT', rightX + cardW / 2, cardY + 75, 2, slateText, 'center');
    drawText(rgba, width, height, 'CLICK ACCEPT BELOW', rightX + cardW / 2, cardY + 98, 2, accentOrange, 'center');

    fillRect(rgba, width, height, rightX + 20, cardY + 145, cardW - 40, 32, badgeBg);
    strokeRect(rgba, width, height, rightX + 20, cardY + 145, cardW - 40, 32, panelBorder, 1);
    drawText(rgba, width, height, 'FREE TDM 1V1 MATCH', rightX + cardW / 2, cardY + 154, 2, slateText, 'center');
  }

  // 6. Footer
  const footerY = 345;
  fillRect(rgba, width, height, 0, footerY, width, height - footerY, [14, 20, 34, 255]);
  fillRect(rgba, width, height, 0, footerY, width, 1, panelBorder);

  const statusStr = String(challenge.status || 'OPEN');
  let statusCol = accentOrange;
  if (statusStr === 'OPEN') statusCol = [34, 197, 94, 255]; // Green
  else if (statusStr === 'ACCEPTED') statusCol = [59, 130, 246, 255]; // Blue
  else if (statusStr === 'CANCELLED' || statusStr === 'EXPIRED') statusCol = [107, 114, 128, 255]; // Gray

  drawText(rgba, width, height, 'STATUS:', 35, footerY + 22, 2, mutedText, 'left');
  drawText(rgba, width, height, statusStr, 105, footerY + 22, 2, statusCol, 'left');

  const expiryInfo = challenge.expiresAt
    ? `EXPIRES: ${new Date(challenge.expiresAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
    : 'NO TIMEOUT';
  drawText(rgba, width, height, expiryInfo, width - 35, footerY + 22, 2, slateText, 'right');

  return encodePngRgba(width, height, rgba);
}

// ============================================================================
// Message Payload Builders with Dynamic Images
// ============================================================================

export async function buildMatchCardPayload(match, volunteerDisplayName = null, options = {}) {
  const avatars = new Map();
  const client = options.client || options.guild?.client;

  if (client) {
    if (match.playerA?.discordId) {
      const bufA = await fetchDiscordAvatarBytes(client, match.playerA.discordId);
      if (bufA) avatars.set(match.playerA.discordId, bufA);
    }
    if (match.playerB?.discordId) {
      const bufB = await fetchDiscordAvatarBytes(client, match.playerB.discordId);
      if (bufB) avatars.set(match.playerB.discordId, bufB);
    }
  }

  const pngBuffer = generateMatchCardPng(match, {
    volunteerDisplayName,
    avatars,
  });

  const filename = `match-${String(match.matchId).toLowerCase()}.png`;
  const attachment = new AttachmentBuilder(pngBuffer, { name: filename });

  const embed = new EmbedBuilder()
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setImage(`attachment://${filename}`);

  // Build match control buttons
  const buttons = [];
  if (match.status === ARENA_STATUS.VOLUNTEER_ASSIGNED || match.status === ARENA_STATUS.ROOM_READY) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:submit_room:${match.matchId}`)
        .setLabel(match.roomId ? 'Edit Room Details' : 'Submit Room Details')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (match.status === ARENA_STATUS.ROOM_READY) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:start_match:${match.matchId}`)
        .setLabel('Start Match')
        .setStyle(ButtonStyle.Success)
    );
  }

  if (match.status === ARENA_STATUS.LIVE) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:submit_winner:${match.matchId}`)
        .setLabel('Submit Winner')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (
    match.status === ARENA_STATUS.VOLUNTEER_ASSIGNED ||
    match.status === ARENA_STATUS.ROOM_READY
  ) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`arena:release_match:${match.matchId}`)
        .setLabel('Release Match')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const components = buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons)] : [];

  return {
    embeds: [embed],
    files: [attachment],
    components,
  };
}

export async function buildChallengeCardPayload(challenge, creatorDisplayName = null, options = {}) {
  const avatars = new Map();
  const client = options.client || options.guild?.client;

  if (client && challenge.creatorId) {
    const buf = await fetchDiscordAvatarBytes(client, challenge.creatorId);
    if (buf) avatars.set(challenge.creatorId, buf);
  }

  const pngBuffer = generateChallengeCardPng(challenge, {
    creatorDisplayName,
    creatorIgn: options.creatorIgn || null,
    avatars,
    acceptedOpponent: options.acceptedOpponent || null,
  });

  const filename = `challenge-${String(challenge.challengeId).toLowerCase()}.png`;
  const attachment = new AttachmentBuilder(pngBuffer, { name: filename });

  const embed = new EmbedBuilder()
    .setColor(ARENA_CONSTANTS.ORANGE_COLOR)
    .setImage(`attachment://${filename}`);

  const components = [];
  if (challenge.status === ARENA_STATUS.OPEN) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`arena:accept_challenge:${challenge.challengeId}`)
        .setLabel('Accept Challenge')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`arena:cancel_challenge:${challenge.challengeId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
    );
    components.push(row);
  }

  return {
    embeds: [embed],
    files: [attachment],
    components,
  };
}

