document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const progressSection = document.getElementById('progressSection');
  const uploadStageBox = document.getElementById('uploadStageBox');
  const fileProgressIndex = document.getElementById('fileProgressIndex');
  const uploadPercentLabel = document.getElementById('uploadPercentLabel');
  const uploadProgressFill = document.getElementById('uploadProgressFill');

  const ocrStageBox = document.getElementById('ocrStageBox');
  const ocrPercentLabel = document.getElementById('ocrPercentLabel');
  const ocrProgressFill = document.getElementById('ocrProgressFill');

  const uploadsSummaryContainer = document.getElementById('uploadsSummaryContainer');
  const batchStatusTableBody = document.getElementById('batchStatusTableBody');
  const summaryConfirmedCount = document.getElementById('summaryConfirmedCount');
  const summaryDeclinedCount = document.getElementById('summaryDeclinedCount');
  const btnUploadMore = document.getElementById('btnUploadMore');
  const btnClearLog = document.getElementById('btnClearLog');

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const btnSearch = document.getElementById('btnSearch');
  const btnRefresh = document.getElementById('btnRefresh');
  const recordsTableBody = document.getElementById('recordsTableBody');
  const recordsCounter = document.getElementById('recordsCounter');
  const emptyState = document.getElementById('emptyState');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');

  let totalConfirmed = 0;
  let totalDeclined = 0;

  // Health check
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.status === 'online') {
        if (data.firebase_connected) {
          statusText.textContent = 'Firebase Connected';
        } else {
          statusText.textContent = 'Local Standalone Mode';
        }
      }
    } catch (err) {
      statusText.textContent = 'Backend Offline';
      statusIndicator.querySelector('.status-dot').style.backgroundColor = '#ef4444';
    }
  }
  checkHealth();

  // --- Drag and Drop Listeners ---
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      processBatchFiles(files);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      processBatchFiles(e.target.files);
    }
  });

  btnUploadMore.addEventListener('click', () => {
    fileInput.click();
  });

  btnClearLog.addEventListener('click', () => {
    totalConfirmed = 0;
    totalDeclined = 0;
    batchStatusTableBody.innerHTML = '';
    uploadsSummaryContainer.classList.add('hidden');
    fileInput.value = '';
  });

  // --- OCR Positional Character Repairs & Format Validation ---
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
   * Resilient License Plate Extractor (Supports 4 Formats)
   * 1) XX-NNN-XX  (e.g. BI-888-DA, AB-123-CD)
   * 2) XX-NNNN    (e.g. AB-1234)
   * 3) XXX-NNN    (e.g. ABC-123)
   * 4) NNNN-XX    (e.g. 1234-AB)
   * Handles country flags (GE, EU, etc.), dashes, spaces, and OCR noise.
   */
  function extractLicensePlate(rawText) {
    if (!rawText) return { isValid: false, formattedPlate: null, formatType: null };

    // 1. Normalize separators
    const normalized = rawText.toUpperCase()
      .replace(/[—–_·•:]+/g, '-')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s*-\s*/g, '-');

    // Strip known country flag prefixes on left (GE, EU, AM, AZ, TR, UA, MD, etc.)
    const cleaned = normalized.replace(/\b(GE|EU|AM|AZ|TR|UA|MD|RO|BG|PL|DE|FR|IT|ES)[-\s]+/gi, '');

    const textsToTry = [cleaned, normalized, rawText.toUpperCase().replace(/[\r\n]+/g, ' ')];

    for (const t of textsToTry) {
      // Format 1: XX-NNN-XX
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

      // Format 2: XX-NNNN
      const m2 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{2})[- ]*([A-Z0-9]{4})(?:$|[^A-Z0-9])/);
      if (m2) {
        let p1 = fixLetters(m2[1]), p2 = fixDigits(m2[2]);
        if (/^[A-Z]{2}$/.test(p1) && /^\d{4}$/.test(p2)) {
          return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XX-NNNN' };
        }
      }

      // Format 3: XXX-NNN
      const m3 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{3})[- ]*([A-Z0-9]{3})(?:$|[^A-Z0-9])/);
      if (m3) {
        let p1 = fixLetters(m3[1]), p2 = fixDigits(m3[2]);
        if (/^[A-Z]{3}$/.test(p1) && /^\d{3}$/.test(p2)) {
          return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'XXX-NNN' };
        }
      }

      // Format 4: NNNN-XX
      const m4 = t.match(/(?:^|[^A-Z0-9])([A-Z0-9]{4})[- ]*([A-Z0-9]{2})(?:$|[^A-Z0-9])/);
      if (m4) {
        let p1 = fixDigits(m4[1]), p2 = fixLetters(m4[2]);
        if (/^\d{4}$/.test(p1) && /^[A-Z]{2}$/.test(p2)) {
          return { isValid: true, formattedPlate: `${p1}-${p2}`, formatType: 'NNNN-XX' };
        }
      }
    }

    // 2. Token-by-token scan with sliding window
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
        // e.g. country prefix + plate (GEBI888DA -> BI888DA)
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

  // --- Canvas Preprocessor with Gentle Grayscale, Rotation & Smart Cropping ---
  function preprocessImageToCanvas(imageElement, mode = 'natural') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const w = imageElement.naturalWidth;
    const h = imageElement.naturalHeight;

    if (mode === 'crop') {
      const srcY = Math.floor(h * 0.35);
      const srcH = Math.floor(h * 0.65);
      canvas.width = w;
      canvas.height = srcH;
      ctx.drawImage(imageElement, 0, srcY, w, srcH, 0, 0, canvas.width, canvas.height);
    } else if (mode === 'rot_13' || mode === 'rot_neg13') {
      const angle = mode === 'rot_13' ? 13 : -13;
      canvas.width = w;
      canvas.height = h;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.drawImage(imageElement, -w / 2, -h / 2);
    } else {
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(imageElement, 0, 0);
    }

    if (mode === 'grayscale') {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const avg = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i] = avg;
        data[i + 1] = avg;
        data[i + 2] = avg;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    return canvas.toDataURL('image/jpeg', 0.95);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // --- Batch File Processing Routine ---
  async function processBatchFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));

    if (files.length === 0) {
      alert('Please select valid image files.');
      return;
    }

    if (files.length > 10) {
      alert('Maximum limit is 10 simultaneous image uploads per batch.');
      return;
    }

    progressSection.classList.remove('hidden');
    uploadStageBox.classList.remove('hidden');
    ocrStageBox.classList.add('hidden');

    const batchResults = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      fileProgressIndex.textContent = `${i + 1}/${files.length}`;
      uploadPercentLabel.textContent = '0%';
      uploadProgressFill.style.width = '0%';
      ocrPercentLabel.textContent = '0%';
      ocrProgressFill.style.width = '0%';

      // STAGE 1: Upload Progress (0% -> 100%)
      await simulateUploadProgress((p) => {
        uploadPercentLabel.textContent = `${p}%`;
        uploadProgressFill.style.width = `${p}%`;
      });

      // STAGE 2: OCR Identification Analysis Progress
      ocrStageBox.classList.remove('hidden');

      let rawText = '';
      let validation = { isValid: false };

      try {
        const loadedImg = await loadImage(file);

        // Smoothly animate Stage 2 OCR progress bar to 100%
        let progressInterval = setInterval(() => {
          let cur = parseInt(ocrPercentLabel.textContent) || 0;
          if (cur < 95) {
            cur += Math.floor(Math.random() * 15) + 5;
            if (cur > 95) cur = 95;
            ocrPercentLabel.textContent = `${cur}%`;
            ocrProgressFill.style.width = `${cur}%`;
          }
        }, 150);

        // Pass 1: Clean Natural Image (Preserves crisp character edges)
        const naturalDataUrl = preprocessImageToCanvas(loadedImg, 'natural');
        const res1 = await Tesseract.recognize(naturalDataUrl, 'eng');
        rawText = res1.data.text || '';
        validation = extractLicensePlate(rawText);

        // Pass 2: Lower Plate Zone Crop (Focuses on vehicle bumper)
        if (!validation.isValid) {
          const croppedDataUrl = preprocessImageToCanvas(loadedImg, 'crop');
          const res2 = await Tesseract.recognize(croppedDataUrl, 'eng');
          const text2 = res2.data.text || '';
          rawText += ' ' + text2;
          validation = extractLicensePlate(text2);
          if (!validation.isValid) {
            validation = extractLicensePlate(rawText);
          }
        }

        // Pass 3: Multi-Angle Perspective Passes (Rotated canvas for angled cars)
        if (!validation.isValid) {
          for (const rotMode of ['rot_13', 'rot_neg13']) {
            const rotDataUrl = preprocessImageToCanvas(loadedImg, rotMode);
            const rotRes = await Tesseract.recognize(rotDataUrl, 'eng');
            const rotText = rotRes.data.text || '';
            rawText += ' ' + rotText;
            validation = extractLicensePlate(rotText);
            if (validation.isValid) break;
            validation = extractLicensePlate(rawText);
            if (validation.isValid) break;
          }
        }

        clearInterval(progressInterval);

      } catch (err) {
        console.error('Client OCR error:', err);
      }

      // Complete Stage 2 at 100%
      ocrPercentLabel.textContent = '100%';
      ocrProgressFill.style.width = '100%';

      // Send to server
      const serverResponse = await uploadFileToServer(file, validation, rawText);
      batchResults.push(serverResponse);

      await new Promise(r => setTimeout(r, 300));
    }

    progressSection.classList.add('hidden');
    fileInput.value = '';
    appendUploadSummary(batchResults);
    fetchSpottedPlates(searchInput.value.trim());
  }

  function simulateUploadProgress(onProgress) {
    return new Promise((resolve) => {
      let current = 0;
      const interval = setInterval(() => {
        current += 25;
        if (current >= 100) {
          current = 100;
          onProgress(100);
          clearInterval(interval);
          resolve();
        } else {
          onProgress(current);
        }
      }, 80);
    });
  }

  async function uploadFileToServer(file, validation, rawText) {
    const formData = new FormData();
    formData.append('images', file);
    formData.append('plate_number', validation.formattedPlate || '');
    formData.append('format_type', validation.formatType || '');
    formData.append('status', validation.isValid ? 'Confirmed' : 'Declined');
    formData.append('raw_text', rawText);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        return data.results[0];
      }
    } catch (e) {
      console.error('Server upload error:', e);
    }

    return {
      filename: file.name,
      status: validation.isValid ? 'Confirmed' : 'Declined',
      reason: validation.isValid ? 'Saved' : 'No valid plate detected (XX-NNN-XX, XX-NNNN, XXX-NNN, NNNN-XX)',
      plate_number: validation.formattedPlate
    };
  }

  function appendUploadSummary(results) {
    uploadsSummaryContainer.classList.remove('hidden');

    results.forEach(item => {
      const isConfirmed = item.status === 'Confirmed';
      if (isConfirmed) totalConfirmed++; else totalDeclined++;

      const row = document.createElement('tr');

      const statusBadge = isConfirmed
        ? `<span class="badge-confirmed">✓ Confirmed</span>`
        : `<span class="badge-declined">✕ Declined</span>`;

      const plateCell = isConfirmed
        ? `<span class="plate-mono">${item.plate_number}</span>`
        : `<span style="color: var(--text-dim); font-style: italic;">None detected</span>`;

      const formatCell = item.format_type
        ? `<span class="format-tag">${item.format_type}</span>`
        : `<span style="color: var(--text-dim);">-</span>`;

      const detailsCell = isConfirmed
        ? `<span style="color: #34d399;">Valid license plate format saved</span>`
        : `<span style="color: #f87171;">${item.reason || 'Invalid format'}</span>`;

      row.innerHTML = `
        <td><strong>${item.filename}</strong></td>
        <td>${plateCell}</td>
        <td>${formatCell}</td>
        <td>${statusBadge}</td>
        <td>${detailsCell}</td>
      `;

      batchStatusTableBody.insertBefore(row, batchStatusTableBody.firstChild);
    });

    summaryConfirmedCount.textContent = `${totalConfirmed} Confirmed`;
    summaryDeclinedCount.textContent = `${totalDeclined} Declined`;
  }

  // --- Search & Database List ---
  async function fetchSpottedPlates(query = '') {
    try {
      recordsTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading records...</td></tr>';
      
      const endpoint = query ? `/api/search/${encodeURIComponent(query)}` : '/api/search';
      const response = await fetch(endpoint);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Search query failed.');
      }

      renderConfirmedRecords(data.results || []);

    } catch (error) {
      console.error('Search error:', error);
      recordsTableBody.innerHTML = '';
      emptyState.classList.remove('hidden');
      recordsCounter.textContent = 'Error loading records';
    }
  }

  function renderConfirmedRecords(records) {
    recordsTableBody.innerHTML = '';
    recordsCounter.textContent = `${records.length} Confirmed Record${records.length === 1 ? '' : 's'}`;

    if (!records || records.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    records.forEach(item => {
      const row = document.createElement('tr');
      const formattedTime = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Recently spotted';

      row.innerHTML = `
        <td><span class="plate-mono">${item.plate_number || 'UNKNOWN'}</span></td>
        <td><span class="format-tag">${item.format_type || 'STANDARD'}</span></td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">📅 ${formattedTime}</td>
        <td><span class="badge-confirmed">✓ Confirmed</span></td>
      `;

      recordsTableBody.appendChild(row);
    });
  }

  // Search Input Listeners
  btnSearch.addEventListener('click', () => {
    fetchSpottedPlates(searchInput.value.trim());
  });

  btnRefresh.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    fetchSpottedPlates();
  });

  searchInput.addEventListener('keyup', (e) => {
    if (searchInput.value.trim().length > 0) {
      clearSearchBtn.classList.remove('hidden');
    } else {
      clearSearchBtn.classList.add('hidden');
    }

    if (e.key === 'Enter') {
      fetchSpottedPlates(searchInput.value.trim());
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    fetchSpottedPlates();
  });

  // Initial load
  fetchSpottedPlates();
});
