//[cite: 14]
import { redis, REDIS_OK } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { generateAnswer } from "../lib/providers.js";
import { hash } from "../lib/hash.js";
import { detectIntent, detectLanguage, systemPromptFor } from "../lib/intent.js";
import {
    validateSid,
    extractSid,
    loadSession,
    saveHistory,
    deleteSession,
} from "../lib/session.js";

const MAX_PROMPT_LENGTH = 4000;
const CACHE_TTL_SECONDS = 1800;
const CACHE_MAX_VALUE_LENGTH = 4000;
const QUIT_COMMANDS = new Set(["quit", "exit", "end", "bye", "/quit", "/exit"]);

function getUsageText(host) {
    return [
        "Secure Terminal AI",
        "",
        "Quick start:",
        "  1. Create a session:",
        `     curl -X POST ${host}/api/session/create`,
        "",
        "  2. Chat:",
        `     curl ${host}/api/ai/<sid>/<prompt>`,
        "",
    ].join("\n");
}

function normalizePrompt(p) {
    return p.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function sanitizeOutput(text) {
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function stripMarkdown(text) {
    return text
        .replace(/^```[a-zA-Z]*\n?/gm, "")
        .replace(/```$/gm, "")
        .trim();
}

function cleanResponse(text) {
    return stripMarkdown(sanitizeOutput(text)).trim();
}

async function safeCacheGet(key) {
    if (!REDIS_OK || !key) return null;
    try {
        return await redis.get(key);
    } catch {
        return null;
    }
}

async function safeCacheSet(key, value) {
    if (!REDIS_OK || !key || !value || value.length > CACHE_MAX_VALUE_LENGTH) return;
    try {
        await redis.set(key, value, { ex: CACHE_TTL_SECONDS });
    } catch { }
}

function clarifierForCode() {
    return "Which programming language should I use?";
}

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain");

    if (req.method !== "GET" && req.method !== "POST") {
        return res.status(405).send("Method not allowed\n");
    }

    const ip = getIp(req);
    const parts = (req.url || "").split("/").filter(Boolean);

    const sidFromPath = parts.length >= 4 ? parts[parts.length - 2] : null;
    const promptFromPath = parts.length >= 4 ? parts[parts.length - 1] : null;

    if (req.method === "GET" && !promptFromPath && !req.query?.q) {
        const protocol = req.headers["x-forwarded-proto"] || "http";
        const hostHeader = req.headers.host || "localhost";
        return res.send(getUsageText(`${protocol}://${hostHeader}`));
    }

    const rawSid = sidFromPath ?? extractSid(req);
    const sidCheck = validateSid(rawSid);

    if (!sidCheck.valid) {
        return res.status(400).send(sidCheck.error);
    }

    const sid = rawSid;

    let rl, sessionResult;

    try {
        [rl, sessionResult] = await Promise.all([
            rateLimit(ip),
            loadSession(sid).catch(e => ({ error: e })),
        ]);
    } catch {
        return res.status(503).send("Storage unavailable\n");
    }

    if (!rl.allowed) {
        return res.status(429).send("Rate limit exceeded\n");
    }

    if (sessionResult.error) {
        return res.status(503).send("Storage unavailable\n");
    }

    if (!sessionResult.found) {
        return res.status(404).send("Session not found\n");
    }

    const { history, ttl } = sessionResult;

    const rawPrompt =
        promptFromPath ||
        (req.method === "GET" ? req.query?.q : req.body?.prompt ?? null);

    if (!rawPrompt || typeof rawPrompt !== "string") {
        return res.status(400).send("Invalid prompt format\n");
    }

    let decoded;
    try {
        decoded = decodeURIComponent(rawPrompt);
    } catch {
        decoded = rawPrompt;
    }

    const normalized = normalizePrompt(decoded);

    if (normalized.length === 0) {
        return res.status(400).send("Prompt cannot be empty\n");
    }

    if (normalized.length > MAX_PROMPT_LENGTH) {
        return res.status(413).send(`Prompt too long. Limit is ${MAX_PROMPT_LENGTH} characters.\n`);
    }

    if (QUIT_COMMANDS.has(normalized.toLowerCase())) {
        await deleteSession(sid);
        return res.send("Session ended.\n");
    }

    const intent = detectIntent(normalized);

    if (intent.kind === "code" && !intent.language) {
        const clarifier = clarifierForCode();
        await saveHistory(sid, [...history, { role: "assistant", content: clarifier }], ttl);
        return res.send(clarifier + "\n");
    }

    const messages = [...history, { role: "user", content: normalized }];

    let cacheKey = null;
    let cached = null;

    if (history.length === 0) {
        cacheKey = `ai:${hash(normalized)}`;
        cached = await safeCacheGet(cacheKey);
    }

    if (cached) {
        await saveHistory(sid, [...messages, { role: "assistant", content: cached }], ttl);
        return res.send(cached + "\n");
    }

    const result = await generateAnswer(messages, systemPromptFor(intent));

    if (!result.ok) {
        return res.status(502).send(`AI failed: ${result.error || "unknown"}\n`);
    }

    const clean = cleanResponse(result.text);

    await saveHistory(sid, [...messages, { role: "assistant", content: clean }], ttl);

    if (cacheKey) {
        await safeCacheSet(cacheKey, clean);
    }

    return res.send(clean + "\n\n");
}