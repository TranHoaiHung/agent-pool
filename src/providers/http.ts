export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }

  /** The refresh token is spent or revoked: only a new sign-in helps. */
  get deadLogin(): boolean {
    return (
      (this.status === 400 || this.status === 401) &&
      /invalid_grant|refresh_token_(expired|reused|invalidated)/i.test(this.message)
    );
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** JSON request with a timeout; non-2xx answers become HttpError. */
export async function httpJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "agent-pool-vscode",
    ...opts.headers,
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new HttpError(0, `Network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retry = Number(res.headers.get("retry-after"));
    throw new HttpError(
      res.status,
      `HTTP ${res.status}: ${text.slice(0, 200)}`,
      Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined
    );
  }
  return (await res.json()) as T;
}
