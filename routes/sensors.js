const express = require("express");
const router = express.Router();
const { getSheetData } = require("../services/sheetsService");

// GET /sensors/:locationId
router.get("/:locationId", async (req, res) => {
  try {
    const data = await getSheetData(req.params.locationId);
    res.json(data);
  } catch (err) {
    console.error("Error getting sensor data:", err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
