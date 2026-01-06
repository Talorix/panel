const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const unsqh = require("../modules/db.js");
// --- Middleware: requireAPI
function requireAPI(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const rawToken =
      (authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null) || req.headers["x-api-key"];

    if (!rawToken) {
      return res.status(401).json({ error: "API key required" });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(String(rawToken))
      .digest("hex");

    const keys = unsqh.list("apikeys") || [];
    const apiKey = keys.find((k) => k.tokenHash === tokenHash);

    if (!apiKey) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    if (apiKey.visible === false) {
      return res.status(403).json({ error: "API key disabled" });
    }

    req.apiKey = apiKey;
    return next();
  } catch (err) {
    console.error("requireAPI error:", err);
    return res.status(500).json({ error: "API authentication failed" });
  }
}

// --- Middleware: requirePermission
// Accepts a single permission string or an array of permissions
function requirePermission(perms) {
  const list = Array.isArray(perms) ? perms : [perms];

  return function (req, res, next) {
    if (!req.apiKey) {
      return res.status(401).json({ error: "API key not loaded" });
    }

    if (!list.length || !list[0]) {
      return res.status(500).json({ error: "Permission not specified" });
    }

    const allowed = list.every((p) => req.apiKey.perms?.[p] === true);
    if (!allowed) {
      return res
        .status(403)
        .json({ error: "Missing permission", required: list });
    }

    return next();
  };
}

// --- Helpers
function getNodeUrl(node) {
  return `http://${node.ip}:${node.port}`;
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

/**
 * POST /api/v1/node/create
 * body: { name, ip, port }
 */
router.post(
  "/api/v1/node/create",
  requireAPI,
  requirePermission("nodes"),
  (req, res) => {
    const { name, ip, port } = req.body || {};

    if (!name || !ip || !port) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const id = crypto.randomUUID();
    const key = crypto.randomBytes(32).toString("hex");

    const node = {
      id,
      name,
      ram: "unknown",
      core: "unknown",
      ip,
      port,
      key,
      allocations: [],
      status: "offline",
      createdAt: Date.now(),
    };

    unsqh.put("nodes", id, node);

    return res.json({ success: true, id, key, status: "created" });
  }
);

/**
 * GET /api/v1/nodes
 * List all nodes (and update status)
 */
router.get(
  "/api/v1/nodes",
  requireAPI,
  requirePermission("nodes"),
  async (req, res) => {
    const nodes = unsqh.list("nodes") || [];

    for (const node of nodes) {
      try {
        const status = await checkNodeHealth(node);
        if (node.status !== status) {
          unsqh.update("nodes", node.id, { status });
          node.status = status;
        }
      } catch (err) {
        // ignore per-node errors
      }
    }

    return res.json({ success: true, nodes });
  }
);

/**
 * POST /api/v1/node/:id/configure-key
 */
router.post(
  "/api/v1/node/:id/configure-key",
  requireAPI,
  requirePermission("nodes"),
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const panelUrl = `${req.protocol}://${req.get("host")}`;

    return res.json({
      command: `npm run configure -- --key ${node.key} --panel ${panelUrl} --port ${node.port}`,
    });
  }
);

/**
 * POST /api/v1/node/:id
 * Returns node info (API)
 */
router.post(
  "/api/v1/node/:id",
  requireAPI,
  requirePermission("nodes"),
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    try {
      const status = await checkNodeHealth(node);
      if (node.status !== status) {
        unsqh.update("nodes", req.params.id, { status });
        node.status = status;
      }
    } catch (err) {
      // ignore
    }

    return res.json({ success: true, node });
  }
);

/**
 * GET /api/v1/node/ver/:id
 * Get the current node version
 */
router.get(
  "/api/v1/node/ver/:id",
  requireAPI,
  requirePermission("nodes"),
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    try {
      const resp = await axios.get(
        `${getNodeUrl(node)}/version?key=${node.key}`,
        { timeout: 3000 }
      );
      return res.json({
        success: true,
        version: resp.data?.version ?? "unknown",
      });
    } catch (err) {
      return res.status(500).json({ success: false, version: "unknown" });
    }
  }
);

/**
 * POST /api/v1/node/:id/delete
 * Delete node and clean up servers
 */
router.post(
  "/api/v1/node/:id/delete",
  requireAPI,
  requirePermission(["nodes", "servers"]),
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const allServers = unsqh.list("servers") || [];
    const serversToRemove = allServers.filter(
      (s) =>
        s &&
        s.node &&
        (s.node.id === node.id ||
          s.node.ip === node.ip ||
          s.node.name === node.name)
    );

    let deletedCount = 0;

    for (const server of serversToRemove) {
      try {
        const serverNode =
          unsqh
            .list("nodes")
            .find(
              (n) => n.id === server.node?.id || n.ip === server.node?.ip
            ) || node;

        if (
          server.idt &&
          serverNode &&
          serverNode.ip &&
          serverNode.port &&
          serverNode.key
        ) {
          try {
            await axios.delete(
              `${getNodeUrl(serverNode)}/server/delete/${server.idt}?key=${
                serverNode.key
              }`,
              { timeout: 5000 }
            );
          } catch (err) {
            console.warn(
              `Failed to instruct node to delete server ${server.id}:`,
              err?.message || err
            );
          }
        }

        if (serverNode && Array.isArray(serverNode.allocations)) {
          let changed = false;
          serverNode.allocations.forEach((a) => {
            if (a.allocationOwnedto?.serverId === server.id) {
              a.allocationOwnedto = null;
              a.type = "";
              changed = true;
            }
          });
          if (changed)
            unsqh.update("nodes", serverNode.id, {
              allocations: serverNode.allocations,
            });
        }

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
          console.warn(
            `Failed to delete server ${server.id} from store:`,
            err?.message || err
          );
        }

        deletedCount++;
      } catch (err) {
        console.error(
          `Error while cleaning server ${server.id}:`,
          err?.message || err
        );
      }
    }

    try {
      unsqh.delete("nodes", req.params.id);
    } catch (err) {
      console.error("Failed to delete node from store:", err?.message || err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to delete node" });
    }

    return res.json({ success: true, deletedServers: deletedCount });
  }
);

/**
 * POST /api/v1/node/:id/allocations/add
 */
router.post(
  "/api/v1/node/:id/allocations/add",
  requireAPI,
  requirePermission("nodes"),
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const { ip, domain, port } = req.body || {};
    if (!ip || !port)
      return res.status(400).json({ error: "IP and port are required" });

    node.allocations = node.allocations || [];

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

    return res.json({ success: true, allocation });
  }
);

/**
 * POST /api/v1/node/:id/allocations/edit/:allocationId
 */
router.post(
  "/api/v1/node/:id/allocations/edit/:allocationId",
  requireAPI,
  requirePermission("nodes"),
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node || !node.allocations)
      return res.status(404).json({ error: "Node or allocations not found" });

    const allocation = node.allocations.find(
      (a) => a.id === req.params.allocationId
    );
    if (!allocation)
      return res.status(404).json({ error: "Allocation not found" });

    const { ip, domain, port } = req.body || {};

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

    return res.json({ success: true, allocation });
  }
);

/**
 * DELETE /api/v1/node/:id/allocations/delete/:allocationId
 */
router.delete(
  "/api/v1/node/:id/allocations/delete/:allocationId",
  requireAPI,
  requirePermission("nodes"),
  (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node || !node.allocations)
      return res.status(404).json({ error: "Node or allocations not found" });

    const before = node.allocations.length;
    node.allocations = node.allocations.filter(
      (a) => a.id !== req.params.allocationId
    );

    if (node.allocations.length === before)
      return res.status(404).json({ error: "Allocation not found" });

    unsqh.update("nodes", req.params.id, { allocations: node.allocations });

    return res.json({ success: true });
  }
);

/**
 * GET /api/v1/node/stats/:id
 */
router.get(
  "/api/v1/node/stats/:id",
  requireAPI,
  requirePermission("nodes"),
  async (req, res) => {
    const node = unsqh.get("nodes", req.params.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    try {
      const resp = await axios.get(`${getNodeUrl(node)}/stats?key=${node.key}`);
      return res.json({ success: true, stats: resp.data?.stats ?? null });
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch node stats" });
    }
  }
);

/**
 * Images CRUD (API)
 */
router.get(
  "/api/v1/images",
  requireAPI,
  requirePermission("images"),
  (req, res) => {
    const images = unsqh.list("images") || [];
    return res.json({ success: true, images });
  }
);

router.post(
  "/api/v1/images/new",
  requireAPI,
  requirePermission("images"),
  (req, res) => {
    const { dockerImage, name, description, envs, files, features } =
      req.body || {};
    if (!dockerImage || !name)
      return res.status(400).json({ error: "Missing fields" });

    const id = crypto.randomUUID();
    const image = {
      id,
      dockerImage,
      name,
      description: description || "",
      envs: envs || {},
      files: files || [],
      createdAt: Date.now(),
      features: Array.isArray(features) ? features : [],
    };

    unsqh.put("images", id, image);
    return res.json({ success: true, image });
  }
);

router.post(
  "/api/v1/images/delete/:id",
  requireAPI,
  requirePermission("images"),
  (req, res) => {
    const image = unsqh.get("images", req.params.id);
    if (!image) return res.status(404).json({ error: "Image not found" });

    unsqh.delete("images", req.params.id);
    return res.json({ success: true });
  }
);

/**
 * Servers: list, create, edit, delete, suspend
 */
router.get(
  "/api/v1/servers",
  requireAPI,
  requirePermission("servers"),
  (req, res) => {
    const servers = unsqh.list("servers") || [];
    return res.json({ success: true, servers });
  }
);

router.post(
  "/api/v1/servers/new",
  requireAPI,
  requirePermission("servers"),
  async (req, res) => {
    const {
      imageId,
      nodeId,
      allocationId,
      name,
      ram,
      core,
      disk,
      userId,
      env = {},
    } = req.body || {};

    if (!imageId || !nodeId || !allocationId || !name || !userId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const node = unsqh.get("nodes", nodeId);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const allocation = (node.allocations || []).find(
      (a) => a.id === allocationId
    );
    if (!allocation)
      return res.status(404).json({ error: "Allocation not found" });
    if (allocation.allocationOwnedto?.serverId) {
      return res
        .status(409)
        .json({ error: "Allocation already claimed by another server" });
    }

    const image = unsqh.get("images", imageId);
    if (!image) return res.status(404).json({ error: "Image not found" });

    const targetUser = unsqh.get("users", userId);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    // ENV merge
    const finalEnv = {};
    for (const key of Object.keys(image.envs || {})) {
      finalEnv[key] = env[key] ?? image.envs[key];
    }

    const interpolateEnv = (str, envObj = {}) => {
      if (typeof str !== "string") return str;
      return str.replace(
        /\$\{(\w+)\}/g,
        (_, key) => envObj[key] ?? process.env[key] ?? ""
      );
    };

    try {
      const resolvedFiles = (image.files || []).map((file) => ({
        ...file,
        url: interpolateEnv(file.url, finalEnv),
        name: interpolateEnv(file.name, finalEnv),
      }));

      const response = await axios.post(
        `${getNodeUrl(node)}/server/create?key=${node.key}`,
        {
          dockerimage: image.dockerImage,
          startCmd: image.startCmd,
          stopCmd: image.stopCmd,
          env: finalEnv,
          name,
          ram,
          core,
          disk,
          port: allocation.port,
          files: resolvedFiles,
        }
      );

      const { containerId, idt } = response.data || {};

      const serverId = crypto.randomUUID().replace(/-/g, "").slice(0, 7);
      const serverData = {
        id: serverId,
        userId,
        node: { id: nodeId, ip: node.ip, name: node.name },
        allocationId,
        ip: `${allocation.domain ?? allocation.ip}`,
        imageId,
        image,
        name,
        ram,
        core,
        disk,
        port: allocation.port,
        containerId,
        idt,
        env: finalEnv,
        suspended: false,
        createdAt: Date.now(),
      };

      allocation.type = "primary";
      allocation.allocationOwnedto = { serverId };
      unsqh.update("nodes", nodeId, { allocations: node.allocations });

      unsqh.put("servers", serverId, serverData);

      targetUser.servers = targetUser.servers || [];
      targetUser.servers.push(serverData);
      unsqh.update("users", userId, { servers: targetUser.servers });

      return res.json({ success: true, server: serverData });
    } catch (err) {
      console.error(
        "Failed to deploy server:",
        err?.response?.data || err.message || err
      );
      return res.status(500).json({ error: "Failed to deploy server" });
    }
  }
);

router.post(
  "/api/v1/edit/:serverId",
  requireAPI,
  requirePermission("servers"),
  async (req, res) => {
    const { serverId } = req.params;
    const server = unsqh.get("servers", serverId);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const node = unsqh
      .list("nodes")
      .find((n) => n.ip === server.node.ip || n.id === server.node.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const {
      name,
      ram,
      core,
      disk,
      env: newEnv = {},
      files: newFiles = [],
      imageId,
    } = req.body || {};

    let image;
    if (imageId) {
      image = unsqh.get("images", imageId);
      if (!image) return res.status(404).json({ error: "Image not found" });
    } else {
      image = unsqh.get("images", server.imageId);
    }

    const mergedEnv = { ...(server.env || {}), ...(newEnv || {}) };
    for (const key of Object.keys(image.envs || {})) {
      if (mergedEnv[key] === undefined) mergedEnv[key] = image.envs[key];
    }

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

      const { containerId } = response.data || {};

      server.name = name || server.name;
      server.ram = ram || server.ram;
      server.core = core || server.core;
      server.disk = disk || server.disk;
      server.env = mergedEnv;
      server.image = image;
      server.imageId = image.id;
      server.containerId = containerId;
      server.files = resolvedFiles;

      unsqh.put("servers", server.id, server);

      const user = unsqh.get("users", server.userId);
      if (user && user.servers) {
        user.servers = user.servers.map((s) =>
          s.id === server.id ? server : s
        );
        unsqh.put("users", user.id, user);
      }

      return res.json({ success: true, server });
    } catch (err) {
      console.error(
        "Failed to edit server:",
        err?.response?.data || err.message || err
      );
      return res
        .status(500)
        .json({ error: "Failed to edit server", details: err?.message });
    }
  }
);

router.post(
  "/api/v1/servers/suspend/:id",
  requireAPI,
  requirePermission("servers"),
  (req, res) => {
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

    return res.json({ success: true, suspended: true });
  }
);

router.post(
  "/api/v1/servers/unsuspend/:id",
  requireAPI,
  requirePermission("servers"),
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

    return res.json({ success: true, suspended: false });
  }
);

router.delete(
  "/api/v1/servers/delete/:id",
  requireAPI,
  requirePermission(["servers", "nodes"]),
  async (req, res) => {
    const server = unsqh.get("servers", req.params.id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const node = unsqh
      .list("nodes")
      .find((n) => n.ip === server.node?.ip || n.id === server.node?.id);
    if (!node) return res.status(404).json({ error: "Node not found" });

    try {
      if (server.idt) {
        try {
          await axios.delete(
            `${getNodeUrl(node)}/server/delete/${server.idt}?key=${node.key}`
          );
        } catch (nodeErr) {
          console.warn(
            "Failed to delete server on node:",
            nodeErr.message || nodeErr
          );
        }
      }

      if (Array.isArray(node.allocations)) {
        node.allocations.forEach((a) => {
          if (a.allocationOwnedto?.serverId === server.id) {
            a.allocationOwnedto = null;
            a.type = "";
          }
        });
        unsqh.update("nodes", node.id, { allocations: node.allocations });
      }

      const user = unsqh.get("users", server.userId);
      if (user?.servers) {
        user.servers = user.servers.filter((s) => s.id !== server.id);
        unsqh.update("users", user.id, { servers: user.servers });
      }

      unsqh.delete("servers", req.params.id);

      return res.json({ success: true });
    } catch (err) {
      console.error("Failed to delete server:", err.message || err);
      return res.status(500).json({ error: "Failed to delete server" });
    }
  }
);

/**
 * Users management (api/v1) – simplified API versions
 */
router.get(
  "/api/v1/users",
  requireAPI,
  requirePermission("users"),
  (req, res) => {
    const users = unsqh.list("users") || [];
    return res.json({ success: true, users });
  }
);

router.get(
  "/api/v1/user/:id",
  requireAPI,
  requirePermission("users"),
  (req, res) => {
    const target = unsqh.get("users", req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });

    const { password, twoFactorSecret, ...safeTarget } = target;
    const servers = (target.servers || []).map((s) =>
      typeof s === "string" ? unsqh.get("servers", s) : s
    );

    return res.json({ success: true, user: safeTarget, servers });
  }
);

router.post(
  "/api/v1/user/:id/edit",
  requireAPI,
  requirePermission("users"),
  (req, res) => {
    const target = unsqh.get("users", req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });

    const { email, username, password, admin } = req.body || {};
    const updates = {};

    if (email) updates.email = String(email).trim();
    if (username) updates.username = String(username).trim();
    if (typeof admin !== "undefined")
      updates.admin = admin === "true" || admin === true;

    if (password && password.trim() !== "") {
      const hash = crypto
        .createHash("sha256")
        .update(String(password))
        .digest("hex");
      updates.password = hash;
    }

    unsqh.update("users", req.params.id, updates);

    return res.json({ success: true, updates });
  }
);

router.post(
  "/api/v1/users/new",
  requireAPI,
  requirePermission("users"),
  (req, res) => {
    const { email, username, password, admin } = req.body || {};
    if (!email || !username || !password)
      return res
        .status(400)
        .json({ error: "Email, username, and password are required" });

    const existing = (unsqh.list("users") || []).find((u) => u.email === email);
    if (existing)
      return res
        .status(409)
        .json({ error: "User with this email already exists" });

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
    return res.json({
      success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        username: newUser.username,
        admin: newUser.admin,
      },
    });
  }
);

router.post(
  "/api/v1/user/:id/delete",
  requireAPI,
  requirePermission("users"),
  async (req, res) => {
    const targetId = req.params.id;
    const target = unsqh.get("users", targetId);
    if (!target) return res.status(404).json({ error: "User not found" });

    if (req.apiKey && req.apiKey.id === targetId) {
      // Prevent accidental self-delete via API key that maps to user id (defensive)
      return res
        .status(400)
        .json({ error: "Cannot delete user associated with this API key" });
    }

    const userServers = Array.isArray(target.servers) ? target.servers : [];

    for (const s of userServers) {
      const server = typeof s === "string" ? unsqh.get("servers", s) : s;
      if (!server) continue;

      const node =
        unsqh.list("nodes").find((n) => n.id === server.node?.id) ||
        unsqh.list("nodes").find((n) => n.ip === server.node?.ip);

      if (node && server.idt) {
        try {
          await axios.delete(
            `${getNodeUrl(node)}/server/delete/${server.idt}?key=${node.key}`
          );
        } catch (err) {
          console.warn(
            "Failed to delete server on node for user deletion:",
            err.message || err
          );
        }
      }

      if (node && Array.isArray(node.allocations)) {
        let changed = false;
        node.allocations.forEach((a) => {
          if (a.allocationOwnedto?.serverId === server.id) {
            a.allocationOwnedto = null;
            a.type = "";
            changed = true;
          }
        });
        if (changed)
          unsqh.update("nodes", node.id, { allocations: node.allocations });
      }

      try {
        unsqh.delete("servers", server.id);
      } catch (err) {
        // continue
      }
    }

    unsqh.delete("users", targetId);
    return res.json({ success: true });
  }
);

/**
 * Settings (app)
 */
router.get(
  "/api/v1/settings",
  requireAPI,
  requirePermission("settings"),
  (req, res) => {
    const settings = unsqh.get("settings", "app") || {};
    return res.json({ success: true, settings });
  }
);

router.post(
  "/api/v1/settings",
  requireAPI,
  requirePermission("settings"),
  (req, res) => {
    const { name, registerEnabled } = req.body || {};
    if (!name || name.trim() === "")
      return res.status(400).json({ error: "App name is required" });

    const updatedSettings = {
      name: name.trim(),
      registerEnabled: registerEnabled === true,
    };
    unsqh.put("settings", "app", updatedSettings);
    return res.json({ success: true, settings: updatedSettings });
  }
);

module.exports = router;
