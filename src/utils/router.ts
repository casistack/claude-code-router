import {
  MessageCreateParamsBase,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";

const enc = get_encoding("cl100k_base");

const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  config: any,
  lastUsage?: Usage | undefined
) => {
  // If an agent (like imageAgent) already set a fully-qualified provider,model keep it
  // We still run other routing logic only when model is an alias (e.g. "default") or single provider string
  const originalModel = req.body.model;
  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = config.Providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return `${finalProvider.name},${finalModel}`;
    }
    return req.body.model;
  }

  // Auto image routing: if any user message contains an image part and a Router.image is configured
  // and current model is an alias (e.g. "default") or equals config.Router.default, prefer Router.image.
  try {
    if (config.Router?.image) {
      const hasImage =
        Array.isArray(req.body.messages) &&
        req.body.messages.some(
          (msg: any) =>
            msg.role === "user" &&
            Array.isArray(msg.content) &&
            msg.content.some((c: any) => c.type === "image")
        );
      if (hasImage) {
        const aliasModels = ["default", "image"];
        if (
          aliasModels.includes(originalModel) ||
          originalModel === config.Router.default
        ) {
          return config.Router.image;
        }
      }
    }
  } catch (e) {
    req.log?.warn?.(`image auto-route check failed: ${(e as Error).message}`);
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = config.Router.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if (
    (lastUsageThreshold || tokenCountThreshold) &&
    config.Router.longContext
  ) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return config.Router.longContext;
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return model[1];
    }
  }
  // If the model is claude-3-5-haiku, use the background model
  if (
    req.body.model?.startsWith("claude-3-5-haiku") &&
    config.Router.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return config.Router.background;
  }
  // if exits thinking, use the think model
  if (req.body.thinking && config.Router.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return config.Router.think;
  }
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    config.Router.webSearch
  ) {
    return config.Router.webSearch;
  }
  return config.Router!.default;
};

export const router = async (req: any, _res: any, context: any) => {
  const { config, event } = context;
  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  if (
    config.REWRITE_SYSTEM_PROMPT &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(config.REWRITE_SYSTEM_PROMPT, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    const tokenCount = calculateTokenCount(
      messages as MessageParam[],
      system,
      tools as Tool[]
    );

    // Sanitize outbound images before model decision (ensures routing considers real content)
    try {
      sanitizeAndNormalizeImages(req, config);
    } catch (e: any) {
      req.log?.warn?.(`image sanitize error: ${e.message}`);
    }

    let model;
    if (config.CUSTOM_ROUTER_PATH) {
      try {
        const customRouter = require(config.CUSTOM_ROUTER_PATH);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, config, {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      model = await getUseModel(req, tokenCount, config, lastMessageUsage);
    }
    req.body.model = model;
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    req.body.model = config.Router!.default;
  }
  return;
};

// --- Image sanitation / normalization ---
function sanitizeAndNormalizeImages(req: any, config: any) {
  const body = req.body || {};
  if (!Array.isArray(body.messages)) return;
  const modelSpec = (body.model || "").split(",");
  const targetModel = modelSpec[1] || modelSpec[0] || "";
  const isGemini = /gemini/i.test(targetModel);
  let kept = 0,
    dropped = 0,
    converted = 0,
    placeholders = 0;
  body.messages.forEach((msg: any) => {
    if (!Array.isArray(msg.content)) return;
    msg.content = msg.content.flatMap((part: any) => {
      if (part?.type === "text" && /\[Image #\d+\]/.test(part.text || "")) {
        placeholders++;
        return [part];
      }
      if (part?.type === "image_url") {
        const url = part.image_url?.url || "";
        const comma = url.indexOf(",");
        if (comma === -1) {
          dropped++;
          return [];
        }
        const mediaMatch = /^data:([^;]+);base64,/.exec(url);
        const base = url.slice(comma + 1);
        if (
          !mediaMatch ||
          base.length < 100 ||
          !/^[A-Za-z0-9+/=]+$/.test(base)
        ) {
          dropped++;
          return [];
        }
        if (isGemini) {
          converted++;
          return [
            {
              type: "image",
              source: { type: "base64", media_type: mediaMatch[1], data: base },
            },
          ];
        }
        kept++;
        return [part];
      }
      if (part?.type === "image" && part.source?.type === "base64") {
        const data = part.source.data || "";
        if (data.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
          dropped++;
          return [];
        }
        kept++;
        return [part];
      }
      return [part];
    });
  });
  // If only placeholders remain without any images kept/converted and no tool usage yet, add guidance
  if (kept + converted === 0 && placeholders > 0) {
    body.system = body.system || [];
    body.system.push({
      type: "text",
      text: "Image data not present for referenced placeholders. Ask the user to resend the image or call analyzeImage if available.",
    });
  }
  req.log?.debug?.(
    `[imageSanitize] kept=${kept} converted=${converted} dropped=${dropped} placeholders=${placeholders} gemini=${isGemini}`
  );
}
