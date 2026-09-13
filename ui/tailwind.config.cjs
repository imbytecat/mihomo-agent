module.exports = {
  content: { relative: true, files: ['./src/**/*.{ts,tsx}'] },
  prefix: 'ufi-',
  important: ':is(#mihomo-agent, #mihomo-agent-portals)',
  corePlugins: { preflight: false },
};
