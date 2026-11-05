import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer, request as namedHttpRequest, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram, main } from "../src/cli/experiment.js";
import { allowLocalFake, clearLocalFakes } from "./setup.js";

const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

const IMPORT_SIDE_EFFECT_PROBE = `
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";

let calls = 0;
globalThis.fetch = () => {
  calls += 1;
  throw new Error("unexpected fetch");
};
for (const module of [http, https]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = function (...args) {
      calls += 1;
      return original.apply(this, args);
    };
  }
}
const originalConnect = net.connect;
net.connect = function (...args) {
  calls += 1;
  return originalConnect.apply(this, args);
};

(async () => {
  const before = existsSync("data") ? readdirSync("data").sort().join(",") : "";
  await import(pathToFileURL(process.cwd() + "/src/cli/experiment.ts").href);
  const after = existsSync("data") ? readdirSync("data").sort().join(",") : "";
  if (calls !== 0) {
    console.error("network-calls:" + calls);
    process.exit(3);
  }
  if (before !== after) {
    console.error("data-directory-changed");
    process.exit(4);
  }
  console.log("side-effect-free");
})();
`;

interface LocalServer {
  readonly origin: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function startLocalServer(handler: (response: ServerResponse) => void): Promise<LocalServer> {
  const server = createServer((_request, response) => {
    handler(response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

function startTextServer(body: string): Promise<LocalServer> {
  return startLocalServer((response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
}

function collectErrorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join(" | ");
}

afterEach(() => {
  clearLocalFakes();
});

describe("offline test network guard", () => {
  it("denies non-loopback HTTP without contacting the network", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/non-loopback/);
  });

  it("denies an unregistered loopback origin", async () => {
    const server = await startTextServer("ok");
    try {
      await expect(fetch(`${server.origin}/probe`)).rejects.toThrow(/not registered/);
    } finally {
      await server.close();
    }
  });

  it("allows an explicitly registered local fake", async () => {
    const server = await startTextServer("local-fake");
    try {
      allowLocalFake(server.origin);
      const response = await fetch(`${server.origin}/probe`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("local-fake");
    } finally {
      await server.close();
    }
  });

  it("denies a redirect from a registered local fake to a non-loopback host", async () => {
    const server = await startLocalServer((response) => {
      response.writeHead(302, { location: "https://example.com/redirected" });
      response.end();
    });
    try {
      allowLocalFake(server.origin);
      let caught: unknown;
      try {
        await fetch(`${server.origin}/redirect`);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(collectErrorMessages(caught)).toMatch(/non-loopback/);
    } finally {
      await server.close();
    }
  });

  it("denies node:http requests made through named ESM imports", async () => {
    const server = await startTextServer("ok");
    try {
      expect(() =>
        namedHttpRequest({ host: "127.0.0.1", port: server.port, path: "/probe" }),
      ).toThrow(/not registered/);
    } finally {
      await server.close();
    }
  });

  it("denies raw socket connections to unregistered or non-loopback targets", async () => {
    const server = await startTextServer("ok");
    try {
      expect(() => net.connect({ host: "127.0.0.1", port: server.port })).toThrow(
        /not registered/,
      );
      expect(() => net.connect(443, "example.com")).toThrow(/non-loopback/);
      expect(() => new net.Socket().connect(String(server.port))).toThrow(/not registered/);
    } finally {
      await server.close();
    }
  });

  it("rejects registration of a non-loopback origin", () => {
    expect(() => allowLocalFake("https://example.com")).toThrow(/not a loopback host/);
  });
});

describe("experiment CLI bootstrap", () => {
  it("imports without changing the data directory or using the network", () => {
    const dataDirectory = join(process.cwd(), "data");
    const before = existsSync(dataDirectory) ? readdirSync(dataDirectory).sort() : [];
    const result = spawnSync(TSX_BIN, ["--eval", IMPORT_SIDE_EFFECT_PROBE], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("side-effect-free");
    expect(result.status).toBe(0);
    expect(existsSync(dataDirectory) ? readdirSync(dataDirectory).sort() : []).toEqual(before);
  });

  it("describes only the implemented capabilities in help", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain("--help");
    expect(help).toContain("--dry-run");
    expect(help).toContain("AI Puzzle Factory experiment CLI.");
  });

  it("prints help and exits successfully", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["node", "experiment", "--help"])).resolves.toBe(0);
    stdout.mockRestore();
    const result = spawnSync(TSX_BIN, ["src/cli/experiment.ts", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Availability (P36)");
  });

  it("fails explicitly for an unknown execution flag", () => {
    const result = spawnSync(TSX_BIN, ["src/cli/experiment.ts", "--not-an-experiment-option"], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option/);
  });

  it("fails explicitly when a smoke mock run is not requested", () => {
    const result = spawnSync(TSX_BIN, ["src/cli/experiment.ts"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/P36 execution supports only --smoke --mock or --resume <run-id>/);
  });
});
