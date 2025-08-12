// test_read_users.js
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccount.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function readUsers() {
  const snapshot = await db.collection("users").get();
  if (snapshot.empty) {
    console.log("No users found");
    return;
  }
  snapshot.forEach(doc => {
    console.log(doc.id, "=>", doc.data());
  });
}

readUsers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
