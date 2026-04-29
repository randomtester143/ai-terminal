const REQUEST_TIMEOUT_MS = 6000;
const MAX_OUTPUT_LENGTH = 8000;
const MAX_TOKENS = 1024;

const GROQ_MODEL = "llama-3.1-8b-instant";
const HF_MODEL = "mistralai/Mistral-7B-Instruct-v0.2";

export const MODEL_VERSION = `${GROQ_MODEL}+${HF_MODEL}`;

// Permanent failures should not trigger fallback — they indicate misconfiguration
// or invalid input, not an upstream incident.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function classify(status) {
    if (PERMANENT_STATUSES.has(status)) return "permanent";
    return "transient";
}

export async function callGroq(prompt, systemPrompt) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error("groq_missing_key");
        return { ok: false, error: "missing_key", permanent: true };
    }

    try {
        const res = await fetchWithTimeout(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt },
                    ],
                    max_tokens: MAX_TOKENS,
                    temperature: 0.3,
                }),
            }
        );

        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            console.error("groq_http_error", res.status, errBody.slice(0, 200));
            return {
                ok: false,
                error: `http_${res.status}`,
                status: res.status,
                permanent: classify(res.status) === "permanent",
            };
        }

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) return { ok: false, error: "empty_response", permanent: false };

        return { ok: true, text: text.slice(0, MAX_OUTPUT_LENGTH) };
    } catch (e) {
        const reason = e?.name === "AbortError" ? "timeout" : "fetch_error";
        console.error("groq_exception", reason, e?.message);
        return { ok: false, error: reason, permanent: false };
    }
}

export async function callHF(prompt, systemPrompt) {
    const apiKey = process.env.HF_TOKEN;
    if (!apiKey) {
        console.error("hf_missing_key");
        return { ok: false, error: "missing_key", permanent: true };
    }

    // Mistral-Instruct expects [INST] ... [/INST]. System prompt is folded into
    // the instruction block per Mistral's documented chat template.
    const composed =
        `[INST] <<SYS>>\n${systemPrompt}\n<</SYS>>\n\n${prompt} [/INST]`;

    try {
        const res = await fetchWithTimeout(
            `https://api-inference.huggingface.co/models/${HF_MODEL}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    inputs: composed,
                    parameters: {
                        max_new_tokens: MAX_TOKENS,
                        return_full_text: false,
                        temperature: 0.3,
                    },
                    options: { wait_for_model: true },
                }),
            }
        );

        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            console.error("hf_http_error", res.status, errBody.slice(0, 200));
            return {
                ok: false,
                error: `http_${res.status}`,
                status: res.status,
                permanent: classify(res.status) === "permanent",
            };
        }

        const data = await res.json();

        // HF can return { error: "..." } with HTTP 200 (e.g., model loading)
        if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
            console.error("hf_payload_error", String(data.error).slice(0, 200));
            return { ok: false, error: "payload_error", permanent: false };
        }

        const raw = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
        const text = typeof raw === "string" ? raw.trim() : "";
        if (!text) return { ok: false, error: "empty_response", permanent: false };

        return { ok: true, text: text.slice(0, MAX_OUTPUT_LENGTH) };
    } catch (e) {
        const reason = e?.name === "AbortError" ? "timeout" : "fetch_error";
        console.error("hf_exception", reason, e?.message);
        return { ok: false, error: reason, permanent: false };
    }
}

// Orchestrator: tries Groq, falls back to HF only on transient failures.
export async function generateAnswer(prompt, systemPrompt) {
    const groq = await callGroq(prompt, systemPrompt);
    if (groq.ok) return { ok: true, text: groq.text, provider: "groq" };

    if (groq.permanent) {
        return { ok: false, error: groq.error, status: groq.status, provider: "groq" };
    }

    const hf = await callHF(prompt, systemPrompt);
    if (hf.ok) return { ok: true, text: hf.text, provider: "hf" };

    return { ok: false, error: hf.error || groq.error, status: hf.status, provider: "hf" };
}