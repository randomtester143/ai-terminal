import crypto from "node:crypto";

export function hash(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}