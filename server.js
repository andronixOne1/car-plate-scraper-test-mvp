const express = require('express');
const cors = require('cors');
const multer = require('multer');
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

// Multer memory storage (Strict limit: MAX 10 files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
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

  let storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;

      if (!storageBucket && serviceAccount.project_id) {
        storageBucket = `${serviceAccount.project_id}.firebasestorage.app`;
      }

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
      if (!storageBucket && serviceAccount.project_id) {
        storageBucket = `${serviceAccount.project_id}.firebasestorage.app`;
      }
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
const bucket = admin.apps.length ? admin.storage().bucket() : null;

// --- License Plate Extraction & Character Repair ---
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

function extractLicensePlate(rawText) {
  if (!rawText) return { isValid: false, formattedPlate: null, formatType: null };

  const normalized = rawText.toUpperCase()
    .replace(/[—–_·•:]+/g, '-')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s*-\s*/g, '-');

  const cleaned = normalized.replace(/\b(GE|EU|AM|AZ|TR|UA|MD|RO|BG|PL|DE|FR|IT|ES)[-\s]+/gi, '');
  const textsToTry = [cleaned, normalized, rawText.toUpperCase().replace(/[\r\n]+/g, ' ')];

  for (const t of textsToTry) {
    const m1 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{2})[- ]*([A-Z0-9]{3})[- ]*([A-Z0-9]{2})(?:$|[^A-Z0-9])/);
    if (m1) {
      const p1 = fixLetters(m1[1]), p2 = fixDigits(m1[2]), p3 = fixLetters(m1[3]);
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }

    const m2 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{2})[- ]*([A-Z0-9]{4})(?:$|[^A-Z0-9])/);
    if (m2) {
      const p1 = fixLetters(m2[1]), p2 = fixDigits(m2[2]);
      if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
      }
    }

    const m3 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{3})[- ]*([A-Z0-9]{3})(?:$|[^A-Z0-9])/);
    if (m3) {
      const p1 = fixLetters(m3[1]), p2 = fixDigits(m3[2]);
      if (/^[A-Z]{3}$/.test(p1) && /^\d{3}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XXX-NNN' };
      }
    }

    const m4 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{4})[- ]*([A-Z0-9]{2})(?:$|[^A-Z0-9])/);
    if (m4) {
      const p1 = fixDigits(m4[1]), p2 = fixLetters(m4[2]);
      if (/^\d{4}$/.test(p1) && /^[A-Z]{2}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'NNNN-XX' };
      }
    }
  }

  const tokens = normalized.match(/[A-Z0-9]{6,12}/g) || [];
  for (const token of tokens) {
    if (token.length === 7) {
      const p1 = fixLetters(token.slice(0, 2)), p2 = fixDigits(token.slice(2, 5)), p3 = fixLetters(token.slice(5, 7));
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }
    if (token.length === 9) {
      const sub = token.slice(2);
      const p1 = fixLetters(sub.slice(0, 2)), p2 = fixDigits(sub.slice(2, 5)), p3 = fixLetters(sub.slice(5, 7));
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }
    if (token.length === 6) {
      const p1 = fixLetters(token.slice(0, 2)), p2 = fixDigits(token.slice(2, 6));
      if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
      }
      const q1 = fixLetters(token.slice(0, 3)), q2 = fixDigits(token.slice(3, 6));
      if (/^[A-Z]{3}$/.test(q1) && /^\d{3}$/.test(q2)) {
        return { isValid: true, formattedPlate: `${q1}-${q2}`, formatType: 'XXX-NNN' };
      }
      const r1 = fixDigits(token.slice(0, 4)), r2 = fixLetters(token.slice(4, 6));
      if (/^\d{4}$/.test(r1) && /^[A-Z]{2}$/.test(r2)) {
        return { isValid: true, formattedPlate: `${r1}-${r2}`, formatType: 'NNNN-XX' };
      }
    }
  }

  return { isValid: false, formattedPlate: null, formatType: null };
}

/**
 * POST /api/upload
 */
app.post('/api/upload', upload.array('images', 10), async (req, res) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No image files uploaded.' });
    }

    const initialPlateNumber = req.body.plate_number || null;
    const initialFormatType = req.body.format_type || null;
    let isConfirmed = req.body.status === 'Confirmed' && initialPlateNumber;
    let rawText = req.body.raw_text || '';
    let plateNumber = initialPlateNumber;
    let formatType = initialFormatType;

    const results = [];

    for (const file of files) {
      const fileName = file.originalname;

      // Server-side fallback OCR check if client did not detect plate
      if (!isConfirmed && file.buffer) {
        try {
          const tesseract = require('tesseract.js');
          const serverOcr = await tesseract.recognize(file.buffer, 'eng');
          const serverText = serverOcr.data.text || '';
          const serverValidation = extractLicensePlate(serverText);
          if (serverValidation.isValid) {
            plateNumber = serverValidation.formattedPlate;
            formatType = serverValidation.formatType;
            isConfirmed = true;
            rawText = (rawText ? rawText + ' | ' : '') + serverText;
            console.log(`✅ Server OCR fallback rescued plate: ${plateNumber} (${formatType})`);
          }
        } catch (ocrErr) {
          console.warn('Server fallback OCR error:', ocrErr.message);
        }
      }

      if (!isConfirmed) {
        results.push({
          filename: fileName,
          status: 'Declined',
          reason: 'No valid license plate detected (Formats: XX-NNN-XX, XX-NNNN, XXX-NNN, NNNN-XX)',
          plate_number: null,
          raw_text: rawText
        });
        continue;
      }

      // Optional Image Storage (Firebase Storage if enabled, otherwise safe metadata-only or compact)
      let imageUrl = '';
      if (bucket && process.env.FIREBASE_STORAGE_BUCKET) {
        try {
          const storagePath = `spotted_plates/${Date.now()}_${path.basename(fileName)}`;
          const fileRef = bucket.file(storagePath);
          await fileRef.save(file.buffer, {
            metadata: { contentType: file.mimetype },
            public: true
          });
          imageUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
        } catch (storageErr) {
          console.warn('⚠️ Cloud Storage upload skipped/failed:', storageErr.message);
          imageUrl = '';
        }
      } else if (file.buffer && file.buffer.length < 300 * 1024) {
        // Only embed base64 if image is under 300KB to respect Firestore 1MB document limit
        imageUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      }

      const timestamp = new Date().toISOString();

      // Save to Firestore
      let docId = 'temp-' + Date.now();
      if (db) {
        const docRef = await db.collection('spotted_plates').add({
          plate_number: plateNumber,
          format_type: formatType,
          raw_text: rawText,
          image_url: imageUrl,
          status: 'Confirmed',
          created_at: timestamp,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        docId = docRef.id;
      }

      results.push({
        filename: fileName,
        status: 'Confirmed',
        id: docId,
        plate_number: plateNumber,
        format_type: formatType,
        raw_text: rawText,
        image_url: imageUrl,
        timestamp: timestamp
      });
    }

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
    version: '2.1.0-resilient-ocr',
    firebase_connected: !!db,
    storage_connected: !!bucket,
    timestamp: new Date()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
