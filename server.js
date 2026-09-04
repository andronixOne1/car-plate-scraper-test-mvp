const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const tesseract = require('tesseract.js');
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
      let p1 = fixLetters(m1[1]), p2 = fixDigits(m1[2]), p3 = fixLetters(m1[3]);
      if ((p1.startsWith('U') || p1.startsWith('Y')) && /^[A-Z]{2}$/.test(p1)) {
        p1 = 'V' + p1.slice(1);
      }
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }

    const m2 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{2})[- ]*([A-Z0-9]{4})(?:$|[^A-Z0-9])/);
    if (m2) {
      let p1 = fixLetters(m2[1]), p2 = fixDigits(m2[2]);
      if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
      }
    }

    const m3 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{3})[- ]*([A-Z0-9]{3})(?:$|[^A-Z0-9])/);
    if (m3) {
      let p1 = fixLetters(m3[1]), p2 = fixDigits(m3[2]);
      if (/^[A-Z]{3}$/.test(p1) && /^\d{3}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XXX-NNN' };
      }
    }

    const m4 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{4})[- ]*([A-Z0-9]{2})(?:$|[^A-Z0-9])/);
    if (m4) {
      let p1 = fixDigits(m4[1]), p2 = fixLetters(m4[2]);
      if (/^\d{4}$/.test(p1) && /^[A-Z]{2}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'NNNN-XX' };
      }
    }
  }

  const tokens = normalized.match(/[A-Z0-9]{6,12}/g) || [];
  for (const token of tokens) {
    if (token.length === 7) {
      let p1 = fixLetters(token.slice(0, 2)), p2 = fixDigits(token.slice(2, 5)), p3 = fixLetters(token.slice(5, 7));
      if (p1.startsWith('U') || p1.startsWith('Y')) p1 = 'V' + p1.slice(1);
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }
    if (token.length === 9) {
      const sub = token.slice(2);
      let p1 = fixLetters(sub.slice(0, 2)), p2 = fixDigits(sub.slice(2, 5)), p3 = fixLetters(sub.slice(5, 7));
      if (p1.startsWith('U') || p1.startsWith('Y')) p1 = 'V' + p1.slice(1);
      if (/^[A-Z]{2}$/.test(p1) && /^\d{3}$/.test(p2) && /^[A-Z]{2}$/.test(p3)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}-${p3}`, formatType: 'XX-NNN-XX' };
      }
    }
    if (token.length === 6) {
      const p1 = fixLetters(token.slice(0, 2)), p2 = fixDigits(token.slice(2, 6));
      if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
        return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
      }
    }
  }

  return { isValid: false, formattedPlate: null, formatType: null };
}

/**
 * Fast Morphological Plate Candidate Locator
 */
async function findCandidatesOnBuffer(buf) {
  const targetW = 800;
  const meta = await sharp(buf).metadata();
  const scale = meta.width / targetW;

  const { data, info } = await sharp(buf)
    .resize({ width: targetW })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, len = w * h;
  const startY = Math.floor(h * 0.25);
  const endY = Math.floor(h * 0.95);
  const grad = new Float32Array(len);

  for (let y = startY + 1; y < endY - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const gx = (-data[row - w + x - 1] + data[row - w + x + 1])
               + 2 * (-data[row + x - 1] + data[row + x + 1])
               + (-data[row + w + x - 1] + data[row + w + x + 1]);
      grad[row + x] = Math.abs(gx);
    }
  }

  let maxG = 0;
  for (let i = 0; i < len; i++) if (grad[i] > maxG) maxG = grad[i];
  const gradU8 = new Uint8Array(len);
  if (maxG > 0) {
    for (let i = 0; i < len; i++) gradU8[i] = Math.min(255, Math.floor((grad[i] / maxG) * 255));
  }

  const hist = new Int32Array(256);
  let totalPix = 0;
  for (let y = startY; y < endY; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      hist[gradU8[row + x]]++;
      totalPix++;
    }
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, varMax = 0, otsuThresh = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = totalPix - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      otsuThresh = t;
    }
  }

  const bin = new Uint8Array(len);
  for (let y = startY; y < endY; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gradU8[row + x] >= otsuThresh) bin[row + x] = 255;
    }
  }

  const kw = 17, kh = 5;
  const padW = Math.floor(kw / 2), padH = Math.floor(kh / 2);
  const dilated = new Uint8Array(len);

  for (let y = startY; y < endY; y++) {
    for (let x = padW; x < w - padW; x++) {
      let maxVal = 0;
      for (let dy = -padH; dy <= padH; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const r = ny * w;
        for (let dx = -padW; dx <= padW; dx++) {
          if (bin[r + x + dx] === 255) { maxVal = 255; break; }
        }
        if (maxVal === 255) break;
      }
      dilated[y * w + x] = maxVal;
    }
  }

  const closed = new Uint8Array(len);
  for (let y = startY; y < endY; y++) {
    for (let x = padW; x < w - padW; x++) {
      let minVal = 255;
      for (let dy = -padH; dy <= padH; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) { minVal = 0; break; }
        const r = ny * w;
        for (let dx = -padW; dx <= padW; dx++) {
          if (dilated[r + x + dx] === 0) { minVal = 0; break; }
        }
        if (minVal === 0) break;
      }
      closed[y * w + x] = minVal;
    }
  }

  const visited = new Uint8Array(len);
  const candidates = [];

  for (let y = startY; y < endY; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (closed[idx] === 255 && !visited[idx]) {
        let minX = x, maxX = x, minY = y, maxY = y;
        let pixelCount = 0;
        const queue = [idx];
        visited[idx] = 1;

        let qHead = 0;
        while (qHead < queue.length) {
          const cur = queue[qHead++];
          const cy = Math.floor(cur / w);
          const cx = cur % w;
          pixelCount++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [cur - 1, cur + 1, cur - w, cur + w];
          for (let ni = 0; ni < 4; ni++) {
            const nIdx = neighbors[ni];
            if (nIdx >= 0 && nIdx < len && closed[nIdx] === 255 && !visited[nIdx]) {
              visited[nIdx] = 1;
              queue.push(nIdx);
            }
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const ar = bw / bh;
        if (bw >= 50 && bw <= 350 && bh >= 15 && bh <= 100 && ar >= 1.8 && ar <= 5.5) {
          candidates.push({
            origX: Math.floor(minX * scale),
            origY: Math.floor(minY * scale),
            origW: Math.floor(bw * scale),
            origH: Math.floor(bh * scale),
            ar,
            pixels: pixelCount
          });
        }
      }
    }
  }

  candidates.sort((a, b) => b.pixels - a.pixels);
  return { candidates, meta };
}

/**
 * Resilient Hierarchical Plate Recognition Pipeline
 */
async function recognizePlate(imageBuffer) {
  // Pass 1: Direct full image OCR (fastest for straight photos, ~400ms)
  try {
    const fullOcr = await tesseract.recognize(imageBuffer, 'eng');
    const fullPlate = extractLicensePlate(fullOcr.data.text);
    if (fullPlate.isValid) {
      return { validation: fullPlate, rawText: fullOcr.data.text, method: 'full' };
    }
  } catch (err) {
    console.warn('Full image OCR pass warning:', err.message);
  }

  // Pass 2: Unrotated candidate search (straight plates with complex backgrounds)
  try {
    const res0 = await findCandidatesOnBuffer(imageBuffer);
    for (const cand of res0.candidates.slice(0, 3)) {
      const padX = Math.floor(cand.origW * 0.12);
      const padY = Math.floor(cand.origH * 0.15);
      const x0 = Math.max(0, cand.origX - padX);
      const y0 = Math.max(0, cand.origY - padY);
      const w0 = Math.min(res0.meta.width - x0, cand.origW + padX * 2);
      const h0 = Math.min(res0.meta.height - y0, cand.origH + padY * 2);

      const crop = await sharp(imageBuffer)
        .extract({ left: x0, top: y0, width: w0, height: h0 })
        .resize(Math.round(w0 * (200 / h0)), 200, { kernel: 'lanczos3' })
        .png()
        .toBuffer();

      const ocr = await tesseract.recognize(crop, 'eng');
      const plate = extractLicensePlate(ocr.data.text);
      if (plate.isValid) {
        return { validation: plate, rawText: ocr.data.text, method: 'candidate_0' };
      }
    }
  } catch (err) {
    console.warn('Pass 2 candidate search warning:', err.message);
  }

  // Pass 3: Multi-Angle Whole-Photo Rotation (for angled, tilted car photos)
  const anglesToTry = [13, -13, 10, -10, 15, -15];
  for (const angle of anglesToTry) {
    try {
      const rotBuffer = await sharp(imageBuffer)
        .rotate(angle, { background: '#ffffff' })
        .toBuffer();

      const rotCands = await findCandidatesOnBuffer(rotBuffer);
      for (const cand of rotCands.candidates.slice(0, 3)) {
        const padX = Math.floor(cand.origW * 0.12);
        const padY = Math.floor(cand.origH * 0.15);
        const x0 = Math.max(0, cand.origX - padX);
        const y0 = Math.max(0, cand.origY - padY);
        const w0 = Math.min(rotCands.meta.width - x0, cand.origW + padX * 2);
        const h0 = Math.min(rotCands.meta.height - y0, cand.origH + padY * 2);

        const crop = await sharp(rotBuffer)
          .extract({ left: x0, top: y0, width: w0, height: h0 })
          .resize(Math.round(w0 * (200 / h0)), 200, { kernel: 'lanczos3' })
          .png()
          .toBuffer();

        const ocr = await tesseract.recognize(crop, 'eng');
        const plate = extractLicensePlate(ocr.data.text);
        if (plate.isValid) {
          return { validation: plate, rawText: ocr.data.text, method: `rot_${angle}` };
        }
      }
    } catch (err) {
      console.warn(`Pass 3 rot_${angle} warning:`, err.message);
    }
  }

  return { validation: { isValid: false, formattedPlate: null, formatType: null }, rawText: '' };
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
      let fileConfirmed = isConfirmed && plateNumber;
      let filePlateNumber = plateNumber;
      let fileFormatType = formatType;
      let fileRawText = rawText;

      // Server-side resilient OCR fallback check if client did not detect plate
      if (!fileConfirmed && file.buffer) {
        try {
          const recResult = await recognizePlate(file.buffer);
          if (recResult.validation && recResult.validation.isValid) {
            filePlateNumber = recResult.validation.formattedPlate;
            fileFormatType = recResult.validation.formatType;
            fileConfirmed = true;
            fileRawText = (fileRawText ? fileRawText + ' | ' : '') + (recResult.rawText || '');
            console.log(`✅ Resilient Server OCR rescued plate: ${filePlateNumber} (${fileFormatType}) via ${recResult.method || 'engine'}`);
          }
        } catch (ocrErr) {
          console.warn('Server fallback OCR error:', ocrErr.message);
        }
      }

      if (!fileConfirmed) {
        results.push({
          filename: fileName,
          status: 'Declined',
          reason: 'No valid license plate detected (Formats: XX-NNN-XX, XX-NNNN, XXX-NNN, NNNN-XX)',
          plate_number: null,
          raw_text: fileRawText
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
          plate_number: filePlateNumber,
          format_type: fileFormatType,
          raw_text: fileRawText,
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
        plate_number: filePlateNumber,
        format_type: fileFormatType,
        raw_text: fileRawText,
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
    version: '2.2.0-multi-angle-ocr',
    firebase_connected: !!db,
    storage_connected: !!bucket,
    timestamp: new Date()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
