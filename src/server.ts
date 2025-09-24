// Type import may not have bundled d.ts; using any fallback for now
import Server from "@musistudio/llms";
import type { FastifyRequest, FastifyReply } from 'fastify';
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { checkForUpdates, performUpdate } from "./utils";
import { join } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";

export const createServer = (config: any): any => {
  const server = new Server(config);

  // Outbound request sanitation hook for image content (applies to /v1/messages)
  server.app.addHook('preHandler', async (req: FastifyRequest & { routerPath?: string; log?: any; body?: any }, reply: FastifyReply) => {
    try {
      if (req.routerPath !== '/v1/messages' || req.method !== 'POST') return;
      const body = req.body;
      if (!body || !Array.isArray(body.messages)) return;
      const modelSpec = (body.model || '').split(',');
      const targetModel = modelSpec[1] || modelSpec[0] || '';
      const isGemini = /gemini/i.test(targetModel);

      let kept = 0, dropped = 0, converted = 0, placeholders = 0;
      body.messages.forEach((m: any) => {
        if (!Array.isArray(m.content)) return;
        m.content = m.content.flatMap((part: any) => {
          if (part?.type === 'text' && /\[Image #\d+\]/.test(part.text || '')) {
            placeholders++; return [part];
          }
          // image_url normalization
            if (part?.type === 'image_url') {
              const url = part.image_url?.url || '';
              const idx = url.indexOf(',');
              if (idx === -1) { dropped++; return []; }
              const base = url.slice(idx + 1);
              const mtMatch = /^data:([^;]+);base64,/.exec(url);
              if (base.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(base)) { dropped++; return []; }
              if (isGemini) {
                converted++;
                return [{ type: 'image', source: { type: 'base64', media_type: (mtMatch?mtMatch[1]:'image/png'), data: base }}];
              }
              kept++; return [part];
            }
          // raw image validation
          if (part?.type === 'image' && part.source?.type === 'base64') {
            const data = part.source.data || '';
            if (data.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(data)) { dropped++; return []; }
            kept++; return [part];
          }
          return [part];
        });
      });
      // If placeholders remain but all images gone and request only relies on them, append guidance
      const totalImages = kept + converted;
      if (placeholders > 0 && totalImages === 0) {
        body.system = body.system || [];
        body.system.push({
          type: 'text',
          text: 'Placeholders referenced but no image data present. Ask user to resend the image(s) or invoke analyzeImage only after images are re-sent.'
        });
      }
      req.log?.debug?.(`[imageSend] model=${targetModel} kept=${kept} converted=${converted} dropped=${dropped} placeholders=${placeholders}`);
      // Redacted sample for debugging (first valid image length)
      if (kept + converted > 0) {
        const firstMsg = body.messages.find((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image'));
        const firstImg = firstMsg?.content.find((p: any) => p.type === 'image');
        if (firstImg?.source?.data) {
          req.log?.debug?.(`[imageSend] firstImageBytes=${firstImg.source.data.length}`);
        }
      }
    } catch (e) {
      req.log?.warn?.(`[imageSend] sanitizer error: ${(e as Error).message}`);
    }
  });

  // Add endpoint to read config.json with access control
  server.app.get("/api/config", async (req: FastifyRequest, reply: FastifyReply) => {
    return await readConfigFile();
  });

  server.app.get("/api/transformers", async () => {
    const transformers =
      server.app._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  server.app.post("/api/config", async (req: FastifyRequest, reply: FastifyReply) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    return { success: true, message: "Config saved successfully" };
  });

  // Add endpoint to restart the service with access control
  server.app.post("/api/restart", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ success: true, message: "Service restart initiated" });

    // Restart the service after a short delay to allow response to be sent
    setTimeout(() => {
      const { spawn } = require("child_process");
      spawn(process.execPath, [process.argv[1], "restart"], {
        detached: true,
        stdio: "ignore",
      });
    }, 1000);
  });

  // Register static file serving with caching
  server.app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  server.app.get("/ui", async (_, reply) => {
    return reply.redirect("/ui/");
  });

  // 版本检查端点
  server.app.get("/api/update/check", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // 获取当前版本
      const currentVersion = require("../package.json").version;
      const { hasUpdate, latestVersion, changelog } = await checkForUpdates(currentVersion);

      return {
        hasUpdate,
        latestVersion: hasUpdate ? latestVersion : undefined,
        changelog: hasUpdate ? changelog : undefined
      };
    } catch (error) {
      console.error("Failed to check for updates:", error);
      reply.status(500).send({ error: "Failed to check for updates" });
    }
  });

  // 执行更新端点
  server.app.post("/api/update/perform", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // 只允许完全访问权限的用户执行更新
      const accessLevel = (req as any).accessLevel || "restricted";
      if (accessLevel !== "full") {
        reply.status(403).send("Full access required to perform updates");
        return;
      }

      // 执行更新逻辑
      const result = await performUpdate();

      return result;
    } catch (error) {
      console.error("Failed to perform update:", error);
      reply.status(500).send({ error: "Failed to perform update" });
    }
  });

  // 获取日志文件列表端点
  server.app.get("/api/logs/files", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // 按修改时间倒序排列
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // 获取日志内容端点
  server.app.get("/api/logs", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // 如果指定了文件路径，使用指定的路径
        logFilePath = filePath;
      } else {
        // 如果没有指定文件路径，使用默认的日志文件路径
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // 清除日志内容端点
  server.app.delete("/api/logs", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // 如果指定了文件路径，使用指定的路径
        logFilePath = filePath;
      } else {
        // 如果没有指定文件路径，使用默认的日志文件路径
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  return server;
};
