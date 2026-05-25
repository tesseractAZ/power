import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, getStoredTheme } from './theme';

// v0.9.11 — apply the user's saved theme BEFORE React mounts so there's no
// "default theme flash" while the bundle hydrates. The same value is then
// picked up by useTheme() in the ThemeToggle for in-app switching.
applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
