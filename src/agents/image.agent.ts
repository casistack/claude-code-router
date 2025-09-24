import { IAgent, ITool } from "./type";
import { LRUCache } from "lru-cache";

interface ImageCacheEntry {
  source: any;
  timestamp: number;
}

class ImageCache {
  private cache: LRUCache<string, ImageCacheEntry>;

  constructor(maxSize = 100) {
    this.cache = new LRUCache({
      max: maxSize,
      ttl: 24 * 60 * 60 * 1000,
    });
  }

  storeImage(id: string, source: any): void {
    if (this.hasImage(id)) return;
    this.cache.set(id, {
      source,
      timestamp: Date.now(),
    });
  }

  getImage(id: string): any {
    const entry = this.cache.get(id);
    return entry ? entry.source : null;
  }

  hasImage(hash: string): boolean {
    return this.cache.has(hash);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

const imageCache = new ImageCache();

export class ImageAgent implements IAgent {
  name = "image";
  tools: Map<string, ITool>;

  constructor() {
    this.tools = new Map<string, ITool>();
    this.appendTools();
  }

  shouldHandle(req: any, config: any): boolean {
    try {
      if (!config.Router.image) return false;
      const mode =
        config.Image?.mode || (config.forceUseImageAgent ? "tool" : "hybrid");
      const hasRawImage = req.body.messages.some(
        (msg: any) =>
          msg.role === "user" &&
          Array.isArray(msg.content) &&
          msg.content.some((p: any) => p.type === "image")
      );
      const hasPlaceholder = req.body.messages.some(
        (msg: any) =>
          msg.role === "user" &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (p: any) => p.type === "text" && /\[Image #\d+\]/.test(p.text || "")
          )
      );
      if (!hasRawImage && !hasPlaceholder) return false;

      // Switch model only when raw image data exists
      if (hasRawImage && req.body.model !== config.Router.image) {
        const prev = req.body.model;
        req.body.model = config.Router.image;
        req.log?.debug?.(
          `[imageAgent] model -> ${req.body.model} (prev=${prev}) mode=${mode} raw=${hasRawImage} placeholder=${hasPlaceholder}`
        );
      } else if (!hasRawImage && hasPlaceholder) {
        req.log?.debug?.(
          "[imageAgent] Placeholder-only reference detected; leaving model unchanged"
        );
      }

      if (mode === "direct" && hasRawImage) return false; // direct path - no mutation
      return true; // run reqHandler for tool/hybrid or placeholder resolution
    } catch (e) {
      req.log?.warn?.(
        `[imageAgent] shouldHandle error: ${(e as Error).message}`
      );
      return false;
    }
  }

  appendTools() {
    this.tools.set("analyzeImage", {
      name: "analyzeImage",
      description:
        "Analyse image or images by ID and extract information such as OCR text, objects, layout, colors, or safety signals.",
      input_schema: {
        type: "object",
        properties: {
          imageId: {
            type: "array",
            description: "an array of IDs to analyse",
            items: {
              type: "string",
            },
          },
          task: {
            type: "string",
            description:
              "Details of task to perform on the image.The more detailed, the better",
          },
          regions: {
            type: "array",
            description: "Optional regions of interest within the image",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Optional label for the region",
                },
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
                w: { type: "number", description: "Width of the region" },
                h: { type: "number", description: "Height of the region" },
                units: {
                  type: "string",
                  enum: ["px", "pct"],
                  description: "Units for coordinates and size",
                },
              },
              required: ["x", "y", "w", "h", "units"],
            },
          },
        },
        required: ["imageId", "task"],
      },
      handler: async (args, context) => {
        console.log("args", JSON.stringify(args, null, 2));
        const imageMessages = [];
        let imageId;

        // Create image messages from cached images
        if (args.imageId && Array.isArray(args.imageId)) {
          const sessionKeys = new Set<string>();
          sessionKeys.add(context.req.id);
          const metaUserId = context.req.body?.metadata?.user_id;
          if (metaUserId) {
            const parts = metaUserId.split("_session_");
            if (parts.length > 1) sessionKeys.add(parts[1]);
          }

          args.imageId.forEach((imgId: string) => {
            let image = null;
            for (const key of sessionKeys) {
              image = imageCache.getImage(`${key}_Image#${imgId}`);
              if (image) break;
            }
            if (image) {
              imageMessages.push({
                type: "image",
                source: image,
              });
            }
          });
          imageId = args.imageId;
          delete args.imageId;
        }

        if (Object.keys(args).length > 0) {
          imageMessages.push({
            type: "text",
            text: JSON.stringify(args),
          });
        }

        // Send to analysis agent and get response
        const agentResponse = await fetch(
          `http://127.0.0.1:${context.config.PORT}/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": context.config.APIKEY,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: context.config.Router.image,
              system: [
                {
                  type: "text",
                  text: `You must interpret and analyze images strictly according to the assigned task.  
When an image placeholder is provided, your role is to parse the image content only within the scope of the user’s instructions.  
Do not ignore or deviate from the task.  
Always ensure that your response reflects a clear, accurate interpretation of the image aligned with the given objective.`,
                },
              ],
              messages: [
                {
                  role: "user",
                  content: imageMessages,
                },
              ],
              stream: false,
            }),
          }
        )
          .then((res) => res.json())
          .catch((err) => {
            return null;
          });
        console.log(agentResponse.content);
        if (!agentResponse || !agentResponse.content) {
          return "analyzeImage Error";
        }
        return agentResponse.content[0].text;
      },
    });
  }

  reqHandler(req: any, config: any) {
    const mode =
      config.Image?.mode || (config.forceUseImageAgent ? "tool" : "hybrid");
    const providerName = (req.body.model || "").split(",")[0];
    const provider = config.Providers?.find(
      (p: any) => p.name.toLowerCase() === providerName.toLowerCase()
    );
    // Dynamic format decision
    const modelSpec = (req.body.model || "").split(",");
    const targetModel = modelSpec[1] || modelSpec[0] || "";
    const isOpenRouter = !!provider?.transformer?.use?.includes("openrouter");
    const isGoogleGemini = /gemini/i.test(targetModel);
    const imageCfg = config.Image || {};
    // Allow override via config.Image.forceImageUrl = true/false
    // Default policy:
    //  - For openrouter+gemini: send Anthropic style base64 part (openrouter will adapt) -> no image_url
    //  - For other openrouter vision models: use image_url data URI
    //  - For non-openrouter: keep original part
    let needsImageUrl = false;
    if (imageCfg.forceImageUrl === true) {
      needsImageUrl = true;
    } else if (imageCfg.forceImageUrl === false) {
      needsImageUrl = false;
    } else if (isOpenRouter && !isGoogleGemini) {
      needsImageUrl = true;
    }
    req.log?.debug?.(
      `[imageAgent] format decision provider=${providerName} targetModel=${targetModel} openrouter=${isOpenRouter} gemini=${isGoogleGemini} needsImageUrl=${needsImageUrl}`
    );

    // Determine a stable session key (match router session logic if possible)
    let sessionKey = req.id;
    if (req.body?.metadata?.user_id) {
      const parts = req.body.metadata.user_id.split("_session_");
      if (parts.length > 1) sessionKey = parts[1];
    }

    const userMessages = req.body.messages.filter(
      (m: any) => m.role === "user" && Array.isArray(m.content)
    );
    const placeholderIds = new Set<number>();
    userMessages.forEach((m: any) =>
      m.content.forEach((part: any) => {
        if (part.type === "text" && typeof part.text === "string") {
          const matches = part.text.matchAll(/\[Image #(\d+)\]/g);
          for (const match of matches) {
            placeholderIds.add(Number(match[1]));
          }
        }
      })
    );
    // Collect raw images (only once per request)
    let nextId = 1;
    const images: {
      id: number;
      media_type: string;
      data: string;
      part: any;
    }[] = [];
    userMessages.forEach((m: any) =>
      m.content.forEach((part: any) => {
        if (part.type === "image" && part.source?.type === "base64") {
          const id = nextId++;
          imageCache.storeImage(`${sessionKey}_Image#${id}`, part.source);
          imageCache.storeImage(`${req.id}_Image#${id}`, part.source); // legacy mapping
          images.push({
            id,
            media_type: part.source.media_type || "image/png",
            data: part.source.data,
            part,
          });
        }
      })
    );

    const hasPlaceholdersOnly = !images.length && placeholderIds.size > 0;
    if (hasPlaceholdersOnly) {
      const available: number[] = [];
      const missing: number[] = [];
      placeholderIds.forEach((id) => {
        const sessionKeyCandidate = `${sessionKey}_Image#${id}`;
        const reqKeyCandidate = `${req.id}_Image#${id}`;
        if (
          imageCache.hasImage(sessionKeyCandidate) ||
          imageCache.hasImage(reqKeyCandidate)
        ) {
          available.push(id);
        } else {
          missing.push(id);
        }
      });

      let guidance: string;
      if (!available.length) {
        guidance =
          "The user referenced image placeholders, but no image data is cached. Do NOT describe or guess. Ask the user to resend the image (paste again) or provide a file path.";
      } else if (missing.length) {
        guidance = `Image data found for ${available
          .map((id) => `[Image #${id}]`)
          .join(", ")} but missing for ${missing
          .map((id) => `[Image #${id}]`)
          .join(
            ", "
          )}. Do not invent details. Offer to analyze the available images via the analyzeImage tool and request the user resend the missing ones.`;
      } else {
        guidance = `Image data is cached for ${Array.from(placeholderIds)
          .map((id) => `[Image #${id}]`)
          .join(
            ", "
          )}. You must call analyzeImage with the relevant imageId values to answer; do not describe the images directly.`;

        // Surface metadata for downstream use
        const imageMetas = Array.from(placeholderIds).map((id) => {
          const cacheSource =
            imageCache.getImage(`${sessionKey}_Image#${id}`) ||
            imageCache.getImage(`${req.id}_Image#${id}`);
          return {
            id,
            media_type: cacheSource?.media_type || "image/png",
          };
        });
        (req as any)._ccrImages = imageMetas;
      }

      req.log?.debug?.(
        `[imageAgent] Placeholder-only request processed (available=${available.length}, missing=${missing.length})`
      );

      req.body?.system?.push({
        type: "text",
        text: guidance,
      });
      return;
    }

    // Build mapping for follow-up
    if (images.length)
      (req as any)._ccrImages = images.map((i) => ({
        id: i.id,
        media_type: i.media_type,
      }));

    if ((mode === "tool" || mode === "hybrid") && images.length) {
      userMessages.forEach((m: any) => {
        const rebuilt: any[] = [];
        m.content.forEach((part: any) => {
          if (part.type === "image" && part.source?.type === "base64") {
            const current = images.shift();
            if (!current) return;
            const placeholder = {
              type: "text",
              text: `[Image #${current.id}]`,
            };
            if (mode === "tool") {
              rebuilt.push(placeholder);
            } else {
              // hybrid
              // Validate base64 roughly (length & charset) before any conversion
              const isLikelyBase64 =
                typeof current.data === "string" &&
                current.data.length > 100 &&
                /^[A-Za-z0-9+/=]+$/.test(current.data.replace(/\s+/g, ""));
              if (!isLikelyBase64) {
                req.log?.warn?.(
                  `[imageAgent] skipping image#${current.id} invalid/short base64 length=${current.data?.length}`
                );
                // fallback: keep original part if present
                rebuilt.push(part);
              } else if (needsImageUrl) {
                // Use data URI for non-gemini openrouter paths
                rebuilt.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${current.media_type};base64,${current.data}`,
                  },
                });
                req.log?.debug?.(
                  `[imageAgent] attach image#${current.id} as image_url bytes=${current.data.length}`
                );
              } else {
                // Keep original Anthropic style part
                rebuilt.push(part);
                req.log?.debug?.(
                  `[imageAgent] attach image#${current.id} as base64 part bytes=${current.data.length}`
                );
              }
              rebuilt.push(placeholder);
            }
          } else {
            rebuilt.push(part);
          }
        });
        m.content = rebuilt;
      });
    }

    if (mode === "tool") {
      req.body?.system?.push({
        type: "text",
        text: `Image tool mode active. You cannot perceive images directly. Whenever a user references [Image #n], you MUST call analyzeImage with the corresponding imageId array to obtain visual information. Never describe or guess image content yourself. Request the image again if it's unavailable.`,
      });
    } else if (mode === "hybrid") {
      req.body?.system?.push({
        type: "text",
        text: `Hybrid image handling active. Inline images may appear for quick descriptions, but tasks requiring OCR, regions, object enumeration, safety checks, or comparisons must use analyzeImage with the relevant imageId(s). Never fabricate visual details.`,
      });
    }
  }
}

export const imageAgent = new ImageAgent();
