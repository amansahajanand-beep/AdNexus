# Local mein Dashboard kaise chalayein

## Method 1: Bina Docker (Sabse Easy)

### Backend start karein (Terminal 1):
```bash
cd gam-dashboard/backend
npm install
cp .env.example .env
node src/server.js
```

### Frontend start karein (Terminal 2):
```bash
cd gam-dashboard/frontend
npm install
npm start
```

Browser mein open karein: http://localhost:3000

---

## Method 2: Docker se

```bash
cd gam-dashboard
docker-compose up --build
```

Browser mein open karein: http://localhost:80

---

## Notes

- `.env` mein credentials nahi hain → MOCK DATA dikhega (sample data)
- Real data ke liye → SETUP.md follow karein aur credentials daalen
- Mock mode mein "🔧 Mock Mode" banner dikhega top pe
