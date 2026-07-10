import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Fraunces (bold-italic serif) — the brand display face for the sidebar
// wordmark. Only the 800-italic cut is bundled, since that's all the wordmark
// uses; everything else stays on the system sans stack.
import '@fontsource/fraunces/800-italic.css';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
