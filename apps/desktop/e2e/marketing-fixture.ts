import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  BoardMetaStore,
  GenerationStore,
  RoundRecordStore,
  SessionStore,
  WhiteboardClient,
} from "@rennet/adapters";
import { WsRennetBridge } from "@rennet/client";
import {
  type BoardDocument,
  generationIdForPatchset,
  type HostElement,
  LENS_KINDS,
  type LensKind,
} from "@rennet/protocol";
import { createBoardsRuntime } from "@rennet/server";
import { git, initRepo, makeTempDir, writeRepoFile } from "./harness";

/**
 * The marketing screenshot fixture (#470): an invented but plausible service, `atlas`, whose
 * `feat/rate-limiting` branch adds per-organisation rate limiting, and the review board a
 * settled council run over that branch would leave behind. Nothing here is a client
 * repository, a real pull request, or anyone's data; the code is written for this file.
 *
 * The board is authored to the shipped vocabulary (`HostElement`, the per-lens kind tables)
 * and seeded through the production board writer, so the app renders it exactly as it
 * renders a real drafting result. Every `code_ref` is resolved by LOOKING UP the cited
 * line in the fixture file, so a line number on the board can never drift from the code.
 */

// ── The repository ──────────────────────────────────────────────────────────

const PACKAGE_JSON_MAIN = `{
  "name": "atlas",
  "version": "0.4.2",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "22.10.2",
    "typescript": "5.7.2",
    "vitest": "2.1.8"
  }
}
`;

const PACKAGE_JSON_HEAD = `{
  "name": "atlas",
  "version": "0.4.2",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "ioredis": "5.4.1"
  },
  "devDependencies": {
    "@types/node": "22.10.2",
    "typescript": "5.7.2",
    "vitest": "2.1.8"
  }
}
`;

const LOCK_MAIN = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@types/node':
        specifier: 22.10.2
        version: 22.10.2
      typescript:
        specifier: 5.7.2
        version: 5.7.2
      vitest:
        specifier: 2.1.8
        version: 2.1.8(@types/node@22.10.2)
`;

const LOCK_HEAD = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      ioredis:
        specifier: 5.4.1
        version: 5.4.1
    devDependencies:
      '@types/node':
        specifier: 22.10.2
        version: 22.10.2
      typescript:
        specifier: 5.7.2
        version: 5.7.2
      vitest:
        specifier: 2.1.8
        version: 2.1.8(@types/node@22.10.2)

packages:

  '@ioredis/commands@1.2.0':
    resolution: {integrity: sha512-Sx1pU8EM64o2BrqNpEO1CNLtKQwyhuXuqyfH7oGKCk+1a33d2r5saW8zNwm3j6BTExtjrv2BxTgzzkMwts6vGg==}

  cluster-key-slot@1.1.2:
    resolution: {integrity: sha512-RMr0FhtfXemyinomL4hrWcYJxmX6deFdCxpJzhDttxgO1+bcCnkk+9drydLVDmAMG7NE6aN/fl4F7ucU/90gAA==}
    engines: {node: '>=0.10.0'}

  denque@2.1.0:
    resolution: {integrity: sha512-HVQE3AAb/pxF8fQAoiqpvg9i3evqug3hoiwakOyZAwJm+6vZehbkYXZ0l4JxS+I3QxM97v5aaRNhj8v5oBhekw==}
    engines: {node: '>=0.10'}

  ioredis@5.4.1:
    resolution: {integrity: sha512-2YZsvl7jopIa1gaePkeMtd9rAcSjOOjPtpcLlOeusyO+XH2SK5ZcT+UCrElPP+WVIInh2TzeI4XW9ENaSLVVHA==}
    engines: {node: '>=12.22.0'}

  lodash.defaults@4.2.0:
    resolution: {integrity: sha512-qjxPLHd3r5DnsdGacqOMU6pb/avJzdh9tFX2ymgoZE27BmjXrNy/y4LoaiTeAb+O3gL8AfpJGtqfX/ae2leYYQ==}

  lodash.isarguments@3.1.0:
    resolution: {integrity: sha512-chi4NHZlZqZD18a0imDHnZPrDeBbTtVN7GXMwuGdRH9qotxAjYs3aVLKc7zNOG9eddR5Ksd8rvFEBc9SsggPpg==}

  redis-errors@1.2.0:
    resolution: {integrity: sha512-1qny3OExCf0UvUV/5wpYKf2YwPcOqXzkwKKSmKHiE6ZMQs5heeE/c8eXK+PNllPvmjgAbfnsbpkGZWy8cBpn9w==}
    engines: {node: '>=4'}

  redis-parser@3.0.0:
    resolution: {integrity: sha512-DJnGAeenTdpMEH6uAJRK/uiyEIH9WVsUmoLwzudwGJUwZPp80PDBWPHXSAGNPwNvIXAbe7MSUB1zQFugFml66A==}
    engines: {node: '>=4'}

  standard-as-callback@2.1.0:
    resolution: {integrity: sha512-qoRRSyROncaz1z0mvYqIE4lCd9p2R90i6GxW3uZv5ucSu8tU7B5HXUP1gG8pVZsYNVaXjk8ClXHPttLyxAL48A==}
`;

const CONFIG_MAIN = `export interface Config {
  readonly port: number;
  readonly redisUrl: string | undefined;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(\`\${name} must be an integer, got "\${raw}"\`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: integer("PORT", 8080),
    redisUrl: process.env.REDIS_URL,
  };
}
`;

const CONFIG_HEAD = `export interface Config {
  readonly port: number;
  readonly redisUrl: string | undefined;
  readonly rateLimit: {
    /** Sustained requests per minute, per organisation. */
    readonly perMinute: number;
    /** How many requests an idle organisation may send at once. */
    readonly burst: number;
  };
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(\`\${name} must be an integer, got "\${raw}"\`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: integer("PORT", 8080),
    redisUrl: process.env.REDIS_URL,
    rateLimit: {
      perMinute: integer("RATE_LIMIT_PER_MINUTE", 600),
      burst: integer("RATE_LIMIT_BURST", 100),
    },
  };
}
`;

const HTTP = `import type { ServerResponse } from "node:http";

export interface Request {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly org: { readonly id: string } | undefined;
}

export type Handler = (request: Request, response: ServerResponse) => Promise<void>;
export type Middleware = (next: Handler) => Handler;

/** Every error atlas returns is a JSON object with an \`error\` string. */
export function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
`;

const AUTH_MAIN = `import type { Middleware } from "../http.js";
import { json } from "../http.js";

/** Resolve the organisation from the bearer token; a missing token is a 401. */
export const auth: Middleware = (next) => async (request, response) => {
  const header = request.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\\s+/i, "") : undefined;
  if (token === undefined || token.length === 0) {
    json(response, 401, { error: "missing bearer token" });
    return;
  }
  await next({ ...request, org: { id: orgFor(token) } }, response);
};

function orgFor(token: string): string {
  return token.split(".")[0] ?? "anonymous";
}
`;

const AUTH_HEAD = `import { json, type Middleware } from "../http.js";

/** Resolve the organisation from the bearer token; a missing token is a 401. */
export const auth: Middleware = (next) => async (request, response) => {
  const header = request.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\\s+/i, "") : undefined;
  if (token === undefined || token.length === 0) {
    json(response, 401, { error: "missing bearer token" });
    return;
  }
  await next({ ...request, org: { id: orgFor(token) } }, response);
};

function orgFor(token: string): string {
  return token.split(".")[0] ?? "anonymous";
}
`;

const SERVER_MAIN = `import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { type Handler, json } from "./http.js";
import { auth } from "./middleware/auth.js";

const routes: Handler = async (request, response) => {
  if (request.method === "GET" && request.path === "/v1/health") {
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: "not found" });
};

export function buildHandler(): Handler {
  return auth(routes);
}

export function start(): void {
  const config = loadConfig();
  const handler = buildHandler();
  createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    void handler(
      {
        method: incoming.method ?? "GET",
        path: url.pathname,
        headers: incoming.headers,
        org: undefined,
      },
      response,
    );
  }).listen(config.port);
}
`;

const SERVER_HEAD = `import { createServer } from "node:http";
import { Redis } from "ioredis";
import { type Config, loadConfig } from "./config.js";
import { type Handler, json } from "./http.js";
import { auth } from "./middleware/auth.js";
import { rateLimit } from "./rate-limit/middleware.js";
import { type BucketStore, failOpen, MemoryStore, RedisStore } from "./rate-limit/store.js";

const routes: Handler = async (request, response) => {
  if (request.method === "GET" && request.path === "/v1/health") {
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: "not found" });
};

/** The only place atlas touches ioredis: the store behind it speaks \`RedisLike\`. */
function bucketStore(config: Config): BucketStore {
  const store =
    config.redisUrl === undefined ? new MemoryStore() : new RedisStore(new Redis(config.redisUrl));
  return failOpen(store, (error) => {
    console.error("rate-limit store unavailable, allowing request", error);
  });
}

export function buildHandler(config: Config): Handler {
  const limiter = rateLimit({
    store: bucketStore(config),
    policy: {
      ratePerSecond: config.rateLimit.perMinute / 60,
      burst: config.rateLimit.burst,
    },
  });
  return auth(limiter(routes));
}

export function start(): void {
  const config = loadConfig();
  const handler = buildHandler(config);
  createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    void handler(
      {
        method: incoming.method ?? "GET",
        path: url.pathname,
        headers: incoming.headers,
        org: undefined,
      },
      response,
    );
  }).listen(config.port);
}
`;

const BUCKET = `/**
 * A token bucket that refills when it is READ, not on a timer: an organisation that
 * sends nothing costs nothing, and there is no sweeper to keep alive across replicas.
 */
export interface Bucket {
  readonly tokens: number;
  readonly refilledAt: number;
}

export interface BucketPolicy {
  /** Tokens added per second of wall-clock time. */
  readonly ratePerSecond: number;
  /** The most tokens the bucket holds; also the size of an allowed burst. */
  readonly burst: number;
}

export interface Decision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Whole seconds until one token is available again; 0 when allowed. */
  readonly retryAfterSeconds: number;
  readonly bucket: Bucket;
}

/** Refill \`bucket\` up to \`now\`, then take one token if there is one to take. */
export function take(bucket: Bucket | undefined, policy: BucketPolicy, now: number): Decision {
  const previous = bucket ?? { tokens: policy.burst, refilledAt: now };
  const elapsedSeconds = Math.max(0, now - previous.refilledAt) / 1000;
  const tokens = Math.min(policy.burst, previous.tokens + elapsedSeconds * policy.ratePerSecond);
  if (tokens >= 1) {
    const next = { tokens: tokens - 1, refilledAt: now };
    return {
      allowed: true,
      remaining: Math.floor(next.tokens),
      retryAfterSeconds: 0,
      bucket: next,
    };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.ceil((1 - tokens) / policy.ratePerSecond),
    bucket: { tokens, refilledAt: now },
  };
}
`;

const STORE = `import type { Bucket } from "./bucket.js";

/**
 * Where buckets live. \`MemoryStore\` is per process and right for one replica; the
 * Redis store is shared, so every replica limits against the same bucket.
 */
export interface BucketStore {
  get(key: string): Promise<Bucket | undefined>;
  set(key: string, bucket: Bucket, ttlSeconds: number): Promise<void>;
}

export class MemoryStore implements BucketStore {
  private readonly buckets = new Map<string, Bucket>();

  async get(key: string): Promise<Bucket | undefined> {
    return this.buckets.get(key);
  }

  async set(key: string, bucket: Bucket): Promise<void> {
    this.buckets.set(key, bucket);
  }
}

/** The two ioredis calls the store makes, so nothing under \`src/rate-limit\` imports ioredis. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

export class RedisStore implements BucketStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "atlas:ratelimit:",
  ) {}

  async get(key: string): Promise<Bucket | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isBucket(parsed) ? parsed : undefined;
  }

  async set(key: string, bucket: Bucket, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(bucket), "EX", ttlSeconds);
  }
}

function isBucket(value: unknown): value is Bucket {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Bucket).tokens === "number" &&
    typeof (value as Bucket).refilledAt === "number"
  );
}

/**
 * Wrap a store so a failed read or write never blocks a request. A store outage
 * degrades to "no limit" rather than to "no service"; \`onError\` is the only trace.
 */
export function failOpen(store: BucketStore, onError: (error: unknown) => void): BucketStore {
  return {
    get: (key) =>
      store.get(key).catch((error: unknown) => {
        onError(error);
        return undefined;
      }),
    set: (key, bucket, ttlSeconds) => store.set(key, bucket, ttlSeconds).catch(onError),
  };
}
`;

const MIDDLEWARE = `import { json, type Middleware } from "../http.js";
import { type BucketPolicy, take } from "./bucket.js";
import type { BucketStore } from "./store.js";

export interface RateLimitOptions {
  readonly store: BucketStore;
  readonly policy: BucketPolicy;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
}

/**
 * Limit requests per organisation. A request with no organisation passes through
 * untouched: \`auth\` runs first and has already rejected it if it needed rejecting.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const now = options.now ?? Date.now;
  const ttlSeconds = Math.ceil(options.policy.burst / options.policy.ratePerSecond) + 1;
  return (next) => async (request, response) => {
    if (request.org === undefined) {
      await next(request, response);
      return;
    }
    const key = \`org:\${request.org.id}\`;
    const decision = take(await options.store.get(key), options.policy, now());
    await options.store.set(key, decision.bucket, ttlSeconds);
    response.setHeader("x-ratelimit-limit", String(options.policy.burst));
    response.setHeader("x-ratelimit-remaining", String(decision.remaining));
    if (!decision.allowed) {
      response.setHeader("retry-after", String(decision.retryAfterSeconds));
      response.statusCode = 429;
      response.end("rate limit exceeded");
      return;
    }
    await next(request, response);
  };
}
`;

const RATE_LIMIT_TEST = `import { describe, expect, it } from "vitest";
import { take } from "../src/rate-limit/bucket.js";
import { rateLimit } from "../src/rate-limit/middleware.js";
import { failOpen, MemoryStore } from "../src/rate-limit/store.js";
import { fakeResponse, request } from "./helpers.js";

const policy = { ratePerSecond: 10, burst: 3 };

describe("take", () => {
  it("starts a new organisation with a full burst", () => {
    const decision = take(undefined, policy, 0);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2);
  });

  it("refills on read at the configured rate", () => {
    let bucket = take(undefined, policy, 0).bucket;
    bucket = take(bucket, policy, 0).bucket;
    bucket = take(bucket, policy, 0).bucket;
    expect(take(bucket, policy, 0).allowed).toBe(false);
    expect(take(bucket, policy, 100).allowed).toBe(true);
  });

  it("reports whole seconds until the next token", () => {
    const empty = { tokens: 0, refilledAt: 0 };
    expect(take(empty, { ratePerSecond: 0.5, burst: 1 }, 0).retryAfterSeconds).toBe(2);
  });
});

describe("rateLimit", () => {
  it("answers 429 with Retry-After once the burst is spent", async () => {
    let clock = 1_000;
    const handler = rateLimit({ store: new MemoryStore(), policy, now: () => clock })(
      async (_request, response) => response.end("ok"),
    );
    for (let index = 0; index < 3; index += 1) {
      const response = fakeResponse();
      await handler(request({ org: "acme" }), response);
      expect(response.statusCode).toBe(200);
    }
    const limited = fakeResponse();
    await handler(request({ org: "acme" }), limited);
    expect(limited.statusCode).toBe(429);
    expect(limited.getHeader("retry-after")).toBe("1");
    clock += 100;
    const recovered = fakeResponse();
    await handler(request({ org: "acme" }), recovered);
    expect(recovered.statusCode).toBe(200);
  });

  it("keeps organisations apart", async () => {
    const handler = rateLimit({ store: new MemoryStore(), policy, now: () => 0 })(
      async (_request, response) => response.end("ok"),
    );
    for (let index = 0; index < 3; index += 1) {
      await handler(request({ org: "acme" }), fakeResponse());
    }
    const other = fakeResponse();
    await handler(request({ org: "globex" }), other);
    expect(other.statusCode).toBe(200);
  });

  it("allows the request when the store throws", async () => {
    const errors: unknown[] = [];
    const broken = failOpen(
      {
        get: async () => {
          throw new Error("ECONNREFUSED");
        },
        set: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
      (error) => errors.push(error),
    );
    const handler = rateLimit({ store: broken, policy, now: () => 0 })(
      async (_request, response) => response.end("ok"),
    );
    const response = fakeResponse();
    await handler(request({ org: "acme" }), response);
    expect(response.statusCode).toBe(200);
    expect(errors).toHaveLength(2);
  });
});
`;

const TEST_HELPERS = `import type { ServerResponse } from "node:http";
import type { Request } from "../src/http.js";

export function request(options: { org?: string } = {}): Request {
  return {
    method: "GET",
    path: "/v1/health",
    headers: {},
    org: options.org === undefined ? undefined : { id: options.org },
  };
}

/** The slice of ServerResponse the handlers touch, recorded instead of written to a socket. */
export function fakeResponse(): ServerResponse {
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    body: "",
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return response;
    },
    getHeader: (name: string) => headers.get(name),
    end(chunk?: string) {
      response.body = chunk ?? "";
      return response;
    },
  };
  return response as unknown as ServerResponse;
}
`;

const SERVER_TEST_MAIN = `import { describe, expect, it } from "vitest";
import { buildHandler } from "../src/server.js";
import { fakeResponse, request } from "./helpers.js";

describe("routes", () => {
  it("rejects a request with no bearer token", async () => {
    const response = fakeResponse();
    await buildHandler()(request(), response);
    expect(response.statusCode).toBe(401);
  });
});
`;

const SERVER_TEST_HEAD = `import { describe, expect, it } from "vitest";
import { buildHandler } from "../src/server.js";
import { fakeResponse, request } from "./helpers.js";

const config = {
  port: 0,
  redisUrl: undefined,
  rateLimit: { perMinute: 600, burst: 100 },
};

describe("routes", () => {
  it("rejects a request with no bearer token", async () => {
    const response = fakeResponse();
    await buildHandler(config)(request(), response);
    expect(response.statusCode).toBe(401);
  });
});
`;

const API_MAIN = `# atlas API

All endpoints live under \`/v1\` and require a bearer token. The token's first segment
names the organisation the request is made on behalf of.

## Errors

Every error is a JSON object with one \`error\` string:

\`\`\`json
{ "error": "missing bearer token" }
\`\`\`

| Status | Meaning |
| --- | --- |
| 401 | No bearer token, or an empty one. |
| 404 | No such endpoint. |

## Endpoints

### \`GET /v1/health\`

Answers \`{ "ok": true }\`.
`;

const API_HEAD = `# atlas API

All endpoints live under \`/v1\` and require a bearer token. The token's first segment
names the organisation the request is made on behalf of.

## Errors

Every error is a JSON object with one \`error\` string:

\`\`\`json
{ "error": "missing bearer token" }
\`\`\`

| Status | Meaning |
| --- | --- |
| 401 | No bearer token, or an empty one. |
| 404 | No such endpoint. |
| 429 | The organisation has exceeded its rate limit. Retry after \`Retry-After\` seconds. |

## Rate limits

Requests are limited per organisation with a token bucket: \`RATE_LIMIT_BURST\` requests
may be sent at once (default 100) and the bucket refills at \`RATE_LIMIT_PER_MINUTE\`
(default 600). Every authenticated response carries:

| Header | Meaning |
| --- | --- |
| \`X-RateLimit-Limit\` | The burst size. |
| \`X-RateLimit-Remaining\` | Whole requests left before a 429. |
| \`Retry-After\` | On a 429 only: whole seconds until one request is allowed again. |

Limits are enforced across replicas when \`REDIS_URL\` is set. Without it each replica
keeps its own bucket, so the effective limit is the configured limit times the replica count.

## Endpoints

### \`GET /v1/health\`

Answers \`{ "ok": true }\`.
`;

const README = `# atlas

The organisation-facing API in front of the billing and usage services.

- \`pnpm test\` runs the suite.
- \`pnpm build && pnpm start\` serves on \`PORT\` (default 8080).
`;

export const SPEC_PATH = "openspec/changes/per-org-rate-limiting/specs/rate-limiting/spec.md";
const PROPOSAL_PATH = "openspec/changes/per-org-rate-limiting/proposal.md";

const PROPOSAL = `# Per-organisation rate limiting

## Why

Two organisations have twice taken the API down for everyone else by retrying a failing
batch job in a tight loop. There is no limit today; the only protection is the load
balancer's connection cap, which is global and blind to who is sending.

## What changes

- Every authenticated request is charged against the organisation's token bucket.
- Exceeding the bucket answers \`429\` with \`Retry-After\`; every response carries the
  remaining allowance.
- Buckets live in Redis when \`REDIS_URL\` is set, so replicas share one limit.
- If the bucket store is unavailable the request is allowed. Losing Redis must not turn
  into losing the API.
`;

const SPEC = `# rate-limiting Specification

## ADDED Requirements

### Requirement: Requests are limited per organisation

The API SHALL charge every authenticated request against a token bucket keyed by the
organisation the bearer token names, refilling at \`RATE_LIMIT_PER_MINUTE\` with a burst of
\`RATE_LIMIT_BURST\`.

#### Scenario: A burst is spent

- **WHEN** an organisation sends more than \`RATE_LIMIT_BURST\` requests before the bucket refills
- **THEN** the API answers \`429\` with a \`Retry-After\` header naming whole seconds until one request is allowed

#### Scenario: Organisations are independent

- **WHEN** one organisation is limited
- **THEN** another organisation's requests are unaffected

### Requirement: The allowance is visible on every response

Every authenticated response SHALL carry \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\`.

#### Scenario: A client reads its remaining allowance

- **WHEN** an organisation's request is allowed
- **THEN** \`X-RateLimit-Remaining\` is the number of further requests that would be allowed right now

### Requirement: A store outage does not block requests

The API SHALL allow a request when the bucket store cannot be read or written, and SHALL
record the failure.

#### Scenario: Redis is unreachable

- **WHEN** the bucket store throws on read or write
- **THEN** the request is handled as if it were within its allowance and the error is logged
`;

const STAMP_PATH = "openspec/changes/per-org-rate-limiting/.openspec.yaml";
const OPENSPEC_STAMP = `schema: spec-driven
created: 2026-09-08
`;

export const FIXTURE_FILES = {
  bucket: "src/rate-limit/bucket.ts",
  store: "src/rate-limit/store.ts",
  middleware: "src/rate-limit/middleware.ts",
  server: "src/server.ts",
  config: "src/config.ts",
  auth: "src/middleware/auth.ts",
  http: "src/http.ts",
  api: "docs/api.md",
  test: "test/rate-limit.test.ts",
  serverTest: "test/server.test.ts",
  helpers: "test/helpers.ts",
  packageJson: "package.json",
  lock: "pnpm-lock.yaml",
  spec: SPEC_PATH,
  proposal: PROPOSAL_PATH,
} as const;

/** The head-side content of every file a board element cites, for line lookup. */
const HEAD_CONTENT: Readonly<Record<string, string>> = {
  [FIXTURE_FILES.bucket]: BUCKET,
  [FIXTURE_FILES.store]: STORE,
  [FIXTURE_FILES.middleware]: MIDDLEWARE,
  [FIXTURE_FILES.server]: SERVER_HEAD,
  [FIXTURE_FILES.config]: CONFIG_HEAD,
  [FIXTURE_FILES.auth]: AUTH_HEAD,
  [FIXTURE_FILES.api]: API_HEAD,
  [FIXTURE_FILES.test]: RATE_LIMIT_TEST,
  [FIXTURE_FILES.serverTest]: SERVER_TEST_HEAD,
  [FIXTURE_FILES.packageJson]: PACKAGE_JSON_HEAD,
  [FIXTURE_FILES.lock]: LOCK_HEAD,
  [FIXTURE_FILES.spec]: SPEC,
  [FIXTURE_FILES.proposal]: PROPOSAL,
  [STAMP_PATH]: OPENSPEC_STAMP,
};

/**
 * Seed the `atlas` repository: `main` holds the service before rate limiting, and the
 * checked-out `feat/rate-limiting` branch carries the feature as two commits plus one
 * uncommitted edit (the test the implementer was still writing), so the capture shows
 * committed and working-tree change together.
 */
export function seedMarketingRepo(): string {
  // The project takes its name from the directory, so the checkout is `atlas` inside a
  // throwaway parent, never the parent's random suffix.
  const repository = join(makeTempDir("rennet-marketing-"), "atlas");
  mkdirSync(repository);
  initRepo(repository);
  writeRepoFile(repository, "README.md", README);
  writeRepoFile(repository, ".gitignore", "node_modules/\ndist/\n");
  writeRepoFile(repository, FIXTURE_FILES.packageJson, PACKAGE_JSON_MAIN);
  writeRepoFile(repository, FIXTURE_FILES.lock, LOCK_MAIN);
  writeRepoFile(
    repository,
    "tsconfig.json",
    '{\n  "compilerOptions": {\n    "target": "es2022",\n    "module": "nodenext",\n    "strict": true,\n    "outDir": "dist"\n  },\n  "include": ["src"]\n}\n',
  );
  writeRepoFile(repository, FIXTURE_FILES.config, CONFIG_MAIN);
  writeRepoFile(repository, FIXTURE_FILES.http, HTTP);
  writeRepoFile(repository, FIXTURE_FILES.auth, AUTH_MAIN);
  writeRepoFile(repository, FIXTURE_FILES.server, SERVER_MAIN);
  writeRepoFile(repository, FIXTURE_FILES.helpers, TEST_HELPERS);
  writeRepoFile(repository, FIXTURE_FILES.serverTest, SERVER_TEST_MAIN);
  git(repository, "add", "-A");
  git(repository, "commit", "-qm", "atlas: health endpoint behind bearer auth");
  writeRepoFile(repository, FIXTURE_FILES.api, API_MAIN);
  git(repository, "add", "-A");
  git(repository, "commit", "-qm", "docs: describe the error envelope");
  git(repository, "checkout", "-qb", "feat/rate-limiting");

  writeRepoFile(repository, FIXTURE_FILES.proposal, PROPOSAL);
  writeRepoFile(repository, FIXTURE_FILES.spec, SPEC);
  writeRepoFile(repository, STAMP_PATH, OPENSPEC_STAMP);
  writeRepoFile(repository, FIXTURE_FILES.bucket, BUCKET);
  writeRepoFile(repository, FIXTURE_FILES.store, STORE);
  writeRepoFile(repository, FIXTURE_FILES.middleware, MIDDLEWARE);
  git(repository, "add", "-A");
  git(repository, "commit", "-qm", "feat(rate-limit): token bucket, stores, middleware");

  writeRepoFile(repository, FIXTURE_FILES.config, CONFIG_HEAD);
  writeRepoFile(repository, FIXTURE_FILES.server, SERVER_HEAD);
  writeRepoFile(repository, FIXTURE_FILES.auth, AUTH_HEAD);
  writeRepoFile(repository, FIXTURE_FILES.packageJson, PACKAGE_JSON_HEAD);
  writeRepoFile(repository, FIXTURE_FILES.lock, LOCK_HEAD);
  writeRepoFile(repository, FIXTURE_FILES.api, API_HEAD);
  writeRepoFile(repository, FIXTURE_FILES.serverTest, SERVER_TEST_HEAD);
  git(repository, "add", "-A");
  git(repository, "commit", "-qm", "feat(rate-limit): wire per-org limiting into the server");

  // Still uncommitted: the suite the implementer was writing when the review started.
  writeRepoFile(repository, FIXTURE_FILES.test, RATE_LIMIT_TEST);
  return repository;
}

// ── The board ───────────────────────────────────────────────────────────────

const author = { kind: "lens-agent", id: "claude" } as const;

/** 1-based line of the first line in `path` (head side) containing `needle`. */
export function fixtureLine(path: string, needle: string, after = 0): number {
  return lineOf(path, needle, after);
}

function lineOf(path: string, needle: string, after = 0): number {
  const content = HEAD_CONTENT[path];
  if (content === undefined) throw new Error(`no fixture content for ${path}`);
  const lines = content.split("\n");
  const index = lines.findIndex((line, at) => at >= after && line.includes(needle));
  if (index === -1) throw new Error(`${path} has no line containing ${JSON.stringify(needle)}`);
  return index + 1;
}

function ref(
  id: string,
  patchsetId: string,
  path: string,
  from: string,
  to: string = from,
  symbol?: string,
): HostElement {
  const start = lineOf(path, from);
  const end = to === from ? start : lineOf(path, to, start - 1);
  return {
    id,
    kind: "code_ref",
    data: {
      author,
      patchset_id: patchsetId,
      path,
      side: "head",
      start_line: start,
      end_line: end,
      ...(symbol === undefined ? {} : { symbol }),
    },
  };
}

const prose = (id: string, markdown: string): HostElement => ({
  id,
  kind: "prose",
  data: { author, markdown },
});

const annotation = (id: string, codeRef: string, body: string): HostElement => ({
  id,
  kind: "annotation",
  data: { author, code_ref: codeRef, body },
});

const callout = (id: string, variant: string, body: string): HostElement => ({
  id,
  kind: "callout",
  data: { author, variant, body },
});

const section = (
  id: string,
  title: string,
  gist: string,
  children: readonly string[],
  extra: Record<string, unknown> = {},
): HostElement => ({
  id,
  kind: "section",
  data: { author, title, gist, children: [...children], delta: "new", ...extra },
});

interface LensFixture {
  readonly document: BoardDocument;
  readonly elements: readonly HostElement[];
}

const BOTH = [
  { model: "claude", agree: 1, total: 1 },
  { model: "codex", agree: 1, total: 1 },
];
const CLAUDE_ONLY = [
  { model: "claude", agree: 1, total: 1 },
  { model: "codex", agree: 0, total: 1 },
];

function sequence(patchsetId: string): LensFixture {
  const F = FIXTURE_FILES;
  const refs = [
    ref(
      "seq-ref-spec",
      patchsetId,
      F.spec,
      "### Requirement: Requests are limited",
      "#### Scenario: Organisations are independent",
    ),
    ref("seq-ref-api", patchsetId, F.api, "## Rate limits", "| `Retry-After`"),
    ref(
      "seq-ref-take",
      patchsetId,
      F.bucket,
      "export function take(",
      "retryAfterSeconds: Math.ceil",
      "take",
    ),
    ref(
      "seq-ref-clamp",
      patchsetId,
      F.bucket,
      "const elapsedSeconds = Math.max(",
      "const tokens = Math.min(",
    ),
    ref(
      "seq-ref-store",
      patchsetId,
      F.store,
      "export interface BucketStore",
      "set(key: string, bucket: Bucket, ttlSeconds",
      "BucketStore",
    ),
    ref(
      "seq-ref-failopen",
      patchsetId,
      F.store,
      "export function failOpen(",
      "set: (key, bucket, ttlSeconds)",
      "failOpen",
    ),
    ref(
      "seq-ref-middleware",
      patchsetId,
      F.middleware,
      "export function rateLimit(",
      "  };",
      "rateLimit",
    ),
    ref(
      "seq-ref-server",
      patchsetId,
      F.server,
      "function bucketStore(config",
      "return auth(limiter(routes));",
    ),
    ref("seq-ref-config", patchsetId, F.config, "readonly rateLimit: {", "readonly burst: number;"),
    ref(
      "seq-ref-test",
      patchsetId,
      F.test,
      'describe("rateLimit"',
      "expect(recovered.statusCode).toBe(200);",
    ),
  ];
  const steps: HostElement[] = [
    {
      id: "seq-step-contract",
      kind: "order_step",
      data: {
        author,
        title: "Start with what the branch promises: three requirements and a new 429",
        span: "seq-ref-spec",
        children: ["seq-prose-contract"],
      },
    },
    {
      id: "seq-step-bucket",
      kind: "order_step",
      data: {
        author,
        title: "The bucket: refill on read, then take one token",
        span: "seq-ref-take",
        children: ["seq-prose-bucket", "seq-anno-refill"],
      },
    },
    {
      id: "seq-step-store",
      kind: "order_step",
      data: {
        author,
        title: "Where buckets live, and what happens when that store is gone",
        span: "seq-ref-failopen",
        children: ["seq-prose-store", "seq-callout-failopen"],
      },
    },
    {
      id: "seq-step-middleware",
      kind: "order_step",
      data: {
        author,
        title: "The middleware charges the organisation and writes the headers",
        span: "seq-ref-middleware",
        children: ["seq-prose-middleware"],
      },
    },
    {
      id: "seq-step-wiring",
      kind: "order_step",
      data: {
        author,
        title: "Composition: config, the store choice, and the one ioredis import",
        span: "seq-ref-server",
        children: ["seq-prose-wiring"],
      },
    },
    {
      id: "seq-step-tests",
      kind: "order_step",
      data: {
        author,
        title: "The tests, still uncommitted, cover the burst and the outage but not Redis",
        span: "seq-ref-test",
        children: ["seq-prose-tests"],
      },
    },
  ];
  const elements: HostElement[] = [
    section(
      "seq-walk",
      "The walk, contract first",
      "Six stops: the spec and API doc, the bucket, the store and its fail-open wrapper, the middleware, the server wiring, then the tests.",
      steps.map((step) => step.id),
    ),
    ...steps,
    prose(
      "seq-prose-contract",
      "The OpenSpec change states three requirements: limit per organisation, expose the allowance on every response, and never block a request because the store is down. `docs/api.md` is the public half of the same promise, adding the `429` row and the three headers. Read these first; every file below is one of them made concrete.",
    ),
    prose(
      "seq-prose-bucket",
      "`take` is a pure function over `(bucket, policy, now)`. A missing bucket is a full one, so a new organisation starts with its whole burst. Refill is computed from elapsed wall-clock time on every read, which is why there is no timer and no sweeper anywhere in the branch.",
    ),
    annotation(
      "seq-anno-refill",
      "seq-ref-clamp",
      "`Math.min(policy.burst, …)` is the burst cap and `Math.max(0, …)` guards a clock that went backwards; both are silent. `retryAfterSeconds` rounds up, so a client told to wait is never told too little.",
    ),
    prose(
      "seq-prose-store",
      "`BucketStore` is two methods. `MemoryStore` is per process; `RedisStore` is the shared one, and it speaks `RedisLike`, a two-call subset, rather than importing ioredis. `failOpen` wraps either so that a thrown read yields `undefined`, which `take` treats as a full bucket.",
    ),
    callout(
      "seq-callout-failopen",
      "warn",
      "A store outage therefore looks, to the middleware, exactly like a new organisation: every request is allowed with a full burst. The spec requires this. Whether the only trace being a `console.error` is enough is the first flagged finding.",
    ),
    prose(
      "seq-prose-middleware",
      "One read, one `take`, one write, then headers. A request with no organisation passes through, on the argument that `auth` has already rejected anything without a token. The 429 path sets `Retry-After` and ends with a plain-text body, which is where the JSON error envelope in `docs/api.md` stops holding.",
    ),
    prose(
      "seq-prose-wiring",
      "`buildHandler` now takes the config it used to load itself, and `bucketStore` is the only function in the service that mentions ioredis. `loadConfig` grows two integers with defaults of 600 per minute and a burst of 100; `docs/api.md` documents the same numbers.",
    ),
    prose(
      "seq-prose-tests",
      "`test/rate-limit.test.ts` is in the working tree and not yet committed. It pins refill arithmetic, the 429 and its `Retry-After`, organisation isolation, and the fail-open path. `RedisStore` has no test at all, so the serialisation round trip and the TTL are unverified.",
    ),
    ...refs,
  ];
  return {
    document: {
      title: "Sequence",
      introMarkdown:
        "Per-organisation rate limiting lands in three commits and one uncommitted test file:\n- A pure token bucket, a two-method store interface with memory and Redis implementations, and a fail-open wrapper.\n- Middleware that charges the organisation named by the bearer token and writes the allowance headers.\n- Server wiring that picks the store from `REDIS_URL`, plus the public contract in `docs/api.md`.",
      measure: "reading",
    },
    elements,
  };
}

function design(patchsetId: string): LensFixture {
  const F = FIXTURE_FILES;
  const refs = [
    ref(
      "des-ref-take",
      patchsetId,
      F.bucket,
      "export function take(",
      "retryAfterSeconds: Math.ceil",
      "take",
    ),
    ref(
      "des-ref-429",
      patchsetId,
      F.middleware,
      "if (!decision.allowed) {",
      'response.end("rate limit exceeded");',
    ),
    ref(
      "des-ref-headers",
      patchsetId,
      F.middleware,
      'response.setHeader("x-ratelimit-limit"',
      'response.setHeader("x-ratelimit-remaining"',
    ),
    ref(
      "des-ref-failopen",
      patchsetId,
      F.store,
      "export function failOpen(",
      "set: (key, bucket, ttlSeconds)",
      "failOpen",
    ),
    ref(
      "des-ref-test-429",
      patchsetId,
      F.test,
      'it("answers 429 with Retry-After',
      'expect(limited.getHeader("retry-after")).toBe("1");',
    ),
    ref(
      "des-ref-test-orgs",
      patchsetId,
      F.test,
      'it("keeps organisations apart"',
      "expect(other.statusCode).toBe(200);",
    ),
    ref(
      "des-ref-test-outage",
      patchsetId,
      F.test,
      'it("allows the request when the store throws"',
      "expect(errors).toHaveLength(2);",
    ),
  ];
  const scenarios: HostElement[] = [
    {
      id: "des-scn-burst",
      kind: "prose",
      data: {
        author,
        markdown:
          "WHEN an organisation sends more than `RATE_LIMIT_BURST` requests before the bucket refills THEN the API answers 429 with a `Retry-After` header naming whole seconds until one request is allowed.",
        scenario_clauses: {
          condition:
            "an organisation sends more than `RATE_LIMIT_BURST` requests before the bucket refills",
          response:
            "the API answers 429 with a `Retry-After` header naming whole seconds until one request is allowed",
        },
      },
    },
    {
      id: "des-scn-independent",
      kind: "prose",
      data: {
        author,
        markdown:
          "WHEN one organisation is limited THEN another organisation's requests are unaffected.",
        scenario_clauses: {
          condition: "one organisation is limited",
          response: "another organisation's requests are unaffected",
        },
      },
    },
    {
      id: "des-scn-remaining",
      kind: "prose",
      data: {
        author,
        markdown:
          "WHEN an organisation's request is allowed THEN `X-RateLimit-Remaining` is the number of further requests that would be allowed right now.",
        scenario_clauses: {
          condition: "an organisation's request is allowed",
          response:
            "`X-RateLimit-Remaining` is the number of further requests that would be allowed right now",
        },
      },
    },
    {
      id: "des-scn-outage",
      kind: "prose",
      data: {
        author,
        markdown:
          "WHEN the bucket store throws on read or write THEN the request is handled as if it were within its allowance and the error is logged.",
        scenario_clauses: {
          condition: "the bucket store throws on read or write",
          response:
            "the request is handled as if it were within its allowance and the error is logged",
        },
      },
    },
  ];
  const requirements: HostElement[] = [
    {
      id: "des-req-limited",
      kind: "requirement",
      data: {
        author,
        name: "Requests are limited per organisation",
        capability: "rate-limiting",
        shall:
          "The API SHALL charge every authenticated request against a token bucket keyed by the organisation the bearer token names, refilling at `RATE_LIMIT_PER_MINUTE` with a burst of `RATE_LIMIT_BURST`.",
        scenarios: ["des-scn-burst", "des-scn-independent"],
        related_files: [F.bucket, F.middleware, F.test],
        source: {
          path: F.spec,
          label: "rate-limiting/spec.md",
          line: lineOf(F.spec, "### Requirement: Requests are limited"),
        },
        spec_delta: "added",
        coverage: "met",
        trace: ["des-ref-take", "des-ref-429", "des-ref-test-429", "des-ref-test-orgs"],
        tests: 2,
      },
    },
    {
      id: "des-req-visible",
      kind: "requirement",
      data: {
        author,
        name: "The allowance is visible on every response",
        capability: "rate-limiting",
        shall:
          "Every authenticated response SHALL carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`.",
        scenarios: ["des-scn-remaining"],
        related_files: [F.middleware, F.api],
        source: {
          path: F.spec,
          label: "rate-limiting/spec.md",
          line: lineOf(F.spec, "### Requirement: The allowance is visible"),
        },
        spec_delta: "added",
        coverage: "partial",
        trace: ["des-ref-headers"],
        tests: 0,
      },
    },
    {
      id: "des-req-outage",
      kind: "requirement",
      data: {
        author,
        name: "A store outage does not block requests",
        capability: "rate-limiting",
        shall:
          "The API SHALL allow a request when the bucket store cannot be read or written, and SHALL record the failure.",
        scenarios: ["des-scn-outage"],
        related_files: [F.store, F.server, F.test],
        source: {
          path: F.spec,
          label: "rate-limiting/spec.md",
          line: lineOf(F.spec, "### Requirement: A store outage"),
        },
        spec_delta: "added",
        coverage: "met",
        trace: ["des-ref-failopen", "des-ref-test-outage"],
        tests: 1,
      },
    },
  ];
  const statedDecisions: HostElement[] = [
    {
      id: "des-dec-failopen",
      kind: "decision",
      data: {
        author,
        title: "Fail open on store error",
        statement:
          "A request the store cannot be consulted for is allowed, with a full burst, and the failure is logged.",
        evidence: ["des-ref-failopen"],
        alternatives: [
          "Fail closed: answer 503 while the store is unreachable",
          "Fall back to a per-process MemoryStore until Redis returns",
        ],
        why: "The proposal is explicit: losing Redis must not turn into losing the API. Rate limiting is protective infrastructure, not an availability dependency.",
        inferred: false,
        source: {
          path: PROPOSAL_PATH,
          label: "proposal.md",
          line: lineOf(PROPOSAL_PATH, "If the bucket store is unavailable"),
        },
      },
    },
  ];
  const elements: HostElement[] = [
    section(
      "des-change",
      "The change",
      "per-org-rate-limiting · 1 new capability · 3 requirements · 4 scenarios.",
      ["des-prose-why"],
      { sources: [{ path: PROPOSAL_PATH, label: "proposal.md", line: 3 }], spec_delta: "added" },
    ),
    prose(
      "des-prose-why",
      "Two organisations have twice taken the API down for everyone else by retrying a failing batch job in a tight loop. The only protection was the load balancer's global connection cap, which is blind to who is sending. This change charges every authenticated request to the organisation the bearer token names.",
    ),
    section(
      "des-requirements",
      "Rate limiting",
      "Three added requirements: two met by the working-tree tests, the header requirement implemented but untested.",
      requirements.map((requirement) => requirement.id),
      {
        sources: [{ path: F.spec, label: "rate-limiting/spec.md", line: 1 }],
        spec_delta: "added",
      },
    ),
    ...requirements,
    ...scenarios,
    section(
      "des-decisions",
      "Stated in the proposal",
      "One decision the proposal makes in so many words, carried into the code unchanged.",
      statedDecisions.map((decision) => decision.id),
      { sources: [{ path: PROPOSAL_PATH, label: "proposal.md", line: 11 }] },
    ),
    ...statedDecisions,
    ...refs,
  ];
  return {
    document: {
      title: "Per-organisation rate limiting",
      introMarkdown:
        "The branch was written against an OpenSpec change, `per-org-rate-limiting`, found from the commit history. Its proposal names the incident, and its one spec adds three requirements to a new `rate-limiting` capability.",
      measure: "structured",
      sources: [
        { path: PROPOSAL_PATH, label: "proposal.md", line: 1 },
        { path: F.spec, label: "rate-limiting/spec.md", line: 1 },
      ],
      stats: [
        { label: "Requirements", value: "3" },
        { label: "Capabilities", value: "1 new / 0 modified" },
        { label: "Scenarios", value: "4" },
        { label: "Covered", value: "2 met / 1 partial" },
      ],
    },
    elements,
  };
}

function decisions(patchsetId: string): LensFixture {
  const F = FIXTURE_FILES;
  const refs = [
    ref(
      "dec-ref-take",
      patchsetId,
      F.bucket,
      "export function take(",
      "const tokens = Math.min(",
      "take",
    ),
    ref(
      "dec-ref-bucket-doc",
      patchsetId,
      F.bucket,
      "A token bucket that refills when it is READ",
      "sends nothing costs nothing",
    ),
    ref(
      "dec-ref-failopen",
      patchsetId,
      F.store,
      "export function failOpen(",
      "set: (key, bucket, ttlSeconds)",
      "failOpen",
    ),
    ref("dec-ref-bucketstore", patchsetId, F.server, "function bucketStore(config", "  });"),
    ref(
      "dec-ref-redislike",
      patchsetId,
      F.store,
      "export interface RedisLike",
      'set(key: string, value: string, mode: "EX"',
      "RedisLike",
    ),
    ref(
      "dec-ref-passthrough",
      patchsetId,
      F.middleware,
      "if (request.org === undefined) {",
      "    }",
    ),
    ref("dec-ref-ttl", patchsetId, F.middleware, "const ttlSeconds = Math.ceil("),
    ref("dec-ref-key", patchsetId, F.middleware, "const key = `org:"),
  ];
  const elements: HostElement[] = [
    section(
      "dec-shape",
      "The shape of the limit",
      "One refill-on-read token bucket per organisation, keyed by what the bearer token names, with a TTL derived from the policy.",
      ["dec-bucket", "dec-key", "dec-ttl"],
    ),
    {
      id: "dec-bucket",
      kind: "decision",
      data: {
        author,
        title: "One refill-on-read bucket",
        statement:
          "Each organisation gets a single token bucket that refills from elapsed time when it is read; there is no timer, no sweeper, and no per-request counter.",
        evidence: ["dec-ref-take", "dec-ref-bucket-doc"],
        alternatives: [
          "A fixed window counter (simpler, but lets 2× the limit through at the window edge)",
          "A sliding log of request timestamps (exact, but O(requests) storage per organisation)",
        ],
        why: "Idle organisations cost nothing to store or to age out, and a bucket serialises to two numbers, which is what makes the Redis store a single GET and SET.",
        inferred: false,
      },
    },
    {
      id: "dec-key",
      kind: "decision",
      data: {
        author,
        title: "The organisation is whatever the token says",
        statement:
          "The bucket key is `org:<id>` where the id is the bearer token's first segment, as `auth` already resolves it; a request without an organisation is not limited at all.",
        evidence: ["dec-ref-key", "dec-ref-passthrough"],
        alternatives: [
          "Also limit unauthenticated requests by client IP",
          "Limit per token rather than per organisation",
        ],
        why: "The incident was two organisations, not two tokens, and `auth` runs first so an unauthenticated request never reaches the limiter. The pass-through is therefore unreachable in production, but it is not documented as such.",
        inferred: true,
      },
    },
    {
      id: "dec-ttl",
      kind: "decision",
      data: {
        author,
        title: "Bucket TTL is one refill plus a second",
        statement:
          "A stored bucket expires `ceil(burst / ratePerSecond) + 1` seconds after its last write, the time it takes to refill from empty.",
        evidence: ["dec-ref-ttl"],
        alternatives: ["A fixed long TTL", "No expiry"],
        why: "A bucket older than one full refill is indistinguishable from a missing one, so keeping it is pure Redis memory. The extra second absorbs rounding.",
        inferred: true,
      },
    },
    section(
      "dec-failure",
      "Failure posture",
      "The branch chooses availability over enforcement, in the proposal and in the code.",
      ["dec-failopen"],
    ),
    {
      id: "dec-failopen",
      kind: "decision",
      data: {
        author,
        title: "Fail open on store error",
        statement:
          "When the store throws on read the request proceeds with a full bucket; when it throws on write the decision stands and the error is only logged.",
        evidence: ["dec-ref-failopen", "dec-ref-bucketstore"],
        alternatives: [
          "Fail closed with a 503 until the store is reachable",
          "Degrade to the per-process MemoryStore while Redis is down",
        ],
        why: "The proposal says it directly: losing Redis must not mean losing the API. The cost is that a Redis outage silently removes every limit, with one `console.error` per request as the only sign.",
        inferred: false,
        source: {
          path: PROPOSAL_PATH,
          label: "proposal.md",
          line: lineOf(PROPOSAL_PATH, "If the bucket store is unavailable"),
        },
      },
    },
    section(
      "dec-boundary",
      "Dependency boundary",
      "ioredis is imported once, at the composition root; the store depends on a two-method interface.",
      ["dec-redis"],
    ),
    {
      id: "dec-redis",
      kind: "decision",
      data: {
        author,
        title: "Keep Redis out of core",
        statement:
          "`RedisStore` takes a `RedisLike` with `get` and `set` only; `src/server.ts` is the single file that imports ioredis and constructs the client.",
        evidence: ["dec-ref-redislike", "dec-ref-bucketstore"],
        alternatives: [
          "Import ioredis inside `store.ts` and construct the client there",
          "A generic key-value port shared by future stores",
        ],
        why: "Tests for the store need no Redis, and swapping the client library later touches one file. The interface is deliberately minimal rather than general.",
        inferred: true,
      },
    },
    ...refs,
  ];
  return {
    document: {
      title: "Decisions",
      introMarkdown:
        "Five judgment calls inside the change: two stated by the proposal, three inferred from the code and marked as such.",
      measure: "reading",
    },
    elements,
  };
}

function flagged(patchsetId: string): LensFixture {
  const F = FIXTURE_FILES;
  const refs = [
    ref(
      "flg-ref-failopen",
      patchsetId,
      F.store,
      "export function failOpen(",
      "set: (key, bucket, ttlSeconds)",
      "failOpen",
    ),
    ref("flg-ref-onerror", patchsetId, F.server, "return failOpen(store, (error) => {", "});"),
    ref(
      "flg-ref-readwrite",
      patchsetId,
      F.middleware,
      "const decision = take(await options.store.get(key)",
      "await options.store.set(key, decision.bucket, ttlSeconds);",
    ),
    ref(
      "flg-ref-429body",
      patchsetId,
      F.middleware,
      "response.statusCode = 429;",
      'response.end("rate limit exceeded");',
    ),
    ref(
      "flg-ref-envelope",
      patchsetId,
      F.api,
      "Every error is a JSON object",
      '{ "error": "missing bearer token" }',
    ),
    ref(
      "flg-ref-redisstore",
      patchsetId,
      F.store,
      "export class RedisStore",
      "await this.redis.set(this.prefix + key",
      "RedisStore",
    ),
  ];
  const elements: HostElement[] = [
    section(
      "flg-high",
      "High",
      "A Redis outage removes every limit and the only trace is a log line per request.",
      ["flg-outage"],
    ),
    {
      id: "flg-outage",
      kind: "finding",
      data: {
        author,
        severity: "high",
        concern:
          "A Redis outage removes every limit, and the only trace is one log line per request.\n\n`failOpen` turns a store failure into `undefined`, and `take` treats `undefined` as a brand-new organisation with a full burst. So while Redis is unreachable every organisation gets an unlimited allowance, which is the spec's stated intent, but the only evidence it is happening is `console.error` once per request in `bucketStore`. Nothing counts it, nothing alarms on it, and `X-RateLimit-Remaining` keeps reporting a healthy number. The incident this branch answers was a tight retry loop; a tight retry loop during a Redis blip now produces one log line per request and no limit.\n\n**Fix:** count fail-open decisions in a metric and mark the response (a header, or `X-RateLimit-Remaining` omitted) so the degraded state is visible to operators and clients.",
        code: ["flg-ref-failopen", "flg-ref-onerror"],
        concurrence: BOTH,
        accord: "conflict",
        status: "open",
      },
    },
    section(
      "flg-medium",
      "Medium",
      "Read-then-write on a shared store lets replicas grant the same token; the 429 breaks the error envelope.",
      ["flg-race", "flg-envelope"],
    ),
    {
      id: "flg-race",
      kind: "finding",
      data: {
        author,
        severity: "medium",
        concern:
          "Two replicas can grant the same token: the take is a read, a decision, then a write.\n\nThe middleware does a GET, decides in process, then a SET. With `RedisStore` and more than one replica, two requests that arrive together both read the same bucket, both see a token, and both write back a bucket that has spent one; the limit under-counts by up to the replica count at every refill boundary. The branch adds Redis specifically so replicas share a limit, so this is the case it was written for.\n\n**Fix:** make the take atomic in Redis, either a small Lua script that refills and decrements in one call, or `INCR` on a per-window counter for the shared store.",
        code: ["flg-ref-readwrite", "flg-ref-redisstore"],
        concurrence: CLAUDE_ONLY,
        accord: "split",
        status: "open",
      },
    },
    {
      id: "flg-envelope",
      kind: "finding",
      data: {
        author,
        severity: "medium",
        concern:
          'The 429 is plain text, so it breaks the JSON error envelope the API doc promises.\n\n`docs/api.md` promises that every error is a JSON object with one `error` string, and this branch adds the 429 row to that table. The 429 itself is sent with `response.end("rate limit exceeded")` and no content type, so a client parsing the envelope gets a JSON error on the first limited request. The `json` helper is one import away.\n\n**Fix:** answer the 429 through `json(response, 429, { error: "rate limit exceeded" })`.',
        code: ["flg-ref-429body", "flg-ref-envelope"],
        concurrence: BOTH,
        accord: "concur",
        status: "open",
      },
    },
    section(
      "flg-cleared",
      "Checked and cleared",
      "Three concerns looked at and found not to be problems.",
      ["flg-cleared-prose"],
    ),
    prose(
      "flg-cleared-prose",
      "**Clock skew between replicas.** `take` clamps a negative elapsed time to zero, so a replica behind another's write cannot mint tokens; it under-refills by the skew, which is the safe direction. **A stale or corrupt bucket in Redis.** `isBucket` rejects anything that is not two numbers and `take` treats it as new; the failure mode is a free burst, the same as fail-open. **Unauthenticated traffic bypassing the limit.** `auth` sits outside the limiter and answers 401 before it, so a request with no organisation never reaches the pass-through.",
    ),
    ...refs,
  ];
  return {
    document: {
      title: "Flagged",
      introMarkdown:
        "Three open findings, one high. Claude and Codex both raised the fail-open visibility gap and disagree on how serious it is; the shared-store race is Claude's alone.",
      measure: "reading",
    },
    elements,
  };
}

function noise(patchsetId: string): LensFixture {
  const F = FIXTURE_FILES;
  const refs = [
    ref("noi-ref-lock", patchsetId, F.lock, "packages:", "standard-as-callback@2.1.0:"),
    ref(
      "noi-ref-auth-import",
      patchsetId,
      F.auth,
      'import { json, type Middleware } from "../http.js";',
    ),
    ref("noi-ref-stamp", patchsetId, STAMP_PATH, "schema: spec-driven", "created: 2026-09-08"),
    ref("noi-ref-pkg", patchsetId, F.packageJson, '"dependencies": {', '"ioredis": "5.4.1"'),
  ];
  const elements: HostElement[] = [
    section(
      "noi-mechanical",
      "Mechanical and generated churn",
      "The lockfile's ioredis subtree, an import merged into one line, and the OpenSpec scaffold stamp.",
      ["noi-prose", "noi-lock", "noi-import", "noi-stamp"],
    ),
    prose(
      "noi-prose",
      "Set aside, not dropped: forty-odd lines that carry no behaviour. Each is judged on its own and can be reopened from the Diff view.",
    ),
    {
      id: "noi-lock",
      kind: "noise_verdict",
      data: {
        author,
        hunk: "noi-ref-lock",
        verdict: "noise",
        judge: "deterministic",
        reason:
          "The `packages:` block `pnpm install` wrote when `ioredis` was added: nine resolution entries with integrity hashes. Generated from `package.json`, which is where the real change is.",
      },
    },
    {
      id: "noi-import",
      kind: "noise_verdict",
      data: {
        author,
        hunk: "noi-ref-auth-import",
        verdict: "noise",
        judge: "deterministic",
        reason:
          "Two import lines from `../http.js` became one with an inline `type` modifier. Same bindings, same module; the formatter's preference, not the author's.",
      },
    },
    {
      id: "noi-stamp",
      kind: "noise_verdict",
      data: {
        author,
        hunk: "noi-ref-stamp",
        verdict: "noise",
        judge: "deterministic",
        reason:
          "The two-line file the OpenSpec tool writes when it creates a change directory: a schema tag and a date.",
      },
    },
    section(
      "noi-signal",
      "Looked like noise, kept as signal",
      "One dependency line that is the reason the lockfile moved.",
      ["noi-pkg"],
    ),
    {
      id: "noi-pkg",
      kind: "noise_verdict",
      data: {
        author,
        hunk: "noi-ref-pkg",
        verdict: "signal",
        judge: "llm",
        reason:
          "A new runtime dependency on `ioredis` is a supply-chain and licence decision even though it is one line; it stays in the review.",
      },
    },
    ...refs,
  ];
  return {
    document: {
      title: "Noise",
      introMarkdown:
        "Three hunks set aside as mechanical churn; one dependency line that looked like churn and is not.",
      measure: "reading",
    },
    elements,
  };
}

const FIXTURES: Readonly<Record<LensKind, (patchsetId: string) => LensFixture>> = {
  design,
  sequence,
  decisions,
  flagged,
  noise,
};

function writeRank(element: HostElement): number {
  switch (element.kind) {
    case "code_ref":
      return 0;
    case "prose":
    case "annotation":
    case "callout":
      return 1;
    case "section":
      return 3;
    default:
      return 2;
  }
}

export interface SeededMarketingBoard {
  readonly sessionId: string;
  readonly reviewId: string;
  readonly patchsetId: string;
  readonly generation: string;
}

async function currentSessionReview(page: Page): Promise<{
  readonly sessionId: string;
  readonly reviewId: string;
  readonly patchsetId: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly paths: ReadonlySet<string>;
}> {
  const hash = await page.evaluate(() => location.hash);
  const slug = /^#\/s\/([^?]+)/.exec(hash)?.[1];
  if (slug === undefined) throw new Error(`expected a session route, got ${hash}`);
  const sessionId = decodeURIComponent(slug);
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    const session = (await bridge.invoke("session.list", {})).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (session?.reviewId === undefined) {
      throw new Error(`session ${sessionId} has no captured review`);
    }
    const { review } = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId: session.reviewId,
    });
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    if (patchset === undefined) throw new Error(`review ${review.id} has no active patchset`);
    return {
      sessionId,
      reviewId: review.id,
      patchsetId: patchset.id,
      baseOid: patchset.repository.baseOid,
      headOid: patchset.repository.headOid,
      paths: new Set(patchset.files.map((file) => file.path)),
    };
  } finally {
    bridge.close();
  }
}

/**
 * Persist the five lens boards for the current session's captured patchset through the
 * production board writer, then the metadata, generation and round record that make the
 * board read as a settled first review. Throws if a cited path is not in the capture, so a
 * board can never point at code the Diff view does not hold.
 */
export async function seedMarketingBoard(
  page: Page,
  repository: string,
  userData: string,
): Promise<SeededMarketingBoard> {
  const review = await currentSessionReview(page);
  const generation = generationIdForPatchset(review.patchsetId);
  const runtime = createBoardsRuntime(repository);
  const whiteboard = new WhiteboardClient(runtime.service);
  // The same bound alias `board-fixture.ts` uses: the fixture is a caller of the injected
  // client, never a second board writer, and the writer-invariant scan reads it as such.
  const write = whiteboard.apply.bind(whiteboard);
  const meta = new BoardMetaStore(join(userData, "board-meta"));
  const generations = new GenerationStore(join(userData, "generations"));
  const lensBoards: Partial<Record<LensKind, string>> = {};

  for (const lens of LENS_KINDS) {
    const fixture = FIXTURES[lens](review.patchsetId);
    for (const element of fixture.elements) {
      if (element.kind === "code_ref" && !review.paths.has(element.data.path)) {
        throw new Error(`${lens} cites ${element.data.path}, which the capture does not hold`);
      }
    }
    const boardId = await runtime.createRennetBoard();
    lensBoards[lens] = boardId;
    // The writer validates every reference as the op arrives, so an element is created
    // after everything it points at: code first, prose next, typed kinds, then sections.
    const ordered = [...fixture.elements].sort((a, b) => writeRank(a) - writeRank(b));
    const applied = await write(
      boardId,
      ordered.map((element) => ({ op: "create" as const, element })),
      `lens:${lens}`,
    );
    if (!applied.response.ok) {
      throw new Error(`fixture board ${lens} was rejected: ${JSON.stringify(applied.response)}`);
    }
    meta.save({
      lens,
      boardId,
      document: fixture.document,
      blemishes: [],
      omissions: [],
      immutability: [],
      session: review.sessionId,
      generation,
    });
  }
  generations.save({
    id: generation,
    patchsetId: review.patchsetId,
    lensBoards,
    status: "live",
  });
  new RoundRecordStore(join(userData, "rounds")).record(review.sessionId, {
    asksDispatched: [],
    workerCommitRange: { from: review.baseOid, to: review.headOid },
    mintedPatchsetGeneration: generation,
    boardGeneration: generation,
    reportBoard: "marketing-fixture-report",
    reworkCount: 0,
  });
  const sessions = new SessionStore(join(userData, "sessions"));
  sessions.setPreparation(review.sessionId, undefined);
  // The title a reviewer would give the session; the default is the generic "New review".
  sessions.rename(review.sessionId, "Per-org rate limiting");

  return {
    sessionId: review.sessionId,
    reviewId: review.reviewId,
    patchsetId: review.patchsetId,
    generation,
  };
}
