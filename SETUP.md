# GAM Live Dashboard — Complete Setup Guide

## Aapko kya kya chahiye
- Google Ad Manager account (Network Admin access) ✅
- DigitalOcean Droplet (Ubuntu 22.04, minimum 2GB RAM)
- Domain name (optional lekin recommended)

---

## STEP 1: Google Cloud Console — API Credentials banayein

### 1.1 Project banayein
1. https://console.cloud.google.com par jayein
2. Top mein "Select Project" → "New Project" click karein
3. Name: `GAM-Dashboard` → Create

### 1.2 Google Ad Manager API enable karein
1. Left menu: "APIs & Services" → "Library"
2. Search: "Google Ad Manager API"
3. Click → "Enable" button dabayein

### 1.3 OAuth Credentials banayein
1. "APIs & Services" → "Credentials"
2. "+ CREATE CREDENTIALS" → "OAuth client ID"
3. Pehli baar: "Configure consent screen" aayega:
   - User Type: "External" select karein
   - App name: `GAM Dashboard`
   - Support email: aapki email
   - Save & Continue (baaki sab skip)
   - "Back to Dashboard"
4. Dobara Credentials → Create OAuth Client ID:
   - Application type: **Web application**
   - Name: `GAM Dashboard`
   - Authorized redirect URIs: `http://YOUR_SERVER_IP/auth/callback`
   - (Local testing ke liye bhi: `http://localhost:3001/auth/callback`)
5. **CLIENT ID aur CLIENT SECRET copy karein** — .env mein daalna hai

---

## STEP 2: GAM Network Code nikalein

1. Google Ad Manager (https://admanager.google.com) open karein
2. Login karein
3. URL mein dekhen: `https://admanager.google.com/XXXXXXXXX#home`
4. Wo `XXXXXXXXX` number hi aapka **Network Code** hai

---

## STEP 3: DigitalOcean Droplet setup karein

### 3.1 Droplet banayein
- Image: Ubuntu 22.04 LTS
- Plan: Basic, $12/month (2GB RAM / 1 CPU)
- Region: Bangalore (BLR1) — India ke liye best
- SSH Key add karein

### 3.2 Server pe connect karein
```bash
ssh root@YOUR_DROPLET_IP
```

### 3.3 Docker install karein
```bash
# System update
apt update && apt upgrade -y

# Docker install
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Docker Compose
apt install docker-compose -y

# Verify
docker --version
docker-compose --version
```

### 3.4 Firewall setup
```bash
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw enable
```

---

## STEP 4: Code server par upload karein

### Option A: Git (Recommended)
```bash
# Server pe
apt install git -y
git clone https://github.com/YOUR_USERNAME/gam-dashboard.git
cd gam-dashboard
```

### Option B: SCP (Local se directly)
```bash
# Apne local machine se run karein:
scp -r ./gam-dashboard root@YOUR_DROPLET_IP:/root/
```

---

## STEP 5: Environment Variables configure karein

```bash
cd /root/gam-dashboard/backend
cp .env.example .env
nano .env
```

Yeh fill karein:
```env
GOOGLE_CLIENT_ID=your_client_id_from_step_1
GOOGLE_CLIENT_SECRET=your_client_secret_from_step_1
GOOGLE_REDIRECT_URI=http://YOUR_DROPLET_IP/auth/callback
GAM_NETWORK_CODE=your_network_code_from_step_2
FRONTEND_URL=http://YOUR_DROPLET_IP
JWT_SECRET=koi_bhi_random_64_char_string_yahan_likhen
```

Save karein: Ctrl+X → Y → Enter

---

## STEP 6: Docker se build & run karein

```bash
cd /root/gam-dashboard

# Build aur start
docker-compose up -d --build

# Logs check karein
docker-compose logs -f backend
```

---

## STEP 7: OAuth Token generate karein (IMPORTANT!)

Yeh ek baar karna hai — refresh token milega jo .env mein save karna hai.

1. Browser mein open karein: `http://YOUR_DROPLET_IP/auth/login`
2. Google account se login karein (wo wali Gmail jo GAM pe hai)
3. Permission grant karein
4. Aapko dikhe screen pe refresh_token — YA server logs mein:

```bash
docker-compose logs backend | grep "GOOGLE_REFRESH_TOKEN"
```

5. Us token ko `.env` mein paste karein:
```env
GOOGLE_REFRESH_TOKEN=1//XXXXXXXXXXXXX...
```

6. Backend restart karein:
```bash
docker-compose restart backend
```

---

## STEP 8: Dashboard verify karein

```bash
# Auth check
curl http://YOUR_DROPLET_IP/auth/status

# Expected output:
# {"authenticated":true,"network_code":"XXXXXXX","token_valid":true}
```

Browser mein open karein: **http://YOUR_DROPLET_IP**

---

## STEP 9: Domain & SSL setup (Optional lekin recommended)

### 9.1 Domain point karein
Apne domain provider pe jaake A Record banayein:
- Type: A
- Name: @ (ya subdomain jaise `ads`)
- Value: YOUR_DROPLET_IP

### 9.2 SSL Certificate (Free — Let's Encrypt)
```bash
apt install certbot -y

# Certificate lein
certbot certonly --standalone -d yourdomain.com

# Frontend nginx config mein SSL add karein:
nano /root/gam-dashboard/frontend/nginx.conf
```

`nginx.conf` mein SSL section add karein:
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    # ... baaki same rakhein
}
```

### 9.3 `.env` update karein
```env
GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/callback
FRONTEND_URL=https://yourdomain.com
```

---

## Useful Commands

```bash
# Dashboard dekhen
docker-compose ps

# Logs live
docker-compose logs -f

# Restart
docker-compose restart

# Stop
docker-compose down

# Update karein (naya code aane par)
git pull
docker-compose up -d --build
```

---

## Data jo aapko dena hai mujhe

Ab aap mujhe yeh do cheezein bata dein:

1. **GOOGLE_CLIENT_ID** — Step 1 mein milega
2. **GOOGLE_CLIENT_SECRET** — Step 1 mein milega  
3. **GAM_NETWORK_CODE** — URL se milega
4. **GOOGLE_REFRESH_TOKEN** — Step 7 ke baad milega

In sab ke bina dashboard real data nahi dikha sakta.
