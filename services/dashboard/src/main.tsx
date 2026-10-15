import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

const container = document.getElementById('root');
// Thrown rather than asserted non-null: if the element is missing the index.html and this
// file disagree, and a thrown error names the problem where a `!` would produce
// "Cannot read properties of null" from inside React.
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
