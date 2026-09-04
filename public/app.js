document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const progressSection = document.getElementById('progressSection');
  const uploadStageBox = document.getElementById('uploadStageBox');
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

  // Check Health
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

  // --- Drag & Drop Listeners ---
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
      handleBatchFileUpload(files);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleBatchFileUpload(e.target.files);
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

  // --- Batch Upload with Sequential Progress Bars ---
  function handleBatchFileUpload(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));

    if (files.length === 0) {
      alert('Please select valid image files.');
      return;
    }

    if (files.length > 10) {
      alert('Maximum limit is 10 simultaneous image uploads per batch.');
      return;
    }

    // Reset Progress Bars
    progressSection.classList.remove('hidden');
    uploadStageBox.classList.remove('hidden');
    ocrStageBox.classList.add('hidden');

    uploadPercentLabel.textContent = '0%';
    uploadProgressFill.style.width = '0%';
    ocrPercentLabel.textContent = '0%';
    ocrProgressFill.style.width = '0%';

    const formData = new FormData();
    files.forEach(file => {
      formData.append('images', file);
    });

    const xhr = new XMLHttpRequest();

    // Stage 1: Track Network Upload Transfer Progress
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        uploadPercentLabel.textContent = `${percent}%`;
        uploadProgressFill.style.width = `${percent}%`;

        // When Upload finishes, transition to Stage 2 (OCR Identification Progress)
        if (percent >= 100) {
          setTimeout(() => {
            ocrStageBox.classList.remove('hidden');
            startOcrProgressAnimation();
          }, 300);
        }
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        try {
          const result = JSON.parse(xhr.responseText);
          finishOcrProgressAnimation(() => {
            progressSection.classList.add('hidden');
            fileInput.value = '';
            appendUploadSummary(result);
            fetchSpottedPlates(searchInput.value.trim());
          });
        } catch (err) {
          progressSection.classList.add('hidden');
          alert('Failed to parse server response.');
        }
      } else {
        progressSection.classList.add('hidden');
        alert(`Server Error ${xhr.status}: Failed to process upload.`);
      }
    });

    xhr.addEventListener('error', () => {
      progressSection.classList.add('hidden');
      alert('Network upload failed. Please check your connection.');
    });

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  }

  // Simulated AI/OCR Progress Animation for Stage 2
  let ocrInterval = null;
  let ocrCurrentPercent = 0;

  function startOcrProgressAnimation() {
    ocrCurrentPercent = 5;
    ocrPercentLabel.textContent = '5%';
    ocrProgressFill.style.width = '5%';

    if (ocrInterval) clearInterval(ocrInterval);

    ocrInterval = setInterval(() => {
      if (ocrCurrentPercent < 90) {
        ocrCurrentPercent += Math.floor(Math.random() * 8) + 3;
        if (ocrCurrentPercent > 90) ocrCurrentPercent = 90;
        ocrPercentLabel.textContent = `${ocrCurrentPercent}%`;
        ocrProgressFill.style.width = `${ocrCurrentPercent}%`;
      }
    }, 400);
  }

  function finishOcrProgressAnimation(callback) {
    if (ocrInterval) clearInterval(ocrInterval);
    ocrPercentLabel.textContent = '100%';
    ocrProgressFill.style.width = '100%';
    setTimeout(callback, 500);
  }

  // Append Upload Results to Log Table
  function appendUploadSummary(batchResult) {
    uploadsSummaryContainer.classList.remove('hidden');

    totalConfirmed += batchResult.confirmed;
    totalDeclined += batchResult.declined;

    summaryConfirmedCount.textContent = `${totalConfirmed} Confirmed`;
    summaryDeclinedCount.textContent = `${totalDeclined} Declined`;

    batchResult.results.forEach(item => {
      const row = document.createElement('tr');

      const isConfirmed = item.status === 'Confirmed';
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
        ? `<span style="color: #34d399;">Valid license plate format saved to database</span>`
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
