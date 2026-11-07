/**
 * Time utilities for the Invite & Earn campaign system.
 * All campaign times are entered and displayed in IST (Asia/Kolkata, UTC+05:30)
 * and stored in MongoDB as UTC Date objects.
 */

export const IST_OFFSET_MINUTES = 330; // +05:30
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

/**
 * Parses an IST date-time string in format "DD-MM-YYYY HH:mm" (or "DD/MM/YYYY HH:mm")
 * and returns a UTC Date instance.
 *
 * @param {string} input
 * @returns {{ valid: boolean, date: Date | null, error?: string }}
 */
export function parseISTDateTime(input) {
  if (!input || typeof input !== 'string') {
    return { valid: false, date: null, error: 'Date/time string is required (format: DD-MM-YYYY HH:mm).' };
  }

  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) {
    return {
      valid: false,
      date: null,
      error: `Invalid format "${trimmed}". Expected DD-MM-YYYY HH:mm in IST (e.g. 15-11-2026 18:30).`,
    };
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (month < 1 || month > 12) {
    return { valid: false, date: null, error: 'Month must be between 01 and 12.' };
  }
  if (hour < 0 || hour > 23) {
    return { valid: false, date: null, error: 'Hour must be between 00 and 23.' };
  }
  if (minute < 0 || minute > 59) {
    return { valid: false, date: null, error: 'Minute must be between 00 and 59.' };
  }

  // Validate day of month (including leap years)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    return { valid: false, date: null, error: `Day must be between 01 and ${daysInMonth} for month ${month}.` };
  }

  // Construct timestamp as if UTC, then subtract IST offset (+05:30) to get true UTC
  const utcEquivalentMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const utcDate = new Date(utcEquivalentMs - IST_OFFSET_MS);

  if (Number.isNaN(utcDate.getTime())) {
    return { valid: false, date: null, error: 'Invalid date value.' };
  }

  return { valid: true, date: utcDate };
}

/**
 * Formats a UTC Date (or timestamp/ISO string) into "DD-MM-YYYY HH:mm IST".
 *
 * @param {Date|string|number|null|undefined} dateInput
 * @returns {string}
 */
export function formatISTDateTime(dateInput) {
  if (!dateInput) return 'N/A';
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return 'N/A';

  const istShifted = new Date(d.getTime() + IST_OFFSET_MS);
  const dd = String(istShifted.getUTCDate()).padStart(2, '0');
  const mm = String(istShifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = istShifted.getUTCFullYear();
  const hh = String(istShifted.getUTCHours()).padStart(2, '0');
  const min = String(istShifted.getUTCMinutes()).padStart(2, '0');

  return `${dd}-${mm}-${yyyy} ${hh}:${min} IST`;
}

/**
 * Formats a UTC Date into "DD-MM-YYYY HH:mm:ss IST" for precise audit/eligibility logs.
 *
 * @param {Date|string|number|null|undefined} dateInput
 * @returns {string}
 */
export function formatISTDateTimeWithSeconds(dateInput) {
  if (!dateInput) return 'N/A';
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return 'N/A';

  const istShifted = new Date(d.getTime() + IST_OFFSET_MS);
  const dd = String(istShifted.getUTCDate()).padStart(2, '0');
  const mm = String(istShifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = istShifted.getUTCFullYear();
  const hh = String(istShifted.getUTCHours()).padStart(2, '0');
  const min = String(istShifted.getUTCMinutes()).padStart(2, '0');
  const sec = String(istShifted.getUTCSeconds()).padStart(2, '0');

  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${sec} IST`;
}

/**
 * Checks whether a Discord user's account age meets the minimum account age in days.
 *
 * @param {Date|number|string|null|undefined} createdAtOrTimestamp
 * @param {number} minAccountAgeDays
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isAccountOldEnough(createdAtOrTimestamp, minAccountAgeDays = 7, now = new Date()) {
  const days = Number(minAccountAgeDays ?? 7);
  if (days <= 0) return true;
  if (!createdAtOrTimestamp) return false;

  const createdMs = createdAtOrTimestamp instanceof Date
    ? createdAtOrTimestamp.getTime()
    : typeof createdAtOrTimestamp === 'number'
      ? createdAtOrTimestamp
      : new Date(createdAtOrTimestamp).getTime();

  if (Number.isNaN(createdMs)) return false;

  const requiredAgeMs = days * 24 * 60 * 60 * 1000;
  return now.getTime() - createdMs >= requiredAgeMs;
}

