let referenceImage = null;
let searchImages = [];

// DOM Elements
const referenceInput = document.getElementById('referenceImage');
const searchInput = document.getElementById('searchImages');
const referencePreview = document.getElementById('referencePreview');
const searchPreview = document.getElementById('searchPreview');
const searchButton = document.getElementById('searchButton');
const progressBar = document.getElementById('progressBar');
const resultsSection = document.getElementById('resultsSection');
const resultsContainer = document.getElementById('resultsContainer');

// Event Listeners
referenceInput.addEventListener('change', handleReferenceUpload);
searchInput.addEventListener('change', handleSearchImagesUpload);
searchButton.addEventListener('click', performSearch);

// Handle reference image upload
function handleReferenceUpload(event) {
    const file = event.target.files[0];
    if (file) {
        referenceImage = file;
        displayReferencePreview(file);
        updateSearchButton();
    }
}

// Handle search images upload
function handleSearchImagesUpload(event) {
    const files = Array.from(event.target.files);
    searchImages = [...searchImages, ...files];
    displaySearchPreviews();
    updateSearchButton();
}

// Display reference image preview
function displayReferencePreview(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        referencePreview.innerHTML = `
            <div class="preview-item">
                <img src="${e.target.result}" alt="Reference face">
                <button class="remove-btn" onclick="removeReference()">×</button>
            </div>
        `;
    };
    reader.readAsDataURL(file);
}

// Display search images previews
function displaySearchPreviews() {
    searchPreview.innerHTML = '';
    searchImages.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const div = document.createElement('div');
            div.className = 'preview-item';
            div.innerHTML = `
                <img src="${e.target.result}" alt="Search image ${index + 1}">
                <button class="remove-btn" onclick="removeSearchImage(${index})">×</button>
            `;
            searchPreview.appendChild(div);
        };
        reader.readAsDataURL(file);
    });
}

// Remove reference image
function removeReference() {
    referenceImage = null;
    referencePreview.innerHTML = '';
    referenceInput.value = '';
    updateSearchButton();
}

// Remove search image
function removeSearchImage(index) {
    searchImages.splice(index, 1);
    displaySearchPreviews();
    updateSearchButton();
}

// Update search button state
function updateSearchButton() {
    searchButton.disabled = !(referenceImage && searchImages.length > 0);
}

// Perform face search
async function performSearch() {
    // Show progress
    progressBar.style.display = 'block';
    searchButton.disabled = true;
    resultsSection.style.display = 'none';
    resultsContainer.innerHTML = '';

    try {
        // Create FormData
        const formData = new FormData();
        formData.append('referenceImage', referenceImage);
        searchImages.forEach((file, index) => {
            formData.append('searchImages', file);
        });

        // Send to backend
        const response = await fetch('/api/search-face', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server error: ${response.statusText}`);
        }

        const results = await response.json();
        displayResults(results);

    } catch (error) {
        console.error('Error:', error);
        alert('Error performing search: ' + error.message);
    } finally {
        progressBar.style.display = 'none';
        searchButton.disabled = false;
    }
}

// Display search results
function displayResults(results) {
    resultsSection.style.display = 'block';
    resultsContainer.innerHTML = '';

    if (results.error) {
        resultsContainer.innerHTML = `
            <div style="padding: 20px; background: #f8d7da; color: #721c24; border-radius: 8px;">
                <strong>Error:</strong> ${results.error}
            </div>
        `;
        return;
    }

    if (!results.matches || results.matches.length === 0) {
        resultsContainer.innerHTML = `
            <div style="padding: 20px; background: #fff3cd; color: #856404; border-radius: 8px;">
                No matches found in the uploaded images.
            </div>
        `;
        return;
    }

    // Sort by confidence (highest first)
    results.matches.sort((a, b) => b.confidence - a.confidence);

    results.matches.forEach((match, index) => {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'result-item';
        
        const matchClass = match.isMatch ? 'match' : 'no-match';
        const matchText = match.isMatch ? '✓ Match Found' : '✗ No Match';
        
        resultDiv.innerHTML = `
            <img src="${match.imageUrl}" alt="Result ${index + 1}">
            <div class="result-info">
                <div class="result-match ${matchClass}">${matchText}</div>
                <div class="result-confidence">
                    Confidence: ${(match.confidence * 100).toFixed(1)}%
                </div>
                ${match.facesFound ? `<div class="result-confidence">Faces found: ${match.facesFound}</div>` : ''}
            </div>
        `;
        resultsContainer.appendChild(resultDiv);
    });

    // Scroll to results
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Expose functions to global scope for onclick handlers
window.removeReference = removeReference;
window.removeSearchImage = removeSearchImage;
