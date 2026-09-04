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
   * Resilient License Plate Extractor (Supports 4 Formats & Multi-Plate Detection)
   * 1) XX-NNN-XX  (e.g. BI-888-DA, AB-123-CD)
   * 2) XX-NNNN    (e.g. AB-1234)
   * 3) XXX-NNN    (e.g. ABC-123)
   * 4) NNNN-XX    (e.g. 1234-AB)
   */
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
        if (l1 === 'VI') l1 = 'VL';
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
      // Format 1: XX-NNN-XX
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

  // Photo Modal Elements
  const photoModalOverlay = document.getElementById('photoModalOverlay');
  const modalPlateBadge = document.getElementById('modalPlateBadge');
  const modalFormatTag = document.getElementById('modalFormatTag');
  const modalPhotoImg = document.getElementById('modalPhotoImg');
  const modalTimestamp = document.getElementById('modalTimestamp');
  const modalCloseBtn = document.getElementById('modalCloseBtn');

  window.openPhotoModal = function(imageUrl, plate, format, time) {
    if (!imageUrl) return;
    modalPlateBadge.textContent = plate || 'RECOGNIZED PLATE';
    modalFormatTag.textContent = format || 'STANDARD';
    modalPhotoImg.src = imageUrl;
    modalTimestamp.textContent = `📅 Sighting Recorded: ${time || 'Recently'}`;
    photoModalOverlay.classList.remove('hidden');
  };

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      photoModalOverlay.classList.add('hidden');
    });
  }

  if (photoModalOverlay) {
    photoModalOverlay.addEventListener('click', (e) => {
      if (e.target === photoModalOverlay) {
        photoModalOverlay.classList.add('hidden');
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && photoModalOverlay && !photoModalOverlay.classList.contains('hidden')) {
      photoModalOverlay.classList.add('hidden');
    }
  });

  // --- Real Network Upload with Progress ---
  function uploadSingleFileWithProgress(file) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('images', file);

      // Track Stage 1 Upload Progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = Math.min(99, Math.round((e.loaded / e.total) * 100));
          uploadPercentLabel.textContent = `${percent}%`;
          uploadProgressFill.style.width = `${percent}%`;
        }
      });

      xhr.upload.addEventListener('load', () => {
        uploadPercentLabel.textContent = '100%';
        uploadProgressFill.style.width = '100%';
        // Trigger Stage 2 Server AI Analysis
        ocrStageBox.classList.remove('hidden');
        ocrPercentLabel.textContent = 'Analyzing...';
        ocrProgressFill.style.width = '70%';
      });

      xhr.addEventListener('load', () => {
        ocrPercentLabel.textContent = '100%';
        ocrProgressFill.style.width = '100%';
        try {
          const json = JSON.parse(xhr.responseText);
          if (json.results && json.results.length > 0) {
            resolve(json.results[0]);
          } else {
            resolve({
              filename: file.name,
              status: 'Declined',
              reason: json.error || 'No valid license plate detected',
              plate_number: null
            });
          }
        } catch (err) {
          resolve({
            filename: file.name,
            status: 'Declined',
            reason: 'Server response parsing error',
            plate_number: null
          });
        }
      });

      xhr.addEventListener('error', () => {
        resolve({
          filename: file.name,
          status: 'Declined',
          reason: 'Network upload error',
          plate_number: null
        });
      });

      xhr.addEventListener('abort', () => {
        resolve({
          filename: file.name,
          status: 'Declined',
          reason: 'Upload cancelled',
          plate_number: null
        });
      });

      xhr.open('POST', '/api/upload');
      xhr.send(formData);
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

      const serverResult = await uploadSingleFileWithProgress(file);
      batchResults.push(serverResult);

      // Instantly append to upload log
      appendUploadSummary([serverResult]);
      await new Promise(r => setTimeout(r, 200));
    }

    progressSection.classList.add('hidden');
    fileInput.value = '';
    fetchSpottedPlates(searchInput.value.trim());
  }

  function appendUploadSummary(results) {
    uploadsSummaryContainer.classList.remove('hidden');

    results.forEach(item => {
      const isConfirmed = item.status === 'Confirmed';
      const hasMultiplePlates = isConfirmed && item.plates && item.plates.length > 1;

      if (isConfirmed) {
        totalConfirmed += hasMultiplePlates ? item.plates.length : 1;
      } else {
        totalDeclined++;
      }

      const row = document.createElement('tr');

      const statusBadge = isConfirmed
        ? `<span class="badge-confirmed">✓ Confirmed</span>`
        : `<span class="badge-declined">✕ Declined</span>`;

      let plateCell;
      if (!isConfirmed) {
        plateCell = `<span style="color: var(--text-dim); font-style: italic;">None detected</span>`;
      } else if (hasMultiplePlates) {
        plateCell = item.plates.map(p => `<span class="plate-mono" style="margin: 2px 4px 2px 0; display: inline-block;">${p.formattedPlate}</span>`).join('');
      } else {
        plateCell = `<span class="plate-mono">${item.plate_number}</span>`;
      }

      let formatCell;
      if (!isConfirmed) {
        formatCell = `<span style="color: var(--text-dim);">-</span>`;
      } else if (hasMultiplePlates) {
        formatCell = item.plates.map(p => `<span class="format-tag" style="margin: 2px 4px 2px 0; display: inline-block;">${p.formatType}</span>`).join('');
      } else {
        formatCell = item.format_type ? `<span class="format-tag">${item.format_type}</span>` : `<span style="color: var(--text-dim);">-</span>`;
      }

      const detailsCell = isConfirmed
        ? `<span style="color: #34d399;">${hasMultiplePlates ? `${item.plates.length} license plates registered` : 'Valid license plate format saved'}</span>`
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
      recordsTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading records...</td></tr>';
      
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
      const safeImgUrl = item.image_url ? item.image_url.replace(/'/g, "\\'") : '';
      const safePlate = (item.plate_number || '').replace(/'/g, "\\'");
      const safeFormat = (item.format_type || '').replace(/'/g, "\\'");
      const safeTime = formattedTime.replace(/'/g, "\\'");

      const thumbnailHtml = item.image_url
        ? `<div class="record-thumbnail-wrapper" onclick="openPhotoModal('${safeImgUrl}', '${safePlate}', '${safeFormat}', '${safeTime}')" title="Click to view photo">
             <img src="${item.image_url}" class="record-thumbnail" alt="${item.plate_number || 'Sighting'}">
           </div>`
        : `<div class="record-thumbnail-wrapper"><span class="thumbnail-placeholder">📷</span></div>`;

      row.innerHTML = `
        <td style="text-align: center;">${thumbnailHtml}</td>
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
