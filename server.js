const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer memory storage for uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Initialize Firebase Admin SDK
function initFirebase() {
  if (admin.apps.length > 0) return;

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  try {
    // Option 1: Inline JSON Service Account Key (Render / Cloud environment)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: storageBucket
      });
      console.log('Firebase Admin initialized with FIREBASE_SERVICE_ACCOUNT JSON.');
      return;
    }

    // Option 2: File path via GOOGLE_APPLICATION_CREDENTIALS or local serviceAccountKey.json
    let credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentialPath && fs.existsSync(path.join(__dirname, 'serviceAccountKey.json'))) {
      credentialPath = path.join(__dirname, 'serviceAccountKey.json');
    }

    if (credentialPath && fs.existsSync(credentialPath)) {
      const serviceAccount = require(path.resolve(credentialPath));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: storageBucket
      });
      console.log(`Firebase Admin initialized using credentials from ${credentialPath}`);
      return;
    }

    // Option 3: Default Application Credentials
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: storageBucket
    });
    console.log('Firebase Admin initialized with Default Application Credentials.');

  } catch (error) {
    console.warn('⚠️ Warning: Firebase failed to initialize with provided credentials.', error.message);
    console.warn('Fallback: Running in dry-run mode until valid Firebase credentials are provided.');
  }
}

initFirebase();

// Firestore and Storage references
const db = admin.apps.length ? admin.firestore() : null;
const bucket = admin.apps.length && process.env.FIREBASE_STORAGE_BUCKET ? admin.storage().bucket() : null;

// Clean raw OCR output to normalized plate format (alphanumeric uppercase)
function cleanPlateText(text) {
  if (!text) return '';
  return text
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/**
 * POST /api/upload
 * Process uploaded car image, extract license plate via OCR, upload image to Storage & save record in Firestore.
 */
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' });
    }

    console.log(`Received file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Step 1: Extract Text via OCR using Tesseract.js
    console.log('Running OCR recognition...');
    const ocrResult = await Tesseract.recognize(req.file.buffer, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          console.log(`OCR Progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });

    const rawText = ocrResult.data.text || '';
    const plateNumber = cleanPlateText(rawText);
    console.log(`OCR Extraction complete. Raw: "${rawText.trim()}" => Plate: "${plateNumber}"`);

    let imageUrl = '';
    
    // Step 2: Upload Image to Firebase Storage (if bucket available)
    if (bucket) {
      const filename = `spotted_plates/${Date.now()}_${path.basename(req.file.originalname)}`;
      const fileRef = bucket.file(filename);

      await fileRef.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
        public: true
      });

      imageUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      console.log(`Image uploaded to Firebase Storage: ${imageUrl}`);
    } else {
      // Data URI fallback for development/testing without live Firebase connection
      const base64Data = req.file.buffer.toString('base64');
      imageUrl = `data:${req.file.mimetype};base64,${base64Data}`;
      console.log('Using base64 image representation (Firebase Storage bucket not configured).');
    }

    const timestamp = new Date().toISOString();

    // Step 3: Save to Firestore
    let docId = 'temp-' + Date.now();
    if (db) {
      const docRef = await db.collection('spotted_plates').add({
        plate_number: plateNumber || 'UNKNOWN',
        raw_text: rawText.trim(),
        image_url: imageUrl,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        created_at: timestamp
      });
      docId = docRef.id;
      console.log(`Saved record to Firestore spotted_plates collection with ID: ${docId}`);
    }

    return res.status(200).json({
      success: true,
      id: docId,
      plate_number: plateNumber || 'UNKNOWN',
      raw_text: rawText.trim(),
      image_url: imageUrl,
      timestamp: timestamp
    });

  } catch (error) {
    console.error('Error in /api/upload:', error);
    return res.status(500).json({ error: 'Failed to process image.', details: error.message });
  }
});

/**
 * GET /api/search/:plate
 * Search spotted_plates Firestore collection by plate_number (supports exact & substring matching).
 */
app.get('/api/search/:plate?', async (req, res) => {
  try {
    const searchQuery = req.params.plate ? cleanPlateText(req.params.plate) : '';

    if (!db) {
      return res.status(200).json({
        success: true,
        query: searchQuery,
        results: [],
        message: 'Firestore not connected. Configure Firebase credentials to query live data.'
      });
    }

    const snapshot = await db.collection('spotted_plates')
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();

    let results = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      results.push({
        id: doc.id,
        plate_number: data.plate_number,
        raw_text: data.raw_text,
        image_url: data.image_url,
        timestamp: data.created_at || (data.timestamp ? data.timestamp.toDate().toISOString() : new Date().toISOString())
      });
    });

    // Filter by searchQuery if provided
    if (searchQuery) {
      results = results.filter(item => 
        item.plate_number.includes(searchQuery) || searchQuery.includes(item.plate_number)
      );
    }

    return res.status(200).json({
      success: true,
      query: searchQuery,
      count: results.length,
      results: results
    });

  } catch (error) {
    console.error('Error in /api/search:', error);
    return res.status(500).json({ error: 'Failed to search license plates.', details: error.message });
  }
});

// Healthcheck route
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    firebase_connected: !!db,
    storage_connected: !!bucket,
    timestamp: new Date()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
});
