const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const vision = require('oci-aivision');
const common = require('oci-common');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Serve static files
app.use(express.static('.'));

// OCI Configuration
let visionClient;

async function initializeOCIClient() {
    try {
        // Use config file authentication
        const configFilePath = process.env.OCI_CONFIG_FILE || undefined;
        const profile = process.env.OCI_PROFILE || undefined;
        const provider = new common.ConfigFileAuthenticationDetailsProvider(
            configFilePath,
            profile
        );
        
        visionClient = new vision.AIServiceVisionClient({
            authenticationDetailsProvider: provider
        });

        const configPathLabel = configFilePath || '~/.oci/config';
        const profileLabel = profile || 'DEFAULT';
        console.log(`OCI Vision client initialized successfully (config: ${configPathLabel}, profile: ${profileLabel})`);
    } catch (error) {
        console.error('Error initializing OCI client:', error);
        throw error;
    }
}

// Detect faces in an image
async function detectFaces(imageBuffer) {
    try {
        const analyzeImageDetails = {
            features: [
                {
                    featureType: "FACE_DETECTION",
                    maxResults: 10
                }
            ],
            image: {
                source: "INLINE",
                data: imageBuffer.toString('base64')
            }
        };

        const analyzeImageRequest = {
            analyzeImageDetails: analyzeImageDetails
        };

        const response = await visionClient.analyzeImage(analyzeImageRequest);
        return response.analyzeImageResult;
    } catch (error) {
        console.error('Error detecting faces:', error);
        throw error;
    }
}

// Compare two face feature sets
// NOTE: OCI Vision face detection doesn't provide embeddings for comparison
// This marks images with faces as potential matches
function compareFaces(referenceFaces, searchFaces, threshold = 0.6) {
    if (!referenceFaces || referenceFaces.length === 0) {
        return { isMatch: false, confidence: 0, facesFound: 0 };
    }

    if (!searchFaces || searchFaces.length === 0) {
        return { isMatch: false, confidence: 0, facesFound: 0 };
    }

    // Get the first face from reference image
    const refFace = referenceFaces[0];
    
    // Check each face in the search image
    let maxConfidence = 0;
    let matchFound = false;

    for (const searchFace of searchFaces) {
        // Calculate basic similarity score
        const confidence = calculateFaceSimilarity(refFace, searchFace);
        
        if (confidence > maxConfidence) {
            maxConfidence = confidence;
        }

        if (confidence >= threshold) {
            matchFound = true;
        }
    }

    return {
        isMatch: matchFound,
        confidence: maxConfidence,
        facesFound: searchFaces.length
    };
}

// Calculate face similarity (simplified version)
function calculateFaceSimilarity(face1, face2) {
    // NOTE: Without face embeddings/features, this is a basic placeholder
    // OCI Vision face detection API doesn't provide face embeddings for comparison
    // For true face matching, you would need OCI Vision's face recognition features
    // or a separate face recognition service
    
    // Use quality scores as a proxy for "match confidence"
    const quality1 = face1.qualityScore || 0.7;
    const quality2 = face2.qualityScore || 0.7;
    
    // If both faces have good quality, mark as potential match
    const avgQuality = (quality1 + quality2) / 2;
    
    // Return quality-based score (higher quality = higher "confidence")
    return Math.min(avgQuality, 0.95);
}

// API endpoint for face search
app.post('/api/search-face', upload.fields([
    { name: 'referenceImage', maxCount: 1 },
    { name: 'searchImages', maxCount: 50 }
]), async (req, res) => {
    try {
        if (!req.files || !req.files.referenceImage || !req.files.searchImages) {
            return res.status(400).json({ 
                error: 'Please provide both reference image and search images' 
            });
        }

        const referenceImage = req.files.referenceImage[0];
        const searchImages = req.files.searchImages;

        console.log(`Processing reference image: ${referenceImage.originalname}`);
        console.log(`Processing ${searchImages.length} search images`);

        // Detect faces in reference image
        const referenceResult = await detectFaces(referenceImage.buffer);
        const referenceFaces = referenceResult.detectedFaces || [];

        console.log('Reference result:', JSON.stringify(referenceResult, null, 2));

        if (referenceFaces.length === 0) {
            return res.json({
                error: 'No face detected in the reference image. Please upload a clear photo with a visible face.'
            });
        }

        console.log(`Found ${referenceFaces.length} face(s) in reference image`);

        // Process each search image
        const matches = [];
        for (let i = 0; i < searchImages.length; i++) {
            const searchImage = searchImages[i];
            console.log(`Processing search image ${i + 1}/${searchImages.length}: ${searchImage.originalname}`);

            try {
                // Detect faces in search image
                const searchResult = await detectFaces(searchImage.buffer);
                const searchFaces = searchResult.detectedFaces || [];

                console.log(`  Found ${searchFaces.length} face(s) in ${searchImage.originalname}`);

                // Compare faces
                const comparison = compareFaces(referenceFaces, searchFaces);
                console.log(`  Match result: ${comparison.isMatch}, confidence: ${comparison.confidence}`);

                // Convert image to base64 for display
                const imageBase64 = `data:${searchImage.mimetype};base64,${searchImage.buffer.toString('base64')}`;

                matches.push({
                    imageUrl: imageBase64,
                    filename: searchImage.originalname,
                    isMatch: comparison.isMatch,
                    confidence: comparison.confidence,
                    facesFound: comparison.facesFound
                });
            } catch (error) {
                console.error(`Error processing ${searchImage.originalname}:`, error);
                matches.push({
                    imageUrl: `data:${searchImage.mimetype};base64,${searchImage.buffer.toString('base64')}`,
                    filename: searchImage.originalname,
                    isMatch: false,
                    confidence: 0,
                    error: 'Error processing image'
                });
            }
        }

        res.json({ matches });

    } catch (error) {
        console.error('Error in face search:', error);
        res.status(500).json({ 
            error: 'Internal server error: ' + error.message 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        ociConfigured: !!visionClient 
    });
});

// Start server
async function startServer() {
    try {
        await initializeOCIClient();
        
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Open this URL in your mobile browser to use the app`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        console.error('Please ensure your OCI configuration is set up correctly');
        process.exit(1);
    }
}

startServer();
