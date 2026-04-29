import { redis, REDIS_OK } from "../lib/redis.js";

const SESSION_TTL_DEFAULT = 3600;
const SESSION_TTL_MIN = 300;
const SESSION_TTL_MAX = 7200;
const SID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const SID_LENGTH = 6;

function generateSid() {
    let sid = "";
    for (let i = 0; i < SID_LENGTH; i++) {
        sid += SID_CHARS[Math.floor(Math.random() * SID_CHARS.length)];
    }
    return sid;
}

function parseTtl(raw) {
    if (raw === undefined || raw === null || raw === "") return SESSION_TTL_DEFAULT;
    const n = Number(raw);
    if (!Number.isInteger(n) || isNaN(n)) return null;
    if (n < SESSION_TTL_MIN || n > SESSION_TTL_MAX) return null;
    return n;
}

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const rawTtl = req.body?.ttl ?? req.query?.ttl;
    const ttl = parseTtl(rawTtl);
    if (ttl === null) {
        return res.status(400).json({
            error: `Invalid ttl. Must be an integer between ${SESSION_TTL_MIN} and ${SESSION_TTL_MAX} seconds.`,
        });
    }

    const sid = generateSid();
    const key = `chat:${sid}`;

    try {
        await redis.set(key, JSON.stringify([]), { ex: ttl });
    } catch (e) {
        console.error("session_create_failed", e?.message);
        return res.status(503).json({ error: "Failed to create session. Try again." });
    }

    return res.status(200).json({ sid, ttl });
}