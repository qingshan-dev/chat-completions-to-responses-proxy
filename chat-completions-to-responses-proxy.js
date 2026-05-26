#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { URL, URLSearchParams } = require("node:url");

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  localApiKey: process.env.LOCAL_API_KEY || "",
  upstreamMode: (process.env.UPSTREAM_MODE || "codex").toLowerCase(),
  upstreamResponsesUrl:
    process.env.UPSTREAM_RESPONSES_URL ||
    "https://chatgpt.com/backend-api/codex/responses",
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  upstreamModelsUrl: process.env.UPSTREAM_MODELS_URL || "",
  codexAccessToken: process.env.CODEX_ACCESS_TOKEN || "",
  codexRefreshToken: process.env.CODEX_REFRESH_TOKEN || "",
  codexAccountId: process.env.CODEX_ACCOUNT_ID || "",
  codexClientId: process.env.CODEX_CLIENT_ID || "",
  codexClientVersion: process.env.CODEX_CLIENT_VERSION || "",
  proxyUrl: process.env.PROXY_URL || "",
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 120000),
  codexStrict: process.env.CODEX_STRICT !== "0",
  logFile:
    process.env.LOG_FILE ||
    path.join(__dirname, "chat-completions-to-responses-proxy.requests.jsonl"),
  rawLogFile:
    process.env.RAW_LOG_FILE ||
    path.join(__dirname, "chat-completions-to-responses-proxy.upstream.jsonl"),
};

const cumulativeUsage = {
  request_count: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

const codexUsage = {
  rate_limits: null,
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function openAiError(message, type = "openai_api_error", code = "") {
  return { error: { message, type, param: "", code } };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function extractTextContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (!part) return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "input_text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeImageUrl(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string")
    return value.url;
  return value;
}

function convertContentParts(role, content) {
  if (content == null) return "";
  if (typeof content === "string") {
    return [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content,
      },
    ];
  }
  if (!Array.isArray(content)) {
    return [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text: JSON.stringify(content),
      },
    ];
  }

  return content.map((part) => {
    if (!part || typeof part !== "object") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: String(part ?? ""),
      };
    }
    if (part.type === "text" || part.type === "input_text") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text || "",
      };
    }
    if (part.type === "image_url") {
      return {
        type: "input_image",
        image_url: normalizeImageUrl(part.image_url),
      };
    }
    if (part.type === "input_audio") {
      return {
        type: "input_audio",
        input_audio: part.input_audio,
      };
    }
    if (part.type === "file" || part.type === "input_file") {
      return {
        type: "input_file",
        file: part.file,
      };
    }
    return { ...part };
  });
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => {
    if (tool?.type === "function" && tool.function) {
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      };
    }
    return tool;
  });
}

function convertToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function") {
    const name = toolChoice.name || toolChoice.function?.name;
    if (name) return { type: "function", name };
  }
  return toolChoice;
}

function convertResponseFormat(responseFormat) {
  if (!responseFormat?.type) return undefined;
  const format = { ...responseFormat };
  if (
    format.type === "json_schema" &&
    format.json_schema &&
    typeof format.json_schema === "object"
  ) {
    const nested = format.json_schema;
    delete format.json_schema;
    Object.assign(format, nested);
    format.type = "json_schema";
  }
  return { format };
}

function chatToResponsesBody(chatReq) {
  if (!chatReq || typeof chatReq !== "object") {
    throw new Error("request body must be a JSON object");
  }
  if (!chatReq.model) {
    throw new Error("model is required");
  }
  if (!Array.isArray(chatReq.messages)) {
    throw new Error("messages must be an array");
  }
  if (chatReq.n && chatReq.n > 1) {
    throw new Error("n>1 is not supported by this compatibility proxy");
  }

  const instructions = [];
  const input = [];

  for (const msg of chatReq.messages) {
    const role = String(msg?.role || "").trim();
    if (!role) continue;

    if (role === "system" || role === "developer") {
      const text = extractTextContent(msg.content).trim();
      if (text) instructions.push(text);
      continue;
    }

    if (role === "tool" || role === "function") {
      const output = extractTextContent(msg.content);
      if (msg.tool_call_id) {
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output,
        });
      } else {
        input.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: `[tool_output_missing_call_id] ${output}`,
            },
          ],
        });
      }
      continue;
    }

    if (role !== "user" && role !== "assistant") {
      input.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: `[${role}] ${extractTextContent(msg.content)}`,
          },
        ],
      });
      continue;
    }

    input.push({
      role,
      content: convertContentParts(role, msg.content),
    });

    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = call?.function?.name;
        const callId = call?.id;
        if (!name || !callId) continue;
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: call.function?.arguments || "",
        });
      }
    }
  }

  const maxOutputTokens = Math.max(
    Number(chatReq.max_tokens || 0),
    Number(chatReq.max_completion_tokens || 0),
  );

  const responsesReq = {
    model: chatReq.model,
    input,
    instructions: instructions.join("\n\n"),
    stream: true,
  };

  if (chatReq.temperature != null)
    responsesReq.temperature = chatReq.temperature;
  if (chatReq.top_p != null) responsesReq.top_p = chatReq.top_p;
  if (chatReq.user != null) responsesReq.user = chatReq.user;
  if (chatReq.metadata != null) responsesReq.metadata = chatReq.metadata;
  if (chatReq.store != null) responsesReq.store = chatReq.store;
  if (maxOutputTokens > 0) responsesReq.max_output_tokens = maxOutputTokens;
  if (chatReq.response_format)
    responsesReq.text = convertResponseFormat(chatReq.response_format);
  if (chatReq.tools) responsesReq.tools = convertTools(chatReq.tools);
  if (chatReq.tool_choice)
    responsesReq.tool_choice = convertToolChoice(chatReq.tool_choice);
  if (chatReq.parallel_tool_calls != null)
    responsesReq.parallel_tool_calls = chatReq.parallel_tool_calls;
  if (chatReq.reasoning_effort) {
    responsesReq.reasoning = {
      effort: chatReq.reasoning_effort,
      summary: "detailed",
    };
  }

  if (config.upstreamMode === "codex" && config.codexStrict) {
    responsesReq.instructions = responsesReq.instructions || "";
    responsesReq.store = false;
    delete responsesReq.max_output_tokens;
    delete responsesReq.temperature;
  }

  return responsesReq;
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getCodexAccountId() {
  if (config.codexAccountId) return config.codexAccountId;
  const claims = decodeJwtPayload(config.codexAccessToken);
  const auth = claims?.["https://api.openai.com/auth"];
  if (auth?.chatgpt_account_id) {
    config.codexAccountId = auth.chatgpt_account_id;
  }
  return config.codexAccountId;
}

function proxyAuthHeader(proxy) {
  if (!proxy.username) return undefined;
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password || "");
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function connectHttpProxy(proxy, target) {
  return new Promise((resolve, reject) => {
    const proxyTransport = proxy.protocol === "https:" ? https : http;
    const headers = { Host: target.host };
    const auth = proxyAuthHeader(proxy);
    if (auth) headers["Proxy-Authorization"] = auth;

    const req = proxyTransport.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: target.host,
      headers,
    });

    req.once("connect", (res, socket) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
      }
    });
    req.once("error", reject);
    req.end();
  });
}

async function connectSocks5(proxy, target) {
  const socket = await connectTcp(proxy.hostname, Number(proxy.port || 1080));
  const username = decodeURIComponent(proxy.username || "");
  const password = decodeURIComponent(proxy.password || "");
  const methods = username ? [0x00, 0x02] : [0x00];

  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  let chunk = await readSocketBytes(socket, 2);
  if (chunk[0] !== 0x05) throw new Error("invalid SOCKS5 proxy response");

  if (chunk[1] === 0x02) {
    if (!username) throw new Error("SOCKS5 proxy requires username/password");
    const userBuf = Buffer.from(username);
    const passBuf = Buffer.from(password);
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, userBuf.length]),
        userBuf,
        Buffer.from([passBuf.length]),
        passBuf,
      ]),
    );
    chunk = await readSocketBytes(socket, 2);
    if (chunk[1] !== 0x00) throw new Error("SOCKS5 authentication failed");
  } else if (chunk[1] !== 0x00) {
    throw new Error(`SOCKS5 proxy selected unsupported method ${chunk[1]}`);
  }

  const hostBuf = Buffer.from(target.hostname);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      portBuf,
    ]),
  );

  const head = await readSocketBytes(socket, 4);
  if (head[1] !== 0x00)
    throw new Error(`SOCKS5 connect failed: code ${head[1]}`);
  const atyp = head[3];
  if (atyp === 0x01) await readSocketBytes(socket, 4 + 2);
  else if (atyp === 0x03) {
    const len = await readSocketBytes(socket, 1);
    await readSocketBytes(socket, len[0] + 2);
  } else if (atyp === 0x04) await readSocketBytes(socket, 16 + 2);
  else throw new Error("invalid SOCKS5 bind address type");

  return socket;
}

let _socketReadBuffer = Buffer.alloc(0);

function readSocketBytes(socket, count) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      _socketReadBuffer = Buffer.concat([_socketReadBuffer, chunk]);
      if (_socketReadBuffer.length >= count) {
        socket.off("data", onData);
        socket.off("error", onError);
        const wanted = _socketReadBuffer.subarray(0, count);
        _socketReadBuffer = _socketReadBuffer.subarray(count);
        resolve(wanted);
      }
    };
    const onError = (error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function createProxiedSocket(targetUrl) {
  if (!config.proxyUrl) return null;
  const proxy = new URL(config.proxyUrl);
  let socket;
  if (proxy.protocol === "http:" || proxy.protocol === "https:") {
    socket = await connectHttpProxy(proxy, targetUrl);
  } else if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
    socket = await connectSocks5(proxy, targetUrl);
  } else {
    throw new Error(`unsupported PROXY_URL protocol: ${proxy.protocol}`);
  }

  if (targetUrl.protocol === "https:") {
    return tls.connect({
      socket,
      servername: targetUrl.hostname,
    });
  }
  return socket;
}

async function requestRaw(
  urlString,
  { method = "GET", headers = {}, body = undefined } = {},
) {
  const target = new URL(urlString);
  const useProxy = Boolean(config.proxyUrl);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;

  return new Promise(async (resolve, reject) => {
    let req;
    const timeout = setTimeout(() => {
      req?.destroy(new Error("upstream request timeout"));
    }, config.requestTimeoutMs);

    try {
      const options = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method,
        path: `${target.pathname}${target.search}`,
        headers,
      };

      if (useProxy && target.protocol === "http:") {
        const proxy = new URL(config.proxyUrl);
        if (proxy.protocol === "http:" || proxy.protocol === "https:") {
          const proxyTransport = proxy.protocol === "https:" ? https : http;
          const proxyHeaders = { ...headers, Host: target.host };
          const auth = proxyAuthHeader(proxy);
          if (auth) proxyHeaders["Proxy-Authorization"] = auth;
          req = proxyTransport.request(
            {
              hostname: proxy.hostname,
              port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
              method,
              path: target.href,
              headers: proxyHeaders,
            },
            (res) => {
              clearTimeout(timeout);
              resolve(res);
            },
          );
        } else {
          const socket = await createProxiedSocket(target);
          req = http.request(
            { ...options, createConnection: () => socket },
            (res) => {
              clearTimeout(timeout);
              resolve(res);
            },
          );
        }
      } else if (useProxy) {
        const socket = await createProxiedSocket(target);
        req = transport.request(
          { ...options, createConnection: () => socket },
          (res) => {
            clearTimeout(timeout);
            resolve(res);
          },
        );
      } else {
        req = transport.request(options, (res) => {
          clearTimeout(timeout);
          resolve(res);
        });
      }

      req.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      if (body != null) req.write(body);
      req.end();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

async function refreshCodexAccessToken() {
  if (!config.codexRefreshToken) return false;

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.codexRefreshToken,
    client_id: config.codexClientId,
  });

  const res = await requestRaw("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  const text = await streamToString(res);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `codex token refresh failed: HTTP ${res.statusCode} ${text.slice(0, 300)}`,
    );
  }
  const payload = JSON.parse(text);
  if (!payload.access_token)
    throw new Error("codex token refresh response missing access_token");
  config.codexAccessToken = payload.access_token;
  if (payload.refresh_token) config.codexRefreshToken = payload.refresh_token;
  return true;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function buildUpstreamHeaders() {
  if (config.upstreamMode === "codex") {
    if (!config.codexAccessToken) {
      await refreshCodexAccessToken();
    }
    const accountId = getCodexAccountId();
    if (!config.codexAccessToken)
      throw new Error("CODEX_ACCESS_TOKEN or CODEX_REFRESH_TOKEN is required");
    if (!accountId)
      throw new Error(
        "CODEX_ACCOUNT_ID is required and could not be extracted from access token",
      );
    return {
      Authorization: `Bearer ${config.codexAccessToken}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (config.upstreamApiKey) {
    headers.Authorization = `Bearer ${config.upstreamApiKey}`;
  }
  return headers;
}

async function callResponsesUpstream(responsesReq, retryOnUnauthorized = true) {
  const body = JSON.stringify(responsesReq);
  const headers = await buildUpstreamHeaders();
  const res = await requestRaw(config.upstreamResponsesUrl, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
  updateCodexUsageFromHeaders(res.headers);

  if (
    retryOnUnauthorized &&
    config.upstreamMode === "codex" &&
    (res.statusCode === 401 || res.statusCode === 403) &&
    config.codexRefreshToken
  ) {
    await streamToString(res);
    await refreshCodexAccessToken();
    return callResponsesUpstream(responsesReq, false);
  }

  return res;
}

function parseSseBlocks(buffer) {
  const parts = buffer.split(/\n\n/);
  return {
    blocks: parts.slice(0, -1),
    rest: parts.at(-1) || "",
  };
}

function parseSseData(block) {
  const dataLines = block
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return "[DONE]";
  return JSON.parse(data);
}

function isFunctionCallItem(item) {
  return item && typeof item === "object" && item.type === "function_call";
}

function createToolCallTracker() {
  return {
    calls: [],
    byKey: new Map(),
  };
}

function rememberToolCallKey(tracker, key, tracked) {
  if (key) tracker.byKey.set(String(key), tracked);
}

function ensureTrackedToolCall(tracker, item) {
  if (!isFunctionCallItem(item)) return null;

  const callId =
    item.call_id ||
    item.callId ||
    item.id ||
    `call_${randomUUID().replace(/-/g, "")}`;
  const keys = [item.id, item.call_id, item.callId, callId]
    .filter(Boolean)
    .map(String);
  let tracked = keys.map((key) => tracker.byKey.get(key)).find(Boolean);

  if (!tracked) {
    tracked = {
      index: tracker.calls.length,
      id: String(callId),
      itemId: item.id ? String(item.id) : "",
      name: "",
      arguments: "",
      identitySent: false,
      sentArgumentsLength: 0,
    };
    tracker.calls.push(tracked);
  }

  rememberToolCallKey(tracker, tracked.id, tracked);
  rememberToolCallKey(tracker, tracked.itemId, tracked);
  for (const key of keys) rememberToolCallKey(tracker, key, tracked);

  if (item.name) tracked.name = String(item.name);
  if (item.arguments != null) tracked.arguments = String(item.arguments);
  return tracked;
}

function findTrackedToolCall(tracker, event) {
  const keys = [
    event?.item_id,
    event?.itemId,
    event?.call_id,
    event?.callId,
    event?.output_item_id,
  ]
    .filter(Boolean)
    .map(String);

  for (const key of keys) {
    const tracked = tracker.byKey.get(key);
    if (tracked) return tracked;
  }

  if (tracker.calls.length === 1) return tracker.calls[0];
  return tracker.calls.at(-1) || null;
}

function addRemainingArgumentsAction(actions, tracked) {
  if (!tracked) return;
  const remaining = (tracked.arguments || "").slice(
    tracked.sentArgumentsLength || 0,
  );
  if (remaining) actions.push({ type: "arguments", tracked, delta: remaining });
}

function ingestFunctionCallEvent(event, tracker) {
  const actions = [];
  if (!event || event === "[DONE]") return actions;

  if (
    (event.type === "response.output_item.added" ||
      event.type === "response.output_item.done") &&
    isFunctionCallItem(event.item)
  ) {
    const tracked = ensureTrackedToolCall(tracker, event.item);
    actions.push({ type: "identity", tracked });
    if (event.type === "response.output_item.done")
      addRemainingArgumentsAction(actions, tracked);
    return actions;
  }

  if (event.type === "response.function_call_arguments.delta") {
    const tracked = findTrackedToolCall(tracker, event);
    if (!tracked) return actions;
    const delta = event.delta || "";
    tracked.arguments += delta;
    if (delta) actions.push({ type: "arguments", tracked, delta });
    return actions;
  }

  if (event.type === "response.function_call_arguments.done") {
    const tracked = findTrackedToolCall(tracker, event);
    if (!tracked) return actions;
    if (event.arguments != null) tracked.arguments = String(event.arguments);
    addRemainingArgumentsAction(actions, tracked);
    return actions;
  }

  if (
    event.type === "response.completed" &&
    Array.isArray(event.response?.output)
  ) {
    for (const item of event.response.output) {
      if (!isFunctionCallItem(item)) continue;
      const tracked = ensureTrackedToolCall(tracker, item);
      actions.push({ type: "identity", tracked });
      addRemainingArgumentsAction(actions, tracked);
    }
  }

  return actions;
}

function toChatToolCall(tracked) {
  return {
    id: tracked.id,
    type: "function",
    function: {
      name: tracked.name,
      arguments: tracked.arguments || "",
    },
  };
}

function getChatToolCalls(tracker) {
  return tracker.calls
    .filter((call) => call.name)
    .sort((a, b) => a.index - b.index)
    .map(toChatToolCall);
}

function chatChunk({
  id,
  model,
  created,
  delta,
  finishReason = null,
  usage = undefined,
}) {
  const choice = {
    index: 0,
    delta,
    finish_reason: finishReason,
  };
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [choice],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function extractUsage(response) {
  const usage = response?.usage;
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens || 0,
    completion_tokens: usage.output_tokens || 0,
    total_tokens:
      usage.total_tokens ||
      (usage.input_tokens || 0) + (usage.output_tokens || 0),
  };
}

function normalizeUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0),
  };
}

function parseNumberHeader(headers, name) {
  const value = headers[name];
  if (value == null || value === "") return null;
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(number) ? number : null;
}

function parseBooleanHeader(headers, name) {
  const value = headers[name];
  if (value == null || value === "") return null;
  const text = String(Array.isArray(value) ? value[0] : value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return null;
}

function parseStringHeader(headers, name) {
  const value = headers[name];
  if (value == null || value === "") return null;
  return String(Array.isArray(value) ? value[0] : value);
}

function extractCodexRateLimits(headers) {
  const primaryUsed = parseNumberHeader(headers, "x-codex-primary-used-percent");
  const secondaryUsed = parseNumberHeader(
    headers,
    "x-codex-secondary-used-percent",
  );
  if (primaryUsed == null && secondaryUsed == null) return null;
  return {
    limit_id: "codex",
    active_limit: parseStringHeader(headers, "x-codex-active-limit"),
    plan_type: parseStringHeader(headers, "x-codex-plan-type"),
    primary: {
      used_percent: primaryUsed,
      window_minutes: parseNumberHeader(
        headers,
        "x-codex-primary-window-minutes",
      ),
      reset_after_seconds: parseNumberHeader(
        headers,
        "x-codex-primary-reset-after-seconds",
      ),
      resets_at: parseNumberHeader(headers, "x-codex-primary-reset-at"),
    },
    secondary: {
      used_percent: secondaryUsed,
      window_minutes: parseNumberHeader(
        headers,
        "x-codex-secondary-window-minutes",
      ),
      reset_after_seconds: parseNumberHeader(
        headers,
        "x-codex-secondary-reset-after-seconds",
      ),
      resets_at: parseNumberHeader(headers, "x-codex-secondary-reset-at"),
    },
    credits: {
      has_credits: parseBooleanHeader(headers, "x-codex-credits-has-credits"),
      balance: parseStringHeader(headers, "x-codex-credits-balance"),
      unlimited: parseBooleanHeader(headers, "x-codex-credits-unlimited"),
    },
  };
}

function updateCodexUsageFromHeaders(headers) {
  if (config.upstreamMode !== "codex") return;
  const rateLimits = extractCodexRateLimits(headers);
  if (rateLimits) codexUsage.rate_limits = rateLimits;
}

async function appendRequestLog(entry) {
  const usage = normalizeUsage(entry.usage);
  cumulativeUsage.request_count += 1;
  cumulativeUsage.prompt_tokens += usage.prompt_tokens;
  cumulativeUsage.completion_tokens += usage.completion_tokens;
  cumulativeUsage.total_tokens += usage.total_tokens;

  const logEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
    usage,
    cumulative_usage: { ...cumulativeUsage },
  };

  try {
    await fs.mkdir(path.dirname(config.logFile), { recursive: true });
    await fs.appendFile(
      config.logFile,
      `${JSON.stringify(logEntry)}\n`,
      "utf8",
    );
  } catch (error) {
    console.error(`failed to append request log: ${error.message}`);
  }
}

async function appendRawUpstreamLog(entry) {
  const rawResponse = String(entry.raw_response || "");
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
    raw_response_length: Buffer.byteLength(rawResponse, "utf8"),
  };

  try {
    await fs.mkdir(path.dirname(config.rawLogFile), { recursive: true });
    await fs.appendFile(
      config.rawLogFile,
      `${JSON.stringify(logEntry)}\n`,
      "utf8",
    );
  } catch (error) {
    console.error(`failed to append upstream raw log: ${error.message}`);
  }
}

async function handleChatCompletions(req, res) {
  const requestId = `chatcmpl-${randomUUID()}`;
  let chatReq;
  try {
    chatReq = await readJsonBody(req);
  } catch (error) {
    sendJson(
      res,
      400,
      openAiError(
        `invalid JSON body: ${error.message}`,
        "invalid_request_error",
      ),
    );
    return;
  }

  let responsesReq;
  try {
    responsesReq = chatToResponsesBody(chatReq);
  } catch (error) {
    sendJson(res, 400, openAiError(error.message, "invalid_request_error"));
    return;
  }

  let upstream;
  try {
    upstream = await callResponsesUpstream(responsesReq);
  } catch (error) {
    sendJson(
      res,
      502,
      openAiError(
        `upstream request failed: ${error.message}`,
        "upstream_error",
      ),
    );
    return;
  }

  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    const body = await streamToString(upstream);
    await appendRawUpstreamLog({
      request_id: requestId,
      mode: chatReq.stream ? "stream" : "non_stream",
      status: `upstream_http_${upstream.statusCode}`,
      requested_model: chatReq.model,
      responses_request: responsesReq,
      upstream_status_code: upstream.statusCode,
      upstream_headers: upstream.headers,
      raw_response: body,
    });
    res.writeHead(upstream.statusCode, {
      "Content-Type": upstream.headers["content-type"] || "application/json",
    });
    res.end(
      body ||
        JSON.stringify(
          openAiError(`upstream HTTP ${upstream.statusCode}`, "upstream_error"),
        ),
    );
    return;
  }

  if (chatReq.stream) {
    await streamResponsesAsChat(
      upstream,
      chatReq,
      res,
      requestId,
      responsesReq,
    );
  } else {
    await collectResponsesAsChat(
      upstream,
      chatReq,
      res,
      requestId,
      responsesReq,
    );
  }
}

async function streamResponsesAsChat(
  upstream,
  chatReq,
  res,
  requestId,
  responsesReq,
) {
  const id = requestId;
  const created = Math.floor(Date.now() / 1000);
  let model = chatReq.model;
  let sentRole = false;
  let buffer = "";
  let finalUsage;
  let output = "";
  let errorMessage = "";
  let rawResponse = "";
  const toolTracker = createToolCallTracker();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendRole = () => {
    if (sentRole) return;
    res.write(chatChunk({ id, model, created, delta: { role: "assistant" } }));
    sentRole = true;
  };

  const sendToolIdentity = (tracked) => {
    if (!tracked || tracked.identitySent) return;
    sendRole();
    res.write(
      chatChunk({
        id,
        model,
        created,
        delta: {
          tool_calls: [
            {
              index: tracked.index,
              id: tracked.id,
              type: "function",
              function: {
                name: tracked.name || "",
                arguments: "",
              },
            },
          ],
        },
      }),
    );
    tracked.identitySent = true;
  };

  const sendToolArguments = (tracked, delta) => {
    if (!tracked || !delta) return;
    sendToolIdentity(tracked);
    res.write(
      chatChunk({
        id,
        model,
        created,
        delta: {
          tool_calls: [
            {
              index: tracked.index,
              function: { arguments: delta },
            },
          ],
        },
      }),
    );
    tracked.sentArgumentsLength += delta.length;
  };

  const sendFunctionCallActions = (actions) => {
    for (const action of actions) {
      if (action.type === "identity") sendToolIdentity(action.tracked);
      if (action.type === "arguments")
        sendToolArguments(action.tracked, action.delta);
    }
  };

  for await (const chunk of upstream) {
    const chunkText = Buffer.from(chunk).toString("utf8");
    rawResponse += chunkText;
    buffer += chunkText;
    const parsed = parseSseBlocks(buffer);
    buffer = parsed.rest;

    for (const block of parsed.blocks) {
      let event;
      try {
        event = parseSseData(block);
      } catch (error) {
        await appendRawUpstreamLog({
          request_id: id,
          mode: "stream",
          status: "parse_error",
          requested_model: chatReq.model,
          upstream_model: model,
          responses_request: responsesReq,
          raw_response: rawResponse,
          error: error.message,
        });
        res.write(
          chatChunk({
            id,
            model,
            created,
            delta: { content: "" },
            finishReason: "stop",
          }),
        );
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }
      if (!event || event === "[DONE]") continue;

      if (event.response?.model) model = event.response.model;
      if (event.response?.usage) finalUsage = extractUsage(event.response);
      sendFunctionCallActions(ingestFunctionCallEvent(event, toolTracker));

      if (event.type === "response.output_text.delta" && event.delta) {
        sendRole();
        output += event.delta;
        res.write(
          chatChunk({ id, model, created, delta: { content: event.delta } }),
        );
      } else if (event.type === "response.completed") {
        finalUsage = extractUsage(event.response) || finalUsage;
      } else if (event.type === "response.failed") {
        errorMessage = event.response?.error?.message || "response.failed";
        sendRole();
        res.write(
          chatChunk({ id, model, created, delta: {}, finishReason: "stop" }),
        );
        res.write(`data: [DONE]\n\n`);
        res.end();
        await appendRequestLog({
          request_id: id,
          mode: "stream",
          status: "failed",
          requested_model: chatReq.model,
          upstream_model: model,
          input: chatReq.messages,
          responses_request: responsesReq,
          output,
          error: errorMessage,
          usage: finalUsage,
          tool_calls: getChatToolCalls(toolTracker),
        });
        await appendRawUpstreamLog({
          request_id: id,
          mode: "stream",
          status: "failed",
          requested_model: chatReq.model,
          upstream_model: model,
          responses_request: responsesReq,
          raw_response: rawResponse,
          error: errorMessage,
          usage: finalUsage,
        });
        return;
      }
    }
  }

  const toolCalls = getChatToolCalls(toolTracker);
  const finishReason = toolCalls.length ? "tool_calls" : "stop";
  sendRole();
  res.write(
    chatChunk({
      id,
      model,
      created,
      delta: {},
      finishReason,
      usage: finalUsage,
    }),
  );
  res.write(`data: [DONE]\n\n`);
  res.end();

  await appendRequestLog({
    request_id: id,
    mode: "stream",
    status: "completed",
    requested_model: chatReq.model,
    upstream_model: model,
    input: chatReq.messages,
    responses_request: responsesReq,
    output,
    tool_calls: toolCalls,
    finish_reason: finishReason,
    usage: finalUsage,
  });
  await appendRawUpstreamLog({
    request_id: id,
    mode: "stream",
    status: "completed",
    requested_model: chatReq.model,
    upstream_model: model,
    responses_request: responsesReq,
    raw_response: rawResponse,
    usage: finalUsage,
  });
}

async function collectResponsesAsChat(
  upstream,
  chatReq,
  res,
  requestId,
  responsesReq,
) {
  const id = requestId;
  const created = Math.floor(Date.now() / 1000);
  let model = chatReq.model;
  let output = "";
  let usage;
  let buffer = "";
  let rawResponse = "";
  const toolTracker = createToolCallTracker();

  for await (const chunk of upstream) {
    const chunkText = Buffer.from(chunk).toString("utf8");
    rawResponse += chunkText;
    buffer += chunkText;
    const parsed = parseSseBlocks(buffer);
    buffer = parsed.rest;

    for (const block of parsed.blocks) {
      let event;
      try {
        event = parseSseData(block);
      } catch {
        continue;
      }
      if (!event || event === "[DONE]") continue;
      if (event.response?.model) model = event.response.model;
      if (event.response?.usage) usage = extractUsage(event.response);
      ingestFunctionCallEvent(event, toolTracker);
      if (event.type === "response.output_text.delta")
        output += event.delta || "";
      if (event.type === "response.output_text.done" && !output)
        output = event.text || "";
      if (event.type === "response.completed")
        usage = extractUsage(event.response) || usage;
    }
  }

  const toolCalls = getChatToolCalls(toolTracker);
  const finishReason = toolCalls.length ? "tool_calls" : "stop";
  const message = {
    role: "assistant",
    content: toolCalls.length ? output || null : output,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });

  await appendRequestLog({
    request_id: id,
    mode: "non_stream",
    status: "completed",
    requested_model: chatReq.model,
    upstream_model: model,
    input: chatReq.messages,
    responses_request: responsesReq,
    output,
    tool_calls: toolCalls,
    finish_reason: finishReason,
    usage,
  });
  await appendRawUpstreamLog({
    request_id: id,
    mode: "non_stream",
    status: "completed",
    requested_model: chatReq.model,
    upstream_model: model,
    responses_request: responsesReq,
    raw_response: rawResponse,
    usage,
  });
}

function authorizeLocal(req, res) {
  if (!config.localApiKey) return true;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${config.localApiKey}`) return true;
  sendJson(res, 401, openAiError("Invalid token", "invalid_request_error"));
  return false;
}

const FALLBACK_MODELS = [
  { id: "gpt-4o", owned_by: "openai" },
  { id: "gpt-4o-mini", owned_by: "openai" },
  { id: "gpt-4-turbo", owned_by: "openai" },
  { id: "gpt-4", owned_by: "openai" },
  { id: "gpt-3.5-turbo", owned_by: "openai" },
  { id: "o3", owned_by: "openai" },
  { id: "o3-mini", owned_by: "openai" },
  { id: "o4-mini", owned_by: "openai" },
];

function deriveModelsUrl() {
  const url = new URL(config.upstreamModelsUrl || config.upstreamResponsesUrl);
  if (!config.upstreamModelsUrl) {
    url.pathname = url.pathname.replace(/\/responses\/?$/, "/models");
  }
  if (
    config.upstreamMode === "codex" &&
    config.codexClientVersion &&
    !url.searchParams.has("client_version")
  ) {
    url.searchParams.set("client_version", config.codexClientVersion);
  }
  return url.toString();
}

function normalizeUpstreamModels(raw) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.data)
      ? raw.data
      : raw.models;
  if (!Array.isArray(list)) return null;
  return list
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const id = m.id || m.slug || m.model || m.name;
      if (!id) return null;
      return {
        id,
        object: "model",
        created: m.created || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || m.ownedBy || "openai",
      };
    })
    .filter(Boolean);
}

async function fetchUpstreamModels() {
  const modelsUrl = deriveModelsUrl();
  const headers = await buildUpstreamHeaders();
  const res = await requestRaw(modelsUrl, {
    method: "GET",
    headers: { ...headers, Accept: "application/json" },
  });
  const text = await streamToString(res);
  if (res.statusCode < 200 || res.statusCode >= 300) return null;
  const parsed = JSON.parse(text);
  return normalizeUpstreamModels(parsed);
}

async function handleModels(_req, res) {
  const now = Date.now();
  try {
    const upstreamModels = await fetchUpstreamModels();
    if (upstreamModels && upstreamModels.length > 0) {
      sendJson(res, 200, { object: "list", data: upstreamModels });
      return;
    }
  } catch {}

  const fallback = FALLBACK_MODELS.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(now / 1000),
    owned_by: m.owned_by,
  }));
  sendJson(res, 200, { object: "list", data: fallback });
}

function handleUsage(_req, res) {
  const payload = {
    object: "proxy.usage",
    cumulative_usage: { ...cumulativeUsage },
  };
  if (config.upstreamMode === "codex" && codexUsage.rate_limits) {
    payload.codex = { rate_limits: codexUsage.rate_limits };
  }
  sendJson(res, 200, payload);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, upstream_mode: config.upstreamMode });
      return;
    }

    if (!authorizeLocal(req, res)) return;

    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleModels(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/usage") {
      handleUsage(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    sendJson(
      res,
      404,
      openAiError(
        `Invalid URL (${req.method} ${url.pathname})`,
        "invalid_request_error",
      ),
    );
  } catch (error) {
    sendJson(res, 500, openAiError(error.message));
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `chat-completions-to-responses proxy listening on http://${config.host}:${config.port}`,
  );
  console.log(`upstream mode: ${config.upstreamMode}`);
  console.log(`upstream responses url: ${config.upstreamResponsesUrl}`);
  if (config.proxyUrl) console.log(`proxy: ${config.proxyUrl}`);
  console.log(`request log: ${config.logFile}`);
});
