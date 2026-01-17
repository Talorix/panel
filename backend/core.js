const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const unsqh = require("../modules/db.js");
const axios = require("axios");
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

    if (!res.ok) return "offline";

    const data = await res.json();

    if (data.status === "online") return "online";
    if (data.status === "dockernotrunning") return "dockernotrunning";

    return "offline";
  } catch {
    return "offline";
  }
}
function getNodeUrl(node) {
  return `http://${node.ip}:${node.port}`;
}
function requireAdmin(req, res, next) {
  const user = unsqh.get("users", req.session.userId);
  if (!user || user.admin !== true) {
    return res.status(403).send("Forbidden");
  }
  next();
}

function generateToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function rand(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, x => chars[x % chars.length]).join("");
  }

  return (
    "eyJ" + rand(30) + "." +
    rand(30) + "." +
    rand(30) + "." +
    rand(7)
  );
  // yes its 100 alphabet long you retard
}

/* =========================
   USER DASHBOARD 
========================= */

router.get("/dashboard", requireAuth, (req, res) => {
  let isAdmin;
  if (req.query.admin === "true") {
    const user = unsqh.get("users", req.session.userId);
    if (!user || user.admin !== true) {
      isAdmin = false;
    } else if (user.admin) {
      isAdmin = true;
    }
  }

  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const { password, ...safeUser } = user;
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("user/dashboard", {
    name: appName,
    user: safeUser,
    servers: isAdmin
      ? unsqh.list("servers").filter(s => !safeUser.servers.includes(s.id))
      : safeUser.servers.map(s => typeof s === "string" ? unsqh.get("servers", s) : s),
  });
});

/* =========================
   ADMIN ROUTES
========================= */

/**
 * POST /admin/node/create
 * body: { name, ip, port }
 */
router.post("/admin/node/create", requireAuth, requireAdmin, (req, res) => {
  const { name, ip, port, ftpPort } = req.body;

  if (!name || !ip || !port) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const id = crypto.randomUUID();
  const key = generateToken();

  const node = {
    name,
    ram: 'unknown',
    core: 'unknown',
    ip,
    port,
    ftpPort,
    key,
    allocations: [],
    status: "offline",
    createdAt: Date.now(),
  };

  unsqh.put("nodes", id, node);

  res.json({
    id,
    key,
    status: "created",
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

  res.render("admin/node/nodes", {
    name: appName,
    user,
    nodes,
  });
});

/**
 * POST /admin/node/:id/configure-key
 */
router.post(
  "/admin/node/:id/configure-key",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const panelUrl = `${req.protocol}://${req.get("host")}`;

    res.json({
      command: `npm run configure -- --key ${node.key} --panel ${panelUrl} --port ${node.port} --ftpport ${node.ftpPort}`,
    });
  }
);

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
 * GET /admin/node/ver/:id
 * Get the current node version
 */
router.get("/admin/node/ver/:id", requireAuth, requireAdmin, async (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  try {
    const response = await fetch(
      `http://${node.ip}:${node.port}/version?key=${node.key}`,
      { timeout: 3000 }
    );
    if (!response.ok) return res.json({ version: 'unknown' });
    const data = await response.json();
    res.json({ version: data.version });
  } catch (err) {
    res.status(500).json({ version: 'unknown' });
  }
});

/**
 * GET /admin/node/:id
 * Render node info page
 */
router.get("/admin/node/:id", requireAuth, requireAdmin, async (req, res) => {
  const node = unsqh.get("nodes", req.params.id);
  const servers = unsqh.list("servers");
  if (!node) return res.redirect("/admin/nodes");

  const status = await checkNodeHealth(node);
  if (node.status !== status) {
    unsqh.update("nodes", req.params.id, { status });
    node.status = status;
  }

  let stats = null;

  try {
    const response = await fetch(
      `http://${node.ip}:${node.port}/stats?key=${node.key}`,
      { timeout: 10000 }
    );

    if (response.ok) {
      const data = await response.json();
      stats = data.stats;
    }
  } catch (err) {
    stats = null;
  }


  if (stats?.totalCpuCores && stats?.totalRamGB) {
    const totalRamGB = Number(stats.totalRamGB);
    const ramMB = Math.round(totalRamGB * 1024);

    unsqh.update("nodes", req.params.id, {
      ram: ramMB,
      core: stats.totalCpuCores,
    });

    node.ram = ramMB;
    node.core = stats.totalCpuCores;
  }

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/node/node", {
    name: appName,
    user,
    node,
    servers,
    req,
  });
});
/**
 * POST /admin/node/:id/delete
 * Delete a node and clean up all servers that live on it (sequentially).
 */
router.post(
  "/admin/node/:id/delete",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const allServers = unsqh.list("servers") || [];
    const serversToRemove = allServers.filter(
      (s) =>
        s &&
        s.node &&
        (s.node.id === node.id || s.node.ip === node.ip || s.node.name === node.name)
    );

    let deletedCount = 0;
    for (const server of serversToRemove) {
      try {
        // Determine the node record that actually hosts this server (defensive)
        const serverNode =
          unsqh
            .list("nodes")
            .find((n) => n.id === server.node?.id || n.ip === server.node?.ip) ||
          node; // fallback to node being deleted

        // If we have an idt (node container id) try to instruct the node to remove it.
        if (server.idt && serverNode && serverNode.ip && serverNode.port && serverNode.key) {
          try {
            // call node API to delete the container (sequential)
            await axios.delete(
              `http://${serverNode.ip}:${serverNode.port}/server/delete/${server.idt}?key=${serverNode.key}`,
              { timeout: 5000 }
            );
          } catch (err) {
            // best-effort: log and continue
            console.warn(
              `Failed to instruct node ${serverNode.ip}:${serverNode.port} to delete server ${server.id}:`,
              err?.message || err
            );
          }
        }

        // Free allocations on the node that match this server
        if (serverNode && Array.isArray(serverNode.allocations)) {
          let changed = false;
          serverNode.allocations.forEach((a) => {
            if (a.allocationOwnedto?.serverId === server.id) {
              a.allocationOwnedto = null;
              a.type = "";
              changed = true;
            }
          });
          if (changed) {
            unsqh.update("nodes", serverNode.id, { allocations: serverNode.allocations });
          }
        }

        // Remove server entry from the owner's user.servers (if present)
        if (server.userId) {
          const owner = unsqh.get("users", server.userId);
          if (owner && Array.isArray(owner.servers)) {
            const before = owner.servers.length;
            owner.servers = owner.servers.filter((s) => s.id !== server.id);
            if (owner.servers.length !== before) {
              unsqh.update("users", owner.id, { servers: owner.servers });
            }
          }
        }

        try {
          unsqh.delete("servers", server.id);          
        } catch (err) {
          console.warn(`Failed to delete server ${server.id} from store:`, err?.message || err);
        }

        deletedCount++;
      } catch (err) {
        // do not abort the whole operation for a single server's failure
        console.error(`Error while cleaning server ${server.id}:`, err?.message || err);
      }
    }

    // Finally delete the node itself
    try {
      unsqh.delete("nodes", req.params.id);
    } catch (err) {
      console.error("Failed to delete node from store:", err?.message || err);
      return res.redirect('/admin/nodes?success=false&err=' + err.message);
    }

    res.redirect('/admin/nodes?success=true');
  }
);

/**
 * POST /admin/node/:id/allocations/add
 * body: { ip, domain, port }
 * - port can be a single number or a range like "25565-27888"
 */
router.post(
  "/admin/node/:id/allocations/add",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const { ip, domain, port } = req.body;
    if (!ip || !port)
      return res.status(400).json({ error: "IP and port are required" });

    node.allocations = node.allocations || [];

    // Check if port is a range
    if (typeof port === "string" && port.includes("-")) {
      const [start, end] = port.split("-").map(Number);
      if (isNaN(start) || isNaN(end) || start > end) {
        return res.status(400).json({ error: "Invalid port range" });
      }

      const ports = [];
      for (let p = start; p <= end; p++) ports.push(p);

      const batchSize = 150;
      const added = [];

      for (let i = 0; i < ports.length; i += batchSize) {
        const batch = ports.slice(i, i + batchSize);

        batch.forEach((p) => {
          if (!node.allocations.some((a) => a.ip === ip && a.port === p)) {
            const allocation = {
              id: crypto.randomUUID(),
              ip,
              domain: domain || null,
              port: p,
              createdAt: Date.now(),
            };
            node.allocations.push(allocation);
            added.push(allocation);
          }
        });
      }

      unsqh.update("nodes", req.params.id, { allocations: node.allocations });
      return res.json({ success: true, added, totalAdded: added.length });
    }

    // Single port case
    const portNumber = Number(port);
    if (node.allocations.some((a) => a.ip === ip && a.port === portNumber)) {
      return res.status(409).json({ error: "Allocation already exists" });
    }

    const allocation = {
      id: crypto.randomUUID(),
      ip,
      domain: domain || null,
      port: portNumber,
      createdAt: Date.now(),
    };

    node.allocations.push(allocation);
    unsqh.update("nodes", req.params.id, { allocations: node.allocations });

    res.json({ success: true, allocation });
  }
);

/**
 * POST /admin/node/:id/allocations/edit/:allocationId
 * body: { ip?, domain?, port? }
 */
router.post(
  "/admin/node/:id/allocations/edit/:allocationId",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node || !node.allocations) {
      return res.status(404).json({ error: "Node or allocations not found" });
    }

    const allocation = node.allocations.find(
      (a) => a.id === req.params.allocationId
    );
    if (!allocation) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    const { ip, domain, port } = req.body;

    if (ip !== undefined) allocation.ip = ip;
    if (domain !== undefined) allocation.domain = domain;

    if (port !== undefined) {
      if (
        node.allocations.some(
          (a) =>
            a.ip === (ip ?? allocation.ip) &&
            a.port === Number(port) &&
            a.id !== allocation.id
        )
      ) {
        return res.status(409).json({ error: "IP and port already in use" });
      }
      allocation.port = Number(port);
    }

    unsqh.update("nodes", req.params.id, { allocations: node.allocations });

    res.json({ success: true, allocation });
  }
);

/**
 * DELETE /admin/node/:id/allocations/delete/:allocationId
 */
router.delete(
  "/admin/node/:id/allocations/delete/:allocationId",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node || !node.allocations) {
      return res.status(404).json({ error: "Node or allocations not found" });
    }

    const before = node.allocations.length;

    node.allocations = node.allocations.filter(
      (a) => a.id !== req.params.allocationId
    );

    if (node.allocations.length === before) {
      return res.status(404).json({ error: "Allocation not found" });
    }

    unsqh.update("nodes", req.params.id, { allocations: node.allocations });

    res.json({ success: true });
  }
);
/**
 * GET /admin/node/stats/:id
 * Fetch node stats from the node API
 */
router.get(
  "/admin/node/stats/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    try {
      const response = await fetch(
        `http://${node.ip}:${node.port}/stats?key=${node.key}`
      );
      if (!response.ok) throw new Error(`Node returned ${response.status}`);

      const data = await response.json();
      res.json({ stats: data.stats });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch node stats" });
    }
  }
);

/**
 * GET /admin/node/:id/edit
 * Render edit page (redirect to /admin/nodes if node missing)
 */
router.get(
  "/admin/node/:id/edit",
  requireAuth,
  requireAdmin,
  async (req, res) => {
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

    res.render("admin/node/node-edit", {
      name: appName,
      user,
      node,
      req,
    });
  }
);

/**
 * POST /admin/node/:id/edit
 * Update node fields and redirect back to the node page
 * body: { name, ram, core, ip, port }
 */
router.post(
  "/admin/node/:id/edit",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.redirect("/admin/nodes");

    const { name, ram, core, ip, port } = req.body;

    if (!name || !ram || !core || !ip || !port) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const updates = {
      name,
      ram,
      core,
      ip,
      port,
    };

    unsqh.update("nodes", req.params.id, updates);

    res.redirect(`/admin/node/${req.params.id}`);
  }
);

/**
 * GET /admin/users
 * List all users
 */
router.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = unsqh.list("users") || [];
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/users/users", {
    name: appName,
    user,
    users,
  });
});

/**
 * GET /admin/user/:id
 * Show user info (admin)
 */
router.get("/admin/user/:id", requireAuth, requireAdmin, (req, res) => {
  const target = unsqh.get("users", req.params.id);
  if (!target) return res.status(404).send("User not found");

  // Make a safe copy (don't render password)
  const { password, twoFactorSecret, ...safeTarget } = target;

  // Resolve servers (they may be embedded objects)
  const servers = (target.servers || []).map((s) =>
    typeof s === "string" ? unsqh.get("servers", s) : s
  );

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/users/user", {
    name: appName,
    user,
    target: safeTarget,
    fullTarget: target, // for actions if needed
    servers,
  });
});

/**
 * GET /admin/user/:id/edit
 * Render user edit page
 */
router.get("/admin/user/:id/edit", requireAuth, requireAdmin, (req, res) => {
  const target = unsqh.get("users", req.params.id);
  if (!target) return res.redirect("/admin/users");

  const { password, twoFactorSecret, ...safeTarget } = target;
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/users/user-edit", {
    name: appName,
    user,
    target: safeTarget,
  });
});

/**
 * POST /admin/user/:id/edit
 * Edit user fields. body: { email?, username?, password?, admin? }
 */
router.post("/admin/user/:id/edit", requireAuth, requireAdmin, (req, res) => {
  const target = unsqh.get("users", req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  const { email, username, password, admin } = req.body;
  const updates = {};

  if (email) updates.email = String(email).trim();
  if (username) updates.username = String(username).trim();
  if (typeof admin !== "undefined") updates.admin = admin === "true" || admin === true;

  // If password provided - hash it
  if (password && password.trim() !== "") {
    const hash = crypto.createHash("sha256").update(String(password)).digest("hex");
    updates.password = hash;
  }

  unsqh.update("users", req.params.id, updates);

  // Redirect back to user info page
  res.redirect(`/admin/user/${req.params.id}`);
});

/**
 * POST /admin/users/new
 * Create a new user (admin)
 * body: { email, username, password, admin? }
 */
router.post("/admin/users/new", requireAuth, requireAdmin, (req, res) => {
  const { email, username, password, admin } = req.body;

  if (!email || !username || !password) {
    return res.status(400).json({ error: "Email, username, and password are required" });
  }

  const existing = unsqh.list("users").find(u => u.email === email);
  if (existing) {
    return res.status(409).json({ error: "User with this email already exists" });
  }

  const id = crypto.randomUUID();
  const hash = crypto.createHash("sha256").update(password).digest("hex");

  const newUser = {
    id,
    email,
    username,
    password: hash,
    admin: admin === "true" || admin === true,
    servers: [],
    createdAt: Date.now(),
  };

  unsqh.put("users", id, newUser);

  res.redirect("/admin/users");
});

/**
 * POST /admin/user/:id/delete
 * Delete a user (admin). Prevent self-delete.
 */
router.post("/admin/user/:id/delete", requireAuth, requireAdmin, async (req, res) => {
  const targetId = req.params.id;
  if (req.session.userId === targetId) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }

  const target = unsqh.get("users", targetId);
  if (!target) return res.status(404).json({ error: "User not found" });

  // Clean up user's servers (if any)
  const userServers = Array.isArray(target.servers) ? target.servers : [];

  for (const s of userServers) {
    const server = typeof s === "string" ? unsqh.get("servers", s) : s;
    if (!server) continue;

    // Find node for this server
    const node =
      unsqh.list("nodes").find((n) => n.id === server.node?.id) ||
      unsqh.list("nodes").find((n) => n.ip === server.node?.ip);

    // Try to instruct node to remove container (best-effort)
    if (node && server.idt) {
      try {
        await axios.delete(`http://${node.ip}:${node.port}/server/delete/${server.idt}?key=${node.key}`);
      } catch (err) {
        console.warn("Failed to delete server on node for user deletion:", err.message);
      }
    }

    // Free node allocations owned by this server
    if (node && Array.isArray(node.allocations)) {
      let changed = false;
      node.allocations.forEach((a) => {
        if (a.allocationOwnedto?.serverId === server.id) {
          a.allocationOwnedto = null;
          a.type = "";
          changed = true;
        }
      });
      if (changed) unsqh.update("nodes", node.id, { allocations: node.allocations });
    }

    // Remove server from global servers store
    try {
      unsqh.delete("servers", server.id);
    } catch (err) {
      // continue even if server deletion fails
    }
  }

  // Finally delete user
  unsqh.delete("users", targetId);

  // Redirect back to users list
  res.redirect("/admin/users");
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

  res.render("admin/images/images", { name: appName, user, images });
});

/**
 * GET /admin/images/new
 * Render create image page
 */
router.get("/admin/images/new", requireAuth, requireAdmin, (req, res) => {
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/images/new-image", { name: appName, user });
});

/**
 * GET /admin/image/:id
 * Show detailed info of a single image
 */
router.get("/admin/image/:id", requireAuth, requireAdmin, (req, res) => {
  const image = unsqh.get("images", req.params.id);
  if (!image) return res.status(404).send("Image not found");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/images/image", { name: appName, user, image });
});

/**
 * GET /admin/images/export/:id
 * Export a single image as JSON
 */
router.get(
  "/admin/images/export/:id",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const image = unsqh.get("images", req.params.id);
    if (!image) return res.status(404).send("Image not found");

    const exportData = {
      dockerImage: image.dockerImage,
      name: image.name,
      description: image.description,
      envs: image.envs,
      files: image.files,
    };

    const jsonStr = JSON.stringify(exportData, null, 2);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${image.name.replace(/\s+/g, "_")}.json"`
    );
    res.setHeader("Content-Type", "application/json");

    res.send(jsonStr);
  }
);

/**
 * POST /admin/images/new
 * Create a new image
 * body: { dockerImage, name, description, envs, files, features }
 */
router.post("/admin/images/new", requireAuth, requireAdmin, (req, res) => {
  const { dockerImage, name, description, envs, files, features, dockerImages, stopCmd, startCmd } = req.body;

  if (!dockerImage || !name)
    return res.status(400).json({ error: "Missing fields" });

  const id = crypto.randomUUID();
  const image = {
    id,
    dockerImage,
    name,
    description: description || "",
    envs: envs || {},
    files: files || [], // [{ filename, url }]
    createdAt: Date.now(),
    features: Array.isArray(features) ? features : [],
    dockerImages: Array.isArray(dockerImages) ? dockerImages : [],
    stopCmd: stopCmd || "",
    startCmd: startCmd || "",
  };

  unsqh.put("images", id, image);

  res.json({ success: true, image });
});

/**
 * POST /admin/images/delete/:id
 * Delete an image
 */
router.post(
  "/admin/images/delete/:id",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const image = unsqh.get("images", req.params.id);
    if (!image) return res.status(404).json({ error: "Image not found" });

    unsqh.delete("images", req.params.id);
    res.json({ success: true });
  }
);

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

  res.render("admin/server/servers", {
    name: appName,
    user,
    servers,
    users,
    nodes,
    images,
  });
});

/**
 * GET /admin/server/:id
 * View specific server (admin)
 */
router.get("/admin/server/:id", requireAuth, requireAdmin, (req, res) => {
  const server = unsqh.get("servers", req.params.id);
  if (!server) return res.status(404).send("Server not found");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  const owner = unsqh.get("users", server.userId);
  const image = unsqh.get("images", server.imageId);

  res.render("admin/server/server", {
    name: appName,
    user,
    server,
    owner,
    image,
  });
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

  res.render("admin/server/servers", {
    name: appName,
    user,
    servers,
    users,
    nodes,
    images,
  });
});

/**
 * GET /admin/servers/new
 * Render create server page
 */
router.get("/admin/servers/new", requireAuth, requireAdmin, (req, res) => {
  const nodes = unsqh.list("nodes").filter((n) => n.status === "online");
  const images = unsqh.list("images");
  const users = unsqh.list("users");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/server/new-server", { name: appName, user, nodes, images, users });
});

/**
 * POST /admin/servers/new
 */
router.post(
  "/admin/servers/new",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const {
      imageId,
      nodeId,
      allocationId,
      allocationLimit,
      name,
      ram,
      core,
      disk,
      userId,
      env = {},
    } = req.body;

    if (!imageId || !nodeId || !allocationId || !name || !userId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const node = unsqh.get("nodes", nodeId);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const allocation = (node.allocations || []).find(
      (a) => a.id === allocationId
    );
    if (!allocation) {
      return res.status(404).json({ error: "Allocation not found" });
    }
    if (allocation.allocationOwnedto?.serverId) {
      return res.status(409).json({
        error: "Allocation already claimed by another server",
      });
    }
    const { port, domain, ip } = allocation;

    const image = unsqh.get("images", imageId);
    if (!image) return res.status(404).json({ error: "Image not found" });

    const targetUser = unsqh.get("users", userId);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    /* -------------------------
     ENV MERGE
  ------------------------- */
    const finalEnv = {};
    for (const key of Object.keys(image.envs || {})) {
      finalEnv[key] = env[key] ?? image.envs[key];
    }

    const interpolateEnv = (str, envObj = {}) => {
      if (typeof str !== "string") return str;
      return str.replace(/\$\{(\w+)\}/g, (_, key) => {
        return envObj[key] ?? process.env[key] ?? "";
      });
    };

    try {
      const resolvedFiles = (image.files || []).map((file) => ({
        ...file,
        url: interpolateEnv(file.url, finalEnv),
        name: interpolateEnv(file.name, finalEnv),
      }));

      /* -------------------------
       CREATE SERVER ON NODE
    ------------------------- */
      const response = await axios.post(
        `http://${node.ip}:${node.port}/server/create?key=${node.key}`,
        {
          dockerimage: image.dockerImage,
          startCmd: image.startCmd,
          stopCmd: image.stopCmd,
          env: finalEnv,
          name,
          ram,
          core,
          disk,
          port,
          files: resolvedFiles,
        }
      );

      const { containerId, idt, ftppass } = response.data;

      /* -------------------------
       SERVER DATA
    ------------------------- */
      const serverId = crypto.randomUUID().replace(/-/g, '').slice(0, 7);
      const serverData = {
        id: serverId,
        userId,
        node: {
          id: nodeId,
          ip: node.ip,
          name: node.name,
        },
        allocationId,
        allocationLimit: allocationLimit || 1,
        ip: `${domain ?? ip}`,
        imageId,
        image,
        name,
        ram,
        core,
        disk,
        port,
        containerId,
        idt,
        ftp: {
          host: node.ip,
          port: node.ftpPort || 3001,
          username: `talorix.${idt}`,
          password: ftppass,
        },
        env: finalEnv,
        suspended: false,
        createdAt: Date.now(),
      };
      allocation.type = "primary";
      allocation.allocationOwnedto = {
        serverId,
      };

      unsqh.update("nodes", nodeId, { allocations: node.allocations });

      unsqh.put("servers", serverId, serverData);

      /* -------------------------
       ATTACH TO USER
    ------------------------- */
      targetUser.servers = targetUser.servers || [];
      targetUser.servers.push(serverData);
      unsqh.update("users", userId, { servers: targetUser.servers });

      res.json({ success: true, server: serverData });
    } catch (err) {
      console.error("Failed to deploy server:", err);
      res.status(500).json({ error: "Failed to deploy server" });
    }
  }
);

/**
 * POST /admin/edit/:serverId
 * Edit a server (admin)
 * Body: { name?, ram?, core?, disk?, imageId?, env?, files?, userId? }
 * - files: [{ filename, url }] – optional, will be downloaded/overwritten on node
 * - userId: optional, transfers ownership to another user
 * NOTE: Node changes are not supported via edit (requires server recreation)
 */
router.post(
  "/admin/edit/:serverId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { serverId } = req.params;
    const server = unsqh.get("servers", serverId);
    if (!server) return res.status(404).json({ error: "Server not found", field: "serverId" });

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).json({ error: "Node not found - server's node may be offline or deleted", field: "node" });

    const {
      name,
      ram,
      core,
      disk,
      env: newEnv = {},
      files: newFiles = [],
      imageId,
      userId: newUserId,
      allocationLimit
    } = req.body;

    // Validate name if provided
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      return res.status(400).json({ error: "Server name cannot be empty", field: "name" });
    }

    // Validate resources if provided
    if (ram !== undefined && (isNaN(ram) || ram < 128)) {
      return res.status(400).json({ error: "RAM must be at least 128 MB", field: "ram" });
    }
    if (core !== undefined && (isNaN(core) || core < 1)) {
      return res.status(400).json({ error: "CPU cores must be at least 1", field: "core" });
    }
    if (disk !== undefined && (isNaN(disk) || disk < 512)) {
      return res.status(400).json({ error: "Disk must be at least 512 MB", field: "disk" });
    }

    // Validate new owner if provided
    let newOwner = null;
    if (newUserId && newUserId !== server.userId) {
      newOwner = unsqh.get("users", newUserId);
      if (!newOwner) {
        return res.status(404).json({ error: "New owner user not found", field: "userId" });
      }
    }

    let image;
    if (imageId) {
      image = unsqh.get("images", imageId);
      if (!image) return res.status(404).json({ error: "Image not found", field: "imageId" });
    } else {
      image = unsqh.get("images", server.imageId);
      if (!image) {
        return res.status(404).json({ error: "Server's current image not found - please select an image", field: "imageId" });
      }
    }

    // Merge env variables (existing server env overridden by newEnv)
    const mergedEnv = { ...(server.env || {}), ...(newEnv || {}) };

    // If image has envs, ensure defaults are included
    for (const key of Object.keys(image.envs || {})) {
      if (mergedEnv[key] === undefined) mergedEnv[key] = image.envs[key];
    }

    // Interpolate file URLs
    const interpolateEnv = (str, envObj = {}) => {
      if (typeof str !== "string") return str;
      return str.replace(
        /\$\{(\w+)\}/g,
        (_, key) => envObj[key] ?? process.env[key] ?? ""
      );
    };
    const resolvedFiles = (newFiles.length ? newFiles : image.files || []).map(
      (file) => ({
        ...file,
        url: interpolateEnv(file.url, mergedEnv),
        name: interpolateEnv(file.name, mergedEnv),
      })
    );

    try {
      // Send edit request to the node
      const response = await axios.post(
        `${getNodeUrl(node)}/server/edit`,
        {
          idt: server.idt,
          dockerimage: image.dockerImage,
          env: mergedEnv,
          name: name || server.name,
          ram: ram || server.ram,
          core: core || server.core,
          disk: disk || server.disk,
          port: server.port,
          files: resolvedFiles,
        },
        { params: { key: node.key, idt: server.idt } }
      );

      const { containerId } = response.data;

      // Store old userId for ownership transfer
      const oldUserId = server.userId;

      // Update admin server info
      server.name = name || server.name;
      server.ram = ram || server.ram;
      server.core = core || server.core;
      server.disk = disk || server.disk;
      server.port = server.port;
      server.env = mergedEnv;
      server.image = image;
      server.imageId = image.id;
      server.containerId = containerId;
      server.files = resolvedFiles; 
      server.allocationLimit = allocationLimit || 1
      // Handle ownership transfer
      if (newOwner && newUserId !== oldUserId) {
        // Update server's userId
        server.userId = newUserId;
        server.ownerId = newUserId;

        // Remove server from old user's servers array
        const oldUser = unsqh.get("users", oldUserId);
        if (oldUser && Array.isArray(oldUser.servers)) {
          oldUser.servers = oldUser.servers.filter((s) => s.id !== server.id);
          unsqh.put("users", oldUser.id, oldUser);
        }

        // Add server to new user's servers array
        newOwner.servers = Array.isArray(newOwner.servers) ? newOwner.servers : [];
        // Check if already exists (shouldn't, but be safe)
        const existingIdx = newOwner.servers.findIndex((s) => s.id === server.id);
        if (existingIdx >= 0) {
          newOwner.servers[existingIdx] = server;
        } else {
          newOwner.servers.push(server);
        }
        unsqh.put("users", newOwner.id, newOwner);
      } else {
        // No ownership change - just update the current user's server copy
        const user = unsqh.get("users", server.userId);
        if (user && user.servers) {
          user.servers = user.servers.map((s) =>
            s.id === server.id ? server : s
          );
          unsqh.put("users", user.id, user);
        }
      }

      // Persist server to global servers store
      unsqh.put("servers", server.id, server);

      res.json({ success: true, server, ownershipTransferred: newOwner ? true : false });
    } catch (err) {
      console.error(
        "Failed to edit server:",
        err.response?.data || err.message
      );

      // Provide more specific error messages
      let errorMessage = "Failed to edit server";
      let errorDetails = err.message;

      if (err.code === "ECONNREFUSED") {
        errorMessage = "Cannot connect to node";
        errorDetails = "The server's node appears to be offline. Please check node status.";
      } else if (err.response?.status === 404) {
        errorMessage = "Server container not found on node";
        errorDetails = "The server may have been deleted on the node. Consider recreating it.";
      } else if (err.response?.data?.error) {
        errorDetails = err.response.data.error;
      }

      res.status(500).json({ error: errorMessage, details: errorDetails });
    }
  }
);

/**
 * GET /admin/server/edit/:serverId
 * Render admin server edit page
 */
router.get("/admin/server/edit/:serverId", requireAuth, requireAdmin, (req, res) => {
  const { serverId } = req.params;
  const server = unsqh.get("servers", serverId);
  if (!server) return res.status(404).send("Server not found");

  const user = unsqh.get("users", req.session.userId);
  const nodes = unsqh.list("nodes").filter((n) => n.status === "online");
  const images = unsqh.list("images");
  const users = unsqh.list("users");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("admin/server/edit-server", {
    name: appName,
    user,
    server,
    nodes,
    users,
    images,
  });
});

/**
 * POST /admin/servers/suspend/:id
 * Suspend the server thats it ;3
 */
router.post(
  "/admin/servers/suspend/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const server = unsqh.get("servers", req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    server.suspended = true;
    unsqh.update("servers", server.id, { suspended: true });

    const user = unsqh.get("users", server.userId);
    if (user && user.servers) {
      const userServer = user.servers.find((s) => s.id === server.id);
      if (userServer) userServer.suspended = true;
      unsqh.update("users", user.id, { servers: user.servers });
    }

    res.json({ success: true, suspended: true });
  }
);

/**
 * POST /admin/servers/unsuspend/:id
 */
router.post(
  "/admin/servers/unsuspend/:id",
  requireAuth,
  requireAdmin,
  (req, res) => {
    const server = unsqh.get("servers", req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    server.suspended = false;
    unsqh.update("servers", server.id, { suspended: false });

    const user = unsqh.get("users", server.userId);
    if (user && user.servers) {
      const userServer = user.servers.find((s) => s.id === server.id);
      if (userServer) userServer.suspended = false;
      unsqh.update("users", user.id, { servers: user.servers });
    }

    res.json({ success: true, suspended: false });
  }
);

/**
 * DELETE /admin/servers/delete/:id
 */
router.delete("/admin/servers/delete/:id", requireAuth, requireAdmin, async (req, res) => {
  const server = unsqh.get("servers", req.params.id);
  if (!server) return res.status(404).json({ error: "Server not found" });

  // Fetch node consistently from db
  const node = unsqh.list("nodes").find(n => n.ip === server.node?.ip || n.id === server.node?.id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  try {
    // Tell node to delete container if node info is available
    if (server.idt) {
      try {
        await axios.delete(`http://${node.ip}:${node.port}/server/delete/${server.idt}?key=${node.key}`);
      } catch (nodeErr) {
        console.warn("Failed to delete server on node:", nodeErr.message);
      }
    }

    // Free allocations owned by this server
    if (Array.isArray(node.allocations)) {
      node.allocations.forEach(a => {
        if (a.allocationOwnedto?.serverId === server.id) {
          a.allocationOwnedto = null;
          a.type = ""; // optional, reset type
        }
      });
      unsqh.update("nodes", node.id, { allocations: node.allocations });
    }

    // Remove server from user's servers
    const user = unsqh.get("users", server.userId);
    if (user?.servers) {
      user.servers = user.servers.filter(s => s.id !== server.id);
      unsqh.update("users", user.id, { servers: user.servers });
    }

    // Remove server from admin table
    unsqh.delete("servers", req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete server:", err.message);
    res.status(500).json({ error: "Failed to delete server" });
  }
});


/**
 * GET /admin/settings
 * Render admin settings page
 */
router.get("/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/settings", {
    name: appName,
    user,
    settings,
  });
});

/**
 * POST /admin/settings
 * Update settings (e.g., app name)
 */
router.post("/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const { name, registerEnabled } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "App name is required" });
  }

  const updatedSettings = {
    name: name.trim(),
    registerEnabled: registerEnabled === true,
  };

  unsqh.put("settings", "app", updatedSettings);

  res.json({ success: true, settings: updatedSettings });
});

function normalizeBool(val) {
  // Accept true/false, "true"/"false", 1/0, etc.
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val === 1;
  if (typeof val === "string") {
    return val === "true" || val === "1" || val === "yes" || val === "on";
  }
  return false;
}

router.get("/admin/apikeys", requireAuth, requireAdmin, (req, res) => {
  const rawKeys = unsqh.list("apikeys") || [];
  // Show only non-sensitive fields; preview contains masked token part
  const visibleKeys = rawKeys.map((k) => {
    return {
      id: k.id,
      name: k.name || null,
      preview: k.preview || null,
      perms: k.perms || {},
      createdAt: k.createdAt,
      updatedAt: k.updatedAt || null,
      visible: k.visible !== false, // default true
    };
  });

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  res.render("admin/apikeys/index", {
    name: appName,
    user,
    apikeys: visibleKeys,
  });
});

/**
 * POST /admin/apikeys/new
 * body: { nodes, servers, users, settings, images, name?, visible? }
 * returns: { success: true, id, token, preview, perms }
 */
router.post("/admin/apikeys/new", requireAuth, requireAdmin, (req, res) => {
  const { nodes, servers, users, settings: settingsPerm, images, name, visible } = req.body || {};

  // Normalize incoming booleans
  const perms = {
    nodes: normalizeBool(nodes),
    servers: normalizeBool(servers),
    users: normalizeBool(users),
    settings: normalizeBool(settingsPerm),
    images: normalizeBool(images),
  };

  // Generate token and store only its hash
  const token = crypto.randomBytes(32).toString("hex"); // 64 hex chars
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // Create a small preview to display in listing (not sensitive)
  const preview = `${token.slice(0, 6)}...${token.slice(-4)}`;

  const id = crypto.randomUUID();
  const keyObj = {
    id,
    name: name ? String(name).trim() : null,
    tokenHash,
    preview,
    perms,
    visible: visible === undefined ? true : normalizeBool(visible),
    createdAt: Date.now(),
  };

  unsqh.put("apikeys", id, keyObj);

  // Return the raw token once (admin must copy it now). Do NOT store raw token.
  res.json({
    success: true,
    id,
    token,
    preview,
    perms,
  });
});

/**
 * POST /admin/apikeys/edit
 * body: { id, nodes, servers, users, settings, images, name?, visible? }
 */
router.post("/admin/apikeys/edit", requireAuth, requireAdmin, (req, res) => {
  const { id, nodes, servers, users, settings: settingsPerm, images, name, visible } = req.body || {};

  if (!id) return res.status(400).json({ error: "id is required" });

  const existing = unsqh.get("apikeys", id);
  if (!existing) return res.status(404).json({ error: "API key not found" });

  const updated = { ...existing };

  // Update perms only if provided (allow toggling)
  if (typeof nodes !== "undefined" || typeof servers !== "undefined" || typeof users !== "undefined" || typeof settingsPerm !== "undefined" || typeof images !== "undefined") {
    updated.perms = {
      nodes: typeof nodes === "undefined" ? existing.perms?.nodes === true : normalizeBool(nodes),
      servers: typeof servers === "undefined" ? existing.perms?.servers === true : normalizeBool(servers),
      users: typeof users === "undefined" ? existing.perms?.users === true : normalizeBool(users),
      settings: typeof settingsPerm === "undefined" ? existing.perms?.settings === true : normalizeBool(settingsPerm),
      images: typeof images === "undefined" ? existing.perms?.images === true : normalizeBool(images),
    };
  }

  if (typeof name !== "undefined") updated.name = name ? String(name).trim() : null;
  if (typeof visible !== "undefined") updated.visible = normalizeBool(visible);

  updated.updatedAt = Date.now();

  unsqh.update("apikeys", id, updated);

  res.json({ success: true, id, perms: updated.perms, name: updated.name, visible: updated.visible });
});

/**
 * DELETE /admin/apikeys/delete?id=<id>
 */
router.delete("/admin/apikeys/delete", requireAuth, requireAdmin, (req, res) => {
  const id = req.query.id || (req.body && req.body.id);
  if (!id) return res.status(400).json({ error: "id query parameter is required" });

  const existing = unsqh.get("apikeys", id);
  if (!existing) return res.status(404).json({ error: "API key not found" });

  try {
    unsqh.delete("apikeys", id);
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete apikey:", err);
    res.status(500).json({ error: "Failed to delete API key" });
  }
});
module.exports = router;
