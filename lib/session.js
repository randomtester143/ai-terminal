import { redis, REDIS_OK } from "./redis.js";
import crypto from "node:crypto";

const SESSION_MAX_MESSAGES = 20;
const SESSION_TTL_DEFAULT = 3600;
const SESSION_TTL_MIN = 300;
const SESSION_TTL_MAX = 7200;
const SID_BYTES = 16; // 32 hex chars — cryptographically secure

// SID validation: 6-64 alphanumeric chars (accepts both generated and user-supplied)
const SID_REGEX = /^[a-zA-Z0-9]{6,64}$/;

export function generateSid() {
    return crypto.randomBytes(SID_BYTES).toString("hex");
}

export function validateSid(sid) {
    if (typeof sid !== "string" || sid.length === 0) {
        return { valid: false, error: "Session key required. Provide x-session-id header or ?sid= param\n" };
    }
    if (!SID_REGEX.test(sid)) {
        return { valid: false, error: "Invalid session key. Use 6-64 alphanumeric characters.\n" };
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

export function extractSid(req) {
    const header = req.headers?.["x-session-id"];
    if (typeof header === "string" && header.trim().length > 0) return header.trim();
    const query = req.query?.sid;
    if (typeof query === "string" && query.trim().length > 0) return query.trim();
    const body = req.body?.sid;
    if (typeof body === "string" && body.trim().length > 0) return body.trim();
    return null;
}

export function sessionKey(sid) {
    return `chat:${sid}`;
}

/**
 * Load session data from Redis.
 * Returns: { found: true, history: [...], ttl: N } on success
 *          { found: false } if key missing (session expired / never created)
 *          throws on Redis infrastructure error (so caller can return 503)
 */
export async function loadSession(sid) {
    // Propagate Redis errors upward — do NOT swallow them as "not found"
    const raw = await redis.get(sessionKey(sid));
    if (raw === null || raw === undefined) {
        return { found: false };
    }
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const history = Array.isArray(parsed.history) ? parsed.history : [];
        const ttl = typeof parsed.ttl === "number" ? parsed.ttl : SESSION_TTL_DEFAULT;
        return { found: true, history, ttl };
    } catch {
        // Corrupted data — treat as missing
        return { found: false };
    }
}

/**
 * Save session history. TTL is always the one stored at creation — not client-controlled per-request.
 */
export async function saveHistory(sid, messages, ttl) {
    // Propagate errors upward
    const trimmed = messages.slice(-SESSION_MAX_MESSAGES);
    await redis.set(sessionKey(sid), JSON.stringify({ history: trimmed, ttl }), { ex: ttl });
}

export async function deleteSession(sid) {
    try {
        await redis.del(sessionKey(sid));
    } catch (e) {
        console.error("session_delete_failed", e?.message);
    }
}

export const SESSION_TTL_CONFIG = { SESSION_TTL_MIN, SESSION_TTL_MAX, SESSION_TTL_DEFAULT };
