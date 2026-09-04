document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const processingBar = document.getElementById('processingBar');
  const processingText = document.getElementById('processingText');
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

  let accumulatedResults = [];
  let totalConfirmed = 0;
  let totalDeclined = 0;

  // Check System Health
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

  // --- Drag and Drop File Handlers ---
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
    accumulatedResults = [];
    totalConfirmed = 0;
    totalDeclined = 0;
    batchStatusTableBody.innerHTML = '';
    uploadsSummaryContainer.classList.add('hidden');
    fileInput.value = '';
  });

  // --- Batch File Upload Processing ---
  async function handleBatchFileUpload(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));

    if (files.length === 0) {
      alert('Please upload valid image files (PNG, JPG, etc.).');
      return;
    }

    // Update UI State
    processingBar.classList.remove('hidden');
    processingText.textContent = `Analyzing ${files.length} image(s) for valid license plates...`;

    const formData = new FormData();
    files.forEach(file => {
      formData.append('images', file);
    });

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      processingBar.classList.add('hidden');
      fileInput.value = ''; // Reset file input so user can re-upload same file if needed

      if (response.ok && result.success) {
        appendUploadSummary(result);
        // Refresh confirmed records database list
        fetchSpottedPlates(searchInput.value.trim());
      } else {
        throw new Error(result.error || 'Failed to process batch upload.');
      }

    } catch (error) {
      console.error('Batch Upload Error:', error);
      processingBar.classList.add('hidden');
      alert(`Upload Error: ${error.message}`);
    }
  }

  // Append Upload Results to Log Table
  function appendUploadSummary(batchResult) {
    uploadsSummaryContainer.classList.remove('hidden');

    totalConfirmed += batchResult.confirmed;
    totalDeclined += batchResult.declined;

    summaryConfirmedCount.textContent = `${totalConfirmed} Confirmed`;
    summaryDeclinedCount.textContent = `${totalDeclined} Declined`;

    batchResult.results.forEach(item => {
      accumulatedResults.unshift(item); // prepend latest

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
        ? `<span style="color: #34d399;">Valid plate format saved to database</span>`
        : `<span style="color: #f87171;">${item.reason || 'Invalid format'}</span>`;

      row.innerHTML = `
        <td><strong>${item.filename}</strong></td>
        <td>${plateCell}</td>
        <td>${formatCell}</td>
        <td>${statusBadge}</td>
        <td>${detailsCell}</td>
      `;

      // Insert at top of status table
      batchStatusTableBody.insertBefore(row, batchStatusTableBody.firstChild);
    });
  }

  // --- Search & Confirmed Records Database List ---
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
