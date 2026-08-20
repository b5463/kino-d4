import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
