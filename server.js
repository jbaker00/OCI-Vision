require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const vision = require('oci-aivision');
const common = require('oci-common');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
let geminiAI;
try {
    if (process.env.GEMINI_API_KEY) {
        geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        console.log('Gemini AI initialized for GCP face comparison');
    } else {
        console.warn('GEMINI_API_KEY not set — GCP face comparison unavailable');
    }
} catch (e) {
    console.error('Failed to initialize Gemini AI:', e.message);
}
const OCI_VISION_DELAY_MS = Number(process.env.OCI_VISION_DELAY_MS || 2000);
const OCI_MAX_RETRIES = Number(process.env.OCI_MAX_RETRIES || 4);
const PYTHON_COMMAND = process.env.PYTHON || 'python';
const PYTHON_FACE_THRESHOLD = Number(process.env.FACE_RECOGNITION_THRESHOLD || 0.6);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function initializeOCIClient() {
    try {
        // If individual OCI env vars are provided (e.g. Cloud Run), write a temp config file
        let configFilePath = process.env.OCI_CONFIG_FILE;
        if (!configFilePath && process.env.OCI_USER && process.env.OCI_PRIVATE_KEY_FILE) {
            const tempDir = path.join(os.tmpdir(), 'oci-init');
            await fs.promises.mkdir(tempDir, { recursive: true });
            configFilePath = path.join(tempDir, 'config');
            const configContent = [
                '[DEFAULT]',
                `user=${process.env.OCI_USER}`,
                `fingerprint=${process.env.OCI_FINGERPRINT}`,
                `tenancy=${process.env.OCI_TENANCY}`,
                `region=${process.env.OCI_REGION || 'us-phoenix-1'}`,
                `key_file=${process.env.OCI_PRIVATE_KEY_FILE}`,
            ].join('\n');
            await fs.promises.writeFile(configFilePath, configContent);
            console.log(`Wrote OCI config to ${configFilePath}`);
            console.log(`  user=${process.env.OCI_USER}`);
            console.log(`  fingerprint=${process.env.OCI_FINGERPRINT}`);
            console.log(`  tenancy=${process.env.OCI_TENANCY}`);
            console.log(`  region=${process.env.OCI_REGION || 'us-phoenix-1'}`);
            console.log(`  key_file=${process.env.OCI_PRIVATE_KEY_FILE}`);
            // Verify key file exists and is readable
            try {
                const keyContent = await fs.promises.readFile(process.env.OCI_PRIVATE_KEY_FILE, 'utf8');
                console.log(`OCI private key file readable, length=${keyContent.length}, starts with: ${keyContent.substring(0,27)}`);
            } catch (keyErr) {
                console.error(`OCI private key file NOT readable: ${keyErr.message}`);
            }
        }
        configFilePath = configFilePath || path.join(os.homedir(), '.oci', 'config');
        const profile = process.env.OCI_PROFILE || undefined;
        const provider = new common.ConfigFileAuthenticationDetailsProvider(
            configFilePath,
            profile
        );

        visionClient = new vision.AIServiceVisionClient({
            authenticationDetailsProvider: provider
        });

        const profileLabel = profile || 'DEFAULT';
        console.log(`OCI Vision client initialized successfully (config: ${configFilePath}, profile: ${profileLabel})`);
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
    // Coerce to string — OCI SDK sometimes returns non-string serviceCode, causing toLowerCase crash
    const rawCode = error.serviceCode || error.code;
    const serviceCode = rawCode != null ? String(rawCode) : undefined;
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

        const pythonTimeout = setTimeout(() => {
            console.error('Python face_recognition timed out after 120 seconds, killing process');
            pythonProcess.kill();
        }, 120000);

        pythonProcess.on('close', () => clearTimeout(pythonTimeout));

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
                })),
                detectionOnly: true
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
            // Only delay on retries (attempt > 0), not the first request
            if (attempt > 0) {
                const delay = OCI_VISION_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(`OCI Vision: waiting ${delay}ms before retry (attempt ${attempt + 1})`);
                await sleep(delay);
            }
            try {
                const response = await visionClient.analyzeImage(analyzeImageRequest);
                return response.analyzeImageResult;
            } catch (err) {
                lastError = err;
                const msg = err?.message || '';
                console.error(`OCI analyzeImage error (attempt ${attempt}): [${err?.constructor?.name}] ${msg}`);
                // OCI SDK bug: crashes with TypeError when processing certain error responses.
                // Check by message alone since instanceof can fail across module boundaries.
                if (msg.includes('toLowerCase')) {
                    const sdkErr = new Error(
                        'OCI Vision API request failed — possible policy/permissions issue. ' +
                        'Ensure this OCI user has: Allow group <group> to use ai-service-vision-family in tenancy'
                    );
                    console.error('OCI SDK bug detected (likely auth/policy issue on OCI side)');
                    throw sdkErr;
                }
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

// Compare two face images using Gemini multimodal AI
async function compareFacesWithGemini(refBuffer, refMime, searchBuffer, searchMime) {
    if (!geminiAI) throw new Error('Gemini AI not initialized. Check GEMINI_API_KEY.');

    const model = geminiAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are a face recognition expert. Compare these two images.
Image 1 is the REFERENCE face to search for.
Image 2 is the SEARCH image to check.

Does Image 2 contain the same person as Image 1?

Reply ONLY with valid JSON in this exact format (no markdown, no explanation):
{"isMatch": true, "confidence": 0.92, "facesFound": 1, "reasoning": "same nose bridge and eye spacing"}

Rules:
- isMatch: true if you believe it is the same person, false otherwise
- confidence: 0.0 to 1.0 (how certain you are)
- facesFound: number of faces detected in Image 2 (0 if no face)
- reasoning: one short phrase explaining your decision
- If no face in Image 2, return {"isMatch": false, "confidence": 0, "facesFound": 0, "reasoning": "no face detected"}`;

    const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: refMime, data: refBuffer.toString('base64') } },
        { inlineData: { mimeType: searchMime, data: searchBuffer.toString('base64') } },
    ]);

    const text = result.response.text().trim();
    // Strip markdown code fences if present
    const jsonText = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonText);
    return {
        isMatch: !!parsed.isMatch,
        confidence: Number(parsed.confidence) || 0,
        facesFound: Number(parsed.facesFound) || 0,
        reasoning: parsed.reasoning || '',
    };
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

        if (provider === 'gcp') {
            // Use Gemini multimodal AI for real face identity comparison
            console.log('Using Gemini AI for face identity comparison');
            if (!geminiAI) {
                return res.status(500).json({ error: 'Gemini AI not configured. Check GEMINI_API_KEY.' });
            }

            const matches = [];
            for (let i = 0; i < searchImages.length; i++) {
                const searchImage = searchImages[i];
                console.log(`Gemini: comparing search image ${i + 1}/${searchImages.length}: ${searchImage.originalname}`);
                try {
                    const comparison = await compareFacesWithGemini(
                        referenceImage.buffer, referenceImage.mimetype,
                        searchImage.buffer, searchImage.mimetype
                    );
                    console.log(`  isMatch=${comparison.isMatch} confidence=${comparison.confidence} reasoning="${comparison.reasoning}"`);
                    matches.push({
                        imageUrl: `data:${searchImage.mimetype};base64,${searchImage.buffer.toString('base64')}`,
                        filename: searchImage.originalname,
                        isMatch: comparison.isMatch,
                        confidence: comparison.confidence,
                        facesFound: comparison.facesFound,
                        reasoning: comparison.reasoning,
                    });
                } catch (error) {
                    console.error(`Gemini error on ${searchImage.originalname}:`, error.message);
                    matches.push({
                        imageUrl: `data:${searchImage.mimetype};base64,${searchImage.buffer.toString('base64')}`,
                        filename: searchImage.originalname,
                        isMatch: false,
                        confidence: 0,
                        error: error.message,
                    });
                }
            }
            return res.json({ matches });
        }

        // OCI provider
        const referenceResult = await detectFaces(referenceImage.buffer, provider);
        const referenceFaces = referenceResult.detectedFaces || [];

        if (referenceFaces.length === 0) {
            return res.json({
                error: 'No face detected in the reference image. Please upload a clear photo with a visible face.'
            });
        }

        const matches = [];
        for (let i = 0; i < searchImages.length; i++) {
            const searchImage = searchImages[i];
            console.log(`Processing search image ${i + 1}/${searchImages.length}: ${searchImage.originalname}`);
            try {
                const searchResult = await detectFaces(searchImage.buffer, provider);
                const searchFaces = searchResult.detectedFaces || [];
                const comparison = compareFaces(referenceFaces, searchFaces);
                matches.push({
                    imageUrl: `data:${searchImage.mimetype};base64,${searchImage.buffer.toString('base64')}`,
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
        gcpConfigured: !!gcpVisionClient,
        geminiConfigured: !!geminiAI,
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
