import React from 'react';
import { createRoot } from 'react-dom/client';
import FloatingApp from './FloatingApp';
import './floating.css';
import './signal-floating.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><FloatingApp /></React.StrictMode>,
);
