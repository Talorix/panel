const express = require("express");
const router = express.Router();
const unsqh = require("../modules/db.js");

/* =========================
   MIDDLEWARE
========================= */
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/");
  next();
}

/* =========================
   USER SERVER MANAGEMENT ROUTE
========================= */

/**
 * GET /server/manage/:id
 * Render server management page for a single server
 */
router.get("/server/manage/:id", requireAuth, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const server = user.servers?.find(s => s.id === req.params.id);
  if (!server) return res.redirect("/dashboard"); // fallback if server not found

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("server/manage", {
    name: appName,
    user,
    server
  });
});

module.exports = router;
