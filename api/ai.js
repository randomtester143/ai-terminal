import { redis, REDIS_OK } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { generateAnswer, MODEL_VERSION } from "../lib/providers.js";
import { hash } from "../lib/hash.js";
import { detectIntent, systemPromptFor } from "../lib/intent.js";
import {
    validateSid,
    validateTtl,
    extractSid,
    loadHistory,
    saveHistory,
    deleteSession,
    sessionExists,
} from "../lib/session.js";

const MAX_PROMPT_LENGTH = 4000;
const CACHE_TTL_SECONDS = 1800;
const CACHE_MAX_VALUE_LENGTH = 4000;
const QUIT_COMMANDS = new Set(["quit", "exit", "end", "bye", "/quit", "/exit"]);

const USAGE_TEXT = [
    "Secure Terminal AI",
    "",
    "Quick start:",
    "  1. Create a session:",
    "     curl -X POST $HOST/api/session/create",
    "     → { \"sid\": \"abc123\", \"ttl\": 3600 }",
    "",
    "  2. Chat using the session header:",
    "     curl -X POST $HOST/api/ai \\",
    "          -H 'x-session-id: abc123' \\",
    "          -H 'Content-Type: application/json' \\",
    "          -d '{\"prompt\":\"explain recursion\"}'",
    "",
    "  3. Or use query param:",
    "     curl \"$HOST/api/ai?q=explain+recursion&sid=abc123\"",
    "",
    "  4. End session:",
    "     Send prompt: quit",
    "",
    "Options:",
    "  sid   Session key. Provide via x-session-id header, ?sid= param, or body.",
    "  ttl   Session lifetime in seconds (300-7200, default 3600).",
    "",
    "Behavior:",
    "  - Code requests without a language return a clarifier.",
    "  - Code requests with a language return clean code only.",
    "  - Explanations and commands return plain prose, no markdown.",
    "  - Conversation history is preserved per session.",
    "",
].join("\n");

function normalizePrompt(p) {
    return p.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function sanitizeOutput(text) {
    let out = text;
    /* eslint-disable no-control-regex */
    out = out.replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "");
    out = out.replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, "");
    out = out.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    out = out.replace(/\x1B[@-Z\\-_]/g, "");
    out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    /* eslint-enable no-control-regex */
    return out;
}

function stripMarkdown(text) {
    let out = text;
    out = out.replace(/```[a-zA-Z0-9_+\-.]*\n?([\s\S]*?)\n?```/g, (_, body) => body);
    out = out.replace(/^```[a-zA-Z0-9_+\-.]*\s*$/gm, "");
    out = out.replace(/`([^`\n]+)`/g, "$1");
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
    out = out.replace(/__([^_\n]+)__/g, "$1");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2");
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1$2");
    out = out.replace(/^#{1,6}\s+/gm, "");
    out = out.replace(/^[ \t]*[-*+]\s+/gm, "");
    out = out.replace(/^[ \t]*>\s?/gm, "");
    out = out.replace(/\n{3,}/g, "\n\n");
    return out;
}

function cleanResponse(text) {
    return stripMarkdown(sanitizeOutput(text)).trim();
}

async function safeCacheGet(key) {
    if (!REDIS_OK) return null;
    try {
        return await redis.get(key);
    } catch (e) {
        console.error("cache_get_failed", e?.message);
        return null;
    }
}

async function safeCacheSet(key, value) {
    if (!REDIS_OK) return;
    try {
        await redis.set(key, value, { ex: CACHE_TTL_SECONDS });
    } catch (e) {
        console.error("cache_set_failed", e?.message);
    }
}

function clarifierForCode() {
    return "Which programming language should I use? (e.g., Python, JavaScript, C, Go, Rust, Java)";
}

export default async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET" && req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).send("Method not allowed\n");
    }

    // Bare GET → usage
    if (req.method === "GET" && (req.query?.q === undefined || req.query?.q === "")) {
        return res.send(USAGE_TEXT);
    }

    // Rate limit
    const ip = getIp(req);
    const rl = await rateLimit(ip);
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
    if (!rl.allowed) {
        res.setHeader("Retry-After", String(rl.retryAfter || 60));
        return res.status(429).send(`Rate limit exceeded. Retry in ${rl.retryAfter || 60}s.\n`);
    }

    // Extract sid: header → query → body
    const rawSid = extractSid(req);
    const sidCheck = validateSid(rawSid);
    if (!sidCheck.valid) {
        return res.status(400).send(sidCheck.error);
    }
    const sid = rawSid;

    // Validate ttl
    const rawTtl = req.method === "GET" ? req.query?.ttl : (req.body?.ttl ?? req.query?.ttl);
    const ttlCheck = validateTtl(rawTtl);
    if (!ttlCheck.valid) {
        return res.status(400).send(ttlCheck.error);
    }
    const ttl = ttlCheck.ttl;

    // Verify session exists in Redis
    const exists = await sessionExists(sid);
    if (!exists) {
        return res
            .status(404)
            .send("Session not found or expired. Create one at POST /api/session/create\n");
    }

    // Extract prompt
    const rawPrompt = req.method === "GET" ? req.query?.q : req.body?.prompt;
    if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
        return res.status(400).send("Invalid prompt\n");
    }
    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
        return res.status(413).send(`Prompt too long (max ${MAX_PROMPT_LENGTH} chars)\n`);
    }

    const normalized = normalizePrompt(rawPrompt);

    // Quit command
    if (QUIT_COMMANDS.has(normalized.toLowerCase())) {
        await deleteSession(sid);
        return res.send("Session ended.\n");
    }

    const intent = detectIntent(normalized);
    const history = await loadHistory(sid);

    // Code intent without language: check history for prior language
    if (intent.kind === "code" && !intent.language) {
        let priorLanguage = null;
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m.role === "assistant" && /which programming language/i.test(m.content)) {
                if (history[i + 1]?.role === "user") {
                    const { detectLanguage } = await import("../lib/intent.js");
                    priorLanguage = detectLanguage(history[i + 1].content);
                }
                break;
            }
        }

        if (!priorLanguage) {
            const clarifier = clarifierForCode();
            const updatedHistory = [
                ...history,
                { role: "user", content: normalized },
                { role: "assistant", content: clarifier },
            ];
            await saveHistory(sid, updatedHistory, ttl);
            return res.send(clarifier + "\n");
        }

        intent.language = priorLanguage;
    }

    const messages = [...history, { role: "user", content: normalized }];

    // Cache only applies to first-turn (no prior history) requests
    let cacheKey = null;
    let cached = null;
    if (history.length === 0) {
        const cacheTag = `${intent.kind}:${intent.language || "-"}`;
        cacheKey = `ai:${MODEL_VERSION}:${cacheTag}:${hash(normalized)}`;
        cached = await safeCacheGet(cacheKey);
    }

    if (typeof cached === "string" && cached.length > 0) {
        const updatedHistory = [...messages, { role: "assistant", content: cached }];
        await saveHistory(sid, updatedHistory, ttl);
        return res.send(cached + "\n");
    }

    const systemPrompt = systemPromptFor(intent);
    const result = await generateAnswer(messages, systemPrompt);

    if (!result.ok) {
        const upstream = result.status;
        if (upstream === 429) return res.status(429).send("Upstream rate limit. Try again shortly.\n");
        if (upstream === 401 || upstream === 403) {
            return res.status(502).send("Service misconfigured. Please contact the operator.\n");
        }
        return res.status(502).send("All providers failed. Please try again.\n");
    }

    const clean = cleanResponse(result.text);
    if (clean.length === 0) {
        return res.status(502).send("Empty response from providers.\n");
    }

    const updatedHistory = [...messages, { role: "assistant", content: clean }];
    await saveHistory(sid, updatedHistory, ttl);

    if (cacheKey && clean.length <= CACHE_MAX_VALUE_LENGTH) {
        await safeCacheSet(cacheKey, clean);
    }

    return res.send(clean + "\n");
}