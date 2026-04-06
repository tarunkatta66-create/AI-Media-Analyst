import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { auth, provider } from '../firebase';

function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (err?.code === 'auth/popup-closed-by-user') {
        setError('Sign-in cancelled. Please try again.');
      } else if (err?.code === 'auth/unauthorized-domain') {
        setError(
          "This domain isn't authorised in Firebase. Add it under Authentication → Authorized domains.",
        );
      } else {
        setError(err?.message || 'Unexpected error during sign-in.');
      }
      setLoading(false);
    }
  };

  return (
    <div className="app-root login-root">
      <div className="login-card fade-up">
        <div className="login-icon-wrapper">
          <svg
            className="login-icon"
            viewBox="0 0 64 64"
            aria-hidden="true"
          >
            <rect width="64" height="64" rx="16" ry="16" fill="url(#grad)" />
            <defs>
              <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#6366f1" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <path
              d="M32 10a8 8 0 0 0-8 8v14a8 8 0 0 0 16 0V18a8 8 0 0 0-8-8zm-4 8a4 4 0 0 1 8 0v14a4 4 0 0 1-8 0V18z"
              fill="#e5e7ff"
            />
            <path
              d="M20 30a2 2 0 0 0-2 2 14 14 0 0 0 12 13.86V52h-4a2 2 0 0 0 0 4h12a2 2 0 0 0 0-4h-4v-6.14A14 14 0 0 0 46 32a2 2 0 0 0-4 0 10 10 0 0 1-20 0 2 2 0 0 0-2-2z"
              fill="#f9fafb"
            />
          </svg>
        </div>
        <h1 className="login-title">AI MEDIA ANALYST</h1>
        <p className="login-subtitle">
          Upload any audio file and get an accurate transcript in seconds.
        </p>
        {error && <div className="error-box">{error}</div>}
        <button
          type="button"
          className="primary-button"
          onClick={handleSignIn}
          disabled={loading}
        >
          {loading ? (
            <span className="button-content">
              <span className="button-spinner spinner" />
              <span>Signing you in…</span>
            </span>
          ) : (
            'Continue with Google'
          )}
        </button>
        <p className="login-footer">
          Free tier · No credit card required · 5 hours/month
        </p>
      </div>
    </div>
  );
}

export default Login;

