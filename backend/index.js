// backend/index.js
require('dotenv').config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const { appendToCache } = require('../public/services/cacheWriter');

// --- CONFIG ---
const API_KEY = process.env.API_KEY || "changeme";
const PORT = process.env.PORT || 4000;

// --- FIREBASE INIT ---
if (!admin.apps.length) {
  const serviceAccount = require("./serviceAccount.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// --- DEFAULT THRESHOLDS ---
const DEFAULT_THRESHOLDS = { sst: 30 };

// --- Express Setup ---
const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Middleware: API Key Auth ---
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/ingest") {
    if (req.headers["x-api-key"] !== API_KEY) {
      return res.status(403).json({ error: "Invalid API Key" });
    }
  }
  next();
});

// --- Helper: Add Sensor Data ---
async function addSensorData(payload) {
  const docRef = db.collection("sensorData").doc();
  const docData = {
    ...payload,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await docRef.set(docData);
  return { id: docRef.id, ...docData };
}

// --- Helper: Threshold Check ---
async function checkThresholdAndNotify(entry) {
  try {
    const locDoc = await db.collection("locations").doc(entry.locationId).get();
    let threshold = DEFAULT_THRESHOLDS[entry.sensorType] ?? null;

    if (locDoc.exists) {
      const loc = locDoc.data();
      if (Array.isArray(loc.sensors)) {
        const s = loc.sensors.find(
          x => x.sensorId === entry.sensorId || x.sensorType === entry.sensorType
        );
        if (s?.threshold !== undefined) threshold = s.threshold;
      }
    }

    if (threshold !== null && entry.value > threshold) {
      const notif = {
        sensorId: entry.sensorId,
        locationId: entry.locationId,
        sensorType: entry.sensorType,
        value: entry.value,
        threshold,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "unread",
        sentTo: []
      };
      await db.collection("notifications").add(notif);
      console.log(`ALERT: ${entry.locationId} ${entry.sensorType}=${entry.value} > ${threshold}`);
    }
  } catch (err) {
    console.error("checkThreshold error:", err);
  }
}

// --- Endpoint: Ingest ---
app.post("/ingest", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.locationId || !payload.sensorId || !payload.sensorType || payload.value === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const added = await addSensorData(payload);
    appendToCache({ id: added.id, ...added });
    checkThresholdAndNotify(added);

    res.status(200).json({ ok: true, id: added.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// --- Health Check ---
app.get("/", (req, res) => res.send("ClimBox backend running"));

// --- Start Server ---
app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
