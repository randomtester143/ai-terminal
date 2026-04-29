export async function callGroq(prompt) {
    if (!process.env.GROQ_API_KEY) {
        return "ERROR: Missing GROQ_API_KEY";
    }

    try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            })
        });

        const text = await res.text();

        if (!res.ok) {
            return `GROQ ERROR:\n${text}`;
        }

        const data = JSON.parse(text);
        return data?.choices?.[0]?.message?.content || "GROQ: Empty response";

    } catch (e) {
        return "GROQ FETCH ERROR: " + e.message;
    }
}

export async function callHF(prompt) {
    if (!process.env.HF_TOKEN) {
        return "ERROR: Missing HF_TOKEN";
    }

    try {
        const res = await fetch(
            "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.HF_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ inputs: prompt })
            }
        );

        const text = await res.text();

        if (!res.ok) {
            return `HF ERROR:\n${text}`;
        }

        const data = JSON.parse(text);
        return data?.[0]?.generated_text || "HF: Empty response";

    } catch (e) {
        return "HF FETCH ERROR: " + e.message;
    }
}