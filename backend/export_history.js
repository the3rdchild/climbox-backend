// /backend/export_history.js
const fs = require('fs');
const path = require('path');
const { db } = require('./services/firestore');

async function exportHistory() {
  console.log('Exporting Firestore sensor data to /public/data/...');

  // Query all sensorData
  const snapshot = await db.collection('sensorData').orderBy('timestamp', 'asc').get();
  if (snapshot.empty) {
    console.log('No sensor data found.');
    return;
  }

  // Group by date
  const grouped = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    const dateStr = new Date(data.timestamp.toDate ? data.timestamp.toDate() : data.timestamp).toISOString().split('T')[0];

    if (!grouped[dateStr]) grouped[dateStr] = [];
    grouped[dateStr].push({
      id: doc.id,
      ...data
    });
  });

  // Ensure /public/data exists
  const dataDir = path.join(__dirname, '../public/data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Save each group as JSON
  Object.keys(grouped).forEach(date => {
    const filePath = path.join(dataDir, `sensorData_${date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(grouped[date], null, 2), 'utf8');
    console.log(`Saved ${grouped[date].length} records to ${filePath}`);
  });

  console.log('Export complete.');
}

exportHistory().catch(err => {
  console.error('Error exporting history:', err);
});
