import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

export async function startSSEServer(buildServerFunc: () => Promise<McpServer>, port: number) {
  // Use host: '0.0.0.0' to bypass local-only DNS rebinding protection for public hosting
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.use(cors());

  // Simple authentication middleware
  const expectedToken = process.env.MCP_SERVER_TOKEN;
  if (expectedToken) {
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // Make sure to parse JSON bodies for the POST requests
  app.use(express.json({ limit: "50mb" }));

  const transports: Record<string, SSEServerTransport> = {};

  app.get("/sse", async (req, res) => {
    try {
      console.error("[affine-mcp] Received GET request to /sse (establishing SSE stream)");
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      transports[sessionId] = transport;

      transport.onclose = () => {
        console.error(`[affine-mcp] SSE transport closed for session ${sessionId}`);
        delete transports[sessionId];
      };

      const server = await buildServerFunc();
      await server.connect(transport);
      console.error(`[affine-mcp] Established SSE stream with session ID: ${sessionId}`);
    } catch (e) {
      console.error("Error establishing SSE stream:", e);
      if (!res.headersSent) {
        res.status(500).send("Error establishing SSE stream");
      }
    }
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      console.error("No session ID provided in request URL");
      res.status(400).send("Missing sessionId parameter");
      return;
    }

    const transport = transports[sessionId];
    if (!transport) {
      console.error(`No active transport found for session ID: ${sessionId}`);
      res.status(404).send("Session not found");
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (e) {
      console.error("Error handling POST message:", e);
      if (!res.headersSent) {
        res.status(500).send("Error handling POST message");
      }
    }
  });

  app.listen(port, () => {
    console.error(`[affine-mcp] SSE server listening on port ${port}`);
    console.error(`[affine-mcp] Connect client to http://localhost:${port}/sse`);
  });

  process.on('SIGINT', async () => {
    for (const sessionId in transports) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (err) {}
    }
    process.exit(0);
  });
}
