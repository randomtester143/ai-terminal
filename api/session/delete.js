import { extractSid, validateSid, deleteSession } from "../lib/session.js";
import { REDIS_OK } from "../lib/redis.js";

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "POST" && req.method !== "DELETE") {
        res.setHeader("Allow", "POST, DELETE");
        return res.status(405).json({ error: "Method not allowed" });
    }

    if (!REDIS_OK) {
        return res.status(503).json({ error: "Storage unavailable." });
    }

    const rawSid = extractSid(req);
    const sidCheck = validateSid(rawSid);
    if (!sidCheck.valid) {
        return res.status(400).json({ error: sidCheck.error.trim() });
    }

    await deleteSession(rawSid);
    return res.status(200).json({ ok: true });
}
