// Configuration
const DB_NAME = "AegisAttendanceDB";
const DB_VERSION = 1;
let db = null;

// Application State
let localStream = null;
let scanIntervalId = null;
let isProcessingScan = false;
let modelsLoaded = false;
let currentCapturedImage = null; // Stores last base64 photo for registration
let currentFaceDescriptor = null; // Stores face descriptor during modal registration
let selectedClass = "";

// DOM Elements
const loginPanel = document.getElementById('login-panel');
const loginView = document.getElementById('login-view');
const setupView = document.getElementById('setup-view');
const loginHeaderTitle = document.getElementById('login-header-title');
const loginHeaderDesc = document.getElementById('login-header-desc');

const passcodeInput = document.getElementById('passcode-input');
const btnLogin = document.getElementById('btn-login');
const loginError = document.getElementById('login-error');

const newPasscode = document.getElementById('new-passcode');
const confirmPasscode = document.getElementById('confirm-passcode');
const setupError = document.getElementById('setup-error');
const btnSetup = document.getElementById('btn-setup');

const appDashboard = document.getElementById('app-dashboard');
const btnLogout = document.getElementById('btn-logout');
const modelStatus = document.getElementById('model-status');
const statusPulse = document.getElementById('status-pulse');

const classInput = document.getElementById('class-input');
const classesDatalist = document.getElementById('classes-datalist');
const toleranceSlider = document.getElementById('tolerance-slider');
const toleranceVal = document.getElementById('tolerance-val');
const voiceToggle = document.getElementById('voice-announcer-toggle');

const video = document.getElementById('webcam');
const overlayCanvas = document.getElementById('overlay-canvas');
const viewportPlaceholder = document.getElementById('viewport-placeholder');
const scannerLaser = document.getElementById('scanner-laser');
const cameraStatus = document.getElementById('camera-status');

const btnStartCamera = document.getElementById('btn-start-camera');
const btnTakeAttendance = document.getElementById('btn-take-attendance');
const btnStopCamera = document.getElementById('btn-stop-camera');

const statusCard = document.getElementById('status-display-panel');
const statusTitle = document.getElementById('status-title');
const statusDesc = document.getElementById('status-desc');
const statusIconContainer = document.querySelector('.info-icon-container');

const logClassTag = document.getElementById('log-class-tag');
const logCount = document.getElementById('log-count');
const attendanceLogBody = document.getElementById('attendance-log-body');

const reportRange = document.getElementById('report-range');
const btnExportExcel = document.getElementById('btn-export-excel');
const btnBackupDb = document.getElementById('btn-backup-db');
const btnRestoreDb = document.getElementById('btn-restore-db');
const restoreFileInput = document.getElementById('restore-file-input');

// Modal Elements
const registerModal = document.getElementById('register-modal');
const faceCropCanvas = document.getElementById('face-crop-canvas');
const studentNameInput = document.getElementById('student-name-input');
const nameError = document.getElementById('name-error');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelRegister = document.getElementById('btn-cancel-register');
const btnSubmitRegister = document.getElementById('btn-submit-register');

// Loading Progress Elements
const loadingProgressContainer = document.getElementById('loading-progress-container');
const loadingProgressBar = document.getElementById('loading-progress-bar');
const loadingProgressText = document.getElementById('loading-progress-text');

// Set canvas dimensions matching face-api.js view aspect ratio
overlayCanvas.width = 640;
overlayCanvas.height = 480;

// ============================================
// ENHANCED PASSCODE HASHING WITH PBKDF2
// ============================================
async function hashPasscodeWithSalt(passcode) {
    try {
        // Generate a random salt
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const encoder = new TextEncoder();
        const data = encoder.encode(passcode);
        
        // Use PBKDF2 with SHA-256, 100,000 iterations
        const key = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 100000,
                hash: 'SHA-256'
            },
            await crypto.subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits']),
            256
        );
        
        // Combine salt + derived key
        const hashBuffer = new Uint8Array(salt.length + key.byteLength / 8);
        hashBuffer.set(salt, 0);
        hashBuffer.set(new Uint8Array(key), salt.length);
        
        // Convert to hex string for storage
        const hashArray = Array.from(hashBuffer);
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.error("PBKDF2 hashing error:", e);
        // Fallback to old SHA-256 method if PBKDF2 fails
        return hashPasscode(passcode);
    }
}

// Old SHA-256 method (kept for backward compatibility)
async function hashPasscode(passcode) {
    const msgBuffer = new TextEncoder().encode(passcode);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// ============================================
// MULTIPLE CDN FALLBACKS FOR FACE-API MODELS
// ============================================
const MODEL_CDNS = [
    'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/',
    'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/models/',
    'https://unpkg.com/@vladmandic/face-api/model/',
    'https://unpkg.com/face-api.js@0.22.2/dist/models/'
];

async function loadFaceModelsWithFallback() {
    updateStatusPanel("waiting", "Loading Models...", "Downloading neural network weights...");
    
    if (loadingProgressContainer) {
        loadingProgressContainer.style.display = 'block';
    }
    
    let lastError = null;
    
    for (let cdnIndex = 0; cdnIndex < MODEL_CDNS.length; cdnIndex++) {
        const MODEL_URL = MODEL_CDNS[cdnIndex];
        console.log(`[FaceAPI] Attempting CDN ${cdnIndex + 1}/${MODEL_CDNS.length}: ${MODEL_URL}`);
        
        if (loadingProgressText) {
            loadingProgressText.innerText = `Trying CDN ${cdnIndex + 1}/${MODEL_CDNS.length}...`;
        }
        
        try {
            // Load models with timeout
            await Promise.race([
                loadModelsFromCDN(MODEL_URL),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Model loading timeout')), 30000)
                )
            ]);
            
            console.log(`[FaceAPI] ✅ Successfully loaded from CDN: ${MODEL_URL}`);
            modelsLoaded = true;
            modelStatus.innerText = "System Ready";
            statusPulse.className = "pulse-indicator";
            
            // Run warmup detection
            await warmupFaceDetection();
            
            updateStatusPanel("waiting", "System Ready", "Type a class name and click 'Start Camera' to begin.");
            
            if (loadingProgressContainer) {
                loadingProgressContainer.style.display = 'none';
            }
            
            return; // Success!
            
        } catch (e) {
            lastError = e;
            console.warn(`[FaceAPI] ⚠️ CDN ${cdnIndex + 1} failed:`, e.message);
            
            // Update progress
            if (loadingProgressBar && loadingProgressText) {
                const progress = ((cdnIndex + 1) / MODEL_CDNS.length) * 100;
                loadingProgressBar.style.width = progress + '%';
                loadingProgressText.innerText = `CDN ${cdnIndex + 1} failed, trying next...`;
            }
            
            continue; // Try next CDN
        }
    }
    
    // All CDNs failed
    console.error("[FaceAPI] ❌ All CDNs failed to load models:", lastError);
    modelStatus.innerText = "Model Error";
    statusPulse.className = "pulse-indicator warning";
    
    const errorMsg = lastError?.message || 'Unknown error';
    updateStatusPanel(
        "error", 
        "Engine Failed", 
        `Unable to load face detection models. Error: ${errorMsg}. Please check your internet connection and refresh the page.`
    );
    
    if (loadingProgressContainer) {
        loadingProgressContainer.innerHTML = `
            <div style="padding: 1rem; text-align: center; color: #ef4444;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i>
                <p style="font-weight: 600;">Model Loading Failed</p>
                <p style="font-size: 0.85rem; margin-top: 0.5rem;">Error: ${errorMsg}</p>
                <button onclick="location.reload()" style="margin-top: 0.75rem; padding: 0.5rem 1rem; background: #0ea5e9; color: white; border: none; border-radius: 6px; cursor: pointer;">
                    Retry
                </button>
            </div>
        `;
    }
}

async function loadModelsFromCDN(modelUrl) {
    return Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl)
    ]);
}

// Warmup detection to prepare models
async function warmupFaceDetection() {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 64, 64);
        
        const options = new faceapi.TinyFaceDetectorOptions({ 
            inputSize: 224, 
            scoreThreshold: 0.4 
        });
        
        // Run dummy detection to warm up the model
        await faceapi.detectSingleFace(canvas, options).withFaceLandmarks().withFaceDescriptor();
        console.log("[FaceAPI] ✅ Model warmup complete");
    } catch (e) {
        console.warn("[FaceAPI] Model warmup skipped:", e.message);
    }
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    // Check if passcode is already set in localStorage
    const hasPasscode = localStorage.getItem('aegis_passcode_hash') !== null;
    
    if (hasPasscode) {
        // Show Standard Login View
        loginView.style.display = 'block';
        setupView.style.display = 'none';
        
        if (sessionStorage.getItem('aegis_auth') === 'true') {
            initDashboard();
        } else {
            btnLogin.addEventListener('click', handleLogin);
            passcodeInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin();
            });
        }
    } else {
        // First-Time Setup Flow
        loginHeaderTitle.innerText = "CREATE PASSCODE";
        loginHeaderDesc.innerText = "Setup Authorized Access";
        loginView.style.display = 'none';
        setupView.style.display = 'block';
        
        btnSetup.addEventListener('click', handleSetup);
        newPasscode.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') confirmPasscode.focus();
        });
        confirmPasscode.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSetup();
        });
    }
});

// Create/Register passcode on first-run
async function handleSetup() {
    const newCode = newPasscode.value.trim();
    const confCode = confirmPasscode.value.trim();
    
    if (!newCode) {
        setupError.innerText = "Passcode cannot be empty.";
        setupError.style.display = "block";
        return;
    }
    
    if (newCode.length < 4) {
        setupError.innerText = "Passcode must be at least 4 characters.";
        setupError.style.display = "block";
        return;
    }
    
    if (newCode !== confCode) {
        setupError.innerText = "Passcodes do not match. Please verify.";
        setupError.style.display = "block";
        return;
    }
    
    setupError.style.display = "none";
    btnSetup.disabled = true;
    
    try {
        const hash = await hashPasscodeWithSalt(newCode);
        localStorage.setItem('aegis_passcode_hash', hash);
        sessionStorage.setItem('aegis_auth', 'true');
        initDashboard();
    } catch (e) {
        console.error("Passcode setup error:", e);
        alert("Error saving your passcode hash.");
    } finally {
        btnSetup.disabled = false;
    }
}

// Passcode Authorization Handler (PBKDF2 Comparison)
async function handleLogin() {
    const code = passcodeInput.value.trim();
    const storedHash = localStorage.getItem('aegis_passcode_hash');
    
    if (!storedHash) {
        location.reload();
        return;
    }
    
    btnLogin.disabled = true;
    try {
        const hash = await hashPasscodeWithSalt(code);
        if (hash === storedHash) {
            sessionStorage.setItem('aegis_auth', 'true');
            initDashboard();
        } else {
            loginError.style.display = 'block';
            passcodeInput.value = '';
            passcodeInput.focus();
        }
    } catch (e) {
        console.error("Authentication error:", e);
        alert("Crypto verification failed.");
    } finally {
        btnLogin.disabled = false;
    }
}

// Log out and lock system
function handleLogout() {
    sessionStorage.removeItem('aegis_auth');
    stopCamera();
    appDashboard.style.display = 'none';
    loginPanel.style.display = 'flex';
    
    // Toggle back to standard login screen
    loginHeaderTitle.innerText = "AEGIS SECURE";
    loginHeaderDesc.innerText = "Authorized Attendance Portal";
    loginView.style.display = 'block';
    setupView.style.display = 'none';
    
    passcodeInput.value = '';
    loginError.style.display = 'none';
}

// Dashboard initialization
async function initDashboard() {
    loginPanel.style.display = 'none';
    appDashboard.style.display = 'block';
    
    btnLogout.addEventListener('click', handleLogout);
    btnStartCamera.addEventListener('click', startCamera);
    btnStopCamera.addEventListener('click', stopCamera);
    btnTakeAttendance.addEventListener('click', startAttendanceScan);
    btnExportExcel.addEventListener('click', exportToExcel);
    btnBackupDb.addEventListener('click', backupDatabase);
    btnRestoreDb.addEventListener('click', () => restoreFileInput.click());
    restoreFileInput.addEventListener('change', restoreDatabase);
    
    // Modal events
    btnCloseModal.addEventListener('click', hideRegisterModal);
    btnCancelRegister.addEventListener('click', hideRegisterModal);
    btnSubmitRegister.addEventListener('click', submitRegistration);
    
    // Escape key modal close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && registerModal.classList.contains('show')) {
            hideRegisterModal();
        }
    });

    classInput.addEventListener('input', () => {
        selectedClass = classInput.value.trim();
        logClassTag.innerText = selectedClass || "No Class";
        
        if (selectedClass) {
            btnTakeAttendance.disabled = (localStream === null || !modelsLoaded);
            loadTodayAttendance();
        } else {
            btnTakeAttendance.disabled = true;
        }
    });

    toleranceSlider.addEventListener('input', () => {
        toleranceVal.innerText = parseFloat(toleranceSlider.value).toFixed(2);
    });

    // Initialize Database
    await initDatabase();
    
    // Load existing classes suggestions
    await fetchClasses();

    // Load Neural Networks with enhanced fallback system
    await loadFaceModelsWithFallback();
}

// Voice Announcer Synth
function announce(text) {
    if (!voiceToggle.checked) return;
    try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(utterance);
    } catch (e) {
        console.error("Vocal synthesis error:", e);
    }
}

// Initialize browser local IndexedDB database
function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (e) => {
            const dbInstance = e.target.result;
            
            // Store 1: Students faces
            if (!dbInstance.objectStoreNames.contains('students')) {
                const studentStore = dbInstance.createObjectStore('students', { keyPath: 'id' });
                // Add indexes for better query performance
                studentStore.createIndex('class', 'class', { unique: false });
            }
            
            // Store 2: Attendance log
            if (!dbInstance.objectStoreNames.contains('attendance')) {
                const attendanceStore = dbInstance.createObjectStore('attendance', { autoIncrement: true });
                attendanceStore.createIndex('class_date', ['class', 'date'], { unique: false });
            }
            
            // Store 3: Captured photos
            if (!dbInstance.objectStoreNames.contains('photos')) {
                dbInstance.createObjectStore('photos', { keyPath: 'id' });
            }
        };
        
        request.onsuccess = (e) => {
            db = e.target.result;
            console.log("[DB] ✅ Database initialized successfully");
            resolve();
        };
        
        request.onerror = (e) => {
            console.error("Database open error:", e.target.error);
            alert("Local storage database initialization failed.");
            reject(e.target.error);
        };
    });
}

// Populate classes suggestions datalist
function fetchClasses() {
    return new Promise((resolve) => {
        if (!db) return resolve();
        
        const transaction = db.transaction('students', 'readonly');
        const store = transaction.objectStore('students');
        const classIndex = store.index('class');
        const request = classIndex.getAll();
        
        request.onsuccess = () => {
            const studentsList = request.result;
            // Get unique classes
            const classes = Array.from(new Set(studentsList.map(s => s.class))).filter(Boolean);
            
            // Keep hardcoded defaults or update with server ones
            const datalist = document.getElementById('classes-datalist');
            const existingOptions = Array.from(datalist.options).map(opt => opt.value);
            
            classes.forEach(cls => {
                if (!existingOptions.includes(cls)) {
                    const opt = document.createElement('option');
                    opt.value = cls;
                    datalist.appendChild(opt);
                }
            });
            resolve();
        };
        
        request.onerror = () => {
            console.error("[DB] Error fetching classes:", request.error);
            resolve();
        };
    });
}

// Start Camera Capture Stream
async function startCamera() {
    if (!selectedClass) {
        alert("Please type a class name before starting the camera.");
        classInput.focus();
        return;
    }
    
    if (!modelsLoaded) {
        alert("Face detection models are still loading. Please wait...");
        return;
    }
    
    try {
        const constraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: "user" // Default user selfie camera
            },
            audio: false
        };
        
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = localStream;
        
        video.style.display = 'block';
        viewportPlaceholder.style.display = 'none';
        btnStartCamera.style.display = 'none';
        btnStopCamera.style.display = 'inline-flex';
        btnTakeAttendance.disabled = false;
        
        cameraStatus.innerText = "Online";
        cameraStatus.className = "status-badge online";
        
        updateStatusPanel("waiting", "Camera Connected", "Click 'Take Attendance' to initiate face scans.");
    } catch (e) {
        console.error("Camera access failed:", e);
        alert("Webcam access blocked. Make sure camera permission is granted in browser settings.");
        updateStatusPanel("error", "Access Denied", "Camera permission blocked. Enable camera access in your phone settings.");
    }
}

// Stop Camera Stream
function stopCamera() {
    stopAttendanceScan();
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    video.srcObject = null;
    video.style.display = 'none';
    viewportPlaceholder.style.display = 'flex';
    
    btnStartCamera.style.display = 'inline-flex';
    btnStopCamera.style.display = 'none';
    btnTakeAttendance.disabled = true;
    
    cameraStatus.innerText = "Offline";
    cameraStatus.className = "status-badge offline";
    
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    updateStatusPanel("waiting", "System Ready", "Type a class name and click 'Start Camera'.");
}

// Start Scanning loop
function startAttendanceScan() {
    if (!localStream || !modelsLoaded) return;
    if (scanIntervalId) return;
    
    cameraStatus.innerText = "Scanning";
    cameraStatus.className = "status-badge scanning";
    scannerLaser.style.display = 'block';
    btnTakeAttendance.disabled = true;
    
    updateStatusPanel("scanning", "Scanning Face...", "Align face in camera view. Detecting...");
    
    // Scan every 1 second
    scanIntervalId = setInterval(captureAndScanFrame, 1000);
}

// Stop Scanning loop
function stopAttendanceScan() {
    if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
    }
    scannerLaser.style.display = 'none';
    btnTakeAttendance.disabled = (localStream === null);
    
    if (localStream) {
        cameraStatus.innerText = "Online";
        cameraStatus.className = "status-badge online";
    }
}

// Update scanning status aesthetics
function updateStatusPanel(type, title, desc) {
    statusCard.className = `card glass-card status-card ${type}`;
    statusTitle.innerText = title;
    statusDesc.innerText = desc;
    
    let iconHTML = '';
    if (type === 'waiting' || type === 'scanning') {
        iconHTML = `<i class="fa-solid fa-shield-halved waiting-icon"></i>`;
    } else if (type === 'marked') {
        iconHTML = `<i class="fa-solid fa-circle-check success-icon"></i>`;
    } else if (type === 'already_marked') {
        iconHTML = `<i class="fa-solid fa-user-check text-warning" style="text-shadow: 0 0 10px rgba(245,158,11,0.3)"></i>`;
    } else if (type === 'unknown') {
        iconHTML = `<i class="fa-solid fa-circle-exclamation text-danger" style="text-shadow: 0 0 10px rgba(239,68,68,0.3)"></i>`;
    } else if (type === 'error') {
        iconHTML = `<i class="fa-solid fa-triangle-exclamation text-danger"></i>`;
    }
    statusIconContainer.innerHTML = iconHTML;
}

// Capture current webcam frame and run client-side recognition
async function captureAndScanFrame() {
    if (isProcessingScan || !localStream || !db) return;
    if (video.readyState < 2 || video.paused || video.ended) return;
    
    isProcessingScan = true;
    
    try {
        // Run face-api detection with improved threshold
        const options = new faceapi.TinyFaceDetectorOptions({ 
            inputSize: 224, 
            scoreThreshold: 0.4  // IMPROVED: Lowered from 0.5 to 0.4 for better detection
        });
        
        const detection = await faceapi.detectSingleFace(video, options)
                                        .withFaceLandmarks()
                                        .withFaceDescriptor();
                                        
        const ctx = overlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        
        if (!detection) {
            isProcessingScan = false;
            return;
        }
        
        const box = detection.detection.box;
        
        // Fetch registered students in this class from IndexedDB using index
        const classStudents = await getRegisteredStudentsInClass(selectedClass);
        
        let recognizedName = null;
        let minDistance = parseFloat(toleranceSlider.value); // Slider matching tolerance threshold (e.g. 0.48)
        
        if (classStudents && classStudents.length > 0) {
            classStudents.forEach(student => {
                const storedDescriptor = new Float32Array(student.descriptor);
                const distance = faceapi.euclideanDistance(detection.descriptor, storedDescriptor);
                
                if (distance < minDistance) {
                    minDistance = distance;
                    recognizedName = student.name;
                }
            });
        }
        
        // Draw face box overlay
        drawFaceBox(box, recognizedName ? "marked" : "unknown");
        
        // Handle result
        if (recognizedName) {
            stopAttendanceScan();
            
            const todayStr = new Date().toISOString().split('T')[0];
            const nowTimeStr = new Date().toTimeString().split(' ')[0];
            
            // Check if already marked present today
            const alreadyMarked = await checkAttendanceToday(selectedClass, recognizedName, todayStr);
            
            if (alreadyMarked) {
                updateStatusPanel("already_marked", "Already Marked", `${recognizedName} is already marked present today.`);
                announce(`${recognizedName} is already marked`);
            } else {
                // Save attendance record and photo to IndexedDB
                await saveAttendanceRecord(selectedClass, recognizedName, todayStr, nowTimeStr);
                await saveBase64Photo(selectedClass, recognizedName, todayStr);
                
                updateStatusPanel("marked", "Attendance Marked!", `${recognizedName} was successfully marked present.`);
                announce(`Attendance marked for ${recognizedName}`);
                loadTodayAttendance();
            }
            
            // Resume scanning after 2.5s
            setTimeout(() => {
                ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                startAttendanceScan();
            }, 2500);
            
        } else {
            // Unknown face detected
            stopAttendanceScan();
            updateStatusPanel("unknown", "Unknown Face Detected", "Unable to match face prints. Opening enrollment modal...");
            announce("Unknown face detected");
            
            // Prepare canvas capture for registration preview with improved cropping
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = 640;
            tempCanvas.height = 480;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(video, 0, 0, 640, 480);
            
            currentCapturedImage = tempCanvas.toDataURL('image/jpeg', 0.95);
            currentFaceDescriptor = Array.from(detection.descriptor); // Convert Float32Array to list for JSON serialization
            
            showRegisterModal(tempCanvas, box);
        }
    } catch (e) {
        console.error("Scan processing error:", e);
    } finally {
        isProcessingScan = false;
    }
}

// Draw rectangle on canvas
function drawFaceBox(box, status) {
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    let color = "#ef4444"; // Red for unknown
    if (status === "marked") color = "#10b981"; // Green
    
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.fillStyle = color + "20"; // translucency
    ctx.fillRect(box.x, box.y, box.width, box.height);
}

// Query registered students in a class using IndexedDB index
function getRegisteredStudentsInClass(className) {
    return new Promise((resolve) => {
        const transaction = db.transaction('students', 'readonly');
        const store = transaction.objectStore('students');
        const classIndex = store.index('class');
        const request = classIndex.getAll(className);
        
        request.onsuccess = () => {
            resolve(request.result);
        };
        request.onerror = () => {
            console.error("[DB] Error fetching students:", request.error);
            resolve([]);
        };
    });
}

// Check attendance logs for lookups using IndexedDB index
function checkAttendanceToday(className, studentName, dateStr) {
    return new Promise((resolve) => {
        const transaction = db.transaction('attendance', 'readonly');
        const store = transaction.objectStore('attendance');
        const classDateIndex = store.index('class_date');
        const request = classDateIndex.getAll([className, dateStr]);
        
        request.onsuccess = () => {
            const records = request.result;
            const exist = records.some(r => r.student === studentName);
            resolve(exist);
        };
        request.onerror = () => {
            console.error("[DB] Error checking attendance:", request.error);
            resolve(false);
        };
    });
}

// Save attendance entry to IndexedDB
function saveAttendanceRecord(className, studentName, dateStr, timeStr) {
    return new Promise((resolve) => {
        const transaction = db.transaction('attendance', 'readwrite');
        const store = transaction.objectStore('attendance');
        const request = store.add({
            class: className,
            student: studentName,
            date: dateStr,
            time: timeStr
        });
        request.onsuccess = () => resolve();
        request.onerror = () => {
            console.error("[DB] Error saving attendance:", request.error);
            resolve();
        };
    });
}

// Save captured face photos in base64 formats inside IndexedDB
function saveBase64Photo(className, studentName, dateStr) {
    return new Promise((resolve) => {
        const id = `${className.replace(/ /g, '_')}:${studentName.replace(/ /g, '_')}:${dateStr}`;
        const transaction = db.transaction('photos', 'readwrite');
        const store = transaction.objectStore('photos');
        const request = store.put({
            id: id,
            image: currentCapturedImage
        });
        request.onsuccess = () => resolve();
        request.onerror = () => {
            console.error("[DB] Error saving photo:", request.error);
            resolve();
        };
    });
}

// Show registration Modal with improved face cropping
function showRegisterModal(canvas, box) {
    const cropCtx = faceCropCanvas.getContext('2d');
    faceCropCanvas.width = 150;
    faceCropCanvas.height = 150;
    
    if (box) {
        // IMPROVED: Dynamic cropping based on detected face box
        const padX = box.width * 0.15;
        const padY = box.height * 0.15;
        
        const srcX = Math.max(0, box.x - padX);
        const srcY = Math.max(0, box.y - padY);
        const srcW = Math.min(canvas.width - srcX, box.width + (padX * 2));
        const srcH = Math.min(canvas.height - srcY, box.height + (padY * 2));
        
        cropCtx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, 150, 150);
    } else {
        // Fallback: center crop
        cropCtx.drawImage(canvas, 120, 40, 400, 400, 0, 0, 150, 150);
    }
    
    studentNameInput.value = "";
    nameError.style.display = "none";
    registerModal.classList.add('show');
    studentNameInput.focus();
}

function hideRegisterModal() {
    registerModal.classList.remove('show');
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    if (localStream) {
        startAttendanceScan();
    }
}

// Submit registration modal form with improved validation
async function submitRegistration() {
    let name = studentNameInput.value.trim();
    
    // IMPROVED: Better input validation
    if (!name) {
        nameError.innerText = "Please enter a valid student name.";
        nameError.style.display = "block";
        studentNameInput.focus();
        return;
    }
    
    // Remove special characters, keep only alphanumeric and spaces
    name = name.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    
    if (name.length < 2) {
        nameError.innerText = "Student name must be at least 2 characters.";
        nameError.style.display = "block";
        studentNameInput.focus();
        return;
    }
    
    if (name.length > 50) {
        nameError.innerText = "Student name is too long (max 50 characters).";
        nameError.style.display = "block";
        studentNameInput.focus();
        return;
    }
    
    nameError.style.display = "none";
    btnSubmitRegister.disabled = true;
    
    try {
        const studentId = `${selectedClass.replace(/ /g, '_')}:${name.replace(/ /g, '_')}`;
        
        // Save student encoding to database
        const transaction = db.transaction('students', 'readwrite');
        const store = transaction.objectStore('students');
        
        const saveRequest = store.put({
            id: studentId,
            class: selectedClass,
            name: name,
            descriptor: currentFaceDescriptor
        });
        
        saveRequest.onsuccess = async () => {
            const todayStr = new Date().toISOString().split('T')[0];
            const nowTimeStr = new Date().toTimeString().split(' ')[0];
            
            // Mark attendance immediately
            await saveAttendanceRecord(selectedClass, name, todayStr, nowTimeStr);
            await saveBase64Photo(selectedClass, name, todayStr);
            
            registerModal.classList.remove('show');
            updateStatusPanel("marked", "Enrolled & Marked!", `${name} has been enrolled and marked present.`);
            announce(`Successfully registered and marked present for ${name}`);
            
            // Refresh class autocomplete list and table logs
            await fetchClasses();
            loadTodayAttendance();
            
            setTimeout(() => {
                const ctx = overlayCanvas.getContext('2d');
                ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                startAttendanceScan();
            }, 2500);
        };
        
        saveRequest.onerror = () => {
            console.error("[DB] Error registering student:", saveRequest.error);
            alert("Database save operation failed.");
        };
    } catch (e) {
        console.error("Register face error:", e);
        alert("Database save operation failed.");
    } finally {
        btnSubmitRegister.disabled = false;
    }
}

// Load today's logs for table display
function loadTodayAttendance() {
    if (!selectedClass || !db) return;
    
    const todayStr = new Date().toISOString().split('T')[0];
    const transaction = db.transaction('attendance', 'readonly');
    const store = transaction.objectStore('attendance');
    const classDateIndex = store.index('class_date');
    const request = classDateIndex.getAll([selectedClass, todayStr]);
    
    request.onsuccess = () => {
        const records = request.result;
        
        logCount.innerText = records.length;
        attendanceLogBody.innerHTML = "";
        
        if (records.length === 0) {
            attendanceLogBody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="3">
                        <div class="empty-state">
                            <i class="fa-solid fa-clipboard-question empty-icon"></i>
                            <p>No attendance marked yet today.</p>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }
        
        records.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${r.student}</strong></td>
                <td>${r.time}</td>
                <td><span class="status-cell-badge present"><i class="fa-solid fa-check"></i> Present</span></td>
            `;
            attendanceLogBody.appendChild(tr);
        });
    };
    
    request.onerror = () => {
        console.error("[DB] Error loading attendance:", request.error);
    };
}

// Generate premium styled Excel sheet directly inside phone's browser
async function exportToExcel() {
    if (!selectedClass || !db) {
        alert("Please type a class name before exporting.");
        classInput.focus();
        return;
    }
    
    // Fetch students list
    const registered = await getRegisteredStudentsInClass(selectedClass);
    if (!registered || registered.length === 0) {
        alert(`No students registered in class '${selectedClass}' yet.`);
        return;
    }
    
    const studentNames = registered.map(s => s.name).sort();
    
    // Fetch all logs
    const transaction = db.transaction('attendance', 'readonly');
    const store = transaction.objectStore('attendance');
    const request = store.getAll();
    
    request.onsuccess = async () => {
        const logs = request.result.filter(r => r.class === selectedClass);
        const uniqueDates = Array.from(new Set(logs.map(r => r.date))).sort();
        
        // Date range filtering
        const range = reportRange.value;
        const today = new Date();
        let filteredDates = [...uniqueDates];
        
        if (range === "this_week") {
            const limit = new Date();
            limit.setDate(today.getDate() - 7);
            filteredDates = uniqueDates.filter(d_str => new Date(d_str) >= limit);
        } else if (range === "this_month") {
            const limit = new Date();
            limit.setDate(today.getDate() - 30);
            filteredDates = uniqueDates.filter(d_str => new Date(d_str) >= limit);
        }
        
        // Initialize Workbook using ExcelJS library
        const workbook = new ExcelJS.Workbook();
        
        // Sheet 1: Matrix
        const ws_matrix = workbook.addWorksheet("Attendance Matrix");
        ws_matrix.views = [{ showGridLines: true }];
        
        // Set column widths
        ws_matrix.getColumn(1).width = 24; // Student Name
        ws_matrix.getColumn(2).width = 15; // Class
        
        // Styles
        const navyFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
        const redFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5D5' } };
        const greenFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2EFDA' } };
        const alertRedFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C00000' } };
        const altRowFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F2F2F2' } };
        const warningYellowFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
        
        const titleFont = { name: 'Calibri', size: 16, bold: true, color: { argb: '1F4E78' } };
        const subtitleFont = { name: 'Calibri', size: 10, italic: true };
        const headerFont = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        const boldFont = { name: 'Calibri', size: 11, bold: true };
        const regularFont = { name: 'Calibri', size: 11 };
        const redTextFont = { name: 'Calibri', size: 11, bold: true, color: { argb: 'C00000' } };
        const greenTextFont = { name: 'Calibri', size: 11, color: { argb: '375623' } };
        
        const thinBorder = {
            top: { style: 'thin', color: { argb: 'D9D9D9' } },
            left: { style: 'thin', color: { argb: 'D9D9D9' } },
            bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
            right: { style: 'thin', color: { argb: 'D9D9D9' } }
        };
        
        const centerAlign = { horizontal: 'center', vertical: 'middle' };
        const leftAlign = { horizontal: 'left', vertical: 'middle' };
        
        // Add Title
        const titleCell = ws_matrix.getCell('A1');
        titleCell.value = `Attendance Record - ${selectedClass}`;
        titleCell.font = titleFont;
        ws_matrix.getRow(1).height = 30;
        
        // Subtitle
        const subtitleCell = ws_matrix.getCell('A2');
        const periodText = range === 'all_time' ? 'All Time' : (range === 'this_week' ? 'Last 7 Days' : 'Last 30 Days');
        subtitleCell.value = `Report Generated on: ${today.toLocaleDateString()} | Date Range: ${periodText}`;
        subtitleCell.font = subtitleFont;
        ws_matrix.getRow(2).height = 18;
        
        // Headers row (row 4)
        const headers = ["Student Name", "Class"].concat(filteredDates).concat(["Total Sessions", "Present", "Attendance %"]);
        ws_matrix.getRow(4).values = headers;
        ws_matrix.getRow(4).height = 25;
        
        // Format Headers
        headers.forEach((h, i) => {
            const cell = ws_matrix.getCell(4, i + 1);
            cell.fill = navyFill;
            cell.font = headerFont;
            cell.alignment = centerAlign;
            cell.border = thinBorder;
            
            // Adjust dates columns width
            if (i > 1 && i < headers.length - 3) {
                ws_matrix.getColumn(i + 1).width = 14;
            }
        });
        ws_matrix.getColumn(headers.length - 2).width = 15;
        ws_matrix.getColumn(headers.length - 1).width = 12;
        ws_matrix.getColumn(headers.length).width = 15;
        
        const redListStudents = [];
        
        // Add Student Records (starts at row 5)
        studentNames.forEach((student, index) => {
            const rowNum = 5 + index;
            const row = ws_matrix.getRow(rowNum);
            row.height = 20;
            
            let presentCount = 0;
            const values = [student, selectedClass];
            
            filteredDates.forEach(dateStr => {
                const wasPresent = logs.some(r => r.student === student && r.date === dateStr);
                if (wasPresent) {
                    values.push("P");
                    presentCount++;
                } else {
                    values.push("A");
                }
            });
            
            const totalSessions = filteredDates.length;
            const pct = totalSessions > 0 ? ((presentCount / totalSessions) * 100) : 100.0;
            
            values.push(totalSessions, presentCount, `${pct.toFixed(1)}%`);
            row.values = values;
            
            // Flag below 75%
            if (pct < 75.0) {
                redListStudents.push({
                    name: student,
                    pct: pct,
                    present: presentCount,
                    total: totalSessions
                });
            }
            
            // Format cells
            const isAlt = index % 2 === 1;
            const rowBg = isAlt ? altRowFill : null;
            
            // Student Name
            const nameC = ws_matrix.getCell(rowNum, 1);
            nameC.font = boldFont;
            nameC.alignment = leftAlign;
            nameC.border = thinBorder;
            if (rowBg) nameC.fill = rowBg;
            
            // Class
            const classC = ws_matrix.getCell(rowNum, 2);
            classC.font = regularFont;
            classC.alignment = leftAlign;
            classC.border = thinBorder;
            if (rowBg) classC.fill = rowBg;
            
            // Status codes
            filteredDates.forEach((_, dIdx) => {
                const colIdx = 3 + dIdx;
                const cell = ws_matrix.getCell(rowNum, colIdx);
                cell.alignment = centerAlign;
                cell.border = thinBorder;
                
                if (cell.value === "P") {
                    cell.fill = greenFill;
                    cell.font = greenTextFont;
                } else {
                    cell.fill = redFill;
                    cell.font = redTextFont;
                }
            });
            
            // Summaries
            const startSumCol = 3 + filteredDates.length;
            
            const totC = ws_matrix.getCell(rowNum, startSumCol);
            totC.font = regularFont;
            totC.alignment = centerAlign;
            totC.border = thinBorder;
            if (rowBg) totC.fill = rowBg;
            
            const presC = ws_matrix.getCell(rowNum, startSumCol + 1);
            presC.font = regularFont;
            presC.alignment = centerAlign;
            presC.border = thinBorder;
            if (rowBg) presC.fill = rowBg;
            
            const pctC = ws_matrix.getCell(rowNum, startSumCol + 2);
            pctC.alignment = centerAlign;
            pctC.border = thinBorder;
            
            if (pct < 75.0) {
                pctC.fill = warningYellowFill;
                pctC.font = redTextFont;
            } else {
                pctC.font = boldFont;
                if (rowBg) pctC.fill = rowBg;
            }
        });
        
        // Sheet 2: Defaulter Red List
        const ws_red = workbook.addWorksheet("Red List (<75%)");
        ws_red.views = [{ showGridLines: true }];
        
        ws_red.getColumn(1).width = 24;
        ws_red.getColumn(2).width = 15;
        ws_red.getColumn(3).width = 15;
        ws_red.getColumn(4).width = 16;
        ws_red.getColumn(5).width = 14;
        ws_red.getColumn(6).width = 18;
        
        // Red List Title
        const redTitleCell = ws_red.getCell('A1');
        redTitleCell.value = `Defaulter List (Attendance < 75%) - ${selectedClass}`;
        redTitleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'C00000' } };
        ws_red.getRow(1).height = 30;
        
        // Red List Subtitle
        const redSub = ws_red.getCell('A2');
        redSub.value = `Evaluation Criteria: Attendance below 75% | Evaluated: ${today.toLocaleDateString()}`;
        redSub.font = subtitleFont;
        ws_red.getRow(2).height = 18;
        
        // Red List Headers
        const redHeaders = ["Student Name", "Class", "Attendance %", "Classes Attended", "Total Classes", "Status"];
        ws_red.getRow(4).values = redHeaders;
        ws_red.getRow(4).height = 25;
        
        redHeaders.forEach((_, i) => {
            const cell = ws_red.getCell(4, i + 1);
            cell.fill = alertRedFill;
            cell.font = headerFont;
            cell.alignment = centerAlign;
            cell.border = thinBorder;
        });
        
        // Populate Red List row details
        if (redListStudents.length === 0) {
            const emptyRow = ws_red.getRow(5);
            emptyRow.height = 25;
            ws_red.mergeCells('A5:F5');
            const cell = ws_red.getCell('A5');
            cell.value = "No students found with attendance below 75% for this period.";
            cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: '595959' } };
            cell.alignment = centerAlign;
            cell.border = thinBorder;
        } else {
            redListStudents.forEach((s, index) => {
                const rNum = 5 + index;
                const row = ws_red.getRow(rNum);
                row.height = 22;
                
                row.values = [
                    s.name,
                    selectedClass,
                    `${s.pct.toFixed(1)}%`,
                    s.present,
                    s.total,
                    "CRITICAL ALERT"
                ];
                
                for (let colIdx = 1; colIdx <= 6; colIdx++) {
                    const c = ws_red.getCell(rNum, colIdx);
                    c.border = thinBorder;
                    c.fill = warningYellowFill;
                    c.alignment = colIdx <= 2 ? leftAlign : centerAlign;
                    
                    if (colIdx === 1) {
                        c.font = boldFont;
                    } else if (colIdx === 3) {
                        c.font = redTextFont;
                    } else if (colIdx === 6) {
                        c.font = redTextFont;
                        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5D5' } };
                    } else {
                        c.font = regularFont;
                    }
                }
            });
        }
        
        // Generate buffer and trigger browser download
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        
        const filename = `${selectedClass.replace(/ /g, '_')}_attendance_${range}_${new Date().toISOString().split('T')[0]}.xlsx`;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
    };
}

// Database backup utility (Exports IndexedDB stores to JSON)
async function backupDatabase() {
    if (!db) return;
    updateStatusPanel("waiting", "Creating Backup...", "Preparing backup package of local database logs...");
    
    try {
        const backupData = {
            students: [],
            attendance: [],
            photos: []
        };
        
        // 1. Fetch Students
        backupData.students = await new Promise((resolve) => {
            const tx = db.transaction('students', 'readonly');
            const store = tx.objectStore('students');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
        
        // 2. Fetch Attendance
        backupData.attendance = await new Promise((resolve) => {
            const tx = db.transaction('attendance', 'readonly');
            const store = tx.objectStore('attendance');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
        
        // 3. Fetch Photos
        backupData.photos = await new Promise((resolve) => {
            const tx = db.transaction('photos', 'readonly');
            const store = tx.objectStore('photos');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
        
        // Download as JSON
        const jsonStr = JSON.stringify(backupData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        
        const todayStr = new Date().toISOString().split('T')[0];
        const filename = `aegis_attendance_backup_${todayStr}.json`;
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        
        updateStatusPanel("waiting", "Backup Complete", "Database logs downloaded successfully.");
        announce("Database backup downloaded successfully");
    } catch (e) {
        console.error("Backup failed:", e);
        alert("Database backup failed: " + e.message);
    }
}

// Database restore utility (Restores JSON backup to IndexedDB)
function restoreDatabase(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const data = JSON.parse(event.target.result);
            if (!data.students || !data.attendance || !data.photos) {
                alert("Invalid backup file. Missing database stores.");
                return;
            }
            
            updateStatusPanel("waiting", "Restoring Database...", "Writing backup records to browser IndexedDB...");
            
            // 1. Clear and Write Students
            await new Promise((resolve, reject) => {
                const tx = db.transaction('students', 'readwrite');
                const store = tx.objectStore('students');
                store.clear();
                data.students.forEach(s => store.put(s));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            
            // 2. Clear and Write Attendance
            await new Promise((resolve, reject) => {
                const tx = db.transaction('attendance', 'readwrite');
                const store = tx.objectStore('attendance');
                store.clear();
                data.attendance.forEach(a => store.add(a));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            
            // 3. Clear and Write Photos
            await new Promise((resolve, reject) => {
                const tx = db.transaction('photos', 'readwrite');
                const store = tx.objectStore('photos');
                store.clear();
                data.photos.forEach(p => store.put(p));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            
            alert("Database restored successfully!");
            updateStatusPanel("waiting", "Restore Success", "Local database restored. Reloading UI...");
            announce("Database restored successfully");
            
            // Reload UI listings
            await fetchClasses();
            loadTodayAttendance();
        } catch (err) {
            console.error("Restore failed:", err);
            alert("Database restore failed: " + err.message);
        } finally {
            restoreFileInput.value = ""; // Reset file input
        }
    };
    reader.readAsText(file);
}
