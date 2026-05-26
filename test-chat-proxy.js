#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = __dirname;
const PROXY_SCRIPT = path.join(ROOT, "chat-completions-to-responses-proxy.js");

function listen(server, port = 0, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function requestJson({ method = "GET", port, path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      async (res) => {
        try {
          const text = await readBody(res);
          const parsed = text ? JSON.parse(text) : null;
          resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port, child) {
  let lastError;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode != null) {
      throw new Error(`Proxy exited early with code ${child.exitCode}`);
    }

    try {
      const res = await requestJson({ port, path: "/health" });
      if (res.statusCode === 200 && res.body?.ok) return res.body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Timed out waiting for proxy health check");
}

async function runSmokeCase({ name, upstreamApiKey, expectedUpstreamAuthHeader }) {
  await fs.access(PROXY_SCRIPT);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-proxy-test-"));
  let upstreamRequestBody;
  let upstreamResponsesAuthHeader;
  let upstreamModelsAuthHeader;
  let upstreamModelsRequestCount = 0;

  const upstreamServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      upstreamModelsRequestCount += 1;
      upstreamModelsAuthHeader = req.headers.authorization;
      const id = `mock-model-${upstreamModelsRequestCount}`;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id,
              object: "model",
              created: 123,
              owned_by: "mock-owner",
            },
          ],
        }),
      );
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    upstreamResponsesAuthHeader = req.headers.authorization;
    upstreamRequestBody = JSON.parse(await readBody(req));

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.write(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "pong",
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          model: "mock-responses-model",
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            total_tokens: 6,
          },
        },
      })}\n\n`,
    );
    res.end();
  });

  const upstreamAddress = await listen(upstreamServer);
  const proxyProbe = http.createServer((_, res) => res.end("reserved"));
  const proxyAddress = await listen(proxyProbe);
  await closeServer(proxyProbe);

  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(proxyAddress.port),
      HOST: "127.0.0.1",
      UPSTREAM_MODE: "responses",
      UPSTREAM_RESPONSES_URL: `http://127.0.0.1:${upstreamAddress.port}/v1/responses`,
      UPSTREAM_API_KEY: upstreamApiKey,
      LOCAL_API_KEY: "test-local-key",
      LOG_FILE: path.join(tempDir, "requests.jsonl"),
      RAW_LOG_FILE: path.join(tempDir, "upstream.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const health = await waitForHealth(proxyAddress.port, child);
    assert.equal(health.upstream_mode, "responses");

    const unauthorized = await requestJson({
      method: "POST",
      port: proxyAddress.port,
      path: "/v1/chat/completions",
      body: {
        model: "mock-model",
        messages: [{ role: "user", content: "ping" }],
      },
    });
    assert.equal(unauthorized.statusCode, 401);

    const chat = await requestJson({
      method: "POST",
      port: proxyAddress.port,
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-local-key" },
      body: {
        model: "mock-model",
        stream: false,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "ping" },
        ],
      },
    });

    assert.equal(chat.statusCode, 200);
    assert.equal(chat.body.object, "chat.completion");
    assert.equal(chat.body.model, "mock-responses-model");
    assert.equal(chat.body.choices[0].message.content, "pong");
    assert.deepEqual(chat.body.usage, {
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
    });

    const models = await requestJson({
      method: "GET",
      port: proxyAddress.port,
      path: "/v1/models",
      headers: { Authorization: "Bearer test-local-key" },
    });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.body, {
      object: "list",
      data: [
        {
          id: "mock-model-1",
          object: "model",
          created: 123,
          owned_by: "mock-owner",
        },
      ],
    });

    const uncachedModels = await requestJson({
      method: "GET",
      port: proxyAddress.port,
      path: "/v1/models",
      headers: { Authorization: "Bearer test-local-key" },
    });
    assert.equal(uncachedModels.statusCode, 200);
    assert.deepEqual(uncachedModels.body, {
      object: "list",
      data: [
        {
          id: "mock-model-2",
          object: "model",
          created: 123,
          owned_by: "mock-owner",
        },
      ],
    });
    assert.equal(upstreamModelsRequestCount, 2);

    const usage = await requestJson({
      method: "GET",
      port: proxyAddress.port,
      path: "/v1/usage",
      headers: { Authorization: "Bearer test-local-key" },
    });
    assert.equal(usage.statusCode, 200);
    assert.deepEqual(usage.body, {
      object: "proxy.usage",
      cumulative_usage: {
        request_count: 1,
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
      },
    });

    assert.equal(upstreamResponsesAuthHeader, expectedUpstreamAuthHeader);
    assert.equal(upstreamModelsAuthHeader, expectedUpstreamAuthHeader);
    assert.equal(upstreamRequestBody.model, "mock-model");
    assert.equal(upstreamRequestBody.stream, true);
    assert.equal(upstreamRequestBody.instructions, "Be concise.");
    assert.equal(upstreamRequestBody.input[0].role, "user");
    assert.equal(upstreamRequestBody.input[0].content[0].text, "ping");

    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(stdout.trim());
    console.error(stderr.trim());
    throw error;
  } finally {
    child.kill();
    await closeServer(upstreamServer);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runCodexModelsClientVersionCase() {
  await fs.access(PROXY_SCRIPT);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-proxy-test-"));
  let upstreamModelsUrl;

  const upstreamServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      upstreamModelsUrl = req.url;
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.searchParams.get("client_version") !== "test-client-version") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "client_version is required" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          object: "list",
          models: [
            {
              slug: "codex-model",
              created: 456,
              owned_by: "codex-owner",
            },
          ],
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1/responses") {
      await readBody(req);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "x-codex-active-limit": "premium",
        "x-codex-plan-type": "plus",
        "x-codex-primary-used-percent": "12",
        "x-codex-secondary-used-percent": "34",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-primary-reset-after-seconds": "120",
        "x-codex-secondary-reset-after-seconds": "240",
        "x-codex-primary-reset-at": "1700000120",
        "x-codex-secondary-reset-at": "1700000240",
        "x-codex-credits-has-credits": "False",
        "x-codex-credits-balance": "",
        "x-codex-credits-unlimited": "False",
      });
      res.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "ok",
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: "codex-model",
            usage: {
              input_tokens: 7,
              output_tokens: 2,
              total_tokens: 9,
            },
          },
        })}\n\n`,
      );
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const upstreamAddress = await listen(upstreamServer);
  const proxyProbe = http.createServer((_, res) => res.end("reserved"));
  const proxyAddress = await listen(proxyProbe);
  await closeServer(proxyProbe);

  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(proxyAddress.port),
      HOST: "127.0.0.1",
      UPSTREAM_MODE: "codex",
      UPSTREAM_RESPONSES_URL: `http://127.0.0.1:${upstreamAddress.port}/v1/responses`,
      CODEX_ACCESS_TOKEN: "test-token",
      CODEX_ACCOUNT_ID: "test-account",
      CODEX_CLIENT_VERSION: "test-client-version",
      LOCAL_API_KEY: "test-local-key",
      LOG_FILE: path.join(tempDir, "requests.jsonl"),
      RAW_LOG_FILE: path.join(tempDir, "upstream.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const health = await waitForHealth(proxyAddress.port, child);
    assert.equal(health.upstream_mode, "codex");

    const models = await requestJson({
      method: "GET",
      port: proxyAddress.port,
      path: "/v1/models",
      headers: { Authorization: "Bearer test-local-key" },
    });

    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.body, {
      object: "list",
      data: [
        {
          id: "codex-model",
          object: "model",
          created: 456,
          owned_by: "codex-owner",
        },
      ],
    });
    assert.equal(
      upstreamModelsUrl,
      "/v1/models?client_version=test-client-version",
    );

    const chat = await requestJson({
      method: "POST",
      port: proxyAddress.port,
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer test-local-key" },
      body: {
        model: "codex-model",
        stream: false,
        messages: [{ role: "user", content: "ping" }],
      },
    });
    assert.equal(chat.statusCode, 200);
    assert.deepEqual(chat.body.usage, {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    });

    const usage = await requestJson({
      method: "GET",
      port: proxyAddress.port,
      path: "/v1/usage",
      headers: { Authorization: "Bearer test-local-key" },
    });
    assert.equal(usage.statusCode, 200);
    assert.deepEqual(usage.body, {
      object: "proxy.usage",
      cumulative_usage: {
        request_count: 1,
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
      },
      codex: {
        rate_limits: {
          limit_id: "codex",
          active_limit: "premium",
          plan_type: "plus",
          primary: {
            used_percent: 12,
            window_minutes: 300,
            reset_after_seconds: 120,
            resets_at: 1700000120,
          },
          secondary: {
            used_percent: 34,
            window_minutes: 10080,
            reset_after_seconds: 240,
            resets_at: 1700000240,
          },
          credits: {
            has_credits: false,
            balance: null,
            unlimited: false,
          },
        },
      },
    });

    console.log("ok - codex /v1/models forwards client_version");
  } catch (error) {
    console.error(stdout.trim());
    console.error(stderr.trim());
    throw error;
  } finally {
    child.kill();
    await closeServer(upstreamServer);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await runSmokeCase({
    name: "proxy forwards upstream Authorization when UPSTREAM_API_KEY is set",
    upstreamApiKey: "test-upstream-key",
    expectedUpstreamAuthHeader: "Bearer test-upstream-key",
  });

  await runSmokeCase({
    name: "proxy allows blank UPSTREAM_API_KEY and omits upstream Authorization",
    upstreamApiKey: "",
    expectedUpstreamAuthHeader: undefined,
  });

  await runCodexModelsClientVersionCase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
