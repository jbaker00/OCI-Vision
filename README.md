# Face Search Application - OCI Vision

A mobile-friendly web application that uses Oracle Cloud Infrastructure (OCI) Vision API to search for a person's face across multiple images.

## Features

- 📱 **Mobile-Friendly**: Responsive design optimized for mobile devices
- 📷 **Camera Integration**: Take photos directly from mobile camera
- 🔍 **Face Detection**: Uses OCI Vision API for accurate face detection
- 🎯 **Face Matching**: Compare reference face against multiple images
- 📊 **Confidence Scoring**: Shows match confidence percentages
- 🎨 **Modern UI**: Clean, intuitive interface with smooth animations

## Prerequisites

- Node.js (v14 or higher)
- Oracle Cloud Infrastructure (OCI) account
- OCI Vision API access enabled
- OCI CLI configured or API keys generated
- (Optional) Google Cloud Vision API enabled
- (Optional) Python 3.9+ with face_recognition installed

## Setup Instructions

### 1. Clone or Download the Project

The project files are already in your workspace at:
```
/Users/jamesbaker/code/OCI Vision/
```

Note: `install.ps1` is for Windows-only OCI CLI installation and is not used on macOS.

### 2. Install Dependencies

Open a terminal in the project directory and run:

```bash
npm install
```

### 3. Configure OCI Credentials

You need to set up your OCI configuration file with your tenant credentials:

#### Option A: Using OCI CLI (Recommended)
If you haven't already, install and configure the OCI CLI:
```bash
# Install OCI CLI (follow instructions at docs.oracle.com)
# Then run the setup command
oci setup config
```

#### Option B: Manual Configuration
1. Create a directory for OCI config:
   ```bash
   mkdir -p ~/.oci
   ```

2. Generate an API key pair in OCI Console:
   - Log in to Oracle Cloud Console (cloud.oracle.com)
   - Click your profile icon → User Settings
   - Under "API Keys", click "Add API Key"
   - Download the private key and save as `~/.oci/oci_api_key.pem`

3. Create config file at `~/.oci/config`:
   ```ini
   [DEFAULT]
   user=ocid1.user.oc1..YOUR_USER_OCID
   fingerprint=YOUR_KEY_FINGERPRINT
   tenancy=ocid1.tenancy.oc1..YOUR_TENANCY_OCID
   region=us-ashburn-1
   key_file=~/.oci/oci_api_key.pem
   ```

See `oci-config-template.txt` for more details.

### 4. Enable OCI Vision API

Ensure your OCI tenant has Vision API enabled:
1. Go to OCI Console → Analytics & AI → Vision
2. Enable the service if not already enabled
3. Ensure you have the required IAM policies:
   ```
   Allow group <your-group> to use ai-service-vision-family in tenancy
   ```

### 5. Start the Application

```bash
npm start
```

If you have multiple OCI profiles in `~/.oci/config`, you can select one with:
```bash
OCI_PROFILE=YOUR_PROFILE_NAME npm start
```

If your config is in a non-default location, set:
```bash
OCI_CONFIG_FILE=/path/to/config OCI_PROFILE=YOUR_PROFILE_NAME npm start
```

The server will start on `http://localhost:3000`

## Optional: Use Google Cloud Vision

You can switch the UI provider to **Google Cloud Vision** instead of OCI.

### GCP Setup
1. Enable the Vision API in your GCP project.
2. Configure Application Default Credentials (ADC) on this machine:
   ```bash
   gcloud auth application-default login
   ```
   Or set a service account key:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   ```
3. Start the app normally and pick **Google Cloud Vision** in the UI.

## Optional: Use Python face_recognition

You can switch the UI provider to **Python face_recognition** for local face comparison.

### Python Setup
1. Ensure Python 3.9+ is installed and available as `python3`.
2. Install the dependency:
   ```bash
   pip install face_recognition
   ```
   Note: On macOS, this package requires build tools for `dlib`. If install fails, use a prebuilt wheel or install `cmake`/Xcode Command Line Tools.
3. Start the app normally and pick **Python face_recognition** in the UI.

## Usage

### On Desktop:
1. Open `http://localhost:3000` in your browser
2. Upload a reference face image (the person you want to find)
3. Upload multiple images to search through
4. Click "Search for Face" to find matches

### On Mobile:
1. Ensure your computer and mobile device are on the same network
2. Find your computer's IP address:
   ```bash
   ipconfig getifaddr en0
   ```
   (If you are on Ethernet, use `en1`.)

3. On your mobile browser, go to:
   ```
   http://YOUR_IP_ADDRESS:3000
   ```
   (e.g., `http://192.168.1.100:3000`)

4. Use the camera button to take photos directly, or upload from gallery

## How It Works

1. **Reference Image Processing**: The app detects faces in your reference image using OCI Vision API
2. **Search Images Analysis**: Each search image is analyzed for faces
3. **Face Comparison**: The detected faces are compared using facial features
4. **Results Display**: Images are ranked by confidence score, showing which ones contain matching faces

## Project Structure

```
OCI Vision/
├── index.html          # Main HTML page
├── styles.css          # Mobile-responsive styling
├── app.js              # Frontend JavaScript
├── server.js           # Node.js backend server
├── face_recognition_compare.py  # Python face_recognition helper
├── package.json        # Node.js dependencies
├── oci-config-template.txt  # OCI config template
└── README.md           # This file
```

## API Endpoints

- `GET /` - Serves the main application
- `POST /api/search-face` - Performs face search
  - Body: multipart/form-data with reference image and search images
  - Returns: JSON with match results and confidence scores
- `GET /api/health` - Health check endpoint

## Troubleshooting

### "OCI client initialization failed"
- Verify your OCI config file exists at `~/.oci/config`
- Check that your API key file path is correct
- Ensure your user OCID, tenancy OCID, and fingerprint are correct

### "GCP Vision client initialization failed"
- Ensure the Vision API is enabled in your GCP project
- Verify Application Default Credentials are set up (`gcloud auth application-default login`)
- If using a service account, confirm `GOOGLE_APPLICATION_CREDENTIALS` points to a valid JSON key

### "No face detected in reference image"
- Use a clear, well-lit photo with a visible face
- Ensure the face is not too small or too large in the frame
- Try a different photo angle

### "Python face recognition failed"
- Confirm `python3` is available in your PATH
- Ensure `face_recognition` is installed (`pip show face_recognition`)
- If `dlib` install fails, install Xcode Command Line Tools and `cmake`

### Mobile device can't connect
- Ensure both devices are on the same WiFi network
- Check your macOS firewall isn't blocking port 3000
- Try using your computer's IP address instead of localhost

### Images not uploading
- Check file size (max 10MB per image)
- Ensure images are in JPG, JPEG, or PNG format
- Try fewer images at once if experiencing timeouts

## Security Notes

- This application is designed for local/development use
- Do not expose the server to the internet without proper authentication
- Keep your OCI credentials secure and never commit them to version control
- The API key file should have restricted permissions (read-only for your user)

## OCI Vision API Limits

- Be aware of your OCI Vision API quotas and limits
- Face detection calls count toward your service limits
- Monitor your usage in the OCI Console

## Future Enhancements

Potential improvements:
- Add face embedding comparison for more accurate matching
- Support for video frame extraction
- Batch processing with progress tracking
- Results export functionality
- Face clustering across multiple images
- Integration with OCI Object Storage for large image sets

## License

MIT License

## Support

For OCI-specific issues, refer to:
- [OCI Vision Documentation](https://docs.oracle.com/en-us/iaas/vision/vision/using/home.htm)
- [OCI SDK for JavaScript](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/typescriptsdk.htm)

---

Built with ❤️ using Oracle Cloud Infrastructure Vision API
