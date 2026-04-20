import { Router } from "express";
import { chat, checkConfig, generatePlan } from "../claude-service.js";

const router = Router();

/**
 * GET /api/chat/config
 * Check if Claude API is configured.
 */
router.get("/chat/config", (_req, res) => {
  const config = checkConfig();
  res.json(config);
});

/**
 * POST /api/chat
 * Body: { messages: [{role, content}] }
 * Streams response as SSE (text/event-stream).
 */
router.post("/chat", async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // Validate message structure
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({ error: "Each message needs role and content" });
    }
    if (msg.role !== "user" && msg.role !== "assistant") {
      return res.status(400).json({ error: "Message role must be user or assistant" });
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const fullText = await chat(messages, (chunk) => {
      res.write(`data: ${JSON.stringify({ type: "delta", text: chunk })}\n\n`);
    });

    res.write(`data: ${JSON.stringify({ type: "done", text: fullText })}\n\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
  } finally {
    res.end();
  }
});

/**
 * POST /api/chat/generate-plan
 * Body: { description: string }
 * Returns structured plan JSON directly (non-streaming).
 */
router.post("/chat/generate-plan", async (req, res) => {
  const { description } = req.body;

  if (!description || typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "description (string) is required" });
  }

  try {
    const plan = await generatePlan(description);
    res.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
