// backend/test_read.js
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function readRecentData(locationId, sensorId, limit = 10) {
  const snapshot = await db.collection("notifications")
    .where("locationId", "==", locationId)
    .where("sensorId", "==", sensorId)
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();

  if (snapshot.empty) {
    console.log("No matching documents.");
    return;
  }

  snapshot.forEach(doc => {
    console.log(doc.id, "=>", doc.data());
  });
}

// Example: get last 10 records for komodo_sst_01
readRecentData("pulau_komodo", "komodo_sst_01")
  .then(() => process.exit())
  .catch(err => console.error(err));
