import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { Octokit } from "@octokit/core";

/** The device-code verification payload GitHub mints (auth-oauth-device's shape). */
export interface Verification {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * The GitHub OAuth device flow (v4.2 — the gh-CLI piggyback's replacement).
 *
 * A public OAuth App client: the client id is a public identifier (safe to
 * commit), there is no client secret and no Rennet backend — the flow is two
 * calls straight to github.com (`POST /login/device/code`, then a poll of
 * `POST /login/oauth/access_token`), both performed by the user's own machine.
 * `onVerification` surfaces the one-time user code + verification URI; the
 * returned promise resolves with the minted token once the user authorizes at
 * github.com/login/device, or rejects on abort/expiry.
 *
 * `@octokit/auth-oauth-device` owns the polling protocol (interval, slow-down,
 * expiry); this module owns only Rennet's identity and the abort seam.
 */

/** The Rennet OAuth App (owner: rbutera). A public identifier, not a secret. */
export const RENNET_GITHUB_CLIENT_ID = "Ov23liDxpY9ZfNnJXYPS";

/**
 * `repo` reads/writes the repositories the user grants; `workflow` lets a push
 * touch `.github/workflows/*` (GitHub rejects such a push without it — a coding
 * agent that cannot push a CI fix is half an agent).
 */
export const RENNET_GITHUB_SCOPES = ["repo", "workflow"];

export type DeviceVerification = Verification;

export interface DeviceFlowOptions {
  /** The outbound HTTP transport (the daemon's fetch). */
  fetch: typeof globalThis.fetch;
  /** Receives the user code + verification URI as soon as GitHub mints them. */
  onVerification: (verification: DeviceVerification) => void;
  /** Aborts the poll (user dismissed the connect card). */
  signal?: AbortSignal;
  /** Overrides for tests. */
  clientId?: string;
  scopes?: string[];
  baseUrl?: string;
}

/** Run the device flow to completion; resolves with the minted OAuth token. */
export async function runGitHubDeviceFlow(options: DeviceFlowOptions): Promise<{ token: string }> {
  const { signal } = options;
  // The abort seam: auth-oauth-device has no signal input, so the injected fetch
  // carries it — an abort fails the in-flight (or next) poll request, which
  // rejects the auth() promise.
  const fetchWithSignal: typeof globalThis.fetch = (url, init) => {
    if (signal?.aborted) return Promise.reject(new Error("GitHub connect was cancelled"));
    return options.fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) });
  };
  const octokit = new Octokit({
    request: { fetch: fetchWithSignal },
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  const auth = createOAuthDeviceAuth({
    clientType: "oauth-app",
    clientId: options.clientId ?? RENNET_GITHUB_CLIENT_ID,
    scopes: options.scopes ?? RENNET_GITHUB_SCOPES,
    onVerification: options.onVerification,
    request: octokit.request,
  });
  const { token } = await auth({ type: "oauth" });
  return { token };
}
