import '@xyflow/react/dist/style.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { setNonce } from 'react-resizable-panels';
import { App } from './App';

// The webview CSP only allows <style> elements carrying this nonce (used for the resize cursor).
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
if (nonce) setNonce(nonce);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
