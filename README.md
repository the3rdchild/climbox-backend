# ClimBox: Backend
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Firebase Hosting](https://img.shields.io/badge/Hosted%20on-Firebase-orange?style=flat-square)](https://firebase.google.com/products/hosting)

ClimBox is an innovative solution designed to support the preservation of marine and freshwater ecosystems through technology-driven data monitoring and management. It provides accurate and continuous environmental insights, making it an ideal tool for researchers, coastal communities, and conservation organizations.

---

## Project File Structure

```
climbox-backend/
├── index.js                # main server
├── package.json
├── .env                    # API keys, spreadsheet mapping, etc. (gitignored)
├── serviceAccount.json     # Firebase Admin SDK (gitignored)
├── sheets-credentials.json # Google service account key (gitignored)
├── services/
│   ├── sheets.js           # Sheets API wrapper
│   ├── cacheWriter.js      # appendToCache, atomic writes
│   └── threshold.js        # threshold logic + dedupe
├── sync-sheets.js          # one-off or cron-triggered full sync script
├── public/
│   └── data/               # cached daily JSON files (gitignored)
└── README.md
```

---

## License

This project is licensed under the MIT License. See the [LICENSE](https://opensource.org/licenses/MIT) file for details.
