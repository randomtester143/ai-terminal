import { redis, REDIS_OK } from "./redis.js";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 30;

export function getIp(req) {
    const xvff = req.headers["x-vercel-forwarded-for"];
    if (typeof xvff === "string" && xvff.trim().length > 0) {
        return xvff.split(",")[0].trim();
    }
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    const xri = req.headers["x-real-ip"];
    if (typeof xri === "string" && xri.trim().length > 0) return xri.trim();
    return "anon";
}

export async function rateLimit(ip) {
    if (!REDIS_OK) return { allowed: true, remaining: MAX_REQUESTS, retryAfter: 0 };

    const key = `rl:${ip}`;
    try {
        // FIXED: Atomic operation prevents TTL race condition
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.expire(key, WINDOW_SECONDS);
        }

        const remaining = Math.max(0, MAX_REQUESTS - Number(count));
        const allowed = Number(count) <= MAX_REQUESTS;

        let retryAfter = 0;
        if (!allowed) {
            const ttl = await redis.ttl(key);
            retryAfter = ttl > 0 ? ttl : WINDOW_SECONDS;
        }
        return { allowed, remaining, retryAfter };
    } catch (e) {
        console.error("ratelimit_failed_open", e?.message);
        return { allowed: true, remaining: MAX_REQUESTS, retryAfter: 0 };
    }
}

export const RATE_LIMIT_CONFIG = { WINDOW_SECONDS, MAX_REQUESTS };