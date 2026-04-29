import { redis } from "./redis.js";

export async function rateLimit(ip) {
    const key = `rl:${ip}`;
    const count = await redis.incr(key);

    if (count === 1) {
        await redis.expire(key, 60);
    }

    if (count > 30) {
        return false;
    }

    return true;
}

export function getIp(req) {
    return req.headers["x-forwarded-for"] || "anon";
}