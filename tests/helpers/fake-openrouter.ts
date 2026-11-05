import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakeOpenRouterResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly delayMs?: number;
  readonly destroy?: boolean;
  readonly hang?: boolean;
}

export interface FakeOpenRouterRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeOpenRouter {
  readonly baseUrl: string;
  readonly requests: FakeOpenRouterRequest[];
  enqueue(response: FakeOpenRouterResponse): void;
  close(): Promise<void>;
}

function headerRecord(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(",") : value ?? "",
    ]),
  );
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) {
        request.destroy();
        reject(new Error("fake OpenRouter request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function payloadFor(response: FakeOpenRouterResponse): Buffer {
  if (response.body === undefined) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(response.body)) {
    return response.body;
  }
  if (typeof response.body === "string") {
    return Buffer.from(response.body, "utf8");
  }
  return Buffer.from(JSON.stringify(response.body), "utf8");
}

export async function createFakeOpenRouter(): Promise<FakeOpenRouter> {
  const queue: FakeOpenRouterResponse[] = [];
  const requests: FakeOpenRouterRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let body: string;
    try {
      body = await readRequestBody(request);
    } catch {
      response.destroy();
      return;
    }
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: headerRecord(request),
      body,
    });
    const spec = queue.shift() ?? {
      status: 500,
      body: { error: { code: 500, message: "fake response queue is empty" } },
    };
    if (spec.delayMs !== undefined && spec.delayMs > 0) {
      await sleep(spec.delayMs);
    }
    if (spec.destroy === true) {
      response.destroy();
      return;
    }
    if (spec.hang === true) {
      return;
    }
    const headers = { ...spec.headers };
    const payload = payloadFor(spec);
    if (
      headers["content-type"] === undefined &&
      spec.body !== undefined &&
      !Buffer.isBuffer(spec.body) &&
      typeof spec.body !== "string"
    ) {
      headers["content-type"] = "application/json";
    }
    response.writeHead(spec.status ?? 200, headers);
    response.end(payload);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    enqueue: (response) => {
      queue.push(response);
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
