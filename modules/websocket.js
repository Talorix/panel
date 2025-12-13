const WebSocket = require("ws");
const unsqh = require("../modules/db.js"); // your DB module

module.exports = (app) => {
  // WebSocket route for server console
  app.ws("/console/:id", async (ws, req) => {
    // --- Auth check ---
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
      // send auth as JSON payload
      nodeWs.send(
        JSON.stringify({
          event: "auth",
          payload: { key: node.key },
        })
      );

      // start streaming logs
      nodeWs.send(
        JSON.stringify({
          event: "logs",
          payload: { containerId: serverData.containerId },
        })
      );
    });

    nodeWs.on("message", (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // Node sends Buffer or JSON string
      let dataToSend;
      try {
        if (msg instanceof Buffer) {
          dataToSend = msg.toString(); // convert buffer to string
        } else if (typeof msg === "string") {
          dataToSend = msg;
        } else {
          dataToSend = JSON.stringify(msg);
        }
        ws.send(dataToSend);
      } catch (err) {
        console.error("Error sending message to client WS:", err);
      }
    });

    nodeWs.on("close", (code, reason) => {
      console.log(
        `Node WS closed for server ${serverData.name}: code=${code}, reason=${reason}`
      );
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    nodeWs.on("error", (err) => {
      console.error(`Node WS error for server ${serverData.name}:`, err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: err.message }));
        ws.close();
      }
    });

    // --- Proxy user messages to node WS ---
    ws.on("message", (msg) => {
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.send(msg);
    });

    ws.on("close", () => {
      console.log(`User WS closed for server ${serverData.name}`);
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
    });

    ws.on("error", (err) => {
      console.error(`User WS error for server ${serverData.name}:`, err);
      if (nodeWs.readyState === WebSocket.OPEN) nodeWs.close();
    });
  });
};
