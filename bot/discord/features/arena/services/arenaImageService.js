import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import {
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ARENA_STATUS, ARENA_CONSTANTS, getArenaPlayer } from '../models/arenaModels.js';

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
    let avatarUrl =
      typeof user?.displayAvatarURL === 'function'
        ? user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true })
        : user?.avatarURL || null;
    let defaultAvatarUrl = null;
    try {
      defaultAvatarUrl = `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
    } catch {
      // IDs from unit fixtures may not be Discord snowflakes.
    }
    const avatarUrls = [...new Set([avatarUrl, defaultAvatarUrl].filter(Boolean))];
    if (typeof fetch !== 'function') return null;

    for (const url of avatarUrls) {
      if (process.env.ARENA_IMAGE_DIAGNOSTICS === '1') {
        console.info(`[ArenaImage] avatar ${userId}: ${url}`);
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 0 && buffer.length <= 1024 * 1024) {
          avatarCache.set(userId, { buffer, ts: Date.now() });
          return buffer;
        }
      } catch {
        // Try the deterministic Discord default avatar next.
      }
    }
  } catch {
    // Graceful fallback to procedural avatar
  }

  return null;
}

export async function fetchMatchAvatars(client, match) {
  const avatars = new Map();
  if (!client || !match) return avatars;
  const pAId = match.playerA?.discordId;
  const pBId = match.playerB?.discordId;
  const promises = [];
  if (pAId) {
    promises.push(
      fetchDiscordAvatarBytes(client, pAId).then((buf) => {
        if (buf) avatars.set(pAId, buf);
      })
    );
  }
  if (pBId) {
    promises.push(
      fetchDiscordAvatarBytes(client, pBId).then((buf) => {
        if (buf) avatars.set(pBId, buf);
      })
    );
  }
  await Promise.all(promises);
  return avatars;
}

export async function fetchChallengeAvatars(client, challenge, acceptedOpponent = null) {
  const avatars = new Map();
  if (!client || !challenge) return avatars;
  const promises = [];
  if (challenge.creatorId) {
    promises.push(
      fetchDiscordAvatarBytes(client, challenge.creatorId).then((buf) => {
        if (buf) avatars.set(challenge.creatorId, buf);
      })
    );
  }
  if (acceptedOpponent?.discordId) {
    promises.push(
      fetchDiscordAvatarBytes(client, acceptedOpponent.discordId).then((buf) => {
        if (buf) avatars.set(acceptedOpponent.discordId, buf);
      })
    );
  }
  await Promise.all(promises);
  return avatars;
}

// ============================================================================
// SVG Rendering Engine (Devanagari, Avatars & Layout Integrity)
// ============================================================================

function escapeXml(unsafe) {
  if (unsafe === undefined || unsafe === null) return '';
  return String(unsafe).replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

function truncate(str, max = 16) {
  if (!str) return '';
  const chars = Array.from(String(str).trim());
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max - 1).join('') + '…';
}

function getAvatarDataUri(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    if (val.startsWith('data:image/')) return val;
    return `data:image/png;base64,${val}`;
  }
  if (Buffer.isBuffer(val)) {
    let mime = 'png';
    if (val.length >= 3 && val[0] === 0xff && val[1] === 0xd8 && val[2] === 0xff) {
      mime = 'jpeg';
    } else if (val.length >= 12 && val.subarray(0, 4).toString() === 'RIFF' && val.subarray(8, 12).toString() === 'WEBP') {
      mime = 'webp';
    }
    return `data:image/${mime};base64,${val.toString('base64')}`;
  }
  return null;
}

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const REQUIRED_FONT_FILES = [
  'NotoSans-Regular.ttf',
  'NotoSans-Bold.ttf',
  'NotoSansDevanagari-Regular.ttf',
  'NotoSansDevanagari-Bold.ttf',
];

let resolvedFontFiles = null;

export function getArenaFontFiles() {
  if (resolvedFontFiles) return resolvedFontFiles;
  const files = [];
  const missing = [];
  for (const name of REQUIRED_FONT_FILES) {
    const full = path.join(FONT_DIR, name);
    if (fs.existsSync(full) && fs.statSync(full).size > 10000) files.push(full);
    else missing.push(name);
  }
  if (missing.length > 0) {
    // Never silently render blank text: fail loudly so a broken deploy is visible.
    throw new Error(`[ArenaImage] Missing bundled font files in ${FONT_DIR}: ${missing.join(', ')}`);
  }
  resolvedFontFiles = files;
  return files;
}

function countVisibleTextPixels(pixels, bgSample) {
  // Counts pixels clearly brighter than the dark card background.
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 150 || pixels[i + 1] > 150 || pixels[i + 2] > 150) lit++;
  }
  return lit;
}

/**
 * Renders SVG to PNG using ONLY bundled fonts (no dependence on host system fonts, so
 * Linux/Docker production hosts render text identically to a developer machine).
 * @param {string} svgString
 * @param {{ expectedTexts?: string[], label?: string }} [opts] expected strings must appear in the SVG
 */
export function renderSvgToPng(svgString, { expectedTexts = [], label = 'card' } = {}) {
  // Validation 1: expected text must really be present in the SVG sent to the renderer.
  const decoded = String(svgString);
  const missingText = expectedTexts.filter((t) => t && !decoded.includes(String(t)));
  if (missingText.length > 0) {
    console.error(`[ArenaImage] ❌ ${label}: expected text missing from SVG: ${JSON.stringify(missingText)}`);
    throw new Error(`Arena image SVG missing expected text: ${missingText.join(', ')}`);
  }

  let rendered;
  try {
    const resvg = new Resvg(svgString, {
      font: {
        loadSystemFonts: false,
        fontFiles: getArenaFontFiles(),
        defaultFontFamily: 'Noto Sans',
        sansSerifFamily: 'Noto Sans',
        serifFamily: 'Noto Sans',
      },
    });
    rendered = resvg.render();
  } catch (err) {
    console.error(`[ArenaImage] ❌ ${label}: render failed: ${err.message}`);
    throw err;
  }

  const png = rendered.asPng();

  // Validation 2: valid PNG with the expected size.
  const sig = png.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') {
    throw new Error(`[ArenaImage] ${label}: output is not a valid PNG`);
  }

  // Validation 3: text pixels exist (guards against a silent blank render).
  if (expectedTexts.length > 0) {
    const lit = countVisibleTextPixels(rendered.pixels);
    if (lit < 500) {
      console.error(`[ArenaImage] ❌ ${label}: rendered image has no visible text (brightPixels=${lit}). Font loading failed.`);
      throw new Error('Arena image rendered without visible text');
    }
    if (process.env.ARENA_IMAGE_DIAGNOSTICS) {
      console.info(`[ArenaImage] ${label}: ok bytes=${png.length} brightPixels=${lit}`);
    }
  }

  return png;
}

// ============================================================================
// Match Card PNG Generator
// ============================================================================

export function generateMatchCardPng(match, { volunteerDisplayName = null, avatars = new Map() } = {}) {
  const pA = match?.playerA || {};
  const pB = match?.playerB || {};

  const nameA = escapeXml(truncate(pA.displayName || 'Player A', 16));
  const ignA = escapeXml(truncate(pA.bgmiIgn || 'Unknown', 16));
  const uidA = escapeXml(truncate(pA.bgmiUid || 'N/A', 15));

  const nameB = escapeXml(truncate(pB.displayName || 'Player B', 16));
  const ignB = escapeXml(truncate(pB.bgmiIgn || 'Unknown', 16));
  const uidB = escapeXml(truncate(pB.bgmiUid || 'N/A', 15));

  const matchIdStr = escapeXml(String(match?.matchId || '1V1 MATCH'));

  // Avatars
  const avatarUriA = getAvatarDataUri(avatars.get(String(pA.discordId)));
  const initialA = escapeXml((pA.displayName || 'A').trim().slice(0, 1).toUpperCase() || 'A');

  const avatarUriB = getAvatarDataUri(avatars.get(String(pB.discordId)));
  const initialB = escapeXml((pB.displayName || 'B').trim().slice(0, 1).toUpperCase() || 'B');

  const avatarSvgA = avatarUriA
    ? `<defs><clipPath id="avatar-clip-a"><circle cx="92" cy="175" r="36" /></clipPath></defs>
       <circle cx="92" cy="175" r="36" fill="#1E293B" />
       <image href="${avatarUriA}" x="56" y="139" width="72" height="72" clip-path="url(#avatar-clip-a)" preserveAspectRatio="xMidYMid slice" />
       <circle cx="92" cy="175" r="36" fill="none" stroke="#F97316" stroke-width="2" />`
    : `<circle cx="92" cy="175" r="36" fill="#1E293B" stroke="#F97316" stroke-width="2" />
       <text x="92" y="184" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="22" font-weight="bold" fill="#F97316">${initialA}</text>`;

  const avatarSvgB = avatarUriB
    ? `<defs><clipPath id="avatar-clip-b"><circle cx="517" cy="175" r="36" /></clipPath></defs>
       <circle cx="517" cy="175" r="36" fill="#1E293B" />
       <image href="${avatarUriB}" x="481" y="139" width="72" height="72" clip-path="url(#avatar-clip-b)" preserveAspectRatio="xMidYMid slice" />
       <circle cx="517" cy="175" r="36" fill="none" stroke="#F97316" stroke-width="2" />`
    : `<circle cx="517" cy="175" r="36" fill="#1E293B" stroke="#F97316" stroke-width="2" />
       <text x="517" y="184" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="22" font-weight="bold" fill="#F97316">${initialB}</text>`;

  // Status Styling & Label Formatting
  const statusRaw = String(match?.status || ARENA_STATUS.WAITING_FOR_VOLUNTEER);
  let statusText = statusRaw.replace(/_/g, ' ');
  let statusBg = '#2E1B0F';
  let statusBorder = '#F97316';
  let statusColor = '#F97316';

  if (statusRaw === ARENA_STATUS.LIVE) {
    statusText = 'MATCH LIVE';
    statusBg = '#052E16';
    statusBorder = '#22C55E';
    statusColor = '#22C55E';
  } else if (statusRaw === ARENA_STATUS.COMPLETED || statusRaw === ARENA_STATUS.CONFIRMED) {
    statusText = statusRaw === ARENA_STATUS.CONFIRMED ? 'CONFIRMED' : 'COMPLETED';
    statusBg = '#064E3B';
    statusBorder = '#10B981';
    statusColor = '#10B981';
  } else if (statusRaw === ARENA_STATUS.UNDER_REVIEW) {
    statusText = 'UNDER REVIEW';
    statusBg = '#450A0A';
    statusBorder = '#EF4444';
    statusColor = '#EF4444';
  } else if (statusRaw === ARENA_STATUS.RESULT_PENDING) {
    statusText = 'RESULT PENDING';
    statusBg = '#422006';
    statusBorder = '#EAB308';
    statusColor = '#EAB308';
  } else if (statusRaw === ARENA_STATUS.ROOM_READY) {
    statusText = 'ROOM READY';
    statusBg = '#3B0764';
    statusBorder = '#A855F7';
    statusColor = '#C084FC';
  } else if (statusRaw === ARENA_STATUS.VOLUNTEER_ASSIGNED) {
    statusText = 'VOLUNTEER ASSIGNED';
    statusBg = '#172554';
    statusBorder = '#3B82F6';
    statusColor = '#60A5FA';
  } else if (statusRaw === ARENA_STATUS.WAITING_FOR_VOLUNTEER) {
    statusText = 'WAITING FOR VOLUNTEER';
    statusBg = '#2E1B0F';
    statusBorder = '#F97316';
    statusColor = '#F97316';
  } else if (statusRaw === ARENA_STATUS.CANCELLED || statusRaw === ARENA_STATUS.EXPIRED) {
    statusText = statusRaw;
    statusBg = '#1F2937';
    statusBorder = '#4B5563';
    statusColor = '#9CA3AF';
  }

  const badgeWidth = Math.max(100, Math.min(260, statusText.length * 8.5 + 24));

  // Volunteer Info
  const volLabel = match?.volunteerId
    ? volunteerDisplayName || `VOLUNTEER ASSIGNED`
    : 'AWAITING VOLUNTEER';
  const volColor = match?.volunteerId ? '#FFFFFF' : '#F59E0B';

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
  <!-- Base Background -->
  <rect width="800" height="420" fill="#0B0F19"/>
  <rect x="0" y="0" width="800" height="4" fill="#F97316"/>
  <rect x="0" y="0" width="800" height="420" fill="none" stroke="#1F2937" stroke-width="1"/>

  <!-- Header -->
  <text x="35" y="42" font-family="Noto Sans, Noto Sans Devanagari" font-size="20" font-weight="bold" fill="#F97316" letter-spacing="1">MATCH DISTRICT</text>
  <text x="35" y="62" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="600" fill="#94A3B8" letter-spacing="1">MATCH DETAILS</text>

  <!-- Match ID Badge -->
  <rect x="615" y="24" width="150" height="34" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
  <text x="690" y="47" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="15" font-weight="bold" fill="#FFFFFF">${matchIdStr}</text>
  <line x1="35" y1="78" x2="765" y2="78" stroke="#1F2937" stroke-width="1"/>

  <!-- Center VS Indicator -->
  <rect x="355" y="145" width="90" height="120" rx="10" fill="#1E293B" stroke="#F97316" stroke-width="2"/>
  <text x="400" y="200" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="34" font-weight="900" fill="#F97316">VS</text>
  <text x="400" y="228" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="bold" fill="#FFFFFF">BGMI</text>
  <text x="400" y="248" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="11" font-weight="600" fill="#94A3B8">TDM 1V1</text>

  <!-- Player A Panel (Left) -->
  <rect x="35" y="95" width="305" height="235" rx="10" fill="#111827" stroke="#1F2937" stroke-width="1"/>
  <rect x="35" y="95" width="5" height="235" rx="2" fill="#F97316"/>
  <text x="52" y="122" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8" letter-spacing="1">PLAYER A • CHALLENGER</text>

  ${avatarSvgA}

  <text x="142" y="152" font-family="Noto Sans, Noto Sans Devanagari" font-size="18" font-weight="bold" fill="#FFFFFF">${nameA}</text>
  <text x="142" y="178" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="600" fill="#94A3B8">IGN: <tspan fill="#F97316" font-weight="bold">${ignA}</tspan></text>
  <text x="142" y="202" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="500" fill="#64748B">UID: <tspan fill="#CBD5E1">${uidA}</tspan></text>

  <rect x="50" y="280" width="275" height="32" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
  <text x="187" y="301" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8">CHALLENGER</text>

  <!-- Player B Panel (Right) -->
  <rect x="460" y="95" width="305" height="235" rx="10" fill="#111827" stroke="#1F2937" stroke-width="1"/>
  <rect x="760" y="95" width="5" height="235" rx="2" fill="#F97316"/>
  <text x="477" y="122" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8" letter-spacing="1">PLAYER B • OPPONENT</text>

  ${avatarSvgB}

  <text x="567" y="152" font-family="Noto Sans, Noto Sans Devanagari" font-size="18" font-weight="bold" fill="#FFFFFF">${nameB}</text>
  <text x="567" y="178" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="600" fill="#94A3B8">IGN: <tspan fill="#F97316" font-weight="bold">${ignB}</tspan></text>
  <text x="567" y="202" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="500" fill="#64748B">UID: <tspan fill="#CBD5E1">${uidB}</tspan></text>

  <rect x="475" y="280" width="275" height="32" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
  <text x="612" y="301" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8">OPPONENT</text>

  <!-- Footer Bar -->
  <rect x="0" y="350" width="800" height="70" fill="#0D1322"/>
  <line x1="0" y1="350" x2="800" y2="350" stroke="#1F2937" stroke-width="1"/>

  <text x="35" y="391" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="bold" fill="#64748B">STATUS</text>
  <rect x="95" y="372" width="${badgeWidth}" height="28" rx="6" fill="${statusBg}" stroke="${statusBorder}" stroke-width="1"/>
  <text x="${95 + badgeWidth / 2}" y="391" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="${statusColor}">${statusText}</text>

  <text x="765" y="391" text-anchor="end" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="bold" fill="#94A3B8">OFFICIAL: <tspan fill="${volColor}">${escapeXml(truncate(volLabel, 22))}</tspan></text>
</svg>
`;

  return renderSvgToPng(svg, {
    label: `match-card ${matchIdStr}`,
    expectedTexts: ['MATCH DISTRICT', matchIdStr, nameA, ignA, uidA, nameB, ignB, uidB, 'VS', 'BGMI', statusText],
  });
}

// ============================================================================
// Challenge Card PNG Generator (for #available-challenges)
// ============================================================================

export function generateChallengeCardPng(
  challenge,
  { creatorDisplayName = null, creatorIgn = null, creatorUid = null, avatars = new Map(), acceptedOpponent = null } = {}
) {
  const cId = escapeXml(String(challenge?.challengeId || 'CHALLENGE'));
  const cName = escapeXml(truncate(creatorDisplayName || `User#${challenge?.creatorId?.slice?.(-4) || '1'}`, 16));
  const cIgnStr = escapeXml(truncate(creatorIgn || 'BGMI PLAYER', 16));
  const cUidStr = escapeXml(truncate(creatorUid || challenge?.creatorUid || '', 15));

  // Challenger Avatar
  const cAvUri = getAvatarDataUri(avatars.get(String(challenge?.creatorId)));
  const cInitial = escapeXml((creatorDisplayName || 'C').trim().slice(0, 1).toUpperCase() || 'C');

  const cAvatarSvg = cAvUri
    ? `<defs><clipPath id="avatar-clip-c"><circle cx="92" cy="175" r="36" /></clipPath></defs>
       <circle cx="92" cy="175" r="36" fill="#1E293B" />
       <image href="${cAvUri}" x="56" y="139" width="72" height="72" clip-path="url(#avatar-clip-c)" preserveAspectRatio="xMidYMid slice" />
       <circle cx="92" cy="175" r="36" fill="none" stroke="#F97316" stroke-width="2" />`
    : `<circle cx="92" cy="175" r="36" fill="#1E293B" stroke="#F97316" stroke-width="2" />
       <text x="92" y="184" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="22" font-weight="bold" fill="#F97316">${cInitial}</text>`;

  // Right Panel: Opponent or Open Slot
  let rightPanelSvg = '';
  if (acceptedOpponent) {
    const opName = escapeXml(truncate(acceptedOpponent.displayName || 'Opponent', 16));
    const opIgn = escapeXml(truncate(acceptedOpponent.bgmiIgn || 'Unknown', 16));
    const opUid = escapeXml(truncate(acceptedOpponent.bgmiUid || '', 15));
    const opAvUri = getAvatarDataUri(avatars.get(String(acceptedOpponent.discordId)));
    const opInitial = escapeXml((acceptedOpponent.displayName || 'O').trim().slice(0, 1).toUpperCase() || 'O');

    const opAvatarSvg = opAvUri
      ? `<defs><clipPath id="avatar-clip-op"><circle cx="517" cy="175" r="36" /></clipPath></defs>
         <circle cx="517" cy="175" r="36" fill="#1E293B" />
         <image href="${opAvUri}" x="481" y="139" width="72" height="72" clip-path="url(#avatar-clip-op)" preserveAspectRatio="xMidYMid slice" />
         <circle cx="517" cy="175" r="36" fill="none" stroke="#F97316" stroke-width="2" />`
      : `<circle cx="517" cy="175" r="36" fill="#1E293B" stroke="#F97316" stroke-width="2" />
         <text x="517" y="184" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="22" font-weight="bold" fill="#F97316">${opInitial}</text>`;

    rightPanelSvg = `
      <rect x="460" y="95" width="305" height="235" rx="10" fill="#111827" stroke="#1F2937" stroke-width="1"/>
      <rect x="760" y="95" width="5" height="235" rx="2" fill="#F97316"/>
      <text x="477" y="122" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8" letter-spacing="1">OPPONENT</text>

      ${opAvatarSvg}

      <text x="567" y="152" font-family="Noto Sans, Noto Sans Devanagari" font-size="18" font-weight="bold" fill="#FFFFFF">${opName}</text>
      <text x="567" y="178" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="600" fill="#94A3B8">IGN: <tspan fill="#F97316" font-weight="bold">${opIgn}</tspan></text>
      ${opUid ? `<text x="567" y="202" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="500" fill="#64748B">UID: <tspan fill="#CBD5E1">${opUid}</tspan></text>` : ''}

      <rect x="475" y="280" width="275" height="32" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
      <text x="612" y="301" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8">CHALLENGE ACCEPTED</text>
    `;
  } else {
    rightPanelSvg = `
      <rect x="460" y="95" width="305" height="235" rx="10" fill="#111827" stroke="#1F2937" stroke-width="1"/>
      <text x="477" y="122" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#64748B" letter-spacing="1">SLOT OPEN</text>

      <rect x="480" y="140" width="265" height="115" rx="8" fill="none" stroke="#334155" stroke-width="1.5" stroke-dasharray="6 4"/>
      <text x="612" y="190" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="14" font-weight="bold" fill="#94A3B8">AWAITING OPPONENT</text>
      <text x="612" y="215" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#F97316">CLICK ACCEPT BELOW</text>

      <rect x="475" y="280" width="275" height="32" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
      <text x="612" y="301" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8">FREE TDM 1V1 MATCH</text>
    `;
  }

  // Footer Status
  const statusStr = String(challenge?.status || 'OPEN');
  let statusCol = '#22C55E';
  let statusBg = '#052E16';
  let statusBorder = '#22C55E';
  if (statusStr === 'ACCEPTED' || statusStr === ARENA_STATUS.WAITING_FOR_VOLUNTEER) {
    statusCol = '#60A5FA';
    statusBg = '#172554';
    statusBorder = '#3B82F6';
  } else if (statusStr === 'CANCELLED' || statusStr === 'EXPIRED') {
    statusCol = '#9CA3AF';
    statusBg = '#1F2937';
    statusBorder = '#4B5563';
  }

  const statusText = statusStr === ARENA_STATUS.WAITING_FOR_VOLUNTEER ? 'ACCEPTED' : statusStr;
  const badgeWidth = Math.max(90, statusText.length * 9 + 24);

  const expiresAtMs = challenge?.expiresAt ? new Date(challenge.expiresAt).getTime() : NaN;
  const remainingSeconds = Number.isFinite(expiresAtMs) ? Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)) : null;
  const expiryInfo = statusStr === ARENA_STATUS.OPEN && remainingSeconds !== null
    ? `EXPIRES IN ${Math.floor(remainingSeconds / 60)}M ${remainingSeconds % 60}S`
    : remainingSeconds !== null
      ? `EXPIRES ${new Date(challenge.expiresAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
      : 'NO TIMEOUT';

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
  <!-- Base Background -->
  <rect width="800" height="420" fill="#0B0F19"/>
  <rect x="0" y="0" width="800" height="4" fill="#F97316"/>
  <rect x="0" y="0" width="800" height="420" fill="none" stroke="#1F2937" stroke-width="1"/>

  <!-- Header -->
  <text x="35" y="42" font-family="Noto Sans, Noto Sans Devanagari" font-size="20" font-weight="bold" fill="#F97316" letter-spacing="1">MATCH DISTRICT</text>
  <text x="35" y="62" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="600" fill="#94A3B8" letter-spacing="1">OPEN 1V1 CHALLENGE</text>

  <!-- Challenge ID Badge -->
  <rect x="615" y="24" width="150" height="34" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
  <text x="690" y="47" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="15" font-weight="bold" fill="#FFFFFF">${cId}</text>
  <line x1="35" y1="78" x2="765" y2="78" stroke="#1F2937" stroke-width="1"/>

  <!-- Center VS Indicator -->
  <rect x="355" y="145" width="90" height="120" rx="10" fill="#1E293B" stroke="#F97316" stroke-width="2"/>
  <text x="400" y="200" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="34" font-weight="900" fill="#F97316">VS</text>
  <text x="400" y="228" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="bold" fill="#FFFFFF">BGMI</text>
  <text x="400" y="248" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="11" font-weight="600" fill="#94A3B8">TDM 1V1</text>

  <!-- Challenger Panel (Left) -->
  <rect x="35" y="95" width="305" height="235" rx="10" fill="#111827" stroke="#1F2937" stroke-width="1"/>
  <rect x="35" y="95" width="5" height="235" rx="2" fill="#F97316"/>
  <text x="52" y="122" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8" letter-spacing="1">CHALLENGER</text>

  ${cAvatarSvg}

  <text x="142" y="152" font-family="Noto Sans, Noto Sans Devanagari" font-size="18" font-weight="bold" fill="#FFFFFF">${cName}</text>
  <text x="142" y="178" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="600" fill="#94A3B8">IGN: <tspan fill="#F97316" font-weight="bold">${cIgnStr}</tspan></text>
  ${cUidStr ? `<text x="142" y="202" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="500" fill="#64748B">UID: <tspan fill="#CBD5E1">${cUidStr}</tspan></text>` : ''}

  <rect x="50" y="280" width="275" height="32" rx="6" fill="#1E293B" stroke="#334155" stroke-width="1"/>
  <text x="187" y="301" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="#94A3B8">READY TO FIGHT</text>

  <!-- Right Panel -->
  ${rightPanelSvg}

  <!-- Footer Bar -->
  <rect x="0" y="350" width="800" height="70" fill="#0D1322"/>
  <line x1="0" y1="350" x2="800" y2="350" stroke="#1F2937" stroke-width="1"/>

  <text x="35" y="391" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="bold" fill="#64748B">STATUS</text>
  <rect x="95" y="372" width="${badgeWidth}" height="28" rx="6" fill="${statusBg}" stroke="${statusBorder}" stroke-width="1"/>
  <text x="${95 + badgeWidth / 2}" y="391" text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari" font-size="12" font-weight="bold" fill="${statusCol}">${statusText}</text>

  <text x="765" y="391" text-anchor="end" font-family="Noto Sans, Noto Sans Devanagari" font-size="13" font-weight="bold" fill="#94A3B8">${escapeXml(expiryInfo)}</text>
</svg>
`;

  return renderSvgToPng(svg, {
    label: `challenge-card ${cId}`,
    expectedTexts: ['MATCH DISTRICT', cId, cName, cIgnStr, 'VS', 'BGMI', statusText],
  });
}

// ============================================================================
// Message Payload Builders with Dynamic Images
// ============================================================================

export async function buildMatchCardPayload(match, volunteerDisplayName = null, options = {}) {
  const client = options.client || options.guild?.client;
  const guild = options.guild || client?.guilds?.cache?.get?.(match.guildId) || null;
  const avatars = options.avatars || await fetchMatchAvatars(client, match);
  const playerData = await Promise.all(['playerA', 'playerB'].map(async (key) => {
    const saved = match[key] || {};
    const discordId = String(saved.discordId || '');
    const [profile, member] = await Promise.all([
      discordId ? getArenaPlayer(discordId).catch(() => null) : null,
      discordId ? (guild?.members?.cache?.get?.(discordId) || guild?.members?.fetch?.(discordId).catch(() => null)) : null,
    ]);
    let user = member?.user || null;
    if (!user && discordId) user = client?.users?.cache?.get?.(discordId) || await client?.users?.fetch?.(discordId).catch(() => null);
    return [key, {
      ...saved,
      displayName: member?.displayName || user?.globalName || user?.username || profile?.displayName || saved.displayName || `Player ${key === 'playerA' ? 'A' : 'B'}`,
      bgmiIgn: profile?.bgmiIgn || saved.bgmiIgn || '',
      bgmiUid: profile?.bgmiUid || saved.bgmiUid || '',
    }];
  }));
  const renderMatch = { ...match, playerA: Object.fromEntries(playerData).playerA, playerB: Object.fromEntries(playerData).playerB };

  if (!volunteerDisplayName && match.volunteerId) {
    const volunteer = guild?.members?.cache?.get?.(String(match.volunteerId)) || await guild?.members?.fetch?.(String(match.volunteerId)).catch(() => null);
    volunteerDisplayName = volunteer?.displayName || volunteer?.user?.globalName || volunteer?.user?.username || null;
  }

  const pngBuffer = generateMatchCardPng(renderMatch, {
    volunteerDisplayName,
    avatars,
  });

  logArenaImageDiagnostics('match', renderMatch, volunteerDisplayName, avatars, pngBuffer);
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

  if (options.surface === 'volunteerPanel') {
    const publicComponents = match.status === ARENA_STATUS.WAITING_FOR_VOLUNTEER && !match.volunteerId
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder()
          .setCustomId(`arena:claim_match:${match.matchId}`)
          .setLabel('Accept Match')
          .setStyle(ButtonStyle.Primary))]
      : [];
    return { embeds: [embed], files: [attachment], attachments: [], components: publicComponents };
  }

  return {
    embeds: [embed],
    files: [attachment],
    attachments: [],
    components,
  };
}

export async function buildChallengeCardPayload(challenge, creatorDisplayName = null, options = {}) {
  const client = options.client || options.guild?.client;
  const guild = options.guild || client?.guilds?.cache?.get?.(challenge.guildId) || null;
  const creator = await getArenaPlayer(challenge.creatorId).catch(() => null);
  const creatorMember = guild?.members?.cache?.get?.(String(challenge.creatorId)) || await guild?.members?.fetch?.(String(challenge.creatorId)).catch(() => null);
  const creatorUser = creatorMember?.user || client?.users?.cache?.get?.(String(challenge.creatorId)) || await client?.users?.fetch?.(String(challenge.creatorId)).catch(() => null);
  const displayName = creatorMember?.displayName || creatorUser?.globalName || creatorUser?.username || creatorDisplayName || creator?.displayName || null;
  let acceptedOpponent = options.acceptedOpponent || null;
  if (!acceptedOpponent && challenge.opponentId) acceptedOpponent = { discordId: challenge.opponentId };
  if (acceptedOpponent?.discordId) {
    const [opponentProfile, opponentMember] = await Promise.all([
      getArenaPlayer(acceptedOpponent.discordId).catch(() => null),
      guild?.members?.cache?.get?.(String(acceptedOpponent.discordId)) || guild?.members?.fetch?.(String(acceptedOpponent.discordId)).catch(() => null),
    ]);
    acceptedOpponent = {
      ...acceptedOpponent,
      displayName: opponentMember?.displayName || opponentMember?.user?.globalName || opponentMember?.user?.username || opponentProfile?.displayName || acceptedOpponent.displayName,
      bgmiIgn: opponentProfile?.bgmiIgn || acceptedOpponent.bgmiIgn,
      bgmiUid: opponentProfile?.bgmiUid || acceptedOpponent.bgmiUid,
    };
  }
  const renderChallenge = {
    ...challenge,
    creatorDisplayName: displayName,
    creatorIgn: creator?.bgmiIgn || options.creatorIgn,
    creatorUid: creator?.bgmiUid || options.creatorUid,
  };
  const avatars = options.avatars || await fetchChallengeAvatars(client, renderChallenge, acceptedOpponent);

  const pngBuffer = generateChallengeCardPng(challenge, {
    creatorDisplayName: displayName,
    creatorIgn: renderChallenge.creatorIgn || null,
    creatorUid: renderChallenge.creatorUid || null,
    avatars,
    acceptedOpponent,
  });

  logArenaImageDiagnostics('challenge', renderChallenge, null, avatars, pngBuffer);
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
    attachments: [],
    components,
  };
}

function logArenaImageDiagnostics(type, item, volunteerDisplayName, avatars, pngBuffer) {
  if (process.env.ARENA_IMAGE_DIAGNOSTICS !== '1') return;
  const player = (p) => p ? ({ discordId: p.discordId, displayName: p.displayName, bgmiIgn: p.bgmiIgn, bgmiUid: p.bgmiUid }) : null;
  console.info('[ArenaImage] render', JSON.stringify({
    type,
    id: item.matchId || item.challengeId,
    playerA: player(item.playerA) || { discordId: item.creatorId, displayName: item.creatorDisplayName, bgmiIgn: item.creatorIgn, bgmiUid: item.creatorUid },
    playerB: player(item.playerB) || (item.opponentId ? { discordId: item.opponentId } : null),
    volunteer: item.volunteerId ? { discordId: item.volunteerId, displayName: volunteerDisplayName || null } : null,
    avatarUserIds: [...avatars.keys()],
    rendererInput: {
      status: item.status,
      matchId: item.matchId || item.challengeId,
      playerA: player(item.playerA) || { discordId: item.creatorId, displayName: item.creatorDisplayName, bgmiIgn: item.creatorIgn, bgmiUid: item.creatorUid },
      playerB: player(item.playerB),
      volunteerDisplayName: volunteerDisplayName || null,
    },
    output: { width: pngBuffer.readUInt32BE(16), height: pngBuffer.readUInt32BE(20), bytes: pngBuffer.length, png: pngBuffer.subarray(0, 8).toString('hex') },
  }));
}

