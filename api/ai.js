import { redis, REDIS_OK } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { generateAnswer, MODEL_VERSION } from "../lib/providers.js";
import { hash } from "../lib/hash.js";
import { detectIntent, systemPromptFor } from "../lib/intent.js";
import {
    validateSid,
    validateTtl,
    loadHistory,
    saveHistory,
} from "../lib/session.js";

const MAX_PROMPT_LENGTH = 4000;
const CACHE_TTL_SECONDS = 1800;
const CACHE_MAX_VALUE_LENGTH = 4000;

const USAGE_TEXT = [
    "Secure Terminal AI",
    "",
    "Usage:",
    "  curl \"$HOST/api/ai?q=your+prompt&sid=your_key\"",
    "  curl -X POST $HOST/api/ai \\",
    "       -H 'Content-Type: application/json' \\",
    "       -d '{\"prompt\":\"explain recursion\",\"sid\":\"mychat\"}'",
    "",
    "Session:",
    "  sid   required. 4-20 alphanumeric characters. Identifies your session.",
    "  ttl   optional. Session lifetime in seconds (300-7200, default 3600).",
    "",
    "Examples:",
    "  curl \"$HOST/api/ai?q=write+binary+search&sid=mychat\"",
    "  curl \"$HOST/api/ai?q=python&sid=mychat\"",
    "",
    "PowerShell:",
    "  irm \"$HOST/api/ai?q=what+is+ai&sid=mysession\"",
    "",
    "Behavior:",
    "  - Code requests without a language return a clarifier.",
    "  - Code requests with a language return clean code only.",
    "  - Explanations and commands return plain prose, no markdown.",
    "  - Conversation history is preserved per session key.",
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

    // Usage text for bare GET
    if (
        req.method === "GET" &&
        (req.query?.q === undefined || req.query?.q === "")
    ) {
        return res.send(USAGE_TEXT);
    }

    // Rate limit
    const ip = getIp(req);
    const rl = await rateLimit(ip);
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
    if (!rl.allowed) {
        res.setHeader("Retry-After", String(rl.retryAfter || 60));
        return res
            .status(429)
            .send(`Rate limit exceeded. Retry in ${rl.retryAfter || 60}s.\n`);
    }

    // Extract fields from GET or POST
    const rawPrompt =
        req.method === "GET" ? req.query?.q : req.body?.prompt;
    const rawSid =
        req.method === "GET" ? req.query?.sid : req.body?.sid;
    const rawTtl =
        req.method === "GET" ? req.query?.ttl : req.body?.ttl;

    // Validate sid (mandatory)
    const sidCheck = validateSid(rawSid);
    if (!sidCheck.valid) {
        return res.status(400).send(sidCheck.error);
    }
    const sid = rawSid;

    // Validate ttl
    const ttlCheck = validateTtl(rawTtl);
    if (!ttlCheck.valid) {
        return res.status(400).send(ttlCheck.error);
    }
    const ttl = ttlCheck.ttl;

    // Validate prompt
    if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
        return res.status(400).send("Invalid prompt\n");
    }
    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
        return res
            .status(413)
            .send(`Prompt too long (max ${MAX_PROMPT_LENGTH} chars)\n`);
    }

    const normalized = normalizePrompt(rawPrompt);
    const intent = detectIntent(normalized);

    // Load session history
    const history = await loadHistory(sid);

    // Smart code flow: if intent is code and no language, check history for
    // a prior language mention before returning the clarifier.
    if (intent.kind === "code" && !intent.language) {
        // Look through history for a language the user already named
        let priorLanguage = null;
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m.role === "assistant" && /which programming language/i.test(m.content)) {
                // The assistant already asked — check what the user replied next
                if (history[i + 1]?.role === "user") {
                    const { detectLanguage } = await import("../lib/intent.js");
                    priorLanguage = detectLanguage(history[i + 1].content);
                }
                break;
            }
        }

        if (!priorLanguage) {
            // Store the clarifier exchange in session so next turn has context
            const clarifier = clarifierForCode();
            const updatedHistory = [
                ...history,
                { role: "user", content: normalized },
                { role: "assistant", content: clarifier },
            ];
            await saveHistory(sid, updatedHistory, ttl);
            return res.send(clarifier + "\n");
        }

        // Reconstruct intent with recovered language so the prompt is complete
        intent.language = priorLanguage;
    }

    // For non-code or code-with-language: build full message list for provider
    const messages = [
        ...history,
        { role: "user", content: normalized },
    ];

    // Cache only applies to stateless (no prior history) requests to avoid
    // serving one user's session context to another.
    let cacheKey = null;
    let cached = null;
    if (history.length === 0) {
        const cacheTag = `${intent.kind}:${intent.language || "-"}`;
        cacheKey = `ai:${MODEL_VERSION}:${cacheTag}:${hash(normalized)}`;
        cached = await safeCacheGet(cacheKey);
    }

    if (typeof cached === "string" && cached.length > 0) {
        // Still save to session so the conversation is coherent on next turn
        const updatedHistory = [
            ...messages,
            { role: "assistant", content: cached },
        ];
        await saveHistory(sid, updatedHistory, ttl);
        return res.send(cached + "\n");
    }

    const systemPrompt = systemPromptFor(intent);
    const result = await generateAnswer(messages, systemPrompt);

    if (!result.ok) {
        const upstream = result.status;
        if (upstream === 429) {
            return res.status(429).send("Upstream rate limit. Try again shortly.\n");
        }
        if (upstream === 401 || upstream === 403) {
            return res
                .status(502)
                .send("Service misconfigured. Please contact the operator.\n");
        }
        return res.status(502).send("All providers failed. Please try again.\n");
    }

    const clean = cleanResponse(result.text);
    if (clean.length === 0) {
        return res.status(502).send("Empty response from providers.\n");
    }

    // Persist updated history
    const updatedHistory = [
        ...messages,
        { role: "assistant", content: clean },
    ];
    await saveHistory(sid, updatedHistory, ttl);

    // Cache only first-turn (no prior history) responses
    if (cacheKey && clean.length <= CACHE_MAX_VALUE_LENGTH) {
        await safeCacheSet(cacheKey, clean);
    }

    return res.send(clean + "\n");
}