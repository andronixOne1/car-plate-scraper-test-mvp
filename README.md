# 🚗 PlateVision AI - License Plate Recognition & Search MVP

A full-stack Node.js + Express web application for license plate recognition (ANPR/ALPR) using OCR (`tesseract.js`), connected to **Firebase Firestore** and **Firebase Storage**, designed for easy deployment to **Render**.

---

## 📁 Project Folder Structure

```
car-plate-scraper/
├── public/
│   ├── index.html       # Vanilla HTML Single Page App
│   ├── style.css        # Modern Dark-Mode SaaS CSS
│   └── app.js           # Client-side JS (Drag & Drop, Fetch API)
├── server.js            # Express API (Upload, OCR, Firestore, Storage)
├── package.json         # Node.js dependencies and start scripts
├── render.yaml          # Render web service configuration
├── .env.example         # Example environment variables
├── .gitignore           # Git ignore rules
└── README.md            # Setup and deployment documentation
```

---

## ⚡ Step 1: Local Setup & Running

### 1. Install Dependencies
In the project directory, run:
```bash
npm install
```

### 2. Configure Firebase Credentials
1. Download your Firebase Admin Service Account Key JSON file from the Firebase Console (**Project Settings > Service Accounts > Generate New Private Key**).
2. Place the file in the project root as `serviceAccountKey.json`, or create a `.env` file based on `.env.example`:

```env
PORT=10000
FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
```

3. Ensure Firebase Firestore rules and Firebase Storage rules are enabled for your project.

### 3. Run the Server
```bash
# Production mode
npm start

# Development mode (with auto-reload)
npm run dev
```

Open your browser at: `http://localhost:10000`

---

## 🚀 Step 2: Push to GitHub / Render Deployment

### Method A: Git Push to GitHub / GitLab (Recommended for Render)

1. **Initialize Git & Commit**:
   ```bash
   git add .
   git commit -m "Initial commit for License Plate Recognition MVP"
   ```

2. **Push to Remote Repository**:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/car-plate-scraper.git
   git branch -M main
   git push -u origin main
   ```

3. **Deploy on Render Dashboard**:
   - Go to [dashboard.render.com](https://dashboard.render.com) (or via your open Chrome session).
   - Click **New +** > **Web Service**.
   - Connect your GitHub repository (`car-plate-scraper`).
   - Render will automatically detect `render.yaml` settings or you can use:
     - **Runtime:** Node
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
   - In **Environment Variables**, add:
     - `PORT`: `10000`
     - `FIREBASE_STORAGE_BUCKET`: `your-project.appspot.com`
     - `FIREBASE_SERVICE_ACCOUNT`: *(Paste the entire contents of your serviceAccountKey.json file as a single line JSON string)*

---

## 🔄 Method B: Manual / CLI Deploy via Render Blueprint

1. Log in to Render via CLI or Dashboard.
2. Select **Blueprints** > **New Blueprint Instance**.
3. Point to your repository containing `render.yaml`.
4. Render will provision the web service automatically on port 10000.
