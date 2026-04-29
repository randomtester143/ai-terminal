import { Redis } from "@upstash/redis";

const REQUIRED = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const missing = REQUIRED.filter((k) => !process.env[k]);

if (missing.length > 0) {
    console.error("redis_env_missing", missing.join(","));
}

export const redis = Redis.fromEnv();
export const REDIS_OK = missing.length === 0;
