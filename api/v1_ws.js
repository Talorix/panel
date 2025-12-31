const WebSocket = require("ws");
const crypto = require("crypto");
const unsqh = require("../modules/db.js");

function authenticateApiKey(req) {
  const authHeader = req.headers["authorization"];
  const rawToken =
    (authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null) || req.headers["x-api-key"];

  if (!rawToken) return null;

  const tokenHash = crypto
    .createHash("sha256")
    .update(String(rawToken))
    .digest("hex");

  const keys = unsqh.list("apikeys");
  return (
    keys.find((k) => k.tokenHash === tokenHash && k.visible !== false) || null
  );
}

module.exports = (app) => {
  // --- Console WebSocket (API) ---
  app.ws("/api/ws/console/:id", (ws, req) => {
    const apiKey = authenticateApiKey(req);
    if (!apiKey) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const { id } = req.params;
    const serverData = unsqh.get("servers", id);

    if (!serverData) {
      ws.close(1008, "Server not found");
      return;
    }

    const node =
      serverData.node &&
      unsqh.list("nodes").find((n) => n.ip === serverData.node.ip);

    if (!node) {
      ws.close(1008, "Node not found");
      return;
    }

    const nodeWs = new WebSocket(`ws://${node.ip}:${node.port}`);

    nodeWs.on("open", () => {
      nodeWs.send(
        JSON.stringify({ event: "auth", payload: { key: node.key } })
      );
      nodeWs.send(
        JSON.stringify({
          event: "logs",
          payload: { containerId: serverData.idt },
        })
      );
    });

    nodeWs.on("message", (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const data = msg instanceof Buffer ? msg.toString() : msg;
      ws.send(data);
    });

    const closeBoth = () => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    ws.on("message", (msg) => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.send(msg);
    });

    ws.on("close", closeBoth);
    ws.on("error", closeBoth);
    nodeWs.on("close", closeBoth);
    nodeWs.on("error", closeBoth);
  });

  // --- Stats WebSocket (API) ---
  app.ws("/api/ws/stats/:id", (ws, req) => {
    const apiKey = authenticateApiKey(req);
    if (!apiKey) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const { id } = req.params;
    const serverData = unsqh.get("servers", id);

    if (!serverData) {
      ws.close(1008, "Server not found");
      return;
    }

    const node =
      serverData.node &&
      unsqh.list("nodes").find((n) => n.ip === serverData.node.ip);

    if (!node) {
      ws.close(1008, "Node not found");
      return;
    }

    const nodeWs = new WebSocket(`ws://${node.ip}:${node.port}`);

    nodeWs.on("open", () => {
      nodeWs.send(
        JSON.stringify({ event: "auth", payload: { key: node.key } })
      );
      nodeWs.send(
        JSON.stringify({
          event: "stats",
          payload: { containerId: serverData.idt },
        })
      );
    });

    nodeWs.on("message", (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const data = msg instanceof Buffer ? msg.toString() : msg;
        const parsed = JSON.parse(data);
        if (parsed.event === "stats") {
          ws.send(JSON.stringify(parsed.payload));
        }
      } catch {
        // ignore non-stats / invalid JSON
      }
    });

    const closeBoth = () => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    ws.on("close", closeBoth);
    ws.on("error", closeBoth);
    nodeWs.on("close", closeBoth);
    nodeWs.on("error", closeBoth);
  });
};
