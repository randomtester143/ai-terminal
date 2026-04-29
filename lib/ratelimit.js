import { redis, REDIS_OK } from "./redis.js";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 30;

export function getIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    const xri = req.headers["x-real-ip"];
    if (typeof xri === "string" && xri.trim().length > 0) return xri.trim();
    const xvff = req.headers["x-vercel-forwarded-for"];
    if (typeof xvff === "string" && xvff.trim().length > 0) {
        return xvff.split(",")[0].trim();
    }
    return "anon";
}

// Real fixed-window limiter: TTL is set exactly once per window via SET NX.
// INCR runs unconditionally; the SET NX call seeds the counter and TTL atomically
// only when the key does not yet exist.
export async function rateLimit(ip) {
    if (!REDIS_OK) return { allowed: true, remaining: MAX_REQUESTS, retryAfter: 0 };

    const key = `rl:${ip}`;
    try {
        const created = await redis.set(key, 0, { nx: true, ex: WINDOW_SECONDS });
        const count = await redis.incr(key);
        const remaining = Math.max(0, MAX_REQUESTS - Number(count));
        const allowed = Number(count) <= MAX_REQUESTS;

        let retryAfter = 0;
        if (!allowed) {
            const ttl = await redis.ttl(key);
            retryAfter = ttl > 0 ? ttl : WINDOW_SECONDS;
        }
        return { allowed, remaining, retryAfter, created: created === "OK" };
    } catch (e) {
        console.error("ratelimit_failed_open", e?.message);
        return { allowed: true, remaining: MAX_REQUESTS, retryAfter: 0 };
    }
}

export const RATE_LIMIT_CONFIG = { WINDOW_SECONDS, MAX_REQUESTS };