// This is the core logic for the PWA. It handles recording, API calls, and UI updates.

// --- API Configuration ---
// IMPORTANT: Replace this with your actual Gemini API key.
// You can get one from the Google AI Studio or Google Cloud Console.
const GEMINI_API_KEY = "AIzaSyAASt9ZpFshMEu9cWXBO13y14IxQ8NtEF4";

// --- DOM Elements ---
const recordButton = document.getElementById('recordButton');
const stopButton = document.getElementById('stopButton');
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');
const loadingSpinner = document.getElementById('loading');
const resultsSection = document.getElementById('results');
const transcriptDiv = document.getElementById('transcript');
const personalityDiv = document.getElementById('personality-analysis');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalCloseButton = document.getElementById('modalCloseButton');

// --- Global Variables ---
let mediaRecorder;
let audioChunks = [];
let audioBlob;
let isRecording = false;

// --- Utility Functions ---
const showModal = (title, message) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modal.classList.remove('hidden');
};

const hideModal = () => {
    modal.classList.add('hidden');
};

const showStatus = (text, isLoading = false) => {
    statusDiv.classList.remove('hidden');
    statusText.textContent = text;
    if (isLoading) {
        loadingSpinner.classList.remove('hidden');
    } else {
        loadingSpinner.classList.add('hidden');
    }
    resultsSection.classList.add('hidden');
};

const hideStatus = () => {
    statusDiv.classList.add('hidden');
};

const showResults = () => {
    resultsSection.classList.remove('hidden');
    hideStatus();
};

const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

// --- API Calls ---

// Function to call the Gemini API with exponential backoff
const fetchWithBackoff = async (url, options, retries = 5, delay = 1000) => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            if (response.status === 429 && retries > 0) { // Too Many Requests
                console.warn(`API call failed with status ${response.status}. Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                return fetchWithBackoff(url, options, retries - 1, delay * 2);
            }
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }
        return response;
    } catch (error) {
        if (retries > 0) {
            console.warn(`Fetch error: ${error.message}. Retrying in ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
            return fetchWithBackoff(url, options, retries - 1, delay * 2);
        }
        throw error;
    }
};

// Transcribes audio and identifies speakers using Gemini
const getTranscriptionWithDiarization = async (audioData) => {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    {
                        text: "Transcribe the following audio conversation, identifying each distinct speaker as 'Speaker 1', 'Speaker 2', etc. Provide the output as a simple transcript, with each line beginning with the speaker's label.",
                    },
                    {
                        inlineData: {
                            mimeType: "audio/webm",
                            data: audioData
                        }
                    }
                ]
            }
        ]
    };

    try {
        const response = await fetchWithBackoff(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new Error("Could not get transcription from API response.");
        }
        return text;
    } catch (e) {
        console.error('Error during transcription:', e);
        throw e;
    }
};

// Analyzes the personality of each speaker based on the DISC model
const getPersonalityAnalysis = async (transcript) => {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `Analyze the following transcript of a conversation. For each speaker identified (e.g., 'Speaker 1'), propose a personality profile based *only* on their dialogue, using the DISC model: Dominance (D), Influence (I), Steadiness (S), and Conscientiousness (C). Categorize each speaker into one of the four main categories based on the strongest indicator in their speech.
    
    Transcript:
    ${transcript}
    
    Please provide the output in a JSON format. The JSON should be an array of objects, where each object has two properties: 'speaker' (e.g., "Speaker 1") and 'discProfile' (the category, e.g., "Dominance").`;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: prompt }
                ]
            }
        ],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        "speaker": { "type": "STRING" },
                        "discProfile": { "type": "STRING" }
                    },
                    "propertyOrdering": ["speaker", "discProfile"]
                }
            }
        }
    };

    try {
        const response = await fetchWithBackoff(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) {
            throw new Error("Could not get personality analysis from API response.");
        }
        return JSON.parse(jsonText);
    } catch (e) {
        console.error('Error during personality analysis:', e);
        throw e;
    }
};

// --- UI Rendering ---

const renderTranscript = (transcript) => {
    const formattedTranscript = transcript.split('\n').map(line => {
        const parts = line.match(/^(Speaker \d+): (.*)/);
        if (parts && parts.length === 3) {
            return `<p class="mb-2"><strong class="font-semibold text-blue-600">${parts[1]}:</strong> ${parts[2]}</p>`;
        }
        return `<p class="mb-2 text-gray-800">${line}</p>`;
    }).join('');
    transcriptDiv.innerHTML = formattedTranscript;
};

const renderPersonalityProfiles = (profiles) => {
    personalityDiv.innerHTML = '';
    const profileColors = {
        'Dominance': 'bg-red-100 border-red-400 text-red-800',
        'Influence': 'bg-yellow-100 border-yellow-400 text-yellow-800',
        'Steadiness': 'bg-green-100 border-green-400 text-green-800',
        'Conscientiousness': 'bg-blue-100 border-blue-400 text-blue-800',
    };

    const profileDescriptions = {
        'Dominance': 'Direct, assertive, and results-oriented. Focused on goals and taking charge.',
        'Influence': 'Outgoing, optimistic, and enthusiastic. Enjoys collaboration and influencing others.',
        'Steadiness': 'Patient, dependable, and cooperative. Values stability and harmony.',
        'Conscientiousness': 'Analytical, precise, and systematic. Focused on quality and accuracy.',
    };

    profiles.forEach(profile => {
        const card = document.createElement('div');
        const colorClass = profileColors[profile.discProfile] || 'bg-gray-100 border-gray-400 text-gray-800';
        const description = profileDescriptions[profile.discProfile] || 'Unknown profile.';
        card.className = `p-4 rounded-lg border-2 ${colorClass} shadow-md`;
        card.innerHTML = `
            <h4 class="font-bold text-lg mb-1">${profile.speaker}</h4>
            <p class="font-semibold mb-2">${profile.discProfile}</p>
            <p class="text-sm">${description}</p>
        `;
        personalityDiv.appendChild(card);
    });
};

// --- Event Handlers ---

const startRecording = async () => {
    // Check if API key is set
    if (!GEMINI_API_KEY) {
        showModal('API Key Missing', 'Please enter your Gemini API key in `app.js` to use this feature.');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        
        mediaRecorder.ondataavailable = (e) => {
            audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            isRecording = false;
            stopButton.disabled = true;
            stopButton.classList.add('hidden');
            recordButton.classList.remove('hidden');

            audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = async () => {
                const base64data = reader.result.split(',')[1];
                
                try {
                    showStatus('Transcribing audio and identifying speakers...', true);
                    const transcript = await getTranscriptionWithDiarization(base64data);
                    renderTranscript(transcript);
                    
                    showStatus('Analyzing personalities...', true);
                    const personalityProfiles = await getPersonalityAnalysis(transcript);
                    renderPersonalityProfiles(personalityProfiles);

                    showResults();

                } catch (e) {
                    showModal('Analysis Failed', `An error occurred: ${e.message}`);
                    console.error(e);
                    hideStatus();
                }
            };
        };

        // Start recording
        audioChunks = [];
        mediaRecorder.start();
        isRecording = true;
        recordButton.disabled = true;
        recordButton.classList.add('hidden');
        stopButton.disabled = false;
        stopButton.classList.remove('hidden');
        showStatus('Recording...', false);
        resultsSection.classList.add('hidden');

    } catch (e) {
        console.error('Error accessing microphone:', e);
        showModal('Microphone Access Denied', 'Please allow microphone access to use the recording feature.');
    }
};

const stopRecording = () => {
    if (isRecording && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
};

// --- Event Listeners ---
recordButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);
modalCloseButton.addEventListener('click', hideModal);

