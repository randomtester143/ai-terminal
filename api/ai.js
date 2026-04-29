import { redis } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { callGroq, callHF } from "../lib/providers.js";
import { hash } from "../lib/hash.js";

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    const ip = getIp(req);

    if (!(await rateLimit(ip))) {
        return res.status(429).send("Rate limit exceeded\n");
    }

    // -------- GET (terminal-friendly) --------
    if (req.method === "GET") {
        const prompt = req.query.q;

        if (!prompt) {
            return res.send(
                `Secure Terminal AI

Usage:
  curl "https://secure-terminal.vercel.app?q=your prompt"

Examples:
  curl "https://secure-terminal.vercel.app?q=explain recursion"
  irm "https://secure-terminal.vercel.app?q=what is ai"
`
            );
        }

        const key = hash(prompt);

        // cache
        const cached = await redis.get(key);
        if (cached) return res.send(cached + "\n");

        let response = await callGroq(prompt);
        if (!response) response = await callHF(prompt);

        if (!response) {
            return res.status(500).send("All providers failed\n");
        }

        if (response.length < 2000) {
            await redis.set(key, response, { ex: 1800 });
        }

        return res.send(response + "\n");
    }

    // -------- POST --------
    if (req.method === "POST") {
        const { prompt } = req.body || {};

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).send("Invalid prompt\n");
        }

        const groq = await callGroq(prompt);
        const hf = await callHF(prompt);

        return res.send(
            `--- GROQ ---
${groq}

--- HF ---
${hf}
`
        );

        if (!response) {
            return res.status(500).send("All providers failed\n");
        }

        return res.send(response + "\n");
    }

    return res.status(405).send("Method not allowed\n");
}