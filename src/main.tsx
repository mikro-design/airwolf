import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import Startup from './components/Startup';
import './styles.css';
// Dropped files/links must not replace the capture workspace. Open capture is
// the explicit import action, so an accidental drop cannot interrupt reception.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Startup>
        <App />
      </Startup>
    </ErrorBoundary>
  </React.StrictMode>,
);
