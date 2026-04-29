import { redis } from "./redis.js";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 30;

export function getIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }

    const xri = req.headers["x-real-ip"];
    if (typeof xri === "string" && xri.trim().length > 0) {
        return xri.trim();
    }

    const xvff = req.headers["x-vercel-forwarded-for"];
    if (typeof xvff === "string" && xvff.trim().length > 0) {
        return xvff.split(",")[0].trim();
    }

    return "anon";
}

export async function rateLimit(ip) {
    const key = `rl:${ip}`;
    try {
        // Atomic INCR + EXPIRE via pipeline; single round trip
        const pipeline = redis.pipeline();
        pipeline.incr(key);
        pipeline.expire(key, WINDOW_SECONDS);
        const [count] = await pipeline.exec();

        return Number(count) <= MAX_REQUESTS;
    } catch (e) {
        console.error("ratelimit_failed_open", e?.message);
        // Fail open: prefer availability over strict throttling
        return true;
    }
}