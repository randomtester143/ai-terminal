// Heuristic intent detection. Runs synchronously before any LLM call.
// Returns one of: "code", "command", "explanation", "general".

const CODE_VERBS = /\b(write|create|generate|build|implement|code|program|make|give\s+me|show\s+me)\b/i;
const CODE_NOUNS = /\b(function|class|script|program|algorithm|snippet|method|module|component|loop|recursion|sort|search|parser|regex|api|endpoint|server|client|app|cli|crud|game)\b/i;
const ALGO_NAMES = /\b(binary\s+search|linear\s+search|bubble\s+sort|quick\s+sort|merge\s+sort|insertion\s+sort|dijkstra|bfs|dfs|fizzbuzz|fibonacci|factorial|palindrome|hello\s+world)\b/i;

const COMMAND_HINTS = /\b(command|cli|terminal|bash|shell|powershell|cmd|how\s+do\s+i|how\s+to)\b.*\b(install|run|kill|list|find|grep|ssh|curl|git|docker|kubectl|npm|pip|apt|brew|chmod|chown|tar|zip)\b/i;
const COMMAND_DIRECT = /^(how\s+(do\s+i|to)\s+)?(install|run|kill|list|find|grep|ssh|curl|git|docker|kubectl|npm|pip|apt|brew|chmod|chown|tar|zip)\b/i;

const EXPLAIN_VERBS = /\b(explain|what\s+is|what\s+are|why|how\s+does|describe|define|tell\s+me\s+about|difference\s+between|compare)\b/i;

const LANGUAGES = [
    "python", "py", "javascript", "js", "typescript", "ts", "java", "kotlin",
    "c\\+\\+", "cpp", "c#", "csharp", "c", "go", "golang", "rust", "ruby", "rb",
    "php", "swift", "scala", "haskell", "elixir", "erlang", "clojure", "lua",
    "perl", "bash", "shell", "sh", "powershell", "ps1", "sql", "html", "css",
    "r", "matlab", "dart", "objective-c", "f#", "fsharp", "ocaml", "zig", "nim",
    "julia", "groovy", "vb", "vbnet", "assembly", "asm",
];

const LANGUAGE_REGEX = new RegExp(
    `\\b(in\\s+|using\\s+|with\\s+)?(${LANGUAGES.join("|")})\\b`,
    "i"
);

const CANONICAL = {
    py: "Python", python: "Python",
    js: "JavaScript", javascript: "JavaScript",
    ts: "TypeScript", typescript: "TypeScript",
    rb: "Ruby", ruby: "Ruby",
    cpp: "C++", "c++": "C++",
    csharp: "C#", "c#": "C#",
    golang: "Go", go: "Go",
    sh: "Bash", shell: "Bash", bash: "Bash",
    ps1: "PowerShell", powershell: "PowerShell",
    fsharp: "F#", "f#": "F#",
    vbnet: "VB.NET", vb: "VB.NET",
    asm: "Assembly", assembly: "Assembly",
};

function canonicalLanguage(token) {
    const t = token.toLowerCase();
    return CANONICAL[t] || t.charAt(0).toUpperCase() + t.slice(1);
}

export function detectLanguage(prompt) {
    const m = prompt.match(LANGUAGE_REGEX);
    if (!m) return null;
    return canonicalLanguage(m[2]);
}

export function detectIntent(prompt) {
    const text = prompt.trim();

    if (COMMAND_DIRECT.test(text) || COMMAND_HINTS.test(text)) {
        return { kind: "command", language: null };
    }

    const looksLikeCode =
        (CODE_VERBS.test(text) && CODE_NOUNS.test(text)) ||
        ALGO_NAMES.test(text) ||
        /\bcode\b/i.test(text);

    if (looksLikeCode) {
        return { kind: "code", language: detectLanguage(text) };
    }

    if (EXPLAIN_VERBS.test(text)) {
        return { kind: "explanation", language: null };
    }

    return { kind: "general", language: null };
}

export function systemPromptFor(intent) {
    const base =
        "You are a CLI assistant. Output plain text only. " +
        "Never use markdown: no asterisks for bold/italic, no backtick fences, no headers, no bullet symbols. " +
        "Do not include conversational filler like 'Sure', 'Of course', or 'Here is'. " +
        "Be direct and concise.";

    if (intent.kind === "code") {
        return (
            base +
            ` Write a complete, working ${intent.language} solution. ` +
            "Output only the code itself with proper indentation. " +
            "Do not wrap the code in backtick fences. " +
            "Do not add prose explanations before or after the code. " +
            "Brief inline code comments are allowed using the language's native comment syntax."
        );
    }

    if (intent.kind === "command") {
        return (
            base +
            " Provide the exact command on its own line. " +
            "Add at most one short line of context if strictly necessary. " +
            "No prose preamble."
        );
    }

    if (intent.kind === "explanation") {
        return (
            base +
            " Explain in clear plain prose. " +
            "Use short paragraphs separated by blank lines. " +
            "No lists, no headers, no markdown."
        );
    }

    return base + " Respond in plain prose.";
}
