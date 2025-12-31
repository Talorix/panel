const WebSocket = require("ws");
const unsqh = require("../modules/db.js");

module.exports = (app) => {
  // --- Console WebSocket ---
  app.ws("/console/:id", async (ws, req) => {
    if (!req.session?.userId) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const { id } = req.params;
    const serverData = unsqh.get("servers", id);
    const user = unsqh.get("users", req.session.userId);

    if (!serverData) {
      ws.close(1008, "Server not found");
      return;
    }

    // Allow owner or subuser
    let hasAccess = serverData.userId === user.id;
    if (!hasAccess) {
      hasAccess = user.servers?.some((s) => s.id === serverData.id);
    }
    if (!hasAccess) {
      ws.close(1008, "Forbidden");
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
      try {
        const dataToSend =
          msg instanceof Buffer
            ? msg.toString()
            : typeof msg === "string"
            ? msg
            : JSON.stringify(msg);
        ws.send(dataToSend);
      } catch (err) {
        console.error("Error sending message to client WS:", err);
      }
    });

    nodeWs.on("close", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    nodeWs.on("error", (err) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: err.message }));
        ws.close();
      }
    });

    ws.on("message", (msg) => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.send(msg);
    });

    ws.on("close", () => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
    });
    ws.on("error", () => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
    });
  });

  // --- Stats WebSocket ---
  app.ws("/stats/:id", async (ws, req) => {
    if (!req.session?.userId) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const { id } = req.params;
    const serverData = unsqh.get("servers", id);
    const user = unsqh.get("users", req.session.userId);

    if (!serverData) {
      ws.close(1008, "Server not found");
      return;
    }

    // Allow owner or subuser
    let hasAccess = serverData.userId === user.id;
    if (!hasAccess) {
      hasAccess = user.servers?.some((s) => s.id === serverData.id);
    }
    if (!hasAccess) {
      ws.close(1008, "Forbidden");
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
        const dataToSend =
          msg instanceof Buffer
            ? msg.toString()
            : typeof msg === "string"
            ? msg
            : JSON.stringify(msg);
        try {
          const parsed = JSON.parse(dataToSend);
          if (parsed.event === "stats") {
            ws.send(JSON.stringify(parsed.payload));
          }
        } catch {
          // ignore non-stats messages
        }
      } catch (err) {
        console.error("Error sending stats to client WS:", err);
      }
    });

    nodeWs.on("close", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    nodeWs.on("error", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on("close", () => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
    });
    ws.on("error", () => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
    });
  });
};
