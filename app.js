// This is the core logic for the PWA. It handles continuous recording, API calls, and UI updates.

// --- API Configuration ---
// IMPORTANT: Replace this with your actual Gemini API key.
// You can get one from the Google AI Studio or Google Cloud Console.
const GEMINI_API_KEY = "AIzaSyAASt9ZpFshMEu9cWXBO13y14IxQ8NtEF4";

// The entire script is now wrapped in a DOMContentLoaded listener
// to ensure the HTML elements are available before the script runs.
document.addEventListener('DOMContentLoaded', () => {

    // --- DOM Elements ---
    const recordButton = document.getElementById('recordButton');
    const stopButton = document.getElementById('stopButton');
    const clearButton = document.getElementById('clearButton');
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
    let mediaStream = null;
    let audioContext;
    let analyserNode;
    let scriptProcessor;
    let fullTranscript = "";
    let shouldContinueRecording = false;
    let recordingTimeout = null;

    // --- Configuration Constants ---
    const CHUNK_DURATION_MS = 15000; // 15 seconds per recording chunk
    const SILENCE_TIMEOUT_MS = 15000; // 15 seconds of silence stops the loop

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

    // --- Continuous Recording and Analysis Logic ---
    const recordAndAnalyzeChunk = async () => {
        if (!shouldContinueRecording) {
            return; // Exit the loop
        }

        try {
            if (!mediaStream) {
                // Get screen audio for the first time
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });
                const audioTrack = mediaStream.getAudioTracks()[0];
                if (!audioTrack) {
                    stopRecording();
                    showModal('Audio not captured', 'Please ensure you select a source with audio when prompted.');
                    return;
                }

                // Setup silence detection
                audioContext = new AudioContext();
                const source = audioContext.createMediaStreamSource(mediaStream);
                analyserNode = audioContext.createAnalyser();
                scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);
                source.connect(analyserNode);
                analyserNode.connect(scriptProcessor);
                scriptProcessor.connect(audioContext.destination);

                let lastActiveTime = Date.now();
                scriptProcessor.onaudioprocess = (event) => {
                    const input = event.inputBuffer.getChannelData(0);
                    let sum = 0;
                    for (let i = 0; i < input.length; ++i) {
                        sum += input[i] * input[i];
                    }
                    const rms = Math.sqrt(sum / input.length);

                    if (rms > 0.01) {
                        lastActiveTime = Date.now();
                    }

                    if (Date.now() - lastActiveTime > SILENCE_TIMEOUT_MS) {
                        console.log("Silence detected, stopping recording loop.");
                        stopRecording();
                    }
                };
            }

            mediaRecorder = new MediaRecorder(mediaStream);
            audioChunks = []; // Clear chunks for the new session

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    audioChunks.push(e.data);
                }
            };

            mediaRecorder.onstop = async () => {
                if (audioChunks.length > 0) {
                    // No need to show a loading spinner, just process in the background
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const reader = new FileReader();
                    reader.readAsDataURL(audioBlob);
                    reader.onloadend = async () => {
                        const base64data = reader.result.split(',')[1];
                        try {
                            const newTranscript = await getTranscriptionWithDiarization(base64data);
                            fullTranscript += newTranscript;
                            renderTranscript(fullTranscript);
                            
                            const personalityProfiles = await getPersonalityAnalysis(fullTranscript);
                            renderPersonalityProfiles(personalityProfiles);
                        } catch (e) {
                            console.error('Error during transcription or analysis:', e);
                            showModal('Analysis Failed', `An error occurred while processing the audio. Please check the console for details.`);
                            stopRecording(); // Stop the loop on error
                        } finally {
                            if (shouldContinueRecording) {
                                recordAndAnalyzeChunk(); // Loop back for the next chunk
                            }
                        }
                    };
                } else {
                     if (shouldContinueRecording) {
                        recordAndAnalyzeChunk(); // Loop back even if there's no audio
                    }
                }
            };

            // Start the recording without a duration, then manually stop it with a timeout
            mediaRecorder.start();
            recordingTimeout = setTimeout(() => {
                if (mediaRecorder.state !== 'inactive') {
                    mediaRecorder.stop();
                }
            }, CHUNK_DURATION_MS);

            // Handle user cancelling screen sharing
            mediaStream.addEventListener('inactive', () => {
                if (shouldContinueRecording) {
                    stopRecording();
                    showModal('Recording Stopped', 'Screen sharing was cancelled.');
                }
            });

        } catch (e) {
            console.error('Error accessing screen/audio:', e);
            stopRecording();
            if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') {
                showModal('Screen/Audio Access Denied', 'You must grant permission and select a source with audio to record system audio.');
            } else if (e.name === 'NotSupportedError') {
                showModal('Recording Error', `Your browser does not support the requested recording settings. This may be a browser-specific issue. Try another browser.`);
            } else {
                showModal('Error', `An unexpected error occurred: ${e.message}`);
            }
        }
    };

    // --- Main Event Handlers ---
    const startRecording = () => {
        if (!GEMINI_API_KEY) {
            showModal('API Key Missing', 'Please enter your Gemini API key in `app.js` to use this feature.');
            return;
        }
        shouldContinueRecording = true;
        recordButton.disabled = true;
        stopButton.disabled = false;
        clearButton.disabled = true;

        recordButton.classList.add('hidden');
        stopButton.classList.remove('hidden');

        showResults(); // Ensure results sections are visible from the start

        recordAndAnalyzeChunk(); // Start the first chunk
    };

    const stopRecording = () => {
        shouldContinueRecording = false;
        if (recordingTimeout) {
            clearTimeout(recordingTimeout);
        }
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        // Update UI state after the recording has actually stopped
        setTimeout(() => {
            recordButton.disabled = false;
            stopButton.disabled = true;
            clearButton.disabled = false;
            
            recordButton.classList.remove('hidden');
            stopButton.classList.add('hidden');
        }, 500); // Give a small delay to ensure onstop is called
    };

    const clearSession = () => {
        fullTranscript = "";
        transcriptDiv.innerHTML = '';
        personalityDiv.innerHTML = '';
        hideStatus();
        resultsSection.classList.add('hidden'); // Re-hide the results section
        showStatus('Ready to record new session.', false);
        stopButton.disabled = true;
        recordButton.disabled = false;
        clearButton.disabled = false;
    };

    // --- Event Listeners ---
    recordButton.addEventListener('click', startRecording);
    stopButton.addEventListener('click', stopRecording);
    clearButton.addEventListener('click', clearSession);
    modalCloseButton.addEventListener('click', hideModal);
});
