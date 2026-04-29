// Provider timeouts are deliberately conservative:
// Groq: 5s, HF: 8s. Combined worst case ~13s which fits within
// Vercel's 15s hobby / 30s pro serverless limit.
// If you are on Hobby and see 504s, reduce HF_TIMEOUT_MS to 5000.
const GROQ_TIMEOUT_MS = 5000;
const HF_TIMEOUT_MS = 8000;
const MAX_OUTPUT_LENGTH = 8000;
const MAX_TOKENS = 1024;

// llama-3.1-8b-instant was deprecated on Groq; use the current fast model.
const GROQ_MODEL = "llama-3.3-70b-versatile";
// Using the Mistral v0.2 model via HF inference API
const HF_MODEL = "mistralai/Mistral-7B-Instruct-v0.2";

export const MODEL_VERSION = `${GROQ_MODEL}+${HF_MODEL}`;

const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function classify(status) {
    return PERMANENT_STATUSES.has(status) ? "permanent" : "transient";
}

export async function callGroq(messages, systemPrompt) {
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
                        ...messages,
                    ],
                    max_tokens: MAX_TOKENS,
                    temperature: 0.3,
                }),
            },
            GROQ_TIMEOUT_MS
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

export async function callHF(messages, systemPrompt) {
    const apiKey = process.env.HF_TOKEN;
    if (!apiKey) {
        console.error("hf_missing_key");
        return { ok: false, error: "missing_key", permanent: true };
    }

    // Mistral-7B-Instruct-v0.2 correct chat template.
    // Does NOT use <<SYS>> (Llama-2 style) — inject system as first user turn.
    // Format: [INST] {system}\n\n{user} [/INST] {assistant} [INST] {user} [/INST]
    let composed = "";
    let systemInjected = false;

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "user") {
            if (!systemInjected) {
                composed += `[INST] ${systemPrompt}\n\n${m.content} [/INST]`;
                systemInjected = true;
            } else {
                composed += ` [INST] ${m.content} [/INST]`;
            }
        } else if (m.role === "assistant") {
            composed += ` ${m.content}`;
        }
    }

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
                    // wait_for_model: true removed — causes 20-40s cold start → Vercel timeout
                    options: { use_cache: true },
                }),
            },
            HF_TIMEOUT_MS
        );

        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            // 503 = model loading — caller should surface this gracefully
            console.error("hf_http_error", res.status, errBody.slice(0, 200));
            return {
                ok: false,
                error: res.status === 503 ? "model_loading" : `http_${res.status}`,
                status: res.status,
                permanent: classify(res.status) === "permanent",
            };
        }

        const data = await res.json();

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

export async function generateAnswer(messages, systemPrompt) {
    const groq = await callGroq(messages, systemPrompt);
    if (groq.ok) return { ok: true, text: groq.text, provider: "groq" };

    // Don't fall back on permanent errors (bad key, invalid request)
    if (groq.permanent) {
        return { ok: false, error: groq.error, status: groq.status, provider: "groq" };
    }

    // Transient Groq failure → try HF
    const hf = await callHF(messages, systemPrompt);
    if (hf.ok) return { ok: true, text: hf.text, provider: "hf" };

    return {
        ok: false,
        error: hf.error || groq.error,
        status: hf.status,
        provider: "hf",
        hfModelLoading: hf.error === "model_loading",
    };
}
