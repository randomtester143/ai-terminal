import { redis } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { callGroq, callHF } from "../lib/providers.js";
import { hash } from "../lib/hash.js";

export const config = {
    api: {
        bodyParser: { sizeLimit: "50kb" }
    }
};

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const ip = getIp(req);

    if (!(await rateLimit(ip))) {
        return res.status(429).json({ error: "Rate limit exceeded" });
    }

    try {
        const { prompt, cache = false } = req.body || {};

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({ error: "Invalid prompt" });
        }

        const key = hash(prompt);

        // CACHE CHECK
        if (cache) {
            const cached = await redis.get(key);
            if (cached) {
                return res.json({ response: cached, cached: true });
            }
        }

        // PROVIDER CALL
        let response = await callGroq(prompt);

        if (!response) {
            response = await callHF(prompt);
        }

        if (!response) {
            return res.status(500).json({ error: "All providers failed" });
        }

        // OPTIONAL CACHE
        if (cache && response.length < 2000) {
            await redis.set(key, response, { ex: 1800 });
        }

        return res.json({ response });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
}