# ClimBox: Backend
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Firebase Hosting](https://img.shields.io/badge/Hosted%20on-Firebase-orange?style=flat-square)](https://firebase.google.com/products/hosting)

ClimBox is an innovative solution designed to support the preservation of marine and freshwater ecosystems through technology-driven data monitoring and management. It provides accurate and continuous environmental insights, making it an ideal tool for researchers, coastal communities, and conservation organizations.

---

## Project File Structure

```
climbox-backend
├── index.js                 # Main server
├── services/
│   ├── auth.js               # Firestore auth, user profile
│   ├── sheets.js             # Google Sheets API read/write
│   ├── cacheWriter.js        # Local JSON cache handling
│   └── threshold.js          # Threshold check logic
├── routes/
│   ├── ingest.js             # Optional ingest route (if pushing to sheets)
│   ├── notifications.js      # Serve notifications from cache
│   ├── users.js              # Sign-up/sign-in/profile endpoints
│   └── sensors.js            # Fetch sensor data (from local cache or sheets)
├── public/
│   └── data/                 # Local cached JSON data
└── package.json
```

---

## License

This project is licensed under the MIT License. See the [LICENSE](https://opensource.org/licenses/MIT) file for details.
