#!/usr/bin/env node
const prompts = require("prompts");
const crypto = require("crypto");
const unsqh = require("../modules/db.js");
const Logger = require("../modules/logger.js");
(async () => {
  Logger.log("=== Talorix Admin System ===\n");

  const response = await prompts({
    type: "select",
    name: "action",
    message: "Choose an action:",
    choices: [
      { title: "Create a new admin user", value: "create" },
      { title: "Set existing user as admin", value: "set" },
      { title: "Fetch images from remote library", value: "fetchImages" },
    ],
  });

  if (response.action === "create") {
    const userData = await prompts([
      { type: "text", name: "username", message: "Username:" },
      { type: "text", name: "email", message: "Email:" },
      { type: "password", name: "password", message: "Password:" },
    ]);

    const existing = unsqh
      .list("users")
      .find((u) => u.email === userData.email);
    if (existing) {
      Logger.log("Error: User with this email already exists.");
      process.exit(1);
    }

    const id = Math.random().toString(36).substring(2, 12);
    const hash = crypto
      .createHash("sha256")
      .update(userData.password)
      .digest("hex");

    unsqh.put("users", id, {
      id,
      email: userData.email,
      username: userData.username,
      password: hash,
      servers: [],
      admin: true,
    });

    Logger.log(`Admin user created: ${userData.username} (${userData.email})`);
  } else if (response.action === "set") {
    const emailResponse = await prompts({
      type: "text",
      name: "email",
      message: "Enter the email of the user to make admin:",
    });

    const user = unsqh
      .list("users")
      .find((u) => u.email === emailResponse.email);
    if (!user) {
      Logger.log("Error: No user found with that email.");
      process.exit(1);
    }

    unsqh.put("users", user.id, { ...user, admin: true });
    Logger.log(`User ${user.username} (${user.email}) is now an admin.`);
  } else if (response.action === "fetchImages") {
    const url =
      "https://raw.githubusercontent.com/Talorix/Container-Images/refs/heads/main/image_library.json";

    try {
      const libraryResp = await fetch(url);
      if (!libraryResp.ok)
        throw new Error(`Failed to fetch URL: ${libraryResp.status}`);
      const library = await libraryResp.json();

      const addedImages = [];
      const skippedImages = [];

      for (const key in library) {
        const imageUrl = library[key];

        const imageResp = await fetch(imageUrl);
        if (!imageResp.ok) continue;
        const imageData = await imageResp.json();

        const { dockerImage, name, description, envs, files, features } = imageData;
        if (!dockerImage || !name) continue;

        // Check if an identical image already exists
        const exists = unsqh.list("images").some((img) => {
          return (
            img.dockerImage === dockerImage &&
            img.name === name &&
            img.description === (description || "") &&
            JSON.stringify(img.envs || {}) === JSON.stringify(envs || {}) &&
            JSON.stringify(img.files || []) === JSON.stringify(files || [])
          );
        });

        if (exists) {
          skippedImages.push(name);
          continue; // skip identical
        }

        // Add new or updated image
        const id = crypto.randomUUID();
        const image = {
          id,
          dockerImage,
          name,
          description: description || "",
          envs: envs || {},
          files: files || [],
          features: Array.isArray(features) ? features : [], 
          createdAt: Date.now(),
        };

        unsqh.put("images", id, image);
        addedImages.push(image);
      }

      Logger.log(`Successfully added/updated ${addedImages.length} images.`);
      addedImages.forEach((img) =>
        Logger.log(`- ${img.name} (${img.dockerImage})`)
      );

      if (skippedImages.length > 0) {
        Logger.log(`Skipped ${skippedImages.length} identical images:`);
        skippedImages.forEach((name) => Logger.log(`- ${name}`));
      }
    } catch (err) {
      Logger.log("Error fetching images:", err.message);
    }
  }

  process.exit(0);
})();
