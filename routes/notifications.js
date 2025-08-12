const express = require("express");
const router = express.Router();
const { readCache } = require("../services/cacheService");

// GET /notifications
router.get("/", (req, res) => {
  try {
    const notifications = readCache("notifications");
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
