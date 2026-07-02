import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Play } from './Play';
import './play.css';

const el = document.getElementById('play-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Play />
    </StrictMode>,
  );
}
