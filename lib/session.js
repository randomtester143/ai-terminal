//[cite: 8]
import { redis, REDIS_OK } from "./redis.js";
import crypto from "node:crypto";

const SESSION_MAX_MESSAGES = 20;
const SESSION_TTL_DEFAULT = 3600;
const SESSION_TTL_MIN = 300;
const SESSION_TTL_MAX = 7200;
const SID_BYTES = 16;

const SID_REGEX = /^[a-zA-Z0-9]{6,64}$/;

/**
 * Generate a cryptographically random session ID (32 hex chars).
 * @returns {string}
 */
export function generateSid() {
    return crypto.randomBytes(SID_BYTES).toString("hex");
}

/**
 * Validate a session ID string against length and character constraints.
 * @param {string|null|undefined} sid
 * @returns {{valid: boolean, error?: string}}
 */
export function validateSid(sid) {
    if (typeof sid !== "string" || sid.length === 0) {
        return { valid: false, error: "Session key required. Provide x-session-id header or ?sid= param\n" };
    }
    if (!SID_REGEX.test(sid)) {
        return { valid: false, error: "Invalid session key. Use 6-64 alphanumeric characters.\n" };
    }
    return { valid: true };
}

/**
 * Validate and convert a TTL value (in minutes) to seconds.
 * @param {string|number|null|undefined} raw — TTL in minutes
 * @returns {{valid: boolean, ttl?: number, error?: string}}
 */
export function validateTtl(raw) {
    if (raw === undefined || raw === null || raw === "") {
        return { valid: true, ttl: SESSION_TTL_DEFAULT };
    }

    const mins = Number(raw);

    if (!Number.isFinite(mins) || !Number.isInteger(mins)) {
        return { valid: false, error: "Invalid ttl. Must be an integer (minutes).\n" };
    }

    const seconds = mins * 60;

    if (seconds < SESSION_TTL_MIN || seconds > SESSION_TTL_MAX) {
        return {
            valid: false,
            error: `Invalid ttl. Must be between ${SESSION_TTL_MIN / 60} and ${SESSION_TTL_MAX / 60} minutes.\n`,
        };
    }

    return { valid: true, ttl: seconds };
}

/**
 * Extract the session ID from the request via header, query, or body.
 * @param {import("http").IncomingMessage & {query?: Record<string,string>, body?: Record<string,string>}} req
 * @returns {string|null}
 */
export function extractSid(req) {
    const header = req.headers?.["x-session-id"];
    if (typeof header === "string" && header.trim().length > 0) return header.trim();

    const query = req.query?.sid;
    if (typeof query === "string" && query.trim().length > 0) return query.trim();

    const body = req.body?.sid;
    if (typeof body === "string" && body.trim().length > 0) return body.trim();

    return null;
}

/**
 * Build the Redis key for a session.
 * @param {string} sid
 * @returns {string}
 */
export function sessionKey(sid) {
    return `chat:${sid}`;
}

/**
 * Load a session's history and TTL from Redis.
 * @param {string} sid
 * @returns {Promise<{found?: boolean, history?: Array, ttl?: number, error?: string}>}
 */
export async function loadSession(sid) {
    if (!REDIS_OK || !redis) return { error: "Storage unavailable" };

    try {
        const raw = await redis.get(sessionKey(sid));
        if (raw === null || raw === undefined) return { found: false };

        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const history = Array.isArray(parsed?.history) ? parsed.history : [];
        const ttl = typeof parsed?.ttl === "number" && Number.isFinite(parsed.ttl)
            ? parsed.ttl
            : SESSION_TTL_DEFAULT;

        return { found: true, history, ttl };
    } catch (e) {
        console.error("session_load_failed", e?.message);
        return { error: "Storage error during load" };
    }
}

/**
 * Save conversation history to Redis with TTL refresh.
 * Trims to the most recent SESSION_MAX_MESSAGES messages.
 * @param {string} sid
 * @param {Array} messages
 * @param {number} ttl — in seconds
 */
export async function saveHistory(sid, messages, ttl) {
    if (!REDIS_OK || !redis) return;
    try {
        const safeTtl = (Number.isFinite(ttl) && ttl > 0) ? ttl : SESSION_TTL_DEFAULT;
        const trimmed = messages.slice(-SESSION_MAX_MESSAGES);
        await redis.set(sessionKey(sid), JSON.stringify({ history: trimmed, ttl: safeTtl }), { ex: safeTtl });
    } catch (e) {
        console.error("session_save_failed", e?.message);
    }
}

/**
 * Delete a session from Redis.
 * @param {string} sid
 */
export async function deleteSession(sid) {
    if (!REDIS_OK || !redis) return;
    try {
        await redis.del(sessionKey(sid));
    } catch (e) {
        console.error("session_delete_failed", e?.message);
    }
}

export const SESSION_TTL_CONFIG = { SESSION_TTL_MIN, SESSION_TTL_MAX, SESSION_TTL_DEFAULT };