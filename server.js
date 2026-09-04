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

// Multer memory storage for multiple uploads (up to 20 files at once)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 }, // 15MB per file, max 20 files
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

    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: storageBucket
    });
    console.log('Firebase Admin initialized with Default Application Credentials.');

  } catch (error) {
    console.warn('⚠️ Warning: Firebase failed to initialize with provided credentials.', error.message);
  }
}

initFirebase();

const db = admin.apps.length ? admin.firestore() : null;
const bucket = admin.apps.length && process.env.FIREBASE_STORAGE_BUCKET ? admin.storage().bucket() : null;

/**
 * Common OCR Character Repairs
 */
function fixLetters(str) {
  return str
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/2/g, 'Z')
    .replace(/5/g, 'S')
    .replace(/8/g, 'B');
}

function fixDigits(str) {
  return str
    .replace(/O/g, '0')
    .replace(/Q/g, '0')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/Z/g, '2')
    .replace(/S/g, '5')
    .replace(/B/g, '8');
}

/**
 * Robust License Plate Extraction & Format Validation
 * Formats:
 * 1) "XX-NNN-XX" -> 2 letters, 3 digits, 2 letters (e.g. AB-123-CD)
 * 2) "XX-NNNN"   -> 2 letters, 4 digits (e.g. AB-1234)
 * 3) "XXX-NNN"   -> 3 letters, 3 digits (e.g. ABC-123)
 */
function extractLicensePlates(rawText) {
  if (!rawText) return { isValid: false, formattedPlate: null, formatType: null };

  const text = rawText.toUpperCase().replace(/[\r\n]+/g, ' ');

  // 1. Direct Regex Search for hyphenated / space-separated formats
  const match1 = text.match(/\b([A-Z0-9]{2})[- ]?(\d[A-Z0-9]{2})[- ]?([A-Z0-9]{2})\b/);
  if (match1) {
    const p1 = fixLetters(match1[1]);
    const p2 = fixDigits(match1[2]);
    const p3 = fixLetters(match1[3]);
    if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
      return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
    }
  }

  const match2 = text.match(/\b([A-Z0-9]{2})[- ]?([A-Z0-9]{4})\b/);
  if (match2) {
    const p1 = fixLetters(match2[1]);
    const p2 = fixDigits(match2[2]);
    if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
      return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
    }
  }

  const match3 = text.match(/\b([A-Z0-9]{3})[- ]?([A-Z0-9]{3})\b/);
  if (match3) {
    const p1 = fixLetters(match3[1]);
    const p2 = fixDigits(match3[2]);
    if (/^[A-Z]{3}$/.test(p1) && /^\d{3}$/.test(p2)) {
      return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XXX-NNN' };
    }
  }

  // 2. Token-by-token scan for unhyphenated license plate strings
  const tokens = text.match(/[A-Z0-9-]{6,12}/g) || [];
  for (const token of tokens) {
    const cleanToken = token.replace(/[^A-Z0-9]/g, '');

    // Format 1: Length 7 (XX-NNN-XX)
    if (cleanToken.length === 7) {
      const p1 = fixLetters(cleanToken.slice(0, 2));
      const p2 = fixDigits(cleanToken.slice(2, 5));
      const p3 = fixLetters(cleanToken.slice(5, 7));
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }

    // Format 2 & 3: Length 6 (XX-NNNN or XXX-NNN)
    if (cleanToken.length === 6) {
      // XX-NNNN
      const p1 = fixLetters(cleanToken.slice(0, 2));
      const p2 = fixDigits(cleanToken.slice(2, 6));
      if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
      }

      // XXX-NNN
      const q1 = fixLetters(cleanToken.slice(0, 3));
      const q2 = fixDigits(cleanToken.slice(3, 6));
      if (/^[A-Z]{3}$/.test(q1) && /^\d{3}$/.test(q2)) {
        return { isValid: true, formattedPlate: `${q1}-${q2}`, formatType: 'XXX-NNN' };
      }
    }
  }

  return { isValid: false, formattedPlate: null, formatType: null };
}

/**
 * Process a single image file through Tesseract OCR
 */
async function processSingleImage(file) {
  const fileName = file.originalname;
  try {
    // Run Tesseract OCR in sparse text mode (PSM 11) to find small text blocks on cars
    const ocrResult = await Tesseract.recognize(file.buffer, 'eng', {
      tessedit_pageseg_mode: '11'
    });

    let rawText = ocrResult.data.text || '';
    let validation = extractLicensePlates(rawText);

    // Fallback: If PSM 11 didn't find it, try PSM 3 (automatic segmentation)
    if (!validation.isValid) {
      const fallbackResult = await Tesseract.recognize(file.buffer, 'eng', {
        tessedit_pageseg_mode: '3'
      });
      rawText += ' ' + (fallbackResult.data.text || '');
      validation = extractLicensePlates(rawText);
    }

    if (!validation.isValid) {
      return {
        filename: fileName,
        status: 'Declined',
        reason: 'No valid license plate detected (Formats: XX-NNN-XX, XX-NNNN, XXX-NNN)',
        plate_number: null,
        raw_text: rawText.trim()
      };
    }

    // Save image to Firebase Storage or Base64 URI
    let imageUrl = '';
    if (bucket) {
      const storagePath = `spotted_plates/${Date.now()}_${path.basename(fileName)}`;
      const fileRef = bucket.file(storagePath);
      await fileRef.save(file.buffer, {
        metadata: { contentType: file.mimetype },
        public: true
      });
      imageUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    } else {
      imageUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    }

    const timestamp = new Date().toISOString();

    // Save document to Firestore spotted_plates
    let docId = 'temp-' + Date.now();
    if (db) {
      const docRef = await db.collection('spotted_plates').add({
        plate_number: validation.formattedPlate,
        format_type: validation.formatType,
        raw_text: rawText.trim(),
        image_url: imageUrl,
        status: 'Confirmed',
        created_at: timestamp,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      docId = docRef.id;
    }

    return {
      filename: fileName,
      status: 'Confirmed',
      id: docId,
      plate_number: validation.formattedPlate,
      format_type: validation.formatType,
      raw_text: rawText.trim(),
      image_url: imageUrl,
      timestamp: timestamp
    };

  } catch (error) {
    return {
      filename: fileName,
      status: 'Declined',
      reason: `OCR Processing Error: ${error.message}`,
      plate_number: null
    };
  }
}

/**
 * POST /api/upload
 */
app.post('/api/upload', upload.array('images', 20), async (req, res) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No image files uploaded.' });
    }

    console.log(`Processing ${files.length} image(s)...`);

    // Process all images concurrently
    const results = await Promise.all(files.map(file => processSingleImage(file)));

    const confirmedCount = results.filter(r => r.status === 'Confirmed').length;
    const declinedCount = results.filter(r => r.status === 'Declined').length;

    return res.status(200).json({
      success: true,
      total: results.length,
      confirmed: confirmedCount,
      declined: declinedCount,
      results: results
    });

  } catch (error) {
    console.error('Error in /api/upload:', error);
    return res.status(500).json({ error: 'Failed to process upload.', details: error.message });
  }
});

/**
 * GET /api/search/:plate
 */
app.get('/api/search/:plate?', async (req, res) => {
  try {
    const queryStr = req.params.plate ? req.params.plate.toUpperCase().trim() : '';

    if (!db) {
      return res.status(200).json({
        success: true,
        query: queryStr,
        results: [],
        message: 'Firestore not connected.'
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
        format_type: data.format_type,
        status: data.status || 'Confirmed',
        raw_text: data.raw_text,
        image_url: data.image_url,
        timestamp: data.created_at || (data.timestamp ? data.timestamp.toDate().toISOString() : new Date().toISOString())
      });
    });

    if (queryStr) {
      results = results.filter(item => 
        item.plate_number.includes(queryStr) || queryStr.includes(item.plate_number)
      );
    }

    return res.status(200).json({
      success: true,
      query: queryStr,
      count: results.length,
      results: results
    });

  } catch (error) {
    console.error('Error in /api/search:', error);
    return res.status(500).json({ error: 'Failed to search plates.', details: error.message });
  }
});

// Health check
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
});
