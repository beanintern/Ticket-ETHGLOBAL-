import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';
import { applyMotionClass } from './lib/motion';
import { captureReferral } from './lib/referral';

applyMotionClass();
// Arrived through someone's share link (?ref=CODE): remember who, for referral rewards later.
captureReferral();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
