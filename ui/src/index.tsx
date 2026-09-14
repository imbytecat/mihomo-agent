import { createRoot } from 'react-dom/client';
import Gateway from './App';
import styleText from './style.css?inline';

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor || document.getElementById('mihomoctl')) return;
  const style = document.createElement('style');
  style.id = 'mihomoctl-style';
  style.textContent = styleText;
  document.head.append(style);
  const container = document.createElement('div');
  container.id = 'mihomoctl';
  anchor.after(container);
  const portals = document.createElement('div');
  portals.id = 'mihomoctl-portals';
  document.body.append(portals);
  createRoot(container).render(<Gateway container={portals} />);
}
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
