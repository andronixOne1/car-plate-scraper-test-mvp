const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const tesseract = require('tesseract.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Ensure public/uploads directory exists for permanent local serving
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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

function extractLicensePlates(rawText) {
  if (!rawText) return { isValid: false, plates: [], formattedPlate: null, formatType: null };

  const preprocessed = rawText.toUpperCase()
    .replace(/[|]/g, 'I')
    .replace(/[\r\n]+/g, ' ');

  const normalized = preprocessed
    .replace(/[—–_·•:]+/g, '-')
    .replace(/\s*-\s*/g, '-');

  const squashed = normalized.replace(/\s+/g, '');
  const cleaned = normalized.replace(/\b(GE|EU|AM|AZ|TR|UA|MD|RO|BG|PL|DE|FR|IT|ES)[-\s]+/gi, '');
  const textsToTry = [cleaned, normalized, squashed, preprocessed];

  const foundMap = new Map();

  function addPlate(p1, p2, p3, formatType) {
    if (formatType === 'XX-NNN-XX') {
      let l1 = fixLetters(p1), d2 = fixDigits(p2), l3 = fixLetters(p3);
      if ((l1.startsWith('U') || l1.startsWith('Y')) && /^[A-Z]{2}$/.test(l1)) {
        l1 = 'V' + l1.slice(1);
      }
      if (l1 === 'VI') l1 = 'VL'; // Slanted Georgian VL series repair
      if (/^[A-Z]{2}$/.test(l1) && /^\d{3}$/.test(d2) && /^[A-Z]{2}$/.test(l3)) {
        foundMap.set(`${l1}-${d2}-${l3}`, 'XX-NNN-XX');
      }
    } else if (formatType === 'XX-NNNN') {
      let l1 = fixLetters(p1), d2 = fixDigits(p2);
      if (/^[A-Z]{2}$/.test(l1) && /^\d{4}$/.test(d2)) {
        foundMap.set(`${l1}-${d2}`, 'XX-NNNN');
      }
    } else if (formatType === 'XXX-NNN') {
      let l1 = fixLetters(p1), d2 = fixDigits(p2);
      if (/^[A-Z]{3}$/.test(l1) && /^\d{3}$/.test(d2)) {
        foundMap.set(`${l1}-${d2}`, 'XXX-NNN');
      }
    } else if (formatType === 'NNNN-XX') {
      let d1 = fixDigits(p1), l2 = fixLetters(p2);
      if (/^\d{4}$/.test(d1) && /^[A-Z]{2}$/.test(l2)) {
        foundMap.set(`${d1}-${l2}`, 'NNNN-XX');
      }
    }
  }

  for (const t of textsToTry) {
    // Format 1: XX-NNN-XX (standard Georgian plate)
    const regex1 = /(?:^|[^A-Z0-9])([A-Z0-9]{2,4})[-—–_·•:\s]*([0-9OQILZSB]{3})[-—–_·•:\s]*([A-Z0-9]{2})(?:$|[^A-Z0-9])/gi;
    for (const m of t.matchAll(regex1)) {
      const rawPrefix = m[1];
      const p1 = rawPrefix.length > 2 ? rawPrefix.slice(-2) : rawPrefix;
      addPlate(p1, m[2], m[3], 'XX-NNN-XX');
    }

    // Format 2: XX-NNNN
    const regex2 = /(?:^|[^A-Z0-9])([A-Z0-9]{2})[- ]*([A-Z0-9]{4})(?:$|[^A-Z0-9])/g;
    for (const m of t.matchAll(regex2)) {
      addPlate(m[1], m[2], null, 'XX-NNNN');
    }

    // Format 3: XXX-NNN
    const regex3 = /(?:^|[^A-Z0-9])([A-Z0-9]{3})[- ]*([A-Z0-9]{3})(?:$|[^A-Z0-9])/g;
    for (const m of t.matchAll(regex3)) {
      addPlate(m[1], m[2], null, 'XXX-NNN');
    }

    // Format 4: NNNN-XX
    const regex4 = /(?:^|[^A-Z0-9])([A-Z0-9]{4})[- ]*([A-Z0-9]{2})(?:$|[^A-Z0-9])/g;
    for (const m of t.matchAll(regex4)) {
      addPlate(m[1], m[2], null, 'NNNN-XX');
    }
  }

  const tokens = normalized.match(/[A-Z0-9]{6,12}/g) || [];
  for (const token of tokens) {
    if (token.length === 7) {
      addPlate(token.slice(0, 2), token.slice(2, 5), token.slice(5, 7), 'XX-NNN-XX');
    }
    if (token.length === 9) {
      const sub = token.slice(2);
      addPlate(sub.slice(0, 2), sub.slice(2, 5), sub.slice(5, 7), 'XX-NNN-XX');
    }
    if (token.length === 6) {
      addPlate(token.slice(0, 2), token.slice(2, 6), null, 'XX-NNNN');
    }
  }

  let rawPlates = Array.from(foundMap.entries()).map(([formattedPlate, formatType]) => ({
    formattedPlate,
    formatType
  }));

  const fullPlates = rawPlates.filter(p => p.formatType === 'XX-NNN-XX').map(p => p.formattedPlate);
  if (fullPlates.length > 0) {
    rawPlates = rawPlates.filter(p => {
      if (p.formatType === 'XX-NNN-XX') return true;
      for (const full of fullPlates) {
        const fullDigits = full.split('-')[1];
        if (p.formattedPlate.includes(fullDigits)) return false;
      }
      return true;
    });

    const xxPlates = rawPlates.filter(p => p.formatType === 'XX-NNN-XX');
    const prunedPlates = [];
    for (const p of xxPlates) {
      const [l1, d2, l3] = p.formattedPlate.split('-');
      const duplicate = xxPlates.find(other => {
        if (other.formattedPlate === p.formattedPlate) return false;
        const [ol1, od2, ol3] = other.formattedPlate.split('-');
        return ol1 === l1 && ol3 === l3;
      });
      if (duplicate) {
        const [dl1, dd2, dl3] = duplicate.formattedPlate.split('-');
        const isThisRepeated = d2[0] === d2[1] && d2[1] === d2[2];
        const isOtherRepeated = dd2[0] === dd2[1] && dd2[1] === dd2[2];
        if (isOtherRepeated && !isThisRepeated) continue;
      }
      prunedPlates.push(p);
    }
    rawPlates = prunedPlates.concat(rawPlates.filter(p => p.formatType !== 'XX-NNN-XX'));
  }

  return {
    isValid: rawPlates.length > 0,
    plates: rawPlates,
    formattedPlate: rawPlates.length > 0 ? rawPlates.map(p => p.formattedPlate).join(', ') : null,
    formatType: rawPlates.length > 0 ? rawPlates[0].formatType : null
  };
}

function extractLicensePlate(rawText) {
  const res = extractLicensePlates(rawText);
  return {
    isValid: res.isValid,
    formattedPlate: res.formattedPlate,
    formatType: res.formatType,
    plates: res.plates
  };
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
  const startY = Math.floor(h * 0.20);
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
        if (bw >= 40 && bw <= 400 && bh >= 12 && bh <= 120 && ar >= 1.7 && ar <= 7.2) {
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
 * Resilient Multi-Plate Recognition Pipeline
 */
async function recognizePlate(imageBuffer) {
  const foundMap = new Map();
  let accumulatedText = '';

  // Pass 1: Direct full image OCR (fast for straight single-car photos)
  try {
    const fullOcr = await tesseract.recognize(imageBuffer, 'eng');
    const fullText = fullOcr.data.text || '';
    accumulatedText += fullText;
    const parsed = extractLicensePlates(fullText);
    for (const p of parsed.plates) foundMap.set(p.formattedPlate, p.formatType);
  } catch (err) {
    console.warn('Pass 1 full OCR warning:', err.message);
  }

  // Pass 2: Candidate Localization & Per-Candidate Local Deskewing
  try {
    const res0 = await findCandidatesOnBuffer(imageBuffer);
    for (let ci = 0; ci < Math.min(5, res0.candidates.length); ci++) {
      const cand = res0.candidates[ci];
      let candFound = false;

      // 2a: Test straight crops (angle 0)
      for (const padY of [0, Math.max(2, Math.floor(cand.origH * 0.05))]) {
        const padX = Math.max(12, Math.floor(cand.origW * 0.08));
        const x0 = Math.max(0, cand.origX - padX);
        const y0 = Math.max(0, cand.origY - padY);
        const w0 = Math.min(res0.meta.width - x0, cand.origW + padX * 2);
        const h0 = Math.min(res0.meta.height - y0, cand.origH + padY * 2);

        const crop = await sharp(imageBuffer)
          .extract({ left: x0, top: y0, width: w0, height: h0 })
          .resize(Math.round(w0 * (200 / h0)), 200, { kernel: 'lanczos3' })
          .extend({ top: 15, bottom: 15, left: 15, right: 15, background: '#ffffff' })
          .png()
          .toBuffer();

        const ocr = await tesseract.recognize(crop, 'eng');
        const text = ocr.data.text || '';
        accumulatedText += ' ' + text;
        const parsed = extractLicensePlates(text);
        if (parsed.plates.some(p => p.formatType === 'XX-NNN-XX')) {
          for (const p of parsed.plates) foundMap.set(p.formattedPlate, p.formatType);
          candFound = true;
          break;
        }
      }

      // 2b: If straight crop did not yield a valid XX-NNN-XX plate, deskew locally around this vehicle
      if (!candFound) {
        const mx = Math.min(cand.origX, Math.floor(cand.origW * 0.80));
        const my = Math.min(cand.origY, Math.floor(cand.origH * 1.20));
        const subX = Math.max(0, cand.origX - mx);
        const subY = Math.max(0, cand.origY - my);
        const subW = Math.min(res0.meta.width - subX, cand.origW + mx * 2);
        const subH = Math.min(res0.meta.height - subY, cand.origH + my * 2);

        const subregion = await sharp(imageBuffer)
          .extract({ left: subX, top: subY, width: subW, height: subH })
          .toBuffer();

        for (const angle of [13, -13, 10, -10, 12, 14]) {
          const rotSub = await sharp(subregion)
            .rotate(angle, { background: '#ffffff' })
            .toBuffer();

          const subCands = await findCandidatesOnBuffer(rotSub);
          for (let sci = 0; sci < Math.min(2, subCands.candidates.length); sci++) {
            const sc = subCands.candidates[sci];
            const spadX = 25;
            const spadY = 5;
            const sx0 = Math.max(0, sc.origX - spadX);
            const sy0 = Math.max(0, sc.origY - spadY);
            const sw0 = Math.min(subCands.meta.width - sx0, sc.origW + spadX * 2);
            const sh0 = Math.min(subCands.meta.height - sy0, sc.origH + spadY * 2);

            for (const hFactor of [0.70, 1.0]) {
              const curH = Math.max(10, Math.round(sh0 * hFactor));
              const sCrop = await sharp(rotSub)
                .extract({ left: sx0, top: sy0, width: sw0, height: curH })
                .resize(Math.round(sw0 * (200 / curH)), 200, { kernel: 'lanczos3' })
                .png()
                .toBuffer();

              const sOcr = await tesseract.recognize(sCrop, 'eng');
              const sText = sOcr.data.text || '';
              accumulatedText += ' ' + sText;
              const sParsed = extractLicensePlates(sText);
              if (sParsed.plates.some(p => p.formatType === 'XX-NNN-XX')) {
                for (const p of sParsed.plates) foundMap.set(p.formattedPlate, p.formatType);
                candFound = true;
                break;
              }
            }
            if (candFound) break;
          }
          if (candFound) break;
        }
      }
    }
  } catch (err) {
    console.warn('Pass 2 candidate search warning:', err.message);
  }

  // Pass 3: Fallback whole-image rotation if no plates detected yet
  if (foundMap.size === 0) {
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
          const text = ocr.data.text || '';
          accumulatedText += ' ' + text;
          const parsed = extractLicensePlates(text);
          if (parsed.plates.length > 0) {
            for (const p of parsed.plates) foundMap.set(p.formattedPlate, p.formatType);
            break;
          }
        }
        if (foundMap.size > 0) break;
      } catch (err) {
        console.warn(`Pass 3 rot_${angle} warning:`, err.message);
      }
    }
  }

  // Deduplicate and filter from foundMap
  let rawPlates = Array.from(foundMap.entries()).map(([formattedPlate, formatType]) => ({
    formattedPlate,
    formatType
  }));

  const fullPlates = rawPlates.filter(p => p.formatType === 'XX-NNN-XX').map(p => p.formattedPlate);
  if (fullPlates.length > 0) {
    rawPlates = rawPlates.filter(p => {
      if (p.formatType === 'XX-NNN-XX') return true;
      for (const full of fullPlates) {
        const fullDigits = full.split('-')[1];
        if (p.formattedPlate.includes(fullDigits)) return false;
      }
      return true;
    });

    const xxPlates = rawPlates.filter(p => p.formatType === 'XX-NNN-XX');
    const prunedPlates = [];
    for (const p of xxPlates) {
      const [l1, d2, l3] = p.formattedPlate.split('-');
      const duplicate = xxPlates.find(other => {
        if (other.formattedPlate === p.formattedPlate) return false;
        const [ol1, od2, ol3] = other.formattedPlate.split('-');
        return ol1 === l1 && ol3 === l3;
      });
      if (duplicate) {
        const [dl1, dd2, dl3] = duplicate.formattedPlate.split('-');
        const isThisRepeated = d2[0] === d2[1] && d2[1] === d2[2];
        const isOtherRepeated = dd2[0] === dd2[1] && dd2[1] === dd2[2];
        if (isOtherRepeated && !isThisRepeated) continue;
      }
      prunedPlates.push(p);
    }
    rawPlates = prunedPlates.concat(rawPlates.filter(p => p.formatType !== 'XX-NNN-XX'));
  }

  return {
    isValid: rawPlates.length > 0,
    plates: rawPlates,
    formattedPlate: rawPlates.map(p => p.formattedPlate).join(', '),
    formatType: rawPlates.length > 0 ? rawPlates[0].formatType : null,
    validation: {
      isValid: rawPlates.length > 0,
      plates: rawPlates,
      formattedPlate: rawPlates.map(p => p.formattedPlate).join(', '),
      formatType: rawPlates.length > 0 ? rawPlates[0].formatType : null
    },
    rawText: accumulatedText
  };
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
      let confirmedPlates = [];
      let fileRawText = rawText;

      // Compute image SHA-256 hash for photo deduplication
      const imageHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

      // Generate optimized compressed web image for fast UI rendering
      let imageUrl = '';
      try {
        const webImageBuf = await sharp(file.buffer)
          .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toBuffer();

        const localFileName = `photo_${imageHash.slice(0, 16)}.jpg`;
        const localFilePath = path.join(uploadsDir, localFileName);
        if (!fs.existsSync(localFilePath)) {
          fs.writeFileSync(localFilePath, webImageBuf);
        }

        // Store embedded base64 (30-40KB) for 100% permanent persistence across cloud container restarts
        imageUrl = `data:image/jpeg;base64,${webImageBuf.toString('base64')}`;
      } catch (imgErr) {
        console.warn('Image compression warning:', imgErr.message);
      }

      // Check if client provided plate(s)
      if (initialPlateNumber) {
        const clientParsed = extractLicensePlates(initialPlateNumber);
        if (clientParsed.isValid) {
          confirmedPlates = clientParsed.plates;
        } else {
          confirmedPlates.push({
            formattedPlate: initialPlateNumber,
            formatType: initialFormatType || 'XX-NNN-XX'
          });
        }
      }

      // Always run server-side recognition if client didn't find plates OR to discover multiple plates
      if (file.buffer) {
        try {
          const recResult = await recognizePlate(file.buffer);
          if (recResult && recResult.isValid && recResult.plates.length > 0) {
            for (const sp of recResult.plates) {
              if (!confirmedPlates.some(cp => cp.formattedPlate === sp.formattedPlate)) {
                confirmedPlates.push(sp);
              }
            }
            fileRawText = (fileRawText ? fileRawText + ' | ' : '') + (recResult.rawText || '');
            console.log(`✅ Multi-Plate Engine detected ${confirmedPlates.length} plate(s): ${confirmedPlates.map(p => p.formattedPlate).join(', ')}`);
          }
        } catch (ocrErr) {
          console.warn('Server multi-plate OCR error:', ocrErr.message);
        }
      }

      if (confirmedPlates.length === 0) {
        results.push({
          filename: fileName,
          status: 'Declined',
          reason: 'No valid license plate detected (Formats: XX-NNN-XX, XX-NNNN, XXX-NNN, NNNN-XX)',
          plate_number: null,
          image_url: imageUrl,
          raw_text: fileRawText
        });
        continue;
      }

      const timestamp = new Date().toISOString();
      const savedDocIds = [];

      // Save EACH detected license plate as an independent sighting in Firestore with photo-level deduplication
      for (const plateObj of confirmedPlates) {
        let docId = 'temp-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
        if (db) {
          try {
            // Check if THIS EXACT PHOTO was already registered for this plate (photo deduplication)
            const existingSnapshot = await db.collection('spotted_plates')
              .where('plate_number', '==', plateObj.formattedPlate)
              .where('image_hash', '==', imageHash)
              .limit(1)
              .get();

            if (!existingSnapshot.empty) {
              docId = existingSnapshot.docs[0].id;
              console.log(`ℹ️ Duplicate photo upload skipped for plate ${plateObj.formattedPlate} (hash: ${imageHash.slice(0, 8)})`);
            } else {
              const docRef = await db.collection('spotted_plates').add({
                plate_number: plateObj.formattedPlate,
                format_type: plateObj.formatType,
                image_hash: imageHash,
                image_url: imageUrl,
                raw_text: fileRawText,
                filename: fileName,
                status: 'Confirmed',
                created_at: timestamp,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
              });
              docId = docRef.id;
              console.log(`📸 New photo sighting registered for plate ${plateObj.formattedPlate} (doc: ${docId})`);
            }
          } catch (dbErr) {
            console.error('Firestore save error:', dbErr.message);
          }
        }
        savedDocIds.push(docId);
      }

      results.push({
        filename: fileName,
        status: 'Confirmed',
        id: savedDocIds[0] || 'temp-' + Date.now(),
        doc_ids: savedDocIds,
        plates: confirmedPlates,
        plate_number: confirmedPlates.map(p => p.formattedPlate).join(', '),
        format_type: confirmedPlates.map(p => p.formatType).join(', '),
        raw_text: fileRawText,
        image_url: imageUrl,
        timestamp: timestamp
      });
    }

    const confirmedPlatesCount = results
      .filter(r => r.status === 'Confirmed')
      .reduce((acc, r) => acc + (r.plates ? r.plates.length : 1), 0);
    const declinedCount = results.filter(r => r.status === 'Declined').length;

    return res.status(200).json({
      success: true,
      total: results.length,
      confirmed: confirmedPlatesCount,
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
    const rawQuery = req.params.plate ? req.params.plate.toUpperCase().trim() : '';
    const queryClean = rawQuery.replace(/[-—–_\s]/g, '');

    if (!db) {
      return res.status(200).json({
        success: true,
        query: rawQuery,
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
        filename: data.filename || 'vehicle_photo.jpg',
        image_url: data.image_url || '',
        timestamp: data.created_at || (data.timestamp ? data.timestamp.toDate().toISOString() : new Date().toISOString())
      });
    });

    if (rawQuery) {
      results = results.filter(item => {
        const itemPlate = (item.plate_number || '').toUpperCase();
        const itemClean = itemPlate.replace(/[-—–_\s]/g, '');
        return itemPlate.includes(rawQuery) || rawQuery.includes(itemPlate) ||
               (queryClean && itemClean.includes(queryClean)) || (queryClean && queryClean.includes(itemClean));
      });
    }

    return res.status(200).json({
      success: true,
      query: rawQuery,
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
    version: '2.4.0-photo-gallery-dedup',
    firebase_connected: !!db,
    storage_connected: !!bucket,
    timestamp: new Date()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
