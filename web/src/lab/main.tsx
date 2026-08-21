import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Lab } from './Lab';
import '../fonts.css';
import './lab.css';

const el = document.getElementById('lab-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Lab />
    </StrictMode>,
  );
}
