import { createRoot } from 'react-dom/client';
import Gateway from './App';
import styleText from './style.css?inline';

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor || document.getElementById('mihomo-agent')) return;
  const style = document.createElement('style');
  style.id = 'mihomo-agent-style';
  style.textContent = styleText;
  document.head.append(style);
  const container = document.createElement('div');
  container.id = 'mihomo-agent';
  anchor.after(container);
  const portals = document.createElement('div');
  portals.id = 'mihomo-agent-portals';
  document.body.append(portals);
  createRoot(container).render(<Gateway container={portals} />);
}
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
