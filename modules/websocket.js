const WebSocket = require("ws");
const unsqh = require("../modules/db.js"); // your DB module

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

    if (!serverData || serverData.userId !== user.id) {
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
      nodeWs.send(JSON.stringify({ event: "auth", payload: { key: node.key } }));
      nodeWs.send(JSON.stringify({ event: "logs", payload: { containerId: serverData.containerId } }));
    });

    nodeWs.on("message", (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      let dataToSend;
      try {
        if (msg instanceof Buffer) dataToSend = msg.toString();
        else if (typeof msg === "string") dataToSend = msg;
        else dataToSend = JSON.stringify(msg);
        ws.send(dataToSend); // console messages only
      } catch (err) {
        console.error("Error sending message to client WS:", err);
      }
    });

    nodeWs.on("close", (code, reason) => {
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

    if (!serverData || serverData.userId !== user.id) {
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
      nodeWs.send(JSON.stringify({ event: "auth", payload: { key: node.key } }));

      // Start streaming stats instead of logs
      nodeWs.send(JSON.stringify({ event: "stats", payload: { containerId: serverData.containerId } }));
    });

    nodeWs.on("message", (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      let dataToSend;
      try {
        if (msg instanceof Buffer) dataToSend = msg.toString();
        else if (typeof msg === "string") dataToSend = msg;
        else dataToSend = JSON.stringify(msg);

        // Only forward JSON stats to client
        try {
          const parsed = JSON.parse(dataToSend);
          if (parsed.event === "stats") {
            ws.send(JSON.stringify(parsed.payload));
          }
        } catch (err) {
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
