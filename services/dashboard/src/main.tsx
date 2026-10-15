import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';
/**
 * Sonner ships a stylesheet, and importing it beats letting it inject at runtime.
 *
 * It does both: the package contains dist/styles.css AND the component injects equivalent
 * rules into the head on mount. Importing means Vite puts them in the hashed CSS bundle
 * instead - so they arrive with the document rather than after the JS executes (no flash
 * of an unstyled toast), they are covered by the one-year immutable cache, and - the
 * reason that actually matters here - they stop depending on the CSP permitting inline
 * styles.
 *
 * `style-src 'unsafe-inline'` is still in the policy, because React writes element styles
 * directly, so this does not remove the concession. It does mean one fewer thing relying
 * on it, which is the direction to move in.
 */
import 'sonner/dist/styles.css';

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
