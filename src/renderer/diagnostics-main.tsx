import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DiagnosticsApp from './DiagnosticsApp';
import './diagnostics.css';
import './signal-select.css';

createRoot(document.getElementById('root')!).render(<StrictMode><DiagnosticsApp /></StrictMode>);
