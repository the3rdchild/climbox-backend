// test_push_user.js
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccount.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function pushUser(uid, email, displayName) {
  const userRef = db.collection("users").doc(uid);
  const data = {
    email,
    displayName,
    role: "user",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await userRef.set(data, { merge: true });
  console.log(`✅ User ${uid} added to Firestore`);
}

pushUser("user_002", "test@example.com", "Test User")
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
