import { createRoot } from 'react-dom/client';
import Gateway from './App';
import styleText from './style.css?inline';

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor || document.getElementById('ufi-mihomo')) return;
  const style = document.createElement('style');
  style.id = 'ufi-mihomo-style';
  style.textContent = styleText;
  document.head.append(style);
  const container = document.createElement('div');
  container.id = 'ufi-mihomo';
  anchor.after(container);
  const portals = document.createElement('div');
  portals.id = 'ufi-mihomo-portals';
  document.body.append(portals);
  createRoot(container).render(<Gateway container={portals} />);
}
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
