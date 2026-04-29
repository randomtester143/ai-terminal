const REQUEST_TIMEOUT_MS = 8000;
const MAX_OUTPUT_LENGTH = 8000;

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export async function callGroq(prompt) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error("groq_missing_key");
        return { ok: false, error: "missing_key" };
    }

    try {
        const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 1024,
            }),
        });

        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            console.error("groq_http_error", res.status, errBody.slice(0, 200));
            return { ok: false, error: `http_${res.status}` };
        }

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) return { ok: false, error: "empty_response" };

        return { ok: true, text: text.slice(0, MAX_OUTPUT_LENGTH) };
    } catch (e) {
        const reason = e?.name === "AbortError" ? "timeout" : "fetch_error";
        console.error("groq_exception", reason, e?.message);
        return { ok: false, error: reason };
    }
}

export async function callHF(prompt) {
    const apiKey = process.env.HF_TOKEN;
    if (!apiKey) {
        console.error("hf_missing_key");
        return { ok: false, error: "missing_key" };
    }

    try {
        const res = await fetchWithTimeout(
            "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    inputs: prompt,
                    parameters: {
                        max_new_tokens: 512,
                        return_full_text: false,
                    },
                }),
            }
        );

        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            console.error("hf_http_error", res.status, errBody.slice(0, 200));
            return { ok: false, error: `http_${res.status}` };
        }

        const data = await res.json();
        const text =
            (Array.isArray(data) ? data[0]?.generated_text : data?.generated_text)?.trim();

        if (!text) return { ok: false, error: "empty_response" };

        return { ok: true, text: text.slice(0, MAX_OUTPUT_LENGTH) };
    } catch (e) {
        const reason = e?.name === "AbortError" ? "timeout" : "fetch_error";
        console.error("hf_exception", reason, e?.message);
        return { ok: false, error: reason };
    }
}