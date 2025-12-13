const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const unsqh = require("../modules/db.js");
const axios = require('axios');
/* =========================
   MIDDLEWARE
========================= */

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/");
  next();
}

async function checkNodeHealth(node) {
  try {
    const res = await fetch(
      `http://${node.ip}:${node.port}/health?key=${node.key}`,
      { timeout: 3000 }
    );

    if (!res.ok) throw new Error("Bad response");

    const data = await res.json();

    if (data.status === "online") return "online";
    if (data.status === "dockernotrunning") return "dockernotrunning";

    return "offline";
  } catch {
    return "offline";
  }
}

function requireAdmin(req, res, next) {
  const user = unsqh.get("users", req.session.userId);
  if (!user || user.admin !== true) {
    return res.status(403).send("Forbidden");
  }
  next();
}

/* =========================
   USER DASHBOARD 
========================= */

router.get("/dashboard", requireAuth, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const { password, ...safeUser } = user;
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("user/dashboard", {
    name: appName,
    user: safeUser
  });
});

/* =========================
   ADMIN ROUTES
========================= */

/**
 * POST /admin/node/create
 * body: { name, ram, core, ip, port }
 */
router.post("/admin/node/create", requireAuth, requireAdmin, (req, res) => {
  const { name, ram, core, ip, port } = req.body;

  if (!name || !ram || !core || !ip || !port) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const id = crypto.randomUUID();
  const key = crypto.randomBytes(32).toString("hex");

  const node = {
    name,
    ram,
    core,
    ip,
    port,
    key,
    status: "offline",
    createdAt: Date.now()
  };

  unsqh.put("nodes", id, node);

  res.json({
    id,
    key,
    status: "created"
  });
});


/**
 * GET /admin/nodes
 * List all nodes
 */
router.get("/admin/nodes", requireAuth, requireAdmin, async (req, res) => {
  const nodes = unsqh.list("nodes");

  for (const node of nodes) {
    const status = await checkNodeHealth(node);

    if (node.status !== status) {
      unsqh.update("nodes", node.id, { status });
      node.status = status;
    }
  }
  
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/nodes", {
    name: appName,
    user,
    nodes
  });
});

/**
 * POST /admin/node/:id/configure-key
 */
router.post("/admin/node/:id/configure-key", requireAuth, requireAdmin, (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  const panelUrl = `${req.protocol}://${req.get("host")}`;

  res.json({
    command: `npm run configure --key ${node.key} --panel ${panelUrl}`
  });
});

/**
 * POST /admin/node/:id
 * Returns node info (API)
 */
router.post("/admin/node/:id", requireAuth, requireAdmin, async (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  const status = await checkNodeHealth(node);

  if (node.status !== status) {
    unsqh.update("nodes", req.params.id, { status });
    node.status = status;
  }

  res.json(node);
});

/**
 * GET /admin/node/:id
 * Render node info page
 */
router.get("/admin/node/:id", requireAuth, requireAdmin, async (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  if (!node) return res.redirect("/admin/nodes");

  const status = await checkNodeHealth(node);
  if (node.status !== status) {
    unsqh.update("nodes", req.params.id, { status });
    node.status = status;
  }

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/node", {
    name: appName,
    user,
    node,
    req
  });
});

/**
 * DELETE /admin/node/:id/delete
 */
router.post("/admin/node/:id/delete", requireAuth, requireAdmin, (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  unsqh.delete("nodes", req.params.id);

  res.json({ success: true });
});

/**
 * GET /admin/node/stats/:id
 * Fetch node stats from the node API
 */
router.get("/admin/node/stats/:id", requireAuth, requireAdmin, async (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  try {
    const response = await fetch(`http://${node.ip}:${node.port}/stats?key=${node.key}`);
    if (!response.ok) throw new Error(`Node returned ${response.status}`);
    
    const stats = await response.json();
    res.json({ stats });
  } catch (err) {
    console.error("Failed to fetch node stats:", err);
    res.status(500).json({ error: "Failed to fetch node stats" });
  }
});


/**
 * GET /admin/images
 * List all images
 */
router.get("/admin/images", requireAuth, requireAdmin, (req, res) => {
  const images = unsqh.list("images");
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/images", { name: appName, user, images });
});

/**
 * GET /admin/images/new
 * Render create image page
 */
router.get("/admin/images/new", requireAuth, requireAdmin, (req, res) => {
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/new-image", { name: appName, user });
});

/**
 * POST /admin/images/new
 * Create a new image
 * body: { dockerImage, name, description, envs, files }
 */
router.post("/admin/images/new", requireAuth, requireAdmin, (req, res) => {
  const { dockerImage, name, description, envs, files } = req.body;

  if (!dockerImage || !name) return res.status(400).json({ error: "Missing fields" });

  const id = crypto.randomUUID();
  const image = {
    id,
    dockerImage,
    name,
    description: description || "",
    envs: envs || {},
    files: files || [], // [{ filename, url }]
    createdAt: Date.now()
  };

  unsqh.put("images", id, image);

  res.json({ success: true, image });
});

/**
 * POST /admin/images/delete/:id
 * Delete an image
 */
router.post("/admin/images/delete/:id", requireAuth, requireAdmin, (req, res) => {
  const image = unsqh.get("images", req.params.id);
  if (!image) return res.status(404).json({ error: "Image not found" });

  unsqh.delete("images", req.params.id);
  res.json({ success: true });
});


/**
 * GET /admin/servers
 * List all servers
 */
router.get("/admin/servers", requireAuth, requireAdmin, (req, res) => {
  const servers = unsqh.list("servers");
  const users = unsqh.list("users");
  const nodes = unsqh.list("nodes");
  const images = unsqh.list("images");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/servers", { name: appName, user, servers, users, nodes, images });
});

/**
 * GET /admin/servers
 * List all servers (admin view)
 */
router.get("/admin/servers", requireAuth, requireAdmin, (req, res) => {
  const servers = unsqh.list("servers");
  const users = unsqh.list("users");
  const nodes = unsqh.list("nodes");
  const images = unsqh.list("images");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/servers", { name: appName, user, servers, users, nodes, images });
});

/**
 * GET /admin/servers/new
 * Render create server page
 */
router.get("/admin/servers/new", requireAuth, requireAdmin, (req, res) => {
  const nodes = unsqh.list("nodes").filter(n => n.status === "online");
  const images = unsqh.list("images");
  const users = unsqh.list("users");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/new-server", { name: appName, user, nodes, images, users });
});

/**
 * POST /admin/servers/new
 * body: { imageId, nodeId, name, ram, core, port, userId }
 */
router.post("/admin/servers/new", requireAuth, requireAdmin, async (req, res) => {
  const { imageId, nodeId, name, ram, core, port, userId } = req.body;
  if (!imageId || !nodeId || !name || !userId)
    return res.status(400).json({ error: "Missing fields" });

  const node = unsqh.get("nodes", nodeId);
  if (!node) return res.status(404).json({ error: "Node not found" });

  const image = unsqh.get("images", imageId);
  if (!image) return res.status(404).json({ error: "Image not found" });

  const targetUser = unsqh.get("users", userId);
  if (!targetUser) return res.status(404).json({ error: "User not found" });

  try {
    // Deploy container on node
    const response = await axios.post(`http://${node.ip}:${node.port}/server/create?key=${node.key}`, {
      dockerimage: image.dockerImage,
      env: image.envs,
      name,
      ram,
      core,
      port,
      files: image.files
    });

    const { containerId, idt } = response.data;

    // Build server object
    const serverId = crypto.randomUUID();
    const serverData = {
      id: serverId,
      userId,
      node: node ? { ip: node.ip, name: node.name } : null,
      imageId,
      name,
      ram,
      core,
      port,
      containerId,
      idt,
      createdAt: Date.now()
    };

    // Save server in admin servers table
    unsqh.put("servers", serverId, serverData);

    // Save server in user's servers array
    targetUser.servers = targetUser.servers || [];
    targetUser.servers.push(serverData);
    unsqh.update("users", userId, { servers: targetUser.servers });

    res.json({ success: true, server: serverData });
  } catch (err) {
    console.error("Failed to deploy server:", err.message);
    res.status(500).json({ error: "Failed to deploy server" });
  }
});

/**
 * POST /admin/servers/delete/:id
 */
router.post("/admin/servers/delete/:id", requireAuth, requireAdmin, async (req, res) => {
  const server = unsqh.get("servers", req.params.id);
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    // Tell node to delete container if node info is available
    if (server.node && server.node.ip && server.node.key && server.idt) {
      try {
        await axios.post(`http://${server.node.ip}:${server.node.port}/server/delete/${server.idt}?key=${server.node.key}`);
      } catch (nodeErr) {
        console.warn("Failed to delete server on node:", nodeErr.message);
      }
    }

    // Remove from user's servers array
    const user = unsqh.get("users", server.userId);
    if (user && user.servers) {
      user.servers = user.servers.filter(s => s.id !== server.id);
      unsqh.update("users", user.id, { servers: user.servers });
    }

    // Remove from admin servers table
    unsqh.delete("servers", req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete server:", err.message);
    res.status(500).json({ error: "Failed to delete server" });
  }
});


module.exports = router;
