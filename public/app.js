document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const scanPreviewContainer = document.getElementById('scanPreviewContainer');
  const imagePreview = document.getElementById('imagePreview');
  const scanLine = document.getElementById('scanLine');
  const uploadSpinner = document.getElementById('uploadSpinner');
  const statusMsg = document.getElementById('statusMsg');
  const ocrResultBadge = document.getElementById('ocrResultBadge');
  const detectedPlateText = document.getElementById('detectedPlateText');
  const btnResetUpload = document.getElementById('btnResetUpload');

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const btnSearch = document.getElementById('btnSearch');
  const btnRefresh = document.getElementById('btnRefresh');
  const resultsGrid = document.getElementById('resultsGrid');
  const recordsCounter = document.getElementById('recordsCounter');
  const emptyState = document.getElementById('emptyState');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');

  // Check Backend System Health
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

  // --- Upload & File Handling ---

  // Drag and drop event listeners
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
      handleFileUpload(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  // Reset upload form
  btnResetUpload.addEventListener('click', () => {
    fileInput.value = '';
    dropZone.classList.remove('hidden');
    scanPreviewContainer.classList.add('hidden');
    ocrResultBadge.classList.add('hidden');
  });

  async function handleFileUpload(file) {
    if (!file.type.startsWith('image/')) {
      alert('Please upload a valid image file (PNG, JPG, etc.).');
      return;
    }

    // Show image preview
    const reader = new FileReader();
    reader.onload = (e) => {
      imagePreview.src = e.target.result;
    };
    reader.readAsDataURL(file);

    // Update UI State
    dropZone.classList.add('hidden');
    scanPreviewContainer.classList.remove('hidden');
    scanLine.classList.remove('hidden');
    uploadSpinner.classList.remove('hidden');
    ocrResultBadge.classList.add('hidden');
    statusMsg.textContent = 'Uploading photo & performing license plate OCR analysis...';

    // Prepare FormData
    const formData = new FormData();
    formData.append('image', file);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (response.ok && result.success) {
        // Success state
        scanLine.classList.add('hidden');
        uploadSpinner.classList.add('hidden');
        statusMsg.textContent = 'OCR Processing Complete!';

        detectedPlateText.textContent = result.plate_number || 'UNKNOWN';
        ocrResultBadge.classList.remove('hidden');

        // Automatically refresh search list to show new upload
        fetchSpottedPlates(searchInput.value.trim());

      } else {
        throw new Error(result.error || 'Failed to analyze plate.');
      }

    } catch (error) {
      console.error('Upload Error:', error);
      scanLine.classList.add('hidden');
      uploadSpinner.classList.add('hidden');
      statusMsg.textContent = `Error: ${error.message}`;
    }
  }

  // --- Search & Database Fetching ---

  async function fetchSpottedPlates(query = '') {
    try {
      resultsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 2rem;">Loading spotted plates...</div>';
      
      const endpoint = query ? `/api/search/${encodeURIComponent(query)}` : '/api/search';
      const response = await fetch(endpoint);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Search query failed.');
      }

      renderResults(data.results || []);

    } catch (error) {
      console.error('Search error:', error);
      resultsGrid.innerHTML = '';
      emptyState.classList.remove('hidden');
      recordsCounter.textContent = 'Error loading records';
    }
  }

  function renderResults(records) {
    resultsGrid.innerHTML = '';
    recordsCounter.textContent = `${records.length} Record${records.length === 1 ? '' : 's'} Found`;

    if (!records || records.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    records.forEach(item => {
      const card = document.createElement('div');
      card.className = 'plate-card';

      const formattedTime = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Recently spotted';

      card.innerHTML = `
        <div class="plate-card-img-container">
          <img src="${item.image_url}" alt="Spotted Plate ${item.plate_number}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\' fill=\'%236b7280\'><text x=\'50%\' y=\'50%\' dominant-baseline=\'middle\' text-anchor=\'middle\'>No Image</text></svg>'">
        </div>
        <div class="plate-card-body">
          <div class="plate-badge-small">${item.plate_number || 'UNKNOWN'}</div>
          <div class="plate-timestamp">📅 ${formattedTime}</div>
        </div>
      `;

      resultsGrid.appendChild(card);
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

  // Initial fetch on app load
  fetchSpottedPlates();
});
