import { redis } from "./redis.js";

const SESSION_MAX_MESSAGES = 10;
const SESSION_TTL_DEFAULT = 3600;
const SESSION_TTL_MIN = 300;
const SESSION_TTL_MAX = 7200;
const SID_REGEX = /^[a-zA-Z0-9]{4,20}$/;

export function validateSid(sid) {
    if (typeof sid !== "string" || sid.length === 0) {
        return { valid: false, error: "Session key required. Use ?sid=your_key\n" };
    }
    if (!SID_REGEX.test(sid)) {
        return { valid: false, error: "Invalid session key. Use 4-20 alphanumeric characters.\n" };
    }
    return { valid: true };
}

export function validateTtl(raw) {
    if (raw === undefined || raw === null || raw === "") {
        return { valid: true, ttl: SESSION_TTL_DEFAULT };
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || isNaN(n)) {
        return { valid: false, error: "Invalid ttl. Must be an integer between 300 and 7200.\n" };
    }
    if (n < SESSION_TTL_MIN || n > SESSION_TTL_MAX) {
        return {
            valid: false,
            error: `Invalid ttl. Must be between ${SESSION_TTL_MIN} and ${SESSION_TTL_MAX} seconds.\n`,
        };
    }
    return { valid: true, ttl: n };
}

export function sessionKey(sid) {
    return `chat:${sid}`;
}

export async function loadHistory(sid) {
    try {
        const raw = await redis.get(sessionKey(sid));
        if (!raw) return [];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error("session_load_failed", e?.message);
        return [];
    }
}

export async function saveHistory(sid, messages, ttl) {
    try {
        const trimmed = messages.slice(-SESSION_MAX_MESSAGES);
        await redis.set(sessionKey(sid), JSON.stringify(trimmed), { ex: ttl });
    } catch (e) {
        console.error("session_save_failed", e?.message);
    }
}

export async function resetTtl(sid, ttl) {
    try {
        await redis.expire(sessionKey(sid), ttl);
    } catch (e) {
        console.error("session_ttl_reset_failed", e?.message);
    }
}