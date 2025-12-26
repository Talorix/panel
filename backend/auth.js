const express = require("express");
const router = express.Router();
const unsqh = require("../modules/db.js");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");

function name() {
  const settings = unsqh.get("settings", "app") || {};
  return settings.name || "Talorix";
};

router.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/dashboard");
  }

  res.render("authentication/login", {
    name: name(),
  });
})
router.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email & password required" });

  const users = unsqh.list("users");
  const user = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (user.password !== hash) return res.status(401).json({ error: "Invalid credentials" });

  req.session.userId = user.id;
   if (user.twoFactorSecret) {
    req.session.pending2FA = user.id; 
    return res.render("authentication/2fa", { name: name(), error: null });
  }
  const { password: _, ...safeUser } = user;
  res.redirect('/dashboard');
});

router.get("/register", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/dashboard");
  }
  res.render("authentication/register", { name: name(), });
});

// --- POST /register ---
router.post("/register", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/dashboard");
  }

  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.render("register", { 
      name: name(), 
      error: "Email, username, and password are required"
    });
  }

  // Check if user already exists
  const existing = unsqh.list("users").find(u => u.email === email);
  if (existing) {
    return res.render("register", { 
      name: name(), 
      error: "User with this email already exists"
    });
  }

  const randomId = Date.now().toString() + Math.floor(Math.random() * 1000);

  const hash = crypto.createHash("sha256").update(password).digest("hex");

  unsqh.put("users", randomId, {
    id: randomId,
    email,
    username,
    servers: [],
    password: hash
  });

  req.session.userId = randomId;

  res.redirect("/dashboard");
});

router.post("/login/2fa", (req, res) => {
  const { token } = req.body;
  const userId = req.session.pending2FA;
  if (!userId) return res.redirect("/");

  const user = unsqh.get("users", userId);
  if (!user || !user.twoFactorSecret) return res.redirect("/");

  const verified = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token
  });

  if (!verified) {
    return res.render("authentication/2fa", { name: name(), error: "Invalid 2FA code" });
  }

  req.session.userId = user.id;
  delete req.session.pending2FA;

  res.redirect("/dashboard");
});
router.post("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.clearCookie("sid");
    res.json({ success: true });
  });
});

module.exports = router;
