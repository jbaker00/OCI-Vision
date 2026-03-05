const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const vision = require('oci-aivision');
const common = require('oci-common');
const { ImageAnnotatorClient } = require('@google-cloud/vision');

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
let gcpVisionClient;
const OCI_VISION_DELAY_MS = Number(process.env.OCI_VISION_DELAY_MS || 2000);
const OCI_MAX_RETRIES = Number(process.env.OCI_MAX_RETRIES || 4);
const PYTHON_COMMAND = process.env.PYTHON || 'python';
const PYTHON_FACE_THRESHOLD = Number(process.env.FACE_RECOGNITION_THRESHOLD || 0.6);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

function getGcpVisionClient() {
    if (!gcpVisionClient) {
        gcpVisionClient = new ImageAnnotatorClient();
        console.log('GCP Vision client initialized successfully');
    }
    return gcpVisionClient;
}

function formatOciError(error) {
    if (!error || typeof error !== 'object') {
        return String(error);
    }

    const statusCode = error.statusCode || error.httpStatusCode;
    const serviceCode = error.serviceCode || error.code;
    const message = error.message || error.detail || error.msg;
    const opcRequestId = error.opcRequestId || error.requestId;

    return {
        statusCode,
        serviceCode,
        message,
        opcRequestId,
        original: error
    };
}

async function runPythonFaceCompare(referenceImage, searchImages) {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'face-compare-'));
    const scriptPath = path.join(__dirname, 'face_recognition_compare.py');

    try {
        const referenceExt = path.extname(referenceImage.originalname || '') || '.jpg';
        const referencePath = path.join(tempDir, `reference${referenceExt}`);
        await fs.promises.writeFile(referencePath, referenceImage.buffer);

        const searchPaths = [];
        for (let i = 0; i < searchImages.length; i++) {
            const image = searchImages[i];
            const ext = path.extname(image.originalname || '') || '.jpg';
            const imagePath = path.join(tempDir, `search-${i}${ext}`);
            await fs.promises.writeFile(imagePath, image.buffer);
            searchPaths.push(imagePath);
        }

        const payload = {
            referencePath,
            searchPaths,
            threshold: PYTHON_FACE_THRESHOLD
        };

        console.log(`Starting Python face_recognition (${PYTHON_COMMAND})`);
        console.log(`Reference image: ${referenceImage.originalname}`);
        console.log(`Search images: ${searchImages.length}`);

        const stdoutChunks = [];
        const stderrChunks = [];

        const pythonProcess = spawn(PYTHON_COMMAND, [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        pythonProcess.stdout.on('data', (chunk) => {
            stdoutChunks.push(chunk);
        });

        pythonProcess.stderr.on('data', (chunk) => {
            const message = chunk.toString();
            stderrChunks.push(message);
            console.log(`[python] ${message.trimEnd()}`);
        });

        pythonProcess.stdin.write(JSON.stringify(payload));
        pythonProcess.stdin.end();

        const exitCode = await new Promise((resolve, reject) => {
            pythonProcess.on('error', reject);
            pythonProcess.on('close', resolve);
        });

        if (exitCode !== 0) {
            const stderrOutput = stderrChunks.join('');
            throw new Error(stderrOutput || `Python exited with code ${exitCode}`);
        }

        const stdout = Buffer.concat(stdoutChunks).toString();
        return JSON.parse(stdout);
    } catch (error) {
        const message = error?.message || 'Python face recognition failed';
        throw new Error(message);
    } finally {
        try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.warn('Failed to clean up temp files:', cleanupError);
        }
    }
}

// Detect faces in an image
async function detectFaces(imageBuffer, provider) {
    try {
        if (provider === 'gcp') {
            const client = getGcpVisionClient();
            const [result] = await client.faceDetection({
                image: { content: imageBuffer.toString('base64') }
            });
            const faces = result.faceAnnotations || [];
            return {
                detectedFaces: faces.map(face => ({
                    qualityScore: face.detectionConfidence || 0.7
                }))
            };
        }

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
            analyzeImageDetails: analyzeImageDetails,
            retryConfiguration: common.NoRetryConfigurationDetails
        };

        let lastError;
        for (let attempt = 0; attempt <= OCI_MAX_RETRIES; attempt++) {
            const delay = OCI_VISION_DELAY_MS * Math.pow(2, attempt);
            if (delay > 0) {
                console.log(`OCI Vision: waiting ${delay}ms before request (attempt ${attempt + 1})`);
                await sleep(delay);
            }
            try {
                const response = await visionClient.analyzeImage(analyzeImageRequest);
                return response.analyzeImageResult;
            } catch (err) {
                lastError = err;
                const msg = err?.message || '';
                const isRateLimit = msg.includes('sync-transactions-per-second-count');
                if (!isRateLimit || attempt === OCI_MAX_RETRIES) {
                    throw err;
                }
                console.warn(`OCI rate limit hit, retrying (attempt ${attempt + 1}/${OCI_MAX_RETRIES})...`);
            }
        }
        throw lastError;
    } catch (error) {
        const formatted = provider === 'gcp' ? error : formatOciError(error);
        console.error('Error detecting faces:', formatted);
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
        const provider = (req.body.provider || 'oci').toLowerCase();

        if (!['oci', 'gcp', 'python'].includes(provider)) {
            return res.status(400).json({
                error: 'Invalid provider. Use "oci", "gcp", or "python".'
            });
        }

        console.log(`Processing reference image: ${referenceImage.originalname}`);
        console.log(`Processing ${searchImages.length} search images`);
        console.log(`Provider: ${provider}`);

        if (provider === 'python') {
            console.log('Using Python face_recognition for comparison');

            const pythonResults = await runPythonFaceCompare(referenceImage, searchImages);
            const referenceFaces = pythonResults.referenceFaces || 0;

            if (referenceFaces === 0) {
                return res.json({
                    error: 'No face detected in the reference image. Please upload a clear photo with a visible face.'
                });
            }

            const matches = searchImages.map((searchImage, index) => {
                const matchResult = pythonResults.matches?.[index] || {
                    isMatch: false,
                    confidence: 0,
                    facesFound: 0
                };

                return {
                    imageUrl: `data:${searchImage.mimetype};base64,${searchImage.buffer.toString('base64')}`,
                    filename: searchImage.originalname,
                    isMatch: matchResult.isMatch,
                    confidence: matchResult.confidence,
                    facesFound: matchResult.facesFound
                };
            });

            return res.json({ matches });
        }

        // Detect faces in reference image
        const referenceResult = await detectFaces(referenceImage.buffer, provider);
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
                const searchResult = await detectFaces(searchImage.buffer, provider);
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
        console.error('Error in face search:', formatOciError(error));
        const message = error?.message || 'Internal server error';
        const isLimitError = typeof message === 'string' && message.includes('sync-transactions-per-second-count');
        res.status(500).json({
            error: isLimitError
                ? 'OCI Vision rate limit exceeded. Try fewer images, wait a moment, or increase the service limit.'
                : message
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        ociConfigured: !!visionClient,
        gcpConfigured: !!gcpVisionClient
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
