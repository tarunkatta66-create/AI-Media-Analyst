import React, { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.webm'];
const SUPPORTED_EXTENSIONS_WITH_MP4 = [...SUPPORTED_EXTENSIONS, '.mp4'];
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120;

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

function getFileExtension(name) {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx).toLowerCase();
}

function isValidExtension(ext) {
  return SUPPORTED_EXTENSIONS_WITH_MP4.includes(ext);
}

async function getIdToken(user) {
  if (!user) return null;
  return user.getIdToken();
}

function Upload({ user }) {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [stepStates, setStepStates] = useState({
    uploadDone: false,
    submitDone: false,
    pollDone: false,
  });
  const [pollAttempt, setPollAttempt] = useState(0);
  const [transcript, setTranscript] = useState(null);
  const [copyState, setCopyState] = useState('idle');

  const pollTimeoutRef = useRef(null);
  const activeXhrRef = useRef(null);
  const transcriptIdRef = useRef(null);

  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'YOUR_API_GATEWAY_URL_HERE';

  const resetState = useCallback(() => {
    setStatus('idle');
    setError('');
    setUploadProgress(0);
    setStepStates({ uploadDone: false, submitDone: false, pollDone: false });
    setPollAttempt(0);
    setTranscript(null);
    setCopyState('idle');
    setFile(null);
    transcriptIdRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      if (activeXhrRef.current) activeXhrRef.current.abort();
    };
  }, []);

  const validateFile = (f) => {
    if (!f) return 'No file selected.';
    if (f.size > MAX_FILE_SIZE_BYTES) return 'File is too large. Maximum size is 500 MB.';
    const ext = getFileExtension(f.name);
    if (!isValidExtension(ext)) return 'Unsupported file type. Use mp3, wav, m4a, ogg, flac, webm, or mp4.';
    return null;
  };

  const handleFileSelect = (selectedFile) => {
    const validationError = validateFile(selectedFile);
    if (validationError) { setError(validationError); setFile(null); return; }
    setError('');
    setFile(selectedFile);
  };

  const onInputChange = (event) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) handleFileSelect(selectedFile);
  };

  const onDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile) handleFileSelect(droppedFile);
  };

  const onDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  // ── Step 1: Get presigned URL ──────────────────────────────────────────
  // FIX: only send filename — Lambda no longer uses or returns contentType
  const getUploadUrl = async (firebaseIdToken) => {
    const res = await fetch(`${apiBaseUrl}/get-upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firebaseIdToken}`,
      },
      body: JSON.stringify({ filename: file.name }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get upload URL (${res.status}). ${text || 'Check API Gateway logs.'}`);
    }

    return res.json(); // { uploadUrl, fileKey }
  };

  // ── Step 2: PUT file to S3 ─────────────────────────────────────────────
  // FIX 1: no contentType parameter — we use file.type directly from the browser.
  // FIX 2: presigned URL no longer signs ContentType, so S3 accepts any value.
  // FIX 3: only set Content-Type header if file.type is a real non-empty string.
  const uploadToS3 = (uploadUrl) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrRef.current = xhr;
      xhr.open('PUT', uploadUrl);

      // Use the browser's file.type directly — the only reliable source.
      // Do NOT use contentType from Lambda — that caused the 403.
      const mimeType = file.type;
      if (mimeType && mimeType.trim() !== '') {
        xhr.setRequestHeader('Content-Type', mimeType);
      }

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setUploadProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      xhr.onload = () => {
        activeXhrRef.current = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress(100);
          resolve();
        } else if (xhr.status === 403) {
          reject(new Error('Upload forbidden (403). Check S3 CORS and IAM permissions.'));
        } else if (xhr.status === 400) {
          reject(new Error('Upload failed with 400. Check S3 bucket CORS AllowedMethods includes PUT.'));
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}.`));
        }
      };

      xhr.onerror = () => {
        activeXhrRef.current = null;
        reject(new Error('Network error during upload. Please try again.'));
      };

      xhr.onabort = () => {
        activeXhrRef.current = null;
        reject(new Error('Upload aborted.'));
      };

      xhr.send(file);
    });

  const startTranscription = async (firebaseIdToken, fileKey) => {
    const res = await fetch(`${apiBaseUrl}/start-transcription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firebaseIdToken}`,
      },
      body: JSON.stringify({ fileKey }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to start transcription (${res.status}). ${text || 'Check Lambda logs.'}`);
    }

    return res.json();
  };

  const getTranscript = async (firebaseIdToken, id) => {
    const res = await fetch(`${apiBaseUrl}/get-transcript?id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${firebaseIdToken}` },
    });

    if (!res.ok) {
      if (res.status === 404) {
        const text = await res.text();
        throw new Error(text || 'Transcript not found (404).');
      }
      if (res.status === 401) throw new Error('Unauthorized (401). Check API key or auth configuration.');
      const text = await res.text();
      throw new Error(`Failed to fetch transcript (${res.status}). ${text || 'Check AssemblyAI status.'}`);
    }

    return res.json();
  };

  const scheduleNextPoll = (fn) => {
    pollTimeoutRef.current = setTimeout(fn, POLL_INTERVAL_MS);
  };

  const pollTranscript = useCallback(
    async (firebaseIdToken) => {
      if (!transcriptIdRef.current) return;

      try {
        setPollAttempt((prev) => prev + 1);
        const attemptNum = pollAttempt + 1;

        if (attemptNum > MAX_POLL_ATTEMPTS) {
          setStatus('error');
          setError('Transcription is taking too long (over 6 minutes). Please try again with a shorter file.');
          setStepStates((prev) => ({ ...prev, pollDone: false }));
          return;
        }

        const data = await getTranscript(firebaseIdToken, transcriptIdRef.current);

        if (data.status === 'completed') {
          setStatus('done');
          setTranscript({
            transcriptId: data.transcriptId,
            text: data.text,
            confidence: data.confidence,
            audioDuration: data.audioDuration,
            words: data.words || [],
          });
          setStepStates((prev) => ({ ...prev, pollDone: true }));
          return;
        }

        if (data.status === 'error') {
          setStatus('error');
          setError(data.error || 'Transcription failed on AssemblyAI.');
          setStepStates((prev) => ({ ...prev, pollDone: false }));
          return;
        }

        setStatus('polling');
        scheduleNextPoll(() => pollTranscript(firebaseIdToken));
      } catch (err) {
        setStatus('error');
        setError(err.message || 'Unexpected error while polling transcript.');
        setStepStates((prev) => ({ ...prev, pollDone: false }));
      }
    },
    [pollAttempt],
  );

  // ── Main submit handler ────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!file) { setError('Please select a file first.'); return; }

    const validationError = validateFile(file);
    if (validationError) { setError(validationError); return; }

    setError('');
    setStatus('uploading');
    setUploadProgress(0);
    setStepStates({ uploadDone: false, submitDone: false, pollDone: false });

    try {
      const token = await getIdToken(user);
      if (!token) throw new Error('Unable to retrieve authentication token. Please sign in again.');

      // FIX: destructure only uploadUrl and fileKey — no contentType
      const { uploadUrl, fileKey } = await getUploadUrl(token);

      // FIX: pass only uploadUrl — file.type is read inside uploadToS3
      await uploadToS3(uploadUrl);
      setStepStates((prev) => ({ ...prev, uploadDone: true }));

      setStatus('submitting');
      const { transcriptId } = await startTranscription(token, fileKey);
      transcriptIdRef.current = transcriptId;
      setStepStates((prev) => ({ ...prev, submitDone: true }));

      setStatus('polling');
      setPollAttempt(0);
      scheduleNextPoll(() => pollTranscript(token));
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Unexpected error during upload or transcription start.');
    }
  };

  const handleCopy = async () => {
    if (!transcript?.text) return;
    try {
      await navigator.clipboard.writeText(transcript.text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch { /* ignore */ }
  };

  const onSignOut = async () => {
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    if (activeXhrRef.current) activeXhrRef.current.abort();
    await signOut(auth);
  };

  const isBusy = status === 'uploading' || status === 'submitting' || status === 'polling';

  const pollingLabel =
    status === 'polling'
      ? `Transcribing… (check ${pollAttempt}/${MAX_POLL_ATTEMPTS})`
      : 'Transcribing…';

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-left">
          <div className="header-icon">
            <span role="img" aria-label="Microphone">🎙️</span>
          </div>
          <div className="header-text">
            <span className="header-title">AI MEDIA ANALYST</span>
            <span className="header-subtitle">Secure, accurate, and fast audio transcription.</span>
          </div>
        </div>
        <div className="header-right">
          <div className="user-info">
            {user?.photoURL && (
              <img src={user.photoURL} alt={user.displayName || 'User avatar'} className="user-avatar" />
            )}
            <div className="user-meta">
              <span className="user-name">{user?.displayName || 'Logged in'}</span>
              <span className="user-email">{user?.email}</span>
            </div>
          </div>
          <button type="button" className="ghost-button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <main className="main-content">
        <section className="card fade-up">
          <h2 className="card-title">Upload audio</h2>
          <p className="card-subtitle">
            Drag &amp; drop or browse to upload up to 500 MB. Supported formats:{' '}
            <code>.mp3, .wav, .m4a, .ogg, .flac, .webm, .mp4</code>
          </p>

          {error && (
            <div className="error-box">
              <div className="error-heading">Something went wrong</div>
              <p>{error}</p>
              <button type="button" className="ghost-button error-reset" onClick={resetState}>
                Try again
              </button>
            </div>
          )}

          <div
            className={`dropzone ${file ? 'dropzone-has-file' : ''} ${isBusy ? 'dropzone-disabled' : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
          >
            <input
              type="file"
              accept=".mp3,.wav,.m4a,.ogg,.flac,.webm,.mp4"
              onChange={onInputChange}
              disabled={isBusy}
              className="dropzone-input"
            />
            {!file && (
              <div className="dropzone-inner">
                <div className="dropzone-icon">⬆️</div>
                <p className="dropzone-title">
                  Drag &amp; drop audio here, or <span className="dropzone-cta">browse files</span>
                </p>
                <p className="dropzone-hint">We upload directly to your S3 bucket over HTTPS.</p>
              </div>
            )}
            {file && (
              <div className="dropzone-inner">
                <p className="dropzone-selected-label">Selected file</p>
                <p className="dropzone-file-name">{file.name}</p>
                <p className="dropzone-file-meta">{formatBytes(file.size)}</p>
              </div>
            )}
          </div>

          <button
            type="button"
            className="primary-button submit-button"
            onClick={handleSubmit}
            disabled={!file || isBusy}
          >
            {isBusy ? 'Working…' : 'Upload & Transcribe'}
          </button>

          <div className="steps-grid">
            <div className="step-item">
              <div className="step-header">
                <div className={`step-indicator ${stepStates.uploadDone ? 'step-complete' : ''}`}>
                  {stepStates.uploadDone ? '✓' : '1'}
                </div>
                <span>Uploading to S3</span>
              </div>
              <div className="step-body">
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
                </div>
                <div className="progress-label">
                  {uploadProgress > 0 ? `${uploadProgress}%` : 'Waiting to start…'}
                </div>
              </div>
            </div>

            <div className="step-item">
              <div className="step-header">
                <div className={`step-indicator ${stepStates.submitDone ? 'step-complete' : ''}`}>
                  {stepStates.submitDone ? '✓' : '2'}
                </div>
                <span>Submitting to AssemblyAI</span>
              </div>
              <div className="step-body">
                <div className="status-line">
                  {status === 'submitting' && <span className="pulse-dot" aria-hidden="true" />}
                  <span>
                    {stepStates.submitDone ? 'Submitted.' : status === 'submitting' ? 'Submitting…' : 'Waiting for upload…'}
                  </span>
                </div>
              </div>
            </div>

            <div className="step-item">
              <div className="step-header">
                <div className={`step-indicator ${stepStates.pollDone ? 'step-complete' : ''}`}>
                  {stepStates.pollDone ? '✓' : '3'}
                </div>
                <span>Transcribing</span>
              </div>
              <div className="step-body">
                <div className="status-line">
                  {(status === 'polling' || status === 'done') && <span className="pulse-dot" aria-hidden="true" />}
                  <span>
                    {status === 'polling' || status === 'done' ? pollingLabel : 'Waiting for job to start…'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {status === 'done' && transcript && (
          <section className="card fade-up transcript-card">
            <div className="transcript-header">
              <div>
                <h2 className="card-title">Transcript</h2>
                <p className="card-subtitle">
                  Confidence:{' '}
                  <strong>
                    {typeof transcript.confidence === 'number'
                      ? `${(transcript.confidence * 100).toFixed(1)}%`
                      : '—'}
                  </strong>{' '}
                  · Duration:{' '}
                  <strong>
                    {typeof transcript.audioDuration === 'number'
                      ? `${Math.round(transcript.audioDuration)}s`
                      : '—'}
                  </strong>
                </p>
              </div>
              <div className="transcript-actions">
                <button type="button" className="ghost-button" onClick={handleCopy}>
                  {copyState === 'copied' ? '✓ Copied!' : 'Copy to clipboard'}
                </button>
                <button type="button" className="primary-button" onClick={resetState}>
                  + New file
                </button>
              </div>
            </div>
            <div className="transcript-body">
              <pre className="transcript-text">
                {transcript.text || 'No transcript text returned.'}
              </pre>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default Upload;
