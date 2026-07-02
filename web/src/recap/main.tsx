import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Recap } from './Recap';
import './recap.css';

const el = document.getElementById('recap-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Recap />
    </StrictMode>,
  );
}
