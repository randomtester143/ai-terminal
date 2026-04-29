import { redis, REDIS_OK } from "../lib/redis.js";
import { rateLimit, getIp } from "../lib/ratelimit.js";
import { generateAnswer, MODEL_VERSION } from "../lib/providers.js";
import { hash } from "../lib/hash.js";
import { detectIntent, systemPromptFor } from "../lib/intent.js";

const MAX_PROMPT_LENGTH = 4000;
const CACHE_TTL_SECONDS = 1800;
const CACHE_MAX_VALUE_LENGTH = 4000;

const USAGE_TEXT = [
    "Secure Terminal AI",
    "",
    "Usage:",
    "  curl \"$HOST/api/ai?q=your+prompt\"",
    "  curl -X POST $HOST/api/ai -H 'Content-Type: application/json' -d '{\"prompt\":\"explain recursion\"}'",
    "",
    "PowerShell:",
    "  irm \"$HOST/api/ai?q=what+is+ai\"",
    "",
    "Behavior:",
    "  - Code requests without a language return a clarifier.",
    "  - Code requests with a language return clean code only.",
    "  - Explanations and commands return plain prose, no markdown.",
    "",
].join("\n");

function normalizePrompt(p) {
    // Preserve case (matters for code) and Unicode. Only normalize line endings
    // and collapse trailing whitespace.
    return p.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

// Strip terminal escape sequences and markdown artifacts.
// Covers CSI, OSC (BEL- and ST-terminated), DCS, single-char escapes, C0/DEL
// controls (preserves \n and \t), and common markdown noise.
function sanitizeOutput(text) {
    let out = text;

    /* eslint-disable no-control-regex */
    // OSC: ESC ] ... BEL  or  ESC ] ... ESC \
    out = out.replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "");
    // DCS / SOS / PM / APC: ESC (P|X|^|_) ... ESC \
    out = out.replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, "");
    // CSI: ESC [ ... final
    out = out.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    // Two-byte ESC sequences (e.g., charset selection, single shifts)
    out = out.replace(/\x1B[@-Z\\-_]/g, "");
    // C0 controls (keep \t \n) and DEL
    out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    /* eslint-enable no-control-regex */

    return out;
}

function stripMarkdown(text) {
    let out = text;

    // Fenced code blocks: ```lang\n...\n```  → keep inner content
    out = out.replace(/```[a-zA-Z0-9_+\-.]*\n?([\s\S]*?)\n?```/g, (_, body) => body);
    // Stray opening or closing fences on their own
    out = out.replace(/^```[a-zA-Z0-9_+\-.]*\s*$/gm, "");
    // Inline code: `x` → x
    out = out.replace(/`([^`\n]+)`/g, "$1");
    // Bold/italic markers (**, __, *, _) — drop the markers, keep text
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
    out = out.replace(/__([^_\n]+)__/g, "$1");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2");
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1$2");
    // ATX headers at line start: "## Heading" → "Heading"
    out = out.replace(/^#{1,6}\s+/gm, "");
    // Bullet markers at line start: "- ", "* ", "+ "
    out = out.replace(/^[ \t]*[-*+]\s+/gm, "");
    // Blockquote markers
    out = out.replace(/^[ \t]*>\s?/gm, "");
    // Collapse runs of 3+ blank lines to 2
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

    // Extract prompt
    const rawPrompt =
        req.method === "GET" ? req.query?.q : req.body?.prompt;

    // GET with no prompt -> usage
    if (req.method === "GET" && (rawPrompt === undefined || rawPrompt === "")) {
        return res.send(USAGE_TEXT);
    }

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

    // Smart code flow: code intent without a language → clarifier (no LLM call)
    if (intent.kind === "code" && !intent.language) {
        return res.send(clarifierForCode() + "\n");
    }

    // Cache key includes model version + intent + language so upgrades and
    // intent shifts invalidate cleanly. Casing preserved.
    const cacheTag = `${intent.kind}:${intent.language || "-"}`;
    const key = `ai:${MODEL_VERSION}:${cacheTag}:${hash(normalized)}`;

    const cached = await safeCacheGet(key);
    if (typeof cached === "string" && cached.length > 0) {
        return res.send(cached + "\n");
    }

    const systemPrompt = systemPromptFor(intent);
    const result = await generateAnswer(normalized, systemPrompt);

    if (!result.ok) {
        // Map upstream status to client status where useful
        const upstream = result.status;
        if (upstream === 429) {
            return res.status(429).send("Upstream rate limit. Try again shortly.\n");
        }
        if (upstream === 401 || upstream === 403) {
            return res.status(502).send("Service misconfigured. Please contact the operator.\n");
        }
        return res.status(502).send("All providers failed. Please try again.\n");
    }

    const clean = cleanResponse(result.text);
    if (clean.length === 0) {
        return res.status(502).send("Empty response from providers.\n");
    }

    if (clean.length <= CACHE_MAX_VALUE_LENGTH) {
        await safeCacheSet(key, clean);
    }

    return res.send(clean + "\n");
}