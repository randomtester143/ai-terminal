import { redis } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { callGroq, callHF } from "../lib/providers.js";
import { hash } from "../lib/hash.js";

const MAX_PROMPT_LENGTH = 4000;
const CACHE_TTL_SECONDS = 1800;
const CACHE_MAX_VALUE_LENGTH = 2000;

const USAGE_TEXT = `Secure Terminal AI

Usage:
  curl "https://secure-terminal.vercel.app/api/ai?q=your+prompt"
  curl -X POST https://secure-terminal.vercel.app/api/ai \\
       -H "Content-Type: application/json" \\
       -d '{"prompt":"explain recursion"}'

PowerShell:
  irm "https://secure-terminal.vercel.app/api/ai?q=what+is+ai"
`;

function normalizePrompt(p) {
    return p.trim().replace(/\r\n/g, "\n").toLowerCase();
}

// Strip ANSI/control sequences from upstream output to prevent terminal injection
function sanitizeOutput(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

async function safeCacheGet(key) {
    try {
        return await redis.get(key);
    } catch (e) {
        console.error("cache_get_failed", e?.message);
        return null;
    }
}

async function safeCacheSet(key, value) {
    try {
        await redis.set(key, value, { ex: CACHE_TTL_SECONDS });
    } catch (e) {
        console.error("cache_set_failed", e?.message);
    }
}

async function generateAnswer(prompt) {
    const groq = await callGroq(prompt);
    if (groq.ok && groq.text) return groq.text;

    const hf = await callHF(prompt);
    if (hf.ok && hf.text) return hf.text;

    return null;
}

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET" && req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).send("Method not allowed\n");
    }

    const ip = getIp(req);
    const allowed = await rateLimit(ip);
    if (!allowed) {
        return res.status(429).send("Rate limit exceeded. Try again in a minute.\n");
    }

    const rawPrompt =
        req.method === "GET"
            ? req.query?.q
            : req.body?.prompt;

    // GET with no prompt -> usage text
    if (req.method === "GET" && (rawPrompt === undefined || rawPrompt === "")) {
        return res.send(USAGE_TEXT);
    }

    if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
        return res.status(400).send("Invalid prompt\n");
    }

    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
        return res.status(413).send(`Prompt too long (max ${MAX_PROMPT_LENGTH} chars)\n`);
    }

    const normalized = normalizePrompt(rawPrompt);
    const key = `ai:v1:${hash(normalized)}`;

    // Cache lookup
    const cached = await safeCacheGet(key);
    if (typeof cached === "string" && cached.length > 0) {
        return res.send(cached + "\n");
    }

    // Provider chain (Groq -> HF)
    const answer = await generateAnswer(rawPrompt);
    if (!answer) {
        return res.status(502).send("All providers failed. Please try again.\n");
    }

    const clean = sanitizeOutput(answer).trim();
    if (clean.length === 0) {
        return res.status(502).send("Empty response from providers.\n");
    }

    // Only cache successful, reasonably-sized responses
    if (clean.length <= CACHE_MAX_VALUE_LENGTH) {
        await safeCacheSet(key, clean);
    }

    return res.send(clean + "\n");
}