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
  limits: { fileSize: 10 * 1024 * 1024, files: 20 }, // 10MB per file, max 20 files
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
 * Strict License Plate Format Validation
 * Allowed Formats:
 * 1) "xx-nnn-xx" -> e.g. AB-123-CD (2 letters, 3 digits, 2 letters)
 * 2) "xx-nnnn"   -> e.g. AB-1234   (2 letters, 4 digits)
 * 3) "xxx-nnn"   -> e.g. ABC-123   (3 letters, 3 digits)
 * x = Latin letter (A-Z), n = Digit (0-9)
 */
function validateAndFormatPlate(rawText) {
  if (!rawText) return { isValid: false, formattedPlate: null, formatType: null };

  const cleaned = rawText.toUpperCase().trim();
  const strippedHyphen = cleaned.replace(/[^A-Z0-9-]/g, '');
  const strippedAlphaNum = cleaned.replace(/[^A-Z0-9]/g, '');

  const pattern1 = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
  const pattern2 = /^[A-Z]{2}-\d{4}$/;
  const pattern3 = /^[A-Z]{3}-\d{3}$/;

  // Check exact hyphenated format
  if (pattern1.test(strippedHyphen)) {
    return { isValid: true, formattedPlate: strippedHyphen, formatType: 'XX-NNN-XX' };
  }
  if (pattern2.test(strippedHyphen)) {
    return { isValid: true, formattedPlate: strippedHyphen, formatType: 'XX-NNNN' };
  }
  if (pattern3.test(strippedHyphen)) {
    return { isValid: true, formattedPlate: strippedHyphen, formatType: 'XXX-NNN' };
  }

  // Check pure alphanumeric string and format automatically
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(strippedAlphaNum)) {
    const formatted = `${strippedAlphaNum.slice(0,2)}-${strippedAlphaNum.slice(2,5)}-${strippedAlphaNum.slice(5,7)}`;
    return { isValid: true, formattedPlate: formatted, formatType: 'XX-NNN-XX' };
  }
  if (/^[A-Z]{2}\d{4}$/.test(strippedAlphaNum)) {
    const formatted = `${strippedAlphaNum.slice(0,2)}-${strippedAlphaNum.slice(2,6)}`;
    return { isValid: true, formattedPlate: formatted, formatType: 'XX-NNNN' };
  }
  if (/^[A-Z]{3}\d{3}$/.test(strippedAlphaNum)) {
    const formatted = `${strippedAlphaNum.slice(0,3)}-${strippedAlphaNum.slice(3,6)}`;
    return { isValid: true, formattedPlate: formatted, formatType: 'XXX-NNN' };
  }

  // Regexp search within OCR text block
  const match1 = cleaned.match(/\b([A-Z]{2})[- ]?(\d{3})[- ]?([A-Z]{2})\b/);
  if (match1) {
    return { isValid: true, formattedPlate: `${match1[1]}-${match1[2]}-${match1[3]}`, formatType: 'XX-NNN-XX' };
  }

  const match2 = cleaned.match(/\b([A-Z]{2})[- ]?(\d{4})\b/);
  if (match2) {
    return { isValid: true, formattedPlate: `${match2[1]}-${match2[2]}`, formatType: 'XX-NNNN' };
  }

  const match3 = cleaned.match(/\b([A-Z]{3})[- ]?(\d{3})\b/);
  if (match3) {
    return { isValid: true, formattedPlate: `${match3[1]}-${match3[2]}`, formatType: 'XXX-NNN' };
  }

  return { isValid: false, formattedPlate: null, formatType: null };
}

/**
 * Process a single image file through OCR and validation
 */
async function processSingleImage(file) {
  const fileName = file.originalname;
  try {
    // OCR with Tesseract.js (Whitelisted chars for faster speed and accuracy)
    const ocrResult = await Tesseract.recognize(file.buffer, 'eng', {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'
    });

    const rawText = ocrResult.data.text || '';
    const validation = validateAndFormatPlate(rawText);

    if (!validation.isValid) {
      return {
        filename: fileName,
        status: 'Declined',
        reason: 'Invalid format (Must be XX-NNN-XX, XX-NNNN, or XXX-NNN)',
        plate_number: null,
        raw_text: rawText.trim()
      };
    }

    // Upload to Firebase Storage if confirmed
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

    // Save to Firestore
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
      reason: `OCR Error: ${error.message}`,
      plate_number: null
    };
  }
}

/**
 * POST /api/upload
 * Accept single or multiple file uploads
 */
app.post('/api/upload', upload.array('images', 20), async (req, res) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No image files uploaded.' });
    }

    console.log(`Processing batch upload of ${files.length} file(s)...`);

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
    return res.status(500).json({ error: 'Failed to process batch upload.', details: error.message });
  }
});

/**
 * GET /api/search/:plate
 * Query spotted_plates Firestore collection by plate_number
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

// Health check route
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
