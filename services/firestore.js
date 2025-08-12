// services/firestore.js
const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require('../serviceAccount.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// Fetch a user profile
async function getUser(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? doc.data() : null;
}

// Create or update a user profile
async function setUser(uid, data) {
  await db.collection('users').doc(uid).set(data, { merge: true });
}

module.exports = { getUser, setUser, db };
