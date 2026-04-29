import { generateSid, validateSid, validateTtl, sessionKey } from "../lib/session.js";
import { redis, REDIS_OK } from "../lib/redis.js";

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    if (!REDIS_OK) {
        return res.status(503).json({ error: "Storage unavailable. Check server configuration." });
    }

    // Validate TTL — must be seconds
    const rawTtl = req.body?.ttl ?? req.query?.ttl;
    const ttlCheck = validateTtl(rawTtl);
    if (!ttlCheck.valid) {
        return res.status(400).json({ error: ttlCheck.error.trim() });
    }
    const ttl = ttlCheck.ttl;

    // Accept a client-supplied SID if provided and valid, otherwise generate one
    let sid;
    const clientSid = req.body?.sid ?? req.query?.sid;
    if (clientSid !== undefined && clientSid !== null && clientSid !== "") {
        const check = validateSid(clientSid);
        if (!check.valid) {
            return res.status(400).json({ error: check.error.trim() });
        }
        sid = clientSid;
    } else {
        sid = generateSid();
    }

    const key = sessionKey(sid);

    try {
        // NX ensures we don't overwrite an existing session with same custom SID
        const created = await redis.set(
            key,
            JSON.stringify({ history: [], ttl }),
            { ex: ttl, nx: true }
        );

        if (created === null) {
            // Key already existed — custom SID collision
            return res.status(409).json({ error: "Session ID already in use. Choose a different one." });
        }
    } catch (e) {
        console.error("session_create_failed", e?.message);
        return res.status(503).json({ error: "Failed to create session. Try again." });
    }

    return res.status(200).json({ sid, ttl });
}
