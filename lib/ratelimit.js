//[cite: 10]
import { redis, REDIS_OK } from "./redis.js";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 30;

export function getIp(req) {
    if (!req || !req.headers) return "anon";

    const xvff = req.headers["x-vercel-forwarded-for"];
    if (typeof xvff === "string" && xvff.trim().length > 0) {
        return xvff.split(",")[0].trim();
    }
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim().length > 0) {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    const xri = req.headers["x-real-ip"];
    if (typeof xri === "string" && xri.trim().length > 0) return xri.trim();

    return req.socket?.remoteAddress || "anon";
}

export async function rateLimit(ip) {
    if (!REDIS_OK || !ip) return { allowed: true, remaining: MAX_REQUESTS, retryAfter: 0 };

    const key = `rl:${ip}`;
    try {
        const p = redis.pipeline();
        p.incr(key);
        p.ttl(key);
        const results = await p.exec();

        const count = Number(results[0]);
        let currentTtl = Number(results[1]);

        if (currentTtl < 0 || count === 1) {
            await redis.expire(key, WINDOW_SECONDS);
            currentTtl = WINDOW_SECONDS;
        }

        const remaining = Math.max(0, MAX_REQUESTS - count);
        const allowed = count <= MAX_REQUESTS;
        const retryAfter = allowed ? 0 : Math.max(1, currentTtl);

        return { allowed, remaining, retryAfter };
    } catch (e) {
        console.error("ratelimit_failed_open", e?.message);
        return { allowed: true, remaining: MAX_REQUESTS, retryAfter: 0 };
    }
}

export const RATE_LIMIT_CONFIG = { WINDOW_SECONDS, MAX_REQUESTS };