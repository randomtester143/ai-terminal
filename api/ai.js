import { redis, REDIS_OK } from "../../lib/redis.js";
import { rateLimit, getIp } from "../../lib/ratelimit.js";
import { generateAnswer, MODEL_VERSION } from "../../lib/providers.js";
import { hash } from "../../lib/hash.js";
import { detectIntent, detectLanguage, systemPromptFor } from "../../lib/intent.js";
import {
    validateSid,
    extractSid,
    loadSession,
    saveHistory,
    deleteSession,
} from "../../lib/session.js";

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
    "     -> { \"sid\": \"abc123...\", \"ttl\": 3600 }",
    "",
    "  2. Chat using the session header:",
    "     curl -X POST $HOST/api/ai \\",
    "          -H 'x-session-id: <sid>' \\",
    "          -H 'Content-Type: application/json' \\",
    "          -d '{\"prompt\":\"explain recursion\"}'",
    "",
    "  3. Or use query param:",
    "     curl \"$HOST/api/ai?q=explain+recursion&sid=<sid>\"",
    "",
    "  4. End session:",
    "     Send prompt: quit",
    "     Or: curl -X POST $HOST/api/session/delete -H 'x-session-id: <sid>'",
    "",
    "Options:",
    "  sid   Session key. Provide via x-session-id header, ?sid= param, or body.",
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
    // Strip terminal escape sequences to prevent injection
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
    // Strip code fences only — do NOT touch **, *, _, or backtick inline code.
    // Reason: ** is Python/JS exponentiation, backticks appear in shell commands.
    // The system prompt instructs the model not to use these; we only clean fences
    // as a safety net for code blocks.
    out = out.replace(/^```[a-zA-Z0-9_+\-.]*\s*\n?([\s\S]*?)\n?^```/gm, (_, body) => body.trimEnd());
    out = out.replace(/^```[a-zA-Z0-9_+\-.]*\s*$/gm, "");
    // Strip markdown headings
    out = out.replace(/^#{1,6}\s+/gm, "");
    // Collapse excessive blank lines
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
    if (req.method === "GET" && (!req.query?.q || req.query.q === "")) {
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

    // Extract and validate SID
    const rawSid = extractSid(req);
    const sidCheck = validateSid(rawSid);
    if (!sidCheck.valid) {
        return res.status(400).send(sidCheck.error);
    }
    const sid = rawSid;

    // Load session — single Redis read, propagates infrastructure errors as 503
    let session;
    try {
        session = await loadSession(sid);
    } catch (e) {
        console.error("session_load_error", e?.message);
        return res.status(503).send("Storage unavailable. Please try again shortly.\n");
    }

    if (!session.found) {
        return res
            .status(404)
            .send("Session not found or expired. Create one at POST /api/session/create\n");
    }

    const { history, ttl } = session;

    // Extract prompt
    const rawPrompt = req.method === "GET" ? req.query?.q : req.body?.prompt;
    if (typeof rawPrompt !== "string" || rawPrompt.trim().length === 0) {
        return res.status(400).send("Invalid prompt\n");
    }
    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
        return res.status(413).send(`Prompt too long (max ${MAX_PROMPT_LENGTH} chars)\n`);
    }

    const normalized = normalizePrompt(rawPrompt);

    // Quit command — delete session and exit
    if (QUIT_COMMANDS.has(normalized.toLowerCase())) {
        await deleteSession(sid);
        return res.send("Session ended.\n");
    }

    const intent = detectIntent(normalized);

    // Code intent without language — check history for a prior clarifier exchange.
    // FIX: the current user answer is in `normalized`, not in history[i+1].
    if (intent.kind === "code" && !intent.language) {
        let priorLanguage = null;

        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m.role === "assistant" && /which programming language/i.test(m.content)) {
                // The user's answer to this clarifier is the CURRENT normalized prompt.
                // history[i+1] would be undefined here because the current turn hasn't been saved yet.
                priorLanguage = detectLanguage(normalized);
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
            try {
                await saveHistory(sid, updatedHistory, ttl);
            } catch (e) {
                console.error("session_save_error", e?.message);
            }
            return res.send(clarifier + "\n");
        }

        intent.language = priorLanguage;
    }

    const messages = [...history, { role: "user", content: normalized }];

    // Cache only for first-turn (no prior history) — keyed by model, intent, and prompt hash
    let cacheKey = null;
    let cached = null;
    if (history.length === 0) {
        const cacheTag = `${intent.kind}:${intent.language || "-"}`;
        cacheKey = `ai:v1:${MODEL_VERSION}:${cacheTag}:${hash(normalized)}`;
        cached = await safeCacheGet(cacheKey);
    }

    if (typeof cached === "string" && cached.length > 0) {
        const updatedHistory = [...messages, { role: "assistant", content: cached }];
        try {
            await saveHistory(sid, updatedHistory, ttl);
        } catch (e) {
            console.error("session_save_error", e?.message);
        }
        return res.send(cached + "\n");
    }

    const systemPrompt = systemPromptFor(intent);
    const result = await generateAnswer(messages, systemPrompt);

    if (!result.ok) {
        if (result.hfModelLoading) {
            return res.status(503).send("AI model is warming up. Please retry in 20 seconds.\n");
        }
        const upstream = result.status;
        if (upstream === 429) return res.status(429).send("Upstream rate limit hit. Try again shortly.\n");
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
    try {
        await saveHistory(sid, updatedHistory, ttl);
    } catch (e) {
        console.error("session_save_error", e?.message);
        // Don't fail the request — the response is already generated
    }

    if (cacheKey && clean.length <= CACHE_MAX_VALUE_LENGTH) {
        await safeCacheSet(cacheKey, clean);
    }

    return res.send(clean + "\n");
}
