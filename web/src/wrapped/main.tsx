import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Wrapped } from './Wrapped';
import '../fonts.css';
import './wrapped.css';

const el = document.getElementById('wrapped-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Wrapped />
    </StrictMode>,
  );
}
